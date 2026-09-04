/**
 * Store scanning: build the in-process catalog from the canonical Markdown
 * tree, and refresh it incrementally when the watcher reports changes. Pure
 * filesystem reads only — the scanner never moves or repairs user files;
 * broken files are diagnosed and excluded from recall (fail closed).
 * @module dsh-ohmymemo/scan
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hashBytes, statFile } from './atomic.ts'
import { MemoryCatalog, makeEntry } from './catalog.ts'
import { archiveRecordPath, canonicalRecordPath, candidateRecordPath, parseLocation, SCAN_AREAS } from './paths.ts'
import { parseRecord, parseScopeFile, parseTombstone } from './schema.ts'
import type { CatalogEntry, Diagnostic, MemoryRecord, ScopeEntry, TombstoneEntry } from './types.ts'

/** Scanner limits. */
export interface ScanOptions {
  maxRecordBytes: number
}

/** Result of one full scan. */
export interface ScanResult {
  catalog: MemoryCatalog
  /** Flat list: per-file issues plus catalog invariants. */
  diagnostics: Diagnostic[]
  /** Per-file issues keyed by store-relative path (replaced on refresh). */
  fileDiagnostics: Map<string, Diagnostic[]>
  durationMs: number
  filesSeen: number
}

/** Result of parsing one file from disk. */
export interface FileScan {
  entry?: CatalogEntry
  tombstoneEntry?: TombstoneEntry
  scopeEntry?: ScopeEntry
  diagnostics: Diagnostic[]
}

/** Result of an incremental subtree refresh. */
export interface RefreshResult {
  added: string[]
  updated: string[]
  removed: string[]
  /** Per-file issues keyed by store-relative path (replaces prior entries). */
  fileDiagnostics: Map<string, Diagnostic[]>
}

/**
 * Full scan of `scopes/`, `inbox/`, `archive/` and `tombstones/`. Builds a
 * fresh catalog; the caller (store) swaps it in under its own freshness
 * rules.
 */
export function scanStore(root: string, options: ScanOptions): ScanResult {
  const started = Date.now()
  const catalog = new MemoryCatalog()
  const fileDiagnostics = new Map<string, Diagnostic[]>()
  const diagnostics: Diagnostic[] = []
  let filesSeen = 0
  for (const area of SCAN_AREAS) {
    const abs = join(root, area)
    if (!isDir(abs)) continue
    for (const rel of walk(join(root, area), root)) {
      filesSeen += 1
      const scan = scanFile(root, rel, options)
      if (scan.diagnostics.length > 0) fileDiagnostics.set(rel, scan.diagnostics)
      diagnostics.push(...scan.diagnostics)
      if (scan.entry !== undefined) catalog.upsertEntry(scan.entry)
      if (scan.tombstoneEntry !== undefined) catalog.upsertTombstone(scan.tombstoneEntry)
      if (scan.scopeEntry !== undefined) catalog.registerScope(scan.scopeEntry)
    }
  }
  catalog.recomputeInvariants()
  diagnostics.push(...catalog.invariantDiagnostics())
  return { catalog, diagnostics, fileDiagnostics, durationMs: Date.now() - started, filesSeen }
}

