import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

async function setup(): Promise<{ harness: Harness; store: OhMyMemoStore; service: ReturnType<typeof createOhMyMemoService> }> {
  const store = new OhMyMemoStore({ root: scratchRoot(), lockTimeoutMs: 400, watch: false })
  await store.open()
  const service = createOhMyMemoService(store)
  const harness = fakeContext(service)
  apply(harness.ctx)
  return { harness, store, service }
}

function exec(agent: unknown, parent?: unknown): unknown {
  return { agent, signal: new AbortController().signal, ...(parent !== undefined ? { parent } : {}) }
}

const AGENT = { id: 'session-42', session: { header: { cwd: process.cwd() } } }
const SUBAGENT = { id: 'session-child', session: { header: { cwd: process.cwd(), origin: 'subagent', delegationDepth: 1 } } }

test('row shape: name, inject and the three write tools plus a guidance section', async () => {
  const { harness: ctx } = await setup()
  assert.equal(name, 'dsh-ohmymemo-tools')
  assert.deepEqual(inject, ['tools', 'systemPrompt', 'ohMyMemo'])
  assert.equal(ctx.registered.length, 3)
  assert.deepEqual(ctx.registered.map((tool) => tool.name), ['memory_remember', 'memory_update', 'memory_forget'])
  assert.equal(ctx.sections.length, 1)
  // Index-first guidance: read/grep are the recall path; retired tools are
  // gone from the prompt too.
  assert.ok(ctx.sections[0]!.includes('read'), 'guidance teaches file reads')
  assert.ok(ctx.sections[0]!.includes('memory_update'))
  assert.ok(!ctx.sections[0]!.includes('memory_search'))
  assert.ok(!ctx.sections[0]!.includes('memory_get'))
  assert.ok(ctx.sections[0]!.includes('frontmatter'), 'update revision comes from the file frontmatter')
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

test('CJK tags degrade to no tags instead of failing the write (lenient normalization)', async () => {
  const { harness: ctx, store } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  // The evidence-session failure: `tag "身份" cannot be normalized` burned a
  // step. Lenient store normalization drops unnormalizable tags silently.
  const result = (await remember.execute({ content: '用户是张炜。', kind: 'semantic', key: 'profile.name2', tags: ['身份', '云之家', 'profile', 'profile'] }, exec(AGENT))) as { id: string }
  const read = store.readRecord(result.id)
  assert.deepEqual(read?.record.tags, ['profile'], 'CJK dropped, ASCII kept, duplicates collapsed')
})

test('subagent callers: writes denied; root PTC subdispatch writes', async () => {
  const { harness: ctx } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  await assert.rejects(() => remember.execute({ content: 'x', kind: 'semantic' }, exec(SUBAGENT)), /denied for subagent/)
  // ToolExecution.parent is the enclosing PTC/run_code transport token — a
  // root Code Mode subdispatch carries it while remaining the root agent,
  // so the write is allowed.
  const root = (await remember.execute({ content: 'x', kind: 'semantic' }, exec(AGENT, { token: 'nested' }))) as { id: string }
  assert.match(root.id, /^mem_/)
  // A true subagent stays denied even inside a PTC subdispatch.
  await assert.rejects(() => remember.execute({ content: 'y', kind: 'semantic' }, exec(SUBAGENT, { token: 'nested' })), /denied for subagent/)
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

test('update works from the frontmatter revision alone (no ifHash, no memory_get)', async () => {
  const { harness: ctx, store } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const update = ctx.registered.find((tool) => tool.name === 'memory_update')!
  const forget = ctx.registered.find((tool) => tool.name === 'memory_forget')!

  const created = (await remember.execute({ content: '验证饮料是 lapsang souchong。', kind: 'semantic', key: 'preference.validation-drink' }, exec(AGENT))) as { id: string }
  // The model reads the revision from the file frontmatter — store tests pin
  // that byte format; here revision 1 is the frontmatter fact.
  const updated = (await update.execute({ id: created.id, ifRevision: 1, confirm: true, reason: 'confirm' }, exec(AGENT))) as { id: string; revision: number }
  assert.equal(updated.revision, 2)

  const forgotten = (await forget.execute({ id: updated.id, reason: 'user asked' }, exec(AGENT))) as { forgottenIds: string[] }
  assert.deepEqual(forgotten.forgottenIds, [updated.id])
  assert.equal(store.readRecord(updated.id), undefined)
})

test('a hand-edited file does not block a hash-less update: disk revision is the authority', async () => {
  const { harness: ctx, store } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const update = ctx.registered.find((tool) => tool.name === 'memory_update')!
  const created = (await remember.execute({ content: 'v1', kind: 'semantic', key: 'a.b' }, exec(AGENT))) as { id: string; path: string }
  // External hand edit, same revision: the store journals the edit and
  // re-reads from disk; the hash-less update proceeds on top of it. The
  // replacement targets the body (after the frontmatter close), never the
  // `ohmymemo/v1` schema discriminator.
  const abs = join(store.root, ...created.path.split('/'))
  const text = readFileSync(abs, 'utf8')
  writeFileSync(abs, text.replace('\n\nv1\n', '\n\nv1-hand-edited\n'))
  const updated = (await update.execute({ id: created.id, ifRevision: 1, confirm: true, reason: 'r' }, exec(AGENT))) as { id: string; revision: number }
  assert.equal(updated.revision, 2)
  assert.ok(store.readRecord(created.id)!.record.body.includes('v1-hand-edited'), 'the update applied to the disk state, not a cached view')
})

test('explicit ifHash mismatch still fails (opt-in hash CAS is enforced when carried)', async () => {
  const { harness: ctx, store } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  const update = ctx.registered.find((tool) => tool.name === 'memory_update')!
  const created = (await remember.execute({ content: 'v1', kind: 'semantic', key: 'a.b' }, exec(AGENT))) as { id: string }
  const realHash = store.readRecord(created.id)!.hash
  // Correct hash carried → same-revision hand-edit protection stays available.
  await update.execute({ id: created.id, ifRevision: 1, ifHash: realHash, confirm: true, reason: 'ok' }, exec(AGENT))
  const other = (await remember.execute({ content: 'v2', kind: 'semantic', key: 'c.d' }, exec(AGENT))) as { id: string }
  await assert.rejects(
    () => update.execute({ id: other.id, ifRevision: 1, ifHash: 'sha256:' + '0'.repeat(64), confirm: true, reason: 'stale' }, exec(AGENT)),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_CAS_HASH')
      return true
    },
  )
  await assert.rejects(
    () => update.execute({ id: other.id, ifRevision: 99, confirm: true, reason: 'stale' }, exec(AGENT)),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_CAS_REVISION')
      return true
    },
  )
})

test('every successful write notes the session self-write capsule digest', async () => {
  const { harness: ctx, service } = await setup()
  const remember = ctx.registered.find((tool) => tool.name === 'memory_remember')!
  await remember.execute({ content: '自写豁免锚点。', kind: 'semantic', key: 'a.b' }, exec(AGENT))
  // The exact digest the context row will compose at the next turn boundary:
  const input = service.capsuleInput(process.cwd())
  const { composeCapsule } = await import('../src/capsule.ts')
  const capsule = composeCapsule({
    entries: input.entries,
    userScope: 'user',
    root: input.root,
    topEntries: input.topEntries,
    summaryChars: input.summaryChars,
    budgetBytes: input.budgetBytes,
    now: new Date(),
    decayHorizons: input.decayHorizons,
  })
  assert.equal(service.hasSelfWriteDigest('session-42', capsule.digest), true, 'the post-write digest is exempt for this session')
  assert.equal(service.hasSelfWriteDigest('session-other', capsule.digest), false, 'exemption is per-session')
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
  const update = byName.get('memory_update')!
  const forget = byName.get('memory_forget')!

  const created = (await remember.execute({ content: '契约测试锚点 zanzibar。', kind: 'semantic', key: 'contract.anchor' }, exec(AGENT))) as { id: string }
  const second = await remember.execute({ content: '第二条契约样本。', kind: 'procedural', key: 'contract.second' }, exec(AGENT))
  // Sequential on purpose: update and forget touch the same record, and the
  // store's write lock must see them in program order for the CAS to hold.
  const updated = await update.execute({ id: created.id, ifRevision: 1, confirm: true, reason: 'contract' }, exec(AGENT))
  const forgotten = await forget.execute({ id: created.id, reason: 'contract' }, exec(AGENT))

  const samples = [
    ['memory_remember', second],
    ['memory_update', updated],
    ['memory_forget', forgotten],
  ] as const
  for (const [toolName, value] of samples) {
    const tool = byName.get(toolName)!
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
