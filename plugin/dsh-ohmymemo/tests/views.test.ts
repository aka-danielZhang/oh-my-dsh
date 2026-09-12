import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeEntry } from '../src/catalog.ts'
import { composeIndexLine, composeScopeIndex, composeView, isCoreViewEntry, isIndexEntry, orderCoreEntries, rebuildViews, viewDigest } from '../src/views.ts'
import { defaultStoreConfig } from '../src/schema.ts'
import { baseRecord } from './helpers/records.ts'
import { scratchRoot } from './helpers/scratch.ts'

const WS = `ws_${'01J5G0'}${'Z0'.repeat(10)}`

function entry(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof makeEntry> {
  const record = baseRecord({ id, ...overrides } as Parameters<typeof baseRecord>[0])
  return makeEntry({ record, relPath: `scopes/user/semantic/${id}.md`, absPath: `/store/${id}`, hash: `sha256:${id}`, bytes: 10, mtimeMs: 0 })
}

const NOW = new Date('2026-09-03T10:00:00.000Z')

test('core view eligibility: active + normal + pinned + validity window, never quarantined', () => {
  assert.equal(isCoreViewEntry(entry('a'), NOW), true, 'base fixture is pinned')
  assert.equal(isCoreViewEntry(entry('a', { pinned: true }), NOW), true)
  assert.equal(isCoreViewEntry(entry('a', { pinned: true, status: 'disputed' }), NOW), false)
  assert.equal(isCoreViewEntry(entry('a', { pinned: true, status: 'expired' }), NOW), false, 'expired never re-enters views')
  assert.equal(isCoreViewEntry(entry('a', { pinned: true, privacy: 'sensitive' }), NOW), false)
  const quarantined = entry('a', { pinned: true })
  quarantined.quarantine = 'single-key-conflict'
  assert.equal(isCoreViewEntry(quarantined, NOW), false)
})

test('validity window gates capsule/views membership at read time', () => {
  assert.equal(isCoreViewEntry(entry('a', { valid_until: '2026-09-04T00:00:00.000Z', valid_from: null }), NOW), true, 'still valid')
  assert.equal(isCoreViewEntry(entry('a', { valid_until: '2026-09-03T10:00:00.000Z', valid_from: null }), NOW), false, 'valid_until passed (boundary is exclusive)')
  assert.equal(isCoreViewEntry(entry('a', { valid_until: '2027-01-01T00:00:00.000Z', valid_from: '2026-12-01T00:00:00.000Z' }), NOW), false, 'valid_from not reached')
  assert.equal(isCoreViewEntry(entry('a', { valid_until: null, valid_from: null }), NOW), true, 'no window = always eligible')
})

test('ordering: importance desc, then created_at asc, then id', () => {
  const low = entry('mem_a', { pinned: true, importance: 0.2, created_at: '2026-09-01T00:00:00.000Z' })
  const high = entry('mem_b', { pinned: true, importance: 0.9, created_at: '2026-09-02T00:00:00.000Z' })
  const sameHigh = entry('mem_c', { pinned: true, importance: 0.9, created_at: '2026-09-02T00:00:00.000Z' })
  const ordered = orderCoreEntries([low, high, sameHigh])
  assert.deepEqual(ordered.map((e) => e.record.id), ['mem_b', 'mem_c', 'mem_a'])
})

test('composeView emits the generated header, ids, digest and one line per memory', () => {
  const a = entry('mem_a', { pinned: true, confirmed: false, body: '用户更喜欢使用中文交流。' })
  const b = entry('mem_b', { pinned: true, confirmed: true, body: '第二 pinned 记忆。' })
  const text = composeView('User profile', 'user', [a, b], '2026-09-03T10:00:00.000Z')
  assert.match(text, /generated: true/)
  assert.match(text, /memory_ids: \[mem_a, mem_b\]/)
  assert.match(text, /digest: [0-9a-f]{16}/)
  assert.ok(text.includes('[mem_a] (semantic · preference.communication.language) 用户更喜欢使用中文交流。'))
  assert.ok(text.includes('confirmed'))
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'))
  // determinism: same inputs → same bytes
  assert.equal(composeView('User profile', 'user', [a, b], '2026-09-03T10:00:00.000Z'), text)
})

test('view digest is order- and revision-sensitive', () => {
  const a = entry('mem_a', { pinned: true, revision: 1 })
  const b = entry('mem_b', { pinned: true, revision: 1 })
  assert.equal(viewDigest([a, b]), viewDigest([b, a]), 'entries are canonically ordered first')
  const bumped = makeEntry({ ...a, record: { ...a.record, revision: 2 } })
  assert.notEqual(viewDigest([a]), viewDigest([bumped]))
})

test('rebuildViews writes the user profile and one file per workspace scope', () => {
  const root = scratchRoot()
  const wsEntry = makeEntry({
    record: baseRecord({ id: 'mem_ws', pinned: true, scope: `workspace:${WS}`, key: 'workflow.build' }),
    relPath: `scopes/workspaces/${WS}/semantic/mem_ws.md`,
    absPath: `/x`, hash: 'h', bytes: 1, mtimeMs: 0,
  })
  const catalog = {
    allEntries: () => [entry('mem_user', { pinned: true }), entry('mem_hidden', { pinned: false }), wsEntry],
    scopes: () => new Map([[WS, { wsId: WS, relPath: `scopes/workspaces/${WS}/scope.yaml`, scope: { canonical_path: '/tmp/p', dsh_workspace_id: null, created_at: '', updated_at: '', id: WS, schema: 'ohmymemo-scope/v1' as const } }]]),
  }
  const written = rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-03T10:00:00.000Z')
  assert.deepEqual(written, ['views/user-profile.md', `views/workspaces/${WS}.md`, 'views/index-user.md', `views/index-workspace-${WS}.md`])
  const profile = readFileSync(join(root, 'views', 'user-profile.md'), 'utf8')
  assert.ok(profile.includes('mem_user'))
  assert.ok(!profile.includes('mem_hidden'), 'unpinned records stay out of views')
  assert.ok(!profile.includes('mem_ws'), 'workspace records stay out of the user profile')
  const wsView = readFileSync(join(root, 'views', 'workspaces', `${WS}.md`), 'utf8')
  assert.ok(wsView.includes('mem_ws'))
  assert.equal(existsSync(join(root, 'views', 'user-profile.md')), true)
})

test('rebuildViews keeps bytes and stamp when nothing changed (config-only rebuild)', () => {
  const root = scratchRoot()
  const catalog = {
    allEntries: () => [entry('mem_user', { pinned: true })],
    scopes: () => new Map(),
  }
  const first = rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-09T10:00:00.000Z')
  const before = readFileSync(join(root, 'views', 'user-profile.md'), 'utf8')
  // A later no-op rebuild — e.g. the `config-updated` store event — must not
  // rewrite the file: generated_at, the file hash and the browser tree
  // generation all stay stable, so open pages keep their index.
  const second = rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-09T19:47:41.000Z')
  assert.deepEqual(second, first)
  const after = readFileSync(join(root, 'views', 'user-profile.md'), 'utf8')
  assert.equal(after, before)
  assert.ok(before.includes('generated_at: 2026-09-09T10:00:00.000Z'), 'the stamp is preserved on the skip')

  // A real data change still rewrites with the new stamp.
  const changed = {
    allEntries: () => [entry('mem_user', { pinned: true }), entry('mem_new', { pinned: true })],
    scopes: () => new Map(),
  }
  rebuildViews(root, changed, defaultStoreConfig(), '2026-09-09T19:47:43.000Z')
  const rewritten = readFileSync(join(root, 'views', 'user-profile.md'), 'utf8')
  assert.ok(rewritten.includes('mem_new'))
  assert.ok(rewritten.includes('generated_at: 2026-09-09T19:47:43.000Z'))
})

test('rebuildViews still rewrites when a validity window closes between generations', () => {
  const root = scratchRoot()
  const catalog = {
    allEntries: () => [entry('mem_temp', { pinned: true, valid_until: '2026-09-09T12:00:00.000Z', valid_from: null })],
    scopes: () => new Map(),
  }
  rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-09T10:00:00.000Z')
  assert.ok(readFileSync(join(root, 'views', 'user-profile.md'), 'utf8').includes('mem_temp'))
  rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-09T13:00:00.000Z')
  const expired = readFileSync(join(root, 'views', 'user-profile.md'), 'utf8')
  assert.ok(!expired.includes('mem_temp'), 'the entry left the view once valid_until passed')
  assert.ok(expired.includes('generated_at: 2026-09-09T13:00:00.000Z'))
})

// ------------------------------------------------- agent-facing indexes ----

const HOR = { semantic: 365, procedural: 180, episodic: 90 }

test('index eligibility: active + normal + validity window, pinned NOT required', () => {
  assert.equal(isIndexEntry(entry('a', { pinned: false }), NOW), true, 'unpinned entries are the point of the index')
  assert.equal(isIndexEntry(entry('a'), NOW), true)
  assert.equal(isIndexEntry(entry('a', { pinned: true, status: 'disputed' }), NOW), false)
  assert.equal(isIndexEntry(entry('a', { pinned: true, status: 'superseded' }), NOW), false)
  assert.equal(isIndexEntry(entry('a', { pinned: true, privacy: 'sensitive' }), NOW), false, 'sensitive never enters the agent index')
  assert.equal(isIndexEntry(entry('a', { pinned: true, valid_until: '2026-09-03T00:00:00.000Z' }), NOW), false)
  const quarantined = entry('a')
  quarantined.quarantine = 'duplicate-id'
  assert.equal(isIndexEntry(quarantined, NOW), false)
})

test('composeIndexLine: shared row shape with optional path and importance', () => {
  const line = composeIndexLine(entry('mem_a', { importance: 0.9, body: '动手改代码前先输出完整落地方案。' }), { summaryChars: 120, withPath: true, withImportance: true })
  assert.equal(line, '[mem_a] (semantic · preference.communication.language · importance 0.9) 动手改代码前先输出完整落地方案。 → scopes/user/semantic/mem_a.md')
  const lean = composeIndexLine(entry('mem_a'), { summaryChars: 120 })
  assert.ok(!lean.includes('importance') && !lean.includes('→'), 'capsule bullets stay lean')
})

test('composeIndexLine truncates long bodies to summaryChars with an ellipsis', () => {
  const body = '长'.repeat(300)
  const line = composeIndexLine(entry('mem_a', { body }), { summaryChars: 120 })
  const summary = line.slice(line.indexOf(') ') + 2)
  assert.ok(summary.startsWith('长'.repeat(119) + '…'), 'the ellipsis counts against the budget')
  assert.ok(!summary.includes('长'.repeat(120)))
})

test('composeScopeIndex: full membership, decay order, header contract and cap footer', () => {
  const unpinned = entry('mem_low', { pinned: false, importance: 0.2, key: 'note.old', created_at: '2026-09-01T00:00:00.000Z' })
  const high = entry('mem_high', { importance: 0.9, key: 'preference.high' })
  const dead = entry('mem_dead', { confirmed: false, importance: 0.9, key: 'preference.dead', created_at: '2024-01-01T00:00:00.000Z' })
  const text = composeScopeIndex('Memory index (user)', 'user', [unpinned, dead, high], '2026-09-12T08:00:00.000Z', { summaryChars: 120, maxEntries: 200, horizons: HOR, now: NOW })
  assert.match(text, /generated: true/)
  assert.match(text, /index: agent-facing/)
  assert.match(text, /memory_ids: \[mem_high, mem_low, mem_dead\]/, 'decayWeight desc: fresh confirmed first, fully-decayed (weight 0) last but present')
  assert.match(text, /digest: [0-9a-f]{16}/)
  assert.ok(text.includes('→ scopes/user/semantic/mem_high.md'), 'rows carry the store-relative path for read')
  assert.ok(!text.includes('另有'), 'nothing truncated below the cap')
  const capped = composeScopeIndex('Memory index (user)', 'user', [high, unpinned, dead], '2026-09-12T08:00:00.000Z', { summaryChars: 120, maxEntries: 2, horizons: HOR, now: NOW })
  assert.ok(capped.includes('另有 1 条未列出'), 'the overflow is counted in a footer note, never silently dropped')
  assert.ok(capped.includes('mem_high') && capped.includes('mem_low') && !capped.includes('[mem_dead]'))
})

test('rebuildViews writes index-user.md and one index file per workspace scope', () => {
  const root = scratchRoot()
  const wsEntry = makeEntry({
    record: baseRecord({ id: 'mem_ws', pinned: false, scope: `workspace:${WS}`, key: 'workflow.build' }),
    relPath: `scopes/workspaces/${WS}/semantic/mem_ws.md`,
    absPath: `/x`, hash: 'h', bytes: 1, mtimeMs: 0,
  })
  const catalog = {
    allEntries: () => [entry('mem_user', { pinned: true }), entry('mem_unpinned_user', { pinned: false, key: 'note.free' }), wsEntry],
    scopes: () => new Map([[WS, { wsId: WS, relPath: `scopes/workspaces/${WS}/scope.yaml`, scope: { canonical_path: '/tmp/p', dsh_workspace_id: null, created_at: '', updated_at: '', id: WS, schema: 'ohmymemo-scope/v1' as const } }]]),
  }
  const written = rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-12T08:00:00.000Z')
  assert.ok(written.includes('views/index-user.md'))
  assert.ok(written.includes(`views/index-workspace-${WS}.md`))
  const userIndex = readFileSync(join(root, 'views', 'index-user.md'), 'utf8')
  assert.ok(userIndex.includes('mem_user') && userIndex.includes('mem_unpinned_user'), 'the index is complete: pinned and unpinned alike')
  assert.ok(!userIndex.includes('mem_ws'), 'workspace records stay out of the user index')
  const wsIndex = readFileSync(join(root, 'views', `index-workspace-${WS}.md`), 'utf8')
  assert.ok(wsIndex.includes('mem_ws'))
})

test('rebuildViews no-op skip covers the index files too (stable stamp and bytes)', () => {
  const root = scratchRoot()
  const catalog = {
    allEntries: () => [entry('mem_user', { pinned: true })],
    scopes: () => new Map(),
  }
  rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-12T08:00:00.000Z')
  const before = readFileSync(join(root, 'views', 'index-user.md'), 'utf8')
  rebuildViews(root, catalog, defaultStoreConfig(), '2026-09-12T19:47:41.000Z')
  assert.equal(readFileSync(join(root, 'views', 'index-user.md'), 'utf8'), before, 'config-only rebuilds must not churn the index files')
  assert.ok(before.includes('generated_at: 2026-09-12T08:00:00.000Z'))
})
