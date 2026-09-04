/**
 * The in-process catalog: a disposable view of the canonical Markdown tree,
 * rebuilt from disk at open and incrementally refreshed by the watcher. It
 * holds path → entry as the source of truth (duplicate ids keep every copy),
 * a derived id → representative index, tombstones, and workspace scope
 * registrations, plus the fail-closed quarantine marks.
 *
 * The catalog is never a second source of truth: readers re-read files by id
 * before trusting content; the watcher reconciles it against disk hashes.
 * @module dsh-ohmymemo/catalog
 */

import { normalizeText } from './schema.ts'
import type { CatalogEntry, Diagnostic, MemoryKind, MemoryStatus, QuarantineReason, ScopeEntry, Tombstone, TombstoneEntry } from './types.ts'

/** Key of the (scope, kind, key) conflict index. */
export function conflictKey(scope: string, kind: MemoryKind, key: string): string {
  return `${scope}|${kind}|${key}`
}

/** Aggregate counts for logs and doctor. */
export interface CatalogStats {
  active: number
  candidate: number
  disputed: number
  superseded: number
  quarantined: number
  tombstones: number
  scopes: number
}

/**
 * In-memory catalog. Not thread-safe; the owning store serializes access.
 * Path-keyed storage is what makes duplicate-id detection possible: an
 * id-keyed map would silently swallow the second copy.
 */
export class MemoryCatalog {
  /** Every catalogued file, keyed by store-relative path. */
  private readonly byPath = new Map<string, CatalogEntry>()
  /** Derived id → representative entry (deterministic: lowest relPath). */
  private readonly primary = new Map<string, CatalogEntry>()
  private readonly tombstoneById = new Map<string, TombstoneEntry>()
  private readonly scopeByWs = new Map<string, ScopeEntry>()

  /** All entries, including quarantined copies. */
  allEntries(): CatalogEntry[] {
    return [...this.byPath.values()]
  }

  /** Representative entry per id (duplicates collapse; see quarantine). */
  entries(): ReadonlyMap<string, CatalogEntry> {
    return this.primary
  }

  tombstones(): ReadonlyMap<string, TombstoneEntry> {
    return this.tombstoneById
  }

  scopes(): ReadonlyMap<string, ScopeEntry> {
    return this.scopeByWs
  }

  get(id: string): CatalogEntry | undefined {
    return this.primary.get(id)
  }

  /** Entries eligible for ordinary recall: unquarantined, active or disputed. */
  activeEntries(): CatalogEntry[] {
    const out: CatalogEntry[] = []
    for (const entry of this.byPath.values()) {
      if (entry.quarantine !== undefined) continue
      if (entry.record.status !== 'active' && entry.record.status !== 'disputed') continue
      out.push(entry)
    }
    return out
  }

  /** Active/disputed entries for one conflict key (unquarantined). */
  byConflictKey(scope: string, kind: MemoryKind, key: string): CatalogEntry[] {
    const wanted = conflictKey(scope, kind, key)
    const out: CatalogEntry[] = []
    for (const entry of this.byPath.values()) {
      if (entry.quarantine !== undefined) continue
      if (entry.record.status !== 'active' && entry.record.status !== 'disputed') continue
      if (conflictKey(entry.record.scope, entry.record.kind, entry.record.key) === wanted) out.push(entry)
    }
    return out
  }

  /** Active tombstone barrier for (scope, key): any tombstone blocks. */
  tombstoneFor(scope: string, key: string): Tombstone | undefined {
    for (const entry of this.tombstoneById.values()) {
      if (entry.tombstone.scope === scope && entry.tombstone.key === key) return entry.tombstone
    }
    return undefined
  }

  upsertEntry(entry: CatalogEntry): void {
    this.byPath.set(entry.relPath, entry)
    this.recomputeInvariants()
  }

  removeByPath(relPath: string): CatalogEntry | undefined {
    const entry = this.byPath.get(relPath)
    if (entry === undefined) return undefined
    this.byPath.delete(relPath)
    this.recomputeInvariants()
    return entry
  }

  removeById(id: string): CatalogEntry | undefined {
    const representative = this.primary.get(id)
    for (const [path, entry] of this.byPath) {
      if (entry.record.id === id) this.byPath.delete(path)
    }
    this.recomputeInvariants()
    return representative
  }

  idForPath(relPath: string): string | undefined {
    return this.byPath.get(relPath)?.record.id
  }

  upsertTombstone(entry: TombstoneEntry): void {
    this.tombstoneById.set(entry.tombstone.id, entry)
  }

  removeTombstoneById(id: string): void {
    this.tombstoneById.delete(id)
  }

  registerScope(entry: ScopeEntry): void {
    this.scopeByWs.set(entry.wsId, entry)
  }

  unregisterScope(wsId: string): void {
    this.scopeByWs.delete(wsId)
  }

  /** Scope registration whose canonical_path matches, if any. */
  scopeByPath(canonicalPath: string): ScopeEntry | undefined {
    for (const entry of this.scopeByWs.values()) {
      if (entry.scope.canonical_path === canonicalPath) return entry
    }
    return undefined
  }

