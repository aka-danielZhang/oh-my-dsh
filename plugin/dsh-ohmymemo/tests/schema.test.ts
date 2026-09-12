import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  composeFrontmatter,
  defaultStoreConfig,
  detectSecretLike,
  normalizeKey,
  normalizeTag,
  normalizeText,
  parseManifest,
  parseRecord,
  parseScopeFile,
  parseStoreConfig,
  parseTombstone,
  serializeManifest,
  serializeRecord,
  serializeScopeFile,
  serializeStoreConfig,
  serializeTombstone,
  splitFrontmatter,
} from '../src/schema.ts'
import type { MemoryRecord } from '../src/types.ts'

function baseRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const at = '2026-09-03T10:00:00.000Z'
  return {
    schema: 'ohmymemo/v1',
    id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    revision: 1,
    scope: 'user',
    kind: 'semantic',
    key: 'preference.communication.language',
    cardinality: 'single',
    status: 'active',
    confidence: 1,
    importance: 0.8,
    privacy: 'normal',
    pinned: true,
    confirmed: true,
    created_at: at,
    updated_at: at,
    last_confirmed_at: at,
    valid_from: at,
    valid_until: null,
    tags: ['language', 'communication'],
    sources: [{ type: 'user_command', session_id: 'session-123', event_seq: 42, observed_at: at }],
    supersedes: [],
    contradicts: [],
    body: '用户更喜欢使用中文交流。',
    ...overrides,
  }
}

test('splitFrontmatter accepts the canonical shape and strips one blank line', () => {
  const parts = splitFrontmatter('---\nkey: value\n---\n\nbody line\n')
  assert.ok(parts !== undefined)
  assert.equal(parts.frontmatter, 'key: value')
  assert.equal(parts.body, 'body line\n')
})

test('splitFrontmatter rejects missing or unterminated frontmatter', () => {
  assert.equal(splitFrontmatter('no frontmatter'), undefined)
  assert.equal(splitFrontmatter('---\nkey: value'), undefined)
})

test('parseRecord accepts the design doc sample and round-trips byte-identically', () => {
  const record = baseRecord()
  const text = serializeRecord(record)
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'exactly one trailing newline')
  const reparsed = parseRecord(text)
  assert.deepEqual(reparsed.record, record)
  const twice = serializeRecord(reparsed.record!)
  assert.equal(twice, text)
})

test('parseRecord reports precise field issues without body leakage into errors', () => {
  const bad = serializeRecord(baseRecord({ revision: 0, status: 'bogus' as MemoryRecord['status'], id: 'mem_nothex' }))
  const { record, issues } = parseRecord(bad)
  assert.equal(record, undefined)
  const fields = issues.map((issue) => issue.field).filter((field) => field !== undefined)
  assert.ok(fields.includes('revision'))
  assert.ok(fields.includes('status'))
  assert.ok(fields.includes('id'))
})

test('parseRecord rejects unknown schema versions instead of guessing', () => {
  const text = serializeRecord(baseRecord()).replace('ohmymemo/v1', 'ohmymemo/v2')
  const { record, issues } = parseRecord(text)
  assert.equal(record, undefined)
  assert.match(issues[0]!.message, /unsupported record schema/)
})

test('candidate records require reason and expiry; non-candidates must not carry them', () => {
  const candidate = baseRecord({ status: 'candidate' })
  const missing = parseRecord(serializeRecord(candidate))
  assert.equal(missing.record, undefined)
  assert.ok(missing.issues.some((issue) => issue.field === 'candidate_reason'))
  const withExtras = parseRecord(
    serializeRecord(baseRecord({ candidate_reason: 'x', candidate_expires_at: '2026-10-03T00:00:00.000Z' })),
  )
  assert.equal(withExtras.record, undefined)
  assert.ok(withExtras.issues.some((issue) => issue.field === 'candidate_reason'))
  const valid = parseRecord(
    serializeRecord(baseRecord({ status: 'candidate', candidate_reason: '三个项目都选了 pnpm', candidate_expires_at: '2026-10-03T00:00:00.000Z' })),
  )
  assert.ok(valid.record !== undefined)
})

test('expired status and last_evidenced_at round-trip through the record schema', () => {
  const expired = baseRecord({ status: 'expired', last_evidenced_at: '2026-09-01T08:00:00.000Z' })
  const text = serializeRecord(expired)
  const reparsed = parseRecord(text)
  assert.deepEqual(reparsed.record, expired)
  assert.ok(text.includes('last_evidenced_at:'))
  const badEvidenced = parseRecord(serializeRecord(baseRecord({ last_evidenced_at: 'yesterday' as unknown as string })))
  assert.equal(badEvidenced.record, undefined)
  assert.ok(badEvidenced.issues.some((issue) => issue.field === 'last_evidenced_at'))
})

