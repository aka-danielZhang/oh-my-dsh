import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { createOhMyMemoService } from '../src/service.ts'
import { OhMyMemoStore } from '../src/store.ts'
import { apply, name, inject } from '../src/tools.ts'
import { scratchRoot } from './helpers/scratch.ts'

interface RegisteredTool {
  name: string
  description: string
  output: { schema: unknown }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Harness {
  ctx: Context
  registered: RegisteredTool[]
  sections: string[]
  effects: Array<() => (() => void) | undefined>
}

function fakeContext(service: ReturnType<typeof createOhMyMemoService>): Harness {
  const registered: RegisteredTool[] = []
  const sections: string[] = []
  const effects: Array<() => (() => void) | undefined> = []
  const ctx = {
    ohMyMemo: service,
    systemPrompt: {
      section: (options: { text: string }): (() => void) => {
        sections.push(options.text)
        return (): void => {
          const at = sections.indexOf(options.text)
          if (at !== -1) sections.splice(at, 1)
        }
      },
    },
    tools: {
      register: (tool: RegisteredTool): (() => void) => {
        registered.push(tool)
        return (): void => {
          const at = registered.indexOf(tool)
          if (at !== -1) registered.splice(at, 1)
        }
      },
    },
    effect: (fn: () => (() => void) | undefined): void => {
      effects.push(fn)
    },
  } as unknown as Context
  return { ctx, registered, sections, effects }
}

async function setup(): Promise<{ harness: Harness; store: OhMyMemoStore }> {
  const store = new OhMyMemoStore({ root: scratchRoot(), lockTimeoutMs: 400, watch: false })
  await store.open()
  const service = createOhMyMemoService(store)
  const harness = fakeContext(service)
  apply(harness.ctx)
  return { harness, store }
}

function exec(agent: unknown, parent?: unknown): unknown {
  return { agent, signal: new AbortController().signal, ...(parent !== undefined ? { parent } : {}) }
}

const AGENT = { id: 'session-42', session: { header: { cwd: process.cwd() } } }
const SUBAGENT = { id: 'session-child', session: { header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } }

test('row shape: name, inject and five registered tools plus a guidance section', async () => {
  const { harness: ctx } = await setup()
  assert.equal(name, 'dsh-ohmymemo-tools')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'ohMyMemo'])
  assert.equal(ctx.registered.length, 5)
  assert.deepEqual(ctx.registered.map((tool) => tool.name), ['memory_search', 'memory_get', 'memory_remember', 'memory_update', 'memory_forget'])
  assert.equal(ctx.sections.length, 1)
  assert.ok(ctx.sections[0]!.includes('memory_search'))
})

test('remember writes through the service with agent-derived provenance', async () => {
  const { harness: ctx, store } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const result = (await remember.execute({ content: '称呼我为 Daniel。', kind: 'semantic', key: 'profile.name' }, exec(AGENT))) as { id: string; path: string }
  assert.match(result.id, /^mem_/)
  const read = store.readRecord(result.id)
  assert.deepEqual(read?.record.sources[0], { type: 'user_command', session_id: 'session-42', observed_at: read?.record.sources[0]?.observed_at })
  assert.equal(read?.record.confirmed, true)
})

test('subagent callers: reads allowed, writes denied; root PTC subdispatch writes', async () => {
  const { harness: ctx } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const search = ctx.registered.find((tool) => tool.name === 'memory_search')!
  await assert.rejects(() => remember.execute({ content: 'x', kind: 'semantic' }, exec(SUBAGENT)), /denied for subagent/)
  // ToolExecution.parent is the enclosing PTC/run_code transport token — a
  // root Code Mode subdispatch carries it while remaining the root agent,
  // so the write is allowed.
  const root = (await remember.execute({ content: 'x', kind: 'semantic' }, exec(AGENT, { token: 'nested' }))) as { id: string }
  assert.match(root.id, /^mem_/)
  // A true subagent stays denied even inside a PTC subdispatch.
  await assert.rejects(() => remember.execute({ content: 'y', kind: 'semantic' }, exec(SUBAGENT, { token: 'nested' })), /denied for subagent/)
  const result = (await search.execute({ query: '任意' }, exec(SUBAGENT))) as { hits: unknown[] }
  assert.deepEqual(result.hits, [])
})

test('unknown caller authority fails closed', async () => {
  const { harness: ctx } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  await assert.rejects(
    () => remember.execute({ content: 'x', kind: 'semantic' }, exec(undefined)),
    /Agent-backed session header/,
  )
  await assert.rejects(
    () => remember.execute({ content: 'x', kind: 'semantic' }, exec({ id: 'session-missing-header', session: {} })),
    /Agent-backed session header/,
  )
})

