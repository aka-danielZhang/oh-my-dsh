import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  activityCells,
  applyRecord,
  breakdownOf,
  dailySeries,
  dateKeyOf,
  dayIndexOf,
  dateKeyOfIndex,
  levelOf,
  longestSessionMs,
  parseRecordLine,
  serializeRecordLine,
  streaksOf,
  summarize,
  usageRecordFromEvent,
  type DayAggregates,
  type SessionEventView,
} from '../src/fold.ts'
import type { UsageRecord } from '../src/types.ts'

const UTC = 0

function messageEvent(overrides: {
  seq?: number
  time?: number
  id?: string
  provider?: string
  model?: string
  usage?: Record<string, number> | null
  interrupted?: boolean
  turn?: number
  step?: number
}): SessionEventView {
  return {
    type: 'assistant/message',
    seq: overrides.seq ?? 1,
    time: overrides.time ?? Date.now(),
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      message: {
        id: overrides.id ?? 'msg-1',
        source: { provider: overrides.provider ?? 'deepseek', model: overrides.model ?? 'deepseek-chat' },
      },
      usage: overrides.usage === null ? null : (overrides.usage ?? { inputTokens: 100, outputTokens: 50 }),
    },
  }
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    v: 1,
    t: overrides.t ?? 0,
    sid: overrides.sid ?? 's1',
    mid: overrides.mid ?? 'm1',
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    in: overrides.in ?? 100,
    out: overrides.out ?? 50,
    ...overrides.cr !== undefined ? { cr: overrides.cr } : {},
    ...overrides.cw !== undefined ? { cw: overrides.cw } : {},
    ...overrides.rt !== undefined ? { rt: overrides.rt } : {},
    ...overrides.sd !== undefined ? { sd: overrides.sd } : {},
  }
}

test('usageRecordFromEvent narrows assistant/message with billed usage', () => {
  const rec = usageRecordFromEvent('s1', messageEvent({
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 8 },
  }))
  assert.deepEqual(rec, {
    v: 1, t: rec?.t, sid: 's1', mid: 'msg-1',
    provider: 'deepseek', model: 'deepseek-chat',
    in: 100, out: 50, cr: 10, cw: 5, rt: 8,
  })
})

test('usageRecordFromEvent skips non-assistant events', () => {
  const event: SessionEventView = { type: 'user/message', seq: 1, time: 1, data: {} }
  assert.equal(usageRecordFromEvent('s1', event), undefined)
})

test('usageRecordFromEvent skips missing and all-zero usage', () => {
  assert.equal(usageRecordFromEvent('s1', messageEvent({ usage: null })), undefined)
  assert.equal(usageRecordFromEvent('s1', messageEvent({ usage: {} })), undefined)
  assert.equal(usageRecordFromEvent('s1', messageEvent({ usage: { inputTokens: 0, outputTokens: 0 } })), undefined)
})

test('usageRecordFromEvent skips unidentifiable messages', () => {
  assert.equal(usageRecordFromEvent('s1', messageEvent({ id: '' })), undefined)
  assert.equal(usageRecordFromEvent('s1', messageEvent({ provider: '' })), undefined)
  assert.equal(usageRecordFromEvent('s1', messageEvent({ model: '' })), undefined)
})

test('dateKeyOf and dayIndexOf round-trip in fixed timezone', () => {
  // 2026-09-09T23:30Z is 2026-09-10 at UTC+1, 2026-09-09 at UTC-1.
  const t = Date.parse('2026-09-09T23:30:00.000Z')
  assert.equal(dateKeyOf(t, 60), '2026-09-10')
  assert.equal(dateKeyOf(t, -60), '2026-09-09')
  assert.equal(dateKeyOfIndex(dayIndexOf('2026-09-09')), '2026-09-09')
})

test('applyRecord aggregates totals, peaks, provider/model sums, session spans', () => {
  const days: DayAggregates = {}
  applyRecord(days, record({ t: 1_000, mid: 'm1', in: 100, out: 50 }), '2026-09-09')
  applyRecord(days, record({ t: 2_000, mid: 'm2', sid: 's1', in: 30, out: 20 }), '2026-09-09')
  applyRecord(days, record({ t: 3_000, mid: 'm3', sid: 's2', provider: 'zai', model: 'glm-4.7', in: 10, out: 5 }), '2026-09-10')
  const day9 = days['2026-09-09']!
  assert.equal(day9.total, 200)
  assert.equal(day9.peak, 150)
  assert.equal(day9.calls, 2)
  assert.equal(day9.byProvider['deepseek'], 200)
  assert.equal(day9.byModel['deepseek/deepseek-chat'].tokens, 200)
  assert.deepEqual(day9.sessions['s1'], { first: 1_000, last: 2_000 })
  assert.equal(days['2026-09-10']!.byProvider['zai'], 15)
})