  /** Scope registration carrying a dsh workspace id, if any. */
  scopeByDshId(dshWorkspaceId: string): ScopeEntry | undefined {
    for (const entry of this.scopeByWs.values()) {
      if (entry.scope.dsh_workspace_id === dshWorkspaceId) return entry
    }
    return undefined
  }

  /**
   * Recompute derived state: representative per id, fail-closed marks
   * (duplicate ids quarantine every copy; single-cardinality keys with more
   * than one active value quarantine each). Called after every mutation —
   * O(n) over a catalog sized for human memory.
   */
  recomputeInvariants(): void {
    // Representative per id: deterministic lowest path wins.
    this.primary.clear()
    const pathsById = new Map<string, string[]>()
    for (const [path, entry] of this.byPath) {
      const id = entry.record.id
      const paths = pathsById.get(id) ?? []
      paths.push(path)
      pathsById.set(id, paths)
    }
    for (const [id, paths] of pathsById) {
      const sorted = [...paths].sort()
      const representative = this.byPath.get(sorted[0] ?? '')
      if (representative !== undefined) this.primary.set(id, representative)
    }

    // Duplicate ids: every copy fails closed.
    const duplicateIds = new Set<string>()
    for (const [id, paths] of pathsById) {
      if (paths.length > 1) duplicateIds.add(id)
    }

    // Single-cardinality keys with multiple active values.
    const activeByKey = new Map<string, CatalogEntry[]>()
    for (const entry of this.byPath.values()) {
      if (entry.quarantine === 'path-mismatch') continue
      if (entry.record.status !== 'active') continue
      if (entry.record.cardinality !== 'single') continue
      const key = conflictKey(entry.record.scope, entry.record.kind, entry.record.key)
      const bucket = activeByKey.get(key) ?? []
      bucket.push(entry)
      activeByKey.set(key, bucket)
    }
    const keyConflictIds = new Set<string>()
    for (const bucket of activeByKey.values()) {
      if (bucket.length > 1) {
        for (const entry of bucket) keyConflictIds.add(entry.record.id)
      }
    }

    for (const entry of this.byPath.values()) {
      if (entry.quarantine === 'path-mismatch') continue
      let mark: QuarantineReason | undefined
      if (duplicateIds.has(entry.record.id)) mark = 'duplicate-id'
      else if (keyConflictIds.has(entry.record.id)) mark = 'single-key-conflict'
      entry.quarantine = mark
    }
  }

  /** Diagnostics for current invariant violations (scan/doctor surface). */
  invariantDiagnostics(): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const emittedDuplicates = new Set<string>()
    for (const entry of this.allEntries()) {
      if (entry.quarantine === 'duplicate-id' && !emittedDuplicates.has(entry.record.id)) {
        emittedDuplicates.add(entry.record.id)
        diagnostics.push({
          code: 'duplicate-id',
          severity: 'error',
          message: `memory id ${entry.record.id} exists in multiple files — all copies excluded from recall until resolved`,
          id: entry.record.id,
          path: entry.relPath,
        })
      }
    }
    const emittedKeyConflicts = new Set<string>()
    for (const entry of this.allEntries()) {
      if (entry.quarantine !== 'single-key-conflict') continue
      const key = conflictKey(entry.record.scope, entry.record.kind, entry.record.key)
      if (emittedKeyConflicts.has(key)) continue
      emittedKeyConflicts.add(key)
      diagnostics.push({
        code: 'single-key-conflict',
        severity: 'error',
        message: `single-cardinality key ${key} has multiple active records — excluded from recall until resolved`,
        id: entry.record.id,
        path: entry.relPath,
      })
    }
    return diagnostics
  }

  stats(): CatalogStats {
    const stats: CatalogStats = { active: 0, candidate: 0, disputed: 0, superseded: 0, quarantined: 0, tombstones: this.tombstoneById.size, scopes: this.scopeByWs.size }
    for (const entry of this.byPath.values()) {
      if (entry.quarantine !== undefined) {
        stats.quarantined += 1
        continue
      }
      const status: MemoryStatus = entry.record.status
      if (status === 'active') stats.active += 1
      else if (status === 'candidate') stats.candidate += 1
      else if (status === 'disputed') stats.disputed += 1
      else stats.superseded += 1
    }
    return stats
  }
}

/** Build a catalog entry from a parsed record and its file facts. */
export function makeEntry(parts: {
  record: CatalogEntry['record']
  relPath: string
  absPath: string
  hash: string
  bytes: number
  mtimeMs: number
  quarantine?: QuarantineReason
}): CatalogEntry {
  return {
    record: parts.record,
    relPath: parts.relPath,
    absPath: parts.absPath,
    hash: parts.hash,
    bytes: parts.bytes,
    mtimeMs: parts.mtimeMs,
    normalizedBody: parts.record.status === 'active' || parts.record.status === 'disputed' ? normalizeText(parts.record.body) : '',
    ...(parts.quarantine !== undefined ? { quarantine: parts.quarantine } : {}),
  }
}
