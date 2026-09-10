/**
 * Pure fold logic for usage statistics: event narrowing, day aggregation, and
 * every metric the gateway serves. Framework-free and filesystem-free on
 * purpose — unit-testable without a Cordis context; src/store.ts owns
 * persistence and src/collector.ts owns event wiring.
 *
 * @module dsh-usage-stats/fold
 */

import type { UsageRecord } from './types.ts'
import { recordTotal } from './types.ts'
import type {
  UsageStatsActivity,
  UsageStatsActivityCell,
  UsageStatsBreakdown,
  UsageStatsBreakdownSlice,
  UsageStatsDaily,
  UsageStatsDailyEntry,
  UsageStatsSummary,
} from './types.ts'

/**
 * Minimal structural view of a session event. Duck-typed (mirrors
 * dsh-fs-observation-log's header-view precedent) so tests construct plain
 * objects and the built bundle keeps zero `@deepseek-ai/*` runtime imports.
 */
export interface SessionEventView {
  type: string
  seq: number
  time: number
  data: {
    turn?: unknown
    step?: unknown
    message?: { id?: unknown, source?: { provider?: unknown, model?: unknown } } | null
    usage?: {
      inputTokens?: unknown
      outputTokens?: unknown
      cacheReadTokens?: unknown
      cacheWriteTokens?: unknown
      reasoningTokens?: unknown
    } | null
  }
}

/** Turn/step pair key when the event carries one, else null. */
function turnStepOf(data: SessionEventView['data']): string | null {
  if (typeof data.turn !== 'number' || !Number.isFinite(data.turn)) return null
  if (typeof data.step !== 'number' || !Number.isFinite(data.step)) return null
  return `${data.turn}:${data.step}`
}

/** Read a non-negative finite number, defaulting to 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Narrow one session event into a {@link UsageRecord}.
 *
 * Counted: `assistant/message` events whose usage reports at least one billed
 * token (interrupted messages included — tokens were really spent). Skipped:
 * every other event type, usage-less or all-zero usage calls (adapters that
 * report nothing), and messages without a resolvable id/provider/model.
 */
export function usageRecordFromEvent(sid: string, event: SessionEventView): UsageRecord | undefined {
  if (event.type !== 'assistant/message') return undefined
  if (typeof sid !== 'string' || sid.length === 0) return undefined
  const usage = event.data?.usage
  const message = event.data?.message
  if (usage === null || usage === undefined || message === null || message === undefined) return undefined
  const mid = message.id
  if (typeof mid !== 'string' || mid.length === 0) return undefined
  const source = message.source
  if (source === null || source === undefined) return undefined
  const provider = source.provider
  const model = source.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  const input = num(usage.inputTokens)
  const output = num(usage.outputTokens)
  const cacheRead = num(usage.cacheReadTokens)
  const cacheWrite = num(usage.cacheWriteTokens)
  if (input + output + cacheRead + cacheWrite <= 0) return undefined
  const reasoning = num(usage.reasoningTokens)
  const record: UsageRecord = {
    v: 1,
    t: typeof event.time === 'number' && Number.isFinite(event.time) && event.time >= 0 ? event.time : 0,
    sid,
    mid,
    provider,
    model,
    in: input,
    out: output,
  }
  if (cacheRead > 0) record.cr = cacheRead
  if (cacheWrite > 0) record.cw = cacheWrite
  if (reasoning > 0) record.rt = reasoning
  return record
}

/**
 * Stateful event folder: pairs `assistant/message` events with their step's
 * start time (the `step/start` event) so each record carries the call's start
 * timestamp (`sd`) — the basis of the apparent-rate and call-duration metrics.
 * One instance per collector; keys are namespaced by session id, so subagent
 * sessions with overlapping turn numbers never collide.
 */
export class SessionUsageFolder {
  private readonly steps = new Map<string, number>()

  /** Fold one event; returns a record when the event is a counted message. */
  fold(sid: string, event: SessionEventView): UsageRecord | undefined {
    if (event.type === 'step/start') {
      const key = turnStepOf(event.data)
      if (key !== null && !this.steps.has(sid + ':' + key)) this.steps.set(sid + ':' + key, event.time)
      return undefined
    }
    const record = usageRecordFromEvent(sid, event)
    if (record === undefined) return undefined
    const key = turnStepOf(event.data)
    if (key !== null) {
      const stepStart = this.steps.get(sid + ':' + key)
      if (stepStart !== undefined && stepStart < record.t) record.sd = stepStart
    }
    return record
  }
}

/** Local UTC offset in minutes for `new Date()` (e.g. CET winter = -60). */
export function localUtcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

