import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as qunoPresetRow from '../src/preset.ts'
import type { TaskRecord } from '../src/types.ts'

// Scope primitives must come from the same module instance the mounted
// runtime uses: the testkit's toolchain resolves dsh-scope from the registry
// store (a peer fallback would hand back this plugin's runtime-build copy,
// whose scope symbol never matches). Keys and tags only match within one
// instance, so import through the testkit's dsh-tools dependency.
const runtimeRequire = createRequire(createRequire(
  import.meta.resolve('@deepseek-ai/dsh-agent-loop-testkit'),
).resolve('@deepseek-ai/dsh-tools'))
const { bindScopeParent, createScope } = (await import(
  pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-scope')).href
)) as typeof import('@deepseek-ai/dsh-scope')

/**
 * The composition regression for the main routing preset: the preset row is
 * mounted inside a preset-generation scope (what `agentPresets.mount` builds)
 * and an Agent joins it through `bindScopeParent`, exactly the relation
 * `AgentPresetRegistry.join` creates. The earlier allow-list bug is invisible
 * when the row is applied on the agent scope itself — it only shows in this
 * topology, where the row's tools are INHERITED by the agent and a layer
 * restriction filters them out of the agent's view.
 */

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

function toolCallChunks(name: string, id: string, args: unknown): StreamChunk[] {
  const argsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name, argumentsDelta: argsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: argsText } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function globalTool(name: string, description: string, run: () => void) {
  return defineTool({
    name,
    description,
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute() {
      run()
      return { message: 'executed' }
    },
  })
}

test('the preset row keeps its tools visible to a joined agent and hides only global execution tools', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter([
    textChunks('（好的，我在。）'),
    toolCallChunks('quno_task', 'start-1', { title: '调研云之家讨论', prompt: '读取相关群聊并给出有依据的整理。' }),
    textChunks('我已交给后台处理，好了告诉你。'),
    toolCallChunks('mcp_probe', 'probe-1', {}),
    textChunks('这个能力主对话不能直接用。'),
    toolCallChunks('quno_task', 'status-1', { action: 'status', taskId: 'task-comp-1' }),
    textChunks('任务仍在进行。'),
    toolCallChunks('quno_task', 'result-1', { action: 'result', taskId: 'task-comp-1' }),
    textChunks('关键结论已经回来。'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await mountAgentLoopTestHarness(ctx)

  // Global surface the host composition contributes: a dsh-base execution
  // row, an allowed memory tool, and a dynamic MCP tool the deny list cannot
  // enumerate (the routing guard must refuse it instead).
  let bashRuns = 0
  let probeRuns = 0
  ctx.tools.register(globalTool('bash', 'Host shell fixture', () => { bashRuns += 1 }))
  ctx.tools.register(globalTool('memory_remember', 'Memory fixture allowed for routing', () => {}))
  ctx.tools.register(globalTool('mcp_probe', 'Dynamic MCP fixture', () => { probeRuns += 1 }))

  const started: { title: string; prompt: string; parentId: string }[] = []
  const queries: string[] = []
  const queryStatuses: TaskRecord['status'][] = ['running', 'done']
  ctx.provide('quno', {
    startTask: async (input: { title: string; prompt: string }, parent: { session: { id: string } }) => {
      started.push({ title: input.title, prompt: input.prompt, parentId: parent.session.id })
      const task: TaskRecord = {
        id: 'task-comp-1', qunoId: 'quno', childSessionId: 'child-comp-1', parentSessionId: parent.session.id,
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
        id: 'task-comp-1', qunoId: 'quno', childSessionId: 'child-comp-1', parentSessionId: 'quno-comp-test',
        jobId: null, title: '调研云之家讨论', prompt: '读取相关群聊并给出有依据的整理。', plan: null, status,
        resultDigest: null, result: status === 'done' ? '关键结论' : null, artifacts: [], error: null,
        createdAt: 1, updatedAt: 2, settledAt: status === 'done' ? 2 : null,
      }
      return task
    },
  } as never)

  // A sibling preset row in the same generation scope (the tool-ask-user
  // stand-in): its tools share the row's layer and must stay visible too.
  const siblingRow = {
    name: 'fixture-sibling-row',
    inject: ['tools'],
    apply(rowCtx: Context): void {
      rowCtx.tools.register(defineTool({
        name: 'ask_user_question',
        description: 'Preset-scope sibling fixture.',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { message: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        async execute() { return { message: 'asked' } },
      }))
    },
  }

  // The preset generation scope, mounted like AgentPresetRegistry.activate.
  const generationKey = {}
  const generation = createScope(ctx, generationKey)
  await generation.ctx.plugin(qunoPresetRow)
  await generation.ctx.plugin(siblingRow)

  // The agent's scope key is only reachable from inside the runtime's own
  // assembly (the setup ctx arrives shadow-wrapped), so join the generation
  // the way the runtime itself observes scopes: through the assembly hook.
  // The ToolRuntime provider registered earlier runs first, so the first
  // request assembles unbound and is discarded as a warm-up; assertions read
  // the headers of later requests.
  let joined = false
  ctx.systemPrompt.tools(context => {
    if (!joined && context.scope !== undefined) {
      joined = true
      // AgentPresetRegistry.join does exactly this when an Agent joins a revision.
      bindScopeParent(context.scope, generationKey)
    }
    return { schemas: [], knownNames: [] }
  })

  const handle = await ctx.agents.create({
    sessionId: 'quno-comp-test' as SessionId,
    meta: { cwd: '/tmp', agentPreset: 'quno' },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '（预热一轮，绑定 preset 组合。）' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '帮我看看云之家群里的讨论并整理建议。' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '直接用你的探测工具查一下吧。' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '刚才那个任务进展如何？' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: '现在结果出来了吗？' }],
      source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()

    assert.equal(joined, true, 'the agent scope joined the preset generation during assembly')
    const exposedTools = adapter.requests[1]?.tools?.map(tool => tool.name) ?? []
    for (const tool of [
      'quno_recall', 'quno_attention', 'quno_task', 'quno_mute', 'quno_status',
      'ask_user_question', 'memory_remember', 'mcp_probe',
    ]) {
      assert.equal(exposedTools.includes(tool), true, `${tool} must reach the model`)
    }
    assert.equal(exposedTools.includes('bash'), false, 'global execution tools stay hidden from the model')

    assert.deepEqual(started, [{
      title: '调研云之家讨论', prompt: '读取相关群聊并给出有依据的整理。', parentId: 'quno-comp-test',
    }])
    assert.equal(bashRuns, 0)
    assert.equal(probeRuns, 0, 'the routing guard refuses non-routing calls without executing them')
    assert.deepEqual(queries, ['task-comp-1', 'task-comp-1'])

    const probeResults = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result')
      .map(event => (event.type === 'tool/result' ? JSON.stringify(event.data) : ''))
      .filter(text => text.includes('mcp_probe'))
    assert.equal(probeResults.length, 1)
    assert.match(probeResults[0] ?? '', /路由|委派/)

    const replies = handle.agent.session.snapshotEvents()
      .filter(event => event.type === 'assistant/message')
      .flatMap(event => event.type === 'assistant/message' ? event.data.message.content : [])
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    assert.match(replies.at(-4) ?? '', /交给后台/)
    assert.match(replies.at(-3) ?? '', /不能直接用/)
    assert.match(replies.at(-2) ?? '', /仍在进行/)
    assert.match(replies.at(-1) ?? '', /关键结论/)
  } finally {
    await handle.dispose()
    await generation.dispose()
    await ctx.fiber.dispose()
  }
})
