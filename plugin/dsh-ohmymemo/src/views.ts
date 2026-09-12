/**
 * Deterministic bounded views. Two families live here:
 *
 * - Human-facing pinned views (`views/user-profile.md`,
 *   `views/workspaces/<ws>.md`) — `isCoreViewEntry`, importance order. The
 *   browser memory tree recomposes and verifies these byte-for-byte.
 * - Agent-facing full indexes (`views/index-user.md`,
 *   `views/index-workspace-<ws>.md`) — `isIndexEntry`, decayWeight order,
 *   not pinned-required. These are the index-first interaction's read path:
 *   the capsule points at them, the model `read`s a row's file for the body.
 *
 * Generated from canonical Markdown only, fully rebuildable, never a second
 * source of truth — hand edits are overwritten on the next rebuild and never
 * propagate back. Header carries `generated: true`, generation time, source
 * memory ids and a content digest. Sensitive content and
 * candidates/superseded never appear in either family.
 * @module dsh-ohmymemo/views
 */

import { hashText, writeFileAtomic } from './atomic.ts'
import { decayWeight, type DecayHorizons } from './decay.ts'
import type { MemoryCatalog } from './catalog.ts'
import type { CatalogEntry, MemoryRecord, StoreUserConfig } from './types.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Entry eligibility shared by the human views and the capsule. `now` gates
 * the business validity window: a record whose `valid_until` has passed (or
 * `valid_from` not yet reached) leaves capsule/views immediately, before the
 * nightly maintenance archives it. Recency decay, by contrast, is capsule
 * ranking only — views (human-facing) stay complete.
 */
export function isCoreViewEntry(entry: CatalogEntry, now: Date): boolean {
  return entry.quarantine === undefined
    && entry.record.status === 'active'
    && entry.record.privacy === 'normal'
    && entry.record.pinned
    && withinValidityWindow(entry.record, now)
}

/**
 * Agent-facing index eligibility: like {@link isCoreViewEntry} but WITHOUT
 * the pinned requirement — the index exists so unpinned episodic/workspace
 * memories are discoverable via `read`/`grep`. Zero-decay-weight entries
 * still qualify (they sink to the bottom of the ordering); only the row cap
 * eventually drops them, counted in the footer note.
 */
export function isIndexEntry(entry: CatalogEntry, now: Date): boolean {
  return entry.quarantine === undefined
    && entry.record.status === 'active'
    && entry.record.privacy === 'normal'
    && withinValidityWindow(entry.record, now)
}

/** False when the record's business validity window excludes it at `now`. */
export function withinValidityWindow(record: Pick<MemoryRecord, 'valid_from' | 'valid_until'>, now: Date): boolean {
  if (record.valid_from !== undefined && record.valid_from !== null && Date.parse(record.valid_from) > now.getTime()) return false
  if (record.valid_until !== undefined && record.valid_until !== null && Date.parse(record.valid_until) <= now.getTime()) return false
  return true
}

/** Deterministic ordering: importance desc, then created_at asc, then id. */
export function orderCoreEntries(entries: CatalogEntry[]): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    if (b.record.importance !== a.record.importance) return b.record.importance - a.record.importance
    if (a.record.created_at !== b.record.created_at) return a.record.created_at < b.record.created_at ? -1 : 1
    return a.record.id < b.record.id ? -1 : 1
  })
}

/** Deterministic index ordering: decayWeight desc, then created_at asc, then id. */
export function orderIndexEntries(entries: CatalogEntry[], now: Date, horizons: DecayHorizons): CatalogEntry[] {
  return [...entries].sort((a, b) => {
    const weightA = decayWeight(a.record, now, horizons)
    const weightB = decayWeight(b.record, now, horizons)
    if (weightB !== weightA) return weightB - weightA
    if (a.record.created_at !== b.record.created_at) return a.record.created_at < b.record.created_at ? -1 : 1
    return a.record.id < b.record.id ? -1 : 1
  })
}

/** One index row's options (shared by the view files and the capsule bullets). */
export interface IndexLineOptions {
  /** Flattened-summary width in characters (ellipsis counts against it). */
  summaryChars: number
  /** Append ` → store-relative file path` (view rows yes; capsule bullets no). */
  withPath?: boolean
  /** Include ` · importance X` in the parenthetical (view rows yes). */
  withImportance?: boolean
}

