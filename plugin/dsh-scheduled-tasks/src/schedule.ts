/**
 * Boundary math for fixed-IANA-timezone schedules (design §8.1).
 *
 * Five rule kinds share one walker: `hourly` (every hour at `:mm`), `daily`,
 * `weekdays` (Mon–Fri), `weekly` (one ISO weekday), and `monthly` (one day of
 * month). Pure and host-independent: every function takes an explicit IANA
 * zone, so a machine timezone change can never shift an existing task's firing
 * time (design acceptance §15.1). Offsets come from `Intl` — no dependency on
 * the process ambient zone.
 *
 * DST policy (design §8.1, unchanged by the kind extension):
 * - A wall time skipped by a spring-forward gap fires once that day at the
 *   first instant at-or-after the transition end (practically: the shifted
 *   wall time, e.g. 02:30 → 03:30 for a one-hour jump). An hourly rule whose
 *   skipped wall time collapses onto the next hour therefore fires ONCE at
 *   that instant: boundaries are always recomputed strictly after `now`, and
 *   the collapsed pair shares one instant.
 * - A wall time repeated by a fall-back overlap fires at the earlier instant,
 *   and only once — including the repeated wall hour of an hourly rule.
 *
 * Monthly on a day the month does not have (day 31 in February) skips that
 * month entirely rather than clamping to its last day: the rule names a date,
 * and "the 31st" has no February occurrence.
 * @module dsh-scheduled-tasks/schedule
 */

/** Parsed strict `HH:mm`. */
export interface LocalTime {
  hour: number
  minute: number
}

/** One schedule rule in numeric form — the persisted shapes live in ./contract.ts. */
export type ScheduleRule =
  | { kind: 'hourly', minute: number }
  | { kind: 'daily', hour: number, minute: number }
  | { kind: 'weekdays', hour: number, minute: number }
  | { kind: 'weekly', dayOfWeek: number, hour: number, minute: number }
  | { kind: 'monthly', dayOfMonth: number, hour: number, minute: number }

/** Parse a validated `HH:mm` string into hour/minute numbers. */
export function parseLocalTime(localTime: string): LocalTime {
  const match = /^(?:[01]\d|2[0-3]):([0-5]\d)$/.exec(localTime)
  if (match === null) throw new TypeError(`invalid local time ${JSON.stringify(localTime)}`)
  return { hour: Number(match[0].slice(0, 2)), minute: Number(match[1]) }
}

/** Formatter cache: one Intl instance per zone (offset math is hot). */
const formatCache = new Map<string, Intl.DateTimeFormat>()

interface WallComponents {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

/** Render one instant's wall clock in a zone as plain components. */
export function wallComponents(instant: number, timeZone: string): WallComponents {
  let formatter = formatCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatCache.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(new Date(instant))
  const pick = (type: string): number => {
    const part = parts.find(candidate => candidate.type === type)
    if (part === undefined) throw new Error(`schedule: missing ${type} part for zone ${timeZone}`)
    return Number(part.value)
  }
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute'), second: pick('second') }
}

/** UTC offset minutes at one instant for one zone (`local − utc`). */
export function timeZoneOffsetMinutes(instant: number, timeZone: string): number {
  const wall = wallComponents(instant, timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return Math.round((asUtc - instant) / 60_000)
}

/** A wall calendar date inside a zone. */
interface WallDate {
  year: number
  month: number
  day: number
}

/**
 * Resolve one wall time in a zone to a UTC instant. Two offset-correction
 * iterations converge everywhere except inside a spring-forward gap; an
 * unresolved gap resolves to the later candidate (at/after the transition).
 */
export function wallTimeToInstant(
  year: number,
  month: number,
  day: number,
  localTime: LocalTime,
  timeZone: string,
): number {
  const asUtcWall = Date.UTC(year, month - 1, day, localTime.hour, localTime.minute, 0, 0)
  let first = asUtcWall - timeZoneOffsetMinutes(asUtcWall, timeZone) * 60_000
  let second = asUtcWall - timeZoneOffsetMinutes(first, timeZone) * 60_000
  if (second !== first) {
    const third = asUtcWall - timeZoneOffsetMinutes(second, timeZone) * 60_000
    // Gap: candidates straddle the transition — take the at/after-transition one.
    first = Math.max(second, third)
  } else {
    first = second
  }
  return first
}

/** Shift one wall calendar date by whole days (month/year rollover included). */
function addWallDays(date: WallDate, delta: number): WallDate {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day))
  probe.setUTCDate(probe.getUTCDate() + delta)
  return { year: probe.getUTCFullYear(), month: probe.getUTCMonth() + 1, day: probe.getUTCDate() }
}

/** ISO weekday of a wall date: 1 = Monday … 7 = Sunday. */
export function wallWeekday(date: WallDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
  return day === 0 ? 7 : day
}

/** Per-kind wall date test: does this rule fire on this date at all? */
function firesOn(rule: ScheduleRule, date: WallDate): boolean {
  if (rule.kind === 'hourly' || rule.kind === 'daily') return true
  if (rule.kind === 'weekdays') return wallWeekday(date) <= 5
  if (rule.kind === 'weekly') return wallWeekday(date) === rule.dayOfWeek
  return date.day === rule.dayOfMonth
}

