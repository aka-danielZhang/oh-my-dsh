import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyQunoPreset } from '../src/preset.ts'
import type { TaskRecord } from '../src/types.ts'

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

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function delegateChunks(): StreamChunk[] {
  const args = JSON.stringify({ title: '调研云之家讨论', prompt: '读取相关群聊并给出有依据的整理。' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('delegate-1'), name: 'quno_task', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('delegate-1'), name: 'quno_task', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function queryChunks(action: 'status' | 'result'): StreamChunk[] {
  const args = JSON.stringify({ action, taskId: 'task-main-1' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(`query-${action}`), name: 'quno_task', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`query-${action}`), name: 'quno_task', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

test('the main agent delegates execution and immediately reports the handoff', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter([
    delegateChunks(),
    textChunks('我已交给后台处理，好了告诉你。'),
    queryChunks('status'),
    textChunks('任务仍在进行。'),
    queryChunks('result'),
    textChunks('关键结论已经回来。'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const started: { title: string; prompt: string; parentId: string }[] = []
  const queries: string[] = []
  const queryStatuses: TaskRecord['status'][] = ['running', 'done']
  ctx.provide('quno', {
    startTask: async (input: { title: string; prompt: string }, parent: { session: { id: string } }) => {
      started.push({ title: input.title, prompt: input.prompt, parentId: parent.session.id })
      const task: TaskRecord = {
        id: 'task-main-1', qunoId: 'quno', childSessionId: 'child-main-1', parentSessionId: parent.session.id,
        jobId: null, title: input.title, prompt: input.prompt, plan: null, status: 'running',
        resultDigest: null, result: null, artifacts: [], error: null,
        createdAt: 1, updatedAt: 1, settledAt: null,
      }
      return task
    },
    getTask: (taskId: string) => {
      queries.push(taskId)
      const status = queryStatuses.shift() ?? 'done'
      const task: TaskRecord = {
        id: 'task-main-1', qunoId: 'quno', childSessionId: 'child-main-1', parentSessionId: 'quno-main-test',
        jobId: null, title: '调研云之家讨论', prompt: '读取相关群聊并给出有依据的整理。', plan: null, status,
        resultDigest: null, result: status === 'done' ? '关键结论' : null, artifacts: [], error: null,
        createdAt: 1, updatedAt: 2, settledAt: status === 'done' ? 2 : null,
      }
      return task
    },
  } as never)
  ctx.tools.register(defineTool({
    name: 'bash',
    description: 'Direct execution fixture that another composition layer could inject globally.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() { return { message: 'executed' } },
  }))
  const handle = await ctx.agents.create({
    sessionId: 'quno-main-test' as SessionId,
    meta: { cwd: '/tmp', agentPreset: 'quno' },
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: (agentCtx) => {
      agentCtx.tools.presentAs('native')
      applyQunoPreset(agentCtx)
    },
  })
  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '帮我看看云之家群里的讨论并整理建议。' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    const exposedTools = adapter.requests[0]?.tools?.map(tool => tool.name) ?? []
    assert.equal(exposedTools.includes('quno_task'), true)
    assert.equal(exposedTools.includes('bash'), false, 'injected execution tools never reach the model')
    assert.deepEqual(started, [{
      title: '调研云之家讨论', prompt: '读取相关群聊并给出有依据的整理。', parentId: 'quno-main-test',
    }])
    assert.equal(adapter.requests.length, 2, 'one delegation and one immediate acknowledgement, no research turn')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '刚才那个任务进展如何？' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests.length, 4, 'one durable status query and its answer')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '现在结果出来了吗？' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests.length, 6, 'one durable result query and its answer')
    assert.deepEqual(queries, ['task-main-1', 'task-main-1'])
    const toolCalls = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/call')
      .map(event => event.type === 'tool/call' ? event.data.name : '')
    assert.deepEqual(toolCalls, ['quno_task', 'quno_task', 'quno_task'])
    const replies = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => event.type === 'assistant/message' ? event.data.message.content : [])
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    assert.match(replies.at(-3) ?? '', /交给后台/)
    assert.match(replies.at(-2) ?? '', /仍在进行/)
    assert.match(replies.at(-1) ?? '', /关键结论/)
  } finally {
    await handle.dispose()
    await ctx.fiber.dispose()
  }
})
