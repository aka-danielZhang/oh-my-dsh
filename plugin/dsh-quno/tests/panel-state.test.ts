import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  attentionStatusKey,
  creationPhase,
  deliveryAnomaly,
  groupTasks,
  runDurationMs,
  runDurationOf,
  sourceReadsOriginal,
  runStatusKey,
  runStatusKind,
  runTone,
  runTriggerKey,
  collectorPageState,
  collectorRowKey,
  collectorRowState,
  collectorRowTone,
  lifecycleKey,
  taskUserStatus,
  taskUserStatusKey,
  type CollectorPageInput,
} from '../src/client/panel-state.ts'

const emptyPage: CollectorPageInput = {
  phase: 'ready',
  hasState: true,
  instanceCount: 0,
  typeCount: 0,
  enabledCount: 0,
  awaitingFirstSync: 0,
  eventCount: 0,
  eventsStatus: 'ready',
}

test('groupTasks buckets tasks and keeps empty buckets empty', () => {
  const empty = groupTasks([])
  assert.deepEqual(empty.needsYou, [])
  assert.deepEqual(empty.active, [])
  assert.deepEqual(empty.settled, [])

  const tasks = [
    { id: 'a', status: 'running', presentationStatus: 'needs-you' },
    { id: 'b', status: 'interrupted' },
    { id: 'c', status: 'running' },
    { id: 'd', status: 'cancelled' },
    { id: 'e', status: 'done' },
  ]
  const groups = groupTasks(tasks)
  assert.deepEqual(groups.needsYou.map(task => task.id), ['a', 'b'])
  assert.deepEqual(groups.active.map(task => task.id), ['c'])
  assert.deepEqual(groups.settled.map(task => task.id), ['d', 'e'])
  assert.equal(groups.settled.length, 2)
})

test('a cancelled task is settled, never "needs you"', () => {
  const groups = groupTasks([{ status: 'cancelled' }])
  assert.equal(groups.needsYou.length, 0)
  assert.equal(groups.settled.length, 1)
})

test('presentationStatus wins over the legacy status; legacy rows fall back', () => {
  assert.equal(taskUserStatus({ status: 'interrupted', presentationStatus: 'needs-you' }), 'needs-you')
  assert.equal(taskUserStatus({ status: 'running', presentationStatus: 'accepted' }), 'accepted')
  assert.equal(taskUserStatus({ status: 'interrupted' }), 'needs-you')
  assert.equal(taskUserStatus({ status: 'waiting' }), 'waiting')
  assert.equal(taskUserStatus({ status: 'weird' }), 'done')
  assert.equal(taskUserStatusKey('needs-you'), 'taskStatusNeedsYou')
  assert.equal(taskUserStatusKey('accepted'), 'taskStatusAccepted')
  assert.equal(taskUserStatusKey('dropped'), 'taskStatusDropped')
})

test('the dynamic page separates "no Collector" from "no events"', () => {
  // Nothing registered at all: the install guide, not an empty feed.
  assert.equal(collectorPageState(emptyPage), 'install-guide')
  // Types exist but no instance yet: first connect.
  assert.equal(collectorPageState({ ...emptyPage, typeCount: 2 }), 'first-connect')
  // Instances exist but no events: an empty feed, still not the install guide.
  assert.equal(collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 1 }), 'empty')
  // Events exist: list.
  assert.equal(collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventCount: 3 }), 'list')
})

test('first sync never reads as "nothing new"', () => {
  assert.equal(
    collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, awaitingFirstSync: 1 }),
    'syncing',
  )
})

test('all sources paused is its own page state', () => {
  assert.equal(
    collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 0, eventCount: 0 }),
    'all-paused',
  )
})

test('an unloaded state is loading; a failed first load is not an empty install', () => {
  assert.equal(collectorPageState({ ...emptyPage, phase: 'idle', hasState: false }), 'loading')
  assert.equal(collectorPageState({ ...emptyPage, phase: 'loading', hasState: false }), 'loading')
  assert.equal(collectorPageState({ ...emptyPage, phase: 'error', hasState: false }), 'load-failed')
})

test('a loaded state stays on the list when a refresh fails', () => {
  assert.equal(
    collectorPageState({ ...emptyPage, phase: 'error', instanceCount: 1, enabledCount: 1, eventCount: 2 }),
    'list',
  )
})

test('run statuses are normalised before display', () => {
  assert.equal(runStatusKind('claimed'), 'running')
  assert.equal(runStatusKind('running'), 'running')
  assert.equal(runStatusKind('committed'), 'committed')
  assert.equal(runStatusKind('failed'), 'failed')
  assert.equal(runStatusKind('interrupted'), 'interrupted')
  assert.equal(runStatusKind('delivering'), 'running')
  assert.equal(runStatusKind('waiting-decision'), 'running')
  assert.equal(runStatusKind('decided'), 'committed')
  assert.equal(runStatusKind('unavailable'), 'interrupted')
  assert.equal(runStatusKind('ended'), 'committed')
  assert.equal(runStatusKind('who-knows'), 'unknown')

  assert.equal(runStatusKey('committed'), 'runStatusCommitted')
  assert.equal(runStatusKey('claimed'), 'runStatusRunning')
  assert.equal(runStatusKey('who-knows'), 'statusUnknown')
  assert.equal(runTone('failed'), 'error')
  assert.equal(runTone('interrupted'), 'warn')
})

test('run triggers localise when known and fall back otherwise', () => {
  assert.equal(runTriggerKey('user'), 'runTriggerUser')
  assert.equal(runTriggerKey('event'), 'runTriggerEvent')
  assert.equal(runTriggerKey('timer'), 'runTriggerTimer')
  assert.equal(runTriggerKey('schedule'), 'runTriggerSchedule')
  assert.equal(runTriggerKey('cron-ish'), undefined)
})

