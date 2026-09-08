/**
 * The `ctx.ohMyMemo` service: a thin, authority-free wrapper over the Phase 1
 * store plus Phase 2 search/views. Tools and the context injector consume
 * this seam only — nothing else walks the Markdown tree.
 *
 * The service name deliberately avoids the generic `ctx.memory` (reserved
 * for a possible upstream). Records re-read from disk on `get`; search hits
 * are metadata + snippet only.
 * @module dsh-ohmymemo/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { decayHorizonsFromConfig, type DecayHorizons } from './capsule.ts'
import type { CuratorCatalogEntry } from './dream.ts'
import type { CatalogEntry, Diagnostic, MemoryChange, MemoryKind, MemoryRecord, MemorySource, MemoryStatus } from './types.ts'
import type { MemorySearchRequest, MemorySearchResult } from './search.ts'
import { searchEntries, type SearchContext } from './search.ts'
import {
  listDisplayFiles,
  readDisplayFile,
  type MemoryDisplayDocument,
  type MemoryDisplayTree,
} from './explorer.ts'
import {
  OhMyMemoStore,
  type CreateCandidateInput,
  type CreateInput,
  type ForgetResult,
  type LifecycleMaintenanceReport,
  type MutationResult,
  type StoreConfigSnapshot,
  type UpdateConfigInput,
  type UpdateInput,
} from './store.ts'
import { rebuildViews } from './views.ts'

/** Record view returned by `get` — canonical metadata, body, provenance, CAS hash. */
export interface MemoryRecordView {
  id: string
  revision: number
  /** Content hash for the mandatory revision+hash CAS on later mutations. */
  hash: string
  scope: string
  kind: MemoryKind
  key: string
  status: MemoryStatus
  privacy: string
  pinned: boolean
  confirmed: boolean
  created_at: string
  updated_at: string
  tags: string[]
  sources: MemorySource[]
  supersedes: string[]
  contradicts: string[]
  /** Body is redacted for `sensitive` records (design: tools never echo them). */
  body: string
  redacted: boolean
}

/** Service-level update request: the store CAS shape plus resolutions. */
export type ServiceUpdateInput = UpdateInput & { resolution?: 'replace' | 'dispute' | 'reactivate'; contradictsWith?: string[] }

/** Public service surface (Phase 2 shape; listCandidates arrives with Phase 3). */
export interface OhMyMemoService {
  search(request: MemorySearchRequest, caller?: { cwd?: string }): Promise<MemorySearchResult>
  get(ids: string[]): Promise<MemoryRecordView[]>
  remember(request: CreateInput & { cwd?: string }): Promise<MutationResult>
  captureCandidate(request: CreateCandidateInput & { cwd?: string }): Promise<MutationResult>
  configSnapshot(): StoreConfigSnapshot
  updateConfig(request: UpdateConfigInput): Promise<StoreConfigSnapshot>
  displayTree(limit: number, maxViewBytes: number): MemoryDisplayTree
  displayDocument(request: { path: string; generation: string }, limits: { maxFiles: number; maxBytes: number }): MemoryDisplayDocument
  hasMemoryKey(scope: string, kind: MemoryKind, key: string): boolean
  withMaintenanceLease<T>(run: () => Promise<T>): Promise<T>
  update(request: ServiceUpdateInput): Promise<MutationResult & { supersededId?: string }>
  dispute(request: { id: string; ifRevision: number; ifHash: string; contradictsWith?: string[]; reason: string }): Promise<MutationResult>
  reactivate(request: { id: string; ifRevision: number; ifHash: string; reason: string }): Promise<MutationResult>
  forget(request: { id?: string; scope?: string; key?: string; reason?: string }): Promise<ForgetResult>
  /** Deterministic lifecycle maintenance (nightly sweep, no LLM). */
  runLifecycleMaintenance(): Promise<LifecycleMaintenanceReport>
  /** Curator refresh: stamp last_evidenced_at from grounded evidence. */
  refreshEvidence(request: { id: string; evidencedAt: string; source: MemorySource; reason: string }): Promise<MutationResult>
  /** Curator merge: absorbed retires into survivor via the supersede machinery. */
  mergeMemories(request: { survivorId: string; absorbedId: string; reason: string }): Promise<MutationResult>
  /** Bounded catalog for the nightly curator (active, normal, unconfirmed). */
  curatorCatalog(): { entries: CuratorCatalogEntry[]; horizons: DecayHorizons }
  rebuildViews(): Promise<string[]>
  doctor(): Diagnostic[]
  stats(): { active: number; candidate: number; disputed: number; superseded: number; expired: number; quarantined: number; tombstones: number; scopes: number }
  watchStatus(): { active: boolean; degradedReason?: string }
  /** Read-only scope resolution for the current cwd (never creates). */
  scopeForCwd(cwd: string | undefined): string | undefined
  /** Catalog facts the context capsule needs (entries in scope + budget). */
  capsuleInput(cwd: string | undefined): { entries: CatalogEntry[]; workspaceScope?: string; budgetBytes: number; decayHorizons: DecayHorizons }
  subscribe(listener: (change: MemoryChange) => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** OhMyMemo memory service (provided by the `ohmymemo-store` row). */
    ohMyMemo?: OhMyMemoService
  }
}

