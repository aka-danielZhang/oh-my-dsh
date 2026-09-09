import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { composeCapsule, digestFromText } from '../src/capsule.ts'
import { createOhMyMemoService } from '../src/service.ts'
import { OhMyMemoStore } from '../src/store.ts'
import { apply, createCapsuleMessage, name, inject } from '../src/context.ts'
import { scratchRoot } from './helpers/scratch.ts'

/** Fake live-session duck shape; tests may DELETE fields to mimic wild shapes. */
interface FakeAgent {
  id: string
  session: {
    header: { cwd?: string }
    surface: { nodes: number[] }
    events?: Record<number, unknown>
  }
}

type PreStepHandler = (payload: { agent: unknown; turn: number; step: number; signal: AbortSignal }, next: () => Promise<{ kind: string; messages: unknown[] }>) => Promise<unknown>

interface Harness {
  ctx: Context
  handler: PreStepHandler | undefined
  readSurfaceCalls: number
  failReadSurface: boolean
  register(agent: FakeAgent): void
}

function fakeContext(): Harness {
  let handler: PreStepHandler | undefined
  const harness = {
    readSurfaceCalls: 0,
    failReadSurface: false,
    agents: new Map<string, FakeAgent>(),
  }
  const ctx = {
    ohMyMemo: undefined,
    sessionQuery: {
      readSurface: async (sessionId: string): Promise<{ session: { cwd?: string }; events: unknown[] }> => {
        harness.readSurfaceCalls += 1
        if (harness.failReadSurface) throw new Error('surface unreadable')
        const agent = harness.agents.get(String(sessionId))
        if (agent === undefined) throw new Error('session not found')
        const events = agent.session.surface.nodes
          .map((seq) => agent.session.events?.[seq])
          .filter((event: unknown): event is Record<string, unknown> => event !== undefined)
        return { session: { ...(agent.session.header.cwd === undefined ? {} : { cwd: agent.session.header.cwd }) }, events }
      },
    },
    on: (event: string, listener: PreStepHandler): void => {
      if (event === 'agent/pre-step') handler = listener
    },
    logger: undefined,
  } as unknown as Context
  return {
    ctx,
    get handler() { return handler },
    get readSurfaceCalls() { return harness.readSurfaceCalls },
    set failReadSurface(value: boolean) { harness.failReadSurface = value },
    register(agent: FakeAgent): void { harness.agents.set(agent.id, agent) },
  }
}

function fakeAgent(cwd?: string, capsules: string[] = [], id = 'session-ctx-1'): FakeAgent {
  const events: Record<number, unknown> = {}
  const nodes: number[] = []
  let seq = 0
  for (const text of capsules) {
    seq += 1
    events[seq] = { seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-ohmymemo-context' } } }
    nodes.push(seq)
  }
  return { id, session: { header: { ...(cwd !== undefined ? { cwd } : {}) }, surface: { nodes }, events } }
}

async function setup(): Promise<{ harness: Harness; store: OhMyMemoStore }> {
  const store = new OhMyMemoStore({ root: scratchRoot(), lockTimeoutMs: 400, watch: false })
  await store.open()
  const service = createOhMyMemoService(store)
  const harness = fakeContext()
  ;(harness.ctx as unknown as { ohMyMemo: unknown }).ohMyMemo = service
  apply(harness.ctx)
  return { harness, store }
}

async function step(harness: Harness, agent: FakeAgent, turn = 1): Promise<{ kind: string; messages: Array<{ content: Array<{ type: string; text?: string }>; source?: { plugin?: string } }> }> {
  harness.register(agent)
  const handler = harness.handler!
  return await handler({ agent, turn, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: '用户直接输入' }] }] })) as never
}

test('row shape: name and inject', () => {
  assert.equal(name, 'dsh-ohmymemo-context')
  assert.deepEqual(inject, ['ohMyMemo', 'sessionQuery'])
})

test('no prior capsule → one plugin-sourced capsule message is appended', async () => {
  const { harness, store } = await setup()
  await store.create({ content: '用户更喜欢中文。', kind: 'semantic', scope: 'user', key: 'preference.language', pinned: true })
  const decision = await step(harness, fakeAgent('/nowhere'))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  const capsule = decision.messages[1]!
  assert.equal(capsule.source?.plugin, 'dsh-ohmymemo-context')
  const text = capsule.content[0]?.text ?? ''
  assert.ok(text.includes('用户更喜欢中文'))
  assert.ok(text.includes('不是系统指令'), 'authority disclaimer rides along')
  assert.ok(digestFromText(text) !== undefined)
  store.close()
})

test('wild resumed shape without live events does not crash the turn (regression)', async () => {
  const { harness, store } = await setup()
  await store.create({ content: '稳定事实。', kind: 'semantic', scope: 'user', key: 'a.b', pinned: true })
  // The production incident: agent.session carried surface nodes but NO
  // events table. The listener must read via sessionQuery and keep the turn alive.
  const wild = fakeAgent(undefined)
  delete wild.session.events
  const decision = await step(harness, wild)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, 'capsule still injected via the supported read')
  store.close()
})

