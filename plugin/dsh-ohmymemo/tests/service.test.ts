import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { writeFileAtomic } from '../src/atomic.ts'
import { serializeTombstone } from '../src/schema.ts'
import { createOhMyMemoService } from '../src/service.ts'
import { OhMyMemoStore } from '../src/store.ts'
import { scratchRoot } from './helpers/scratch.ts'

async function openService(root = scratchRoot()): Promise<{ service: ReturnType<typeof createOhMyMemoService>; store: OhMyMemoStore }> {
  const store = new OhMyMemoStore({ root, lockTimeoutMs: 400, watch: false, now: (): Date => new Date('2026-09-03T10:00:00.000Z') })
  await store.open()
  return { service: createOhMyMemoService(store), store }
}

test('search scopes: current = user + resolved workspace; all spans every scope', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ohmymemo-svc-'))
  const { service } = await openService()
  await service.remember({ content: '全局偏好 pnpm。', kind: 'semantic', scope: 'user', key: 'preference.package-manager', pinned: true })
  await service.remember({ content: '本项目用 pnpm。', kind: 'procedural', scope: 'workspace', cwd: project, key: 'workflow.build', pinned: true })

  const current = await service.search({ query: 'pnpm' }, { cwd: project })
  assert.equal(current.hits.length, 2)
  const userOnly = await service.search({ query: 'pnpm', scope: 'user' }, { cwd: project })
  assert.equal(userOnly.hits.length, 1)
  assert.equal(userOnly.hits[0]?.scope, 'user')
  const wsOnly = await service.search({ query: 'pnpm', scope: 'workspace' }, { cwd: project })
  assert.equal(wsOnly.hits.length, 1)
  assert.match(wsOnly.hits[0]?.scope ?? '', /^workspace:/)
  const other = await service.search({ query: 'pnpm', scope: 'workspace' }, { cwd: tmpdir() })
  assert.equal(other.hits.length, 0, 'cwd without a registered scope sees no workspace memories')
})

test('get re-reads from disk and redacts sensitive bodies', async () => {
  const { service } = await openService()
  const normal = await service.remember({ content: '普通事实。', kind: 'semantic', scope: 'user', key: 'a.b', pinned: true })
  const sensitive = await service.remember({ content: '健康状况备注。', kind: 'semantic', scope: 'user', key: 'c.d', privacy: 'sensitive', pinned: false })
  const [a, b] = await service.get([normal.id, sensitive.id])
  assert.equal(a?.body, '普通事实。')
  assert.equal(b?.redacted, true)
  assert.ok(!JSON.stringify(b).includes('健康状况'), 'sensitive body never leaves the store')
})

test('a published tombstone is a read barrier even while the body lingers', async () => {
  const root = scratchRoot()
  const { service } = await openService(root)
  const created = await service.remember({ content: '延迟删除期间的残留正文。', kind: 'semantic', scope: 'user', key: 'preference.deferred', pinned: true })

  // Another process published the tombstone first; body deletion has not
  // happened yet (deferred/conflicted recovery) — the record must not be
  // recallable through any outward path.
  const tombstone = {
    schema: 'ohmymemo-tombstone/v1' as const,
    id: 'tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    scope: 'user',
    key: 'preference.deferred',
    memory_ids: [created.id],
    forgotten_at: '2026-09-03T10:05:00.000Z',
    reason: 'user-request',
  }
  writeFileAtomic(join(root, 'tombstones', `${tombstone.id}.yaml`), serializeTombstone(tombstone))

  const search = await service.search({ query: '延迟删除' })
  assert.equal(search.hits.length, 0, 'search never recalls a tombstoned body')
  assert.deepEqual(await service.get([created.id]), [], 'get refuses the tombstoned id')
  assert.equal(service.capsuleInput(undefined).entries.some(entry => entry.record.id === created.id), false, 'capsule omits it')
  const tree = service.displayTree(100, 64_000)
  assert.equal(tree.files.some(file => file.path.includes(created.id)), false, 'browser hides the residue file')
  assert.equal(service.hasMemoryKey('user', 'semantic', 'preference.deferred'), true, 'a tombstone keeps the (scope, key) pair occupied for writers of every kind')
})

