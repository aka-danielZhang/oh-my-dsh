/**
 * Real AgentLoop test of the Eval turn: the permanent conversation receives a
 * program-owned candidate, the model reads it with `quno_eval`, submits a
 * decision, and a memory write is refused by the turn guard.
 *
 * @module dsh-quno/tests/eval-agent
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyQunoPreset } from '../src/preset.ts'
import type { EvalCandidateView } from '../src/host-face.ts'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('script exhausted')
    for (const chunk of next) yield chunk
  }
}

function toolChunks(name: string, args: unknown, callId: string): StreamChunk[] {
  const text = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name, argumentsDelta: text },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(callId), name, arguments: text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const CANDIDATE: EvalCandidateView = {
  evalId: 'eval_1',
  threadId: 'thr_1',
  threadLabel: '项目群',
  strength: 'explicit',
  policyVersion: 'v1',
  acceptMode: 'auto',
  status: 'waiting-decision',
  triggers: [{
    triggerId: 'evt_1',
    type: 'im.message.created',
    human: true,
    addressed: 'mention',
    summary: '用户点名要求整理需求',
    occurredAt: 1,
    actor: { source: 'im', id: 'u1' },
    channel: { source: 'im', thread: 'thr_1' },
  }],
  tickets: [],
}

test('an eval turn reads the candidate and submits a decision through the preset tools', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter([
    toolChunks('memory_remember', { content: 'source-driven memory write' }, 'mem-1'),
    toolChunks('quno_eval', {}, 'eval-1'),
    toolChunks('quno_eval_decide', { kind: 'accept', title: '整理需求', goal: '读完上下文' }, 'decide-1'),
    textChunks('已交给后台处理，好了告诉你。'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const decisions: { evalId: string; kind: string; title?: string }[] = []
  const reads: (string | undefined)[] = []
  ctx.provide('quno', {
    evalCandidate: (evalId?: string) => {
      reads.push(evalId)
      return CANDIDATE
    },
    evalRead: () => ({ found: true }),
    evalDecide: async (input: { evalId: string; kind: string; title?: string }) => {
      decisions.push({ evalId: input.evalId, kind: input.kind, ...(input.title === undefined ? {} : { title: input.title }) })
      return {
        evalId: input.evalId,
        kind: input.kind,
        downgraded: false,
        ticketId: 'ticket_eval_1',
        message: '已受理',
      }
    },
  } as never)
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Global memory fixture from another plugin.',
    parameters: { content: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: 'stored' }],
    },
    async execute() { return { ok: true } },
  }))
  const handle = await ctx.agents.create({
    sessionId: 'quno-main-eval' as SessionId,
    meta: { cwd: '/tmp', agentPreset: 'quno' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: (agentCtx) => {
      agentCtx.tools.presentAs('native')
      applyQunoPreset(agentCtx)
    },
  })
  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '【Quno 评估候选】项目群有 1 条来源事件。' }],
      source: {
        kind: 'quno-eval',
        form: 'relay',
        summary: '评估 1 条来源事件',
        evalId: 'eval_1',
        threadId: 'thr_1',
      },
    }))
    await handle.agent.whenIdle()

    const results = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result')
      .map(event => (event.data as { message?: { content?: readonly { type?: string; text?: string }[] } }).message?.content ?? [])
      .flat()
    const memoryResult = results.find(block => block.type === 'text' && block.text?.includes('自动回合不能写入长期记忆'))
    assert.ok(memoryResult, 'a memory write is refused during an automatic turn')

    assert.deepEqual(reads, ['eval_1'], 'the candidate is resolved from the current turn source')
    assert.deepEqual(decisions, [{ evalId: 'eval_1', kind: 'accept', title: '整理需求' }])
    assert.equal(adapter.requests.length, 4)

  } finally {
    await handle.dispose()
    await ctx.fiber.dispose()
  }
})
