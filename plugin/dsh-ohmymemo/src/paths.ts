/**
 * Store layout: path derivation and location classification. All internal
 * paths are store-relative and `/`-separated; conversion to platform paths
 * happens at the fs edge only.
 *
 * Layout (see the design doc):
 *
 * ```text
 * scopes/user/{semantic,procedural}/mem_<ulid>.md
 * scopes/user/episodic/YYYY/MM/mem_<ulid>.md
 * scopes/workspaces/<ws>/…same three kind dirs…
 * inbox/candidates/mem_<ulid>.md
 * archive/{user,workspaces/<ws>}/<kind>/mem_<ulid>.md
 * tombstones/tomb_<ulid>.yaml
 * journal/YYYY/MM.jsonl
 * .state/transactions/<txn>.yaml   .state/locks/writer.lock/
 * manifest.yaml   config.yaml      views/…(Phase 2)   .cache/
 * ```
 * @module dsh-ohmymemo/paths
 */

import { MEM_ID_RE, TOMB_ID_RE, TXN_ID_RE, WS_ID_RE } from './ids.ts'
import type { MemoryKind, MemoryRecord, MemoryStatus } from './types.ts'

/** Directory name of the store inside `$DSH_HOME`. */
export const STORE_DIR_NAME = 'ohmymemo'

/** Store root for a DSH home; `dshHomeEnv` wins when non-empty (mirrors the harness convention). */
export function defaultStoreRoot(dshHomeEnv: string | undefined, home: string): string {
  const base = dshHomeEnv !== undefined && dshHomeEnv.length > 0 ? dshHomeEnv : `${home}/.dsh`
  return `${base}/${STORE_DIR_NAME}`
}

/** Top-level areas the scanner walks. */
export const SCAN_AREAS = ['scopes', 'inbox', 'archive', 'tombstones'] as const

/** Statuses allowed in the canonical area (scopes/). */
const CANONICAL_STATUSES: ReadonlySet<string> = new Set(['active', 'disputed'])

/** Map a scope value to its directory segments under scopes/ or archive/. */
export function scopeSegments(scope: string): string[] | undefined {
  if (scope === 'user') return ['user']
  const match = /^workspace:(ws_[0-9A-HJKMNP-TV-Z]{26})$/.exec(scope)
  if (match === null) return undefined
  return ['workspaces', match[1] ?? '']
}

/** Build a scope value from parsed directory segments. */
export function scopeFromSegments(segments: string[]): string | undefined {
  if (segments.length === 1 && segments[0] === 'user') return 'user'
  if (segments.length === 2 && segments[0] === 'workspaces' && WS_ID_RE.test(segments[1] ?? '')) {
    return `workspace:${segments[1]}`
  }
  return undefined
}

/** Episodic YYYY/MM nesting derived from created_at. */
function episodicSegments(record: Pick<MemoryRecord, 'kind' | 'created_at'>): string[] | undefined {
  const match = /^(\d{4})-(\d{2})-/.exec(record.created_at)
  if (match === null) return undefined
  return [match[1] ?? '', match[2] ?? '']
}

/** Canonical (scopes/) relative path for a record. */
export function canonicalRecordPath(record: Pick<MemoryRecord, 'id' | 'scope' | 'kind' | 'created_at'>): string | undefined {
  const scopeSegs = scopeSegments(record.scope)
  if (scopeSegs === undefined) return undefined
  const segments = ['scopes', ...scopeSegs, record.kind]
  if (record.kind === 'episodic') {
    const nest = episodicSegments(record)
    if (nest === undefined) return undefined
    segments.push(...nest)
  }
  segments.push(`${record.id}.md`)
  return segments.join('/')
}

/** Candidate inbox relative path. */
export function candidateRecordPath(id: string): string {
  return `inbox/candidates/${id}.md`
}

/** Archive relative path for a superseded record (episodic flattens to kind dir). */
export function archiveRecordPath(record: Pick<MemoryRecord, 'id' | 'scope' | 'kind'>): string | undefined {
  const scopeSegs = scopeSegments(record.scope)
  if (scopeSegs === undefined) return undefined
  return ['archive', ...scopeSegs, record.kind, `${record.id}.md`].join('/')
}

/** The area a record file belongs in for its current status. */
export function expectedAreaForStatus(status: MemoryStatus): 'canonical' | 'candidate' | 'archive' | undefined {
  if (status === 'candidate') return 'candidate'
  if (status === 'superseded') return 'archive'
  if (CANONICAL_STATUSES.has(status)) return 'canonical'
  return undefined
}

/** Tombstone relative path. */
export function tombstonePath(id: string): string {
  return `tombstones/${id}.yaml`
}

/** Journal relative path for a timestamp (year directory, `MM.jsonl` monthly file). */
export function journalPath(isoTimestamp: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-/.exec(isoTimestamp)
  if (match === null) return undefined
  return `journal/${match[1]}/${match[2]}.jsonl`
}

/** Transaction marker relative path. */
export function transactionPath(id: string): string {
  return `.state/transactions/${id}.yaml`
}

