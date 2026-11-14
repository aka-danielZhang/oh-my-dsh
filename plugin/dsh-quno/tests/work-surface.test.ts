import assert from 'node:assert/strict'
import { test } from 'node:test'
import { zh } from '../src/client/locales.ts'
import { workEntryCounts, workEntryAriaLabel } from '../src/client/work-model.ts'
import { workerRowActivity, type TaskSectionTask } from '../src/client/work-model.ts'
import { selectWorkerComposer } from '../src/client/work-model.ts'
import {
  createWorkNavigation,
  decodeReturnContext,
  encodeReturnContext,
  isKeyboardActivation,
  consumeEntryFocus,
  workerOpenFailure,
  type ReturnContext,
  type ReturnStorage,
  type WorkNavigationFaces,
} from '../src/client/work-navigation.ts'
import { EXECUTOR_SESSION_PREFIX, executorTicketIdOf } from '../src/presentation.ts'
import type { QunoLocaleKey } from '../src/client/locales.ts'

/** Locale stub: the raw zh dictionary (format interpolation included). */
const t = (key: QunoLocaleKey, params?: Record<string, string | number>): string => {
  const template: string = zh[key]
  if (params === undefined) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

test('work entry counts: one badge, needs-you included', () => {
  assert.deepEqual(workEntryCounts(null), { needsYou: 0, active: 0 })
  const tasks = [
    { status: 'running', presentationStatus: 'running' },
    { status: 'running', presentationStatus: 'accepted' },
    { status: 'interrupted', presentationStatus: 'needs-you' },
    { status: 'done', presentationStatus: 'done' },
  ]
  const counts = workEntryCounts(tasks)
  assert.equal(counts.needsYou, 1)
  // activeCount INCLUDES needs-you: "2 项需要你" must never read as 2+2=4.
  assert.equal(counts.active, 3)
  assert.equal(
    workEntryAriaLabel({ needsYou: 2, active: 3 }, t),
    '查看工作，2 项需要你处理',
  )
  assert.equal(workEntryAriaLabel({ needsYou: 0, active: 3 }, t), '查看工作，3 项进行中')
})

test('worker row activity maps every status onto real facts', () => {
  const row = (over: Partial<TaskSectionTask>): TaskSectionTask => ({
    id: 'ticket-1',
    title: '读备忘',
    status: over.presentationStatus ?? 'running',
    error: null,
    settledAt: null,
    ...over,
  })
  // accepted states the resource wait, never a fake "working".
  assert.equal(workerRowActivity(row({ presentationStatus: 'accepted' }), t), t('taskActivityAccepted'))
  // running uses the declared activity kind, falling back to 正在处理.
  assert.equal(workerRowActivity(row({ presentationStatus: 'running', activityKind: 'read-file' }), t), t('taskActivityReadFile'))
  assert.equal(workerRowActivity(row({ presentationStatus: 'running' }), t), t('taskActivityWorking'))
  // needs-you surfaces the recorded question.
  assert.equal(workerRowActivity(row({ presentationStatus: 'needs-you', question: { question: '要哪个群？' } }), t), '要哪个群？')
  assert.equal(workerRowActivity(row({ presentationStatus: 'needs-you' }), t), t('taskActivityWaitingUser'))
  // failed shows the reason; done/cancelled show the recorded time.
  assert.equal(workerRowActivity(row({ presentationStatus: 'failed', error: { message: '登录态失效。' } }), t), '登录态失效。')
  const settled = workerRowActivity(row({ presentationStatus: 'done', settledAt: 1_700_000_000_000 }), t)
  assert.ok(settled !== null && settled.includes(t('taskLastActive')))
  // waiting without an activity fact still states the wait.
  assert.equal(workerRowActivity(row({ presentationStatus: 'waiting' }), t), t('taskActivityWaitingEvent'))
})

test('the composer elect claims exactly the executor sessions', () => {
  assert.deepEqual(selectWorkerComposer({ sessionId: `${EXECUTOR_SESSION_PREFIX}ticket-9` }), { ticketId: 'ticket-9' })
  assert.equal(selectWorkerComposer({ sessionId: 'some-work-session' }), null)
  assert.equal(selectWorkerComposer({}), null)
  assert.equal(selectWorkerComposer({ sessionId: 42 }), null)
  assert.equal(executorTicketIdOf(`${EXECUTOR_SESSION_PREFIX}abc`), 'abc')
  assert.equal(executorTicketIdOf('main'), null)
})

test('return context survives a storage roundtrip; garbage decodes to null', () => {
  const context: ReturnContext = {
    mainSessionId: 'quno-main',
    workPanelOpen: true,
    scrollY: 480,
    entry: 'worker-list',
    keyboard: true,
  }
  assert.deepEqual(decodeReturnContext(encodeReturnContext(context)), context)
  assert.equal(decodeReturnContext(null), null)
  assert.equal(decodeReturnContext('not json'), null)
  assert.equal(decodeReturnContext(JSON.stringify({ workPanelOpen: true })), null)
  assert.equal(isKeyboardActivation({ detail: 0 }), true)
  assert.equal(isKeyboardActivation({ detail: 1 }), false)
  assert.equal(isKeyboardActivation({}), true)
})

test('workerOpenFailure maps every host answer onto an honest reason', () => {
  assert.equal(workerOpenFailure(null, 't1'), 'detail-failed')
  assert.equal(workerOpenFailure({ ok: false }, 't1'), 'detail-failed')
  assert.equal(workerOpenFailure({ ok: true, value: { ticketId: 'other', executorSessionId: 's' } }, 't1'), 'unknown-ticket')
  assert.equal(workerOpenFailure({ ok: true, value: { ticketId: 't1', executorSessionId: null } }, 't1'), 'session-not-assigned')
  assert.equal(workerOpenFailure({ ok: true, value: { ticketId: 't1', executorSessionId: 's' } }, 't1'), null)
})

/** Recording stub of the navigation faces; assertions read `state` live. */
function recordingFaces(mainSessionId: string | null): {
  faces: WorkNavigationFaces
  state: { opened: string[]; panelOpens: number; mainPanelSelects: number; scrollRestores: number[]; focusedEntry: number }
} {
  const state = { opened: [] as string[], panelOpens: 0, mainPanelSelects: 0, scrollRestores: [] as number[], focusedEntry: 0 }
  const faces: WorkNavigationFaces = {
    openSession: sessionId => { state.opened.push(sessionId) },
    selectMainPanel: () => { state.mainPanelSelects += 1 },
    openWorkPanel: () => { state.panelOpens += 1 },
    workPanelVisible: () => true,
    readMainScroll: () => 321,
    restoreMainScroll: y => { state.scrollRestores.push(y) },
    focusWorkEntry: () => { state.focusedEntry += 1 },
    fallbackMainSessionId: () => mainSessionId,
  }
  return { faces, state }
}

/** In-memory sessionStorage stub. */
function memoryStorage(): ReturnStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
  }
}

