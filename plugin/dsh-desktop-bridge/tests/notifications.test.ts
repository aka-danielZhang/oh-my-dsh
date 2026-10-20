import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bodyForEdge,
  installNotifications,
  parseNotifyClick,
  shouldNotify,
} from '../src/client/notifications.ts'
import type { DesktopInvoke } from '../src/client/env.ts'

const copy = { turnDone: '回合已完成', awaitInput: '等待你的输入' }

/** One `dsh_desktop_notify` invocation captured off the fake IPC carrier. */
interface NotifyCall {
  cmd: string
  title?: unknown
  body?: unknown
  sessionId?: unknown
}

/** Fake carrier recording every invocation; `on` subscriptions are optional. */
function recordingInvoke(calls: NotifyCall[], listeners = new Map<string, (payload: unknown) => void>()): DesktopInvoke {
  return {
    invoke: async (cmd, args) => {
      calls.push({ cmd, ...(args ?? {}) })
      return undefined
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => { listeners.delete(event) }
    },
  }
}

/** Empty authority stub: no session has a live interaction. */
const emptyPending = {
  getSnapshot: (): ReadonlyMap<string, unknown> => new Map(),
  subscribe: (): (() => void) => () => {},
}

describe('shouldNotify', () => {
  const edge = { sessionId: 'a' }
  it('notifies when the window is hidden', () => {
    assert.equal(shouldNotify(edge, { hidden: true, focused: false, currentSessionId: 'a' }), true)
  })
  it('notifies when the window is visible but unfocused', () => {
    assert.equal(shouldNotify(edge, { hidden: false, focused: false, currentSessionId: 'a' }), true)
  })
  it('notifies a background session while the window is focused', () => {
    assert.equal(shouldNotify(edge, { hidden: false, focused: true, currentSessionId: 'b' }), true)
  })
  it('stays quiet for the focused current session', () => {
    assert.equal(shouldNotify(edge, { hidden: false, focused: true, currentSessionId: 'a' }), false)
  })
})

describe('parseNotifyClick', () => {
  it('reads a non-empty sessionId', () => {
    assert.equal(parseNotifyClick({ sessionId: 's1' }), 's1')
  })
  it('rejects missing or empty ids', () => {
    assert.equal(parseNotifyClick(undefined), undefined)
    assert.equal(parseNotifyClick({}), undefined)
    assert.equal(parseNotifyClick({ sessionId: '' }), undefined)
  })
})

describe('bodyForEdge', () => {
  it('picks copy by kind', () => {
    assert.equal(bodyForEdge('turn-done', copy), '回合已完成')
    assert.equal(bodyForEdge('await-input', copy), '等待你的输入')
  })
})