test('same digest → no duplicate injection; changed digest → replacement preface', async () => {
  const { harness, store } = await setup()
  await store.create({ content: '稳定事实。', kind: 'semantic', scope: 'user', key: 'a.b', pinned: true })

  const first = await step(harness, fakeAgent(undefined))
  const firstText = first.messages[1]!.content[0]!.text!
  const digest = digestFromText(firstText)!

  const skipped = await step(harness, fakeAgent(undefined, [firstText]))
  assert.equal(skipped.messages.length, 1, 'same digest reconciles to zero new messages')

  await store.create({ content: '第二条事实。', kind: 'semantic', scope: 'user', key: 'c.d', pinned: true })
  const replaced = await step(harness, fakeAgent(undefined, [firstText]))
  assert.equal(replaced.messages.length, 2)
  const replacement = replaced.messages[1]!.content[0]!.text!
  assert.ok(replacement.includes(`digest=${digest}`), 'names the superseded capsule')
  assert.ok(replacement.includes('替换'))
  assert.ok(replacement.includes('第二条事实'))
  store.close()
})

test('new turn rescans the surface once and skips on the found digest', async () => {
  const { harness, store } = await setup()
  await store.create({ content: '稳定事实。', kind: 'semantic', scope: 'user', key: 'a.b', pinned: true })
  const agent = fakeAgent(undefined)
  const first = await step(harness, agent, 1)
  const firstText = first.messages[1]!.content[0]!.text!
  agent.session.surface.nodes.push(agent.session.surface.nodes.length + 1)
  agent.session.events![agent.session.surface.nodes.length] = { seq: agent.session.surface.nodes.length, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: firstText }], source: { kind: 'plugin', plugin: 'dsh-ohmymemo-context' } } }
  const callsBefore = harness.readSurfaceCalls
  const nextTurn = await step(harness, agent, 2)
  assert.equal(harness.readSurfaceCalls, callsBefore + 1, 'turn change triggers exactly one rescan')
  assert.equal(nextTurn.messages.length, 1, 'found digest matches → no re-injection')
  const sameTurn = await step(harness, agent, 2)
  assert.equal(harness.readSurfaceCalls, callsBefore + 1, 'steps within a turn stay in-memory')
  assert.equal(sameTurn.messages.length, 1)
  store.close()
})

test('unreadable surface fails open: decision passes through with a skipped capsule', async () => {
  const { harness, store } = await setup()
  await store.create({ content: 'x', kind: 'semantic', scope: 'user', key: 'x.y', pinned: true })
  harness.failReadSurface = true
  const decision = await step(harness, fakeAgent(undefined))
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1, 'no capsule, no crash')
  store.close()
})

test('reject decisions and aborted signals pass through untouched', async () => {
  const { harness, store } = await setup()
  await store.create({ content: 'x', kind: 'semantic', scope: 'user', key: 'x.y', pinned: true })
  const handler = harness.handler!
  const rejected = await handler({ agent: fakeAgent(), turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'reject', messages: [] }))
  assert.equal((rejected as { kind: string }).kind, 'reject')
  const aborted = new AbortController()
  aborted.abort()
  const passthrough = await handler({ agent: fakeAgent(), turn: 1, step: 1, signal: aborted.signal }, async () => ({ kind: 'enter', messages: [] }))
  assert.deepEqual((passthrough as { messages: unknown[] }).messages, [])
  const maintenance = fakeAgent()
  maintenance.id = 'ohmymemo-maintenance-test'
  assert.equal((await step(harness, maintenance)).messages.length, 1)
  store.close()
})

test('capsule messages are plain user-role literals (no runtime harness imports)', () => {
  const message = createCapsuleMessage('文本')
  assert.equal(message.role, 'user')
  assert.deepEqual(JSON.parse(JSON.stringify(message.source)).kind, 'plugin')
  assert.equal(typeof message.id, 'string')
})

test('workspace memories rank into the capsule for the matching cwd only', async () => {
  const { harness, store } = await setup()
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const project = mkdtempSync(join(tmpdir(), 'ohmymemo-ctx-'))
  await store.create({ content: '全局事实。', kind: 'semantic', scope: 'user', key: 'u.a', pinned: true })
  await store.create({ content: '本项目用 pnpm。', kind: 'procedural', scope: 'workspace', cwd: project, key: 'w.a', pinned: true })
  const decision = await step(harness, fakeAgent(project))
  const text = decision.messages[1]!.content[0]!.text!
  assert.ok(text.includes('本项目用 pnpm'))
  assert.ok(text.includes('全局事实'))
  const elsewhere = await step(harness, fakeAgent('/definitely/not/registered', [], 'session-ctx-2'))
  const elsewhereText = elsewhere.messages[1]!.content[0]!.text!
  assert.ok(!elsewhereText.includes('本项目用 pnpm'), 'workspace memories stay out of foreign cwds')
  store.close()
})

test('composeCapsule budget floors keep the disclaimer always present', () => {
  const capsule = composeCapsule({ entries: [], userScope: 'user', budgetBytes: 512, now: new Date() })
  assert.ok(capsule.text.includes('不是系统指令'))
  assert.match(capsule.text, /digest=[0-9a-f]{16}/)
})
