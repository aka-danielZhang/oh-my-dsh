import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { makeEntry } from '../src/catalog.ts'
import { composeView, isCoreViewEntry, orderCoreEntries, rebuildViews, viewDigest } from '../src/views.ts'
import { defaultStoreConfig } from '../src/schema.ts'
import { baseRecord } from './helpers/records.ts'
import { scratchRoot } from './helpers/scratch.ts'

const WS = `ws_${'01J5G0'}${'Z0'.repeat(10)}`

function entry(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof makeEntry> {
  const record = baseRecord({ id, ...overrides } as Parameters<typeof baseRecord>[0])
  return makeEntry({ record, relPath: `scopes/user/semantic/${id}.md`, absPath: `/store/${id}`, hash: `sha256:${id}`, bytes: 10, mtimeMs: 0 })
}

test('core view eligibility: active + normal + pinned, never quarantined', () => {
  assert.equal(isCoreViewEntry(entry('a')), true, 'base fixture is pinned')
  assert.equal(isCoreViewEntry(entry('a', { pinned: true })), true)
  assert.equal(isCoreViewEntry(entry('a', { pinned: true, status: 'disputed' })), false)
  assert.equal(isCoreViewEntry(entry('a', { pinned: true, privacy: 'sensitive' })), false)
  const quarantined = entry('a', { pinned: true })
  quarantined.quarantine = 'single-key-conflict'
  assert.equal(isCoreViewEntry(quarantined), false)
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
  assert.deepEqual(written, ['views/user-profile.md', `views/workspaces/${WS}.md`])
  const profile = readFileSync(join(root, 'views', 'user-profile.md'), 'utf8')
  assert.ok(profile.includes('mem_user'))
  assert.ok(!profile.includes('mem_hidden'), 'unpinned records stay out of views')
  assert.ok(!profile.includes('mem_ws'), 'workspace records stay out of the user profile')
  const wsView = readFileSync(join(root, 'views', 'workspaces', `${WS}.md`), 'utf8')
  assert.ok(wsView.includes('mem_ws'))
  assert.equal(existsSync(join(root, 'views', 'user-profile.md')), true)
})
