/**
 * Store tests: record/lookup round trips, restart survival (the point of the
 * plugin), collision-free hashed filenames, header identity verification,
 * fork isolation, physical-line compaction, corruption tolerance, and the
 * fail-soft write switch.
 * @module dsh-fs-observation-log/tests/store
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { validateConfig } from '../src/config.ts'
import { ObservationStore, parseSidecarLine, serializeSidecarLine, sidecarFileId } from '../src/store.ts'
import { sessionLineage } from '../src/heal.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function freshStore(overrides: Record<string, unknown> = {}): { store: ObservationStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fs-obs-log-'))
  dirs.push(dir)
  return { store: new ObservationStore(validateConfig(overrides), dir), dir }
}

test('file ids hash the full opaque id — separator twins can never collide', () => {
  assert.equal(sidecarFileId('s1'), sidecarFileId('s1'))
  assert.notEqual(sidecarFileId('a/b'), sidecarFileId('a_b'))
  assert.notEqual(sidecarFileId('x'.repeat(300)), sidecarFileId('x'.repeat(301)))
  assert.match(sidecarFileId('anything/../weird'), /^[0-9a-f]{64}$/)
})

test('parse tolerates malformed lines and skips unknown versions', () => {
  assert.equal(parseSidecarLine(''), undefined)
  assert.equal(parseSidecarLine('not json'), undefined)
  assert.equal(parseSidecarLine('42'), undefined)
  assert.equal(parseSidecarLine('{"v":2,"targetKey":"k","version":"1"}'), undefined)
  assert.equal(parseSidecarLine('{"v":1,"targetKey":"","version":"1"}'), undefined)
  assert.deepEqual(parseSidecarLine('{"hdr":1,"id":"s1","parent":"s0"}'), { hdr: 1, id: 's1', parent: 's0' })
  const record = parseSidecarLine('{"v":1,"targetKey":"k","version":"v1","at":5}')
  assert.deepEqual(record, { v: 1, targetKey: 'k', displayPath: 'k', version: 'v1', at: 5 })
})

test('record then lookup finds the evidence, including across a store restart', () => {
  const { store, dir } = freshStore()
  store.record('s1', '/tmp/x.ts', 'x.ts', 'v1', 's0')
  assert.deepEqual(store.lookup(['s1'], '/tmp/x.ts'), { version: 'v1', sessionId: 's1' })
  // New process, same dir: the sidecar is the only state.
  const revived = new ObservationStore(validateConfig({}), dir)
  assert.deepEqual(revived.lookup(['s1'], '/tmp/x.ts'), { version: 'v1', sessionId: 's1' })
})

test('a session never heals from another session\'s sidecar', () => {
  const { store } = freshStore()
  store.record('parent', '/tmp/a.ts', 'a.ts', 'vp')
  // The policy hands lookup a single-entry lineage (the acting session); the
  // child therefore misses even though the parent's sidecar holds the target.
  assert.equal(store.lookup(sessionLineage({ id: 'child', parentSession: 'parent' }), '/tmp/a.ts'), undefined)
  // The parent itself still heals from its own sidecar.
  assert.deepEqual(store.lookup(sessionLineage({ id: 'parent' }), '/tmp/a.ts'), { version: 'vp', sessionId: 'parent' })
})

test('re-recording the same version does not append a duplicate line', () => {
  const { store, dir } = freshStore()
  store.record('s1', '/tmp/x.ts', 'x.ts', 'v1')
  store.record('s1', '/tmp/x.ts', 'x.ts', 'v1')
  const text = readFileSync(join(dir, `${sidecarFileId('s1')}.jsonl`), 'utf8')
  assert.equal(text.split('\n').filter((line) => line.length > 0).length, 2) // header + one record
})

test('compaction keeps the header and the newest half on overflow', () => {
  const { store, dir } = freshStore({ maxEntriesPerSession: 4 })
  store.record('s1', '/f0', 'f0', 'v0', 's0')
  store.record('s1', '/f1', 'f1', 'v1')
  store.record('s1', '/f2', 'f2', 'v2')
  store.record('s1', '/f3', 'f3', 'v3')
  store.record('s1', '/f4', 'f4', 'v4') // overflow: rewrite keeping newest 2
  const revived = new ObservationStore(validateConfig({ maxEntriesPerSession: 4 }), dir)
  assert.equal(revived.lookup(['s1'], '/f4') !== undefined, true)
  assert.equal(revived.lookup(['s1'], '/f3') !== undefined, true)
  assert.equal(revived.lookup(['s1'], '/f0'), undefined)
  const text = readFileSync(join(dir, `${sidecarFileId('s1')}.jsonl`), 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 3) // header + two records
  assert.equal(lines[0].includes('"hdr"'), true)
})

test('physical growth from repeated re-observations of one target compacts too', () => {
  const { store, dir } = freshStore({ maxEntriesPerSession: 4 })
  // Distinct keys stay at 1; every version change appends another physical
  // line. The OLD Map-size trigger never compacted here (20 appends would
  // grow the file to 21 lines); the physical trigger bounds it at cap
  // records + header.
  for (let i = 0; i < 20; i += 1) store.record('s1', '/tmp/x.ts', 'x.ts', `v${i}`)
  const text = readFileSync(join(dir, `${sidecarFileId('s1')}.jsonl`), 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  assert.ok(lines.length <= 5, `expected bounded file, got ${lines.length} lines`)
  assert.deepEqual(new ObservationStore(validateConfig({}), dir).lookup(['s1'], '/tmp/x.ts'), {
    version: 'v19',
    sessionId: 's1',
  })
})

test('a sidecar whose header names another session is treated as absent', () => {
  const { store, dir } = freshStore()
  const foreign = join(dir, `${sidecarFileId('s1')}.jsonl`)
  writeFileSync(foreign, serializeSidecarLine({ hdr: 1, id: 'someone-else' }), 'utf8')
  assert.equal(store.lookup(['s1'], '/tmp/x.ts'), undefined)
  // Recording rewrites the file with the correct header instead of appending
  // into the foreign one, and the record is then served.
  store.record('s1', '/tmp/x.ts', 'x.ts', 'v1')
  const text = readFileSync(foreign, 'utf8')
  const lines = text.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]), { hdr: 1, id: 's1' })
  assert.deepEqual(store.lookup(['s1'], '/tmp/x.ts'), { version: 'v1', sessionId: 's1' })
})

test('a corrupt sidecar loads its healthy lines only', () => {
  const { store, dir } = freshStore()
  store.record('s1', '/tmp/good.ts', 'good.ts', 'v1')
  const file = join(dir, `${sidecarFileId('s1')}.jsonl`)
  writeFileSync(file, '{corrupt!\n' + readFileSync(file, 'utf8'), 'utf8')
  const revived = new ObservationStore(validateConfig({}), dir)
  assert.deepEqual(revived.lookup(['s1'], '/tmp/good.ts'), { version: 'v1', sessionId: 's1' })
})

test('write failures disable the store fail-soft while the mirror keeps serving', () => {
  // A directory planted where the sidecar file should be makes every write throw.
  const dir = mkdtempSync(join(tmpdir(), 'fs-obs-log-'))
  dirs.push(dir)
  mkdirSync(join(dir, `${sidecarFileId('s1')}.jsonl`))
  const store = new ObservationStore(validateConfig({ maxWriteFailures: 2 }), dir)
  store.record('s1', '/tmp/x.ts', 'x.ts', 'v1')
  assert.equal(store.writeDisabled, false)
  store.record('s1', '/tmp/y.ts', 'y.ts', 'v1')
  assert.equal(store.writeDisabled, true)
  // Mirror still answers this process.
  assert.deepEqual(store.lookup(['s1'], '/tmp/x.ts'), { version: 'v1', sessionId: 's1' })
})

test('serialize/parse round trips records and headers', () => {
  const record = { v: 1 as const, targetKey: '/k', displayPath: 'k', version: 'v9', at: 123 }
  assert.deepEqual(parseSidecarLine(serializeSidecarLine(record).trimEnd()), record)
  const header = { hdr: 1 as const, id: 's1' }
  assert.deepEqual(parseSidecarLine(serializeSidecarLine(header).trimEnd()), header)
})