/** Writer lock directory (a directory, acquired via atomic mkdir). */
export const WRITER_LOCK_REL = '.state/locks/writer.lock'

/** Parsed location of a file inside the store. */
export type Location =
  | { type: 'record'; area: 'canonical' | 'candidate' | 'archive'; scope: string; kind: MemoryKind; id: string; year?: number; month?: number }
  | { type: 'tombstone'; id: string }
  | { type: 'scope-file'; wsId: string }
  | { type: 'manifest' }
  | { type: 'store-config' }
  | { type: 'journal' }
  | { type: 'transaction'; id: string }
  | { type: 'lock' }
  | { type: 'view' }
  | { type: 'cache' }
  | { type: 'unknown' }

const KINDS: ReadonlySet<string> = new Set(['semantic', 'episodic', 'procedural'])
const YEAR_RE = /^(19|20)\d{2}$/
const MONTH_RE = /^(0[1-9]|1[0-2])$/

/**
 * Classify a store-relative path. Pure: callers (scanner, watcher) use it to
 * route files without touching the filesystem, and to validate that a file's
 * location agrees with its frontmatter.
 */
export function parseLocation(relPath: string): Location {
  const segments = relPath.split('/')
  const first = segments[0] ?? ''
  if (first === 'manifest.yaml' && segments.length === 1) return { type: 'manifest' }
  if (first === 'config.yaml' && segments.length === 1) return { type: 'store-config' }
  if (first === '.state') {
    if (relPath === WRITER_LOCK_REL || relPath.startsWith(`${WRITER_LOCK_REL}/`)) return { type: 'lock' }
    if (segments[1] === 'transactions' && segments.length === 3 && segments[2]?.endsWith('.yaml')) {
      const id = segments[2]!.slice(0, -'.yaml'.length)
      if (TXN_ID_RE.test(id)) return { type: 'transaction', id }
    }
    return { type: 'unknown' }
  }
  if (first === 'journal') return { type: 'journal' }
  if (first === 'views') return { type: 'view' }
  if (first === '.cache') return { type: 'cache' }
  if (first === 'tombstones' && segments.length === 2 && segments[1]?.endsWith('.yaml')) {
    const id = segments[1]!.slice(0, -'.yaml'.length)
    if (TOMB_ID_RE.test(id)) return { type: 'tombstone', id }
    return { type: 'unknown' }
  }
  // Record areas: canonical / candidate / archive.
  let area: 'canonical' | 'candidate' | 'archive' | undefined
  let index = 1
  if (first === 'scopes') area = 'canonical'
  else if (first === 'inbox' && segments[1] === 'candidates') {
    area = 'candidate'
    index = 2
  } else if (first === 'archive') area = 'archive'
  if (area === undefined) return { type: 'unknown' }

  // Workspace registration file: scopes/workspaces/<ws>/scope.yaml (not .md).
  if (segments.length >= 3 && segments[1] === 'workspaces' && segments[segments.length - 1] === 'scope.yaml') {
    const wsId = segments[2] ?? ''
    if (first === 'scopes' && segments.length === 4 && WS_ID_RE.test(wsId)) {
      return { type: 'scope-file', wsId }
    }
    return { type: 'unknown' }
  }

  const file = segments[segments.length - 1] ?? ''
  if (!file.endsWith('.md')) return { type: 'unknown' }
  const id = file.slice(0, -3)
  if (!MEM_ID_RE.test(id)) return { type: 'unknown' }

  if (area === 'candidate') {
    if (segments.length !== index + 1) return { type: 'unknown' }
    return { type: 'record', area, scope: '', kind: 'semantic', id }
  }

  // canonical/archive: <area> <scope...> <kind> [YYYY MM] <id>.md
  let scopeSegCount: number
  if (segments[index] === 'user') scopeSegCount = 1
  else if (segments[index] === 'workspaces' && WS_ID_RE.test(segments[index + 1] ?? '')) scopeSegCount = 2
  else return { type: 'unknown' }
  const scope = scopeFromSegments(segments.slice(index, index + scopeSegCount))
  if (scope === undefined) return { type: 'unknown' }
  index += scopeSegCount
  const kind = segments[index]
  if (kind === undefined || !KINDS.has(kind)) return { type: 'unknown' }
  index += 1
  let year: number | undefined
  let month: number | undefined
  if (kind === 'episodic' && area === 'canonical') {
    const y = segments[index]
    const m = segments[index + 1]
    if (y === undefined || m === undefined || !YEAR_RE.test(y) || !MONTH_RE.test(m)) return { type: 'unknown' }
    year = Number(y)
    month = Number(m)
    index += 2
  }
  if (segments.length !== index + 1) return { type: 'unknown' }
  return { type: 'record', area, scope, kind: kind as MemoryKind, id, ...(year !== undefined ? { year } : {}), ...(month !== undefined ? { month } : {}) }
}

/** Whether a location refers to something the watcher must react to. */
export function isWatchRelevant(location: Location): boolean {
  return location.type === 'record'
    || location.type === 'tombstone'
    || location.type === 'scope-file'
    || location.type === 'store-config'
}
