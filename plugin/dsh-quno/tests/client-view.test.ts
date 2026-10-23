import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  eventLine,
  mainPresence,
  panelCounts,
  shouldShowPill,
  surfaceEnabled,
  type StateSlice,
} from '../src/client/view-model.ts'
import { narrowPanelParams } from '../src/client/right-tab.ts'

const slice: StateSlice = {
  quno: { mainSessionId: 'main-1', mutedUntil: null },
  main: { sessionId: 'main-1', state: 'ok' },
  senses: [
    { desiredState: 'enabled', health: 'healthy', stale: false },
    { desiredState: 'enabled', health: 'degraded', stale: false },
    { desiredState: 'paused', health: 'auth-required', stale: false },
  ],
  attention: [
    { status: 'open' },
    { status: 'snoozed' },
    { status: 'resolved' },
  ],
  tasks: [
    { status: 'running' },
    { status: 'running' },
    { status: 'interrupted' },
    { status: 'done' },
  ],
}

test('mainPresence reflects switch, mute window and binding', () => {
  const now = 1_000
  assert.equal(mainPresence(slice, false, now), 'paused')
  assert.equal(mainPresence(slice, true, now), 'online')
  assert.equal(
    mainPresence({ ...slice, quno: { mainSessionId: 'main-1', mutedUntil: 2_000 } }, true, now),
    'muted',
  )
  assert.equal(
    mainPresence({ ...slice, quno: { mainSessionId: 'main-1', mutedUntil: 500 } }, true, now),
    'online',
    'an expired mute window does not read as muted',
  )
  assert.equal(
    mainPresence({ ...slice, main: { sessionId: null, state: 'unbound' } }, true, now),
    'unbound',
  )
  assert.equal(
    mainPresence({ ...slice, main: { sessionId: 'gone', state: 'missing' } }, true, now),
    'missing',
  )
})

test('panelCounts reads the actionable slices', () => {
  assert.deepEqual(panelCounts(slice), { runningTasks: 2, attentionOpen: 2, senseAlarms: 1 })
})

test('shouldShowPill requires the quno main conversation on screen and the panel collapsed', () => {
  const base = {
    mainSessionId: 'main-1',
    mountedSessionId: 'main-1',
    mountedPreset: 'quno' as const,
    panelExpanded: false,
  }
  assert.equal(shouldShowPill(base), true)
  assert.equal(shouldShowPill({ ...base, panelExpanded: true }), false)
  assert.equal(shouldShowPill({ ...base, mountedSessionId: 'other' }), false)
  assert.equal(shouldShowPill({ ...base, mountedPreset: 'default' }), false)
  // A pending projection keeps the capsule off instead of flashing it.
  assert.equal(shouldShowPill({ ...base, mountedPreset: undefined }), false)
  assert.equal(shouldShowPill({ ...base, mountedPreset: null }), false)
  assert.equal(shouldShowPill({ ...base, mainSessionId: null }), false)
})

test('narrowPanelParams accepts only the declared shapes', () => {
  assert.deepEqual(narrowPanelParams({ taskId: 't1', view: 'task' }), { taskId: 't1', view: 'task' })
  assert.deepEqual(narrowPanelParams({ view: 'sense' }), { view: 'sense' })
  assert.deepEqual(narrowPanelParams({ taskId: '' }), undefined)
  assert.deepEqual(narrowPanelParams({ view: 'nope' }), undefined)
  assert.deepEqual(narrowPanelParams('x'), undefined)
  assert.deepEqual(narrowPanelParams(undefined), undefined)
  // The typed face of the right-tab module shares the same narrowing.
  assert.deepEqual(narrowPanelParams({ taskId: 't2' }), { taskId: 't2' })
})

test('eventLine prefers the summary and falls back to type · operation', () => {
  assert.equal(eventLine({ type: 'a/b', operation: 'upsert', summary: '变了' }), '变了')
  assert.equal(eventLine({ type: 'a/b', operation: 'upsert', summary: null }), 'a/b · upsert')
})

test('surfaceEnabled gates on the master switch and treats absence as off', () => {
  assert.equal(surfaceEnabled({ config: { enabled: true } }), true)
  assert.equal(surfaceEnabled({ config: { enabled: false } }), false)
  assert.equal(surfaceEnabled({ config: {} }), true)
  assert.equal(surfaceEnabled(null), false)
})
