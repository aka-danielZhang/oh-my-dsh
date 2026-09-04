import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { hashText, writeFileAtomic } from '../src/atomic.ts'
import { readJournal } from '../src/journal.ts'
import { serializeRecord, serializeTombstone } from '../src/schema.ts'
import { recoverTransactions, readTxnMarkers, runTransaction, writeTxnMarker, type TransactionMarker } from '../src/txn.ts'
import { baseRecord } from './helpers/records.ts'
import { scratchRoot } from './helpers/scratch.ts'

const SUCCESSOR = `mem_${'01J5G0'}${'Z0'.repeat(9)}Z1`

function absOf(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

test('runTransaction executes write + journal ops and removes its marker', () => {
  const root = scratchRoot()
  const record = baseRecord()
  const text = serializeRecord(record)
  const rel = `scopes/user/semantic/${record.id}.md`
  runTransaction(root, {
    action: 'create',
    ops: [
      { op: 'write', path: rel, content: text, after_hash: hashText(text) },
      { op: 'journal', entry: { at: '2026-09-03T10:00:00.000Z', action: 'created', id: record.id, revision: 1, content_hash: hashText(text) } },
    ],
  })
  assert.equal(readFileSync(absOf(root, rel), 'utf8'), text)
  assert.deepEqual(readJournal(root).map((entry) => entry.action), ['created'])
  assert.deepEqual(readTxnMarkers(root).markers, [])
})

test('recovery finishes an interrupted forget: tombstone stays, body deleted, journal appended', () => {
  const root = scratchRoot()
  const record = baseRecord({ key: 'preference.validation-drink' })
  const bodyRel = `scopes/user/semantic/${record.id}.md`
  const bodyText = serializeRecord(record)
  writeFileAtomic(absOf(root, bodyRel), bodyText)

  // Crash point: tombstone written (op1 done), body still present (op2 not done).
  const tombstone = {
    schema: 'ohmymemo-tombstone/v1' as const,
    id: 'tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    scope: 'user',
    key: record.key,
    memory_ids: [record.id],
    forgotten_at: '2026-09-03T10:00:00.000Z',
    reason: 'user-request',
  }
  const tombRel = `tombstones/${tombstone.id}.yaml`
  const tombText = serializeTombstone(tombstone)
  writeFileAtomic(absOf(root, tombRel), tombText)
  const marker: TransactionMarker = {
    schema: 'ohmymemo-transaction/v1',
    id: 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    action: 'forget',
    phase: 'canonical-written',
    targets: [{ path: tombRel, after_hash: hashText(tombText) }, { path: bodyRel, before_hash: hashText(bodyText) }],
    ops: [
      { op: 'write', path: tombRel, after_hash: hashText(tombText) },
      { op: 'delete', path: bodyRel, hash: hashText(bodyText) },
      { op: 'journal', entry: { at: '2026-09-03T10:00:00.000Z', action: 'forgotten', scope: 'user', key: record.key } },
    ],
    created_at: '2026-09-03T09:59:59.000Z',
  }
  writeTxnMarker(root, marker)

  const report = recoverTransactions(root)
  assert.deepEqual(report.recovered, [marker.id])
  assert.equal(existsSync(absOf(root, tombRel)), true, 'tombstone survives')
  assert.equal(existsSync(absOf(root, bodyRel)), false, 'body deleted on resume')
  const actions = readJournal(root).map((entry) => entry.action)
  assert.ok(actions.includes('forgotten'))
  assert.ok(actions.includes('transaction-recovered'))
  assert.deepEqual(readTxnMarkers(root).markers, [])
})

test('recovery aborts a transaction that never reached disk', () => {
  const root = scratchRoot()
  const marker: TransactionMarker = {
    schema: 'ohmymemo-transaction/v1',
    id: 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    action: 'create',
    phase: 'prepared',
    targets: [{ path: 'scopes/user/semantic/mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.md', after_hash: hashText('never written') }],
    ops: [{ op: 'write', path: 'scopes/user/semantic/mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.md', after_hash: hashText('never written') }],
    created_at: '2026-09-03T10:00:00.000Z',
  }
  writeTxnMarker(root, marker)
  const report = recoverTransactions(root)
  assert.deepEqual(report.aborted, [marker.id])
  assert.equal(existsSync(absOf(root, 'scopes/user/semantic/mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.md')), false)
  assert.ok(readJournal(root).some((entry) => entry.action === 'transaction-aborted'))
  assert.deepEqual(readTxnMarkers(root).markers, [])
})

test('recovery aborts a prepared overwrite while its before hash is still present', () => {
  const root = scratchRoot()
  const path = 'config.yaml'
  const before = 'schema: ohmymemo-config/v1\nallow_inference_candidates: false\n'
  const after = 'schema: ohmymemo-config/v1\nallow_inference_candidates: true\n'
  writeFileAtomic(absOf(root, path), before)
  const marker: TransactionMarker = {
    schema: 'ohmymemo-transaction/v1',
    id: 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    action: 'config-update',
    phase: 'prepared',
    targets: [{ path, before_hash: hashText(before), after_hash: hashText(after) }],
    ops: [{ op: 'write', path, before_hash: hashText(before), after_hash: hashText(after) }],
    created_at: '2026-09-03T10:00:00.000Z',
  }
  writeTxnMarker(root, marker)
  const report = recoverTransactions(root)
  assert.deepEqual(report.aborted, [marker.id])
  assert.equal(readFileSync(absOf(root, path), 'utf8'), before)
  assert.deepEqual(readTxnMarkers(root).markers, [])
})

test('live overwrite refuses a stale before hash without changing the target', () => {
  const root = scratchRoot()
  const path = 'config.yaml'
  const before = 'before\n'
  const after = 'after\n'
  writeFileAtomic(absOf(root, path), before)
  assert.throws(() => runTransaction(root, {
    action: 'config-update',
    ops: [{ op: 'write', path, content: after, before_hash: hashText('different\n'), after_hash: hashText(after) }],
  }), /precondition failed/u)
  assert.equal(readFileSync(absOf(root, path), 'utf8'), before)
  assert.deepEqual(readTxnMarkers(root), { markers: [], damaged: [] })
})

test('recovery quarantines traversal markers without touching files outside the Store', (t) => {
  const root = scratchRoot()
  const victimName = `${basename(root)}-transaction-victim.txt`
  const outside = join(root, '..', victimName)
  t.after(() => { rmSync(outside, { force: true }) })
  writeFileAtomic(outside, 'keep me\n')
  const id = 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'
  const markerPath = absOf(root, `.state/transactions/${id}.yaml`)
  const malicious = {
    schema: 'ohmymemo-transaction/v1',
    id,
    action: 'forget',
    phase: 'canonical-written',
    targets: [{ path: `../${victimName}`, before_hash: hashText('keep me\n') }],
    ops: [{ op: 'delete', path: `../${victimName}`, hash: hashText('keep me\n') }],
    created_at: '2026-09-03T10:00:00.000Z',
  }
  writeFileAtomic(markerPath, JSON.stringify(malicious))

  const report = recoverTransactions(root)
  assert.equal(report.conflicts.length, 1)
  assert.match(report.conflicts[0]!.message, /unreadable transaction marker/u)
  assert.equal(readFileSync(outside, 'utf8'), 'keep me\n')
  assert.equal(existsSync(markerPath), true)
})

test('recovery finalizes a transaction whose work is already complete', () => {
  const root = scratchRoot()
  const record = baseRecord()
  const text = serializeRecord(record)
  const rel = `scopes/user/semantic/${record.id}.md`
  runTransaction(root, {
    action: 'create',
    ops: [
      { op: 'write', path: rel, content: text, after_hash: hashText(text) },
      { op: 'journal', entry: { at: '2026-09-03T10:00:00.000Z', action: 'created', id: record.id, content_hash: hashText(text) } },
    ],
  })
  // A crash after the last op but before marker deletion replants the marker.
  const marker: TransactionMarker = {
    schema: 'ohmymemo-transaction/v1',
    id: 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    action: 'create',
    phase: 'journaled',
    targets: [{ path: rel, after_hash: hashText(text) }],
    ops: [
      { op: 'write', path: rel, after_hash: hashText(text) },
      { op: 'journal', entry: { at: '2026-09-03T10:00:00.000Z', action: 'created', id: record.id, content_hash: hashText(text) } },
    ],
    created_at: '2026-09-03T10:00:01.000Z',
  }
  writeTxnMarker(root, marker)
  const report = recoverTransactions(root)
  assert.deepEqual(report.finalized, [marker.id])
  // Journal dedupe by exact line: the created entry is NOT re-appended.
  const created = readJournal(root).filter((entry) => entry.action === 'created')
  assert.equal(created.length, 1)
})

test('recovery refuses to guess when disk state contradicts the marker', () => {
  const root = scratchRoot()
  writeFileAtomic(absOf(root, 'scopes/user/semantic/mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.md'), 'foreign content\n')
  const marker: TransactionMarker = {
    schema: 'ohmymemo-transaction/v1',
    id: 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    action: 'create',
    phase: 'prepared',
    targets: [{ path: 'scopes/user/semantic/mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.md', after_hash: hashText('expected') }],
    ops: [{ op: 'write', path: 'scopes/user/semantic/mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.md', after_hash: hashText('expected') }],
    created_at: '2026-09-03T10:00:00.000Z',
  }
  writeTxnMarker(root, marker)
  const report = recoverTransactions(root)
  assert.equal(report.conflicts.length, 1)
  assert.match(report.conflicts[0]!.message, /disagrees with disk hashes/)
  assert.equal(readTxnMarkers(root).markers.length, 1, 'conflicting marker stays for doctor')
})

test('write-derived ops re-derive deterministic content from disk (supersede resume)', () => {
  const root = scratchRoot()
  const record = baseRecord()
  const oldRel = `scopes/user/semantic/${record.id}.md`
  const oldText = serializeRecord(record)
  writeFileAtomic(absOf(root, oldRel), oldText)

  // Crash point: new successor written (op1 done), archive move pending.
  const at = '2026-09-03T11:00:00.000Z'
  const successor = baseRecord({
    id: SUCCESSOR,
    created_at: at,
    updated_at: at,
    supersedes: [record.id],
    body: '新的偏好内容。',
  })
  const newText = serializeRecord(successor)
  const newRel = `scopes/user/semantic/${successor.id}.md`
  writeFileAtomic(absOf(root, newRel), newText)
  const derivedText = serializeRecord({ ...record, status: 'superseded', updated_at: at })
  const archiveRel = `archive/user/semantic/${record.id}.md`

  const marker: TransactionMarker = {
    schema: 'ohmymemo-transaction/v1',
    id: 'txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    action: 'supersede',
    phase: 'canonical-written',
    targets: [{ path: newRel, after_hash: hashText(newText) }, { path: archiveRel, before_hash: hashText(oldText), after_hash: hashText(derivedText) }, { path: oldRel, before_hash: hashText(oldText) }],
    ops: [
      { op: 'write', path: newRel, after_hash: hashText(newText) },
      { op: 'write-derived', from: oldRel, to: archiveRel, before_hash: hashText(oldText), after_hash: hashText(derivedText), derive: { status: 'superseded', updated_at: at } },
      { op: 'delete', path: oldRel, hash: hashText(oldText) },
      { op: 'journal', entry: { at, action: 'superseded', id: successor.id, content_hash: hashText(newText) } },
    ],
    created_at: at,
  }
  writeTxnMarker(root, marker)
  const report = recoverTransactions(root)
  assert.deepEqual(report.recovered, [marker.id])
  assert.equal(existsSync(absOf(root, oldRel)), false)
  assert.equal(readFileSync(absOf(root, archiveRel), 'utf8'), derivedText)
  assert.equal(readFileSync(absOf(root, newRel), 'utf8'), newText)
})
