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
  sensePageState,
  senseRowKey,
  senseRowState,
  senseRowTone,
  taskSections,
  taskStatusKey,
  type SensePageInput,
} from '../src/client/panel-state.ts'

const emptyPage: SensePageInput = {
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
  assert.deepEqual(empty.needsAction, [])
  assert.deepEqual(empty.running, [])
  assert.deepEqual(empty.settled, [])

  const tasks = [
    { id: 'a', status: 'failed' },
    { id: 'b', status: 'interrupted' },
    { id: 'c', status: 'running' },
    { id: 'd', status: 'cancelled' },
    { id: 'e', status: 'done' },
  ]
  const groups = groupTasks(tasks)
  assert.deepEqual(groups.needsAction.map(task => task.id), ['a', 'b'])
  assert.deepEqual(groups.running.map(task => task.id), ['c'])
  assert.deepEqual(groups.settled.map(task => task.id), ['d', 'e'])
  assert.equal(groups.settled.length, 2)
})

test('a cancelled task is settled, never "needs action"', () => {
  const groups = groupTasks([{ status: 'cancelled' }])
  assert.equal(groups.needsAction.length, 0)
  assert.equal(groups.settled.length, 1)
})

test('the dynamic page separates "no Sense" from "no events"', () => {
  // Nothing registered at all: the install guide, not an empty feed.
  assert.equal(sensePageState(emptyPage), 'install-guide')
  // Types exist but no instance yet: first connect.
  assert.equal(sensePageState({ ...emptyPage, typeCount: 2 }), 'first-connect')
  // Instances exist but no events: an empty feed, still not the install guide.
  assert.equal(sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 1 }), 'empty')
  // Events exist: list.
  assert.equal(sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventCount: 3 }), 'list')
})

test('first sync never reads as "nothing new"', () => {
  assert.equal(
    sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, awaitingFirstSync: 1 }),
    'syncing',
  )
})

test('all sources paused is its own page state', () => {
  assert.equal(
    sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 0, eventCount: 0 }),
    'all-paused',
  )
})

test('an unloaded state is loading; a failed first load is not an empty install', () => {
  assert.equal(sensePageState({ ...emptyPage, phase: 'idle', hasState: false }), 'loading')
  assert.equal(sensePageState({ ...emptyPage, phase: 'loading', hasState: false }), 'loading')
  assert.equal(sensePageState({ ...emptyPage, phase: 'error', hasState: false }), 'load-failed')
})

test('a loaded state stays on the list when a refresh fails', () => {
  assert.equal(
    sensePageState({ ...emptyPage, phase: 'error', instanceCount: 1, enabledCount: 1, eventCount: 2 }),
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

test('the sense row shows one state in the documented priority', () => {
  const base = { desiredState: 'enabled', lifecycle: 'running', health: 'healthy', stale: false, lastSuccessAt: 1 }
  assert.equal(senseRowState(base), 'ok')
  assert.equal(senseRowState({ ...base, stale: true }), 'stale')
  assert.equal(senseRowState({ ...base, lastSuccessAt: null }), 'syncing')
  assert.equal(senseRowState({ ...base, lifecycle: 'starting' }), 'starting')
  assert.equal(senseRowState({ ...base, desiredState: 'paused' }), 'paused')
  assert.equal(senseRowState({ ...base, desiredState: 'disabled' }), 'disabled')
  // An auth failure outranks a paused/disabled intent and staleness.
  assert.equal(senseRowState({ ...base, desiredState: 'paused', health: 'auth-required', stale: true }), 'auth-required')
  assert.equal(senseRowState({ ...base, health: 'rate-limited', stale: true }), 'rate-limited')
  assert.equal(senseRowKey('syncing'), 'panelSenseSyncing')
  assert.equal(senseRowTone('auth-required'), 'error')
  assert.equal(senseRowTone('stale'), 'warn')
  assert.equal(senseRowTone('ok'), 'ok')
})

test('task sections follow the status table and hide empty sections', () => {
  const base = {
    status: 'running',
    plan: null as string | null,
    prompt: 'do it' as string | null,
    result: null as string | null,
    resultDigest: null as string | null,
    artifacts: [] as readonly unknown[],
    childSessionId: null as string | null,
    error: null as unknown,
  }

  const running = taskSections({ ...base, plan: '1. read' })
  assert.equal(running.plan, true)
  assert.equal(running.prompt, true)
  assert.equal(running.result, false)
  assert.equal(running.cancel, true)
  assert.equal(running.resume, false)

  // A running task without a plan renders no plan heading at all.
  assert.equal(taskSections(base).plan, false)

  const done = taskSections({ ...base, status: 'done', result: 'ok', childSessionId: 'child-1' })
  assert.equal(done.result, true)
  assert.equal(done.child, true)
  assert.equal(done.plan, false)
  assert.equal(done.cancel, false)
  assert.equal(done.artifacts, false, 'no artifacts means no artifacts section')

  const doneWithArtifact = taskSections({
    ...base,
    status: 'done',
    result: 'ok',
    artifacts: [{ kind: 'file', label: 'a', uri: 'file:///a' }],
  })
  assert.equal(doneWithArtifact.artifacts, true)

  const failed = taskSections({ ...base, status: 'failed', error: { code: 'x', message: 'y' } })
  assert.equal(failed.error, true)
  assert.equal(failed.resume, true)
  assert.equal(failed.cancel, true)

  const interrupted = taskSections({ ...base, status: 'interrupted', error: { code: 'x', message: 'y' } })
  assert.equal(interrupted.error, true)
  assert.equal(interrupted.resume, true)

  const cancelled = taskSections({ ...base, status: 'cancelled', childSessionId: 'child-1' })
  assert.equal(cancelled.cancelledNote, true)
  assert.equal(cancelled.prompt, true)
  assert.equal(cancelled.child, true)
  assert.equal(cancelled.cancel, false)
})

test('status keys are localised and never leak the raw enum', () => {
  assert.equal(taskStatusKey('done'), 'taskStatusDone')
  assert.equal(taskStatusKey('weird'), 'statusUnknown')
  assert.equal(attentionStatusKey('snoozed'), 'statusSnoozed')
  assert.equal(attentionStatusKey('weird'), 'statusUnknown')
})

test('an unread events list is never reported as "nothing new"', () => {
  assert.equal(
    sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventsStatus: 'loading' }),
    'list',
  )
  assert.equal(
    sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventsStatus: 'error' }),
    'list',
  )
  assert.equal(
    sensePageState({ ...emptyPage, instanceCount: 1, enabledCount: 1, eventsStatus: 'ready' }),
    'empty',
  )
})

test('readable originals require a declared capability on the owning type', () => {
  const state = {
    sources: [{ id: 'src-1', type: 'feed' }, { id: 'src-2', type: 'screen' }],
    senseTypes: [
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
