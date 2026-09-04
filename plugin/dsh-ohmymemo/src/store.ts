/**
 * The OhMyMemo store: orchestrates the Markdown medium contract — open
 * (layout, manifest/config, transaction recovery, scan, watch), mutations
 * (create / update / supersede / promote / forget) under the cross-process
 * writer lock with revision+hash CAS, journal, and watcher-driven refresh.
 *
 * Invariants this class owns:
 *
 * - Markdown files are the only canonical content; the in-memory catalog is
 *   disposable and hash-reconciled.
 * - Mutations re-read the target file under the lock — never trust the
 *   pre-lock catalog — and fail closed on CAS mismatch (no last-writer-wins).
 * - External (hand) edits win: the disk is the source of truth, the change is
 *   journaled as `external-edit-detected`, and racing tool writes lose to the
 *   CAS check instead of overwriting the edit.
 * - Journal lines and tombstones never carry record bodies.
 *
 * Phase 1 exposes the class directly; Phase 2 wraps it as `ctx.ohMyMemo`.
 * @module dsh-ohmymemo/store
 */

import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, hashFile, hashText, statFile, writeFileAtomic } from './atomic.ts'
import { MemoryCatalog } from './catalog.ts'
import { runDoctor } from './doctor.ts'
import { StoreError } from './errors.ts'
import { newMemoryId, newStoreId, newTombstoneId } from './ids.ts'
import { appendJournal, type JournalEntry } from './journal.ts'
import { WriterLock, type LockInfo } from './lock.ts'
import {
  archiveRecordPath,
  canonicalRecordPath,
  candidateRecordPath,
  parseLocation,
  tombstonePath,
  WRITER_LOCK_REL,
} from './paths.ts'
import { refreshSubtree, scanFile, scanStore } from './scan.ts'
import {
  defaultStoreConfig,
  detectSecretLike,
  normalizeKey,
  normalizeTag,
  parseManifest,
  parseRecord,
  parseStoreConfig,
  serializeManifest,
  serializeRecord,
  serializeStoreConfig,
  serializeTombstone,
} from './schema.ts'
import { resolveWorkspaceScope, type WorkspaceRegistryLike } from './scope.ts'
import { recoverTransactions, runTransaction, type LiveTxnOp } from './txn.ts'
import type { MemoryChange, MemoryKind, MemoryRecord, MemorySource, MemoryStatus, Diagnostic, StoreManifest, StoreUserConfig } from './types.ts'
import { StoreWatcher } from './watch.ts'

/** Minimal logger shape (ctx.logger satisfies it). */
export interface StoreLogger {
  debug?: (message: string) => void
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/** Store construction options. */
export interface StoreOptions {
  root: string
  watch?: boolean
  lockTimeoutMs?: number
  watchDebounceMs?: number
  logger?: StoreLogger
  now?: () => Date
  idNow?: () => number
}

/** Create mutation input. */
export interface CreateInput {
  content: string
  kind: MemoryKind
  scope: 'user' | 'workspace'
  cwd?: string
  key?: string
  cardinality?: 'single' | 'multiple'
  importance?: number
  pinned?: boolean
  tags?: string[]
  privacy?: 'normal' | 'sensitive' | 'secret-ref'
  confirmed?: boolean
  confidence?: number
  sources?: MemorySource[]
  overrideTombstone?: boolean
  registry?: WorkspaceRegistryLike
}

/** Automated candidate input; candidates remain outside active recall until promotion. */
export interface CreateCandidateInput extends CreateInput {
  reason: string
  expiresAt?: string
}

/** CAS-protected mutation of the user-editable store policy. */
export interface UpdateConfigInput {
  ifHash: string
  patch: Partial<Pick<StoreUserConfig, 'allow_inference_candidates' | 'dream_schedule_local_time'>>
}

/** Immutable config view paired with the current file hash. */
export interface StoreConfigSnapshot {
  config: StoreUserConfig
  hash: string
}

/** In-place revision update input (mandatory revision+hash CAS). */
export interface UpdateInput {
  id: string
  ifRevision: number
  /** Content hash the caller read (a same-revision hand edit must not be overwritten). */
  ifHash: string
  content?: string
  key?: string
  importance?: number
  pinned?: boolean
  confirm?: boolean
  reason: string
}

/** Replace-with-successor input (old record archived, new id created). */
export interface SupersedeInput {
  id: string
  ifRevision: number
  ifHash: string
  content: string
  key?: string
  importance?: number
  pinned?: boolean
  reason: string
}

/** Candidate promotion input (same id moves inbox → canonical). */
export interface PromoteInput {
  id: string
  ifRevision: number
  ifHash: string
  confirm: boolean
  reason: string
}

/** Forget input: exactly one of id / (scope + key). */
export interface ForgetRequest {
  id?: string
  scope?: string
  key?: string
  reason?: string
}

/** Mutation outcome (no bodies). */
export interface MutationResult {
  id: string
  revision: number
  status: MemoryStatus
  scope: string
  path: string
}

/** Forget outcome (no bodies). */
export interface ForgetResult {
  forgottenIds: string[]
  tombstoneId: string
  tombstonePath: string
}

const PENDING_TTL_MS = 10_000

export class OhMyMemoStore {
  readonly root: string
  private readonly logger: StoreLogger | undefined
  private readonly now: () => Date
  private readonly idNow: () => number
  private readonly lock: WriterLock
  private readonly maintenanceLock: WriterLock
  private readonly watchRequested: boolean
  private readonly watchDebounceMs: number

  private catalogValue = new MemoryCatalog()
  private manifestValue: StoreManifest | undefined
  private configValue: StoreUserConfig = defaultStoreConfig()
  /** Per-file issues keyed by store-relative path; empty = file is clean. */
  private fileDiagnostics = new Map<string, Diagnostic[]>()
  private baseDiagnostics: Diagnostic[] = []
  private watcher: StoreWatcher | undefined
  private readyPromise: Promise<void> | undefined
  private openErrorMsg: string | undefined
  private pendingInternal = new Map<string, { expected?: string; expiresAt: number }>()
  private listeners = new Set<(change: MemoryChange) => void>()