test('the collectors row shows one state in the documented priority', () => {
  const base = { desiredState: 'enabled', lifecycle: 'running', health: 'healthy', stale: false, lastSuccessAt: 1 }
  assert.equal(collectorRowState(base), 'ok')
  assert.equal(collectorRowState({ ...base, stale: true }), 'stale')
  assert.equal(collectorRowState({ ...base, lastSuccessAt: null }), 'syncing')
  assert.equal(collectorRowState({ ...base, lifecycle: 'starting' }), 'starting')
  assert.equal(collectorRowState({ ...base, desiredState: 'paused' }), 'paused')
  assert.equal(collectorRowState({ ...base, desiredState: 'disabled' }), 'disabled')
  // An auth failure outranks a paused/disabled intent and staleness.
  assert.equal(collectorRowState({ ...base, desiredState: 'paused', health: 'auth-required', stale: true }), 'auth-required')
  assert.equal(collectorRowState({ ...base, health: 'rate-limited', stale: true }), 'rate-limited')
  assert.equal(collectorRowKey('syncing'), 'panelCollectorSyncing')
  assert.equal(collectorRowTone('auth-required'), 'error')
  assert.equal(collectorRowTone('stale'), 'warn')
  assert.equal(collectorRowTone('ok'), 'ok')
})

test('status keys are localised and never leak the raw enum', () => {
  assert.equal(taskUserStatusKey('done'), 'taskStatusDone')
  assert.equal(attentionStatusKey('snoozed'), 'statusSnoozed')
  assert.equal(attentionStatusKey('weird'), 'statusUnknown')
})

test('an unread events list is never reported as "nothing new"', () => {
  assert.equal(
    collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventsStatus: 'loading' }),
    'list',
  )
  assert.equal(
    collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventsStatus: 'error' }),
    'list',
  )
  assert.equal(
    collectorPageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventsStatus: 'ready' }),
    'empty',
  )
})

test('readable originals require a declared capability on the owning type', () => {
  const state = {
    sources: [{ id: 'src-1', type: 'feed' }, { id: 'src-2', type: 'screen' }],
    collectorTypes: [
      { type: 'feed', reliability: { readOriginal: true } },
      { type: 'screen', reliability: null },
    ],
  }
  assert.equal(sourceReadsOriginal(state, 'src-1'), true)
  assert.equal(sourceReadsOriginal(state, 'src-2'), false)
  assert.equal(sourceReadsOriginal(state, 'gone'), false)
  assert.equal(sourceReadsOriginal(state, undefined), false)
})

test('delivery anomalies and run duration are derived, not guessed', () => {
  assert.deepEqual(deliveryAnomaly({ pending: 2 }), { deadLetter: 0, deferred: 0 })
  assert.deepEqual(deliveryAnomaly({ 'dead-letter': 1, deferred: 3 }), { deadLetter: 1, deferred: 3 })
  assert.equal(runDurationMs({ startedAt: 1_000, finishedAt: 4_500 }, 9_000), 3_500)
  assert.equal(runDurationMs({ startedAt: 1_000, finishedAt: null }, 4_000), 3_000)
  assert.equal(runDurationMs({ startedAt: 5_000, finishedAt: 4_000 }, 9_000), 0)
})

test('a new instance reports its real first-sync phase', () => {
  const base = { lifecycle: 'running', health: 'healthy', lastSuccessAt: null }
  assert.equal(creationPhase(base), 'syncing')
  assert.equal(creationPhase({ ...base, lifecycle: 'starting' }), 'starting')
  assert.equal(creationPhase({ ...base, health: 'auth-required' }), 'auth-required')
  assert.equal(creationPhase({ ...base, lifecycle: 'failed' }), 'failed')
  assert.equal(creationPhase({ ...base, lastSuccessAt: 1 }), 'ready')
  // A failed lifecycle outranks an auth health reading: the instance is down.
  assert.equal(creationPhase({ lifecycle: 'failed', health: 'auth-required', lastSuccessAt: null }), 'failed')
})

test('a settled run without a finish time has no duration', () => {
  assert.equal(runDurationOf({ status: 'failed', startedAt: 1_000, finishedAt: null }, 5_000), null)
  assert.equal(runDurationOf({ status: 'running', startedAt: 1_000, finishedAt: null }, 5_000), 4_000)
  assert.equal(runDurationOf({ status: 'committed', startedAt: 1_000, finishedAt: 4_000 }, 5_000), 3_000)
})

test('every runtime lifecycle value has a localized label in both languages (idle included)', async () => {
  const { zh, en } = await import('../src/client/locales.ts')
  // Exhaustive by construction: a new CollectorLifecycle value fails to
  // typecheck here until it gets a label.
  const all: Record<import('../src/types.ts').CollectorLifecycle, true> = {
    idle: true,
    starting: true,
    running: true,
    stopping: true,
    stopped: true,
    failed: true,
  }
  for (const lifecycle of Object.keys(all)) {
    const key = lifecycleKey(lifecycle)
    assert.ok(key !== null, `${lifecycle} has a locale key`)
    assert.ok(zh[key].length > 0 && en[key].length > 0)
    assert.notEqual(zh[key], lifecycle, `${lifecycle} is never shown raw`)
  }
  assert.equal(zh[lifecycleKey('idle') ?? 'lifecycleIdle'], '待下次运行')
  assert.equal(lifecycleKey('from-the-future'), null, 'an unknown value falls back to showing itself')
})