test('parseRecordLine and serializeRecordLine round-trip; junk lines are skipped', () => {
  const rec = record({ t: 5, sid: 'sx', mid: 'mx', cr: 3, rt: 7 })
  assert.deepEqual(parseRecordLine(serializeRecordLine(rec).trimEnd()), rec)
  assert.equal(parseRecordLine(''), undefined)
  assert.equal(parseRecordLine('{oops'), undefined)
  assert.equal(parseRecordLine('{"v":2,"t":1}'), undefined)
  assert.equal(parseRecordLine('null'), undefined)
})

test('streaksOf: gaps break runs, a quiet today keeps the streak alive', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const today = '2026-09-09'
  const mk = (base: string, delta: number): string => dateKeyOfIndex(dayIndexOf(base) + delta)
  // Active Mon..Wed this week, today (Wed) included.
  assert.deepEqual(streaksOf([mk(today, -2), mk(today, -1), today], now, UTC), { current: 3, longest: 3 })
  // Yesterday's run survives a quiet today; older gap reset current.
  assert.deepEqual(streaksOf([mk(today, -1), mk(today, -2)], now, UTC), { current: 2, longest: 2 })
  assert.deepEqual(streaksOf([mk(today, -2), mk(today, -3), mk(today, -10)], now, UTC), { current: 0, longest: 2 })
  // Longest beats current when an older run was longer.
  assert.deepEqual(
    streaksOf([mk(today, -1), mk(today, -5), mk(today, -6), mk(today, -7)], now, UTC),
    { current: 1, longest: 3 },
  )
  assert.deepEqual(streaksOf([], now, UTC), { current: 0, longest: 0 })
})

test('longestSessionMs merges cross-day spans per session', () => {
  const days: DayAggregates = {}
  applyRecord(days, record({ t: 1_000, sid: 'a' }), '2026-09-08')
  applyRecord(days, record({ t: 50_000, sid: 'a' }), '2026-09-09')
  applyRecord(days, record({ t: 10_000, sid: 'b' }), '2026-09-09')
  applyRecord(days, record({ t: 11_000, sid: 'b' }), '2026-09-09')
  assert.equal(longestSessionMs(days), 49_000)
})

test('summarize folds the five cards', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const days: DayAggregates = {}
  const day = (delta: number): string => dateKeyOfIndex(dayIndexOf('2026-09-09') + delta)
  applyRecord(days, record({ t: Date.parse('2026-09-08T10:00:00.000Z'), sid: 'a', mid: 'm1', in: 100, out: 50 }), day(-1))
  applyRecord(days, record({ t: Date.parse('2026-09-08T10:05:00.000Z'), sid: 'a', mid: 'm2', in: 400, out: 100 }), day(-1))
  applyRecord(days, record({ t: Date.parse('2026-09-09T11:00:00.000Z'), sid: 'a', mid: 'm3', in: 10, out: 5 }), day(0))
  const summary = summarize(days, now, UTC)
  assert.equal(summary.totalTokens, 665)
  assert.equal(summary.peakTokens, 500)
  assert.equal(summary.longestChatMs, Date.parse('2026-09-09T11:00:00.000Z') - Date.parse('2026-09-08T10:00:00.000Z'))
  assert.equal(summary.currentStreakDays, 2)
  assert.equal(summary.longestStreakDays, 2)
  assert.equal(summary.activeDays, 2)
  assert.equal(summary.firstDate, day(-1))
  assert.equal(summary.lastDate, day(0))
})

test('dailySeries zero-fills missing days and sorts model detail', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const days: DayAggregates = {}
  applyRecord(days, record({ t: 1, mid: 'm1', model: 'b-model', in: 10, out: 0 }), '2026-09-09')
  applyRecord(days, record({ t: 2, mid: 'm2', model: 'a-model', in: 30, out: 0 }), '2026-09-09')
  const series = dailySeries(days, now, UTC, { days: 3 })
  assert.equal(series.days.length, 3)
  assert.deepEqual(series.days.map(entry => entry.date), ['2026-09-07', '2026-09-08', '2026-09-09'])
  assert.equal(series.days[0]!.total, 0)
  assert.deepEqual(series.days[2]!.byModel, [
    { model: 'deepseek/a-model', tokens: 30 },
    { model: 'deepseek/b-model', tokens: 10 },
  ])
})

