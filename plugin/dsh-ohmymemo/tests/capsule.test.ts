import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeEntry } from '../src/catalog.ts'
import { CAPSULE_DISCLAIMER, USER_INDEX_REL, budgetFrom, composeCapsule, digestFromText, lastCapsuleDigest, replacementPreface, workspaceIndexRel } from '../src/capsule.ts'
import { decayFactor, decayWeight } from '../src/decay.ts'
import { baseRecord } from './helpers/records.ts'

const WS = `ws_${'01J5G0'}${'Z0'.repeat(10)}`
const NOW = new Date('2026-09-12T08:00:00.000Z')
const HOR = { semantic: 365, procedural: 180, episodic: 90 }

function entry(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof makeEntry> {
  const record = baseRecord({ id, pinned: true, body: `记忆 ${id} 的内容。`, ...overrides } as Parameters<typeof baseRecord>[0])
  return makeEntry({ record, relPath: `scopes/user/semantic/${id}.md`, absPath: `/store/${id}`, hash: `sha256:${id}`, bytes: 10, mtimeMs: 0 })
}

function input(entries: Parameters<typeof composeCapsule>[0]['entries'], extra: Partial<Parameters<typeof composeCapsule>[0]> = {}): Parameters<typeof composeCapsule>[0] {
  return { entries, userScope: 'user', root: '/store', topEntries: 5, summaryChars: 120, budgetBytes: 8192, now: NOW, decayHorizons: HOR, ...extra }
}

test('capsule carries the authority disclaimer, ids and digest marker', () => {
  const capsule = composeCapsule(input([entry('mem_a')]))
  assert.ok(capsule.text.startsWith(CAPSULE_DISCLAIMER))
  assert.ok(capsule.text.includes('[mem_a]'))
  assert.match(capsule.text, /\[ohmymemo-capsule digest=[0-9a-f]{16}\]$/)
  assert.deepEqual(capsule.memoryIds, ['mem_a'])
  assert.equal(capsule.truncated, false)
  assert.equal(digestFromText(capsule.text), capsule.digest)
})

test('capsule is an index pointer: per-scope pointer lines with counts, top bullets without paths', () => {
  const wsEntry = makeEntry({
    record: baseRecord({ id: 'mem_ws', pinned: true, scope: `workspace:${WS}`, key: 'workflow.build', body: '工作区记忆。' }),
    relPath: `scopes/workspaces/${WS}/semantic/mem_ws.md`, absPath: '/x', hash: 'h', bytes: 1, mtimeMs: 0,
  })
  const capsule = composeCapsule(input([entry('mem_a'), entry('mem_b'), wsEntry], { workspaceScope: `workspace:${WS}` }))
  const text = capsule.text
  assert.ok(text.includes('【记忆库】/store'), 'prints the store root for read/grep')
  assert.ok(text.includes(`${USER_INDEX_REL}（2 条）`), 'user index pointer with the full count')
  assert.ok(text.includes(`${workspaceIndexRel(`workspace:${WS}`)}（1 条）`), 'workspace index pointer with the full count')
  assert.ok(text.includes('· [mem_a] (semantic · preference.communication.language) 记忆 mem_a 的内容。'), 'top bullet is a one-line summary')
  assert.ok(!text.includes('→ scopes/'), 'bullets stay lean: file paths live in the index files, not the capsule')
  assert.ok(text.includes('read 索引中给出的文件路径'), 'closing line hands off to read/grep')
  assert.deepEqual(capsule.scopeIds.sort(), [`workspace:${WS}`, 'user'].sort())
})

test('unpinned active entries enter the capsule (index-first covers episodic/workspace recall)', () => {
  const capsule = composeCapsule(input([entry('mem_unpinned', { pinned: false })]))
  assert.deepEqual(capsule.memoryIds, ['mem_unpinned'])
})

test('top-N per scope is capped by capsule_top_entries and flagged as truncated', () => {
  const entries = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((letter, index) => entry(`mem_${letter}`, { importance: 0.9 - index * 0.1 }))
  const capsule = composeCapsule(input(entries, { topEntries: 3 }))
  assert.deepEqual(capsule.memoryIds, ['mem_a', 'mem_b', 'mem_c'], 'top-3 by importance/weight, never fs order')
  assert.equal(capsule.truncated, true)
  assert.ok(!capsule.text.includes('[mem_d]'))
  assert.ok(capsule.text.includes('（7 条）'), 'the pointer line still reports the full membership')
})

test('budget backstop truncates deterministically and keeps the skeleton readable', () => {
  const entries = ['a', 'b', 'c', 'd'].map((letter, index) => entry(`mem_${letter}`, { body: `记忆 ${letter}：${'内容'.repeat(60)}（${index}）`, importance: 1 - index * 0.1 }))
  const capsule = composeCapsule(input(entries, { budgetBytes: 1200 }))
  assert.equal(capsule.truncated, true)
  assert.ok(capsule.memoryIds.length < entries.length)
  assert.ok(capsule.text.startsWith(CAPSULE_DISCLAIMER), 'disclaimer survives any budget')
  // The pointer line must not promise more rows than it inlines.
  assert.ok(capsule.text.includes('内联 1/4 条'), `pointer line downgraded on budget cut, got:\n${capsule.text}`)
  assert.ok(!capsule.text.includes('最相关 4 条'))
  assert.deepEqual(capsule.memoryIds, [...capsule.memoryIds].sort((a, b) => {
    const rank = (id: string): number => entries.findIndex((e) => e.record.id === id)
    return rank(a) - rank(b)
  }), 'kept entries follow the deterministic ranking, never fs order')
})

test('empty capsule states so explicitly and still digests', () => {
  const capsule = composeCapsule(input([entry('x', { pinned: false, status: 'superseded' })]))
  assert.deepEqual(capsule.memoryIds, [])
  assert.ok(capsule.text.includes('没有可索引的 active 记忆'))
  assert.match(capsule.digest, /^[0-9a-f]{16}$/)
})

test('decayed entries sink to the bottom but stay listed (the index must be complete)', () => {
  const fresh = entry('mem_fresh_unconfirmed', { confirmed: false, importance: 0.9, key: 'preference.fresh', created_at: '2026-09-10T00:00:00.000Z' })
  const stale = entry('mem_stale_unconfirmed', { confirmed: false, importance: 0.9, key: 'preference.stale', created_at: '2026-01-01T00:00:00.000Z' })
  const dead = entry('mem_dead_unconfirmed', { confirmed: false, importance: 0.9, key: 'preference.dead', created_at: '2025-01-01T00:00:00.000Z' })
  const capsule = composeCapsule(input([stale, dead, fresh]))
  assert.deepEqual(capsule.memoryIds, ['mem_fresh_unconfirmed', 'mem_stale_unconfirmed', 'mem_dead_unconfirmed'], 'decayWeight ordering: freshest first, most-decayed last, none dropped')
  const lines = capsule.text.split('\n').filter((line) => line.startsWith('  · ['))
  assert.match(lines[0]!, /mem_fresh_unconfirmed/)
  assert.match(lines[lines.length - 1]!, /mem_dead_unconfirmed/)
})

test('index rel-path helpers derive the two agent-facing files', () => {
  assert.equal(USER_INDEX_REL, 'views/index-user.md')
  assert.equal(workspaceIndexRel(`workspace:${WS}`), `views/index-workspace-${WS}.md`)
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
    dream_model_provider: '',
    dream_model: '',
    dream_effort: '',
    auto_consolidation: false,
    watch: true,
    max_record_bytes: 16384,
    max_search_results: 8,
    max_get_records: 8,
    max_injected_bytes: 8192,
    capsule_top_entries: 5,
    index_entry_summary_chars: 120,
    index_max_entries: 200,
    candidate_retention_days: 30,
    decay_horizon_days_semantic: 365,
    decay_horizon_days_procedural: 180,
    decay_horizon_days_episodic: 90,
  }
}

const DAY = 86_400_000

test('decayFactor follows the piecewise curve at H/2, H and 2H boundaries', () => {
  const created = '2026-01-01T00:00:00.000Z'
  const at = (days: number): Date => new Date(Date.parse(created) + days * DAY)
  const fresh: Parameters<typeof decayFactor>[0] = { confirmed: false, created_at: created }
  assert.equal(decayFactor(fresh, at(0), 100), 1)
  assert.equal(decayFactor(fresh, at(50), 100), 1, 'age = H/2 keeps full weight')
  assert.ok(decayFactor(fresh, at(50.0001), 100) < 1 && decayFactor(fresh, at(50.0001), 100) > 0.2, 'just past H/2 slides')
  assert.ok(Math.abs(decayFactor(fresh, at(75), 100) - 0.6) < 1e-9, 'midpoint of the first ramp is 0.6')
  assert.ok(Math.abs(decayFactor(fresh, at(100), 100) - 0.2) < 1e-9, 'age = H lands at 0.2')
  assert.ok(Math.abs(decayFactor(fresh, at(150), 100) - 0.1) < 1e-9, 'midpoint of the second ramp is 0.1')
  assert.equal(decayFactor(fresh, at(200), 100), 0, 'age = 2H is zero weight')
  assert.equal(decayFactor(fresh, at(400), 100), 0, 'beyond 2H stays zero')
})

test('decayFactor: confirmed never decays; last_evidenced_at resets the age basis', () => {
  const created = '2026-01-01T00:00:00.000Z'
  const now = new Date(Date.parse(created) + 500 * DAY)
  assert.equal(decayFactor({ confirmed: true, created_at: created }, now, 100), 1, 'confirmed ≡ 1')
  assert.equal(decayFactor({ confirmed: false, created_at: created, last_evidenced_at: new Date(Date.parse(created) + 480 * DAY).toISOString() }, now, 100), 1, 'recent evidence keeps full weight')
  // updated_at is deliberately NOT part of the signature: metadata revisions are not evidence.
  const decayed = decayFactor({ confirmed: false, created_at: created }, now, 100)
  assert.equal(decayed, 0)
})

test('decayWeight multiplies importance by the recency factor per kind horizon', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')
  const semantic = baseRecord({ kind: 'semantic', confirmed: false, importance: 0.5, created_at: '2025-12-17T00:00:00.000Z' }) // age 15d
  const episodic = baseRecord({ kind: 'episodic', confirmed: false, importance: 0.5, created_at: '2025-12-17T00:00:00.000Z' })
  const semanticWeight = decayWeight(semantic, now, { semantic: 100, procedural: 100, episodic: 7 })
  const episodicWeight = decayWeight(episodic, now, { semantic: 100, procedural: 100, episodic: 7 })
  assert.equal(semanticWeight, 0.5, 'age 15d ≤ semantic H/2 keeps importance × 1')
  assert.equal(episodicWeight, 0, 'age 15d ≥ 2×episodic horizon (7d) is zero')
})