  constructor(options: StoreOptions) {
    this.root = options.root
    this.logger = options.logger
    this.now = options.now ?? ((): Date => new Date())
    this.idNow = options.idNow ?? Date.now
    this.watchRequested = options.watch ?? true
    this.watchDebounceMs = options.watchDebounceMs ?? 120
    this.lock = new WriterLock(join(this.root, ...WRITER_LOCK_REL.split('/')), {
      timeoutMs: options.lockTimeoutMs ?? 5_000,
    })
    this.maintenanceLock = new WriterLock(join(this.root, '.state', 'locks', 'dream-memory.lock'), {
      timeoutMs: options.lockTimeoutMs ?? 5_000,
    })
  }

  // -------------------------------------------------------------- state ----

  get catalog(): MemoryCatalog {
    return this.catalogValue
  }

  /** Refresh fail-closed tombstone barriers before exposing a read catalog. */
  readCatalog(): MemoryCatalog {
    this.refreshTombstoneBarriers()
    return this.catalogValue
  }

  get manifest(): StoreManifest | undefined {
    return this.manifestValue
  }

  get storeConfig(): StoreUserConfig {
    return this.configValue
  }

  get openError(): string | undefined {
    return this.openErrorMsg
  }

  get watchActive(): boolean {
    return this.watcher?.active ?? false
  }

  get watchDegradedReason(): string | undefined {
    return this.watcher?.degraded
  }

  catalogStats(): ReturnType<MemoryCatalog['stats']> {
    this.refreshTombstoneBarriers()
    return this.catalogValue.stats()
  }

  subscribe(listener: (change: MemoryChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Hold the store-specific cross-process lease for one maintenance run. */
  async withMaintenanceLease<T>(run: () => Promise<T>): Promise<T> {
    await this.ensureReady()
    return this.maintenanceLock.withLock(run)
  }

  // --------------------------------------------------------------- open ----

  open(): Promise<void> {
    if (this.readyPromise === undefined) {
      this.readyPromise = this.openInternal().catch((error: unknown) => {
        this.openErrorMsg = (error as Error).message
        throw error
      })
    }
    return this.readyPromise
  }

  private async openInternal(): Promise<void> {
    this.ensureLayout()
    await this.initUnderLock()
    this.rescan()
    if (this.watchRequested && this.configValue.watch) {
      this.startWatcher()
    }
    this.logger?.info?.(`dsh-ohmymemo: store opened at ${this.root} — ${JSON.stringify(this.catalogStats())}`)
  }

  private ensureLayout(): void {
    const dirs = [
      'scopes/user/semantic',
      'scopes/user/episodic',
      'scopes/user/procedural',
      'scopes/workspaces',
      'inbox/candidates',
      'archive',
      'tombstones',
      'journal',
      'views',
      '.cache',
      '.state/transactions',
      '.state/locks',
    ]
    for (const dir of dirs) {
      ensureDir(join(this.root, ...dir.split('/')))
    }
  }

  /** Recover transactions and (re)initialize manifest/config under the writer lock. */
  private async initUnderLock(): Promise<void> {
    let locked = false
    try {
      await this.lock.acquire()
      locked = true
    } catch (error) {
      if ((error as StoreError).code === 'OHMYMEMO_BUSY') {
        this.baseDiagnostics.push({
          code: 'recovery-deferred',
          severity: 'warning',
          message: 'writer lock busy at open — transaction recovery deferred to a later mutation/open',
        })
        this.initManifestAndConfig()
        return
      }
      throw error
    }
    try {
      const report = recoverTransactions(this.root, this.now)
      for (const conflict of report.conflicts) {
        this.baseDiagnostics.push({
          code: 'transaction-conflict',
          severity: 'error',
          message: `transaction ${conflict.id}: ${conflict.message}`,
        })
      }
      if (report.recovered.length + report.aborted.length > 0) {
        this.logger?.warn?.(`dsh-ohmymemo: recovered ${report.recovered.length} transaction(s), aborted ${report.aborted.length}`)
      }
      this.initManifestAndConfig()
    } finally {
      if (locked) this.lock.release()
    }
  }

  /** Read or create manifest.yaml and config.yaml (fatal on newer formats). */
  private initManifestAndConfig(): void {
    const manifestAbs = join(this.root, 'manifest.yaml')
    if (statFile(manifestAbs) === undefined) {
      const manifest: StoreManifest = {
        schema: 'ohmymemo-store/v1',
        store_id: newStoreId(this.idNow()),
        created_at: this.now().toISOString(),
        format_version: 1,
      }
      writeFileAtomic(manifestAbs, serializeManifest(manifest))
      this.manifestValue = manifest
    } else {
      const { manifest, issues } = parseManifest(readFileSync(manifestAbs, 'utf8'))
      if (manifest === undefined) {
        throw new StoreError('OHMYMEMO_UNSUPPORTED_STORE_VERSION', `store manifest rejected: ${issues.map((issue) => issue.message).join('; ')}`)
      }
      this.manifestValue = manifest
    }

    const configAbs = join(this.root, 'config.yaml')
    if (statFile(configAbs) === undefined) {
      const config = defaultStoreConfig()
      writeFileAtomic(configAbs, serializeStoreConfig(config))
      this.configValue = config
    } else {
      const { config, issues } = parseStoreConfig(readFileSync(configAbs, 'utf8'))
      this.configValue = config
      for (const issue of issues) {
        this.baseDiagnostics.push({
          code: 'config-invalid',
          severity: 'warning',
          message: `config.yaml ${issue.field !== undefined ? `field "${issue.field}"` : ''}: ${issue.message}`,
        })
      }
    }
  }

  private rescan(): void {
    const result = scanStore(this.root, { maxRecordBytes: this.configValue.max_record_bytes })
    this.catalogValue = result.catalog
    this.fileDiagnostics = result.fileDiagnostics
    const issues = result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
    if (issues > 0) {
      this.logger?.warn?.(`dsh-ohmymemo: scan found ${issues} error-level issue(s) (see doctor)`)
    }
  }

  private applyRuntimeConfig(next: StoreUserConfig): void {
    const previous = this.configValue
    this.configValue = next
    if (previous.max_record_bytes !== next.max_record_bytes) this.rescan()
    if (!this.watchRequested) return
    if (next.watch && this.watcher === undefined) this.startWatcher()
    if (!next.watch && this.watcher !== undefined) {
      this.watcher.stop()
      this.watcher = undefined
    }
  }

  private startWatcher(): void {
    this.watcher = new StoreWatcher(
      this.root,
      (batch) => {
        this.handleWatchBatch(batch.changed)
      },
      {
        debounceMs: this.watchDebounceMs,
        onDegraded: (reason) => {
          this.baseDiagnostics.push({ code: 'watch-degraded', severity: 'warning', message: reason })
          this.logger?.warn?.(`dsh-ohmymemo: ${reason}`)
        },
      },
    )
    this.watcher.start()
  }

  close(): void {
    this.watcher?.stop()
    this.watcher = undefined
    this.listeners.clear()
    // Locks are never force-released here. An in-flight withWriterLock /
    // withMaintenanceLease callback still owns its critical section and
    // releases in its own finally; ripping the lock out mid-callback would
    // let another process interleave with the exact mutation we are still
    // performing. A process that exits mid-hold leaves its lock directory
    // behind, and other processes steal it only after proving this pid dead
    // or reused — the designed stale-holder path.
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise === undefined) {
      throw new StoreError('OHMYMEMO_NOT_OPEN', 'store.open() must complete before mutations')
    }
    await this.readyPromise
  }

  // ----------------------------------------------------------- reading ----

  /** Re-read one record from disk by id (the read path trusts files, not the catalog). */
  readRecord(id: string): { record: MemoryRecord; hash: string; absPath: string } | undefined {
    this.refreshTombstoneBarriers()
    const entry = this.catalogValue.get(id)
    if (entry === undefined) return undefined
    const hash = hashFile(entry.absPath)
    if (hash === undefined) return undefined
    const { record } = parseRecord(readFileSync(entry.absPath, 'utf8'))
    this.refreshTombstoneBarriers()
    if (record === undefined || record.id !== id || this.catalogValue.isTombstoned(id)) return undefined
    return { record, hash, absPath: entry.absPath }
  }

  /** Re-read config.yaml and return a detached policy plus its CAS hash. */
  configSnapshot(): StoreConfigSnapshot {
    const abs = join(this.root, 'config.yaml')
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      return { config: defaultStoreConfig(), hash: '' }
    }
    const hash = hashText(text)
    const parsed = parseStoreConfig(text)
    return { config: structuredClone(parsed.config), hash }
  }

