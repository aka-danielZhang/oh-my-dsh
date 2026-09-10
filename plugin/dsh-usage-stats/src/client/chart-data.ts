/**
 * Pure data transforms for the usage-stats charts: the Top-N + “other” model
 * cut shared by the stacked trend and the donut/ranking, per-day stack
 * alignment, axis ceiling, and tick-gutter estimation. No React, no DOM —
 * unit-testable from node:test. Components only draw what these produce, so
 * the trend's stacked layers, its tooltip, the donut arcs, and the ranking
 * list can never disagree about colors, order, or totals.
 *
 * @module dsh-usage-stats/client/chart-data
 */

import type { UsageStatsBreakdown, UsageStatsBreakdownSlice } from '../types.ts'

/** Key of the aggregated “other” series. */
export const OTHER_KEY = '\0other'

/** Display label source for a series key: the bare model id after `/`. */
export function seriesLabel(key: string): string {
  return key.slice(key.indexOf('/') + 1)
}

/** One aggregated series row: a named model or the “other” bucket. */
export interface SeriesEntry {
  /** `provider/model` key, or {@link OTHER_KEY}. */
  key: string
  /** Display label (bare model id; the section localizes “other”). */
  label: string
  /** Range total behind the entry. */
  tokens: number
}

/** Result of the shared Top-N cut: `named` (largest first) plus one bucket. */
export interface NamedCut {
  named: SeriesEntry[]
  /** Aggregate of everything beyond the cut; null when nothing was cut. */
  other: SeriesEntry | null
  /** Every entry in draw order (named then other) — the color index basis. */
  all: SeriesEntry[]
  /** Σ tokens over the whole input. */
  total: number
}

/**
 * Cut model entries (already the range totals) to `limit` named series and
 * aggregate the tail into one “other” bucket. Input order does not matter;
 * output is sorted by tokens descending with a stable key tiebreak, so the
 * same data always yields the same colors.
 */
export function cutNamed(
  entries: ReadonlyArray<{ key: string, tokens: number }>,
  limit = 5,
): NamedCut {
  const sorted = [...entries].sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1))
  const head = sorted.slice(0, limit)
  const tail = sorted.slice(limit)
  const named: SeriesEntry[] = head.map(entry => ({ key: entry.key, label: seriesLabel(entry.key), tokens: entry.tokens }))
  let total = 0
  for (const entry of sorted) total += entry.tokens
  const other = tail.length > 0
    ? { key: OTHER_KEY, label: '', tokens: tail.reduce((sum, entry) => sum + entry.tokens, 0) }
    : null
  const all = other === null ? [...named] : [...named, other]
  return { named, other, all, total }
}

/** Structural day shape the helpers accept (the wire type is assignable). */
export interface DailyLike {
  date: string
  total: number
  byModel: ReadonlyArray<{ model: string, tokens: number }>
}

/** Range totals per model from the daily trend payload. */
export function modelTotalsOf(days: ReadonlyArray<DailyLike>): Array<{ key: string, tokens: number }> {
  const totals = new Map<string, number>()
  for (const day of days) {
    for (const { model, tokens } of day.byModel) {
      totals.set(model, (totals.get(model) ?? 0) + tokens)
    }
  }
  return [...totals.entries()].map(([key, tokens]) => ({ key, tokens }))
}

/**
 * Per-day stacks aligned with a {@link NamedCut}: `values[i]` is the day's
 * tokens of `all[i]` (the last slot is “other”). Zero-token days keep their
 * place so the x axis stays a continuous calendar.
 */
export function stackedPoints(
  days: ReadonlyArray<DailyLike>,
  cut: NamedCut,
): Array<{ date: string, total: number, values: number[] }> {
  const index = new Map(cut.all.map((entry, i) => [entry.key, i]))
  return days.map(day => {
    const values = cut.all.map(() => 0)
    for (const { model, tokens } of day.byModel) {
      const at = index.get(model) ?? index.get(OTHER_KEY)
      if (at !== undefined) values[at] = values[at]! + tokens
    }
    return { date: day.date, total: day.total, values }
  })
}

/** Round up to a "nice" axis maximum (1/2/5 × 10^k); non-positive becomes 1. */
export function niceCeil(value: number): number {
  if (!(value > 0)) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const scale of [1, 2, 5, 10]) {
    if (value <= scale * base) return scale * base
  }
  return 10 * base
}

/**
 * Left gutter for a plot from its formatted y ticks: the widest label's
 * character count times `charWidth` plus padding, clamped to [min, max]. The
 * axis compact formatter keeps labels short; the gutter still fits `1000万`
 * without the fixed-46px truncation the redesign fixes.
 */
export function gutterOf(ticks: ReadonlyArray<string>, options?: {
  charWidth?: number
  pad?: number
  min?: number
  max?: number
}): number {
  const { charWidth = 6.4, pad = 10, min = 24, max = 72 } = options ?? {}
  let widest = 0
  for (const tick of ticks) widest = Math.max(widest, tick.length)
  return Math.min(max, Math.max(min, Math.ceil(widest * charWidth + pad)))
}

/**
 * Evenly rounded donut shares: each slice's share of `total`, with the
 * rounding residue absorbed by the largest slice so the parts always sum to
 * exactly 1 — the ring and the ranking can never disagree about 100%.
 */
export function normalizedShares(values: ReadonlyArray<number>): number[] {
  if (values.some(value => !Number.isFinite(value) || value < 0)) return values.map(() => 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || total <= 0) return values.map(() => 0)
  const shares = values.map(value => value / total)
  // Re-anchor on the largest slice (index 0 after sorting; callers pass
  // descending data, but be robust to any order).
  let largest = 0
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! > values[largest]!) largest = i
  }
  let sum = 0
  for (const share of shares) sum += share
  shares[largest] = shares[largest]! + (1 - sum)
  return shares
}

/**
 * Donut/ranking series from a breakdown payload: shares renormalized over the
 * Top-N + other cut, sorted descending. `points` is empty — the donut has no
 * per-day dimension; the shared shape keeps colors identical to the trend.
 */
export function breakdownCut(breakdown: UsageStatsBreakdown, limit = 5): NamedCut & { shares: number[] } {
  const entries: Array<{ key: string, tokens: number }> = breakdown.slices.map((slice: UsageStatsBreakdownSlice) => ({
    key: slice.key,
    tokens: slice.tokens,
  }))
  const cut = cutNamed(entries, limit)
  const shares = normalizedShares(cut.all.map(entry => entry.tokens))
  return { ...cut, shares }
}

/** True when the daily payload carries no day at all. */
export function isDailyEmpty(days: ReadonlyArray<DailyLike>): boolean {
  return days.length === 0
}