/**
 * Local-timezone date key `yyyy-mm-dd` of one epoch-milliseconds timestamp.
 * @param t - epoch milliseconds.
 * @param utcOffsetMinutes - timezone offset injected for deterministic tests;
 *   production passes {@link localUtcOffsetMinutes}.
 */
export function dateKeyOf(t: number, utcOffsetMinutes: number): string {
  const shifted = new Date(t + utcOffsetMinutes * 60_000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Session first/last usage-event span tracked per day. */
export interface SessionSpan {
  first: number
  last: number
}

/** Aggregate of one local day. */
export interface DayAggregate {
  /** Σ recordTotal of the day. */
  total: number
  /** Largest single-call total of the day. */
  peak: number
  /** Number of counted calls. */
  calls: number
  /** provider → Σ total. */
  byProvider: Record<string, number>
  /** `provider/model` → Σ total. */
  byModel: Record<string, number>
  /** session → first/last event times seen that day. */
  sessions: Record<string, SessionSpan>
}

/** In-memory aggregate snapshot: local date key → day aggregate. */
export type DayAggregates = Record<string, DayAggregate>

/** Day index (days since 1970-01-01 UTC) of one `yyyy-mm-dd` key. */
export function dayIndexOf(dateKey: string): number {
  const parsed = Date.parse(`${dateKey}T00:00:00.000Z`)
  if (!Number.isFinite(parsed)) throw new Error(`usage-stats: invalid date key "${dateKey}"`)
  return Math.floor(parsed / 86_400_000)
}

/** Inverse of {@link dayIndexOf}: `yyyy-mm-dd` for a day index. */
export function dateKeyOfIndex(dayIndex: number): string {
  return dateKeyOf(dayIndex * 86_400_000, 0)
}

function emptyDay(): DayAggregate {
  return { total: 0, peak: 0, calls: 0, byProvider: {}, byModel: {}, sessions: {} }
}

/**
 * Fold one record into the day aggregates (mutates `days`).
 * @param days - aggregate map to mutate.
 * @param record - the usage record.
 * @param dateKey - the record's local date key (caller resolves the timezone).
 */
export function applyRecord(days: DayAggregates, record: UsageRecord, dateKey: string): void {
  const day = days[dateKey] ?? emptyDay()
  const total = recordTotal(record)
  day.total += total
  if (total > day.peak) day.peak = total
  day.calls += 1
  day.byProvider[record.provider] = (day.byProvider[record.provider] ?? 0) + total
  const modelKey = `${record.provider}/${record.model}`
  day.byModel[modelKey] = (day.byModel[modelKey] ?? 0) + total
  const span = day.sessions[record.sid]
  if (span === undefined) {
    day.sessions[record.sid] = { first: record.t, last: record.t }
  } else {
    if (record.t < span.first) span.first = record.t
    if (record.t > span.last) span.last = record.t
  }
  days[dateKey] = day
}

/** Parse one records-JSONL line; malformed lines and unknown versions yield undefined. */
export function parseRecordLine(line: string): UsageRecord | undefined {
  if (line.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Partial<UsageRecord>
  if (record.v !== 1) return undefined
  if (typeof record.t !== 'number' || !Number.isFinite(record.t)) return undefined
  if (typeof record.sid !== 'string' || record.sid.length === 0) return undefined
  if (typeof record.mid !== 'string' || record.mid.length === 0) return undefined
  if (typeof record.provider !== 'string' || record.provider.length === 0) return undefined
  if (typeof record.model !== 'string' || record.model.length === 0) return undefined
  if (typeof record.in !== 'number' || typeof record.out !== 'number') return undefined
  return {
    v: 1,
    t: record.t,
    sid: record.sid,
    mid: record.mid,
    provider: record.provider,
    model: record.model,
    in: record.in,
    out: record.out,
    ...typeof record.cr === 'number' && record.cr > 0 ? { cr: record.cr } : {},
    ...typeof record.cw === 'number' && record.cw > 0 ? { cw: record.cw } : {},
    ...typeof record.rt === 'number' && record.rt > 0 ? { rt: record.rt } : {},
    ...typeof record.sd === 'number' && record.sd > 0 && record.sd <= record.t ? { sd: record.sd } : {},
  }
}

/** Serialize one record as a JSONL line (newline included). */
export function serializeRecordLine(record: UsageRecord): string {
  return `${JSON.stringify(record)}\n`
}

/**
 * Longest and current streaks over the set of active local dates.
 *
 * `current` counts the consecutive run that reaches today or yesterday — a
 * today with no records yet does not break the streak (GitHub-calendar
 * semantics); an older gap resets it to 0.
 */
export function streaksOf(dateKeys: readonly string[], now: number, utcOffsetMinutes: number): {
  current: number
  longest: number
} {
  if (dateKeys.length === 0) return { current: 0, longest: 0 }
  const indexes = [...new Set(dateKeys)].map(dayIndexOf).sort((a, b) => a - b)
  let longest = 1
  let run = 1
  let currentRun = 0
  const todayIndex = dayIndexOf(dateKeyOf(now, utcOffsetMinutes))
  for (let i = 1; i <= indexes.length; i += 1) {
    const contiguous = i < indexes.length && indexes[i] === indexes[i - 1]! + 1
    if (contiguous) {
      run += 1
    } else {
      if (run > longest) longest = run
      // A run ending today or yesterday is "current".
      if (indexes[i - 1]! >= todayIndex - 1 && indexes[i - 1]! <= todayIndex) currentRun = run
      run = 1
    }
  }
  return { current: currentRun, longest }
}

/**
 * Merge every day's session spans and return the widest first→last span.
 * Cross-day sessions count as one whole span (min first, max last per sid).
 */
export function longestSessionMs(days: DayAggregates): number {
  const merged = new Map<string, SessionSpan>()
  for (const day of Object.values(days)) {
    for (const [sid, span] of Object.entries(day.sessions)) {
      const known = merged.get(sid)
      if (known === undefined) {
        merged.set(sid, { first: span.first, last: span.last })
      } else {
        if (span.first < known.first) known.first = span.first
        if (span.last > known.last) known.last = span.last
      }
    }
  }
  let widest = 0
  for (const span of merged.values()) {
    const width = span.last - span.first
    if (width > widest) widest = width
  }
  return widest
}

/**
 * Fold the five headline cards.
 * @param days - the aggregate map.
 * @param now - epoch milliseconds (streak anchor, "today").
 * @param utcOffsetMinutes - local timezone offset for date bucketing.
 */
export function summarize(days: DayAggregates, now: number, utcOffsetMinutes: number): UsageStatsSummary {
  const keys = Object.keys(days)
  let totalTokens = 0
  let peakTokens = 0
  let calls = 0
  for (const day of Object.values(days)) {
    totalTokens += day.total
    if (day.peak > peakTokens) peakTokens = day.peak
    calls += day.calls
  }
  const sorted = [...keys].sort()
  const streaks = streaksOf(keys, now, utcOffsetMinutes)
  return {
    totalTokens,
    peakTokens,
    calls,
    longestChatMs: longestSessionMs(days),
    currentStreakDays: streaks.current,
    longestStreakDays: streaks.longest,
    activeDays: keys.length,
    firstDate: sorted[0] ?? null,
    lastDate: sorted[sorted.length - 1] ?? null,
    speedTokensPerSec: null,
    avgCallMs: null,
    cacheHitRate: null,
    generatedAt: now,
  }
}

/** Range selector for the trend and donut payloads. */
export type UsageStatsRangeSpec = { days: number } | { from: string; to: string }

/** Local date keys covered by one range spec, oldest first (bounded at 120 days). */
export function rangeDateKeysOf(
  now: number,
  utcOffsetMinutes: number,
  spec: UsageStatsRangeSpec,
): string[] {
  if ('from' in spec && 'to' in spec) {
    const startIndex = dayIndexOf(spec.from)
    const endIndex = dayIndexOf(spec.to)
    if (Number.isFinite(startIndex) && Number.isFinite(endIndex) && startIndex <= endIndex && endIndex - startIndex <= 120) {
      const keys: string[] = []
      for (let i = startIndex; i <= endIndex; i += 1) keys.push(dateKeyOfIndex(i))
      return keys
    }
  }
  const days = 'days' in spec && Number.isFinite(spec.days) && spec.days > 0 ? Math.floor(spec.days) : 7
  const todayIndex = dayIndexOf(dateKeyOf(now, utcOffsetMinutes))
  const keys: string[] = []
  for (let i = days - 1; i >= 0; i -= 1) keys.push(dateKeyOfIndex(todayIndex - i))
  return keys
}

/**
 * Build the trend series: one entry per day in the requested range, oldest
 * first, zero-filled, per-model detail sorted by tokens.
 */
export function dailySeries(
  days: DayAggregates,
  now: number,
  utcOffsetMinutes: number,
  range: UsageStatsRangeSpec,
): UsageStatsDaily {
  const entries: UsageStatsDailyEntry[] = []
  for (const date of rangeDateKeysOf(now, utcOffsetMinutes, range)) {
    const day = days[date]
    if (day === undefined) {
      entries.push({ date, total: 0, byModel: [] })
      continue
    }
    const byModel = Object.entries(day.byModel)
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
    entries.push({ date, total: day.total, byModel })
  }
  return { days: entries }
}

/** Color bucket for one value against the range max: 0 empty, else 1..4. */
export function levelOf(total: number, maxTotal: number): number {
  if (total <= 0) return 0
  if (maxTotal <= 0) return 1
  return Math.min(4, Math.max(1, Math.ceil((total / maxTotal) * 4)))
}

/** Monday date key of the week containing `dateKey`. */
function weekStartOf(dateKey: string): string {
  const index = dayIndexOf(dateKey)
  // 1970-01-01 was a Thursday (dow 4); Monday-based dow: (index + 3) % 7.
  const dow = (index + 3) % 7
  return dateKeyOfIndex(index - dow)
}

/** Heatmap window: `weeks` Monday-aligned weeks ending with the current week. */
function heatmapDateKeys(now: number, utcOffsetMinutes: number, weeks: number): string[] {
  const todayIndex = dayIndexOf(dateKeyOf(now, utcOffsetMinutes))
  const thisMonday = dayIndexOf(weekStartOf(dateKeyOfIndex(todayIndex)))
  const start = thisMonday - (weeks - 1) * 7
  const end = thisMonday + 6
  const keys: string[] = []
  for (let i = start; i <= end; i += 1) keys.push(dateKeyOfIndex(i))
  return keys
}

/**
 * Build the heatmap payload over the trailing ~52 weeks.
 *
 * `daily` buckets per local day; `weekly` sums per Monday-starting week;
 * `cumulative` fills each day with the running total since the window start.
 */
export function activityCells(
  days: DayAggregates,
  mode: UsageStatsActivity['mode'],
  now: number,
  utcOffsetMinutes: number,
  weeks = 52,
): UsageStatsActivity {
  const windowKeys = heatmapDateKeys(now, utcOffsetMinutes, weeks)
  const cells: UsageStatsActivityCell[] = []
  let cumulative = 0
  if (mode === 'weekly') {
    const weekTotals = new Map<string, { total: number; calls: number }>()
    for (const key of windowKeys) {
      const week = weekStartOf(key)
      const day = days[key]
      const acc = weekTotals.get(week) ?? { total: 0, calls: 0 }
      acc.total += day?.total ?? 0
      acc.calls += day?.calls ?? 0
      weekTotals.set(week, acc)
    }
    let maxTotal = 0
    for (const v of weekTotals.values()) if (v.total > maxTotal) maxTotal = v.total
    for (const [date, v] of weekTotals) {
      cells.push({ date, total: v.total, calls: v.calls, level: levelOf(v.total, maxTotal) })
    }
    return { mode, cells, maxTotal }
  }
  let maxTotal = 0
  for (const key of windowKeys) {
    const day = days[key]
    const total = day?.total ?? 0
    if (mode === 'cumulative') {
      cumulative += total
      cells.push({ date: key, total: cumulative, calls: 0, level: 0 })
      if (cumulative > maxTotal) maxTotal = cumulative
    } else {
      cells.push({ date: key, total, calls: day?.calls ?? 0, level: 0 })
      if (total > maxTotal) maxTotal = total
    }
  }
  const settledMax = maxTotal
  for (const cell of cells) cell.level = levelOf(cell.total, settledMax)
  return { mode, cells, maxTotal }
}

/**
 * Build the donut payload grouped by provider or model over the requested
 * range, shares against the range total.
 * @param providerLabels - provider id → display name (gateway resolves these
 *   via `ctx.llm.listProviders()`; unknown ids fall back to the raw id).
 */
export function breakdownOf(
  days: DayAggregates,
  dim: UsageStatsBreakdown['dim'],
  now: number,
  utcOffsetMinutes: number,
  range: UsageStatsRangeSpec,
  providerLabels: ReadonlyMap<string, string>,
): UsageStatsBreakdown {
  const totals = new Map<string, number>()
  let total = 0
  for (const date of rangeDateKeysOf(now, utcOffsetMinutes, range)) {
    const day = days[date]
    if (day === undefined) continue
    const source = dim === 'provider' ? day.byProvider : day.byModel
    for (const [key, tokens] of Object.entries(source)) {
      totals.set(key, (totals.get(key) ?? 0) + tokens)
      total += tokens
    }
  }
  const slices: UsageStatsBreakdownSlice[] = [...totals.entries()]
    .map(([key, tokens]) => ({
      key,
      label: dim === 'provider'
        ? providerLabels.get(key) ?? key
        : key.slice(key.indexOf('/') + 1),
      tokens,
      share: total > 0 ? tokens / total : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.key.localeCompare(b.key))
  return { dim, total, slices }
}