/**
 * The one-line index row shared by view files and capsule bullets:
 *
 * ```text
 * [mem_x] (kind · key · importance 0.9) 第一行摘要 ≤N 字 → scopes/user/mem_x.md
 * ```
 */
export function composeIndexLine(entry: CatalogEntry, options: IndexLineOptions): string {
  const record = entry.record
  const flat = record.body.replace(/\s+/g, ' ').trim()
  const width = Math.max(20, options.summaryChars)
  const summary = flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
  const importance = options.withImportance ? ` · importance ${record.importance}` : ''
  const core = `[${record.id}] (${record.kind} · ${record.key}${importance}) ${summary}`
  return options.withPath ? `${core} → ${entry.relPath}` : core
}

/** Compose the Markdown text of one human view (pure). */
export function composeView(viewName: string, scopeLabel: string, entries: CatalogEntry[], generatedAt: string): string {
  const ordered = orderCoreEntries(entries)
  const ids = ordered.map((entry) => entry.record.id)
  const digest = viewDigest(ordered)
  const lines: string[] = [
    '<!--',
    'generated: true',
    `view: ${viewName}`,
    `scope: ${scopeLabel}`,
    `generated_at: ${generatedAt}`,
    `memory_ids: [${ids.join(', ')}]`,
    `digest: ${digest}`,
    '-->',
    '',
    `# ${viewName}`,
    '',
  ]
  if (ordered.length === 0) {
    lines.push('(no pinned active memories in this scope yet)', '')
    return lines.join('\n')
  }
  for (const entry of ordered) {
    const record = entry.record
    lines.push(`- [${record.id}] (${record.kind} · ${record.key}${record.confirmed ? ' · confirmed' : ''}) ${firstLine(record.body)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Options for {@link composeScopeIndex}. */
export interface ScopeIndexOptions {
  summaryChars: number
  maxEntries: number
  horizons: DecayHorizons
  now: Date
}

/**
 * Compose one agent-facing full index file (pure). Rows carry the
 * store-relative path so the model can `read` the body directly; the row cap
 * truncates deterministically with a counting footer.
 */
export function composeScopeIndex(viewName: string, scopeLabel: string, entries: CatalogEntry[], generatedAt: string, options: ScopeIndexOptions): string {
  const ordered = orderIndexEntries(entries.filter((entry) => isIndexEntry(entry, options.now)), options.now, options.horizons)
  const capped = ordered.slice(0, Math.max(1, options.maxEntries))
  const omitted = ordered.length - capped.length
  const ids = ordered.map((entry) => entry.record.id)
  const digest = indexDigest(ordered, options)
  const lines: string[] = [
    '<!--',
    'generated: true',
    `view: ${viewName}`,
    `scope: ${scopeLabel}`,
    `index: agent-facing`,
    `generated_at: ${generatedAt}`,
    `memory_ids: [${ids.join(', ')}]`,
    `digest: ${digest}`,
    '-->',
    '',
    `# ${viewName}`,
    '',
  ]
  if (capped.length === 0) {
    lines.push('(no active memories in this scope yet)', '')
    return lines.join('\n')
  }
  for (const entry of capped) {
    lines.push(`- ${composeIndexLine(entry, { summaryChars: options.summaryChars, withPath: true, withImportance: true })}`)
  }
  if (omitted > 0) {
    lines.push(`- …（另有 ${omitted} 条未列出；完整内容请直接浏览 scopes/ 目录）`)
  }
  lines.push('')
  return lines.join('\n')
}

/** Digest over the ordered id+revision+hash list plus the shaping options. */
export function indexDigest(entries: CatalogEntry[], options: ScopeIndexOptions): string {
  const ordered = orderIndexEntries(entries, options.now, options.horizons)
  const material = [
    ...ordered.map((entry) => `${entry.record.id}@${entry.record.revision}:${entry.hash}`),
    `summary:${options.summaryChars}`,
    `max:${options.maxEntries}`,
  ].join('\n')
  return hashText(material).slice('sha256:'.length, 'sha256:'.length + 16)
}

/** Digest over the ordered id+revision+hash list — view freshness marker. */
export function viewDigest(entries: CatalogEntry[]): string {
  const ordered = orderCoreEntries(entries)
  const material = ordered.map((entry) => `${entry.record.id}@${entry.record.revision}:${entry.hash}`).join('\n')
  return hashText(material).slice('sha256:'.length, 'sha256:'.length + 16)
}

/** Write (or remove) one view file; deletable at any time. */
export function publishView(root: string, relPath: string, text: string): void {
  writeFileAtomic(join(root, ...relPath.split('/')), text)
}

/**
 * The only nondeterministic line of a view header — masked when comparing
 * an on-disk view against a freshly composed candidate.
 */
const GENERATED_AT_LINE = /^generated_at: .*$/m
const GENERATED_AT_MASK = 'generated_at: <stamp>'

/** True when two view texts differ only in their generation stamp. */
function sameViewText(previous: string, next: string): boolean {
  return previous.replace(GENERATED_AT_LINE, GENERATED_AT_MASK) === next.replace(GENERATED_AT_LINE, GENERATED_AT_MASK)
}

/**
 * Write one view file unless the on-disk text already matches the candidate
 * modulo the generation stamp. Store events that do not touch view data —
 * notably `config-updated` — used to rewrite every file anyway, bumping
 * `generated_at`, the file hash and therefore the browser tree generation,
 * stranding every open page on a stale index. Skipping no-op writes keeps
 * the stamp (and the hash) stable; a real change — including validity
 * windows closing at the new generation time — still differs outside the
 * stamp line and rewrites as before. Hand edits never match and are
 * overwritten, unchanged behavior.
 */
function publishViewIfChanged(root: string, relPath: string, text: string): void {
  const abs = join(root, ...relPath.split('/'))
  let previous: string | undefined
  try {
    previous = readFileSync(abs, 'utf8')
  } catch {
    previous = undefined
  }
  if (previous !== undefined && sameViewText(previous, text)) return
  writeFileAtomic(abs, text)
}

/**
 * Rebuild every view from the catalog; returns the ensured relative paths
 * (files whose content already matched keep their previous bytes). The
 * agent-facing index files ride the same no-op skip as the human views.
 */
export function rebuildViews(root: string, catalog: Pick<MemoryCatalog, 'allEntries' | 'scopes'>, config: StoreUserConfig, generatedAt: string): string[] {
  const written: string[] = []
  const now = new Date(generatedAt)
  const horizons: DecayHorizons = {
    semantic: config.decay_horizon_days_semantic,
    procedural: config.decay_horizon_days_procedural,
    episodic: config.decay_horizon_days_episodic,
  }
  const indexOptions: ScopeIndexOptions = {
    summaryChars: config.index_entry_summary_chars,
    maxEntries: config.index_max_entries,
    horizons,
    now,
  }
  // Human views show core entries only: active + normal + pinned,
  // unquarantined, inside their validity window at generation time.
  const all = catalog.allEntries().filter((entry) => isCoreViewEntry(entry, now))
  const userEntries = all.filter((entry) => entry.record.scope === 'user')
  publishViewIfChanged(root, 'views/user-profile.md', composeView('User profile', 'user', userEntries, generatedAt))
  written.push('views/user-profile.md')
  for (const scopeEntry of catalog.scopes().values()) {
    const scopeValue = `workspace:${scopeEntry.wsId}`
    const scoped = all.filter((entry) => entry.record.scope === scopeValue)
    const rel = `views/workspaces/${scopeEntry.wsId}.md`
    publishViewIfChanged(root, rel, composeView(`Workspace ${scopeEntry.wsId}`, scopeValue, scoped, generatedAt))
    written.push(rel)
  }
  // Agent-facing full indexes: every active+normal entry, pinned or not,
  // decayWeight-ordered. The capsule points the model at these two files.
  const indexAll = catalog.allEntries().filter((entry) => isIndexEntry(entry, now))
  publishViewIfChanged(root, 'views/index-user.md', composeScopeIndex('Memory index (user)', 'user', indexAll.filter((entry) => entry.record.scope === 'user'), generatedAt, indexOptions))
  written.push('views/index-user.md')
  for (const scopeEntry of catalog.scopes().values()) {
    const scopeValue = `workspace:${scopeEntry.wsId}`
    const scoped = indexAll.filter((entry) => entry.record.scope === scopeValue)
    const rel = `views/index-workspace-${scopeEntry.wsId}.md`
    publishViewIfChanged(root, rel, composeScopeIndex(`Memory index (workspace ${scopeEntry.wsId})`, scopeValue, scoped, generatedAt, indexOptions))
    written.push(rel)
  }
  return written
}

function firstLine(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`
}