test('hasMemoryKey narrows to the active set: archived records never block re-remembering', async () => {
  const { service } = await openService()
  const first = await service.remember({ content: 'v1', kind: 'semantic', scope: 'user', key: 'preference.retired', pinned: true })
  const firstHash = (await service.get([first.id]))[0]!.hash
  // Supersede under a DIFFERENT key: the only remaining holder of the old
  // key is the archived (superseded) record.
  await service.update({ id: first.id, ifRevision: 1, ifHash: firstHash, content: 'v2', key: 'preference.successor', reason: 'user correction' })
  assert.equal(service.hasMemoryKey('user', 'semantic', 'preference.retired'), false, 'archived records do not occupy their key')
  assert.equal(service.hasMemoryKey('user', 'semantic', 'preference.successor'), true, 'the active successor does')
  const recreated = await service.remember({ content: '重新提到的旧事实。', kind: 'semantic', scope: 'user', key: 'preference.retired', pinned: true })
  assert.match(recreated.id, /^mem_/)
})

test('sensitive provenance keeps locators but never quote text', async () => {
  const { service } = await openService()
  const created = await service.remember({
    content: '敏感偏好。',
    kind: 'semantic',
    scope: 'user',
    key: 'sensitive.quote',
    privacy: 'sensitive',
    pinned: false,
    sources: [{
      type: 'cross_session_inference',
      session_id: 'sess_x',
      event_seq: 7,
      quote_hash: 'sha256:' + 'a'.repeat(64),
      quote_preview: '我的敏感原话是这句话',
      observed_at: '2026-09-04T01:02:03.000Z',
    }],
  })
  const [view] = await service.get([created.id])
  assert.equal(view?.redacted, true)
  assert.equal(view?.sources[0]?.quote_preview, undefined, 'quote text never leaves the store')
  assert.equal(view?.sources[0]?.quote_hash, 'sha256:' + 'a'.repeat(64), 'locator hash survives')
  assert.equal(view?.sources[0]?.session_id, 'sess_x')
  assert.ok(!JSON.stringify(view).includes('敏感原话'), 'no direct-human quote leaks through provenance')
})

test('update resolutions: replace supersedes, dispute symmetrizes, reactivate restores', async () => {
  const { service } = await openService()
  const first = await service.remember({ content: 'v1', kind: 'semantic', scope: 'user', key: 'preference.x', pinned: true })
  const second = await service.remember({ content: 'v2', kind: 'semantic', scope: 'user', key: 'preference.y', pinned: true })

  const firstHash = (await service.get([first.id]))[0]!.hash
  const replaced = await service.update({ id: first.id, ifRevision: 1, ifHash: firstHash, content: 'v1 修正版', reason: 'user correction' })
  assert.notEqual(replaced.id, first.id)
  assert.equal(replaced.supersededId, first.id)

  const secondHash = (await service.get([second.id]))[0]!.hash
  const disputed = await service.update({ id: second.id, ifRevision: 1, ifHash: secondHash, resolution: 'dispute', contradictsWith: [replaced.id], reason: 'unclear conflict' })
  assert.equal(disputed.status, 'disputed')
  const [view] = await service.get([second.id])
  assert.deepEqual(view?.contradicts, [replaced.id])
  const other = (await service.get([replaced.id]))[0]
  assert.equal(other?.status, 'disputed', 'counterpart is disputed too (symmetric link)')
  assert.ok(other?.contradicts.includes(second.id))

  const reactivatedHash = (await service.get([second.id]))[0]!.hash
  const reactivated = await service.update({ id: second.id, ifRevision: 2, ifHash: reactivatedHash, resolution: 'reactivate', reason: 'user resolved it' })
  assert.equal(reactivated.status, 'active')
})

