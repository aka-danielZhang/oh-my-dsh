/**
 * Bounded, read-only projection of user-facing Markdown files. Store internals
 * (`journal`, `.state`, config, scope metadata, and tombstones) never enter the
 * browser-facing index.
 * @module dsh-ohmymemo/explorer
 */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, posix, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { MemoryCatalog } from './catalog.ts'
import { StoreError } from './errors.ts'
import { hashText } from './atomic.ts'
import { parseRecord } from './schema.ts'
import type { CatalogEntry, MemoryKind, MemoryPrivacy, MemoryStatus } from './types.ts'
import { composeView, isCoreViewEntry } from './views.ts'

/** One file row safe to transfer to the browser. */
export interface MemoryDisplayFile {
  path: string
  name: string
  label: string
  kind: 'memory' | 'view'
  bytes: number
  mtimeMs: number
  hash: string
  record?: {
    id: string
    scope: string
    kind: MemoryKind
    status: MemoryStatus
    privacy: MemoryPrivacy
    quarantined: boolean
  }
}

/** Flat file index; the browser derives expandable directories from paths. */
export interface MemoryDisplayTree {
  generation: string
  files: MemoryDisplayFile[]
  truncated: boolean
}

/** Parsed Markdown document safe to render in the browser. */
export interface MemoryDisplayDocument {
  path: string
  title: string
  markdown: string
  redacted: boolean
  hash: string
  mtimeMs: number
  meta: {
    id?: string
    revision?: number
    scope?: string
    kind?: MemoryKind
    status?: MemoryStatus
    tags?: string[]
  }
}

/** Build a bounded browser-facing file index from catalog records and views. */
export function listDisplayFiles(root: string, catalog: MemoryCatalog, limit: number, maxViewBytes: number, now: Date = new Date()): MemoryDisplayTree {
  const boundedLimit = Math.max(1, Math.floor(limit))
  // readableEntries applies the tombstone memory-id barrier: a lingering
  // forgotten body (deferred deletion) never appears in the browser.
  const records = catalog.readableEntries()
    .filter((entry) => isDisplayRecordPath(entry.relPath))
    .sort((left, right) => left.relPath.localeCompare(right.relPath))
  const viewResult = collectViewFiles(root, catalog, boundedLimit + 1, maxViewBytes, now)
  const views = viewResult.files
  const files: MemoryDisplayFile[] = []
  for (const entry of records) {
    if (files.length >= boundedLimit) break
    files.push(displayRecord(entry))
  }
  for (const view of views) {
    if (files.length >= boundedLimit) break
    files.push(view)
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  const generation = createHash('sha256')
    .update(files.map(file => `${file.path}\0${file.hash}`).join('\n'))
    .digest('hex')
  return {
    generation: `sha256:${generation}`,
    files,
    truncated: viewResult.truncated || records.length + views.length > boundedLimit,
  }
}

/** Read one file only when it belongs to the current bounded display index. */
export function readDisplayFile(
  root: string,
  catalog: MemoryCatalog,
  request: { path: string; generation: string },
  limits: { maxFiles: number; maxBytes: number },
): MemoryDisplayDocument {
  const path = normalizeDisplayPath(request.path)
  const tree = listDisplayFiles(root, catalog, limits.maxFiles, limits.maxBytes)
  if (request.generation !== tree.generation) {
    throw new StoreError('OHMYMEMO_TREE_STALE', 'memory file index changed; refresh before reading')
  }
  const indexed = tree.files.find(file => file.path === path)
  if (indexed === undefined) {
    throw new StoreError('OHMYMEMO_FILE_NOT_VISIBLE', `file "${path}" is not in the memory display index`)
  }
  const abs = containedFile(root, path)
  const stat = statSync(abs)
  if (stat.size > limits.maxBytes) {
    throw new StoreError('OHMYMEMO_FILE_TOO_LARGE', `file "${path}" exceeds the display byte limit`, {
      bytes: stat.size,
      maxBytes: limits.maxBytes,
    })
  }
  const text = readFileSync(abs, 'utf8')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > limits.maxBytes) {
    throw new StoreError('OHMYMEMO_FILE_TOO_LARGE', `file "${path}" exceeds the display byte limit`, {
      bytes,
      maxBytes: limits.maxBytes,
    })
  }
  const hash = hashText(text)
  if (hash !== indexed.hash) {
    throw new StoreError('OHMYMEMO_TREE_STALE', 'memory file changed; refresh the index before reading')
  }

  if (indexed.kind === 'view') {
    return {
      path,
      title: indexed.label,
      markdown: stripGeneratedViewHeader(text),
      redacted: false,
      hash,
      mtimeMs: stat.mtimeMs,
      meta: {},
    }
  }

  const parsed = parseRecord(text)
  if (parsed.record === undefined) {
    throw new StoreError('OHMYMEMO_RECORD_INVALID', `file "${path}" is no longer a valid memory record`)
  }
  const record = parsed.record
  const redacted = record.privacy === 'sensitive'
  return {
    path,
    title: record.key,
    markdown: redacted ? '' : record.body,
    redacted,
    hash,
    mtimeMs: stat.mtimeMs,
    meta: {
      id: record.id,
      revision: record.revision,
      scope: record.scope,
      kind: record.kind,
      status: record.status,
      tags: [...record.tags],
    },
  }
}