test('decay horizon config keys default, round-trip and fall back per-field', () => {
  const defaults = defaultStoreConfig()
  assert.equal(defaults.decay_horizon_days_semantic, 365)
  assert.equal(defaults.decay_horizon_days_procedural, 180)
  assert.equal(defaults.decay_horizon_days_episodic, 90)
  const tuned = parseStoreConfig(serializeStoreConfig({ ...defaults, decay_horizon_days_episodic: 45 }))
  assert.deepEqual(tuned.issues, [])
  assert.equal(tuned.config.decay_horizon_days_episodic, 45)
  const broken = parseStoreConfig(serializeStoreConfig(defaults).replace('decay_horizon_days_semantic: 365', 'decay_horizon_days_semantic: soon'))
  assert.equal(broken.config.decay_horizon_days_semantic, 365, 'invalid value falls back to the default')
  assert.ok(broken.issues.some((issue) => issue.field === 'decay_horizon_days_semantic'))
})

test('index-first interaction config keys default, round-trip and fall back per-field', () => {
  const defaults = defaultStoreConfig()
  assert.equal(defaults.capsule_top_entries, 5)
  assert.equal(defaults.index_entry_summary_chars, 120)
  assert.equal(defaults.index_max_entries, 200)
  const tuned = parseStoreConfig(serializeStoreConfig({ ...defaults, capsule_top_entries: 3, index_entry_summary_chars: 160, index_max_entries: 500 }))
  assert.deepEqual(tuned.issues, [])
  assert.equal(tuned.config.capsule_top_entries, 3)
  assert.equal(tuned.config.index_entry_summary_chars, 160)
  assert.equal(tuned.config.index_max_entries, 500)
  const broken = parseStoreConfig(serializeStoreConfig(defaults)
    .replace('capsule_top_entries: 5', 'capsule_top_entries: 0')
    .replace('index_entry_summary_chars: 120', 'index_entry_summary_chars: short')
    .replace('index_max_entries: 200', 'index_max_entries: 1'))
  assert.equal(broken.config.capsule_top_entries, 5, 'out-of-range value falls back to the default')
  assert.equal(broken.config.index_entry_summary_chars, 120)
  assert.equal(broken.config.index_max_entries, 200)
  assert.ok(broken.issues.some((issue) => issue.field === 'capsule_top_entries'))
  assert.ok(broken.issues.some((issue) => issue.field === 'index_entry_summary_chars'))
  assert.ok(broken.issues.some((issue) => issue.field === 'index_max_entries'))
})

test('parseRecord refuses credential-like bodies (fail closed)', () => {
  const withKey = parseRecord(serializeRecord(baseRecord({ body: 'my key is -----BEGIN RSA PRIVATE KEY----- stuff' })))
  assert.equal(withKey.record, undefined)
  assert.match(withKey.issues[0]!.message, /credential/)
})

test('normalizeKey lowercases, hyphenates, and drops noise', () => {
  assert.equal(normalizeKey('Preference.Package Manager'), 'preference.package-manager')
  assert.equal(normalizeKey('  workflow__pre release  checks  '), 'workflow-pre-release-checks')
  assert.equal(normalizeKey('...'), undefined)
  assert.equal(normalizeKey('%%%'), undefined)
})

test('normalizeTag and normalizeText behave', () => {
  assert.equal(normalizeTag('CI Checks'), 'ci-checks')
  assert.equal(normalizeTag('X'), 'x')
  assert.equal(normalizeTag(''), undefined)
  assert.equal(normalizeTag('!!!'), undefined)
  assert.equal(normalizeText('Ａｂｃ ＤＥ'), 'abc de')
})

test('detectSecretLike catches common credential shapes and ignores placeholders', () => {
  assert.equal(detectSecretLike('sk-abcdefghij1234567890abcd'), 'openai-style-key')
  assert.equal(detectSecretLike('AKIAIOSFODNN7EXAMPLE'), 'aws-access-key')
  assert.equal(detectSecretLike('password: hunter2hunter2'), 'credential-assignment')
  assert.equal(detectSecretLike('password: ${DB_PASSWORD}'), undefined)
  assert.equal(detectSecretLike('我喜欢用 pnpm 管理依赖。'), undefined)
})

