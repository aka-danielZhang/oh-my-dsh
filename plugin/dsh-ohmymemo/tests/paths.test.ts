import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  archiveRecordPath,
  candidateRecordPath,
  canonicalRecordPath,
  defaultStoreRoot,
  isWatchRelevant,
  journalPath,
  parseLocation,
  tombstonePath,
  transactionPath,
  WRITER_LOCK_REL,
} from '../src/paths.ts'

const MEM = 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'
const WS = 'ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'
const TOMB = 'tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'

test('defaultStoreRoot honors $DSH_HOME then falls back to <home>/.dsh', () => {
  assert.equal(defaultStoreRoot('/tmp/scratch', '/Users/u'), '/tmp/scratch/ohmymemo')
  assert.equal(defaultStoreRoot(undefined, '/Users/u'), '/Users/u/.dsh/ohmymemo')
  assert.equal(defaultStoreRoot('', '/Users/u'), '/Users/u/.dsh/ohmymemo')
})

test('canonical paths follow scope × kind, episodic nests by created_at', () => {
  assert.equal(canonicalRecordPath({ id: MEM, scope: 'user', kind: 'semantic', created_at: '2026-09-03T10:00:00.000Z' }), `scopes/user/semantic/${MEM}.md`)
  assert.equal(canonicalRecordPath({ id: MEM, scope: 'user', kind: 'procedural', created_at: '2026-09-03T10:00:00.000Z' }), `scopes/user/procedural/${MEM}.md`)
  assert.equal(canonicalRecordPath({ id: MEM, scope: 'user', kind: 'episodic', created_at: '2026-09-03T10:00:00.000Z' }), `scopes/user/episodic/2026/09/${MEM}.md`)
  assert.equal(canonicalRecordPath({ id: MEM, scope: `workspace:${WS}`, kind: 'semantic', created_at: '2026-09-03T10:00:00.000Z' }), `scopes/workspaces/${WS}/semantic/${MEM}.md`)
})

test('candidate and archive paths', () => {
  assert.equal(candidateRecordPath(MEM), `inbox/candidates/${MEM}.md`)
  assert.equal(archiveRecordPath({ id: MEM, scope: 'user', kind: 'semantic' }), `archive/user/semantic/${MEM}.md`)
  assert.equal(archiveRecordPath({ id: MEM, scope: `workspace:${WS}`, kind: 'episodic' }), `archive/workspaces/${WS}/episodic/${MEM}.md`)
})

test('journal and tombstone and txn paths', () => {
  assert.equal(journalPath('2026-09-03T10:00:00.000Z'), 'journal/2026/09.jsonl')
  assert.equal(journalPath('junk'), undefined)
  assert.equal(tombstonePath(TOMB), `tombstones/${TOMB}.yaml`)
  assert.equal(transactionPath('txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'), '.state/transactions/txn_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.yaml')
  assert.equal(WRITER_LOCK_REL, '.state/locks/writer.lock')
})

test('parseLocation classifies every area and rejects malformed paths', () => {
  assert.deepEqual(parseLocation(`scopes/user/semantic/${MEM}.md`), { type: 'record', area: 'canonical', scope: 'user', kind: 'semantic', id: MEM })
  assert.deepEqual(parseLocation(`scopes/user/episodic/2026/09/${MEM}.md`), { type: 'record', area: 'canonical', scope: 'user', kind: 'episodic', id: MEM, year: 2026, month: 9 })
  assert.deepEqual(parseLocation(`scopes/workspaces/${WS}/procedural/${MEM}.md`), { type: 'record', area: 'canonical', scope: `workspace:${WS}`, kind: 'procedural', id: MEM })
  assert.deepEqual(parseLocation(`inbox/candidates/${MEM}.md`), { type: 'record', area: 'candidate', scope: '', kind: 'semantic', id: MEM })
  assert.deepEqual(parseLocation(`archive/user/semantic/${MEM}.md`), { type: 'record', area: 'archive', scope: 'user', kind: 'semantic', id: MEM })
  assert.deepEqual(parseLocation(`tombstones/${TOMB}.yaml`), { type: 'tombstone', id: TOMB })
  assert.deepEqual(parseLocation(`scopes/workspaces/${WS}/scope.yaml`), { type: 'scope-file', wsId: WS })
  assert.equal(parseLocation('manifest.yaml').type, 'manifest')
  assert.equal(parseLocation('config.yaml').type, 'store-config')
  assert.equal(parseLocation('journal/2026/09.jsonl').type, 'journal')
  assert.equal(parseLocation(WRITER_LOCK_REL).type, 'lock')
  assert.equal(parseLocation(`${WRITER_LOCK_REL}/info.json`).type, 'lock')
  assert.equal(parseLocation('views/user-profile.md').type, 'view')

  assert.equal(parseLocation('scopes/user/semantic/notaulid.md').type, 'unknown')
  assert.equal(parseLocation('scopes/user/bogus/x.md').type, 'unknown')
  assert.equal(parseLocation('scopes/user/episodic/2026/9/x.md').type, 'unknown')
  assert.equal(parseLocation('random/dir/file.md').type, 'unknown')
  assert.equal(parseLocation('inbox/candidates/sub/dir/x.md').type, 'unknown')
  assert.equal(parseLocation(`archive/${WS}/semantic/${MEM}.md`).type, 'unknown')
})

test('isWatchRelevant reacts to canonical records, policy, tombstones and scope files', () => {
  assert.equal(isWatchRelevant(parseLocation(`scopes/user/semantic/${MEM}.md`)), true)
  assert.equal(isWatchRelevant(parseLocation('config.yaml')), true)
  assert.equal(isWatchRelevant(parseLocation(`tombstones/${TOMB}.yaml`)), true)
  assert.equal(isWatchRelevant(parseLocation(`scopes/workspaces/${WS}/scope.yaml`)), true)
  assert.equal(isWatchRelevant(parseLocation('journal/2026/09.jsonl')), false)
  assert.equal(isWatchRelevant(parseLocation(WRITER_LOCK_REL)), false)
})