test('levelOf maps to 0..4 buckets', () => {
  assert.equal(levelOf(0, 400), 0)
  assert.equal(levelOf(1, 400), 1)
  assert.equal(levelOf(100, 400), 1)
  assert.equal(levelOf(101, 400), 2)
  assert.equal(levelOf(400, 400), 4)
  assert.equal(levelOf(400, 0), 1)
})

test('activityCells daily covers 52 Monday-aligned weeks ending this week', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z') // Wednesday
  const days: DayAggregates = {}
  applyRecord(days, record({ t: now }), '2026-09-09')
  const activity = activityCells(days, 'daily', now, UTC)
  assert.equal(activity.cells.length, 52 * 7)
  assert.equal(activity.cells.at(-1)!.date, '2026-09-13') // this week's Sunday
  // The window starts and ends on week boundaries: (index + 3) % 7 === 0 is a Monday.
  assert.equal((dayIndexOf(activity.cells[0]!.date) + 3) % 7, 0)
  assert.equal(activity.maxTotal, 150)
  assert.equal(activity.cells.find(cell => cell.date === '2026-09-09')!.level, 4)
  assert.equal(activity.cells.find(cell => cell.date === '2026-09-08')!.level, 0)
})

test('activityCells weekly aggregates per Monday-starting week', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z') // Wednesday of week starting 2026-09-07
  const days: DayAggregates = {}
  applyRecord(days, record({ t: 1, mid: 'm1', in: 10, out: 0 }), '2026-09-07')
  applyRecord(days, record({ t: 2, mid: 'm2', in: 20, out: 0 }), '2026-09-08')
  applyRecord(days, record({ t: 3, mid: 'm3', in: 40, out: 0 }), '2026-08-31') // previous week
  const activity = activityCells(days, 'weekly', now, UTC)
  assert.equal(activity.cells.length, 52)
  assert.equal(activity.cells.find(cell => cell.date === '2026-09-07')!.total, 30)
  assert.equal(activity.cells.find(cell => cell.date === '2026-08-31')!.total, 40)
  assert.equal(activity.cells.find(cell => cell.date === '2026-09-07')!.level, 3)
  assert.equal(activity.cells.find(cell => cell.date === '2026-08-31')!.level, 4)
})

test('activityCells cumulative fills running totals', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const days: DayAggregates = {}
  applyRecord(days, record({ t: 1, mid: 'm1', in: 10, out: 0 }), '2026-09-08')
  applyRecord(days, record({ t: 2, mid: 'm2', in: 20, out: 0 }), '2026-09-09')
  const activity = activityCells(days, 'cumulative', now, UTC)
  const last = activity.cells.at(-1)!
  assert.equal(last.total, 30)
  assert.equal(last.level, 4)
  assert.equal(activity.cells.find(cell => cell.date === '2026-09-07')!.total, 0)
})

test('breakdownOf groups and shares with provider display-name fallback', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const days: DayAggregates = {}
  applyRecord(days, record({ t: 1, mid: 'm1', in: 75, out: 0 }), '2026-09-09')
  applyRecord(days, record({ t: 2, mid: 'm2', provider: 'zai', model: 'glm-4.7', in: 25, out: 0 }), '2026-09-09')
  applyRecord(days, record({ t: 3, mid: 'm3', in: 999, out: 0 }), '2026-08-01') // outside range
  const labels = new Map([['deepseek', 'DeepSeek Official']])
  const byProvider = breakdownOf(days, 'provider', now, UTC, { days: 7 }, labels)
  assert.equal(byProvider.total, 100)
  assert.deepEqual(byProvider.slices, [
    { key: 'deepseek', label: 'DeepSeek Official', tokens: 75, share: 0.75 },
    { key: 'zai', label: 'zai', tokens: 25, share: 0.25 },
  ])
  const byModel = breakdownOf(days, 'model', now, UTC, { days: 7 }, new Map())
  assert.deepEqual(byModel.slices.map(slice => slice.label), ['deepseek-chat', 'glm-4.7'])
})