  doctor(): Diagnostic[] {
    const fileIssues: Diagnostic[] = []
    for (const list of this.fileDiagnostics.values()) fileIssues.push(...list)
    return runDoctor({
      root: this.root,
      catalog: this.catalogValue,
      baseDiagnostics: [...this.baseDiagnostics, ...fileIssues, ...this.catalogValue.invariantDiagnostics()],
      watchRequested: this.watchRequested,
      watchActive: this.watchActive,
      watchDegradedReason: this.watchDegradedReason,
      lockHeldByUs: this.lock.held,
    })
  }

  // --------------------------------------------------------- mutations ----

  async create(input: CreateInput): Promise<MutationResult> {
    await this.ensureReady()
    return this.withWriterLock(() => this.createLocked(input))
  }

  async createCandidate(input: CreateCandidateInput): Promise<MutationResult> {
    await this.ensureReady()
    return this.withWriterLock(() => this.createLocked(input, {
      reason: input.reason,
      expiresAt: input.expiresAt,
    }))
  }

  private createLocked(input: CreateInput, candidate?: { reason: string; expiresAt?: string }): MutationResult {
    const content = input.content.replace(/\n+$/, '')
    if (content.trim().length === 0) {
      throw new StoreError('OHMYMEMO_EMPTY_CONTENT', 'record content must not be empty')
    }
    const secret = detectSecretLike(content)
    if (secret !== undefined) {
      throw new StoreError('OHMYMEMO_SECRET_REFUSED', `content matches a credential pattern (${secret}) — refusing to store (fail closed)`)
    }
    const scopeValue = this.resolveScopeValueLocked(input)
    const id = newMemoryId(this.idNow())
    const key = normalizeKey(input.key ?? `auto.${id}`)
    if (key === undefined) {
      throw new StoreError('OHMYMEMO_INVALID_KEY', `key "${input.key ?? ''}" cannot be normalized`)
    }
    const cardinality = input.cardinality ?? (input.kind === 'episodic' ? 'multiple' : 'single')
    const at = this.now().toISOString()

    const barrier = this.catalogValue.tombstoneFor(scopeValue, key)
    if (barrier !== undefined && input.overrideTombstone !== true) {
      throw new StoreError('OHMYMEMO_TOMBSTONE_BARRIER', `key ${scopeValue}/${key} has an active forget tombstone — refusing to re-create (explicit re-remember required)`, { tombstone: barrier.id })
    }
    if (candidate === undefined && cardinality === 'single') {
      const existing = this.catalogValue.byConflictKey(scopeValue, input.kind, key)
      if (existing.length > 0) {
        throw new StoreError('OHMYMEMO_SINGLE_KEY_CONFLICT', `key ${scopeValue}/${input.kind}/${key} already has an active record (${existing.map((entry) => entry.record.id).join(', ')}) — update or supersede it instead`)
      }
    } else if (candidate !== undefined) {
      const duplicate = this.catalogValue.allEntries().find((entry) =>
        entry.record.scope === scopeValue && entry.record.kind === input.kind && entry.record.key === key)
      if (duplicate !== undefined) {
        throw new StoreError('OHMYMEMO_SINGLE_KEY_CONFLICT', `candidate key ${scopeValue}/${input.kind}/${key} already exists (${duplicate.record.id})`)
      }
    }

    const candidateExpiresAt = candidate === undefined
      ? undefined
      : candidate.expiresAt ?? new Date(this.now().getTime() + this.configValue.candidate_retention_days * 86_400_000).toISOString()
    const record: MemoryRecord = {
      schema: 'ohmymemo/v1',
      id,
      revision: 1,
      scope: scopeValue,
      kind: input.kind,
      key,
      cardinality,
      status: candidate === undefined ? 'active' : 'candidate',
      confidence: input.confidence ?? 1,
      importance: input.importance ?? 0.5,
      privacy: input.privacy ?? 'normal',
      pinned: input.pinned ?? false,
      confirmed: input.confirmed ?? false,
      created_at: at,
      updated_at: at,
      tags: normalizeTags(input.tags),
      sources: input.sources ?? [{ type: 'user_statement', observed_at: at }],
      supersedes: [],
      contradicts: [],
      ...(candidate === undefined ? {} : {
        candidate_reason: candidate.reason,
        candidate_expires_at: candidateExpiresAt,
      }),
      body: content,
    }
    const text = serializeRecord(record)
    this.checkSize(text)
    const rel = candidate === undefined ? canonicalRecordPath(record) : candidateRecordPath(record.id)
    if (rel === undefined) {
      throw new StoreError('OHMYMEMO_INVALID_SCOPE', `scope ${scopeValue} has no canonical path`)
    }
    this.expectInternal(rel, hashText(text))
    runTransaction(this.root, {
      action: candidate === undefined ? 'create' : 'candidate-create',
      ops: [
        { op: 'write', path: rel, content: text, after_hash: hashText(text) },
        { op: 'journal', entry: journalEntry(this.now(), candidate === undefined ? 'created' : 'candidate-created', record, hashText(text)) },
      ],
      validateWrite: validateRecordText,
    })
    this.refreshEntry(rel)
    this.emit({ type: 'upserted', id, revision: record.revision, hash: hashText(text), external: false })
    return { id, revision: record.revision, status: record.status, scope: record.scope, path: rel }
  }