test('source validation catches unknown types and bad spans', () => {
  const badSource = baseRecord({ sources: [{ type: 'webhook_hack' as never, span: [10, 2] as [number, number] }] })
  const { record, issues } = parseRecord(serializeRecord(badSource))
  assert.equal(record, undefined)
  assert.ok(issues.some((issue) => issue.field === 'sources[0].type'))
  assert.ok(issues.some((issue) => issue.field === 'sources[0].span'))
})

test('supersedes/contradicts must be valid ids without self-reference or duplicates', () => {
  const selfRef = parseRecord(serializeRecord(baseRecord({ supersedes: ['mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'] })))
  assert.equal(selfRef.record, undefined)
  assert.ok(selfRef.issues.some((issue) => issue.field === 'supersedes'))
})

test('tombstone round-trips and never includes bodies', () => {
  const tombstone = {
    schema: 'ohmymemo-tombstone/v1' as const,
    id: 'tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    scope: 'user',
    key: 'preference.validation-drink',
    memory_ids: ['mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'],
    forgotten_at: '2026-09-03T20:00:00.000Z',
    reason: 'user-request',
  }
  const text = serializeTombstone(tombstone)
  assert.ok(!text.includes('lapsang'))
  const parsed = parseTombstone(text)
  assert.deepEqual(parsed.tombstone, tombstone)
  assert.equal(parseTombstone('schema: nope\n').tombstone, undefined)
})

test('manifest round-trips and refuses newer format versions', () => {
  const manifest = {
    schema: 'ohmymemo-store/v1' as const,
    store_id: 'oms_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    created_at: '2026-09-03T00:00:00.000Z',
    format_version: 1,
  }
  assert.deepEqual(parseManifest(serializeManifest(manifest)).manifest, manifest)
  const newer = serializeManifest({ ...manifest, format_version: 2 })
  const result = parseManifest(newer)
  assert.equal(result.manifest, undefined)
  assert.match(result.issues[0]!.message, /newer than supported/)
})

test('scope file round-trips', () => {
  const scope = {
    schema: 'ohmymemo-scope/v1' as const,
    id: 'ws_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    dsh_workspace_id: null,
    canonical_path: '/Users/example/work/project',
    created_at: '2026-09-03T00:00:00.000Z',
    updated_at: '2026-09-03T00:00:00.000Z',
  }
  assert.deepEqual(parseScopeFile(serializeScopeFile(scope)).scope, scope)
  assert.equal(parseScopeFile('id: ws_x\n').scope, undefined)
})

test('dream model config fields round-trip and default to follow-default', () => {
  assert.equal(defaultStoreConfig().dream_model_provider, '')
  assert.equal(defaultStoreConfig().dream_model, '')
  assert.equal(defaultStoreConfig().dream_effort, '')
  const parsed = parseStoreConfig(serializeStoreConfig({ ...defaultStoreConfig(), dream_model_provider: 'zai', dream_model: 'glm-5.3-flash', dream_effort: 'high' }))
  assert.deepEqual(parsed.issues, [])
  assert.equal(parsed.config.dream_model_provider, 'zai')
  assert.equal(parsed.config.dream_model, 'glm-5.3-flash')
  assert.equal(parsed.config.dream_effort, 'high')
  const fallen = parseStoreConfig(serializeStoreConfig(defaultStoreConfig()).replace('dream_model: ""', 'dream_model: 42'))
  assert.equal(fallen.config.dream_model, '')
  assert.ok(fallen.issues.some(issue => issue.field === 'dream_model'))
})

test('store config falls back per-field on invalid values and warns on unknown fields', () => {
  const text = ['schema: ohmymemo-config/v1', 'max_record_bytes: banana', 'dream_schedule_local_time: 27:90', 'future_knob: yes', 'watch: false'].join('\n')
  const { config, issues } = parseStoreConfig(text)
  assert.equal(config.max_record_bytes, defaultStoreConfig().max_record_bytes)
  assert.equal(config.dream_schedule_local_time, '02:00')
  assert.equal(config.watch, false)
  assert.ok(issues.some((issue) => issue.field === 'max_record_bytes'))
  assert.ok(issues.some((issue) => issue.field === 'dream_schedule_local_time'))
  assert.ok(issues.some((issue) => issue.field === 'future_knob'))
  // defaults serialize and reparse cleanly
  const defaults = defaultStoreConfig()
  assert.deepEqual(parseStoreConfig(serializeStoreConfig(defaults)).config, defaults)
})

test('composeFrontmatter produces the canonical single-trailing-newline shape', () => {
  assert.equal(composeFrontmatter('a: 1', 'body\n\n\n'), '---\na: 1\n---\n\nbody\n')
})
