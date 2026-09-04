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
import type { CatalogEntry, Diagnostic, MemoryKind, MemoryRecord, MemorySource, MemoryStatus } from './types.ts'
import type { MemorySearchRequest, MemorySearchResult } from './search.ts'
import { searchEntries, type SearchContext } from './search.ts'
import { OhMyMemoStore, type CreateInput, type ForgetResult, type MutationResult, type UpdateInput } from './store.ts'
import { rebuildViews } from './views.ts'

/** Record view returned by `get` — canonical metadata, body, provenance. */
export interface MemoryRecordView {
  id: string
  revision: number
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
  update(request: ServiceUpdateInput): Promise<MutationResult & { supersededId?: string }>
  dispute(request: { id: string; ifRevision: number; contradictsWith?: string[]; reason: string }): Promise<MutationResult>
  reactivate(request: { id: string; ifRevision: number; reason: string }): Promise<MutationResult>
  forget(request: { id?: string; scope?: string; key?: string; reason?: string }): Promise<ForgetResult>
  rebuildViews(): Promise<string[]>
  doctor(): Diagnostic[]
  stats(): { active: number; candidate: number; disputed: number; superseded: number; quarantined: number; tombstones: number; scopes: number }
  /** Read-only scope resolution for the current cwd (never creates). */
  scopeForCwd(cwd: string | undefined): string | undefined
  /** Catalog facts the context capsule needs (entries in scope + budget). */
  capsuleInput(cwd: string | undefined): { entries: CatalogEntry[]; workspaceScope?: string; budgetBytes: number }
  subscribe(listener: (change: unknown) => void): () => void
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
      return searchEntries(store.catalog.activeEntries().concat(disputedEntries(store)), request, context)
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
          sources: record.sources,
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
    async update(request) {
      const resolution = request.resolution ?? 'replace'
      if (request.content !== undefined && resolution === 'replace') {
        // Meaning-changing edit: new successor id, old record archived (design).
        return await store.supersede({
          id: request.id,
          ifRevision: request.ifRevision,
          content: request.content,
          ...(request.key !== undefined ? { key: request.key } : {}),
          ...(request.importance !== undefined ? { importance: request.importance } : {}),
          ...(request.pinned !== undefined ? { pinned: request.pinned } : {}),
          reason: request.reason,
        })
      }
      if (resolution === 'dispute') {
        return await service.dispute({ id: request.id, ifRevision: request.ifRevision, ...(request.contradictsWith !== undefined ? { contradictsWith: request.contradictsWith } : {}), reason: request.reason })
      }
      if (resolution === 'reactivate') {
        return await service.reactivate({ id: request.id, ifRevision: request.ifRevision, reason: request.reason })
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
        await store.markDispute({ id: other, ifRevision: read.record.revision, contradictsWith: [request.id], reason: `symmetric dispute with ${request.id}` }).catch(() => undefined)
      }
      return result
    },
    async reactivate(request) {
      return store.markActive(request)
    },
    async forget(request) {
      return store.forget(request)
    },
    async rebuildViews() {
      return rebuildViews(store.root, store.catalog, store.storeConfig, now().toISOString())
    },
    doctor() {
      return store.doctor()
    },
    stats() {
      return store.catalogStats()
    },
    scopeForCwd(cwd) {
      return store.resolveWorkspaceScopeForRead(cwd)
    },
    capsuleInput(cwd) {
      const workspaceScope = store.resolveWorkspaceScopeForRead(cwd)
      const entries = store.catalog.activeEntries().filter((entry) =>
        entry.record.scope === 'user' || (workspaceScope !== undefined && entry.record.scope === workspaceScope))
      return { entries, ...(workspaceScope !== undefined ? { workspaceScope } : {}), budgetBytes: Math.max(512, store.storeConfig.max_injected_bytes) }
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
  return store.catalog.allEntries().filter((entry) => entry.record.status === 'disputed' && entry.quarantine === undefined)
}

function scopeValues(store: OhMyMemoStore): string[] {
  const values: string[] = []
  for (const scopeEntry of store.catalog.scopes().values()) {
    values.push(`workspace:${scopeEntry.wsId}`)
  }
  return values
}
