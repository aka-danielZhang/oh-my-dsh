/**
 * Live-protocol regression for the eval gateway's OpenAI-compatible mapping
 * (no credentials, no network): the SSE assembler must preserve provider
 * tool-call ids, and a replayed history must keep `tool_calls[].id` paired
 * with the tool results' `toolCallId` — providers reject mismatched pairs.
 *
 * @module dsh-quno/tests/eval-gateway
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SseAssembler, toOpenAiMessages } from '../evals/models/gateway.ts'

const SSE_TOOL_CALL = [
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_provider_42","function":{"name":"read","arguments":""}}]}}]}',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"notes.md\\"}"}}]}}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}',
  'data: [DONE]',
]

test('sse assembler keeps the provider tool-call id across deltas and block-end', () => {
  const assembler = new SseAssembler()
  const chunks = SSE_TOOL_CALL.flatMap(line => assembler.push(line)).concat(assembler.finalize())

  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  assert.ok(delta !== undefined && delta.type === 'tool-call-delta')
  assert.equal(delta.id, ToolCallId('call_provider_42'), 'the delta carries the provider id')

  const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(end !== undefined && end.type === 'block-end' && end.block.type === 'tool-call')
  assert.equal(end.block.id, ToolCallId('call_provider_42'), 'block-end keeps the provider id')
  assert.equal(end.block.name, 'read')
  assert.equal(end.block.arguments, '{"path":"notes.md"}')

  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.ok(finish !== undefined && finish.type === 'finish')
  assert.equal(finish.reason.kind, 'tool-calls')

  const usage = chunks.find(chunk => chunk.type === 'usage')
  assert.ok(usage !== undefined && usage.type === 'usage')
  assert.deepEqual({ input: usage.usage.inputTokens, output: usage.usage.outputTokens }, { input: 10, output: 3 })
})

test('two interleaved tool calls keep distinct provider ids in call order', () => {
  const assembler = new SseAssembler()
  const lines = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"grep","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  ]
  const chunks = lines.flatMap(line => assembler.push(line)).concat(assembler.finalize())
  const ends = chunks.filter((chunk): chunk is Extract<typeof chunk, { type: 'block-end' }> => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.deepEqual(ends.map(block => (block.block as { id: string }).id), [ToolCallId('call_a'), ToolCallId('call_b')], 'block-end follows provider call indexes')
})

test('replayed history maps assistant tool calls and tool results to the same provider id', () => {
  const assistant = {
    role: 'assistant',
    id: 'a1',
    source: { kind: 'model' },
    content: [
      { type: 'text', text: '我来读取文件。' },
      { type: 'tool-call', id: ToolCallId('call_provider_42'), name: 'read', arguments: '{"path":"notes.md"}' },
    ],
  } as never
  const toolResult = {
    role: 'tool',
    id: 't1',
    source: { kind: 'tool', callId: ToolCallId('call_provider_42') },
    toolCallId: ToolCallId('call_provider_42'),
    content: [{ type: 'text', text: '截止日期：2026-11-20' }],
  } as never
  const user = {
    role: 'user',
    id: 'u1',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '帮我读 notes.md' }],
  } as never

  const mapped = toOpenAiMessages({ messages: [user, assistant, toolResult] } as never) as {
    role: string
    content?: string
    tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[]
    tool_call_id?: string
  }[]

  const assistantRow = mapped.find(row => row.role === 'assistant')
  assert.ok(assistantRow !== undefined)
  assert.equal(assistantRow.tool_calls?.[0]?.id, 'call_provider_42', 'assistant keeps the provider id (not call_0)')
  assert.equal(assistantRow.tool_calls?.[0]?.function.name, 'read')
  assert.equal(assistantRow.tool_calls?.[0]?.function.arguments, '{"path":"notes.md"}')
  assert.equal(assistantRow.content, '我来读取文件。')

  const toolRow = mapped.find(row => row.role === 'tool')
  assert.ok(toolRow !== undefined)
  assert.equal(toolRow.tool_call_id, 'call_provider_42', 'the tool result references the SAME id')
  assert.equal(assistantRow.tool_calls?.[0]?.id, toolRow.tool_call_id, 'assistant call and tool result are paired')
})

test('a missing provider id falls back to a stable positional id on both sides', () => {
  const assembler = new SseAssembler()
  const chunks = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"glob","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  ].flatMap(line => assembler.push(line)).concat(assembler.finalize())
  const end = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  assert.ok(end !== undefined && end.type === 'block-end' && end.block.type === 'tool-call')
  assert.match(end.block.id, /^call_\d+$/, 'synthesized ids stay stable for the whole block')

  const mapped = toOpenAiMessages({
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool-call', id: end.block.id, name: end.block.name, arguments: end.block.arguments }],
    }],
  } as never) as { tool_calls?: { id: string }[] }[]
  assert.equal(mapped[0]?.tool_calls?.[0]?.id, end.block.id, 'the synthesized id round-trips unchanged')
})
