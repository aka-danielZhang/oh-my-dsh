import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEntry } from '../src/catalog.ts'
import { CAPSULE_DISCLAIMER, budgetFrom, composeCapsule, digestFromText, lastCapsuleDigest, replacementPreface } from '../src/capsule.ts'
import { baseRecord } from './helpers/records.ts'

const WS = `ws_${'01J5G0'}${'Z0'.repeat(10)}`

function entry(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof makeEntry> {
  const record = baseRecord({ id, pinned: true, body: `记忆 ${id} 的内容。`, ...overrides } as Parameters<typeof baseRecord>[0])
  return makeEntry({ record, relPath: `scopes/user/semantic/${id}.md`, absPath: `/store/${id}`, hash: `sha256:${id}`, bytes: 10, mtimeMs: 0 })
}

test('capsule carries the authority disclaimer, ids and digest marker', () => {
  const capsule = composeCapsule({ entries: [entry('mem_a')], userScope: 'user', budgetBytes: 8192, now: new Date() })
  assert.ok(capsule.text.startsWith(CAPSULE_DISCLAIMER))
  assert.ok(capsule.text.includes('[mem_a]'))
  assert.match(capsule.text, /\[ohmymemo-capsule digest=[0-9a-f]{16}\]$/)
  assert.deepEqual(capsule.memoryIds, ['mem_a'])
  assert.equal(capsule.truncated, false)
  assert.equal(digestFromText(capsule.text), capsule.digest)
})

test('only core entries enter the capsule; workspace ranks first; confirmed beats unconfirmed', () => {
  const wsEntry = makeEntry({
    record: baseRecord({ id: 'mem_ws', pinned: true, scope: `workspace:${WS}`, key: 'workflow.build', body: '工作区记忆。' }),
    relPath: `scopes/workspaces/${WS}/semantic/mem_ws.md`, absPath: '/x', hash: 'h', bytes: 1, mtimeMs: 0,
  })
  const capsule = composeCapsule({
    entries: [entry('mem_user_unpinned', { pinned: false }), entry('mem_user_confirmed', { confirmed: true }), entry('mem_user_plain'), wsEntry],
    userScope: 'user',
    workspaceScope: `workspace:${WS}`,
    budgetBytes: 8192,
    now: new Date(),
  })
  const ids = capsule.text.split('\n').filter((line) => line.startsWith('- [')).map((line) => (/\[(mem_[^\]]+)\]/.exec(line) ?? [])[1])
  assert.deepEqual(ids, ['mem_ws', 'mem_user_confirmed', 'mem_user_plain'])
  assert.deepEqual(capsule.scopeIds.sort(), [`workspace:${WS}`, 'user'].sort())
})

test('budget truncation is deterministic and flagged', () => {
  const entries = ['mem_a', 'mem_b', 'mem_c', 'mem_d'].map((id, index) => entry(id, { body: `记忆 ${id}：${'内容'.repeat(20)}（${index}）`, importance: 1 - index * 0.1 }))
  const capsule = composeCapsule({ entries, userScope: 'user', budgetBytes: 400, now: new Date() })
  assert.equal(capsule.truncated, true)
  assert.ok(capsule.memoryIds.length < entries.length)
  assert.deepEqual(capsule.memoryIds, [...capsule.memoryIds].sort((a, b) => {
    const rank = (id: string): number => entries.findIndex((e) => e.record.id === id)
    return rank(a) - rank(b)
  }), 'kept entries follow the deterministic ranking, never fs order')
})

test('empty capsule states so explicitly and still digests', () => {
  const capsule = composeCapsule({ entries: [entry('x', { pinned: false })], userScope: 'user', budgetBytes: 8192, now: new Date() })
  assert.deepEqual(capsule.memoryIds, [])
  assert.ok(capsule.text.includes('没有需要注入的置顶记忆'))
  assert.match(capsule.digest, /^[0-9a-f]{16}$/)
})

test('lastCapsuleDigest scans the surface backwards for our plugin only', () => {
  const digest = 'abcdef0123456789'
  const messages: Record<number, { text: string; sourcePlugin?: string } | undefined> = {
    1: { text: '普通用户消息' },
    2: { text: `capsule v1 [ohmymemo-capsule digest=${digest}]`, sourcePlugin: 'dsh-ohmymemo-context' },
    3: { text: '之后的普通消息', sourcePlugin: 'other-plugin' },
  }
  const found = lastCapsuleDigest((seq) => messages[seq], [1, 2, 3], 'dsh-ohmymemo-context')
  assert.equal(found, digest)
  assert.equal(lastCapsuleDigest((seq) => messages[seq], [1, 3], 'dsh-ohmymemo-context'), undefined)
  assert.equal(lastCapsuleDigest(() => undefined, [], 'dsh-ohmymemo-context'), undefined)
})

test('replacement preface names the superseded digest', () => {
  const preface = replacementPreface('deadbeef00000000')
  assert.ok(preface.includes('deadbeef00000000'))
  assert.ok(preface.includes('替换'))
})

test('budgetFrom clamps to a sane floor', () => {
  assert.equal(budgetFrom({ ...minimalConfig(), max_injected_bytes: 8192 }), 8192)
  assert.equal(budgetFrom({ ...minimalConfig(), max_injected_bytes: 8 }), 512)
})

function minimalConfig(): Parameters<typeof budgetFrom>[0] {
  return {
    schema: 'ohmymemo-config/v1',
    capture_mode: 'direct',
    remember_direct_facts: true,
    allow_inference_candidates: false,
    dream_schedule_local_time: '02:00',
    auto_consolidation: false,
    watch: true,
    max_record_bytes: 16384,
    max_search_results: 8,
    max_get_records: 8,
    max_injected_bytes: 8192,
    candidate_retention_days: 30,
  }
}