test('search → get → update(CAS) → forget round-trip through the tools', async () => {
  const { harness: ctx } = await setup()
  const search = ctx.registered.find((tool) => tool.name === 'memory_search')!
  const get = ctx.registered.find((tool) => tool.name === 'memory_get')!
  const update = ctx.registered.find((tool) => tool.name === 'memory_update')!
  const forget = ctx.registered.find((tool) => tool.name === 'memory_forget')!

  await ctx.registered.find((tool) => tool.name === 'memory_remember')!.execute({ content: '验证饮料是 lapsang souchong。', kind: 'semantic', key: 'preference.validation-drink' }, exec(AGENT))
  const found = (await search.execute({ query: 'lapsang' }, exec(AGENT))) as { hits: Array<{ id: string }> }
  assert.equal(found.hits.length, 1)
  const id = found.hits[0]!.id

  const records = (await get.execute({ ids: [id] }, exec(AGENT))) as { records: Array<{ body: string; revision: number; hash: string }> }
  assert.match(records.records[0]!.body, /lapsang/)

  const updated = (await update.execute({ id, ifRevision: records.records[0]!.revision, ifHash: records.records[0]!.hash, confirm: true, reason: 'confirm' }, exec(AGENT))) as { id: string; revision: number }
  assert.equal(updated.revision, 2)

  const forgotten = (await forget.execute({ id: updated.id, reason: 'user asked' }, exec(AGENT))) as { forgottenIds: string[] }
  assert.deepEqual(forgotten.forgottenIds, [updated.id])
  const after = (await search.execute({ query: 'lapsang' }, exec(AGENT))) as { hits: unknown[] }
  assert.deepEqual(after.hits, [])
})

test('update with stale revision or hand-edited hash fails with the store CAS error', async () => {
  const { harness: ctx } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const get = ctx.registered.find((tool) => tool.name === 'memory_get')!
  const update = ctx.registered.find((tool) => tool.name === 'memory_update')!
  const created = (await remember.execute({ content: 'v1', kind: 'semantic', key: 'a.b' }, exec(AGENT))) as { id: string }
  const got = (await get.execute({ ids: [created.id] }, exec(AGENT))) as { records: Array<{ revision: number; hash: string }> }
  const view = got.records[0]!
  await update.execute({ id: created.id, ifRevision: view.revision, ifHash: view.hash, confirm: true, reason: 'r' }, exec(AGENT))
  await assert.rejects(
    () => update.execute({ id: created.id, ifRevision: view.revision, ifHash: view.hash, confirm: true, reason: 'stale' }, exec(AGENT)),
    (error: unknown) => {
      assert.match((error as { code?: string }).code ?? (error as Error).message, /OHMYMEMO_CAS_REVISION|revision mismatch/)
      return true
    },
  )
})

test('unmount disposes every registration', async () => {
  const { harness: ctx } = await setup()
  const disposers = ctx.effects.map((effect) => effect?.() ?? ((): void => { }))
  for (const dispose of disposers) dispose()
  assert.equal(ctx.registered.length, 0)
  assert.equal(ctx.sections.length, 0)
})

// The ToolRegistry validates every successful execute() value against the
// declared output schema (createSuccessResult) — a mismatch fails loud at
// dispatch, as the 0.2.3 memory_search `score` omission proved. The mock
// registry in this file skips that seam, so this test replays it: run each
// tool's real execute() and validate the value with the same dsh-tools
// validator the registry uses.
test('contract: every tool output validates against its declared output schema', async () => {
  const { harness: ctx } = await setup()
  const byName = new Map(ctx.registered.map((tool) => [tool.name, tool]))
  const remember = byName.get('memory_remember')!
  const search = byName.get('memory_search')!
  const get = byName.get('memory_get')!
  const update = byName.get('memory_update')!
  const forget = byName.get('memory_forget')!

  const created = (await remember.execute({ content: '契约测试锚点 zanzibar。', kind: 'semantic', key: 'contract.anchor' }, exec(AGENT))) as { id: string }
  const got = (await get.execute({ ids: [created.id] }, exec(AGENT))) as { records: Array<{ revision: number; hash: string }> }
  const view = got.records[0]!

  // Sequential on purpose: update and forget touch the same record, and the
  // store's write lock must see them in program order for the CAS to hold.
  const searchHit = await search.execute({ query: 'zanzibar' }, exec(AGENT))
  // The empty result validates trivially — it is exactly the shape that
  // masked the 0.2.3 score omission in manual testing, so pin it too.
  const searchEmpty = await search.execute({ query: '绝不匹配的检索词 zzqqxx' }, exec(AGENT))
  const second = await remember.execute({ content: '第二条契约样本。', kind: 'procedural', key: 'contract.second' }, exec(AGENT))
  const updated = await update.execute({ id: created.id, ifRevision: view.revision, ifHash: view.hash, confirm: true, reason: 'contract' }, exec(AGENT))
  const forgotten = await forget.execute({ id: created.id, reason: 'contract' }, exec(AGENT))

  const samples = [
    ['memory_search', searchHit],
    ['memory_search(empty)', searchEmpty],
    ['memory_get', got],
    ['memory_remember', second],
    ['memory_update', updated],
    ['memory_forget', forgotten],
  ] as const
  for (const [toolName, value] of samples) {
    const tool = byName.get(toolName.replace(/\(.*\)$/, ''))!
    const violations = validateJsonSchemaValue(tool.output.schema as Parameters<typeof validateJsonSchemaValue>[0], value, 'value')
    assert.deepEqual(violations, [], `${toolName} output violates its declared schema`)
  }
})

test('workspace-scoped remember uses the session cwd (forged cwds impossible)', async () => {
  const { harness: ctx, store } = await setup()
  const project = mkdtempSync(join(tmpdir(), 'ohmymemo-tools-'))
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const result = (await remember.execute({ content: '本项目发布前跑全量测试。', kind: 'procedural', scope: 'workspace', key: 'workflow.release' }, exec({ id: 'session-7', session: { header: { cwd: project } } }))) as { scope: string }
  assert.match(result.scope, /^workspace:/)
  assert.equal(store.catalogStats().scopes, 1)
})
