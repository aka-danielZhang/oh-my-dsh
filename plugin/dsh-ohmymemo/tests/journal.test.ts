import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { appendJournal, readJournal, type JournalEntry } from '../src/journal.ts'
import { scratchRoot } from './helpers/scratch.ts'

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    at: '2026-09-03T10:00:00.000Z',
    action: 'created',
    id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    revision: 1,
    scope: 'user',
    key: 'preference.communication.language',
    content_hash: 'sha256:abc',
    ...overrides,
  }
}

test('appendJournal writes one JSON line into journal/YYYY/MM.jsonl at 0600', () => {
  const root = scratchRoot()
  appendJournal(root, entry())
  const file = join(root, 'journal', '2026', '09.jsonl')
  const text = readFileSync(file, 'utf8')
  assert.equal(text, `${JSON.stringify(entry())}\n`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('journal entries never carry bodies — the type has no content field to abuse', () => {
  const root = scratchRoot()
  const e = entry()
  appendJournal(root, e)
  const line = readFileSync(join(root, 'journal', '2026', '09.jsonl'), 'utf8')
  assert.ok(!line.includes('用户更喜欢'))
  const round = readJournal(root)
  assert.deepEqual(round, [e])
})

test('appendJournal rejects entries without a usable timestamp', () => {
  const root = scratchRoot()
  assert.throws(() => appendJournal(root, entry({ at: 'not-a-time' })))
})

test('entries land in separate files across month boundaries', () => {
  const root = scratchRoot()
  appendJournal(root, entry({ at: '2026-08-31T23:59:59.000Z', action: 'updated' }))
  appendJournal(root, entry({ at: '2026-09-01T00:00:01.000Z', action: 'created' }))
  const actions = readJournal(root).map((item) => item.action)
  assert.deepEqual(actions, ['updated', 'created'])
})
