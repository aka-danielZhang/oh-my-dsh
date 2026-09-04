/**
 * Metadata-only audit journal: one JSON line per action, appended to
 * `journal/YYYY/MM.jsonl`. The journal never carries record bodies — it is an
 * audit trail over the canonical Markdown, deliberately not an event source
 * (true forgetting must be possible).
 * @module dsh-ohmymemo/journal
 */

import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { ensureDir, FILE_MODE } from './atomic.ts'
import { journalPath } from './paths.ts'
import { dirname, join } from 'node:path'

/** Actions the journal records. */
export type JournalAction =
  | 'created'
  | 'candidate-created'
  | 'config-updated'
  | 'updated'
  | 'superseded'
  | 'promoted'
  | 'forgotten'
  | 'candidate-rejected'
  | 'candidate-expired'
  | 'scope-created'
  | 'external-edit-detected'
  | 'external-removal'
  | 'transaction-recovered'
  | 'transaction-aborted'

/** One journal line. Field set is metadata-only by construction. */
export interface JournalEntry {
  at: string
  action: JournalAction
  txn_id?: string
  id?: string
  revision?: number
  scope?: string
  key?: string
  content_hash?: string
  old_hash?: string
  new_hash?: string
  path?: string
  source?: { session_id?: string; event_seq?: number }
  reason?: string
}

/**
 * Append one entry to the current month's journal file. Synchronous and
 * small; failures propagate (the caller decides whether a journaled
 * mutation may proceed — the store treats journal failure as fatal to the
 * mutation, keeping canonical and journal consistent).
 */
export function appendJournal(root: string, entry: JournalEntry): void {
  const rel = journalPath(entry.at)
  if (rel === undefined) {
    throw new Error(`journal: entry has no usable timestamp: ${JSON.stringify(entry.at)}`)
  }
  const abs = join(root, ...rel.split('/'))
  ensureDir(dirname(abs))
  appendFileSync(abs, `${JSON.stringify(entry)}\n`, { mode: FILE_MODE })
}

/** Read all journal lines for inspection (tests/doctor). Invalid lines are skipped. */
export function readJournal(root: string): JournalEntry[] {
  // Doctor/tests consume small stores; a full replay helper is intentionally
  // not part of the contract (the journal does not promise replay).
  const entries: JournalEntry[] = []
  const yearsDir = join(root, 'journal')
  if (!existsSync(yearsDir)) return entries
  for (const year of readdirSync(yearsDir, { withFileTypes: true })) {
    if (!year.isDirectory()) continue
    for (const file of readdirSync(join(yearsDir, year.name), { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.jsonl')) continue
      const abs = join(yearsDir, year.name, file.name)
      if (!statSync(abs).isFile()) continue
      for (const line of readFileSync(abs, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          entries.push(JSON.parse(line) as JournalEntry)
        } catch {
          // Skip damaged lines; the journal is advisory audit, not canonical.
        }
      }
    }
  }
  return entries
}
