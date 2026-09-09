import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEntry } from '../src/catalog.ts'
import { isRecallable, makeSnippet, searchEntries, tokenizeQuery, type SearchContext } from '../src/search.ts'
import { baseRecord } from './helpers/records.ts'

const NOW = new Date('2026-09-03T12:00:00.000Z')

function entry(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof makeEntry> {
  const record = baseRecord({ id, key: 'preference.package-manager', body: '用户这个项目固定使用 pnpm 管理依赖。', ...overrides } as Parameters<typeof baseRecord>[0])
  return makeEntry({ record, relPath: `scopes/user/semantic/${id}.md`, absPath: `/store/scopes/user/semantic/${id}.md`, hash: `sha256:${id}`, bytes: 100, mtimeMs: 0 })
}

function context(overrides: Partial<SearchContext> = {}): SearchContext {
  return { scopes: ['user'], now: NOW, limit: 8, ...overrides }
}

test('tokenizeQuery normalizes NFKC + case folding', () => {
  const { tokens, phrase } = tokenizeQuery('ＰＮＰＭ 管理')
  assert.deepEqual(tokens, ['pnpm', '管理'])
  assert.equal(phrase, 'pnpm 管理')
})

test('hard filters: privacy, status, validity, scope, quarantine', () => {
  const ctx = context()
  assert.equal(isRecallable(entry('a'), ctx, false), true)
  assert.equal(isRecallable(entry('a', { privacy: 'sensitive' }), ctx, false), false)
  assert.equal(isRecallable(entry('a', { status: 'superseded' }), ctx, false), false)
  assert.equal(isRecallable(entry('a', { status: 'disputed' }), ctx, false), false)
  assert.equal(isRecallable(entry('a', { status: 'disputed' }), ctx, true), true)
  assert.equal(isRecallable(entry('a', { valid_from: '2026-09-04T00:00:00.000Z' }), ctx, false), false)
  assert.equal(isRecallable(entry('a', { valid_until: '2026-09-01T00:00:00.000Z' }), ctx, false), false)
  assert.equal(isRecallable(entry('a', { valid_until: null }), ctx, false), true)
  const quarantined = entry('a')
  quarantined.quarantine = 'duplicate-id'
  assert.equal(isRecallable(quarantined, ctx, false), false)
  const otherScope = entry('a', { scope: 'workspace:ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0' })
  assert.equal(isRecallable(otherScope, ctx, false), false, 'scope outside the resolved set')
})

test('ranking: exact key beats body phrase; workspace boost wins; disputed ranks below active', () => {
  const a = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0', { key: 'preference.package-manager', body: '无关正文。' })
  const b = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z1', { key: 'unrelated.key', body: 'pnpm 是用户偏好的包管理器。' })
  const result = searchEntries([a, b], { query: 'preference.package-manager' }, context())
  assert.equal(result.hits[0]?.id, a.record.id)

  const wsScope = 'workspace:ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'
  const userHit = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z2', { key: 'profile.stack', body: 'pnpm 用户。' })
  const wsHit = makeEntry({
    record: baseRecord({ id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z3', scope: wsScope, key: 'workflow.build', body: '用 pnpm。' }),
    relPath: 'scopes/workspaces/ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0/semantic/mem_x.md',
    absPath: '/x', hash: 'h', bytes: 1, mtimeMs: 0,
  })
  const ranked = searchEntries([userHit, wsHit], { query: 'pnpm' }, context({ scopes: ['user', wsScope], workspaceScope: wsScope }))
  assert.equal(ranked.hits[0]?.id, wsHit.record.id, 'workspace hit outranks the user hit')

  const disputed = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z4', { key: 'x.y', body: 'pnpm pnpm', status: 'disputed' })
  const active = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z5', { key: 'x.z', body: 'pnpm', importance: 0.1 })
  const mixed = searchEntries([disputed, active], { query: 'pnpm', includeDisputed: true }, context())
  assert.equal(mixed.hits[0]?.id, active.record.id)
})

test('snippet centers the first match and bounds length', () => {
  const snippet = makeSnippet('前缀'.repeat(30) + '关键词' + '后缀'.repeat(30), ['关键词'], '')
  assert.ok(snippet.includes('关键词'))
  assert.ok(snippet.length <= 126)
  assert.ok(snippet.startsWith('…') || snippet.endsWith('…') || snippet.length <= 120)
})

test('search returns bounded hits with truncated flag and skips empty queries', () => {
  assert.deepEqual(searchEntries([entry('a')], { query: '   ' }, context()), { hits: [], truncated: false })
  const many = Array.from({ length: 12 }, (_, i) => entry(`mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z${i.toString(16)}`.padEnd(30, '0').slice(0, 30), { key: `k.${i}`, body: `pnpm ${i}` }))
  const result = searchEntries(many, { query: 'pnpm' }, context({ limit: 4 }))
  assert.equal(result.hits.length, 4)
  assert.equal(result.truncated, true)
  for (const hit of result.hits) {
    assert.equal(typeof hit.revision, 'number')
    assert.ok(hit.snippet.length > 0)
    assert.equal(hit.status, 'active')
  }
})

test('kind filter narrows results', () => {
  const semantic = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z6', { kind: 'semantic', body: 'pnpm' })
  const episodic = entry('mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z7', { kind: 'episodic', body: 'pnpm 事故' })
  const result = searchEntries([semantic, episodic], { query: 'pnpm', kinds: ['episodic'] }, context())
  assert.deepEqual(result.hits.map((hit) => hit.id), [episodic.record.id])
})