/** Build the service over an opened store. */
export function createOhMyMemoService(store: OhMyMemoStore, options: { now?: () => Date } = {}): OhMyMemoService {
  const now = options.now ?? ((): Date => new Date())

  const searchContextFor = (request: MemorySearchRequest, caller?: { cwd?: string }): SearchContext => {
    const workspaceScope = store.resolveWorkspaceScopeForRead(caller?.cwd)
    const mode = request.scope ?? 'current'
    let scopes: string[]
    if (mode === 'user') scopes = ['user']
    else if (mode === 'all') scopes = ['user', ...scopeValues(store)]
    else if (mode === 'workspace') scopes = workspaceScope !== undefined ? [workspaceScope] : []
    else scopes = workspaceScope !== undefined ? ['user', workspaceScope] : ['user']
    return { scopes, ...(workspaceScope !== undefined ? { workspaceScope } : {}), now: now(), limit: store.storeConfig.max_search_results }
  }

  const service: OhMyMemoService = {
    async search(request, caller) {
      const context = searchContextFor(request, caller)
      return searchEntries(store.readCatalog().activeEntries().concat(disputedEntries(store)), request, context)
    },
    async get(ids) {
      const limit = Math.min(ids.length, store.storeConfig.max_get_records)
      const views: MemoryRecordView[] = []
      for (const id of ids.slice(0, limit)) {
        const read = store.readRecord(id)
        if (read === undefined) continue
        const record = read.record
        const redacted = record.privacy === 'sensitive'
        views.push({
          id: record.id,
          revision: record.revision,
          hash: read.hash,
          scope: record.scope,
          kind: record.kind,
          key: record.key,
          status: record.status,
          privacy: record.privacy,
          pinned: record.pinned,
          confirmed: record.confirmed,
          created_at: record.created_at,
          updated_at: record.updated_at,
          tags: record.tags,
          sources: redacted ? redactSources(record.sources) : record.sources,
          supersedes: record.supersedes,
          contradicts: record.contradicts,
          body: redacted ? '(敏感记忆正文已隐去；内容保留在本地 Markdown 中，可经显式修订处理)' : record.body,
          redacted,
        })
      }
      return views
    },
    async remember(request) {
      return store.create(request)
    },
    async captureCandidate(request) {
      return store.createCandidate(request)
    },
    configSnapshot() {
      return store.configSnapshot()
    },
    async updateConfig(request) {
      return store.updateConfig(request)
    },
    displayTree(limit, maxViewBytes) {
      return listDisplayFiles(store.root, store.readCatalog(), limit, maxViewBytes, now())
    },
    displayDocument(request, limits) {
      return readDisplayFile(store.root, store.readCatalog(), request, limits)
    },
    hasMemoryKey(scope, kind, key) {
      // Occupied = an unquarantined active/disputed record holds the key
      // (aligned with the store's byConflictKey, so archived records never
      // block re-remembering) OR an active forget tombstone barriers the
      // (scope, key) pair for writes of every kind — mirroring createLocked.
      const catalog = store.readCatalog()
      return catalog.activeEntries().some((entry) =>
        entry.record.scope === scope && entry.record.kind === kind && entry.record.key === key)
        || catalog.tombstoneFor(scope, key) !== undefined
    },
    async withMaintenanceLease(run) {
      return store.withMaintenanceLease(run)
    },
    async update(request) {
      const resolution = request.resolution ?? 'replace'
      if (request.content !== undefined && resolution === 'replace') {
        // Meaning-changing edit: new successor id, old record archived (design).
        return await store.supersede({
          id: request.id,
          ifRevision: request.ifRevision,
          ifHash: request.ifHash,
          content: request.content,
          ...(request.key !== undefined ? { key: request.key } : {}),
          ...(request.importance !== undefined ? { importance: request.importance } : {}),
          ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
          reason: request.reason,
        })
      }
      if (resolution === 'dispute') {
        return await service.dispute({ id: request.id, ifRevision: request.ifRevision, ifHash: request.ifHash, ...(request.contradictsWith !== undefined ? { contradictsWith: request.contradictsWith } : {}), reason: request.reason })
      }
      if (resolution === 'reactivate') {
        return await service.reactivate({ id: request.id, ifRevision: request.ifRevision, ifHash: request.ifHash, reason: request.reason })
      }
      const { resolution: _resolution, ...rest } = request
      return store.update(rest)
    },
    async dispute(request) {
      const result = await store.markDispute(request)
      // Symmetric link on the counterparts (best-effort second revision).
      for (const other of request.contradictsWith ?? []) {
        const read = store.readRecord(other)
        if (read === undefined || read.record.status === 'superseded') continue
        await store.markDispute({ id: other, ifRevision: read.record.revision, ifHash: read.hash, contradictsWith: [request.id], reason: `symmetric dispute with ${request.id}` }).catch(() => undefined)
      }
      return result
    },
    async reactivate(request) {
      return store.markActive(request)
    },
    async forget(request) {
      return store.forget(request)
    },
    async runLifecycleMaintenance() {
      return store.runLifecycleMaintenance()
    },
    async refreshEvidence(request) {
      return store.refreshEvidence(request)
    },
    async mergeMemories(request) {
      return store.mergeMemories(request)
    },
    curatorCatalog() {
      const entries: CuratorCatalogEntry[] = []
      for (const entry of store.readCatalog().activeEntries()) {
        const record = entry.record
        // Confirmed entries are untouchable and deliberately not listed;
        // sensitive content never crosses to the model.
        if (record.status !== 'active' || record.confirmed || record.privacy !== 'normal') continue
        entries.push({
          id: record.id,
          key: record.key,
          kind: record.kind,
          importance: record.importance,
          confirmed: record.confirmed,
          created_at: record.created_at,
          ...(record.last_evidenced_at !== undefined ? { last_evidenced_at: record.last_evidenced_at } : {}),
          valid_until: record.valid_until ?? null,
          content: firstCatalogLine(record.body),
        })
      }
      return { entries, horizons: decayHorizonsFromConfig(store.storeConfig) }
    },
    async rebuildViews() {
      return rebuildViews(store.root, store.readCatalog(), store.storeConfig, now().toISOString())
    },
    doctor() {
      return store.doctor()
    },
    stats() {
      return store.catalogStats()
    },
    watchStatus() {
      return {
        active: store.watchActive,
        ...(store.watchDegradedReason === undefined ? {} : { degradedReason: store.watchDegradedReason }),
      }
    },
    scopeForCwd(cwd) {
      return store.resolveWorkspaceScopeForRead(cwd)
    },
    capsuleInput(cwd) {
      const workspaceScope = store.resolveWorkspaceScopeForRead(cwd)
      const entries = store.readCatalog().activeEntries().filter((entry) =>
        entry.record.scope === 'user' || (workspaceScope !== undefined && entry.record.scope === workspaceScope))
      return {
        entries,
        ...(workspaceScope !== undefined ? { workspaceScope } : {}),
        budgetBytes: Math.max(512, store.storeConfig.max_injected_bytes),
        decayHorizons: decayHorizonsFromConfig(store.storeConfig),
      }
    },
    subscribe(listener) {
      return store.subscribe(listener)
    },
  }
  return service
}

/** Provide the service on a context (used by the store row after open). */
export function provideOhMyMemo(ctx: Context, service: OhMyMemoService): void {
  ctx.provide('ohMyMemo', service)
}

function disputedEntries(store: OhMyMemoStore): CatalogEntry[] {
  return store.readCatalog().allEntries().filter((entry) => entry.record.status === 'disputed' && entry.quarantine === undefined && !store.readCatalog().isTombstoned(entry.record.id))
}

/** Sensitive records keep locators (session_id/event_seq/quote_hash) but never quote text. */
function redactSources(sources: MemorySource[]): MemorySource[] {
  return sources.map((source) => {
    if (source.quote_preview === undefined) return source
    const { quote_preview: _preview, ...rest } = source
    return rest
  })
}

function scopeValues(store: OhMyMemoStore): string[] {
  const values: string[] = []
  for (const scopeEntry of store.catalog.scopes().values()) {
    values.push(`workspace:${scopeEntry.wsId}`)
  }
  return values
}

/** First content line for a curator catalog entry (flattened, bounded). */
function firstCatalogLine(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 119)}…`
}