  async updateConfig(input: UpdateConfigInput): Promise<StoreConfigSnapshot> {
    await this.ensureReady()
    return this.withWriterLock(() => {
      const current = this.configSnapshot()
      if (current.hash !== input.ifHash) {
        throw new StoreError('OHMYMEMO_CONFIG_CAS_MISMATCH', 'config.yaml changed since it was read', {
          expectedHash: input.ifHash,
          actualHash: current.hash,
        })
      }
      if (current.hash !== '') {
        const source = parseStoreConfig(readFileSync(join(this.root, 'config.yaml'), 'utf8'))
        if (source.issues.length > 0) {
          throw new StoreError('OHMYMEMO_CONFIG_INVALID', `config.yaml contains unowned or invalid fields: ${source.issues.map(issue => issue.message).join('; ')}`)
        }
      }
      const next = { ...current.config, ...input.patch }
      const text = serializeStoreConfig(next)
      const validated = parseStoreConfig(text)
      if (validated.issues.length > 0) {
        throw new StoreError('OHMYMEMO_CONFIG_INVALID', `refusing invalid config: ${validated.issues.map((issue) => issue.message).join('; ')}`)
      }
      const nextHash = hashText(text)
      if (nextHash === current.hash) return current
      this.expectInternal('config.yaml', nextHash)
      runTransaction(this.root, {
        action: 'config-update',
        ops: [
          { op: 'write', path: 'config.yaml', content: text, ...(current.hash === '' ? {} : { before_hash: current.hash }), after_hash: nextHash },
          { op: 'journal', entry: {
            at: this.now().toISOString(),
            action: 'config-updated',
            ...(current.hash === '' ? {} : { old_hash: current.hash }),
            new_hash: nextHash,
            path: 'config.yaml',
          } },
        ],
        validateWrite: validateConfigText,
      })
      this.applyRuntimeConfig(validated.config)
      this.emit({ type: 'config-updated', hash: nextHash, external: false })
      return { config: structuredClone(validated.config), hash: nextHash }
    })
  }

  async update(input: UpdateInput): Promise<MutationResult> {
    await this.ensureReady()
    return this.withWriterLock(() => this.updateLocked(input))
  }

  private updateLocked(input: UpdateInput): MutationResult {
    const current = this.readUnderLock(input.id)
    if (current === undefined) {
      throw new StoreError('OHMYMEMO_RECORD_INVALID', `record ${input.id} on disk is not a valid record — refusing to mutate`)
    }
    this.detectExternalEdit(current)
    this.assertCas(current, input.ifRevision, input.ifHash)

    const next: MemoryRecord = { ...current.record }
    next.revision = current.record.revision + 1
    next.updated_at = this.now().toISOString()
    if (input.content !== undefined) {
      const content = input.content.replace(/\n+$/, '')
      if (content.trim().length === 0) throw new StoreError('OHMYMEMO_EMPTY_CONTENT', 'record content must not be empty')
      const secret = detectSecretLike(content)
      if (secret !== undefined) {
        throw new StoreError('OHMYMEMO_SECRET_REFUSED', `content matches a credential pattern (${secret}) — refusing to store (fail closed)`)
      }
      next.body = content
    }
    if (input.key !== undefined) {
      const key = normalizeKey(input.key)
      if (key === undefined) throw new StoreError('OHMYMEMO_INVALID_KEY', `key "${input.key}" cannot be normalized`)
      if (key !== current.record.key && current.record.cardinality === 'single') {
        const clash = this.catalogValue.byConflictKey(current.record.scope, current.record.kind, key)
          .filter((entry) => entry.record.id !== current.record.id)
        if (clash.length > 0) {
          throw new StoreError('OHMYMEMO_SINGLE_KEY_CONFLICT', `key change to ${key} collides with ${clash.map((entry) => entry.record.id).join(', ')}`)
        }
      }
      next.key = key
    }
    if (input.importance !== undefined) next.importance = input.importance
    if (input.pinned !== undefined) next.pinned = input.pinned
    if (input.confirm === true) {
      next.confirmed = true
      next.last_confirmed_at = next.updated_at
    }
    const text = serializeRecord(next)
    this.checkSize(text)
    const rel = expectedRel(current.record)
    this.expectInternal(rel, hashText(text))
    runTransaction(this.root, {
      action: 'update',
      ops: [
        { op: 'write', path: rel, content: text, before_hash: current.hash, after_hash: hashText(text) },
        { op: 'journal', entry: journalEntry(this.now(), 'updated', next, hashText(text), input.reason) },
      ],
      validateWrite: validateRecordText,
    })
    this.refreshEntry(rel)
    this.emit({ type: 'upserted', id: next.id, revision: next.revision, hash: hashText(text), external: false })
    return { id: next.id, revision: next.revision, status: next.status, scope: next.scope, path: rel }
  }

  async supersede(input: SupersedeInput): Promise<MutationResult & { supersededId: string }> {
    await this.ensureReady()
    return this.withWriterLock(() => this.supersedeLocked(input))
  }

