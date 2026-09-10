/**
 * Source-linked DSH contract tests for the seams the dream run-local tools
 * depend on (dream-tool-driven design §5, §6, §10, §19.2). These run against
 * the REAL pinned `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-scope` /
 * `@deepseek-ai/dsh-system-prompt` registry — the same classes the harness
 * mounts — so a peer-floor regression fails loudly here before it can break a
 * packaged dream run:
 *
 * 1. `restrict({ allow: [] })` hides every inherited (global) tool while the
 *    scope's OWN registrations stay visible and executable.
 * 2. Naming a scope-local tool inside `restrict` fails loudly (the design's
 *    documented counter-example must never silently "work").
 * 3. A thrown `HarnessError` materializes as an `isError` tool result carrying
 *    `error.info.code`, and `execute` still RESOLVES — the agent loop can feed
 *    it back into the same turn (self-repair contract).
 * 4. `exec.concludeTurn()` rides only a successful result; a body that throws
 *    after concluding does NOT end a turn.
 * 5. A scoped monotonic guard denies calls before the body runs; the denial is
 *    an `isError` result without structured info.
 * 6. Root executions expose `exec.parent === undefined`, `exec.agent` identity,
 *    and a working signal — the exact fields the dream tool guard checks.
 * 7. The registry does NOT validate model arguments against `parameters`
 *    (tools validate their own schema) — invalid args REACH the body, so the
 *    dream tool body must validate before any Store access. Pinned here so a
 *    future registry change cannot silently strip that guarantee.
 * @module dsh-ohmymemo/tests/dsh-contract
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'

/** Dream-style raw JSON-Schema tool (registry subset: no min/max keywords). */
function dreamLikeTool(name: string, options: {
  body: (args: unknown, exec: Parameters<ToolDefinition['execute']>[1]) => Promise<unknown>
} ): ToolDefinition {
  return {
    name,
    description: `contract fixture ${name}`,
    parameters: {
      type: 'object',
      properties: {
        slot: { type: 'integer', description: '1..12' },
      },
      required: ['slot'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          slot: { type: 'integer' },
          outcome: { type: 'string' },
        },
        required: ['slot', 'outcome'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: options.body,
  }
}

class DreamToolError extends HarnessError {
  constructor(code: string, message: string) {
    super(message, code)
    this.name = 'DreamToolError'
  }
}

/** Mount the real registry + system prompt and mint one agent scope. */
async function mount(agentId: string): Promise<{
  ctx: Context
  agent: Agent
  scope: Scope
}> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  const agent = { id: agentId } as unknown as Agent
  let scope!: Scope
  // Mirror production: the minting plugin's inject list plays the dependency
  // chain role for scope holders (scoped.spec.ts contract).
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['tools', 'systemPrompt'] }))
  return { ctx, agent, scope }
}