/** Parse one store-relative file into catalog-shaped data. */
export function scanFile(root: string, relPath: string, options: ScanOptions): FileScan {
  const diagnostics: Diagnostic[] = []
  const abs = join(root, ...relPath.split('/'))
  const location = parseLocation(relPath)
  if (location.type === 'unknown' || !isRelevantName(relPath)) {
    return { diagnostics }
  }
  const info = statFile(abs)
  if (info === undefined) {
    diagnostics.push({ code: 'unreadable-file', severity: 'error', message: `cannot stat ${relPath}`, path: relPath })
    return { diagnostics }
  }
  if (location.type === 'record' && info.bytes > options.maxRecordBytes) {
    diagnostics.push({
      code: 'record-too-large',
      severity: 'error',
      message: `record ${relPath} is ${info.bytes} bytes (limit ${options.maxRecordBytes}) — excluded from recall`,
      path: relPath,
    })
    return { diagnostics }
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (error) {
    diagnostics.push({ code: 'unreadable-file', severity: 'error', message: `cannot read ${relPath}: ${(error as Error).message}`, path: relPath })
    return { diagnostics }
  }
  const hash = hashBytes(bytes)

  if (location.type === 'tombstone') {
    const { tombstone, issues } = parseTombstone(bytes.toString('utf8'))
    if (tombstone === undefined) {
      diagnostics.push({ code: 'tombstone-invalid', severity: 'error', message: `tombstone ${relPath}: ${formatIssues(issues)}`, path: relPath })
      return { diagnostics }
    }
    if (tombstone.id !== location.id) {
      diagnostics.push({ code: 'tombstone-invalid', severity: 'error', message: `tombstone ${relPath} declares id ${tombstone.id} — file name mismatch`, path: relPath })
      return { diagnostics }
    }
    return { tombstoneEntry: { tombstone, relPath, absPath: abs, hash }, diagnostics }
  }

  if (location.type === 'scope-file') {
    const { scope, issues } = parseScopeFile(bytes.toString('utf8'))
    if (scope === undefined) {
      diagnostics.push({ code: 'scope-invalid', severity: 'error', message: `scope file ${relPath}: ${formatIssues(issues)}`, path: relPath })
      return { diagnostics }
    }
    if (scope.id !== location.wsId) {
      diagnostics.push({ code: 'scope-invalid', severity: 'error', message: `scope file ${relPath} declares id ${scope.id} — directory mismatch`, path: relPath })
      return { diagnostics }
    }
    return { scopeEntry: { scope, wsId: location.wsId, relPath }, diagnostics }
  }

  // record
  const text = bytes.toString('utf8')
  const { record, issues } = parseRecord(text)
  if (record === undefined) {
    const schemaIssue = issues.find((issue) => issue.field === 'schema')
    const code = schemaIssue !== undefined ? 'record-schema-version' : 'record-invalid'
    diagnostics.push({ code, severity: 'error', message: `record ${relPath}: ${formatIssues(issues)}`, path: relPath })
    return { diagnostics }
  }
  const mismatch = expectedPathFor(record) === relPath ? undefined : expectedPathFor(record)
  if (mismatch !== undefined) {
    diagnostics.push({
      code: 'path-mismatch',
      severity: 'error',
      message: `record ${record.id} at ${relPath} does not match its frontmatter (expected ${mismatch}) — excluded from recall`,
      path: relPath,
      id: record.id,
    })
  }
  return {
    entry: makeEntry({
      record,
      relPath,
      absPath: abs,
      hash,
      bytes: info.bytes,
      mtimeMs: info.mtimeMs,
      ...(mismatch !== undefined ? { quarantine: 'path-mismatch' as const } : {}),
    }),
    diagnostics,
  }
}

/** The canonical location a record's frontmatter says it belongs at. */
export function expectedPathFor(record: MemoryRecord): string | undefined {
  if (record.status === 'candidate') return candidateRecordPath(record.id)
  if (record.status === 'superseded') return archiveRecordPath(record)
  return canonicalRecordPath(record)
}

/**
 * Incrementally refresh a subtree (a directory or a single file path) against
 * the catalog: files present on disk are revalidated, catalog entries under
 * the prefix whose files vanished are removed. Returns id-level changes for
 * external-change journaling.
 */
export function refreshSubtree(root: string, relTarget: string, catalog: MemoryCatalog, options: ScanOptions): RefreshResult {
  const result: RefreshResult = { added: [], updated: [], removed: [], fileDiagnostics: new Map() }
  const target = relTarget.replace(/\/+$/, '')
  const abs = join(root, ...target.split('/'))
  const prefix = target.length === 0 ? '' : `${target}/`

  const onDisk = new Set<string>()
  if (isFile(abs)) {
    onDisk.add(target)
  } else if (isDir(abs)) {
    for (const rel of walk(abs, root)) onDisk.add(rel)
  }

  // Remove vanished entries under the prefix (their diagnostics go too).
  for (const entry of catalog.allEntries()) {
    if (entry.relPath === target || entry.relPath.startsWith(prefix)) {
      if (!onDisk.has(entry.relPath)) {
        catalog.removeByPath(entry.relPath)
        result.removed.push(entry.record.id)
        result.fileDiagnostics.set(entry.relPath, [])
      }
    }
  }
  for (const tombstone of [...catalog.tombstones().values()]) {
    if (tombstone.relPath === target || tombstone.relPath.startsWith(prefix)) {
      if (!onDisk.has(tombstone.relPath)) catalog.removeTombstoneById(tombstone.tombstone.id)
    }
  }

  // Revalidate present files under the prefix (per-file diagnostics replace).
  for (const rel of onDisk) {
    if (!isRelevantName(rel)) continue
    const location = parseLocation(rel)
    if (location.type === 'unknown') continue
    const scan = scanFile(root, rel, options)
    if (scan.diagnostics.length > 0) result.fileDiagnostics.set(rel, scan.diagnostics)
    else result.fileDiagnostics.set(rel, [])
    if (scan.entry !== undefined) {
      const existing = catalog.get(scan.entry.record.id)
      if (existing === undefined) {
        catalog.upsertEntry(scan.entry)
        if (scan.entry.quarantine === undefined) result.added.push(scan.entry.record.id)
      } else if (existing.hash !== scan.entry.hash || existing.relPath !== scan.entry.relPath) {
        catalog.upsertEntry(scan.entry)
        if (scan.entry.quarantine === undefined) result.updated.push(scan.entry.record.id)
      }
    } else if (location.type === 'record') {
      // The file stopped being an acceptable record (oversize/unparsable):
      // drop whatever the catalog still holds at that path.
      const id = catalog.idForPath(rel)
      if (id !== undefined) {
        catalog.removeById(id)
        result.removed.push(id)
      }
    }
    if (scan.tombstoneEntry !== undefined) catalog.upsertTombstone(scan.tombstoneEntry)
    if (scan.scopeEntry !== undefined) catalog.registerScope(scan.scopeEntry)
  }
  catalog.recomputeInvariants()
  return result
}

/** Whether a path's base name is scanner-relevant (skips temp/dot files). */
function isRelevantName(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? ''
  return !base.startsWith('.')
}

function isDir(abs: string): boolean {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

/** Walk a directory subtree, returning store-relative file paths. */
function walk(absDir: string, root: string): string[] {
  const out: string[] = []
  const recurse = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        recurse(child)
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue
        out.push(toRel(child, root))
      }
    }
  }
  recurse(absDir)
  return out
}

function toRel(abs: string, root: string): string {
  const rel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs
  return rel.split('/').join('/')
}

function formatIssues(issues: Array<{ field?: string; message: string }>): string {
  return issues
    .slice(0, 3)
    .map((issue) => (issue.field !== undefined ? `${issue.field}: ${issue.message}` : issue.message))
    .join('; ')
}