  private supersedeLocked(input: SupersedeInput): MutationResult & { supersededId: string } {
    const current = this.readUnderLock(input.id)
    if (current === undefined) {
      throw new StoreError('OHMYMEMO_RECORD_INVALID', `record ${input.id} on disk is not a valid record — refusing to mutate`)
    }
    this.detectExternalEdit(current)
    this.assertCas(current, input.ifRevision, input.ifHash)

    const content = input.content.replace(/\n+$/, '')
    if (content.trim().length === 0) throw new StoreError('OHMYMEMO_EMPTY_CONTENT', 'record content must not be empty')
    const secret = detectSecretLike(content)
    if (secret !== undefined) {
      throw new StoreError('OHMYMEMO_SECRET_REFUSED', `content matches a credential pattern (${secret}) — refusing to store (fail closed)`)
    }
    const at = this.now().toISOString()
    const newId = newMemoryId(this.idNow())
    const key = input.key !== undefined ? normalizeKey(input.key) : current.record.key
    if (key === undefined) throw new StoreError('OHMYMEMO_INVALID_KEY', `key "${input.key ?? current.record.key}" cannot be normalized`)

    const successor: MemoryRecord = {
      ...current.record,
      id: newId,
      revision: 1,
      key,
      status: 'active',
      created_at: at,
      updated_at: at,
      last_confirmed_at: at,
      confirmed: true,
      body: content,
      supersedes: [current.record.id],
      contradicts: [],
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
    }
    const newText = serializeRecord(successor)
    this.checkSize(newText)
    const newRel = canonicalRecordPath(successor)
    const oldRel = expectedRel(current.record)
    const archiveRel = archiveRecordPath(current.record)
    if (newRel === undefined || oldRel === undefined || archiveRel === undefined) {
      throw new StoreError('OHMYMEMO_INVALID_SCOPE', 'record paths cannot be derived')
    }
    const oldDerivedText = serializeRecord({ ...current.record, status: 'superseded', updated_at: at })
    const oldDerivedHash = hashText(oldDerivedText)
    const oldHash = current.hash

    this.expectInternal(newRel, hashText(newText))
    this.expectInternal(archiveRel, oldDerivedHash)
    this.expectInternal(oldRel)
    runTransaction(this.root, {
      action: 'supersede',
      ops: [
        { op: 'write', path: newRel, content: newText, after_hash: hashText(newText) },
        { op: 'write-derived', from: oldRel, to: archiveRel, before_hash: oldHash, after_hash: oldDerivedHash, derive: { status: 'superseded', updated_at: at } },
        { op: 'delete', path: oldRel, hash: oldHash },
        { op: 'journal', entry: journalEntry(this.now(), 'superseded', successor, hashText(newText), input.reason) },
      ],
      validateWrite: validateRecordText,
    })
    this.refreshEntry(newRel)
    this.refreshEntry(archiveRel)
    this.dropEntryPath(oldRel)
    this.emit({ type: 'upserted', id: newId, revision: 1, hash: hashText(newText), external: false })
    return { id: newId, revision: 1, status: successor.status, scope: successor.scope, path: newRel, supersededId: current.record.id }
  }

  async promote(input: PromoteInput): Promise<MutationResult> {
    await this.ensureReady()
    return this.withWriterLock(() => this.promoteLocked(input))
  }

  private promoteLocked(input: PromoteInput): MutationResult {
    const current = this.readUnderLock(input.id)
    if (current === undefined) {
      throw new StoreError('OHMYMEMO_RECORD_INVALID', `record ${input.id} on disk is not a valid record — refusing to mutate`)
    }
    if (current.record.status !== 'candidate') {
      throw new StoreError('OHMYMEMO_NOT_CANDIDATE', `record ${input.id} has status ${current.record.status}, only candidates can be promoted`)
    }
    this.detectExternalEdit(current)
    this.assertCas(current, input.ifRevision, input.ifHash)

    const at = this.now().toISOString()
    const candidateRel = candidateRecordPath(input.id)
    // Promotion strips candidate-only fields; the id is preserved.
    const { candidate_reason: _reason, candidate_expires_at: _expires, ...base } = current.record
    const targetRecord: MemoryRecord = {
      ...base,
      status: 'active',
      revision: current.record.revision + 1,
      updated_at: at,
      confirmed: input.confirm,
      ...(input.confirm ? { last_confirmed_at: at } : {}),
    }
    const targetRel = canonicalRecordPath(targetRecord)
    if (targetRel === undefined) {
      throw new StoreError('OHMYMEMO_INVALID_SCOPE', 'promoted record has no canonical path')
    }
    const targetText = serializeRecord(targetRecord)
    this.checkSize(targetText)
    const targetHash = hashText(targetText)

    this.expectInternal(targetRel, targetHash)
    this.expectInternal(candidateRel)
    runTransaction(this.root, {
      action: 'promote',
      ops: [
        { op: 'write', path: targetRel, content: targetText, after_hash: targetHash },
        { op: 'delete', path: candidateRel, hash: current.hash },
        { op: 'journal', entry: journalEntry(this.now(), 'promoted', targetRecord, targetHash, input.reason) },
      ],
      validateWrite: validateRecordText,
    })
    this.refreshEntry(targetRel)
    this.dropEntryPath(candidateRel)
    this.emit({ type: 'upserted', id: input.id, revision: targetRecord.revision, hash: targetHash, external: false })
    return { id: input.id, revision: targetRecord.revision, status: 'active', scope: targetRecord.scope, path: targetRel }
  }

  async forget(request: ForgetRequest): Promise<ForgetResult> {
    await this.ensureReady()
    return this.withWriterLock(() => this.forgetLocked(request))
  }

  /** Read-only workspace scope resolution for search/capsule (never creates). */
  resolveWorkspaceScopeForRead(cwd: string | undefined): string | undefined {
    if (cwd === undefined || cwd.length === 0) return undefined
    let canonicalPath: string
    try {
      canonicalPath = realpathSync(cwd)
    } catch {
      return undefined
    }
    const entry = this.catalogValue.scopeByPath(canonicalPath)
    return entry !== undefined ? `workspace:${entry.wsId}` : undefined
  }

