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
  assert.equal(service.hasMemoryKey('user', 'semantic', 'preference.deferred'), true, 'writers still see the key occupied and hit the barrier')
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
