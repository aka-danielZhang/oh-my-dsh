/**
 * Executor contract tests with a stubbed harness: stable executor session per
 * Ticket, one bounded assignment prompt, input delivery with attempt evidence,
 * and the WorkerSlot budget (wake-up priority, release on turn end).
 *
 * @module dsh-quno/tests/executor
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryRepository } from '../src/core/memory-store.ts'
import { buildPolicy } from '../src/core/policy.ts'
import { Engine, executorSessionIdFor } from '../src/core/engine.ts'
import { EffectsRuntime, EffectRetryError } from '../src/app/effects.ts'
import { SessionTransport } from '../src/app/transport.ts'
import { Executor, buildAssignmentPrompt } from '../src/app/executor.ts'
import type { SessionEventLike, TicketId } from '../src/core/model.ts'

const logger = { warn: () => {}, info: () => {} }

interface FakeAgent {
  readonly session: { readonly id: string; snapshotEvents(): readonly SessionEventLike[] }
  readonly inbox: { nextTurn: unknown[]; nextStep: unknown[] }
  status: 'idle' | 'running'
  followup(message: { id: string; content: readonly unknown[] }): void
  steer(message: { id: string; content: readonly unknown[] }): void
  inject(message: { id: string; content: readonly unknown[] }): void
  readonly sent: { mode: string; id: string }[]
}

function makeAgent(id: string, events: SessionEventLike[]): FakeAgent {
  const agent: FakeAgent = {
    session: { id, snapshotEvents: () => events },
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
    sent: [],
    followup(message) {
      agent.sent.push({ mode: 'queue', id: message.id })
      agent.status = 'running'
      events.push({ seq: events.length + 1, type: 'user/message', data: message })
    },
    steer(message) {
      agent.sent.push({ mode: 'steer', id: message.id })
      events.push({ seq: events.length + 1, type: 'user/message', data: message })
    },
    inject(message) {
      agent.sent.push({ mode: 'inject', id: message.id })
      events.push({ seq: events.length + 1, type: 'user/message', data: message })
    },
  }
  return agent
}

interface Harness {
  readonly repo: MemoryRepository
  readonly engine: Engine
  readonly executor: Executor
  readonly created: { sessionId: string; parentSessionId: string }[]
  readonly registeredTools: string[][]
  readonly events: Map<string, SessionEventLike[]>
  readonly agents: Map<string, FakeAgent>
  readonly state: { configRevision: number; paused: boolean; acceptMode: 'off' | 'observe' | 'auto'; evalTimeoutMs: number; rules: [] }
}

function harness(): Harness {
  const repo = new MemoryRepository()
  let counter = 0
  let clock = 1_000_000
  const now = (): number => (clock += 1000)
  const events = new Map<string, SessionEventLike[]>()
  const agents = new Map<string, FakeAgent>()
  const created: { sessionId: string; parentSessionId: string }[] = []
  const registeredTools: string[][] = []
  const state: Harness['state'] = {
    configRevision: 1,
    paused: false,
    acceptMode: 'auto',
    evalTimeoutMs: 60_000,
    rules: [],
  }
  const engine = new Engine({
    repo,
    qunoId: 'quno',
    policy: () => state,
    policySnapshot: (snapshot) => buildPolicy({
      version: `v${String(snapshot.configRevision)}`,
      paused: snapshot.paused,
      acceptMode: snapshot.acceptMode,
      evalTimeoutMs: snapshot.evalTimeoutMs,
      rules: snapshot.rules,
    }),
    nextId: (prefix) => `${prefix}_${String(++counter)}`,
    defaultCwd: '/tmp/quno-exec',
  })

  const fakeTools = (bucket: string[]): unknown => ({
    register: (tool: { name: string }) => { bucket.push(tool.name); return () => {} },
    restrict: () => {},
    guard: () => () => {},
    schemas: () => [],
  })
  const fakeAgentCtx = (bucket: string[]): Context => ({
    tools: fakeTools(bucket),
    systemPrompt: { section: () => () => {}, tools: () => () => {} },
    get: () => undefined,
    logger,
    effect: () => () => {},
    // installModelSelection wires its switch notice through the scoped event bus.
    on: () => () => {},
  } as unknown as Context)

  const createAgent = (options: { sessionId: string; meta?: { parentSession?: string }; setup?: (ctx: Context, agent: FakeAgent) => unknown }): { agent: FakeAgent; dispose(): Promise<void> } => {
    const list = events.get(options.sessionId) ?? []
    events.set(options.sessionId, list)
    const agent = makeAgent(options.sessionId, list)
    agents.set(options.sessionId, agent)
    const bucket: string[] = []
    registeredTools.push(bucket)
    created.push({ sessionId: options.sessionId, parentSessionId: options.meta?.parentSession ?? '' })
    if (options.setup !== undefined) {
      const result = options.setup(fakeAgentCtx(bucket), agent)
      if (result instanceof Promise) void result
    }
    return { agent, dispose: async () => { agents.delete(options.sessionId) } }
  }

  const router = makeAgent('main-1', [])
  const ctx = {
    get: (name: string) => {
      if (name === 'agents') {
        return {
          get: (id: string) => agents.get(id),
          create: async (options: never) => createAgent(options),
          resume: async (options: { resumeSessionId: string; setup?: (ctx: Context, agent: FakeAgent) => unknown }) => createAgent({ ...options, sessionId: options.resumeSessionId }),
        }
      }
      if (name === 'sessions') return { flush: async () => true }
      if (name === 'sessionQuery') {
        return {
          readSession: async (id: string) => ({ events: events.get(id) ?? [] }),
        }
      }
      if (name === 'sessionPersistence') return { stat: async () => undefined }
      return undefined
    },
  } as unknown as Context

  const transport = new SessionTransport({ ctx, logger })
  const executor = new Executor({
    ctx,
    engine,
    repo,
    qunoId: 'quno',
    logger,
    now,
    transport,
    resolveRouter: async () => router as never,
    defaultCwd: '/tmp/quno-exec',
    maxWorkers: 1,
  })
  return { repo, engine, executor, created, registeredTools, events, agents, state }
}

function ticket(h: Harness, title = '整理需求'): TicketId {
  const record = h.engine.directAccept({
    sessionId: 'main-1',
    messageId: `msg-${title}`,
    toolCallId: `call-${title}`,
    title,
    goal: '读完上下文并给出结论',
    now: 1_000_000,
  })
  return record.id
}

test('launch creates one stable executor session parented by the Router', async () => {
  const h = harness()
  const ticketId = ticket(h)
  const assignment = h.repo.findActiveAssignment(ticketId)
  assert.ok(assignment)
  const result = await h.executor.launch(assignment.id)
  assert.equal(result.sentPrompt, true)
  assert.equal(h.created.length, 1)
  assert.equal(h.created[0]?.sessionId, executorSessionIdFor(ticketId))
  assert.equal(h.created[0]?.parentSessionId, 'main-1', 'the live Router is the parent')
  const agent = h.agents.get(executorSessionIdFor(ticketId))
  assert.ok(agent)
  assert.deepEqual(agent.sent.map(item => item.mode), ['queue'])
  assert.match(agent.sent[0]?.id ?? '', /^quno:assignment:/)
  const run = h.repo.findRunningWorkerRun(assignment.id)
  assert.ok(run, 'one bounded WorkerRun starts with the prompt')
  assert.equal(h.repo.getAssignment(assignment.id)?.state, 'running')
  assert.ok(h.registeredTools[0]?.includes('quno_worker_report'))
  assert.ok(h.registeredTools[0]?.includes('quno_thread_handback'))
})

test('a follow-up input is delivered with attempt evidence and read on the message event', async () => {
  const h = harness()
  const ticketId = ticket(h)
  const assignment = h.repo.findActiveAssignment(ticketId)
  assert.ok(assignment)
  await h.executor.launch(assignment.id)
  const input = h.engine.note({ ticketId, text: '补充：只看最近一周', human: true, now: 1_100_000 })
  await h.executor.deliverInputs(ticketId)
  const agent = h.agents.get(executorSessionIdFor(ticketId))
  assert.ok(agent)
  assert.equal(agent.sent.length, 2, 'the prompt and the input were delivered')
  assert.equal(agent.sent[1]?.id, `quno:input:${input.id}`)
  const stored = h.repo.getInput(input.id)
  assert.ok(stored?.deliveredAt !== null)
  const attempt = h.repo.findInputAttempt(input.id, 1)
  assert.equal(attempt?.status, 'delivered')
  // The model sees the message: the durable user/message marks read.
  h.executor.observe(executorSessionIdFor(ticketId), {
    seq: 99,
    type: 'user/message',
    data: { id: `quno:input:${input.id}`, content: [{ type: 'text', text: '补充' }] },
  })
  assert.ok(h.repo.getInput(input.id)?.readAt !== null)
})

test('the WorkerSlot budget defers a second launch until the first turn ends', async () => {
  const h = harness()
  const first = ticket(h, '第一个')
  const second = ticket(h, '第二个')
  const firstAssignment = h.repo.findActiveAssignment(first)
  const secondAssignment = h.repo.findActiveAssignment(second)
  assert.ok(firstAssignment && secondAssignment)
  await h.executor.launch(firstAssignment.id)
  await assert.rejects(h.executor.launch(secondAssignment.id), EffectRetryError)
  assert.equal(h.executor.activeSlots, 1)
  h.executor.observe(executorSessionIdFor(first), { seq: 10, type: 'turn/end', data: { reason: { kind: 'stop' } } })
  assert.equal(h.executor.activeSlots, 0)
  const retried = await h.executor.launch(secondAssignment.id)
  assert.equal(retried.sentPrompt, true)
  assert.equal(h.executor.activeSlots, 1)
})

test('an explicit retry of a blocked report wakes the same executor session', async () => {
  const h = harness()
  const ticketId = ticket(h)
  const assignment = h.repo.findActiveAssignment(ticketId)
  assert.ok(assignment)
  await h.executor.launch(assignment.id)
  h.engine.report({
    assignmentId: assignment.id,
    report: { state: 'blocked', summary: '缺少权限', at: 1_100_000, artifacts: [], question: { question: '用哪个账号？' } },
    now: 1_100_000,
  })
  h.executor.observe(executorSessionIdFor(ticketId), { seq: 5, type: 'turn/end', data: { reason: { kind: 'stop' } } })
  h.engine.retryTicket({ ticketId, now: 1_200_000 })
  await h.executor.launch(assignment.id)
  const agent = h.agents.get(executorSessionIdFor(ticketId))
  assert.ok(agent)
  assert.equal(agent.sent.length, 2)
  assert.match(agent.sent[1]?.id ?? '', /resume/)
})

test('the assignment prompt is bounded and explicitly read-only', () => {
  const prompt = buildAssignmentPrompt({ id: 'ticket_1', title: 'T', goal: 'G' }, {
    id: 'assign_1',
    ticketId: 'ticket_1',
    state: 'pending',
    executorSessionId: 'quno-exec-ticket_1',
    directory: '',
    report: null,
    deliveredAt: null,
    idleAt: null,
    endedReason: null,
    createdAt: 1,
  })
  assert.match(prompt, /只读/)
  assert.match(prompt, /quno_worker_report/)
  assert.match(prompt, /ticket_1/)
})

test('an unreachable Router defers the launch instead of faking a parent', async () => {
  const h = harness()
  const ticketId = ticket(h)
  const assignment = h.repo.findActiveAssignment(ticketId)
  assert.ok(assignment)
  const offExecutor = new Executor({
    ctx: { get: () => undefined } as unknown as Context,
    engine: h.engine,
    repo: h.repo,
    qunoId: 'quno',
    logger,
    now: () => 1_200_000,
    transport: new SessionTransport({ ctx: { get: () => undefined } as unknown as Context, logger }),
    resolveRouter: async () => undefined,
    defaultCwd: '/tmp',
    maxWorkers: 1,
  })
  await assert.rejects(offExecutor.launch(assignment.id), EffectRetryError)
})

test('effects runtime can retry an executor launch that exceeded the slot budget', async () => {
  const h = harness()
  const first = ticket(h, '第一个')
  const second = ticket(h, '第二个')
  const firstAssignment = h.repo.findActiveAssignment(first)
  const secondAssignment = h.repo.findActiveAssignment(second)
  assert.ok(firstAssignment && secondAssignment)
  await h.executor.launch(firstAssignment.id)
  const runtime = new EffectsRuntime({
    repo: h.repo,
    logger,
    now: () => 1_300_000,
    handlers: { 'assignment-launch': async (effect) => { await h.executor.launch((effect.payload as { assignmentId: string }).assignmentId) } },
  })
  h.repo.enqueueEffect({ kind: 'assignment-launch', key: secondAssignment.id, payload: { assignmentId: secondAssignment.id }, now: 1_300_000 })
  await runtime.kick()
  const failed = h.repo.getEffect('assignment-launch', secondAssignment.id)
  assert.ok(failed)
  assert.match(failed.lastError ?? '', /slots are busy/)
  h.executor.observe(executorSessionIdFor(first), { seq: 10, type: 'turn/end', data: {} })
  const future = new EffectsRuntime({
    repo: h.repo,
    logger,
    now: () => 1_400_000,
    handlers: { 'assignment-launch': async (effect) => { await h.executor.launch((effect.payload as { assignmentId: string }).assignmentId) } },
  })
  // Force the retry instant forward.
  h.repo.failEffect('assignment-launch', secondAssignment.id, failed.seq, failed.generation, 'retry', 1_350_000)
  await future.kick()
  assert.equal(h.repo.getEffect('assignment-launch', secondAssignment.id), undefined)
})