  /** Mark a record disputed, merging symmetric `contradicts` links (Phase 2 minimal dispute). */
  async markDispute(input: { id: string; ifRevision: number; ifHash: string; contradictsWith?: string[]; reason: string }): Promise<MutationResult> {
    await this.ensureReady()
    return this.withWriterLock(() => {
      const current = this.readUnderLock(input.id)
      if (current === undefined) {
        throw new StoreError('OHMYMEMO_RECORD_INVALID', `record ${input.id} on disk is not a valid record — refusing to mutate`)
      }
      this.detectExternalEdit(current)
      this.assertCas(current, input.ifRevision, input.ifHash)
      const next: MemoryRecord = {
        ...current.record,
        revision: current.record.revision + 1,
        updated_at: this.now().toISOString(),
        status: 'disputed',
        contradicts: [...new Set([...current.record.contradicts, ...(input.contradictsWith ?? [])])],
      }
      return this.publishInPlace(current, next, input.reason)
    })
  }

  /** Reactivate a disputed record (resolution without a replacement). */
  async markActive(input: { id: string; ifRevision: number; ifHash: string; reason: string }): Promise<MutationResult> {
    await this.ensureReady()
    return this.withWriterLock(() => {
      const current = this.readUnderLock(input.id)
      if (current === undefined) {
        throw new StoreError('OHMYMEMO_RECORD_INVALID', `record ${input.id} on disk is not a valid record — refusing to mutate`)
      }
      if (current.record.status !== 'disputed') {
        throw new StoreError('OHMYMEMO_BAD_REQUEST', `record ${input.id} is ${current.record.status}, only disputed records can be reactivated`)
      }
      this.detectExternalEdit(current)
      this.assertCas(current, input.ifRevision, input.ifHash)
      const next: MemoryRecord = {
        ...current.record,
        revision: current.record.revision + 1,
        updated_at: this.now().toISOString(),
        status: 'active',
      }
      return this.publishInPlace(current, next, input.reason)
    })
  }

  /** Shared tail for in-place status/field revisions (single write + journal). */
  private publishInPlace(previous: { record: MemoryRecord; hash: string }, next: MemoryRecord, reason: string): MutationResult {
    const text = serializeRecord(next)
    this.checkSize(text)
    const rel = expectedRel(previous.record)
    this.expectInternal(rel, hashText(text))
    runTransaction(this.root, {
      action: 'update',
      ops: [
        { op: 'write', path: rel, content: text, before_hash: previous.hash, after_hash: hashText(text) },
        { op: 'journal', entry: journalEntry(this.now(), 'updated', next, hashText(text), reason) },
      ],
      validateWrite: validateRecordText,
    })
    this.refreshEntry(rel)
    this.emit({ type: 'upserted', id: next.id, revision: next.revision, hash: hashText(text), external: false })
    return { id: next.id, revision: next.revision, status: next.status, scope: next.scope, path: rel }
  }

  private forgetLocked(request: ForgetRequest): ForgetResult {
    const targets: Array<{ id: string; relPath: string; absPath: string; scope: string; key: string }> = []
    if (request.id !== undefined) {
      const entry = this.catalogValue.get(request.id)
      if (entry === undefined) {
        throw new StoreError('OHMYMEMO_RECORD_NOT_FOUND', `memory ${request.id} not found`)
      }
      targets.push({ id: entry.record.id, relPath: entry.relPath, absPath: entry.absPath, scope: entry.record.scope, key: entry.record.key })
    } else if (request.scope !== undefined && request.key !== undefined) {
      for (const entry of this.catalogValue.allEntries()) {
        if (entry.record.scope === request.scope && entry.record.key === request.key) {
          targets.push({ id: entry.record.id, relPath: entry.relPath, absPath: entry.absPath, scope: entry.record.scope, key: entry.record.key })
        }
      }
      if (targets.length === 0) {
        throw new StoreError('OHMYMEMO_RECORD_NOT_FOUND', `no memories for ${request.scope}/${request.key}`)
      }
    } else {
      throw new StoreError('OHMYMEMO_BAD_REQUEST', 'forget requires exactly one of id or (scope + key)')
    }

    // The tombstone is the read barrier: write it before any body deletion.
    const scope = targets[0]!.scope
    const key = targets[0]!.key
    if (targets.some((target) => target.scope !== scope || target.key !== key)) {
      throw new StoreError('OHMYMEMO_BAD_REQUEST', 'forget by id spans multiple (scope, key) pairs — forget each explicitly')
    }
    const tombstone = {
      schema: 'ohmymemo-tombstone/v1' as const,
      id: newTombstoneId(this.idNow()),
      scope,
      key,
      memory_ids: targets.map((target) => target.id),
      forgotten_at: this.now().toISOString(),
      reason: request.reason ?? 'user-request',
    }
    const tombRel = tombstonePath(tombstone.id)
    const tombText = serializeTombstone(tombstone)

    const ops: LiveTxnOp[] = [
      {
        op: 'write',
        path: tombRel,
        content: tombText,
        after_hash: hashText(tombText),
      },
    ]
    const deletes: Array<{ id: string; rel: string; hash: string }> = []
    for (const target of targets) {
      const hash = hashFile(target.absPath)
      if (hash === undefined) {
        throw new StoreError('OHMYMEMO_RECORD_NOT_FOUND', `memory ${target.id} body missing at ${target.relPath}`)
      }
      deletes.push({ id: target.id, rel: target.relPath, hash })
    }
    for (const target of deletes) {
      ops.push({ op: 'delete', path: target.rel, hash: target.hash })
    }
    ops.push({
      op: 'journal',
      entry: {
        at: this.now().toISOString(),
        action: 'forgotten',
        id: targets.length === 1 ? targets[0]!.id : undefined,
        scope,
        key,
        reason: tombstone.reason,
      },
    })

    this.expectInternal(tombRel, hashText(tombText))
    for (const target of deletes) this.expectInternal(target.rel)
    runTransaction(this.root, { action: 'forget', ops })
    // Register the barrier in-process immediately (no waiting for a watcher).
    const tombScan = scanFile(this.root, tombRel, { maxRecordBytes: this.configValue.max_record_bytes })
    if (tombScan.tombstoneEntry !== undefined) this.catalogValue.upsertTombstone(tombScan.tombstoneEntry)
    for (const target of deletes) {
      this.dropEntryPath(target.rel)
      this.emit({ type: 'removed', id: target.id, external: false })
    }
    this.emit({ type: 'tombstoned', scope, key })
    return { forgottenIds: deletes.map((target) => target.id), tombstoneId: tombstone.id, tombstonePath: tombRel }
  }

  // ------------------------------------------------------------ helpers ----

  private withWriterLock<T>(run: () => T | Promise<T>): Promise<T> {
    return this.lock.withLock(() => {
      this.reconcileCatalogUnderLock()
      return run()
    })
  }

