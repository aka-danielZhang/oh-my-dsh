import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { effectivePriority, mergeAttentionChanges, mergeNotificationCandidates, selectDeliveries } from '../src/selection.ts'
import type { EffectivePriority } from '../src/types.ts'
import { backoffMs, inDayRange, localClock, nextQuietEnd, shiftDayKey, stableStringify, truncateText, zonedToEpoch } from '../src/util.ts'

const NOW = Date.parse('2026-10-23T09:00:00.000Z')

test('effective priority: a source suggestion cannot mint P0, near deadlines can', () => {
  assert.equal(effectivePriority({ priority: 'p0', deadline: null }, NOW), 'p1')
  assert.equal(effectivePriority({ priority: 'p3', deadline: NOW + 30 * 60_000 }, NOW), 'p0')
  assert.equal(effectivePriority({ priority: 'p3', deadline: NOW + 12 * 60 * 60_000 }, NOW), 'p1')
  assert.equal(effectivePriority({ priority: 'p3', deadline: null }, NOW), 'p3')
})

test('selection: priority first, oldest reserve, and a per-source cap', () => {
  const items: { priority: EffectivePriority; createdAt: number; sourceId: string; eventId: string }[] = Array.from({ length: 40 }, (_value, index) => ({
    priority: 'p3',
    createdAt: NOW + index,
    sourceId: 'source-a',
    eventId: `a${String(index)}`,
  }))
  items.push({ priority: 'p0', createdAt: NOW + 500, sourceId: 'source-b', eventId: 'b0' })
  for (let index = 1; index < 10; index += 1) {
    items.push({ priority: 'p2', createdAt: NOW + 500 + index, sourceId: 'source-b', eventId: `b${String(index)}` })
  }
  const chosen = selectDeliveries(items, 10)
  assert.equal(chosen.length, 10)
  assert.equal(chosen[0]?.eventId, 'b0', 'the urgent item leads')
  assert.equal(chosen.some(item => item.eventId === 'b1'), true, 'the second source gets a turn')
  const fromA = chosen.filter(item => item.sourceId === 'source-a').length
  assert.ok(fromA <= 6, `one source must not exceed 60% (got ${String(fromA)})`)
  assert.equal(chosen.some(item => item.eventId === 'a0'), true, 'the oldest item is reserved a slot')
})

test('attention changes for one topic collapse into one action', () => {
  const merged = mergeAttentionChanges([
    { action: 'create', topicKey: 't', title: 'T', summary: 'v1', evidence: [{ eventId: 'e1' }], material: false },
    { action: 'update', topicKey: 't', summary: 'v2', evidence: [{ eventId: 'e1' }, { eventId: 'e2' }], material: true, expectedRevision: 1 },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.action, 'create')
  assert.equal(merged[0]?.summary, 'v2')
  assert.equal(merged[0]?.material, true)
  assert.deepEqual(merged[0]?.evidence?.map(point => point.eventId), ['e1', 'e2'])
})

test('notification candidates for one topic merge their reasons and stage', () => {
  const merged = mergeNotificationCandidates([
    { topicKey: 't', reason: 'a', kind: 'update' },
    { topicKey: 't', reason: 'b', kind: 'reminder', reminderStage: 2 },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.kind, 'reminder')
  assert.equal(merged[0]?.reminderStage, 2)
  assert.match(merged[0]?.reason ?? '', /a；b/)
})

test('day ranges cross midnight and quiet ends land on the next morning', () => {
  assert.equal(inDayRange({ start: '22:00', end: '08:00' }, 23 * 60), true)
  assert.equal(inDayRange({ start: '22:00', end: '08:00' }, 7 * 60), true)
  assert.equal(inDayRange({ start: '22:00', end: '08:00' }, 12 * 60), false)
  const config = { quietHours: { start: '22:00', end: '08:00' }, timeZone: 'Asia/Shanghai' }
  const lateEvening = Date.parse('2026-10-23T15:00:00.000Z') // 23:00 Asia/Shanghai
  const end = nextQuietEnd(config, lateEvening)
  assert.equal(new Date(end).toISOString(), '2026-10-24T00:00:00.000Z')
  assert.equal(nextQuietEnd(config, NOW), NOW, 'not quiet at 17:00 local')
})

test('zone arithmetic survives a DST transition', () => {
  // 2026-03-08 is the US spring-forward day.
  const quiet = { quietHours: { start: '22:00', end: '08:00' }, timeZone: 'America/New_York' }
  const before = Date.parse('2026-03-08T03:30:00.000Z') // 22:30 EST on Mar 7
  const end = nextQuietEnd(quiet, before)
  assert.equal(new Date(end).toISOString(), '2026-03-08T12:00:00.000Z', '08:00 EDT')
  assert.equal(localClock(before, 'America/New_York').hhmm, '22:30')
  assert.equal(shiftDayKey('2026-02-28', 1), '2026-03-01')
  assert.equal(zonedToEpoch('2026-03-08', 8 * 60, 'America/New_York'), Date.parse('2026-03-08T12:00:00.000Z'))
})

test('stableStringify is order-independent and backoff is bounded', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }))
  assert.ok(backoffMs(0) < backoffMs(3))
  assert.ok(backoffMs(50) <= 30 * 60_000 * 1.2)
  assert.equal(truncateText('abcdef', 4), 'abc…')
  assert.equal(DEFAULT_QUNO_CONFIG.retention.eventBodyDays, 30)
})
