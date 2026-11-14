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

type RunLimits = CollectorRunContext<CalendarConfig>['limits']

/** The Host's real per-batch limits (contracts LIMITS) plus the declared per-run quota. */
const HOST_LIMITS: RunLimits = { maxEventsPerRun: 200, maxBytesPerRun: 8 * 1024 * 1024, maxEventsPerBatch: 100, maxBytesPerBatch: 1024 * 1024 }

function runCtx(
  config: CalendarConfig,
  commit: (batch: IngestBatch) => Promise<IngestAck>,
  checkpoint: { readonly value: string | null; readonly revision: number } = { value: null, revision: 0 },
  limits: Partial<RunLimits> = {},
): CollectorRunContext<CalendarConfig> {
  return {
    instanceId: 'col-cal',
    sourceId: 'src-cal',
    type: 'quno/calendar',
    config,
    runId: 1,
    checkpoint,
    limits: { ...HOST_LIMITS, ...limits },
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

/** A VCALENDAR with several events inside the read window. */
function icsWith(entries: readonly { readonly uid: string; readonly offsetMs: number; readonly description?: string }[]): string {
  const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const body = entries.map((entry) => {
    const start = Date.now() + entry.offsetMs
    return `BEGIN:VEVENT\nUID:${entry.uid}\nSUMMARY:评审 ${entry.uid}\nDTSTART:${stamp(start)}\nDTEND:${stamp(start + 3_600_000)}\nSEQUENCE:0\n${entry.description === undefined ? '' : `DESCRIPTION:${entry.description}\n`}END:VEVENT\n`
  }).join('')
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${body}END:VCALENDAR\n`
}

/** A Host double that records every batch and keeps the checkpoint like the store does. */
function recordingHost(): { readonly batches: IngestBatch[]; commit(batch: IngestBatch): Promise<IngestAck>; checkpoint(): { value: string | null; revision: number } } {
  const batches: IngestBatch[] = []
  return {
    batches,
    commit: async (batch) => {
      batches.push(batch)
      return ack(batch, batches.length)
    },
    checkpoint: () => ({ value: batches.at(-1)?.checkpointAfter?.value ?? null, revision: batches.length }),
  }
}

function committedUids(batches: readonly IngestBatch[]): string[] {
  return batches.flatMap(batch => batch.events.map(event => (event.data as { uid: string }).uid))
}

test('run: a change set beyond the run budget commits a prefix; the rest lands next run — nothing skipped', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quno-cal-budget-'))
  writeFileSync(join(directory, 'work.ics'), icsWith(['e1', 'e2', 'e3', 'e4', 'e5'].map((uid, index) => ({ uid, offsetMs: (index + 1) * 3_600_000 }))))
  const config = validateConfig({ directory })
  assert.ok(config.ok)
  const host = recordingHost()
  const budget = { maxEventsPerRun: 3, maxEventsPerBatch: 2 }

  const first = await factory.run(runCtx(config.value, host.commit, host.checkpoint(), budget))
  assert.ok(first.ok)
  assert.deepEqual(host.batches.map(batch => batch.events.length), [2, 1], 'batches respect the per-batch count')
  assert.ok(first.nextRunAtMs !== undefined && first.nextRunAtMs - Date.now() < 10_000, 'a backlog asks for a prompt continuation')
  assert.equal((first.health?.progress as { pendingChanges?: number } | undefined)?.pendingChanges, 2)
  const afterFirst = JSON.parse(host.checkpoint().value ?? '{}') as { events: Record<string, string> }
  assert.deepEqual(Object.keys(afterFirst.events).sort(), committedUids(host.batches).sort(), 'the snapshot holds exactly the committed changes')

  const second = await factory.run(runCtx(config.value, host.commit, host.checkpoint(), budget))
  assert.ok(second.ok)
  assert.ok(second.nextRunAtMs !== undefined && second.nextRunAtMs - Date.now() > 30_000, 'a drained backlog returns to the interval')
  assert.deepEqual(committedUids(host.batches).sort(), ['e1', 'e2', 'e3', 'e4', 'e5'], 'every change is committed exactly once')

  const third = await factory.run(runCtx(config.value, host.commit, host.checkpoint(), budget))
  assert.ok(third.ok)
  assert.equal(host.batches.length, 3, 'a settled snapshot commits nothing')
})

test('run: a deferred removal keeps its snapshot entry, so the retraction is not lost', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quno-cal-removal-'))
  writeFileSync(join(directory, 'work.ics'), icsWith([]))
  const config = validateConfig({ directory })
  assert.ok(config.ok)
  const host = recordingHost()
  const stored = { value: JSON.stringify({ events: { r1: '0:a', r2: '0:b', r3: '0:c' } }), revision: 0 }

  const first = await factory.run(runCtx(config.value, host.commit, stored, { maxEventsPerRun: 2 }))
  assert.ok(first.ok)
  assert.deepEqual(host.batches[0]?.events.map(event => event.operation), ['retract', 'retract'])
  const remaining = JSON.parse(host.checkpoint().value ?? '{}') as { events: Record<string, string> }
  assert.deepEqual(Object.keys(remaining.events), ['r3'], 'the not-yet-retracted uid stays in the snapshot')

  await factory.run(runCtx(config.value, host.commit, host.checkpoint(), { maxEventsPerRun: 2 }))
  assert.deepEqual(committedUids(host.batches).sort(), ['r1', 'r2', 'r3'])
  assert.deepEqual((JSON.parse(host.checkpoint().value ?? '{}') as { events: Record<string, string> }).events, {})
})

test('run: batches are cut by bytes as well as by count, and stay inside the batch limit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quno-cal-bytes-'))
  const long = '详'.repeat(1500) // ~4.5 KB of UTF-8 per event
  writeFileSync(join(directory, 'work.ics'), icsWith(['b1', 'b2', 'b3', 'b4'].map((uid, index) => ({ uid, offsetMs: (index + 1) * 3_600_000, description: long }))))
  const config = validateConfig({ directory })
  assert.ok(config.ok)
  const host = recordingHost()
  const maxBytesPerBatch = 16 * 1024
  const outcome = await factory.run(runCtx(config.value, host.commit, host.checkpoint(), { maxBytesPerBatch }))
  assert.ok(outcome.ok)
  assert.ok(host.batches.length > 1, 'the byte limit split the change set')
  for (const batch of host.batches) {
    assert.ok(batch.events.length < 100, 'a byte cut, not a count cut')
    assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') <= maxBytesPerBatch, 'each batch fits the Host batch limit')
  }
  assert.deepEqual(committedUids(host.batches).sort(), ['b1', 'b2', 'b3', 'b4'])
})

test('run: a single change larger than any batch is a loud failure, not a silent stall', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'quno-cal-huge-'))
  writeFileSync(join(directory, 'work.ics'), icsWith([{ uid: 'huge', offsetMs: 3_600_000, description: '超'.repeat(1500) }]))
  const config = validateConfig({ directory })
  assert.ok(config.ok)
  const host = recordingHost()
  const outcome = await factory.run(runCtx(config.value, host.commit, host.checkpoint(), { maxBytesPerBatch: 6 * 1024 }))
  assert.ok(!outcome.ok)
  assert.equal(outcome.failure.code, 'batch-too-large')
  assert.equal(host.batches.length, 0)
})