  /** Fold interrupted and cross-process writes before any policy or CAS decision. */
  private reconcileCatalogUnderLock(): void {
    const report = recoverTransactions(this.root, this.now)
    this.baseDiagnostics = this.baseDiagnostics.filter((diagnostic) =>
      diagnostic.code !== 'recovery-deferred' && diagnostic.code !== 'transaction-conflict')
    for (const conflict of report.conflicts) {
      this.baseDiagnostics.push({
        code: 'transaction-conflict',
        severity: 'error',
        message: `transaction ${conflict.id}: ${conflict.message}`,
      })
    }
    if (report.conflicts.length > 0) {
      throw new StoreError('OHMYMEMO_TRANSACTION_CONFLICT', 'unresolved transaction markers block memory mutations')
    }
    if (report.recovered.length + report.aborted.length > 0) {
      this.logger?.warn?.(`dsh-ohmymemo: recovered ${report.recovered.length} transaction(s), aborted ${report.aborted.length}`)
    }
    // Another process may have rewritten config.yaml since our last look:
    // re-read policy first so size/retention/watch decisions under this lock
    // never enforce obsolete limits.
    this.reloadConfigLocked()
    this.handleWatchBatch(['scopes', 'inbox', 'archive', 'tombstones'])
  }

  /** Re-read config.yaml under the writer lock and apply runtime policy. */
  private reloadConfigLocked(): void {
    const snapshot = this.configSnapshot()
    this.applyRuntimeConfig(snapshot.config)
  }

  private resolveScopeValueLocked(input: CreateInput): string {
    if (input.scope === 'user') return 'user'
    if (input.cwd === undefined) {
      throw new StoreError('OHMYMEMO_BAD_REQUEST', 'workspace scope requires cwd')
    }
    const resolution = resolveWorkspaceScope({
      root: this.root,
      catalog: this.catalogValue,
      cwd: input.cwd,
      create: true,
      ...(input.registry !== undefined ? { registry: input.registry } : {}),
      now: this.now,
    })
    if (resolution.created) {
      appendJournal(this.root, { at: this.now().toISOString(), action: 'scope-created', id: resolution.wsId, path: `scopes/workspaces/${resolution.wsId}/scope.yaml` })
      this.emit({ type: 'scope-registered', wsId: resolution.wsId })
    }
    return resolution.scope
  }

  /** Re-read a record under the lock; undefined when disk content is unusable. */
  private readUnderLock(id: string): { record: MemoryRecord; hash: string; relPath: string } | undefined {
    const entry = this.catalogValue.get(id)
    if (entry === undefined) return undefined
    const hash = hashFile(entry.absPath)
    if (hash === undefined) return undefined
    const text = readFileSync(entry.absPath, 'utf8')
    const { record } = parseRecord(text)
    if (record === undefined || record.id !== id) return undefined
    const rel = expectedRel(record)
    if (rel !== entry.relPath) return undefined
    return { record, hash, relPath: entry.relPath }
  }

  /** Disk hash diverged from the catalog ⇒ accept disk, journal the edit. */
  private detectExternalEdit(current: { record: MemoryRecord; hash: string; relPath: string }): void {
    const entry = this.catalogValue.get(current.record.id)
    if (entry === undefined || entry.hash === current.hash) return
    appendJournal(this.root, {
      at: this.now().toISOString(),
      action: 'external-edit-detected',
      id: current.record.id,
      revision: current.record.revision,
      scope: current.record.scope,
      key: current.record.key,
      old_hash: entry.hash,
      new_hash: current.hash,
      path: current.relPath,
    })
    this.logger?.warn?.(`dsh-ohmymemo: external edit detected for ${current.record.id}`)
    this.refreshEntry(current.relPath)
  }

  private assertCas(current: { record: MemoryRecord; hash: string }, ifRevision: number, ifHash: string): void {
    if (current.record.revision !== ifRevision) {
      throw new StoreError('OHMYMEMO_CAS_REVISION', `revision mismatch: expected ${ifRevision}, disk has ${current.record.revision}`, { id: current.record.id, diskRevision: current.record.revision, diskHash: current.hash })
    }
    if (current.hash !== ifHash) {
      throw new StoreError('OHMYMEMO_CAS_HASH', `content hash mismatch: expected ${ifHash}, disk has ${current.hash}`, { id: current.record.id, diskRevision: current.record.revision, diskHash: current.hash })
    }
  }

  private checkSize(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.configValue.max_record_bytes) {
      throw new StoreError('OHMYMEMO_CONTENT_TOO_LARGE', `record is ${bytes} bytes (limit ${this.configValue.max_record_bytes})`)
    }
  }

  /** Record the store's own write so the watcher does not journal it as external. */
  private expectInternal(relPath: string, expectedHash?: string): void {
    this.pendingInternal.set(relPath, { ...(expectedHash !== undefined ? { expected: expectedHash } : {}), expiresAt: Date.now() + PENDING_TTL_MS })
  }

  private consumeInternal(relPath: string, actual: string | undefined): boolean {
    const pending = this.pendingInternal.get(relPath)
    if (pending === undefined) return false
    if (pending.expected !== actual) return false
    this.pendingInternal.delete(relPath)
    return true
  }

  private refreshEntry(relPath: string): void {
    const result = refreshSubtree(this.root, relPath, this.catalogValue, { maxRecordBytes: this.configValue.max_record_bytes })
    this.mergeFileDiagnostics(result.fileDiagnostics)
  }

  private refreshTombstoneBarriers(): void {
    const result = refreshSubtree(this.root, 'tombstones', this.catalogValue, { maxRecordBytes: this.configValue.max_record_bytes })
    this.mergeFileDiagnostics(result.fileDiagnostics)
  }

  /** Merge per-path refresh diagnostics into the store's view (empty clears). */
  private mergeFileDiagnostics(incoming: Map<string, Diagnostic[]>): void {
    for (const [path, list] of incoming) {
      if (list.length === 0) this.fileDiagnostics.delete(path)
      else this.fileDiagnostics.set(path, list)
    }
  }

  private dropEntryPath(relPath: string): void {
    this.catalogValue.removeByPath(relPath)
  }