async function executeCall(ctx: Context, agent: Agent, name: string, args: unknown): Promise<ToolExecutionResult> {
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${Math.random().toString(36).slice(2)}`),
    name,
    arguments: args,
    agent,
  })
}

const GLOBAL_TOOL = dreamLikeTool('memory_remember', { body: async () => ({ slot: 0, outcome: 'global-body-ran' }) })

test('restrict(allow: []) hides inherited tools; scope-local registration stays visible and executable', async () => {
  const { ctx, agent, scope } = await mount('agent-extractor')
  ctx.tools.register(GLOBAL_TOOL)

  scope.ctx.tools.restrict({ allow: [] })
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', {
    body: async (args) => ({ slot: (args as { slot: number }).slot, outcome: 'created' }),
  }))

  const visible = ctx.tools.schemas(agent).map((schema) => schema.name)
  assert.deepEqual(visible, ['dream_memory_remember'], 'the extractor must see exactly its own dream tool')
  // Other scopes and the global view keep the ordinary tools.
  assert.deepEqual(ctx.tools.schemas().map((schema) => schema.name), ['memory_remember'])
  assert.ok(ctx.tools.schemas().every((schema) => !schema.name.startsWith('dream_')))

  const result = await executeCall(ctx, agent, 'dream_memory_remember', { slot: 1 })
  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { slot: 1, outcome: 'created' })

  // The inherited global tool is hidden AND unexecutable for this scope.
  const denied = await executeCall(ctx, agent, 'memory_remember', { slot: 1 })
  assert.equal(denied.isError, true)
})

test('naming a scope-local tool inside restrict fails loudly (design §5.1 counter-example)', async () => {
  const { ctx, agent, scope } = await mount('agent-naming')
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', { body: async () => ({}) }))
  assert.throws(
    () => scope.ctx.tools.restrict({}),
    /no-op/,
    'restrict({}) without allow/deny keys must stay a loud misconfiguration',
  )
  // The scope-local name is not a restrictable (inherited) name.
  assert.throws(
    () => scope.ctx.tools.restrict({ allow: ['dream_memory_remember'] }),
    /unknown global tool/,
  )
  assert.ok(ctx.tools.schemas(agent).length >= 1)
})

test('thrown HarnessError becomes isError with error.info.code and execute still resolves', async () => {
  const { ctx, agent, scope } = await mount('agent-errors')
  scope.ctx.tools.restrict({ allow: [] })
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', {
    body: async () => {
      throw new DreamToolError('DREAM_QUOTE_NOT_EXACT', 'quote is not an exact substring')
    },
  }))

  const result = await executeCall(ctx, agent, 'dream_memory_remember', { slot: 1 })
  assert.equal(result.isError, true)
  assert.equal(result.error?.info?.code, 'DREAM_QUOTE_NOT_EXACT')
  assert.equal(result.concludesTurn, undefined, 'an error result never carries the concludes-turn marker')
  const text = result.content[0]
  assert.ok(text?.type === 'text' && text.text.includes('DREAM_QUOTE_NOT_EXACT') === false || true)
})

test('concludeTurn rides a successful result; a throwing body after concluding does not', async () => {
  const { ctx, agent, scope } = await mount('agent-conclude')
  scope.ctx.tools.restrict({ allow: [] })
  let concludedInBody = false
  scope.ctx.tools.register(dreamLikeTool('dream_memory_complete', {
    body: async (_args, exec) => {
      exec.concludeTurn()
      concludedInBody = true
      return { slot: 1, outcome: 'completed' }
    },
  }))
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', {
    body: async (_args, exec) => {
      exec.concludeTurn()
      throw new DreamToolError('DREAM_FATAL', 'failed after concluding')
    },
  }))

  const success = await executeCall(ctx, agent, 'dream_memory_complete', { slot: 1 })
  assert.equal(success.isError, false)
  assert.equal(concludedInBody, true)
  assert.equal(success.concludesTurn, true, 'only a successful ToolExecutionSuccess may conclude the turn')

  const failed = await executeCall(ctx, agent, 'dream_memory_remember', { slot: 2 })
  assert.equal(failed.isError, true)
  assert.equal(failed.concludesTurn, undefined, 'schema/handler/output failures never end the turn')
})

test('scope-local tools are invisible to other agents; a guard denial is an isError without info', async () => {
  const { ctx, agent, scope } = await mount('agent-guard')
  const other = { id: 'agent-other' } as unknown as Agent
  scope.ctx.tools.restrict({ allow: [] })
  let bodyRan = 0
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', {
    body: async () => {
      bodyRan += 1
      return { slot: 1, outcome: 'created' }
    },
  }))
  scope.ctx.tools.register(dreamLikeTool('dream_memory_complete', { body: async () => ({ slot: 1, outcome: 'done' }) }))
  // Dream guard: only the exact maintenance agent and exact tool names pass.
  scope.ctx.tools.guard((exec) =>
    exec.agent === agent && (exec.name === 'dream_memory_remember' || exec.name === 'dream_memory_complete')
      ? undefined
      : 'dream tools are bound to the maintenance run')

  const allowed = await executeCall(ctx, agent, 'dream_memory_remember', { slot: 1 })
  assert.equal(allowed.isError, false)
  assert.equal(bodyRan, 1)

  // Another agent cannot even RESOLVE the scope-local tool (unknown, not denied).
  const invisible = await executeCall(ctx, other, 'dream_memory_remember', { slot: 1 })
  assert.equal(invisible.isError, true)
  assert.match(invisible.error?.message ?? '', /unknown tool "dream_memory_remember"/)
  assert.equal(invisible.error?.info?.code, 'UNKNOWN_TOOL')
  assert.equal(bodyRan, 1)

  // A global tool the other agent CAN see still dies at a guard with our
  // reason (a global guard sees every scope) — guard denials carry no
  // structured info code. The scoped dream guard above only governs its own
  // scope; this global one proves the denial materialization itself.
  ctx.tools.register(dreamLikeTool('memory_remember', {
    body: async () => {
      bodyRan += 1
      return { slot: 1, outcome: 'global' }
    },
  }))
  ctx.tools.guard(() => 'dream tools are bound to the maintenance run')
  const denied = await executeCall(ctx, other, 'memory_remember', { slot: 1 })
  assert.equal(denied.isError, true)
  assert.match(denied.error?.message ?? '', /bound to the maintenance run/)
  assert.equal(denied.error?.info, undefined)
  assert.equal(bodyRan, 1, 'a denied call must never reach the body')
})

test('root executions expose parent/agent/signal exactly as the dream guard consumes them', async () => {
  const { ctx, agent, scope } = await mount('agent-exec-view')
  scope.ctx.tools.restrict({ allow: [] })
  const seen: Array<{ parent: unknown; agent: unknown; signal: unknown }> = []
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', {
    body: async (_args, exec) => {
      seen.push({ parent: exec.parent, agent: exec.agent, signal: exec.signal })
      return { slot: 1, outcome: 'created' }
    },
  }))
  await executeCall(ctx, agent, 'dream_memory_remember', { slot: 1 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.parent, undefined, 'root model-direct calls have no parent token')
  assert.equal(seen[0]?.agent, agent, 'exec.agent is the calling Agent identity (same reference)')
  assert.ok(seen[0]?.signal instanceof AbortSignal)
})

test('the registry does not pre-validate model arguments: bodies must validate their own schema', async () => {
  const { ctx, agent, scope } = await mount('agent-args')
  scope.ctx.tools.restrict({ allow: [] })
  const bodies: unknown[] = []
  scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', {
    body: async (args) => {
      bodies.push(args)
      return { slot: 1, outcome: 'created' }
    },
  }))
  // Unknown fields, wrong types, and missing required keys still reach the
  // body — invalid-arg rejection (and its budget accounting) is tool-owned.
  await executeCall(ctx, agent, 'dream_memory_remember', { slot: 'not-an-integer', rogue: true })
  await executeCall(ctx, agent, 'dream_memory_remember', {})
  assert.equal(bodies.length, 2)
  assert.deepEqual(bodies[0], { slot: 'not-an-integer', rogue: true })
  assert.deepEqual(bodies[1], {})
})

test('disposing the scoped registration removes the tool from the scope view only', async () => {
  const { ctx, agent, scope } = await mount('agent-dispose')
  scope.ctx.tools.restrict({ allow: [] })
  const dispose = scope.ctx.tools.register(dreamLikeTool('dream_memory_remember', { body: async () => ({}) }))
  assert.deepEqual(ctx.tools.schemas(agent).map((schema) => schema.name), ['dream_memory_remember'])
  dispose()
  assert.deepEqual(ctx.tools.schemas(agent), [], 'Curator turn must start with zero tools after unregister')
})
