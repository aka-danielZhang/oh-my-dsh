import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { definition, factory, parseIcs, readCalendar, validateConfig } from '../src/index.ts'

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:review-1
SUMMARY:产品评审
DTSTART:20261024T100000Z
DTEND:20261024T110000Z
SEQUENCE:2
LOCATION:会议室 A
DESCRIPTION:讨论 Q4 计划
END:VEVENT
END:VCALENDAR
`

test('declaration is a valid quno.sense/v1 poll source', () => {
  assert.equal(definition.contractVersion, 'quno.sense/v1')
  assert.equal(definition.reliability.checkpoint, 'snapshot')
  assert.equal(definition.runtime.modes.includes('poll'), true)
  assert.equal(definition.reliability.gapDetection, 'explicit')
})

test('parseIcs: UTC times, revision and identity', () => {
  const events = parseIcs(ICS, 'Asia/Shanghai')
  assert.equal(events.length, 1)
  const event = events[0]!
  assert.equal(event.uid, 'review-1')
  assert.equal(event.summary, '产品评审')
  assert.equal(event.start, Date.UTC(2026, 9, 24, 10, 0, 0))
  assert.equal(event.end, Date.UTC(2026, 9, 24, 11, 0, 0))
  assert.match(event.revision, /^2:/)
})

test('parseIcs: floating time is read in the configured zone', () => {
  const [event] = parseIcs(`BEGIN:VEVENT
UID:floating
SUMMARY:本地会议
DTSTART:20261024T100000
END:VEVENT`, 'Asia/Shanghai')
  assert.ok(event !== undefined)
  assert.equal(event.start, Date.UTC(2026, 9, 24, 2, 0, 0), '10:00 Asia/Shanghai is 02:00Z')
})

test('parseIcs: all-day and escaped text', () => {
  const [event] = parseIcs(`BEGIN:VEVENT
UID:allday
SUMMARY:评审\\, 改期
DTSTART;VALUE=DATE:20261025
END:VEVENT`, 'Asia/Shanghai')
  assert.ok(event !== undefined)
  assert.equal(event.allDay, true)
  assert.equal(event.summary, '评审, 改期')
})

test('validateConfig: path exclusivity, interval floor, zone validation', () => {
  assert.equal(validateConfig({}).ok, false)
  assert.equal(validateConfig({ directory: '/tmp/a', file: '/tmp/b.ics' }).ok, false)
  assert.equal(validateConfig({ directory: '/tmp/a', intervalSec: 5 }).ok, false)
  assert.equal(validateConfig({ directory: '/tmp/a', timeZone: 'Mars/Olympus' }).ok, false)
  const valid = validateConfig({ directory: '/tmp/a', intervalSec: 30 })
  assert.equal(valid.ok, true)
})

test('readCalendar: reads every .ics file and skips out-of-window events', () => {
  const root = mkdtempSync(join(tmpdir(), 'quno-cal-'))
  const past = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const soon = new Date(Date.now() + 2 * 60 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  writeFileSync(join(root, 'a.ics'), `BEGIN:VEVENT
UID:old
SUMMARY:很久以前
DTSTART:${past}
END:VEVENT
BEGIN:VEVENT
UID:soon
SUMMARY:马上开始
DTSTART:${soon}
END:VEVENT`)
  const config = validateConfig({ directory: root })
  assert.ok(config.ok)
  const snapshot = readCalendar(config.value)
  assert.equal(snapshot.files, 1)
  assert.deepEqual(snapshot.events.map(event => event.uid), ['soon'])
  assert.deepEqual(snapshot.gaps, [])
})

test('probe reports a missing directory without throwing', async () => {
  const config = validateConfig({ directory: '/definitely/missing/quno-test' })
  assert.ok(config.ok)
  const result = await factory.probe!(config.value, {} as never)
  assert.equal(result.ok, false)
})
