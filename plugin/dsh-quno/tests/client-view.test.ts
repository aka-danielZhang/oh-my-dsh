import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  capsuleItems,
  capsuleSummaries,
  capsuleTotal,
  capsuleVisibility,
  eventLine,
  hasCapsuleContent,
  isCapsuleVisible,
  mainPresence,
  panelCounts,
  qunoWorkspaceSessionVisible,
  surfaceEnabled,
  type CapsuleVisibilityInput,
  type StateSlice,
} from '../src/client/view-model.ts'
import { narrowPanelParams } from '../src/client/right-tab.ts'

const slice: StateSlice = {
  quno: { mainSessionId: 'main-1', mutedUntil: null },
  main: { sessionId: 'main-1', state: 'ok' },
  collectors: [
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
  assert.deepEqual(panelCounts(slice), { runningTasks: 2, attentionOpen: 2, collectorAlarms: 1 })
})

test('capsuleVisibility names one reason per state', () => {
  const base: CapsuleVisibilityInput = {
    preset: 'quno',
    hasFace: true,
    hasContent: true,
    hasAnchor: true,
    panelVisible: false,
    navigationHidden: false,
    open: false,
  }
  assert.equal(capsuleVisibility(base), 'visible-collapsed')
  assert.equal(capsuleVisibility({ ...base, open: true }), 'visible-flyout')
  // A pending projection keeps the pill off instead of flashing it.
  assert.equal(capsuleVisibility({ ...base, preset: undefined }), 'hidden-not-quno')
  assert.equal(capsuleVisibility({ ...base, preset: null }), 'hidden-not-quno')
  assert.equal(capsuleVisibility({ ...base, preset: 'default' }), 'hidden-not-quno')
  assert.equal(capsuleVisibility({ ...base, hasFace: false }), 'hidden-no-face')
  assert.equal(capsuleVisibility({ ...base, hasContent: false }), 'hidden-no-content')
  assert.equal(capsuleVisibility({ ...base, hasAnchor: false }), 'hidden-no-anchor')
  // The panel takeover outranks the just-clicked navigation state.
  assert.equal(capsuleVisibility({ ...base, panelVisible: true }), 'hidden-right-panel')
  assert.equal(capsuleVisibility({ ...base, navigationHidden: true }), 'hidden-navigation')
  assert.equal(capsuleVisibility({ ...base, panelVisible: true, navigationHidden: true }), 'hidden-right-panel')

  assert.equal(isCapsuleVisible('visible-collapsed'), true)
  assert.equal(isCapsuleVisible('visible-flyout'), true)
  for (const hidden of ['hidden-not-quno', 'hidden-no-face', 'hidden-no-content', 'hidden-no-anchor', 'hidden-right-panel', 'hidden-navigation'] as const) {
    assert.equal(isCapsuleVisible(hidden), false, hidden)
  }
})

test('capsuleSummaries names one real record per non-zero category', () => {
  const rows = capsuleSummaries({
    tasks: [{ status: 'running', title: '整理评审材料' }, { status: 'done', title: '旧任务' }],
    attention: [{ status: 'open', title: '明日评审改期确认' }, { status: 'resolved', title: '已处理' }],
    collectors: [
      { desiredState: 'enabled', health: 'auth-required', stale: false, label: '', type: 'yzj' },
      { desiredState: 'paused', health: 'degraded', stale: true, label: '订阅源', type: 'feed' },
    ],
    collectorTypes: [{ type: 'yzj', displayName: '云之家群聊' }],
  })
  assert.deepEqual(rows.map(row => [row.kind, row.count, row.subject]), [
    ['tasks', 1, '整理评审材料'],
    ['attention', 1, '明日评审改期确认'],
    ['activity', 1, '云之家群聊'],
  ])
})

test('capsuleSummaries drops empty categories and keeps the fixed order', () => {
  const rows = capsuleSummaries({
    tasks: [],
    attention: [{ status: 'snoozed', title: '等待回复' }],
    collectors: [{ desiredState: 'disabled', health: 'unavailable', stale: false, label: '停用的源', type: 'feed' }],
    collectorTypes: [],
  })
  assert.deepEqual(rows.map(row => row.kind), ['attention'])
})

test('the compact pill counts exactly the non-zero categories', () => {
  assert.equal(capsuleTotal({ runningTasks: 2, attentionOpen: 4, collectorAlarms: 1 }), 7)
  assert.equal(capsuleTotal({ runningTasks: 0, attentionOpen: 0, collectorAlarms: 0 }), 0)
})

test('narrowPanelParams accepts only the declared shapes', () => {
  assert.deepEqual(narrowPanelParams({ taskId: 't1', view: 'task' }), { taskId: 't1', view: 'task' })
  assert.deepEqual(narrowPanelParams({ view: 'collectors' }), { view: 'collectors' })
  assert.deepEqual(narrowPanelParams({ taskId: '' }), undefined)
  assert.deepEqual(narrowPanelParams({ view: 'nope' }), undefined)
  assert.deepEqual(narrowPanelParams('x'), undefined)
  assert.deepEqual(narrowPanelParams(undefined), undefined)
  // The typed face of the right-tab module shares the same narrowing.
  assert.deepEqual(narrowPanelParams({ taskId: 't2' }), { taskId: 't2' })
  // A Collector focus is a first-class navigation target, and junk is dropped.
  assert.deepEqual(narrowPanelParams({ collectorId: 'collectors-1', view: 'collectors' }), { collectorId: 'collectors-1', view: 'collectors' })
  assert.deepEqual(narrowPanelParams({ collectorId: '' }), undefined)
  assert.deepEqual(narrowPanelParams({ collectorId: 42 }), undefined)
  assert.deepEqual(narrowPanelParams({ collectorId: 's1', taskId: 't1' }), { taskId: 't1', collectorId: 's1' })
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

test('Quno hides only its main preset from Workspace browsing views', () => {
  assert.equal(qunoWorkspaceSessionVisible({ projectionValues: { agentPreset: 'quno' } }), false)
  assert.equal(qunoWorkspaceSessionVisible({ projectionValues: { agentPreset: 'default' } }), true)
  assert.equal(qunoWorkspaceSessionVisible({ projectionValues: { agentPreset: null } }), true)
  assert.equal(qunoWorkspaceSessionVisible({}), true)
})

test('the capsule lists only non-zero counts', () => {
  assert.deepEqual(capsuleItems({ runningTasks: 0, attentionOpen: 0, collectorAlarms: 0 }), [])
  assert.equal(hasCapsuleContent({ runningTasks: 0, attentionOpen: 0, collectorAlarms: 0 }), false)
  assert.deepEqual(
    capsuleItems({ runningTasks: 2, attentionOpen: 0, collectorAlarms: 0 }),
    [{ kind: 'tasks', count: 2 }],
  )
  assert.deepEqual(
    capsuleItems({ runningTasks: 0, attentionOpen: 3, collectorAlarms: 1 }),
    [{ kind: 'attention', count: 3 }, { kind: 'activity', count: 1 }],
  )
})
