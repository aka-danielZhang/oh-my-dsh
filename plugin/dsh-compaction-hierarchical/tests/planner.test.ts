import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ToolCallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import {
  estimateMessages,
  OversizedCompactionUnitError,
  planMessageChunks,
  splitMessageChunk,
  toolBalancedUnits,
} from '../src/planner.ts'

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function priced(messages: readonly Message[], prices: readonly number[]) {
  const byId = new Map(messages.map((message, index) => [message.id, prices[index] ?? 0]))
  return (message: Message): number => byId.get(message.id) ?? 0
}

test('estimateMessages sums the shared estimator', () => {
  const messages = [user('a'), user('b'), user('c')]
  assert.equal(estimateMessages(messages, priced(messages, [5, 20, 9])), 34)
})

test('planMessageChunks greedily fills the budget in order', () => {
  const messages = [user('a'), user('b'), user('c')]
  const chunks = planMessageChunks(messages, 25, priced(messages, [5, 20, 9]))
  assert.deepEqual(chunks.map(chunk => chunk.map(message => message.id)), [
    [messages[0]?.id, messages[1]?.id],
    [messages[2]?.id],
  ])
})

test('tool calls and their results stay in one indivisible unit', () => {
  const callA = ToolCallId('call-a')
  const callB = ToolCallId('call-b')
  const request = user('run both')
  const assistant = createAssistantMessage({
    content: [
      { type: 'tool-call', id: callA, name: 'read', arguments: '{}' },
      { type: 'tool-call', id: callB, name: 'grep', arguments: '{}' },
    ],
    source: { provider: 'test', model: 'test' },
  })
  const resultA = createToolResultMessage({
    callId: callA,
    content: [{ type: 'text', text: 'a' }],
    isError: false,
  })
  const resultB = createToolResultMessage({
    callId: callB,
    content: [{ type: 'text', text: 'b' }],
    isError: false,
  })
  const after = user('continue')
  const messages = [request, assistant, resultA, resultB, after]
  const units = toolBalancedUnits(messages)
  assert.deepEqual(units.map(unit => unit.map(message => message.id)), [
    [request.id],
    [assistant.id, resultA.id, resultB.id],
    [after.id],
  ])

  const chunks = planMessageChunks(messages, 10, priced(messages, [2, 3, 2, 2, 2]))
  assert.deepEqual(chunks.map(chunk => chunk.map(message => message.id)), [
    [request.id, assistant.id, resultA.id, resultB.id],
    [after.id],
  ])

  const split = splitMessageChunk(messages, priced(messages, [2, 3, 2, 2, 2]))
  assert.ok(split)
  const toolSide = split.find(side => side.some(message => message.id === assistant.id))
  assert.deepEqual(toolSide?.map(message => message.id), [
    assistant.id,
    resultA.id,
    resultB.id,
    after.id,
  ])
})

test('adaptive splitting chooses the closest weighted balanced-unit boundary', () => {
  const messages = [user('a'), user('b'), user('c'), user('d')]
  const split = splitMessageChunk(messages, priced(messages, [8, 7, 2, 1]))
  assert.ok(split)
  assert.deepEqual(split.map(side => side.map(message => message.id)), [
    [messages[0]?.id],
    [messages[1]?.id, messages[2]?.id, messages[3]?.id],
  ])
})

test('adaptive splitting bisects zero-priced units by count and stops at a singleton', () => {
  const messages = [user('a'), user('b'), user('c'), user('d')]
  const split = splitMessageChunk(messages, () => 0)
  assert.ok(split)
  assert.deepEqual(split.map(side => side.map(message => message.id)), [
    [messages[0]?.id, messages[1]?.id],
    [messages[2]?.id, messages[3]?.id],
  ])
  assert.equal(splitMessageChunk([messages[0] as Message], () => 1), null)
})

test('one oversized balanced unit fails instead of crossing the provider limit', () => {
  const message = user('large')
  assert.throws(
    () => planMessageChunks([message], 10, () => 11),
    OversizedCompactionUnitError,
  )
})

test('planner rejects corrupt or unbalanced tool history', () => {
  const call = ToolCallId('missing')
  const orphan = createToolResultMessage({
    callId: call,
    content: [{ type: 'text', text: 'orphan' }],
    isError: false,
  })
  assert.throws(() => toolBalancedUnits([orphan]), /has no call/)

  const open = createAssistantMessage({
    content: [{ type: 'tool-call', id: call, name: 'read', arguments: '{}' }],
    source: { provider: 'test', model: 'test' },
  })
  assert.throws(() => toolBalancedUnits([open]), /unresolved tool call/)
})

test('planner rejects an invalid estimator result', () => {
  const message = user('x')
  assert.throws(() => estimateMessages([message], () => -1), /invalid token count/)
  assert.throws(() => estimateMessages([message], () => 1.5), /invalid token count/)
})