  private emit(change: MemoryChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // Listener errors never break the store.
      }
    }
  }

  /** Watcher callback: hash-diffed refresh with external-change journaling. */
  private handleWatchBatch(changed: string[]): void {
    const nowMs = Date.now()
    for (const [rel, pending] of this.pendingInternal) {
      if (pending.expiresAt < nowMs) this.pendingInternal.delete(rel)
    }
    for (const rel of changed) {
      if (parseLocation(rel).type === 'store-config') {
        this.reloadConfigFromWatch(rel)
        continue
      }
      const before = this.snapshotUnder(rel)
      const result = refreshSubtree(this.root, rel, this.catalogValue, { maxRecordBytes: this.configValue.max_record_bytes })
      this.mergeFileDiagnostics(result.fileDiagnostics)
      for (const id of result.updated) {
        const entry = this.catalogValue.get(id)
        const relPath = entry?.relPath ?? ''
        const isInternal = entry !== undefined && this.consumeInternal(relPath, entry.hash)
        if (!isInternal) {
          appendJournal(this.root, {
            at: this.now().toISOString(),
            action: 'external-edit-detected',
            id,
            ...(before.get(id) !== undefined ? { old_hash: before.get(id)?.hash } : {}),
            ...(entry !== undefined ? { new_hash: entry.hash, revision: entry.record.revision, scope: entry.record.scope, key: entry.record.key } : {}),
            path: relPath,
          })
          this.emit({ type: 'upserted', id, revision: entry?.record.revision ?? 0, hash: entry?.hash ?? '', external: true })
        } else {
          this.emit({ type: 'upserted', id, revision: entry?.record.revision ?? 0, hash: entry?.hash ?? '', external: false })
        }
      }
      for (const id of result.added) {
        const entry = this.catalogValue.get(id)
        if (entry !== undefined && this.consumeInternal(entry.relPath, entry.hash)) continue
        this.emit({ type: 'upserted', id, revision: entry?.record.revision ?? 0, hash: entry?.hash ?? '', external: true })
      }
      for (const id of result.removed) {
        const relPath = before.get(id)?.relPath
        const wasInternal = relPath !== undefined && this.consumeInternal(relPath, undefined)
        if (wasInternal) continue
        appendJournal(this.root, {
          at: this.now().toISOString(),
          action: 'external-removal',
          id,
          ...(before.get(id) !== undefined ? { scope: before.get(id)?.scope, key: before.get(id)?.key, path: relPath } : {}),
        })
        this.emit({ type: 'removed', id, external: true })
      }
    }
  }

  private reloadConfigFromWatch(rel: string): void {
    const abs = join(this.root, 'config.yaml')
    const hash = hashFile(abs)
    if (this.consumeInternal(rel, hash)) return
    this.baseDiagnostics = this.baseDiagnostics.filter((diagnostic) => diagnostic.code !== 'config-invalid')
    if (hash === undefined) {
      this.applyRuntimeConfig(defaultStoreConfig())
      this.baseDiagnostics.push({
        code: 'config-invalid',
        severity: 'warning',
        message: 'config.yaml is missing; using defaults until it is restored',
      })
      this.emit({ type: 'config-updated', hash: '', external: true })
      return
    }
    const parsed = parseStoreConfig(readFileSync(abs, 'utf8'))
    this.applyRuntimeConfig(parsed.config)
    for (const issue of parsed.issues) {
      this.baseDiagnostics.push({
        code: 'config-invalid',
        severity: 'warning',
        message: `config.yaml ${issue.field !== undefined ? `field "${issue.field}"` : ''}: ${issue.message}`,
      })
    }
    this.emit({ type: 'config-updated', hash, external: true })
  }

  /** Catalog snapshot for paths under a prefix (for external-change journals). */
  private snapshotUnder(rel: string): Map<string, { hash: string; relPath: string; scope: string; key: string }> {
    const out = new Map<string, { hash: string; relPath: string; scope: string; key: string }>()
    const prefix = `${rel}/`
    for (const entry of this.catalogValue.allEntries()) {
      if (entry.relPath === rel || entry.relPath.startsWith(prefix)) {
        out.set(entry.record.id, { hash: entry.hash, relPath: entry.relPath, scope: entry.record.scope, key: entry.record.key })
      }
    }
    return out
  }

  lockDebugInfo(): LockInfo | undefined {
    return this.lock.holderInfo()
  }
}

// ----------------------------------------------------------- utilities ----

function expectedRel(record: MemoryRecord): string {
  const rel = record.status === 'candidate'
    ? candidateRecordPath(record.id)
    : record.status === 'superseded'
      ? archiveRecordPath(record)
      : canonicalRecordPath(record)
  if (rel === undefined) {
    throw new StoreError('OHMYMEMO_INVALID_SCOPE', `cannot derive path for record ${record.id}`)
  }
  return rel
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (tags === undefined) return []
  const out: string[] = []
  for (const tag of tags) {
    const normalized = normalizeTag(tag)
    if (normalized === undefined) {
      throw new StoreError('OHMYMEMO_INVALID_KEY', `tag "${tag}" cannot be normalized`)
    }
    if (!out.includes(normalized)) out.push(normalized)
  }
  if (out.length > 8) throw new StoreError('OHMYMEMO_BAD_REQUEST', 'at most 8 tags per record')
  return out
}

function validateRecordText(text: string): void {
  const { record, issues } = parseRecord(text)
  if (record === undefined) {
    throw new StoreError('OHMYMEMO_RECORD_INVALID', `refusing to publish unparsable record: ${issues.map((issue) => issue.message).join('; ')}`)
  }
}

function validateConfigText(text: string): void {
  const parsed = parseStoreConfig(text)
  if (parsed.issues.length > 0) {
    throw new StoreError('OHMYMEMO_CONFIG_INVALID', `refusing to publish invalid config: ${parsed.issues.map((issue) => issue.message).join('; ')}`)
  }
}

function journalEntry(at: Date, action: JournalEntry['action'], record: MemoryRecord, hash: string, reason?: string): JournalEntry {
  const primary = record.sources[0]
  const entry: JournalEntry = {
    at: at.toISOString(),
    action,
    id: record.id,
    revision: record.revision,
    scope: record.scope,
    key: record.key,
    content_hash: hash,
    ...(primary?.session_id !== undefined ? { source: { session_id: primary.session_id, ...(primary.event_seq !== undefined ? { event_seq: primary.event_seq } : {}) } } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
  return entry
}
