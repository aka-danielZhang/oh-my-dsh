/**
 * Deterministic bounded views: `views/user-profile.md` and
 * `views/workspaces/<ws>.md`. Generated from canonical Markdown only, fully
 * rebuildable, never a second source of truth — hand edits are overwritten on
 * the next rebuild and never propagate back.
 *
 * Header carries `generated: true`, generation time, source memory ids and a
 * content digest. Eligibility mirrors the capsule: active, normal, pinned.
 * Sensitive content and candidates/superseded never appear.
 * @module dsh-ohmymemo/views
 */

import { hashText, writeFileAtomic } from './atomic.ts'
import type { MemoryCatalog } from './catalog.ts'
import type { CatalogEntry, MemoryRecord, StoreUserConfig } from './types.ts'
import { join } from 'node:path'

/**
 * Entry eligibility shared by views and the capsule. `now` gates the business
 * validity window: a record whose `valid_until` has passed (or `valid_from`
 * not yet reached) leaves capsule/views immediately, before the nightly
 * maintenance archives it. Recency decay, by contrast, is capsule ranking
 * only — views (human-facing) stay complete.
 */
export function isCoreViewEntry(entry: CatalogEntry, now: Date): boolean {
  return entry.quarantine === undefined
    && entry.record.status === 'active'
    && entry.record.privacy === 'normal'
    && entry.record.pinned
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

/** Compose the Markdown text of one view (pure). */
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

/** Rebuild every view from the catalog; returns the written relative paths. */
export function rebuildViews(root: string, catalog: Pick<MemoryCatalog, 'allEntries' | 'scopes'>, config: StoreUserConfig, generatedAt: string): string[] {
  void config
  const written: string[] = []
  // Views show core entries only: active + normal + pinned, unquarantined,
  // inside their validity window at generation time.
  const now = new Date(generatedAt)
  const all = catalog.allEntries().filter((entry) => isCoreViewEntry(entry, now))
  const userEntries = all.filter((entry) => entry.record.scope === 'user')
  publishView(root, 'views/user-profile.md', composeView('User profile', 'user', userEntries, generatedAt))
  written.push('views/user-profile.md')
  for (const scopeEntry of catalog.scopes().values()) {
    const scopeValue = `workspace:${scopeEntry.wsId}`
    const scoped = all.filter((entry) => entry.record.scope === scopeValue)
    const rel = `views/workspaces/${scopeEntry.wsId}.md`
    publishView(root, rel, composeView(`Workspace ${scopeEntry.wsId}`, scopeValue, scoped, generatedAt))
    written.push(rel)
  }
  return written
}

function firstLine(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= 160 ? flat : `${flat.slice(0, 159)}…`
}
