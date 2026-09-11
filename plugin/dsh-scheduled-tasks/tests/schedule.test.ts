/**
 * Boundary math tests (design §8.1, acceptance §15.1): ordinary days, all
 * five rule kinds, DST gap/overlap, day/week/month rollover, host-timezone
 * independence, and the bounded catch-up window.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dueCatchUpBoundary,
  latestBoundary,
  localTimeLabel,
  nextBoundary,
  parseLocalTime,
  scheduleLabel,
  wallComponents,
  wallTimeToInstant,
  wallWeekday,
  type ScheduleRule,
} from '../src/schedule.ts'

const hourly = (minute: number): ScheduleRule => ({ kind: 'hourly', minute })
const daily = (hour: number, minute: number): ScheduleRule => ({ kind: 'daily', hour, minute })
const weekdays = (hour: number, minute: number): ScheduleRule => ({ kind: 'weekdays', hour, minute })
const weekly = (dayOfWeek: number, hour: number, minute: number): ScheduleRule => ({ kind: 'weekly', dayOfWeek, hour, minute })
const monthly = (dayOfMonth: number, hour: number, minute: number): ScheduleRule => ({ kind: 'monthly', dayOfMonth, hour, minute })

test('parseLocalTime accepts strict HH:mm and rejects the rest', () => {
  assert.deepEqual(parseLocalTime('02:00'), { hour: 2, minute: 0 })
  assert.deepEqual(parseLocalTime('23:59'), { hour: 23, minute: 59 })
  assert.throws(() => parseLocalTime('24:00'))
  assert.throws(() => parseLocalTime('7:30'))
  assert.throws(() => parseLocalTime(''))
})

test('next daily boundary is strictly in the future and advances across the day', () => {
  // 2026-09-11T10:00:00Z
  const now = Date.UTC(2026, 8, 11, 10, 0, 0)
  const next = nextBoundary(now, daily(9, 30), 'Asia/Shanghai')
  // 09-11 09:30 +08 = 01:30Z (past); next is 09-12 09:30 +08 = 01:30Z on the 12th.
  assert.equal(next, Date.UTC(2026, 8, 12, 1, 30, 0))
})

test('a later wall time today still fires today', () => {
  const now = Date.UTC(2026, 8, 11, 1, 0, 0) // 09:00 +08
  const next = nextBoundary(now, daily(22, 5), 'Asia/Shanghai')
  assert.equal(next, Date.UTC(2026, 8, 11, 14, 5, 0))
})

test('the pinned zone wins over the host ambient zone', () => {
  const now = Date.UTC(2026, 8, 10, 23, 30, 0)
  const shanghai = nextBoundary(now, daily(8, 0), 'Asia/Shanghai')
  const tokyo = nextBoundary(now, daily(8, 0), 'Asia/Tokyo')
  // Same wall clock, different zones ⇒ different instants (Tokyo is 1h ahead).
  assert.notEqual(shanghai, tokyo)
  assert.equal(shanghai, Date.UTC(2026, 8, 11, 0, 0, 0))
  assert.equal(tokyo, Date.UTC(2026, 8, 11, 23, 0, 0))
})

test('wallComponents renders one instant differently per zone', () => {
  const instant = Date.UTC(2026, 8, 11, 2, 0, 0)
  assert.equal(localTimeLabel(instant, 'Asia/Shanghai'), '10:00')
  assert.equal(localTimeLabel(instant, 'UTC'), '02:00')
})

test('hourly fires inside the current hour or the next one', () => {
  // 2026-09-11T10:00:00Z = 18:00 +08 → 18:30 +08 = 10:30Z.
  assert.equal(nextBoundary(Date.UTC(2026, 8, 11, 10, 0, 0), hourly(30), 'Asia/Shanghai'), Date.UTC(2026, 8, 11, 10, 30, 0))
  // Exactly on the boundary: the next one, never the same instant twice.
  assert.equal(nextBoundary(Date.UTC(2026, 8, 11, 10, 30, 0), hourly(30), 'Asia/Shanghai'), Date.UTC(2026, 8, 11, 11, 30, 0))
  // Past this hour's minute → the following hour.
  assert.equal(nextBoundary(Date.UTC(2026, 8, 11, 10, 59, 0), hourly(5), 'Asia/Shanghai'), Date.UTC(2026, 8, 11, 11, 5, 0))
  // 23:30 +08 → 00:05 +08 tomorrow (same UTC day).
  assert.equal(nextBoundary(Date.UTC(2026, 8, 11, 15, 30, 0), hourly(5), 'Asia/Shanghai'), Date.UTC(2026, 8, 11, 16, 5, 0))
})

test('hourly latest boundary stays at or before now', () => {
  const latest = latestBoundary(Date.UTC(2026, 8, 11, 10, 45, 0), hourly(30), 'Asia/Shanghai')
  assert.equal(latest, Date.UTC(2026, 8, 11, 10, 30, 0))
  assert.ok(latest <= Date.UTC(2026, 8, 11, 10, 45, 0))
})

test('weekdays skip the weekend and fire Monday', () => {
  // 2026-09-11 is a Friday; 18:00 +08 already passed at 10:00Z.
  const friday = Date.UTC(2026, 8, 11, 10, 0, 0)
  assert.equal(wallWeekday({ year: 2026, month: 9, day: 11 }), 5)
  assert.equal(nextBoundary(friday, weekdays(18, 0), 'Asia/Shanghai'), Date.UTC(2026, 8, 14, 10, 0, 0))
  // Saturday and Sunday roll to the same Monday.
  assert.equal(nextBoundary(Date.UTC(2026, 8, 12, 4, 0, 0), weekdays(9, 0), 'Asia/Shanghai'), Date.UTC(2026, 8, 14, 1, 0, 0))
  assert.equal(nextBoundary(Date.UTC(2026, 8, 13, 4, 0, 0), weekdays(9, 0), 'Asia/Shanghai'), Date.UTC(2026, 8, 14, 1, 0, 0))
})

test('weekly finds the named weekday', () => {
  // Wednesday 2026-09-09 12:00Z → next Monday 2026-09-14 09:00 +08 = 01:00Z.
  assert.equal(wallWeekday({ year: 2026, month: 9, day: 9 }), 3)
  assert.equal(nextBoundary(Date.UTC(2026, 8, 9, 12, 0, 0), weekly(1, 9, 0), 'Asia/Shanghai'), Date.UTC(2026, 8, 14, 1, 0, 0))
  // Sunday (7) is honoured too: from Wednesday the 9th → 2026-09-13.
  assert.equal(nextBoundary(Date.UTC(2026, 8, 9, 12, 0, 0), weekly(7, 9, 0), 'Asia/Shanghai'), Date.UTC(2026, 8, 13, 1, 0, 0))
})

test('monthly rolls into the next month, and skips months without that date', () => {
  // 2026-09-20 → October 15th.
  const late = Date.UTC(2026, 8, 20, 0, 0, 0)
  assert.equal(nextBoundary(late, monthly(15, 9, 0), 'Asia/Shanghai'), Date.UTC(2026, 9, 15, 1, 0, 0))
  // February has no 31st: the rule skips to March 31st instead of clamping.
  assert.equal(nextBoundary(Date.UTC(2026, 1, 10, 0, 0, 0), monthly(31, 9, 0), 'Asia/Shanghai'), Date.UTC(2026, 2, 31, 1, 0, 0))
  // A day the current month still has fires this month.
  assert.equal(nextBoundary(Date.UTC(2026, 2, 15, 0, 0, 0), monthly(31, 9, 0), 'Asia/Shanghai'), Date.UTC(2026, 2, 31, 1, 0, 0))
})

test('DST fall-back overlap fires once at the earlier instant (America/New_York 2026-11-01 01:30)', () => {
  const instant = wallTimeToInstant(2026, 11, 1, { hour: 1, minute: 30 }, 'America/New_York')
  // Earlier (EDT, UTC-4) occurrence: 05:30Z.
  assert.equal(instant, Date.UTC(2026, 10, 1, 5, 30, 0))
  // And exactly once per day: the next boundary after it is tomorrow's.
  assert.equal(nextBoundary(instant + 1, daily(1, 30), 'America/New_York'), Date.UTC(2026, 10, 2, 6, 30, 0))
  // The repeated wall hour never schedules a second hourly firing: after the
  // 01:30 EDT boundary the walker goes straight to 02:30 EST.
  assert.equal(nextBoundary(instant + 1, hourly(30), 'America/New_York'), Date.UTC(2026, 10, 1, 7, 30, 0))
})

test('DST spring-forward gap lands at/after the transition and fires once (America/New_York 2026-03-08 02:30)', () => {
  const instant = wallTimeToInstant(2026, 3, 8, { hour: 2, minute: 30 }, 'America/New_York')
  // Transition is 07:00Z (02:00 EST → 03:00 EDT); the gap target resolves
  // at/after it and still inside the same day.
  assert.ok(instant >= Date.UTC(2026, 2, 8, 7, 0, 0), `gap instant ${instant} before transition`)
  assert.ok(instant < Date.UTC(2026, 2, 9, 0, 0, 0), 'gap instant left the day')
  const wall = wallComponents(instant, 'America/New_York')
  assert.equal(wall.day, 8)
  // One firing per day: next boundary is the following day's target
  // (2026-03-09 is already EDT, so 02:30 = 06:30Z).
  assert.equal(nextBoundary(instant + 1, daily(2, 30), 'America/New_York'), Date.UTC(2026, 2, 9, 6, 30, 0))
  // The skipped 02:30 wall hour and the 03:30 hour share one instant, so the
  // hourly walker fires once there and resumes at 04:30 EDT.
  assert.equal(nextBoundary(Date.UTC(2026, 2, 8, 6, 30, 0) + 1, hourly(30), 'America/New_York'), Date.UTC(2026, 2, 8, 7, 30, 0))
  assert.equal(nextBoundary(Date.UTC(2026, 2, 8, 7, 30, 0) + 1, hourly(30), 'America/New_York'), Date.UTC(2026, 2, 8, 8, 30, 0))
})

test('latest boundary never exceeds now', () => {
  const now = Date.UTC(2026, 8, 11, 10, 0, 0)
  const latest = latestBoundary(now, daily(9, 30), 'Asia/Shanghai')
  // 2026-09-11 09:30 +08 = 01:30Z — earlier today.
  assert.equal(latest, Date.UTC(2026, 8, 11, 1, 30, 0))
  assert.ok(latest <= now)
})

test('catch-up takes only the latest unconsumed boundary inside the window', () => {
  const now = Date.UTC(2026, 8, 11, 10, 0, 0)
  const window12h = 12 * 3_600_000
  const due = Date.UTC(2026, 8, 11, 1, 30, 0) // 09-11 09:30 +08
  const rule = daily(9, 30)

  // Never consumed and fresh enough → run it.
  assert.equal(dueCatchUpBoundary(now, rule, 'Asia/Shanghai', null, false, window12h), due)
  // Already consumed → nothing.
  assert.equal(dueCatchUpBoundary(now, rule, 'Asia/Shanghai', due, false, window12h), undefined)
  // Older than the window → never replayed.
  assert.equal(dueCatchUpBoundary(now + 13 * 3_600_000, rule, 'Asia/Shanghai', null, false, window12h), undefined)
  // An active run blocks catch-up (overlap policy).
  assert.equal(dueCatchUpBoundary(now, rule, 'Asia/Shanghai', null, true, window12h), undefined)
})

test('no catch-up when the boundary is still in the future', () => {
  const now = Date.UTC(2026, 8, 11, 0, 0, 0) // 08:00 +08, before a 09:30 target
  assert.equal(dueCatchUpBoundary(now, daily(9, 30), 'Asia/Shanghai', null, false, 12 * 3_600_000), undefined)
})

test('catch-up for an hourly rule replays only the most recent missed hour', () => {
  const now = Date.UTC(2026, 8, 11, 10, 45, 0) // 18:45 +08
  const latest = Date.UTC(2026, 8, 11, 10, 30, 0) // 18:30 +08
  assert.equal(dueCatchUpBoundary(now, hourly(30), 'Asia/Shanghai', null, false, 12 * 3_600_000), latest)
  assert.equal(dueCatchUpBoundary(now, hourly(30), 'Asia/Shanghai', latest, false, 12 * 3_600_000), undefined)
})

test('scheduleLabel names each kind', () => {
  assert.equal(scheduleLabel(hourly(5)), '每小时 :05')
  assert.equal(scheduleLabel(daily(9, 30)), '每天 09:30')
  assert.equal(scheduleLabel(weekdays(9, 0)), '每工作日 09:00')
  assert.equal(scheduleLabel(weekly(1, 9, 0)), '每周一 09:00')
  assert.equal(scheduleLabel(monthly(15, 9, 0)), '每月 15 号 09:00')
})

test('wallWeekday maps Sunday to 7', () => {
  assert.equal(wallWeekday({ year: 2026, month: 9, day: 13 }), 7)
  assert.equal(wallWeekday({ year: 2026, month: 9, day: 14 }), 1)
})
