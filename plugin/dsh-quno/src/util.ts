/**
 * Small, dependency-free helpers shared by every Quno layer: durable ids,
 * stable hashes, wall-clock arithmetic in an IANA zone, backoff and text
 * bounds.
 *
 * Time rule for the whole plugin: durable columns store epoch milliseconds
 * (UTC); local wall-clock reasoning happens only here, through
 * {@link localClock} and {@link nextQuietEnd}.
 *
 * @module dsh-quno/util
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DayRange, QunoConfig } from './types.ts'

/** Mint one prefixed durable identity. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/** SHA-256 hex of a UTF-8 string. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Deterministic JSON with sorted object keys. Event identity hashes must not
 * depend on JSON.stringify's insertion order, because a retried submission may
 * rebuild the same envelope in a different order.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** Content hash for one event payload (identity and body, not host-assigned fields). */
export function contentHashOf(event: {
  readonly eventKey: string
  readonly type: string
  readonly eventSchema?: string
  readonly summary?: string
  readonly data?: unknown
  readonly subject?: { readonly key: string; readonly revision?: string }
  readonly operation?: string
  readonly occurredAt?: string | null
  readonly provenance?: unknown
  readonly deadline?: string | null
  readonly priority?: string
}): string {
  return sha256(stableStringify({
    eventKey: event.eventKey,
    type: event.type,
    schema: event.eventSchema ?? 'quno.event/v1',
    summary: event.summary ?? null,
    data: event.data ?? null,
    subject: event.subject ?? null,
    operation: event.operation ?? 'upsert',
    occurredAt: event.occurredAt ?? null,
    provenance: event.provenance ?? null,
    deadline: event.deadline ?? null,
    priority: event.priority ?? null,
  }))
}

/** Parse an ISO timestamp to epoch ms, or null. */
export function toMillis(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** ISO string for an epoch (UTC), or null. */
export function toIso(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString()
}

/** One local wall clock reading. */
export interface LocalClock {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  /** Minutes since local midnight. */
  readonly minutes: number
  /** `YYYY-MM-DD` in the zone. */
  readonly dayKey: string
  /** `HH:MM` in the zone. */
  readonly hhmm: string
}

const CLOCK_FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function clockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = CLOCK_FORMATTERS.get(timeZone)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  CLOCK_FORMATTERS.set(timeZone, formatter)
  return formatter
}

/** Read the wall clock in `timeZone`. */
export function localClock(epochMs: number, timeZone: string): LocalClock {
  const parts = clockFormatter(timeZone).formatToParts(new Date(epochMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find(part => part.type === type)?.value
    return value === undefined ? 0 : Number(value)
  }
  const year = pick('year')
  const month = pick('month')
  const day = pick('day')
  const hour = pick('hour')
  const minute = pick('minute')
  return {
    year,
    month,
    day,
    hour,
    minute,
    minutes: hour * 60 + minute,
    dayKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  }
}

/** Parse `HH:MM` into minutes since midnight. */
export function parseHhmm(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return (hours ?? 0) * 60 + (minutes ?? 0)
}

/** Whether `minutes` falls inside [start, end); a start after end crosses midnight. */
export function inDayRange(range: DayRange, minutes: number): boolean {
  const start = parseHhmm(range.start)
  const end = parseHhmm(range.end)
  if (start === end) return false
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

/** The zone's UTC offset in milliseconds (positive east of UTC), at minute precision. */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = clockFormatter(timeZone).formatToParts(new Date(epochMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(part => part.type === type)?.value ?? '0')
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour'), pick('minute'))
  // The formatter reads whole minutes, so compare against the epoch's minute start.
  return asUtc - Math.floor(epochMs / 60_000) * 60_000
}

/** Convert a local wall-clock reading in `timeZone` to epoch ms (DST-safe enough for hour windows). */
export function zonedToEpoch(
  dayKey: string,
  minutesOfDay: number,
  timeZone: string,
): number {
  const [year, month, day] = dayKey.split('-').map(Number)
  const hours = Math.floor(minutesOfDay / 60)
  const minutes = minutesOfDay % 60
  const guess = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hours, minutes)
  let candidate = guess - zoneOffsetMs(guess, timeZone)
  const secondOffset = zoneOffsetMs(candidate, timeZone)
  candidate = guess - secondOffset
  return candidate
}

/** `YYYY-MM-DD` shifted by whole days (calendar arithmetic, no zone involved). */
export function shiftDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
  return shifted.toISOString().slice(0, 10)
}

/** Whether proactive notices are currently held. */
export function isQuietNow(config: Pick<QunoConfig, 'quietHours' | 'timeZone'>, nowMs: number): boolean {
  if (config.quietHours === null) return false
  return inDayRange(config.quietHours, localClock(nowMs, config.timeZone).minutes)
}

/**
 * The next instant the quiet window ends, or `nowMs` when it is not quiet.
 * Handles windows crossing midnight and zones with DST transitions.
 */
export function nextQuietEnd(config: Pick<QunoConfig, 'quietHours' | 'timeZone'>, nowMs: number): number {
  const range = config.quietHours
  if (range === null) return nowMs
  const clock = localClock(nowMs, config.timeZone)
  if (!inDayRange(range, clock.minutes)) return nowMs
  const endMinutes = parseHhmm(range.end)
  // The window may have started yesterday; check today's end first, then
  // tomorrow's, and pick the first strictly future instant.
  for (const offset of [0, 1]) {
    const candidate = zonedToEpoch(shiftDayKey(clock.dayKey, offset), endMinutes, config.timeZone)
    if (candidate > nowMs) return candidate
  }
  return nowMs + 60_000
}

/** Deterministic bounded exponential backoff with a small attempt-seeded jitter. */
export function backoffMs(attempts: number, baseMs = 5000, capMs = 30 * 60_000): number {
  const exponent = Math.min(10, Math.max(0, attempts))
  const base = Math.min(capMs, baseMs * 2 ** exponent)
  const jitter = Math.floor(base * 0.15 * ((attempts * 2654435761) % 1000) / 1000)
  return base + jitter
}

/** Bound a string by Unicode code points, marking truncation. */
export function truncateText(value: string, max: number): string {
  const chars = [...value]
  if (chars.length <= max) return value
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** Parse JSON defensively. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** Clamp a number into an inclusive range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Literal union helper for exhaustive switches. */
export function assertNever(value: never): never {
  throw new Error(`unexpected value: ${String(value)}`)
}

/** Render a duration in whole minutes/seconds for UI copy. */
export function humanizeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${String(seconds)} 秒`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${String(minutes)} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时`
  return `${String(Math.round(hours / 24))} 天`
}