describe('installNotifications', () => {
  it('sends sessionId and opens that session on click', async () => {
    const calls: NotifyCall[] = []
    const opened: string[] = []
    const listeners = new Map<string, (payload: unknown) => void>()
    let flush = (): void => {}
    const rows = {
      a: { id: 'a', displayTitle: 'Alpha', running: true },
    }
    const list = {
      getSnapshot: () => ({ ids: ['a'] as const, byId: rows, current: 'b' }),
      subscribe: (fn: () => void) => {
        flush = fn
        return () => {}
      },
    }
    let now = 0
    const stop = installNotifications({
      list,
      pending: emptyPending,
      invoke: recordingInvoke(calls, listeners),
      logger: { warn: () => {} },
      copy,
      openSession: (id) => { opened.push(id) },
      surface: () => ({ hidden: true, focused: false }),
      now: () => now,
    })
    now = 2_000
    rows.a = { id: 'a', displayTitle: 'Alpha', running: false }
    flush()
    await Promise.resolve()
    assert.deepEqual(calls, [{ cmd: 'dsh_desktop_notify', title: 'Alpha', body: '回合已完成', sessionId: 'a' }])
    listeners.get('dsh-desktop-notify-click')?.({ sessionId: 'a' })
    assert.deepEqual(opened, ['a'])
    stop()
  })

  it('does not notify a new-session running pulse inside the birth grace', () => {
    const calls: NotifyCall[] = []
    let now = 1_000
    const rows: Record<string, { id: string; displayTitle: string; running: boolean }> = {}
    let ids: string[] = []
    let flush = (): void => {}
    const stop = installNotifications({
      pending: emptyPending,
      list: {
        getSnapshot: () => ({ ids, byId: rows, current: 'a' }),
        subscribe: (fn: () => void) => {
          flush = fn
          return () => {}
        },
      },
      invoke: recordingInvoke(calls),
      logger: { warn: () => {} },
      copy,
      openSession: () => {},
      surface: () => ({ hidden: true, focused: false }),
      now: () => now,
    })
    ids = ['a']
    rows.a = { id: 'a', displayTitle: 'dsh-desktop', running: false }
    flush()
    rows.a = { id: 'a', displayTitle: 'dsh-desktop', running: true }
    now = 1_050
    flush()
    rows.a = { id: 'a', displayTitle: 'dsh-desktop', running: false }
    now = 1_100
    flush()
    assert.equal(calls.length, 0)
    rows.a = { id: 'a', displayTitle: 'dsh-desktop', running: true }
    now = 3_000
    flush()
    rows.a = { id: 'a', displayTitle: 'dsh-desktop', running: false }
    now = 3_050
    flush()
    assert.deepEqual(calls.map((call) => call.sessionId), ['a'])
    stop()
  })

  it('does not notify historical idle sessions when the list hydrates', () => {
    const calls: NotifyCall[] = []
    let ids: string[] = []
    const byId: Record<string, { id: string; displayTitle: string; running: boolean }> = {}
    let flush = (): void => {}
    const stop = installNotifications({
      pending: emptyPending,
      list: {
        getSnapshot: () => ({ ids, byId }),
        subscribe: (fn: () => void) => {
          flush = fn
          return () => {}
        },
      },
      invoke: recordingInvoke(calls),
      logger: { warn: () => {} },
      copy,
      openSession: () => {},
      surface: () => ({ hidden: true, focused: false }),
    })
    ids = ['a', 'b', 'c']
    byId.a = { id: 'a', displayTitle: '830 项目', running: false }
    byId.b = { id: 'b', displayTitle: 'yzj_advance_create', running: false }
    byId.c = { id: 'c', displayTitle: 'yzj_advance_scan', running: false }
    flush()
    assert.deepEqual(calls, [])
    stop()
  })

  it('raises await-input from the pending authority joined with the list', () => {
    const calls: NotifyCall[] = []
    const rows: Record<string, { id: string; displayTitle: string; running: boolean }> = {
      a: { id: 'a', displayTitle: 'Alpha', running: true },
    }
    let listFlush = (): void => {}
    let pendingFlush = (): void => {}
    let pendingMap = new Map<string, unknown>()
    let unsubscribed = false
    const stop = installNotifications({
      list: {
        getSnapshot: () => ({ ids: ['a'] as const, byId: rows, current: 'a' }),
        subscribe: (fn) => {
          listFlush = fn
          return () => {}
        },
      },
      pending: {
        getSnapshot: () => pendingMap,
        subscribe: (fn) => {
          pendingFlush = fn
          return () => { unsubscribed = true }
        },
      },
      invoke: recordingInvoke(calls),
      logger: { warn: () => {} },
      copy,
      openSession: () => {},
      surface: () => ({ hidden: true, focused: false }),
    })
    // The authority gains an interaction while the list row is unchanged.
    pendingMap = new Map([['a', { kind: 'question' }]])
    pendingFlush()
    assert.deepEqual(calls.map((call) => call.body), ['等待你的输入'])
    // Clearing it does not re-notify; the edge is none→present only.
    pendingMap = new Map()
    pendingFlush()
    assert.deepEqual(calls.map((call) => call.body), ['等待你的输入'])
    stop()
    assert.equal(unsubscribed, true)
  })
})