/** Remove only OhMyMemo's own generated-view metadata comment. */
export function stripGeneratedViewHeader(text: string): string {
  if (!text.startsWith('<!--\ngenerated: true\n')) return text
  const end = text.indexOf('\n-->\n')
  if (end === -1) return text
  const body = text.slice(end + '\n-->\n'.length)
  return body.startsWith('\n') ? body.slice(1) : body
}

function displayRecord(entry: CatalogEntry): MemoryDisplayFile {
  const file = basename(entry.relPath)
  return {
    path: entry.relPath,
    name: file,
    label: entry.record.key,
    kind: 'memory',
    bytes: entry.bytes,
    mtimeMs: entry.mtimeMs,
    hash: entry.hash,
    record: {
      id: entry.record.id,
      scope: entry.record.scope,
      kind: entry.record.kind,
      status: entry.record.status,
      privacy: entry.record.privacy,
      quarantined: entry.quarantine !== undefined,
    },
  }
}

interface GeneratedViewSpec {
  path: string
  name: string
  label: string
  view: string
  scope: string
  entries: CatalogEntry[]
}

function collectViewFiles(
  root: string,
  catalog: MemoryCatalog,
  limit: number,
  maxBytes: number,
  now: Date,
): { files: MemoryDisplayFile[]; truncated: boolean } {
  const core = catalog.allEntries().filter((entry) => isCoreViewEntry(entry, now))
  const specs: GeneratedViewSpec[] = [{
    path: 'views/user-profile.md',
    name: 'user-profile.md',
    label: 'user-profile',
    view: 'User profile',
    scope: 'user',
    entries: core.filter(entry => entry.record.scope === 'user'),
  }]
  for (const scopeEntry of [...catalog.scopes().values()].sort((left, right) => left.wsId.localeCompare(right.wsId))) {
    const scope = `workspace:${scopeEntry.wsId}`
    specs.push({
      path: `views/workspaces/${scopeEntry.wsId}.md`,
      name: `${scopeEntry.wsId}.md`,
      label: scopeEntry.wsId,
      view: `Workspace ${scopeEntry.wsId}`,
      scope,
      entries: core.filter(entry => entry.record.scope === scope),
    })
  }

  const files: MemoryDisplayFile[] = []
  for (const spec of specs.slice(0, Math.max(0, limit))) {
    const abs = join(root, ...spec.path.split('/'))
    let stat
    let text: string
    try {
      stat = lstatSync(abs)
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) continue
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (Buffer.byteLength(text, 'utf8') > maxBytes || !isCurrentGeneratedView(text, spec)) continue
    files.push({
      path: spec.path,
      name: spec.name,
      label: spec.label,
      kind: 'view',
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: hashText(text),
    })
  }
  return { files, truncated: specs.length > limit }
}

function isCurrentGeneratedView(text: string, spec: GeneratedViewSpec): boolean {
  const match = /^<!--\n([\s\S]*?)\n-->\n/u.exec(text)
  if (match?.[1] === undefined) return false
  try {
    const metadata = parseYaml(match[1]) as unknown
    if (!isPlainObject(metadata) || metadata.generated !== true || typeof metadata.generated_at !== 'string') return false
    return composeView(spec.view, spec.scope, spec.entries, metadata.generated_at) === text
  } catch {
    return false
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDisplayRecordPath(path: string): boolean {
  return path.startsWith('scopes/')
    || path.startsWith('inbox/candidates/')
    || path.startsWith('archive/')
}

function normalizeDisplayPath(input: string): string {
  if (input.length === 0 || input.includes('\\') || input.includes('\0') || posix.isAbsolute(input)) {
    throw new StoreError('OHMYMEMO_BAD_REQUEST', 'memory file path must be a non-empty relative POSIX path')
  }
  const normalized = posix.normalize(input)
  if (normalized === '..' || normalized.startsWith('../') || normalized !== input) {
    throw new StoreError('OHMYMEMO_BAD_REQUEST', 'memory file path must be normalized and stay inside the store')
  }
  return normalized
}

function containedFile(root: string, path: string): string {
  const realRoot = realpathSync(root)
  const candidate = join(root, ...path.split('/'))
  let resolved: string
  try {
    resolved = realpathSync(candidate)
  } catch {
    throw new StoreError('OHMYMEMO_FILE_NOT_VISIBLE', `file "${path}" does not exist`)
  }
  const rel = relative(realRoot, resolved)
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '' || rel.startsWith(sep)) {
    throw new StoreError('OHMYMEMO_FILE_NOT_VISIBLE', `file "${path}" resolves outside the memory store`)
  }
  const stat = lstatSync(resolved)
  if (!stat.isFile()) throw new StoreError('OHMYMEMO_FILE_NOT_VISIBLE', `file "${path}" is not a regular file`)
  return resolved
}
