import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  OTHER_KEY,
  breakdownCut,
  cutNamed,
  gutterOf,
  isDailyEmpty,
  modelTotalsOf,
  niceCeil,
  normalizedShares,
  seriesLabel,
  stackedPoints,
} from '../src/client/chart-data.ts'
import type { UsageStatsBreakdown, UsageStatsDailyEntry } from '../src/types.ts'

function day(date: string, byModel: Array<[string, number]>): UsageStatsDailyEntry {
  let total = 0
  for (const [, tokens] of byModel) total += tokens
  return { date, total, byModel: byModel.map(([model, tokens]) => ({ model, tokens })) }
}

test('cutNamed: sorts by volume, keeps top 5, aggregates the tail once', () => {
  const entries = [
    { key: 'p/m1', tokens: 10 },
    { key: 'p/m2', tokens: 50 },
    { key: 'p/m3', tokens: 30 },
    { key: 'p/m4', tokens: 5 },
    { key: 'p/m5', tokens: 20 },
    { key: 'p/m6', tokens: 8 },
    { key: 'p/m7', tokens: 2 },
  ]
  const cut = cutNamed(entries, 5)
  assert.deepEqual(cut.named.map(e => e.key), ['p/m2', 'p/m3', 'p/m5', 'p/m1', 'p/m6'])
  assert.equal(cut.other?.key, OTHER_KEY)
  assert.equal(cut.other?.tokens, 5 + 2)
  assert.equal(cut.total, 125)
  assert.equal(cut.all.length, 6)
  // No tail → no other bucket.
  const small = cutNamed(entries.slice(0, 3), 5)
  assert.equal(small.other, null)
  assert.equal(small.all.length, 3)
})

test('cutNamed: stable tiebreak on keys', () => {
  const cut = cutNamed([
    { key: 'b/x', tokens: 10 },
    { key: 'a/x', tokens: 10 },
  ], 5)
  assert.deepEqual(cut.named.map(e => e.key), ['a/x', 'b/x'])
})

test('seriesLabel strips the provider prefix', () => {
  assert.equal(seriesLabel('deepseek/deepseek-chat'), 'deepseek-chat')
  assert.equal(seriesLabel('bare'), 'bare')
})

test('modelTotalsOf folds per-day model rows into range totals', () => {
  const totals = modelTotalsOf([
    day('2026-09-01', [['p/a', 10], ['p/b', 5]]),
    day('2026-09-02', [['p/a', 7]]),
  ])
  const map = new Map(totals.map(e => [e.key, e.tokens]))
  assert.equal(map.get('p/a'), 17)
  assert.equal(map.get('p/b'), 5)
})

test('stackedPoints: bar total equals the day total across all series', () => {
  const days = [
    day('2026-09-01', [['p/a', 10], ['p/b', 5], ['p/z', 1]]),
    day('2026-09-02', []),
    day('2026-09-03', [['p/c', 3]]),
  ]
  const cut = cutNamed(modelTotalsOf(days), 2)
  const points = stackedPoints(days, cut)
  assert.equal(points.length, 3)
  for (const point of points) {
    assert.equal(point.values.reduce((a, b) => a + b, 0), point.total,
      `day ${point.date} stack sum must equal its total`)
  }
  // Zero days keep their calendar slot.
  assert.equal(points[1]!.date, '2026-09-02')
  assert.deepEqual(points[1]!.values, cut.all.map(() => 0))
  // Tail models fold into the other slot on their days (top-2 are p/a, p/b).
  const otherIndex = cut.all.findIndex(e => e.key === OTHER_KEY)
  assert.notEqual(otherIndex, -1)
  assert.equal(points[0]!.values[otherIndex], 1) // only p/z is tail on day 1
  assert.equal(points[0]!.values[1], 5) // p/b rides its named slot
  assert.equal(points[2]!.values[otherIndex], 3) // p/c entirely in other
})

test('stackedPoints: empty input stays empty — never dereferences []', () => {
  const cut = cutNamed([], 5)
  assert.deepEqual(stackedPoints([], cut), [])
  assert.equal(cut.other, null)
  assert.equal(cut.total, 0)
  assert.ok(isDailyEmpty([]))
  assert.ok(!isDailyEmpty([day('2026-09-01', [])]))
})

test('niceCeil: 1/2/5 mantissas, zero-safe', () => {
  assert.equal(niceCeil(0), 1)
  assert.equal(niceCeil(-3), 1)
  assert.equal(niceCeil(0.7), 1)
  assert.equal(niceCeil(1), 1)
  assert.equal(niceCeil(1.2), 2)
  assert.equal(niceCeil(3), 5)
  assert.equal(niceCeil(6), 10)
  assert.equal(niceCeil(70), 100)
  assert.equal(niceCeil(1_234_567), 2_000_000)
})

test('gutterOf: grows with the widest tick, clamped to [min, max]', () => {
  assert.equal(gutterOf(['1']), 24) // min clamp
  assert.equal(gutterOf(['1', '1000万']), Math.ceil(5 * 6.4 + 10))
  assert.equal(gutterOf(['1234567890123']), 72) // max clamp
  const narrow = gutterOf(['1000万'], { charWidth: 6.4, pad: 10, min: 46, max: 64 })
  assert.equal(narrow, 46)
})

test('normalizedShares: parts always sum to exactly 1, zero-total safe', () => {
  const shares = normalizedShares([10, 7, 5, 3, 2, 1])
  const sum = shares.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-12, `sum ${sum} must be 1`)
  assert.deepEqual(normalizedShares([0, 0, 0]), [0, 0, 0])
  assert.deepEqual(normalizedShares([5]), [1])
})

test('breakdownCut: donut series sums to 100% with top-5 + other', () => {
  const breakdown: UsageStatsBreakdown = {
    dim: 'model',
    total: 100,
    slices: [
      { key: 'p/m1', label: 'm1', tokens: 40, share: 0.4 },
      { key: 'p/m2', label: 'm2', tokens: 26, share: 0.26 },
      { key: 'p/m3', label: 'm3', tokens: 14, share: 0.14 },
      { key: 'p/m4', label: 'm4', tokens: 8, share: 0.08 },
      { key: 'p/m5', label: 'm5', tokens: 6, share: 0.06 },
      { key: 'p/m6', label: 'm6', tokens: 4, share: 0.04 },
      { key: 'p/m7', label: 'm7', tokens: 2, share: 0.02 },
    ],
  }
  const cut = breakdownCut(breakdown, 5)
  assert.equal(cut.all.length, 6)
  assert.equal(cut.other?.tokens, 6)
  const percent = cut.shares.reduce((a, s) => a + Math.round(s * 1000) / 10, 0)
  assert.equal(percent, 100)
  // ≤5 models: everything named, no other bucket, still 100%.
  const small = breakdownCut({ dim: 'model', total: 3, slices: breakdown.slices.slice(0, 3) }, 5)
  assert.equal(small.other, null)
  assert.equal(small.shares.reduce((a, s) => a + Math.round(s * 1000) / 10, 0), 100)
})
