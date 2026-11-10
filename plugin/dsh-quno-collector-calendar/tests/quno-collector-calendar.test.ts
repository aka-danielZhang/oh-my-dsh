import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { definition, factory, ingressRefusalOf, parseIcs, readCalendar, validateConfig } from '../src/index.ts'
import type { CollectorRunContext } from '../../dsh-quno/src/collectors.ts'
import type { IngestAck, IngestBatch } from '../../dsh-quno/src/types.ts'

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

test('declaration is a valid quno.collector/v2 collector', () => {
  assert.equal(definition.contractVersion, 'quno.collector/v2')
  assert.equal(definition.reliability.checkpoint, 'snapshot')
  assert.equal(definition.schedule.defaultIntervalSec >= definition.schedule.minIntervalSec, true)
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

/* ------------------------------------------------- run(ctx) (Host-scheduled) */

type CalendarConfig = Extract<ReturnType<typeof validateConfig>, { ok: true }>['value']

/** A VCALENDAR with one event starting `offsetMs` from now (inside the read window). */
function icsAt(uid: string, offsetMs: number): string {
  const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const start = Date.now() + offsetMs
  return `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:${uid}\nSUMMARY:窗口内评审\nDTSTART:${stamp(start)}\nDTEND:${stamp(start + 3_600_000)}\nSEQUENCE:0\nEND:VEVENT\nEND:VCALENDAR\n`
}

/** The Host's ingest refusal as the commit face throws it — structurally, never the Host class. */
function refusal(code: string, retryable: boolean): Error {
  return Object.assign(new Error(`refused: ${code}`), { name: 'QunoIngressError', shape: { code, message: code, retryable } })
}

function ack(batch: IngestBatch, revision: number): IngestAck {
  return {
    batchId: `bat-${String(revision)}`,
    batchKey: batch.batchKey,
    accepted: [],
    eventCount: batch.events.length,
    acceptedCount: batch.events.length,
    duplicateCount: 0,
    checkpointRevision: revision,
    gapReported: batch.gap != null,
  }
}

function runCtx(
  config: CalendarConfig,
  commit: (batch: IngestBatch) => Promise<IngestAck>,
  checkpoint: { readonly value: string | null; readonly revision: number } = { value: null, revision: 0 },
): CollectorRunContext<CalendarConfig> {
  return {
    instanceId: 'col-cal',
    sourceId: 'src-cal',
    type: 'quno/calendar',
    config,
    runId: 1,
    checkpoint,
    limits: { maxEventsPerRun: 200, maxBytesPerRun: 8 * 1024 * 1024 },
    logger: { info: () => {}, warn: () => {} },
    signal: new AbortController().signal,
    commit,
  }
}

test('run: one snapshot-diff pass commits changes, then an unchanged pass commits nothing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quno-cal-run-'))
  writeFileSync(join(directory, 'work.ics'), icsAt('in-window-1', 2 * 86_400_000))
  const config = validateConfig({ directory })
  assert.ok(config.ok)
  const batches: IngestBatch[] = []
  const commit = async (batch: IngestBatch): Promise<IngestAck> => {
    batches.push(batch)
    return ack(batch, batches.length)
  }
  const first = await factory.run(runCtx(config.value, commit))
  assert.equal(first.ok, true)
  assert.ok(first.ok && typeof first.nextRunAtMs === 'number', 'the declared interval becomes the next-run hint')
  assert.equal(first.ok && first.health?.coveredThrough, '1 file(s)')
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0]?.events.map(event => event.type), ['calendar/event-updated'])
  assert.equal(batches[0]?.checkpointAfter?.revision, 0, 'the CAS is based on the run checkpoint')

  const stored = batches[0]?.checkpointAfter?.value ?? null
  const second = await factory.run(runCtx(config.value, commit, { value: stored, revision: 1 }))
  assert.equal(second.ok, true)
  assert.equal(batches.length, 1, 'an unchanged snapshot commits nothing')
})

test('run: a missing directory is a classified, non-fatal unavailable failure', async () => {
  const config = validateConfig({ directory: join(tmpdir(), `quno-cal-missing-${String(Date.now())}`) })
  assert.ok(config.ok)
  const outcome = await factory.run(runCtx(config.value, async () => assert.fail('nothing to commit')))
  assert.equal(outcome.ok, false)
  assert.ok(!outcome.ok)
  assert.equal(outcome.failure.state, 'unavailable')
  assert.equal(outcome.failure.code, 'path-missing')
  assert.equal(outcome.failure.fatal, undefined, 'a missing path backs off; it does not stop scheduling')
})

test('run: Host refusals are read structurally — fencing is fatal, a transient refusal backs off', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quno-cal-refusal-'))
  writeFileSync(join(directory, 'work.ics'), icsAt('in-window-2', 86_400_000))
  const config = validateConfig({ directory })
  assert.ok(config.ok)

  const fenced = await factory.run(runCtx(config.value, async () => { throw refusal('stale-generation', false) }))
  assert.ok(!fenced.ok)
  assert.equal(fenced.failure.fatal, true, 'a fenced run can never succeed by retrying')
  assert.equal(fenced.failure.code, 'stale-generation')

  const transient = await factory.run(runCtx(config.value, async () => { throw refusal('temporarily-unavailable', true) }))
  assert.ok(!transient.ok)
  assert.equal(transient.failure.fatal, undefined)
  assert.equal(transient.failure.state, 'unavailable')
  assert.equal(transient.failure.code, 'temporarily-unavailable', 'the Host code is reported as-is, not as read-failed')
})

test('ingressRefusalOf: only a QunoIngressError-shaped error is a refusal', () => {
  assert.deepEqual(ingressRefusalOf(refusal('checkpoint-conflict', true)), { code: 'checkpoint-conflict', message: 'refused: checkpoint-conflict', retryable: true })
  assert.equal(ingressRefusalOf(Object.assign(new Error('nope'), { code: 'ENOENT' })), null, 'a filesystem code is not a Host refusal')
  assert.equal(ingressRefusalOf({ name: 'QunoIngressError', shape: { code: 'x' } }), null, 'a plain object is not an Error')
})