test('capsuleInput scopes entries and reports the budget; scopeForCwd never creates', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ohmymemo-svc2-'))
  const { service } = await openService()
  await service.remember({ content: '全局。', kind: 'semantic', scope: 'user', key: 'u.a', pinned: true })
  await service.remember({ content: '工作区。', kind: 'semantic', scope: 'workspace', cwd: project, key: 'w.a', pinned: true })
  await service.remember({ content: '别处。', kind: 'semantic', scope: 'workspace', cwd: mkdtempSync(join(tmpdir(), 'ohmymemo-svc3-')), key: 'w.b', pinned: true })

  const input = service.capsuleInput(project)
  assert.match(input.workspaceScope ?? '', /^workspace:/)
  assert.equal(input.budgetBytes, 8192)
  const ids = input.entries.filter((e) => e.record.status === 'active').map((e) => e.record.key)
  assert.ok(ids.includes('u.a'))
  assert.ok(ids.includes('w.a'))
  assert.ok(!ids.includes('w.b'), 'other workspaces stay out')

  assert.equal(service.scopeForCwd('/definitely/not/registered'), undefined)
})

test('stats/doctor/subscribe/rebuildViews operate over the live store', async () => {
  const { service, store } = await openService()
  await service.remember({ content: 'x', kind: 'semantic', scope: 'user', key: 's.a', pinned: true })
  assert.equal(service.stats().active, 1)
  assert.deepEqual(service.doctor().filter((d) => d.severity === 'error'), [])
  let changed = 0
  const unsubscribe = service.subscribe(() => { changed += 1 })
  await service.remember({ content: 'y', kind: 'semantic', scope: 'user', key: 's.b', pinned: true })
  unsubscribe()
  assert.ok(changed > 0, 'store change events flow through the service')
  const written = await service.rebuildViews()
  assert.ok(written.includes('views/user-profile.md'))
  store.close()
})

test('curatorCatalog lists only active, normal, unconfirmed entries', async () => {
  const { service, store } = await openService()
  const plain = await service.remember({ content: '可整理的普通记忆。', kind: 'semantic', scope: 'user', key: 'c.a', pinned: true })
  await service.remember({ content: '确认过的记忆。', kind: 'semantic', scope: 'user', key: 'c.b', pinned: true, confirmed: true })
  await service.remember({ content: '敏感记忆。', kind: 'semantic', scope: 'user', key: 'c.c', pinned: true, privacy: 'sensitive' })
  const catalog = service.curatorCatalog()
  assert.deepEqual(catalog.entries.map((entry) => entry.id), [plain.id])
  assert.equal(catalog.entries[0]?.content, '可整理的普通记忆。')
  assert.equal(catalog.horizons.semantic, 365)
  store.close()
})

test('rememberFromDream resolves the workspace scope read-only and rejects unregistered cwds', async () => {
  const project = mkdtempSync(join(tmpdir(), 'ohmymemo-dream-svc-'))
  const { service } = await openService()
  const base = {
    content: '本项目发布前跑全量测试。',
    kind: 'procedural' as const,
    scopeHint: 'workspace' as const,
    keyHint: 'workflow.release',
    importance: 0.6,
    tags: ['release'],
    confidence: 0.82,
    source: { sessionId: 's', eventSeq: 1, messageId: 'm', time: '2026-09-09T22:10:00.000Z', cwd: project },
    quote: '发布前跑全量测试',
    quoteHash: 'sha256:q',
  }
  await assert.rejects(
    () => service.rememberFromDream(base),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_INVALID_SCOPE', 'an unregistered workspace never gets created by a dream write')
      return true
    },
  )
  // Register the scope via an explicit write, then the dream write resolves.
  await service.remember({ content: '本项目用 pnpm。', kind: 'semantic', scope: 'workspace', cwd: project, key: 'workspace.pkg', pinned: true })
  const result = await service.rememberFromDream(base)
  assert.equal(result.outcome, 'created')
  assert.match(result.scope, /^workspace:/)
  // Exact replay through the same service seam.
  const replay = await service.rememberFromDream(base)
  assert.equal(replay.outcome, 'already-present')
  assert.equal(replay.id, result.id)
})
