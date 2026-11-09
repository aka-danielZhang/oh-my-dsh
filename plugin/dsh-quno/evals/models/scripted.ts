/**
 * Scripted turn helpers: the same chunk vocabulary the plugin's own tests use
 * (block-start → deltas → block-end → usage → finish), so scripted cases
 * exercise the real AgentLoop with deterministic model output.
 *
 * @module dsh-quno/evals/models/scripted
 */

import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** One text-only model turn. */
export function textTurn(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One tool-call model turn (the loop executes the tool, then asks again). */
export function toolTurn(name: string, args: unknown, callId: string): StreamChunk[] {
  const text = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: text },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Several tool calls in one turn (arguments share the delta stream). */
export function multiToolTurn(calls: readonly { name: string; args: unknown; id: string }[]): StreamChunk[] {
  const chunks: StreamChunk[] = []
  calls.forEach((call, slot) => {
    const text = JSON.stringify(call.args)
    chunks.push(
      { type: 'block-start', index: slot + 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: slot + 1, id: ToolCallId(call.id), name: call.name, argumentsDelta: text },
      { type: 'block-end', index: slot + 1, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: text } },
    )
  })
  chunks.push(
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  )
  return chunks
}