test('rangeDateKeysOf supports explicit from/to windows', async () => {
  const { rangeDateKeysOf } = await import('../src/fold.ts')
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const keys = rangeDateKeysOf(now, UTC, { from: '2026-09-01', to: '2026-09-03' })
  assert.deepEqual(keys, ['2026-09-01', '2026-09-02', '2026-09-03'])
  // Invalid or inverted spans fall back to the trailing 7 days.
  assert.equal(rangeDateKeysOf(now, UTC, { from: '2026-09-03', to: '2026-09-01' }).length, 7)
})

test('SessionUsageFolder pairs step/start with messages into record.sd', async () => {
  const { SessionUsageFolder } = await import('../src/fold.ts')
  const folder = new SessionUsageFolder()
  const stepStart: SessionEventView = { type: 'step/start', seq: 1, time: 1_000, data: { turn: 1, step: 1 } }
  const message = messageEvent({ seq: 2, time: 4_000, id: 'm9' })
  assert.equal(folder.fold('s1', stepStart), undefined)
  const rec = folder.fold('s1', message)
  assert.ok(rec !== undefined)
  assert.equal(rec.sd, 1_000)
  // A message whose step never started carries no sd (different turn/step).
  const orphan = folder.fold('s1', messageEvent({ seq: 3, time: 9_000, id: 'm10', turn: 9, step: 9 }))
  assert.ok(orphan !== undefined)
  assert.equal(orphan.sd, undefined)
  // A same-step follow-up message inherits the step's start time.
  const follow = folder.fold('s1', messageEvent({ seq: 4, time: 8_000, id: 'm11' }))
  assert.ok(follow !== undefined)
  assert.equal(follow.sd, 1_000)
})

test('parseRecordLine round-trips sd and rejects out-of-order values', async () => {
  const { parseRecordLine, serializeRecordLine } = await import('../src/fold.ts')
  const withSd = record({ mid: 'mx', t: 1_000, sd: 500 })
  assert.equal(parseRecordLine(serializeRecordLine(withSd).trimEnd())?.sd, 500)
  const bad = JSON.stringify({ ...record({ mid: 'mb' }), sd: 9_999_999 })
  assert.equal(parseRecordLine(bad)?.sd, undefined)
})

test('activityCells daily cells carry per-day call counts', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const days: DayAggregates = {}
  applyRecord(days, record({ mid: 'm1' }), '2026-09-09')
  applyRecord(days, record({ mid: 'm2' }), '2026-09-09')
  const activity = activityCells(days, 'daily', now, UTC)
  assert.equal(activity.cells.find(c => c.date === '2026-09-09')?.calls, 2)
  assert.equal(activity.cells.find(c => c.date === '2026-09-08')?.calls, 0)
})

test('qualityByModel aggregates per-model hit rate and apparent rate over range', async () => {
  const { qualityByModel } = await import('../src/fold.ts')
  const now = Date.parse('2026-09-09T12:00:00.000Z')
  const days: DayAggregates = {}
  // deepseek: cr 40 / billed 100 → 40% hit; duration 10s → 5 tok/s
  applyRecord(days, record({ mid: 'q1', in: 60, out: 50, cr: 40, sd: Date.parse('2026-09-09T10:00:00.000Z'), t: Date.parse('2026-09-09T10:00:10.000Z') }), '2026-09-09')
  // zai: 无缓存 → hit 0%；duration 5s，out 100 → 20 tok/s
  applyRecord(days, record({ mid: 'q2', provider: 'zai', model: 'glm-5', in: 10, out: 100, sd: Date.parse('2026-09-09T11:00:00.000Z'), t: Date.parse('2026-09-09T11:00:05.000Z') }), '2026-09-09')
  // 范围外不计
  applyRecord(days, record({ mid: 'q3', provider: 'old', model: 'legacy', in: 999, out: 999 }), '2026-08-01')
  const q = qualityByModel(days, now, UTC, { days: 7 })
  assert.equal(q.models.length, 2)
  const deepseek = q.models.find(m => m.model === 'deepseek/deepseek-chat')!
  assert.equal(deepseek.hitRate, 0.4)
  assert.equal(deepseek.speedTokensPerSec, 5)
  const zai = q.models.find(m => m.model === 'zai/glm-5')!
  assert.equal(zai.hitRate, 0)
  assert.equal(zai.speedTokensPerSec, 20)
  // 自定义日期区间（范围外不进）
  const scoped = qualityByModel(days, now, UTC, { from: '2026-08-01', to: '2026-08-02' })
  assert.equal(scoped.models.length, 1)
  assert.equal(scoped.models[0]!.model, 'old/legacy')
})