test('backToQuno restores the stored context; a lost context falls back to the main session', () => {
  const storage = memoryStorage()
  const record = recordingFaces('quno-main-fallback')
  const navigation = createWorkNavigation(record.faces, storage)
  navigation.enterWorker({
    mainSessionId: 'quno-main',
    workPanelOpen: true,
    scrollY: 128,
    entry: 'work-button',
    keyboard: true,
  })
  const result = navigation.backToQuno()
  assert.equal(result.restored, true)
  assert.equal(result.mainSessionId, 'quno-main')
  assert.deepEqual(record.state.opened, ['quno-main'])
  assert.equal(record.state.panelOpens, 1)
  assert.deepEqual(record.state.scrollRestores, [128])
  assert.equal(record.state.focusedEntry, 1, 'keyboard return refocuses the work entry')

  // Storage wiped: the fallback snapshot id still brings the user home.
  storage.map.clear()
  const degraded = navigation.backToQuno()
  assert.equal(degraded.restored, false)
  assert.equal(degraded.mainSessionId, 'quno-main-fallback')
  assert.deepEqual(record.state.opened, ['quno-main', 'quno-main-fallback'])

  // No fallback either: report the dead end instead of navigating blind.
  const emptyRecord = recordingFaces(null)
  const emptyNavigation = createWorkNavigation(emptyRecord.faces, memoryStorage())
  assert.deepEqual(emptyNavigation.backToQuno(), { restored: false, keyboard: false, mainSessionId: null })
  assert.deepEqual(emptyRecord.state.opened, [])
})

test('the entry-focus flag is one-shot and consumed on read', () => {
  const storage = memoryStorage()
  assert.equal(consumeEntryFocus(storage), false)
  storage.setItem('dsh-quno/worker-focus', '1')
  assert.equal(consumeEntryFocus(storage), true)
  assert.equal(consumeEntryFocus(storage), false, 'second mount must not steal focus again')
})

test('returnToMainFromPanel leaves a missing page without navigation state', () => {
  const record = recordingFaces('quno-main')
  const navigation = createWorkNavigation(record.faces, memoryStorage())
  navigation.returnToMainFromPanel(true)
  assert.deepEqual(record.state.opened, ['quno-main'])
  assert.equal(record.state.mainPanelSelects, 1)
  assert.equal(record.state.focusedEntry, 1)
  // Mouse returns never steal focus (v2 §6.3).
  navigation.returnToMainFromPanel(false)
  assert.equal(record.state.focusedEntry, 1)
})