/** Walk guard: a monthly rule needs at most ~62 days, so 400 is generous. */
const MAX_DATE_STEPS = 400
/** Walk guard for the hourly hour-by-hour scan (one day either side suffices). */
const MAX_HOUR_STEPS = 48

/**
 * Next boundary strictly after `now`, interpreted in `timeZone`.
 * @param now - reference instant (epoch ms).
 * @param rule - parsed rule.
 * @param timeZone - IANA zone the rule's wall times are read in.
 * @returns the epoch-ms instant of the next firing.
 */
export function nextBoundary(now: number, rule: ScheduleRule, timeZone: string): number {
  if (rule.kind === 'hourly') {
    const wall = wallComponents(now, timeZone)
    let date: WallDate = { year: wall.year, month: wall.month, day: wall.day }
    let hour = wall.hour
    let instant = wallTimeToInstant(date.year, date.month, date.day, { hour, minute: rule.minute }, timeZone)
    for (let step = 0; instant <= now && step < MAX_HOUR_STEPS; step++) {
      hour += 1
      if (hour > 23) {
        hour = 0
        date = addWallDays(date, 1)
      }
      instant = wallTimeToInstant(date.year, date.month, date.day, { hour, minute: rule.minute }, timeZone)
    }
    return instant
  }
  const time: LocalTime = { hour: rule.hour, minute: rule.minute }
  const wall = wallComponents(now, timeZone)
  let date: WallDate = { year: wall.year, month: wall.month, day: wall.day }
  for (let step = 0; step < MAX_DATE_STEPS; step++) {
    if (firesOn(rule, date)) {
      const instant = wallTimeToInstant(date.year, date.month, date.day, time, timeZone)
      if (instant > now) return instant
    }
    date = addWallDays(date, 1)
  }
  throw new Error(`schedule: no ${rule.kind} boundary within ${String(MAX_DATE_STEPS)} days of ${String(now)}`)
}

/**
 * Most recent boundary at or before `now`. The scan is defensive: the walk
 * never needs more than one day for `daily`/`weekdays`, seven for `weekly`,
 * and a couple of months for `monthly`.
 */
export function latestBoundary(now: number, rule: ScheduleRule, timeZone: string): number {
  if (rule.kind === 'hourly') {
    const wall = wallComponents(now, timeZone)
    let date: WallDate = { year: wall.year, month: wall.month, day: wall.day }
    let hour = wall.hour
    let instant = wallTimeToInstant(date.year, date.month, date.day, { hour, minute: rule.minute }, timeZone)
    for (let step = 0; instant > now && step < MAX_HOUR_STEPS; step++) {
      hour -= 1
      if (hour < 0) {
        hour = 23
        date = addWallDays(date, -1)
      }
      instant = wallTimeToInstant(date.year, date.month, date.day, { hour, minute: rule.minute }, timeZone)
    }
    return instant
  }
  const time: LocalTime = { hour: rule.hour, minute: rule.minute }
  const wall = wallComponents(now, timeZone)
  let date: WallDate = { year: wall.year, month: wall.month, day: wall.day }
  for (let step = 0; step < MAX_DATE_STEPS; step++) {
    if (firesOn(rule, date)) {
      const instant = wallTimeToInstant(date.year, date.month, date.day, time, timeZone)
      if (instant <= now) return instant
    }
    date = addWallDays(date, -1)
  }
  throw new Error(`schedule: no ${rule.kind} boundary within ${String(MAX_DATE_STEPS)} days before ${String(now)}`)
}

/**
 * The one boundary a startup/wake may catch up: the latest boundary at or
 * before `now`, provided it was never consumed, is not already active, and
 * sits inside the catch-up window. Older misses never replay (design §8.1).
 */
export function dueCatchUpBoundary(
  now: number,
  rule: ScheduleRule,
  timeZone: string,
  lastScheduledFor: number | null,
  activeRun: boolean,
  catchUpWindowMs: number,
): number | undefined {
  const due = latestBoundary(now, rule, timeZone)
  if (lastScheduledFor !== null && lastScheduledFor >= due) return undefined
  if (activeRun) return undefined
  if (now - due > catchUpWindowMs) return undefined
  return due
}

/** Local `HH:mm` of an instant in a zone — for the session title suffix. */
export function localTimeLabel(instant: number, timeZone: string): string {
  const wall = wallComponents(instant, timeZone)
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`
}

/** ISO weekday names for schedule labels, indexed 1–7. */
const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

/**
 * Short human label of a rule — the session title suffix and the run audit's
 * detail vocabulary share it (never the task instruction).
 */
export function scheduleLabel(rule: ScheduleRule): string {
  const hm = `${String('hour' in rule ? rule.hour : 0).padStart(2, '0')}:${String(rule.minute).padStart(2, '0')}`
  if (rule.kind === 'hourly') return `每小时 :${String(rule.minute).padStart(2, '0')}`
  if (rule.kind === 'daily') return `每天 ${hm}`
  if (rule.kind === 'weekdays') return `每工作日 ${hm}`
  if (rule.kind === 'weekly') return `每${WEEKDAY_LABELS[rule.dayOfWeek] ?? ''} ${hm}`
  return `每月 ${String(rule.dayOfMonth)} 号 ${hm}`
}
