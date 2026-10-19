import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as TodoCompletionGuard from '../src/index.ts'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * Behavior suite for the turn-end todo guard: the steer-at-stopping nudge,
 * the once-per-turn throttle, pending/in_progress both counting as open, the
 * max-tokens and stale-list exemptions, and the all-completed quiet path —
 * all driven through a real agent loop with the real todo_write tool against
 * a scripted mock adapter (no network).
 */

const OPEN_TODOS = [
  { content: 'write the guard', status: 'in_progress' },
  { content: 'test the guard', status: 'pending' },
]
const DONE_TODOS = [
  { content: 'write the guard', status: 'completed' },
  { content: 'test the guard', status: 'completed' },
]

/** Boot the core spine, the real todo tool, and the guard under test. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  await ctx.plugin(TodoCompletionGuard)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Every guard-steered user message in the agent's log, flattened to joined text + source for terse assertions. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.snapshotEvents()]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message' && e.data.source.kind === 'todo-completion-guard')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

/** The reason of the most recent turn/end event. */
function lastTurnEnd(agent: Agent): { kind?: string } | undefined {
  return agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')?.data.reason
}

/** The most recent todo/write snapshot. */
function currentTodos(agent: Agent): unknown {
  return agent.session.snapshotEvents().findLast(event => event.type === 'todo/write')?.data.todos
}

function go(agent: Agent): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
}

describe('the steering nudge', () => {
  it('steers one reminder at the stopping boundary and the model can complete the list in the same turn', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: OPEN_TODOS }),
      textResponse('working'),
      toolCallResponse('c2', 'todo_write', { todos: DONE_TODOS }),
      textResponse('all done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    go(agent)
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 4) // the steered step really ran
    const found = reminders(agent)
    assert.equal(found.length, 1)
    assert.ok(found[0]!.text.includes('2 unfinished item(s)'))
    assert.ok(found[0]!.text.includes('- [in_progress] write the guard'))
    assert.ok(found[0]!.text.includes('- [pending] test the guard'))
    assert.ok(found[0]!.text.includes('todo_write'))
    assert.deepEqual(found[0]!.source, {
      kind: 'todo-completion-guard',
      form: 'notice',
      summary: 'todos: 2 unfinished',
    })
    assert.deepEqual(currentTodos(agent), DONE_TODOS)
    assert.equal(lastTurnEnd(agent)?.kind, 'completed')
  })

  it('advises once per turn: a steered turn that still ends open is allowed to end', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: OPEN_TODOS }),
      textResponse('done for now'),
      textResponse('deferring the rest to a later turn'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    go(agent)
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 3)
    assert.equal(reminders(agent).length, 1) // the second stopping boundary stayed quiet
    assert.deepEqual(currentTodos(agent), OPEN_TODOS) // the list was left open and the turn still closed
    assert.equal(lastTurnEnd(agent)?.kind, 'completed')
  })
})

describe('exemptions', () => {
  it('skips the reminder when the turn ended on max-tokens', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: OPEN_TODOS }),
      maxTokensResponse('cut off mid-sentence'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a3'), { provider: 'mock', model: 'mock' })
    go(agent)
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 2) // no forced continuation
    assert.equal(reminders(agent).length, 0)
    assert.equal(lastTurnEnd(agent)?.kind, 'max-tokens')
  })

  it('does not nag a later turn about a list written in an earlier one', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: OPEN_TODOS }),
      textResponse('turn one ends open'),
      textResponse('still deferring'),
      textResponse('fresh reply without touching the list'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a4'), { provider: 'mock', model: 'mock' })
    go(agent)
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'next request' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 4)
    assert.equal(reminders(agent).length, 1) // only turn one's nudge; turn two stayed quiet
    assert.equal(lastTurnEnd(agent)?.kind, 'completed')
  })

  it('stays quiet when every item is already completed', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'todo_write', { todos: DONE_TODOS }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a5'), { provider: 'mock', model: 'mock' })
    go(agent)
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 2)
    assert.equal(reminders(agent).length, 0)
    assert.equal(lastTurnEnd(agent)?.kind, 'completed')
  })
})
