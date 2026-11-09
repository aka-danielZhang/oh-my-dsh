/**
 * The turn binding is a pure Definition: a delivered notice message folds into
 * one hidden Chat node carrying its notification id, and nothing else matches.
 * These assertions are the evidence behind "the report card belongs to its own
 * Turn" — the slot component only reads what this Definition published.
 *
 * @module dsh-quno/tests/report-turn
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qunoNoticeDefinition } from '../src/client/report-turn.ts'

const notice = (source: Record<string, unknown> | undefined) => ({
  type: 'user/message',
  seq: 12,
  time: 1_790_000_000_000,
  data: { id: 'msg_1', content: [], ...(source === undefined ? {} : { source }) },
})

const location = { kind: 'turn', turn: { turn: 3 } }

function startOf(event: ReturnType<typeof notice>) {
  const match = qunoNoticeDefinition.match(event as never)
  assert.notEqual(match, null)
  return {
    event,
    role: 'start' as const,
    location,
  }
}

test('a quno report message is matched by its durable notification id', () => {
  assert.deepEqual(
    qunoNoticeDefinition.match(notice({
      kind: 'quno-notify',
      notificationId: 'ntf_1',
      topicKey: 'calendar/review',
    }) as never),
    { id: 'ntf_1', role: 'start', exclusive: true },
  )
  assert.deepEqual(
    qunoNoticeDefinition.match(notice({
      kind: 'quno-task',
      notificationId: 'ntf_2',
      taskId: 'task_2',
    }) as never),
    { id: 'ntf_2', role: 'start', exclusive: true },
  )
})

test('ordinary messages, other events and incomplete sources never match', () => {
  assert.equal(qunoNoticeDefinition.match(notice(undefined) as never), null)
  assert.equal(qunoNoticeDefinition.match(notice({ kind: 'quno-notify' }) as never), null)
  assert.equal(qunoNoticeDefinition.match(notice({ kind: 'quno-notify', notificationId: '' }) as never), null)
  assert.equal(qunoNoticeDefinition.match(notice({ kind: 'other', notificationId: 'x' }) as never), null)
  assert.equal(qunoNoticeDefinition.match({ type: 'assistant/message', seq: 13, time: 0, data: {} } as never), null)
})

test('the folded state keeps the business identity and the owning Turn', () => {
  const event = notice({ kind: 'quno-task', notificationId: 'ntf_2', taskId: 'task_2' })
  const match = startOf(event)
  const state = qunoNoticeDefinition.start({ key: 'k', kind: 'quno-notice', id: 'ntf_2', matches: [match], start: match, state: undefined, current: new Map() } as never, match as never, {} as never)
  assert.equal(state.notificationId, 'ntf_2')
  assert.equal(state.kind, 'task')
  assert.equal(state.taskId, 'task_2')
  assert.equal(state.turn, 3)
})

test('the published node is hidden and belongs to the Turn, never to the visible flow', () => {
  const event = notice({ kind: 'quno-notify', notificationId: 'ntf_1' })
  const match = startOf(event)
  const state = qunoNoticeDefinition.start({ key: 'k', kind: 'quno-notice', id: 'ntf_1', matches: [match], start: match, state: undefined, current: new Map() } as never, match as never, {} as never)
  const buildViewNode = qunoNoticeDefinition.buildViewNode
  assert.notEqual(buildViewNode, undefined)
  if (buildViewNode === undefined) return
  const node = buildViewNode({
    key: 'quno-notice:ntf_1',
    kind: 'quno-notice',
    id: 'ntf_1',
    matches: [match],
    start: match,
    state,
    current: new Map(),
  } as never) as { kind?: string; target?: string; visibility?: string; groupTree?: string; data?: unknown } | null
  assert.notEqual(node, null)
  assert.equal(node?.kind, 'quno-notice')
  assert.equal(node?.target, 'chat')
  assert.equal(node?.visibility, 'hidden')
  assert.equal(node?.groupTree, 'turn')
  assert.deepEqual(node?.data, { notificationId: 'ntf_1', kind: 'notify' })
  // A node that has not started yet publishes nothing (never a flash card).
  assert.equal(buildViewNode({
    key: 'k', kind: 'quno-notice', id: 'ntf_1', matches: [], start: undefined, state: undefined, current: new Map(),
  } as never), null)
})
