import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UsageStatsStore } from '../src/store.ts'
import { validateConfig } from '../src/config.ts'
import type { UsageRecord } from '../src/types.ts'

const UTC = 0

function fixture(): { dir: string } {
  return { dir: mkdtempSync(join(tmpdir(), 'usage-stats-')) }
}

function rec(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    v: 1,
    t: overrides.t ?? Date.parse('2026-09-09T12:00:00.000Z'),
    sid: overrides.sid ?? 's1',
    mid: overrides.mid ?? 'm1',
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    in: overrides.in ?? 100,
    out: overrides.out ?? 50,
  }
}

async function openStore(dir: string): Promise<UsageStatsStore> {
  const store = new UsageStatsStore(validateConfig(undefined), dir, UTC)
  await store.open()
  return store
}

test('record persists a JSONL line and rebuilds identically after reopen', async () => {
  const { dir } = fixture()
  const store = await openStore(dir)
  assert.equal(store.record(rec({ mid: 'm1', in: 100, out: 50 })), true)
  assert.equal(store.record(rec({ mid: 'm1', in: 100, out: 50 })), false) // dedup in-process
  store.flush()

  const reopened = await openStore(dir)
  assert.equal(reopened.seenCount, 1)
  const line = readFileSync(join(dir, 'records', '2026-09-09.jsonl'), 'utf8')
  assert.match(line, /"mid":"m1"/)
  const summary = reopened.aggregates['2026-09-09']!
  assert.equal(summary.total, 150)
  assert.equal(reopened.record(rec({ mid: 'm1' })), false) // dedup survives reopen
  reopened.dispose()
})

test('state.json persists watermarks and backfilled set', async () => {
  const { dir } = fixture()
  const store = await openStore(dir)
  store.setSessionWatermark('s1', 7)
  store.markBackfilled('s1')
  store.markBackfilled('s2')
  store.flush()
  const reopened = await openStore(dir)
  assert.equal(reopened.sessionWatermark('s1'), 7)
  assert.equal(reopened.isBackfilled('s1'), true)
  assert.equal(reopened.isBackfilled('s2'), true)
  assert.equal(reopened.isBackfilled('s3'), false)
  reopened.dispose()
})

test('rescan folds lines another process appended, skipping partial trailing lines', async () => {
  const { dir } = fixture()
  const mine = await openStore(dir)
  mine.record(rec({ mid: 'm1' }))
  mine.flush()

  // Another process writes two complete lines and one partial line.
  const other = await openStore(dir)
  other.record(rec({ mid: 'm2' }))
  other.record(rec({ mid: 'm3', sid: 's2' }))
  other.dispose() // flush is implicit; but append already durable
  const file = join(dir, 'records', '2026-09-09.jsonl')
  const m4 = JSON.stringify(rec({ mid: 'm4', sid: 's3', in: 1, out: 1 }))
  writeFileSync(file, readFileSync(file, 'utf8') + m4.slice(0, 20), 'utf8')

  await mine.rescan()
  assert.equal(mine.seenCount, 3)
  assert.equal(mine.aggregates['2026-09-09']!.total, 450)
  // Completing the line folds it on the next rescan.
  writeFileSync(file, readFileSync(file, 'utf8') + m4.slice(20) + '\n', 'utf8')
  await mine.rescan()
  assert.equal(mine.seenCount, 4)
  assert.equal(mine.aggregates['2026-09-09']!.total, 452)
  mine.dispose()
})

test('rescan folds a brand-new day file another process created', async () => {
  const { dir } = fixture()
  const mine = await openStore(dir)
  mine.record(rec({ mid: 'm1', t: Date.parse('2026-09-09T10:00:00.000Z') }))
  mine.flush()
  const other = await openStore(dir)
  other.record(rec({ mid: 'm2', t: Date.parse('2026-09-10T10:00:00.000Z'), in: 10, out: 5 }))
  other.dispose()
  await mine.rescan()
  assert.equal(mine.seenCount, 2)
  assert.equal(mine.aggregates['2026-09-10']!.total, 15)
  mine.dispose()
})

test('retention drops day files older than retentionDays at open', async () => {
  const { dir } = fixture()
  mkdirSync(join(dir, 'records'), { recursive: true })
  writeFileSync(join(dir, 'records', '2020-01-01.jsonl'), `${JSON.stringify(rec({ mid: 'old' }))}\n`, 'utf8')
  writeFileSync(join(dir, 'records', '2099-01-01.jsonl'), `${JSON.stringify(rec({ mid: 'future' }))}\n`, 'utf8')
  const store = new UsageStatsStore({ ...validateConfig(undefined), retentionDays: 400 }, dir, UTC)
  await store.open()
  assert.equal(existsSync(join(dir, 'records', '2020-01-01.jsonl')), false)
  assert.equal(existsSync(join(dir, 'records', '2099-01-01.jsonl')), true)
  assert.equal(store.seenCount, 1) // only the retained file folded
  store.dispose()
})

test('corrupt state.json falls back to empty bookkeeping', async () => {
  const { dir } = fixture()
  writeFileSync(join(dir, 'state.json'), '{not json', 'utf8')
  const store = await openStore(dir)
  assert.equal(store.sessionWatermark('s1'), 0)
  assert.equal(store.isBackfilled('s1'), false)
  store.dispose()
})

test('flush publishes aggregates.json atomically', async () => {
  const { dir } = fixture()
  const store = await openStore(dir)
  store.record(rec({ mid: 'm1' }))
  store.flush()
  const published = JSON.parse(readFileSync(join(dir, 'aggregates.json'), 'utf8'))
  assert.equal(published.v, 1)
  assert.equal(published.days['2026-09-09'].total, 150)
  assert.equal(readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0)
  store.dispose()
})
