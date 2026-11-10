import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EventEnvelope } from '../../dsh-quno/src/types.ts'
import {
  BACKLOG_CONTINUATION_MS,
  ENTRY_KEY_MIGRATION_DONE,
  ENTRY_KEY_MIGRATION_SNAPSHOT,
  ENTRY_KEY_SESSION_PREFIX,
  ENTRY_STORAGE_CAPACITY,
  CHECKPOINT_MAX_BYTES,
  MAX_SESSIONS,
  REQUESTS_PER_MINUTE,
  SEEN_CAP,
  SWEEP_PAGE_PACING_MS,
  isV3Root,
  classifyFocused,
  classifyRun,
  createWorker,
  definition,
  emptyV2,
  extractAtMentions,
  hasMore,
  migrateV1,
  orderOf,
  parseCheckpoint,
  parseEnvelope,
  parseMessagePage,
  parseRecentConversations,
  parseSentAt,
  resetTokens,
  serializeCheckpoint,
  takeToken,
  toEnvelope,
  toGroupOption,
  validateConfig,
  factory,
  resetCollectorWorkers,
  runCollector,
} from '../src/index.ts'
import type { CliExec, CliRun, RoundDeps, V2Checkpoint, YzjConfig, YzjMessage } from '../src/index.ts'
import type { CollectorRunContext } from '../../dsh-quno/src/collectors.ts'
import type { IngestAck, IngestBatch } from '../../dsh-quno/src/types.ts'

/* ------------------------------------------------------------------ helpers */

/** A successful CLI run carrying `data.list` + `data.more`. */
function ok(list: readonly unknown[], more = false): CliRun {
  return {
    code: 0,
    stdout: JSON.stringify({ success: true, identity: 'user', data: { list, more } }),
    stderr: '',
    failure: null,
  }
}

/** A failing CLI run with the documented single-line stderr envelope. */
function fail(code: number, error: Record<string, unknown> = {}): CliRun {
  return {
    code,
    stdout: '',
    stderr: JSON.stringify({ success: false, error: { message: 'boom', ...error } }),
    failure: null,
  }
}

const SELF = { openId: 'u-self', orgId: 'org-1', name: '本人' }

/** A successful `whoami`. */
function whoamiRun(openId = SELF.openId): CliRun {
  return {
    code: 0,
    stdout: JSON.stringify({ success: true, data: { openId, orgId: SELF.orgId, name: SELF.name } }),
    stderr: '',
    failure: null,
  }
}

/** One recent-conversation row as `im group recent` reports it. */
function conv(id: string, name: string, groupType: number, lastMsgId?: string): Record<string, unknown> {
  return { groupId: id, groupName: name, groupType, ...(lastMsgId === undefined ? {} : { lastMsgId }) }
}

/**
 * One message row. `at` is the @ target list (`null` = param absent,
 * `'malformed'` = broken desc shape); timestamps are epoch millis so ordering
 * tests stay independent of timezone parsing.
 */
function msg(
  msgId: string,
  sentAt: number | null,
  overrides: {
    readonly from?: string | null
    readonly content?: string
    readonly at?: readonly string[] | 'malformed' | null
    readonly param?: unknown
    readonly msgType?: string
    readonly extFields?: unknown
    readonly groupId?: string
  } = {},
): Record<string, unknown> {
  const at = overrides.at
  let param: unknown = overrides.param
  if (param === undefined) {
    if (at === 'malformed') param = { desc: { type: 'at' } }
    else if (at === null) param = null
    else if (at !== undefined) param = { desc: at.map(target => ({ type: 'at', data: target })) }
  }
  return {
    msgId,
    groupId: overrides.groupId ?? 'g1',
    fromOpenId: overrides.from === undefined ? 'u-peer' : overrides.from,
    msgType: overrides.msgType ?? 'text',
    content: overrides.content ?? `消息 ${msgId}`,
    ...(sentAt === null ? {} : { sendTime: sentAt }),
    ...(param === undefined ? {} : { param }),
    ...(overrides.extFields === undefined ? {} : { extFields: overrides.extFields }),
  }
}

/** Exec stub that replays `runs` in order and records the argv it received. */
function queueExec(runs: CliRun[]): CliExec & { calls: string[][]; push: (...next: CliRun[]) => void } {
  const calls: string[][] = []
  const queue = [...runs]
  const exec = (async (args: readonly string[]) => {
    calls.push([...args])
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(' ')}`)
    return next
  }) as unknown as CliExec & { calls: string[][]; push: (...next: CliRun[]) => void }
  exec.calls = calls
  exec.push = (...next) => {
    queue.push(...next)
  }
  return exec
}

interface BatchRecord {
  readonly batchKey: string
  readonly events: readonly EventEnvelope[]
  readonly checkpointAfter: { readonly value: string; readonly revision: number }
  readonly complete?: boolean
  readonly gap?: { readonly reason: string } | null
}

interface Harness {
  readonly batches: BatchRecord[]
  readonly health: Array<Record<string, unknown>>
  readonly ingestKeys: string[]
  /** The ingest call with the given 0-based ordinal throws `{shape:{code}}` once. */
  refuseAt(index: number, code: string): void
  run(): Promise<{ events: number; failed: boolean; fatal: boolean; baseline: boolean; nextWorkAtMs?: number | null }>
  /** The last committed checkpoint, parsed back. */
  state(): V2Checkpoint
  /** Advance the mock clock (discovery periods, sweep pacing, backoff ladders). */
  advance(ms: number): void
  now(): number
}

/** Fixed mock clock base; every relative time in tests is expressed against it. */
const NOW = 1_800_000_000_000

function harness(
  config: YzjConfig,
  checkpointValue: string | null,
  exec: CliExec & { calls: string[][] },
  opts: { readonly maxEvents?: number; readonly maxBytes?: number } = {},
): Harness {
  resetTokens(config.yzjProfile)
  const batches: BatchRecord[] = []
  const health: Array<Record<string, unknown>> = []
  const ingestKeys: string[] = []
  const refusals = new Map<number, string>()
  let revision = 0
  let callOrdinal = 0
  let clock = NOW
  const worker = createWorker({
    config,
    generation: 1,
    checkpointValue,
    checkpointRevision: 0,
    limits: {
      maxEventsPerCheck: opts.maxEvents ?? 200,
      maxBytesPerCheck: opts.maxBytes ?? 2 * 1024 * 1024,
    },
    signal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {} },
    exec,
    ingress: {
      async ingestBatch(batch) {
        const ordinal = callOrdinal
        callOrdinal += 1
        ingestKeys.push(batch.batchKey)
        const refusal = refusals.get(ordinal)
        if (refusal !== undefined) {
          refusals.delete(ordinal)
          throw { shape: { code: refusal, message: 'refused by test stub' } }
        }
        batches.push(batch as BatchRecord)
        revision += 1
        return { checkpointRevision: revision }
      },
      async reportHealth(report) {
        health.push(report)
      },
    },
    now: () => clock,
  })
  return {
    batches,
    health,
    ingestKeys,
    refuseAt: (index, code) => refusals.set(index, code),
    run: () => worker.runRound(0),
    state() {
      const batch = batches[batches.length - 1]
      assert.ok(batch, 'no batch committed yet')
      const parsed = parseCheckpoint(batch.checkpointAfter.value)
      assert.equal(parsed.kind, 'v2')
      return (parsed as { kind: 'v2'; state: V2Checkpoint }).state
    },
    advance(ms) {
      clock += ms
    },
    now: () => clock,
  }
}

/** A focused config with no whitelist (auto-discovery). */
function focusedConfig(overrides: Record<string, unknown> = {}): YzjConfig {
  const parsed = validateConfig({ collectionMode: 'focused', ...overrides })
  assert.ok(parsed.ok, 'focused config should validate')
  return parsed.value
}

/** A legacy selected-groups config. */
function legacyConfig(groupIds = 'g1'): YzjConfig {
  const parsed = validateConfig({ groupIds })
  assert.ok(parsed.ok, 'legacy config should validate')
  return parsed.value
}

/** A v2 checkpoint whose g1 is initialized at `cursor` (owner + focusedSince set). */
function v2Pinned(cursor: string, seen: readonly string[], chatType: 1 | 2 = 2): string {
  const state: V2Checkpoint = {
    ...emptyV2(),
    owner: { orgId: SELF.orgId, openId: SELF.openId },
    focusedSince: new Date(NOW - 3_600_000).toISOString(),
    groups: {
      g1: {
        groupType: chatType,
        label: '项目群',
        cursor,
        initialized: true,
        seen,
        lastSeenInRecentAt: null,
        lastAttemptAt: null,
        syncedAt: NOW - 60_000,
        needsCatchUp: false,
        retryNotBefore: null,
        pinnedAt: NOW - 60_000,
        gap: null,
      },
    },
  }
  const serialized = serializeCheckpoint(state)
  assert.ok(serialized.ok)
  return serialized.json
}

/** The last batch's checkpoint groups. */
function lastGroups(h: Harness): Record<string, V2Checkpoint['groups'][string]> {
  return h.state().groups
}

/** The last batch's checkpoint value, to seed the next harness round. */
function lastValue(h: Harness): string {
  const batch = h.batches[h.batches.length - 1]
  assert.ok(batch)
  return batch.checkpointAfter.value
}

/* --------------------------------------------------------------- declaration */

test('declaration: shard scheduling fields, focused defaults, honest reliability', () => {
  assert.equal(definition.type, 'quno/yzj-im')
  assert.equal(definition.implementationVersion, '0.3.0')
  assert.equal(definition.schedule.defaultIntervalSec, 300)
  assert.equal(definition.schedule.quotas?.maxEventsPerRun, 200)
  assert.equal(definition.firstSync, 'baseline-only')
  assert.equal(definition.defaults?.['collectionMode'], 'focused')
  assert.equal(definition.defaults?.['pendingWaitThresholdSec'], 600)
  assert.equal(definition.defaults?.['directoryStalledSec'], 900)
  assert.match(definition.permissions.reads.join(' '), /全部增量消息/)
})

/* ------------------------------------------------------------ validateConfig */

test('validateConfig: focused defaults, thresholds, legacy rules intact', () => {
  const parsed = validateConfig({ collectionMode: 'focused' })
  assert.ok(parsed.ok)
  assert.equal(parsed.value.collectionMode, 'focused')
  assert.deepEqual(parsed.value.groupIds, [])
  assert.equal(parsed.value.intervalSec, 300)
  assert.equal(parsed.value.maxConversationsPerCheck, 20)
  assert.equal(parsed.value.maxDiscoveryPages, 5)
  assert.equal(parsed.value.pendingWaitThresholdSec, 600)
  assert.equal(parsed.value.directoryStalledSec, 900)

  assert.equal(validateConfig({}).ok, false, 'missing collectionMode = legacy = groups required')
  const legacy = legacyConfig(' g1, g2\n g1 ')
  assert.deepEqual(legacy.groupIds, ['g1', 'g2'])
  assert.equal(legacy.collectionMode, 'selected-groups')
  assert.equal(legacy.intervalSec, 600)

  const badMode = validateConfig({ collectionMode: 'turbo' })
  assert.equal(badMode.ok, false)
  if (!badMode.ok) assert.match(badMode.message, /collectionMode/)
})

/* --------------------------------------------------------------- time policy */

test('parseSentAt: naive strings are Asia/Shanghai, never host-local', () => {
  assert.equal(parseSentAt('2026-10-29 22:01:00.194'), Date.parse('2026-10-29T22:01:00.194+08:00'))
  assert.equal(parseSentAt('2026-10-29 22:01'), Date.parse('2026-10-29T22:01:00+08:00'))
  assert.equal(parseSentAt('2026-10-29T14:00:00Z'), Date.parse('2026-10-29T14:00:00Z'))
  assert.equal(parseSentAt('2026-10-29T14:00:00+02:00'), Date.parse('2026-10-29T14:00:00+02:00'))
  assert.equal(parseSentAt(1_726_800_000), 1_726_800_000_000, 'epoch seconds')
  assert.equal(parseSentAt('garbage'), null)
  assert.equal(parseSentAt(null), null)
})

/* ------------------------------------------------------------ mention policy */

test('extractAtMentions: top-level param.desc[] only; extFields never counts', () => {
  assert.deepEqual(extractAtMentions(msg('m1', 1, { at: ['u-self'] })), ['u-self'])
  assert.deepEqual(extractAtMentions(msg('m1', 1, { param: null })), [])
  assert.deepEqual(extractAtMentions(msg('m1', 1, { param: {} })), [])
  assert.deepEqual(extractAtMentions(msg('m1', 1, { param: { desc: [] } })), [])
  assert.deepEqual(extractAtMentions(msg('m1', 1, { param: null, extFields: { reactions: [{ openid: 'u-self' }] } })), [])
  assert.equal(extractAtMentions(msg('m1', 1, { at: 'malformed' })), null)
  assert.equal(extractAtMentions(msg('m1', 1, { param: { desc: [{ type: 'at', data: 42 }] } })), null)
  assert.equal(extractAtMentions(msg('m1', 1, { param: { desc: ['oops'] } })), null)
})

/* ------------------------------------------------------------ focused filter */

function focusedMessage(msgId: string, at: readonly string[] | null | 'malformed', overrides: { from?: string | null; msgType?: string } = {}): YzjMessage {
  const base = msg(msgId, NOW, { at: at === 'malformed' ? 'malformed' : at, ...overrides })
  const [parsed] = parseMessagePage([base], 'g1').messages
  assert.ok(parsed)
  return parsed
}

test('classifyFocused: the full verdict matrix (v2 §4)', () => {
  const g = 2 as const
  const d = 1 as const
  assert.deepEqual(classifyFocused(focusedMessage('m1', ['u-self']), 'u-self', g), { kind: 'event', evidence: 'yzj-param-desc-at' })
  assert.equal(classifyFocused(focusedMessage('m2', ['u-self'], { msgType: 'richText' }), 'u-self', g).kind, 'event')
  assert.deepEqual(classifyFocused(focusedMessage('m3', ['all']), 'u-self', g), { kind: 'skip', reason: 'at-all-only' })
  assert.deepEqual(classifyFocused(focusedMessage('m4', ['all', 'u-self']), 'u-self', g), { kind: 'event', evidence: 'yzj-param-desc-at' })
  assert.deepEqual(classifyFocused(focusedMessage('m5', ['u-other']), 'u-self', g), { kind: 'skip', reason: 'no-direct-at-evidence' })
  assert.deepEqual(classifyFocused(focusedMessage('m6', null), 'u-self', g), { kind: 'skip', reason: 'no-direct-at-evidence' })
  assert.deepEqual(classifyFocused(focusedMessage('m7', ['u-self'], { from: 'u-self' }), 'u-self', g), { kind: 'skip', reason: 'self' })
  assert.deepEqual(classifyFocused(focusedMessage('m8', null, { from: 'u-self' }), 'u-self', d), { kind: 'skip', reason: 'self' })
  assert.deepEqual(classifyFocused(focusedMessage('m9', null), 'u-self', d), { kind: 'event', evidence: 'direct-incoming' })
  assert.deepEqual(classifyFocused(focusedMessage('m10', ['u-self'], { from: null }), 'u-self', g), { kind: 'unknown', code: 'sender-missing' })
  assert.deepEqual(classifyFocused(focusedMessage('m11', 'malformed'), 'u-self', g), { kind: 'unknown', code: 'mention-structure-malformed' })
  assert.deepEqual(classifyFocused(focusedMessage('m12', ['u-self'], { msgType: 'mergedForward' }), 'u-self', g), {
    kind: 'unknown',
    code: 'unsupported-message-type-with-at',
  })
})

/* --------------------------------------------------------- pagination purity */

test('orderOf and page parsing: proof-based direction, invalid entries counted', () => {
  const [a] = parseMessagePage([msg('m1', 1_726_800_000_000)], 'g').messages
  const [b] = parseMessagePage([msg('m2', 1_726_800_001_000)], 'g').messages
  assert.equal(orderOf([a, b]), 'asc')
  assert.equal(orderOf([b, a]), 'desc')
  const [t1] = parseMessagePage([msg('m1', null)], 'g').messages
  assert.equal(orderOf([t1, b]), 'unknown')
  const [c] = parseMessagePage([msg('m3', 1_726_800_000_000)], 'g').messages
  const [d] = parseMessagePage([msg('m4', 1_726_800_000_000)], 'g').messages
  assert.equal(orderOf([c, d]), 'asc', 'equal timestamps keep proven ASC via source order')
  const page = parseMessagePage([msg('m1', 1), { nope: true }], 'g')
  assert.equal(page.messages.length, 1)
  assert.equal(page.invalid, 1)
  const emptyTail = parseEnvelope('{"success":true,"data":{"list":[],"more":false}}')
  assert.ok(emptyTail)
  assert.equal(hasMore(emptyTail), false)
})

/* ---------------------------------------------------------------- checkpoint */

test('checkpoint: v1 migrates intact; corrupt/unknown refuse; coverage additions parse', () => {
  const v1 = parseCheckpoint(JSON.stringify({ v: 1, groups: { g1: { cursor: 'm1', pinnedAt: 5, seen: ['m1'], syncedAt: 9 } } }))
  assert.equal(v1.kind, 'v1')
  const migrated = migrateV1((v1 as { kind: 'v1'; state: never }).state)
  assert.equal(migrated.groups['g1']?.cursor, 'm1')
  assert.equal(migrated.groups['g1']?.initialized, true)
  assert.equal(migrated.groups['g1']?.syncedAt, 9)

  assert.equal(parseCheckpoint('not json {').kind, 'corrupt')
  assert.equal(parseCheckpoint('[]').kind, 'corrupt')
  assert.equal(parseCheckpoint(JSON.stringify({ v: 99 })).kind, 'corrupt')
  assert.equal(parseCheckpoint(null).kind, 'empty')

  const parsed = parseCheckpoint(JSON.stringify({
    v: 2,
    coverage: { directoryTruncated: true, unresolvedCount: 2, lastProgressAt: 5, capacityRejectedIds: ['a', 'a', 'b'] },
    groups: { g1: { initFailures: 2, initFailCode: 'time-missing' } },
  }))
  assert.equal(parsed.kind, 'v2')
  const state = (parsed as { kind: 'v2'; state: V2Checkpoint }).state
  assert.equal(state.coverage.lastProgressAt, 5)
  assert.deepEqual(state.coverage.capacityRejectedIds, ['a', 'b'], 'rejections dedupe on parse')
  assert.equal(state.groups['g1']?.initFailures, 2)
  assert.equal(state.groups['g1']?.initFailCode, 'time-missing')
})

test('checkpoint: serialize enforces session cap and byte budget loudly', () => {
  assert.ok(serializeCheckpoint(emptyV2()).ok)
  const bloated: V2Checkpoint = {
    ...emptyV2(),
    groups: Object.fromEntries(
      Array.from({ length: MAX_SESSIONS + 1 }, (_, index) => [`g${String(index)}`, {
        groupType: 2, label: 'g', cursor: null, initialized: false, seen: [], lastSeenInRecentAt: null,
        lastAttemptAt: null, syncedAt: null, needsCatchUp: false, retryNotBefore: null, pinnedAt: null, gap: null,
      }]),
    ),
  }
  const overflow = serializeCheckpoint(bloated)
  assert.equal(overflow.ok, false)
  if (!overflow.ok) assert.equal(overflow.reason, 'session-capacity')
  const heavy: V2Checkpoint = {
    ...emptyV2(),
    groups: Object.fromEntries(
      Array.from({ length: MAX_SESSIONS }, (_, index) => [`g${String(index)}`, {
        groupType: 2, label: '群名称很长很长的群聊会话'.repeat(8), cursor: 'm0123456789012345678901234567890123456789', initialized: true,
        seen: Array.from({ length: SEEN_CAP }, (_, seenIndex) => `m01234567890123456789${String(seenIndex)}`),
        lastSeenInRecentAt: '2026-10-29T14:00:00.000Z', lastAttemptAt: '2026-10-29T14:00:00.000Z',
        syncedAt: 1_800_000_000_000, needsCatchUp: false, retryNotBefore: 1_800_000_000_000, pinnedAt: 1_800_000_000_000, gap: null,
      }]),
    ),
  }
  const heavySerialized = serializeCheckpoint(heavy)
  assert.ok(heavySerialized.ok ? heavySerialized.bytes > 100 * 1024 : true, 'the fixture is actually heavy')
  const trimmed = serializeCheckpoint({ ...emptyV2(), groups: { g1: {
    groupType: 2, label: 'x'.repeat(200), cursor: 'm', initialized: true,
    seen: Array.from({ length: SEEN_CAP + 10 }, (_, index) => `m${String(index)}`),
    lastSeenInRecentAt: null, lastAttemptAt: null, syncedAt: null, needsCatchUp: false, retryNotBefore: null, pinnedAt: null, gap: null,
  } } })
  assert.ok(trimmed.ok)
})

/* ------------------------------------------------------------------- cli run */

test('classifyRun: exit code wins; rate limit has its own state', () => {
  assert.equal(classifyRun(ok([])), null)
  assert.equal(classifyRun(fail(3, { subtype: 'credentials_missing' }))?.state, 'auth-required')
  assert.equal(classifyRun(fail(1, { code: 10000400 }))?.state, 'auth-required')
  assert.equal(classifyRun(fail(1, { code: 429 }))?.state, 'rate-limited')
  assert.equal(classifyRun(fail(4))?.state, 'unavailable')
  assert.equal(classifyRun(fail(2))?.state, 'degraded')
  assert.equal(classifyRun({ code: null, stdout: '', stderr: '', failure: 'ENOENT' })?.code, 'cli-missing')
})

test('request bucket: 30/min per profile, shared, refill over time', () => {
  resetTokens('bucket-test')
  let now = NOW
  for (let index = 0; index < REQUESTS_PER_MINUTE; index += 1) {
    assert.equal(takeToken('bucket-test', now).ok, true, `token ${String(index)} available`)
  }
  const denied = takeToken('bucket-test', now)
  assert.equal(denied.ok, false)
  assert.ok(denied.nextTokenAt > now, 'denied carries the next token time')
  // Half a minute refills half the bucket.
  now += 30_000
  assert.equal(takeToken('bucket-test', now).ok, true)
  // Another profile has its own bucket.
  assert.equal(takeToken('other-profile', now).ok, true)
})

test('recent conversations are normalized; only multi-member groups are selectable', () => {
  const conversations = parseRecentConversations([
    conv('g1', '项目群', 2),
    conv('d1', '张三', 1),
    conv('a1', '助手', 3),
    conv('s1', '通知', 8),
    conv('u1', '未知', 42),
  ])
  assert.deepEqual(conversations.map(conversation => conversation.conversationId), ['g1', 'd1', 'a1', 's1', 'u1'])
  const options = conversations.map(toGroupOption)
  assert.equal(options[0]?.disabled, undefined)
  assert.match(options[1]?.disabledReason ?? '', /聚焦模式自动接收/)
  for (const option of options.slice(2)) assert.equal(option.disabled, true)
})

/* --------------------------------------------------- worker: corrupt & fatal */

test('worker: a corrupt checkpoint stops loudly before any CLI call', async () => {
  const exec = queueExec([])
  const h = harness(focusedConfig(), '{"v":2, broken', exec)
  const outcome = await h.run()
  assert.equal(outcome.failed, true)
  assert.equal(outcome.fatal, true)
  assert.equal(exec.calls.length, 0)
  assert.equal(h.health[0]?.['errorCode'], 'checkpoint-corrupt')
})

test('worker: account identity change is fatal and says so', async () => {
  const exec = queueExec([whoamiRun('u-someone-else')])
  const state = serializeCheckpoint({ ...emptyV2(), owner: { orgId: SELF.orgId, openId: SELF.openId } })
  assert.ok(state.ok)
  const h = harness(focusedConfig(), state.json, exec)
  const outcome = await h.run()
  assert.equal(outcome.fatal, true)
  assert.equal(h.health[0]?.['errorCode'], 'account-changed')
})

test('worker: whoami without a bindable openId is a degraded failure', async () => {
  const exec = queueExec([ok([{ nope: true }])])
  const h = harness(focusedConfig(), null, exec)
  const outcome = await h.run()
  assert.equal(outcome.failed, true)
  assert.equal(outcome.fatal, false)
  assert.equal(h.health[0]?.['errorCode'], 'whoami-shape')
})

/* ------------------------------------------- worker: focused first shard */

test('worker: focused first shard — structural commit, catalog, filtered initialization', async () => {
  const t0 = NOW
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm1'), conv('d1', '张三', 1, 'p2')]),
    ok([
      msg('p1', t0 + 1_000, { from: 'u-self', groupId: 'd1' }),
      msg('p2', t0 + 2_000, { from: 'u-peer', groupId: 'd1' }),
    ]),
    ok([
      msg('m1', t0 - 60_000, { at: ['u-other'] }),
      msg('m2', t0 + 1_000, { at: ['u-self'], content: '请确认评审时间' }),
      msg('m3', t0 + 2_000, { at: ['all'] }),
      msg('m4', t0 + 3_000, { at: null }),
    ]),
  ])
  const h = harness(focusedConfig(), null, exec)
  const outcome = await h.run()

  assert.equal(outcome.failed, false)
  assert.equal(outcome.baseline, true)
  assert.equal(exec.calls.length, 4)
  assert.deepEqual(exec.calls[0], ['--profile', 'default', 'whoami'])

  // Batch 1: structural — owner binding + focusedSince, before any read.
  assert.equal(h.batches[0]?.events.length, 0)
  const structuralAt = (index: number): V2Checkpoint => {
    const batch = h.batches[index]
    assert.ok(batch)
    const parsed = parseCheckpoint(batch.checkpointAfter.value)
    assert.equal(parsed.kind, 'v2')
    return (parsed as { kind: 'v2'; state: V2Checkpoint }).state
  }
  assert.equal(structuralAt(0).owner?.openId, 'u-self')
  assert.equal(structuralAt(0).focusedSince, new Date(NOW).toISOString())

  assert.equal(structuralAt(1).groups['g1']?.groupType, 2)
  assert.equal(structuralAt(1).groups['d1']?.groupType, 1)

  // Direct lane first: only the peer's private message.
  const directEvents = h.batches[2]?.events ?? []
  assert.deepEqual(directEvents.map(event => event.eventKey), ['yzj:d1:p2'])
  const direct = directEvents[0]?.data as Record<string, unknown>
  assert.equal(direct['chatType'], 'direct')
  assert.deepEqual(directEvents[0]?.correlationKeys, ['yzj-group:d1', 'yzj-direct:d1'])

  // Group lane: only the direct @me after the enable instant.
  const groupEvents = h.batches[3]?.events ?? []
  assert.deepEqual(groupEvents.map(event => event.eventKey), ['yzj:g1:m2'])
  const mention = groupEvents[0]?.data as Record<string, unknown>
  assert.equal(mention['mentionedMe'], true)
  assert.equal(groupEvents[0]?.priority, 'p1')
  assert.match(String(groupEvents[0]?.summary), /项目群 · @我：请确认评审时间/)

  const groups = lastGroups(h)
  assert.equal(groups['g1']?.cursor, 'm4')
  assert.equal(groups['d1']?.cursor, 'p2')
  assert.equal(groups['g1']?.lastAttemptAt, new Date(NOW).toISOString(), 'every service attempt stamps lastAttemptAt')
  assert.equal(h.health[0]?.['state'], 'healthy')
  assert.match(String(h.health[0]?.['detail']), /正在同步/)
})

test('worker: focused incremental filters; legacy keeps the v1 envelope shape', async () => {
  // Focused: initialized group, watermark differs from cursor → served.
  {
    const t0 = NOW
    const exec = queueExec([
      whoamiRun(),
      ok([conv('g1', '项目群', 2, 'm9')]),
      ok([
        msg('m2', t0 + 1_000, { at: ['u-self'] }),
        msg('m3', t0 + 2_000, { at: ['u-other'] }),
        msg('m4', t0 + 3_000, { from: 'u-self', at: ['u-self'] }),
      ]),
    ])
    const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec)
    const outcome = await h.run()
    assert.equal(outcome.failed, false)
    const events = h.batches[h.batches.length - 1]?.events ?? []
    assert.deepEqual(events.map(event => event.eventKey), ['yzj:g1:m2'])
    assert.equal(lastGroups(h)['g1']?.cursor, 'm4', 'cursor moves past filtered messages')
    assert.equal(lastGroups(h)['g1']?.needsCatchUp, false, 'caught up')
  }
  // Legacy: every new message is an event, v1 envelope shape preserved.
  {
    const t0 = NOW
    const exec = queueExec([
      whoamiRun(),
      ok([msg('m2', t0 + 1_000), msg('m3', t0 + 2_000)]),
    ])
    const h = harness(legacyConfig(), v2Pinned('m1', ['m1']), exec)
    const outcome = await h.run()
    assert.equal(outcome.failed, false)
    assert.equal(exec.calls.some(args => args.includes('group') && args.includes('recent')), false, 'legacy reads no catalog')
    const events = h.batches[0]?.events ?? []
    assert.deepEqual(events.map(event => event.eventKey), ['yzj:g1:m2', 'yzj:g1:m3'])
    assert.equal(events[0]?.priority, 'p2', 'legacy keeps the source-suggested p2')
    const data = events[0]?.data as Record<string, unknown>
    assert.equal('chatType' in data, false, 'v1 data shape unchanged')
  }
})

test('worker: watermark-equal conversations skip their message read', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm1')]),
  ])
  const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec)
  const outcome = await h.run()
  assert.equal(outcome.failed, false)
  assert.equal(outcome.events, 0)
  assert.equal(exec.calls.length, 2, 'fresh equal watermark → no message request')
  assert.equal(h.health[0]?.['state'], 'healthy')
})

test('worker: whitelist removal stops requests for existing tracking immediately', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('gx', '别的群', 2, 'x1')]),
    ok([], false), // gx initializes empty
  ])
  const h = harness(focusedConfig({ groupIds: 'gx' }), v2Pinned('m1', ['m1']), exec)
  const outcome = await h.run()
  assert.equal(outcome.failed, false)
  const g1Read = exec.calls.some(args => {
    const i = args.indexOf('--group-id')
    return i >= 0 && args[i + 1] === 'g1'
  })
  assert.equal(g1Read, false, 'g1 left the whitelist → no message request')
  const retained = lastGroups(h)['g1']
  assert.equal(retained?.cursor, 'm1', 'the cursor survives the scope change')
})

test('worker: v1 checkpoint migrates in place — cursor survives the mode switch', async () => {
  const t0 = NOW
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m2', t0 + 1_000, { at: ['u-self'] })]),
  ])
  const v1 = JSON.stringify({ v: 1, groups: { g1: { cursor: 'm1', pinnedAt: 1, seen: ['m1'], syncedAt: 1000 } } })
  const h = harness(focusedConfig({ groupIds: 'g1' }), v1, exec)
  const outcome = await h.run()
  assert.equal(outcome.failed, false)
  assert.ok(exec.calls.some(args => args.includes('--msg-id') && args.includes('m1')), 'incremental from the migrated cursor, no re-baseline')
  const events = h.batches[2]?.events ?? []
  assert.deepEqual(events.map(event => event.eventKey), ['yzj:g1:m2'])
})

/* ------------------------------------------------ pagination & state machine */

test('worker: descending incremental page does not advance and reports protocol gap', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m3', NOW + 3_000), msg('m2', NOW + 2_000)], true),
  ])
  const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec)
  await h.run()
  const groups = lastGroups(h)
  assert.equal(groups['g1']?.cursor, 'm1', 'unprovable pages never move the cursor')
  assert.equal(groups['g1']?.needsCatchUp, true)
  const gapBatch = h.batches.find(batch => (batch.gap?.reason ?? '').includes('顺序'))
  assert.ok(gapBatch, 'protocol gap recorded')
  assert.equal(gapBatch?.complete, false)
  assert.equal(h.health[0]?.['state'], 'degraded')
})

test('worker: entries without msgId freeze the page boundary in place', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m2', NOW + 1_000), { nope: true }]),
  ])
  const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec)
  await h.run()
  const groups = lastGroups(h)
  assert.equal(groups['g1']?.cursor, 'm1', 'never advance past an unknown boundary')
  assert.ok(groups['g1']?.retryNotBefore !== null, 'the conversation pauses on a timer')
  assert.equal(groups['g1']?.needsCatchUp, true, 'and the debt stays pinned')
})

test('worker: zero progress with more:true backs off instead of spinning', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m1', NOW - 1_000)], true),
  ])
  const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec)
  await h.run()
  const groups = lastGroups(h)
  assert.equal(groups['g1']?.cursor, 'm1')
  assert.equal(groups['g1']?.needsCatchUp, true)
  assert.match(h.batches[1]?.gap?.reason ?? '', /无新消息但 more:true/)
})

test('worker: missing data.list or non-boolean more is a session-level protocol failure', async () => {
  const execA = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    { code: 0, stdout: '{"success":true,"data":{"more":false}}', stderr: '', failure: null },
  ])
  const hA = harness(focusedConfig(), v2Pinned('m1', ['m1']), execA)
  const outcomeA = await hA.run()
  assert.equal(outcomeA.failed, false, 'session-level: the shard continues')
  assert.equal(hA.health[0]?.['errorCode'], 'session-protocol-shape')
  assert.equal(lastGroups(hA)['g1']?.cursor, 'm1', 'cursor untouched')

  const execB = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    { code: 0, stdout: '{"success":true,"data":{"list":[],"more":"yes"}}', stderr: '', failure: null },
  ])
  const hB = harness(focusedConfig(), v2Pinned('m1', ['m1']), execB)
  const outcomeB = await hB.run()
  assert.equal(outcomeB.failed, false)
  assert.equal(hB.health[0]?.['errorCode'], 'session-protocol-shape')
})

test('worker: event budget cuts mid-page — prefix only, remainder deferred', async () => {
  const t0 = NOW
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([
      msg('m2', t0 + 1_000, { at: ['u-self'] }),
      msg('m3', t0 + 2_000, { at: ['u-self'] }),
    ]),
  ])
  const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec, { maxEvents: 1 })
  await h.run()
  const eventBatch = h.batches.find(batch => batch.events.length > 0)
  assert.deepEqual(eventBatch?.events.map(event => event.eventKey), ['yzj:g1:m2'], 'only the fitting prefix emits')
  assert.equal(eventBatch?.complete, false)
  assert.equal(lastGroups(h)['g1']?.cursor, 'm2', 'cursor follows the last PROCESSED message')
  assert.equal(lastGroups(h)['g1']?.needsCatchUp, true)
})

test('worker: byte budget consumes real serialization bytes', async () => {
  const t0 = NOW
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([
      msg('m2', t0 + 1_000, { at: ['u-self'], content: 'x'.repeat(3000) }),
      msg('m3', t0 + 2_000, { at: ['u-self'], content: 'x'.repeat(3000) }),
    ]),
  ])
  // 6 KiB: the checkpoint reserve plus one ~3 KB event fit; the second cuts.
  const h = harness(focusedConfig(), v2Pinned('m1', ['m1']), exec, { maxBytes: 6 * 1024 })
  await h.run()
  const eventBatch = h.batches.find(batch => batch.events.length > 0)
  assert.ok(eventBatch, 'at least one event committed')
  assert.equal(eventBatch?.events.length, 1, 'byte budget cut the page prefix')
  assert.equal(eventBatch?.complete, false)
})

test('worker: empty conversation initializes with null cursor, then collects its first message', async () => {
  const execA = queueExec([
    whoamiRun(),
    ok([conv('d1', '张三', 1)]),
    ok([], false),
  ])
  const hA = harness(focusedConfig(), null, execA)
  await hA.run()
  assert.equal(lastGroups(hA)['d1']?.initialized, true)
  assert.equal(lastGroups(hA)['d1']?.cursor, null)

  const execB = queueExec([
    whoamiRun(),
    ok([conv('d1', '张三', 1, 'p1')]),
    ok([msg('p1', NOW + 1_000, { groupId: 'd1' })]),
  ])
  const hB = harness(focusedConfig(), lastValue(hA), execB)
  await hB.run()
  const eventBatch = hB.batches.find(batch => batch.events.length > 0)
  assert.deepEqual(eventBatch?.events.map(event => event.eventKey), ['yzj:d1:p1'])
})

test('worker: two-lane budget serves one per lane; queueing is progress, not a fault', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '群一', 2, 'w1'), conv('g2', '群二', 2, 'w2'), conv('d1', '甲', 1, 'p1'), conv('d2', '乙', 1, 'p2')]),
    ok([msg('p1', NOW + 1_000, { groupId: 'd1' })]),
    ok([msg('m1', NOW + 1_000, { at: ['u-self'] })]),
  ])
  const h = harness(focusedConfig({ maxConversationsPerCheck: 2 }), null, exec)
  const outcome = await h.run()
  const groupIds = exec.calls
    .filter(args => args.includes('--group-id'))
    .map(args => args[args.indexOf('--group-id') + 1])
  assert.deepEqual([...groupIds].sort(), ['d1', 'g1'], 'one per lane; the rest waits')
  assert.equal(outcome.failed, false)
  assert.equal(h.health[0]?.['state'], 'healthy', 'queueing alone is never degraded')
  assert.match(String(h.health[0]?.['detail']), /待检查 2 个/)
  assert.ok(outcome.nextWorkAtMs != null && outcome.nextWorkAtMs <= NOW + BACKLOG_CONTINUATION_MS + 1_000,
    'backlog continuation wakes in seconds, not a full interval')
})

test('worker: cross-round catalog sweep persists its page and resumes there', async () => {
  const assistant = (index: number): Record<string, unknown> => conv(`a${String(index)}`, `助手${String(index)}`, 3)
  // Shard 1 (t=0): discovery due → page 1 + one sweep page (cap 2), both more:true.
  const roundOne = queueExec([
    whoamiRun(),
    ok(Array.from({ length: 20 }, (_, index) => assistant(index)), true),
    ok([assistant(100)], true),
  ])
  const h1 = harness(focusedConfig({ maxDiscoveryPages: 2 }), null, roundOne)
  await h1.run()
  assert.ok(roundOne.calls.some(args => args.includes('--page') && args.includes('2')))
  assert.equal(h1.state().discovery.nextPage, 3, 'mid-sweep position persisted')
  assert.ok(h1.state().coverage.lastProgressAt !== null && h1.state().coverage.lastProgressAt !== undefined)

  // Shard 2 (t=+30s): discovery NOT due; sweep pacing due → resumes at page 3.
  h1.advance(SWEEP_PAGE_PACING_MS)
  roundOne.push(whoamiRun(), ok([], false))
  await h1.run()
  assert.ok(roundOne.calls.some(args => args.includes('--page') && args.includes('3')), 'resumes from the persisted page')
  assert.ok(roundOne.calls.filter(args => args.includes('--page') && args.includes('2')).length === 1, 'never re-reads the swept page')
  assert.ok(roundOne.calls.every(args => !args.includes('message')), 'no message reads: nothing collectable discovered')
  assert.equal(h1.state().discovery.nextPage, 2, 'sweep completed → next discovery restarts at page 2')
})

test('worker: capacity rejections dedupe across shards — unique count, loud fault', async () => {
  const parked: Record<string, V2Checkpoint['groups'][string]> = {}
  for (let index = 0; index < MAX_SESSIONS - 1; index += 1) {
    parked[`p${String(index)}`] = {
      groupType: 2, label: `群${String(index)}`, cursor: 'm0', initialized: true, seen: [],
      lastSeenInRecentAt: null, lastAttemptAt: new Date(NOW - 3_600_000).toISOString(), syncedAt: NOW - 60_000,
      needsCatchUp: false, retryNotBefore: NOW + 3_600_000, pinnedAt: null, gap: null,
    }
  }
  const seeded = serializeCheckpoint({
    ...emptyV2(),
    owner: { orgId: SELF.orgId, openId: SELF.openId },
    focusedSince: new Date(NOW - 3_600_000).toISOString(),
    groups: parked,
  })
  assert.ok(seeded.ok)
  const group = (index: number): Record<string, unknown> => conv(`n${String(index)}`, `新群${String(index)}`, 2)
  const page = ok(Array.from({ length: 20 }, (_, index) => group(index)), false)
  const exec = queueExec([
    whoamiRun(),
    page,
    ok([], false), // the one admitted newcomer is empty
  ])
  const h = harness(focusedConfig({ maxConversationsPerCheck: 1 }), seeded.json, exec)
  await h.run()
  assert.equal(Object.keys(h.state().groups).length, MAX_SESSIONS, 'the 200th conversation is admitted')
  const firstRejected = h.state().coverage.capacityRejectedIds ?? []
  assert.equal(firstRejected.length, 19, '19 unique conversations rejected')

  // A second shard re-meets the same 19 — the unique count must not grow.
  h.advance(301_000)
  const exec2 = queueExec([
    whoamiRun(),
    page,
    ok([], false),
  ])
  void exec2
  const exec3 = queueExec([
    whoamiRun(),
    ok(Array.from({ length: 20 }, (_, index) => group(index)), false),
  ])
  void exec3
  // Feed the same page through a fresh harness seeded with the previous state.
  const h2 = harness(focusedConfig({ maxConversationsPerCheck: 1 }), lastValue(h), (() => {
    const calls: string[][] = []
    const exec = (async (args: readonly string[]) => {
      calls.push([...args])
      if (args.includes('whoami')) return whoamiRun()
      if (args.includes('recent')) return page
      return ok([], false)
    }) as unknown as CliExec & { calls: string[][] }
    exec.calls = calls
    return exec
  })())
  await h2.run()
  assert.equal((h2.state().coverage.capacityRejectedIds ?? []).length, 19, 're-encountering adds no duplicates')
  assert.equal(h2.health[0]?.['state'], 'degraded')
  assert.match(String(h2.health[0]?.['detail']), /部分会话未覆盖/)
})

/* ------------------------------------------------------- ingest transaction */

test('worker: an uncertain ACK retries the IDENTICAL batchKey once', async () => {
  const t0 = NOW
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m1', t0 + 1_000, { at: ['u-self'] })]),
  ])
  const h = harness(focusedConfig(), null, exec)
  h.refuseAt(0, 'temporarily-unavailable')
  const outcome = await h.run()
  assert.equal(outcome.failed, false, 'the identical retry landed')
  assert.equal(h.ingestKeys.length, 4, 'structural retry + catalog + events')
  assert.equal(h.ingestKeys[0], h.ingestKeys[1], 'same batch key — never rebuilt from a fresh read')
})

test('worker: stale-generation refusal is fatal — no overwrite of another writer', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2)]),
    ok([]),
  ])
  const h = harness(focusedConfig(), null, exec)
  h.refuseAt(0, 'stale-generation')
  const outcome = await h.run()
  assert.equal(outcome.fatal, true)
  assert.equal(h.health[0]?.['errorCode'], 'stale-generation')
})

test('worker: identity-conflict pauses that session durably and the shard continues', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m1', NOW + 1_000, { at: ['u-self'] })]),
  ])
  const h = harness(focusedConfig(), null, exec)
  // Ingest ordinals: 0 = structural, 1 = catalog, 2 = g1's event batch.
  h.refuseAt(2, 'identity-conflict')
  const outcome = await h.run()
  assert.equal(outcome.failed, false, 'one conflicted session does not sink the shard')
  assert.equal(h.health[0]?.['state'], 'degraded')
  assert.equal(h.health[0]?.['errorCode'], 'identity-conflict')
  const groups = lastGroups(h)
  assert.equal(groups['g1']?.gap?.code, 'identity-conflict', 'the gap marker persists past clean commits')
  assert.ok(groups['g1']?.retryNotBefore !== null, 'the conversation backs off')
})

test('worker: standing gaps stay visible in later quiet shards (never erased)', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m1', NOW + 1_000, { at: ['u-self'] })]),
  ])
  const h = harness(focusedConfig(), null, exec)
  h.refuseAt(2, 'identity-conflict')
  await h.run()

  h.advance(301_000)
  const exec2 = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm1')]),
  ])
  const h2 = harness(focusedConfig(), lastValue(h), exec2)
  const outcome = await h2.run()
  assert.equal(outcome.failed, false)
  assert.equal(h2.health[0]?.['state'], 'degraded', 'the standing gap keeps health degraded')
  assert.equal(h2.health[0]?.['errorCode'], 'identity-conflict')
})

test('worker: a logged-out CLI reports auth-required with no cursor movement', async () => {
  const exec = queueExec([
    fail(3, {
      type: 'authentication',
      subtype: 'credentials_missing',
      message: 'this command requires user identity',
      hint: '运行 yzj-cli auth login --device 重新认证',
    }),
  ])
  const h = harness(focusedConfig(), null, exec)
  const outcome = await h.run()
  assert.equal(outcome.failed, true)
  assert.equal(h.batches.length, 0, 'a failed read must not persist a cursor')
  assert.equal(h.health[0]?.['state'], 'auth-required')
  assert.equal(h.health[0]?.['nextRetryAt'], null, 'auth needs a human, not a backoff')
  assert.match(String(h.health[0]?.['detail']), /auth login/)
})

/* --------------------------------------------------- init failure isolation */

test('worker: init failures diagnose the cause and walk the backoff ladder', async () => {
  const convRow = conv('g1', '项目群', 2, 'm9')
  // Shard 1: unparseable times → time-missing, 1 minute backoff.
  const exec1 = queueExec([
    whoamiRun(),
    ok([convRow]),
    ok([msg('m2', null), msg('m3', NOW + 1_000)]),
  ])
  const h = harness(focusedConfig(), null, exec1)
  await h.run()
  let group = lastGroups(h)['g1']
  assert.equal(group?.initialized, false)
  assert.equal(group?.initFailures, 1)
  assert.equal(group?.initFailCode, 'time-missing')
  assert.equal(group?.retryNotBefore, NOW + 60_000, 'first rung: 1 minute')
  assert.equal(group?.gap?.code, 'init-time-missing')

  // Shard 2 (after the rung): same cause → 2 minutes, still not blocked.
  h.advance(60_000)
  exec1.push(whoamiRun(), ok([msg('m2', null), msg('m3', NOW + 61_000)]))
  await h.run()
  group = lastGroups(h)['g1']
  assert.equal(group?.initFailures, 2)
  assert.equal(group?.retryNotBefore, NOW + 60_000 + 120_000)

  // Shard 3: third consecutive same-cause failure → 采集受阻.
  h.advance(120_000)
  exec1.push(whoamiRun(), ok([msg('m2', null), msg('m3', NOW + 181_000)]))
  await h.run()
  group = lastGroups(h)['g1']
  assert.equal(group?.initFailures, 3)
  assert.equal(group?.gap?.code, 'init-blocked')
  const lastHealth = h.health[h.health.length - 1]
  assert.equal(lastHealth?.['state'], 'degraded')
  assert.equal(lastHealth?.['errorCode'], 'session-blocked')
  assert.match(String(lastHealth?.['detail']), /初始化受阻/)
})

test('worker: descending init pages diagnose page-order-unverified, not time-missing', async () => {
  const exec = queueExec([
    whoamiRun(),
    ok([conv('g1', '项目群', 2, 'm9')]),
    ok([msg('m3', NOW + 3_000), msg('m2', NOW + 2_000)]),
  ])
  const h = harness(focusedConfig(), null, exec)
  await h.run()
  const group = lastGroups(h)['g1']
  assert.equal(group?.initFailCode, 'page-order-unverified')
  assert.equal(group?.initialized, false)
})

test('worker: successful initialization clears the failure memory', async () => {
  const convRow = conv('g1', '项目群', 2, 'm9')
  const exec1 = queueExec([
    whoamiRun(),
    ok([convRow]),
    ok([msg('m2', null), msg('m3', NOW + 1_000)]),
  ])
  const h = harness(focusedConfig(), null, exec1)
  await h.run()
  assert.equal(lastGroups(h)['g1']?.initFailures, 1)

  h.advance(60_000)
  const t0 = h.now()
  exec1.push(whoamiRun(), ok([
    msg('m2', t0 + 1_000, { at: ['u-self'] }),
    msg('m3', t0 + 2_000, { at: null }),
  ]))
  await h.run()
  const group = lastGroups(h)['g1']
  assert.equal(group?.initialized, true)
  assert.equal(group?.initFailures, 0)
  assert.equal(group?.initFailCode, null)
  assert.equal(group?.gap, null)
})

/* ---------------------------------------------------------------- envelopes */

/* ---------------------------------------------------- checkpoint entries v1 */

/** An in-memory Host: entries map + root, CAS + capacity, replayable batches. */
function entriesHost(capacity = ENTRY_STORAGE_CAPACITY) {
  const store = new Map<string, string>()
  let rootValue: string | null = null
  let revision = 0
  const batches: Array<{ batchKey: string; patchKeys: readonly string[] }> = []
  let refusal: string | null = null
  let callOrdinal = 0
  const face = {
    list: (request: { limit?: number; afterKey?: string }) => {
      const keys = [...store.keys()].sort()
      const after = request.afterKey
      const filtered = after === undefined ? keys : keys.filter(key => key > after)
      const page = filtered.slice(0, request.limit ?? 200).map(key => ({ key, value: store.get(key) ?? '' }))
      return { entries: page, count: store.size, revision }
    },
    get: (key: string) => {
      const value = store.get(key)
      return value === undefined ? undefined : { key, value }
    },
  }
  const ingest = (async (batchBody: {
    readonly batchKey: string
    readonly events: readonly EventEnvelope[]
    readonly checkpointAfter?: { value: string; revision: number } | null
    readonly checkpointPatch?: { upserts?: readonly { readonly key: string; readonly value: string }[]; deletes?: readonly string[] } | null
    readonly complete?: boolean
    readonly gap?: { reason: string } | null
  }): Promise<{ checkpointRevision: number }> => {
    const ordinal = callOrdinal
    callOrdinal += 1
    batches.push({ batchKey: batchBody.batchKey, patchKeys: (batchBody.checkpointPatch?.upserts ?? []).map(entry => entry.key) })
    if (refusal !== null) {
      const code = refusal
      refusal = null
      throw { shape: { code, message: 'refused by host stub' } }
    }
    if (batchBody.checkpointPatch?.upserts !== undefined) {
      if (store.size + batchBody.checkpointPatch.upserts.length > capacity) {
        throw { shape: { code: 'quota-exceeded', message: 'capacity' } }
      }
      for (const entry of batchBody.checkpointPatch.upserts) store.set(entry.key, entry.value)
    }
    for (const key of batchBody.checkpointPatch?.deletes ?? []) store.delete(key)
    if (batchBody.checkpointAfter != null) {
      assert.equal(batchBody.checkpointAfter.revision, revision, 'CAS: stale revisions refuse')
      revision += 1
      rootValue = batchBody.checkpointAfter.value
    }
    return { checkpointRevision: revision }
  }) as unknown as (batch: {
    readonly batchKey: string
    readonly events: readonly EventEnvelope[]
    readonly checkpointAfter?: { value: string; revision: number } | null
    readonly checkpointPatch?: { upserts?: { key: string; value: string }[]; deletes?: readonly string[] } | null
    readonly complete?: boolean
    readonly gap?: { reason: string } | null
  }) => Promise<{ checkpointRevision: number }>
  return {
    face,
    ingest,
    batches,
    refuseNext(code: string) {
      refusal = code
    },
    get root(): string | null {
      return rootValue
    },
    get revision(): number {
      return revision
    },
    keys(): string[] {
      return [...store.keys()].sort()
    },
    ingressFace: {
      ingestBatch: ingest,
      reportHealth: async () => {},
    } as unknown as RoundDeps['ingress'],
  }
}

/** Wire the in-memory Host into a worker over the given checkpoint value. */
function entriesHarness(config: YzjConfig, host: ReturnType<typeof entriesHost>, checkpointValue: string | null, checkpointRevision = 0) {
  let clock = NOW
  const exec = queueExec([])
  const worker = createWorker({
    config,
    generation: 1,
    checkpointValue,
    checkpointRevision,
    checkpointEntries: host.face,
    capabilities: { checkpointEntries: true },
    limits: { maxEventsPerCheck: 200, maxBytesPerCheck: 2 * 1024 * 1024 },
    signal: new AbortController().signal,
    logger: { info: () => {}, warn: () => {} },
    exec,
    ingress: host.ingressFace,
    now: () => clock,
  })
  return {
    exec,
    run: () => worker.runRound(0),
    advance(ms: number) {
      clock += ms
    },
  }
}

test('entries: a legacy v2 blob migrates into entries; the snapshot and marker persist', async () => {
  const host = entriesHost()
  const blob = v2Pinned('m1', ['m1'])
  const h = entriesHarness(focusedConfig({ groupIds: 'g1' }), host, blob)
  h.exec.push(whoamiRun(), ok([conv('g1', '项目群', 2, 'm9')]), ok([], false))
  const outcome = await h.run()
  assert.equal(outcome.failed, false)
  assert.equal(isV3Root(host.root), true, 'the root switched to v3')
  assert.ok(host.keys().includes(ENTRY_KEY_MIGRATION_SNAPSHOT), 'the old blob is preserved read-only')
  assert.ok(host.keys().includes(ENTRY_KEY_MIGRATION_DONE), 'migration carries a done marker')
  assert.ok(host.keys().includes(ENTRY_KEY_SESSION_PREFIX + 'g1'), 'the conversation cursor is an entry')
  // The migrated cursor continues incrementally — no re-baseline.
  assert.ok(h.exec.calls.some(args => args.includes('--msg-id') && args.includes('m1')))
})

test('entries: restart resumes from persisted entries without re-baselining', async () => {
  const host = entriesHost()
  const h1 = entriesHarness(focusedConfig({ groupIds: 'g1' }), host, null)
  // Shard 1: catalog discovers g1; the newest window pins cursor m1 (pre-enable baseline).
  h1.exec.push(whoamiRun(), ok([conv('g1', '项目群', 2, 'w9')]), ok([msg('m1', NOW - 1_000, { groupId: 'g1', at: ['u-self'] })]))
  await h1.run()
  assert.ok(host.keys().includes(ENTRY_KEY_SESSION_PREFIX + 'g1'), 'g1 tracked as an entry')
  const rootAfterInit = host.root
  assert.ok(rootAfterInit !== null && isV3Root(rootAfterInit))

  // "Restart": a fresh worker over the persisted root + entries.
  const h2 = entriesHarness(focusedConfig({ groupIds: 'g1' }), host, rootAfterInit, host.revision)
  h2.exec.push(whoamiRun(), ok([conv('g1', '项目群', 2, 'w9')]), ok([msg('m2', NOW + 1_000, { groupId: 'g1', at: ['u-self'] })]))
  await h2.run()
  assert.ok(h2.exec.calls.some(args => args.includes('--msg-id') && args.includes('m1')), 'incremental from the persisted cursor, no re-baseline')
  void h2
})

test('entries: capacity overflow is a fatal checkpoint-capacity fault', async () => {
  const host = entriesHost(2) // room for snapshot + done only — one conversation overflows
  const blob = v2Pinned('m1', ['m1'])
  const h = entriesHarness(focusedConfig({ groupIds: 'g1' }), host, blob)
  const outcome = await h.run()
  assert.equal(outcome.fatal, true, 'capacity is a hard stop, never a trim')
})

test('entries: an uncertain ACK retries the identical patch-bearing batch', async () => {
  const host = entriesHost()
  const h = entriesHarness(focusedConfig({ groupIds: 'g1' }), host, null)
  host.refuseNext('temporarily-unavailable')
  h.exec.push(whoamiRun(), ok([conv('g1', '项目群', 2, 'w9')]), ok([], false))
  await h.run()
  assert.ok(host.batches.length >= 1, 'the shard reached the structural commit')
})

test('entries: entry keys stay opaque to the host; session payloads stay bounded', () => {
  const group: V2Checkpoint['groups'][string] = {
    groupType: 2, label: 'g', cursor: 'm', initialized: true,
    seen: Array.from({ length: SEEN_CAP }, (_, index) => `m${String(index)}`),
    lastSeenInRecentAt: null, lastAttemptAt: null, syncedAt: null,
    needsCatchUp: false, retryNotBefore: null, pinnedAt: null, gap: null,
  }
  const value = JSON.stringify(group)
  assert.ok(value.length < 8 * 1024, 'a session entry stays under the 8 KiB guidance')
  assert.ok(ENTRY_KEY_SESSION_PREFIX.startsWith('c:'))
})

test('worker: event envelopes carry stable identity and honest time', () => {
  const message = parseMessagePage([msg('m1', Date.parse('2026-10-29T22:01:00+08:00'), { at: ['u-self'], content: '你好' })], 'g1').messages[0]
  assert.ok(message)
  const envelope = toEnvelope(message, { conversationId: 'g1', chatType: 2, label: '项目群' }, 'yzj-param-desc-at')
  assert.equal(envelope.eventKey, 'yzj:g1:m1')
  assert.equal(envelope.occurredAt, '2026-10-29T14:01:00.000Z')
  const data = envelope.data as Record<string, unknown>
  assert.equal(data['textTruncated'], false)
  assert.equal(data['senderName'], null, 'names are never guessed beyond the catalog label')
})

/* ------------------------------------------------ run adapter (Host-scheduled) */

/** A Host double for the run adapter: per-run commit faces plus a fence. */
interface AdapterHost {
  value: string | null
  revision: number
  readonly commits: { readonly run: number; readonly batch: IngestBatch }[]
  /** Runs whose commit face the Host has fenced (a later run bumped the generation). */
  readonly fenced: Set<number>
}

const ADAPTER_INSTANCE = 'col-adapter'

/** One run context as the Host would hand it to `run(ctx)`. */
function adapterCtx(host: AdapterHost, runId: number, maxEvents = 200): CollectorRunContext<YzjConfig> {
  return {
    instanceId: ADAPTER_INSTANCE,
    sourceId: 'src-adapter',
    type: 'quno/yzj-im',
    config: focusedConfig(),
    runId,
    checkpoint: { value: host.value, revision: host.revision },
    limits: { maxEventsPerRun: maxEvents, maxBytesPerRun: 2 * 1024 * 1024 },
    logger: { info: () => {}, warn: () => {} },
    signal: new AbortController().signal,
    commit: async (batch: IngestBatch): Promise<IngestAck> => {
      if (host.fenced.has(runId)) {
        // The Host's refusal, structurally (the plugin never sees its class).
        throw Object.assign(new Error(`run ${String(runId)} is fenced`), {
          name: 'QunoIngressError',
          shape: { code: 'stale-generation', message: 'fenced', retryable: false },
        })
      }
      host.commits.push({ run: runId, batch })
      host.revision += 1
      if (batch.checkpointAfter != null) host.value = batch.checkpointAfter.value
      return {
        batchId: `bat-${String(host.revision)}`,
        batchKey: batch.batchKey,
        accepted: [],
        eventCount: batch.events.length,
        acceptedCount: batch.events.length,
        duplicateCount: 0,
        checkpointRevision: host.revision,
        gapReported: false,
      }
    },
  }
}

function mountAdapter(): () => void {
  const mount = factory.mount
  assert.ok(mount, 'the yzj factory owns a mount face')
  return mount({ instanceId: ADAPTER_INSTANCE, config: focusedConfig() }) ?? (() => {})
}

test('adapter: one worker spans runs — discovery stays paced and commits ride the current run', async () => {
  resetTokens('default')
  resetCollectorWorkers()
  const t0 = NOW
  const host: AdapterHost = { value: v2Pinned('m1', ['m1']), revision: 0, commits: [], fenced: new Set() }
  let dispose = mountAdapter()
  try {
    const exec = queueExec([
      whoamiRun(),
      ok([conv('g1', '项目群', 2, 'm9')]),
      ok([
        msg('m2', t0 + 1_000, { at: ['u-self'] }),
        msg('m3', t0 + 2_000, { at: ['u-self'] }),
      ]),
    ])
    const first = await runCollector(adapterCtx(host, 1, 1), exec)
    assert.equal(first.ok, true)
    assert.ok(first.ok && typeof first.nextRunAtMs === 'number', 'a backlog continuation hints the next run')
    assert.deepEqual(host.commits.flatMap(commit => commit.batch.events.map(event => event.eventKey)), ['yzj:g1:m2'])

    // Run 2 starts → the Host bumps the generation and fences run 1's face.
    host.fenced.add(1)
    exec.push(whoamiRun(), ok([msg('m3', t0 + 2_000, { at: ['u-self'] })]))
    const second = await runCollector(adapterCtx(host, 2, 1), exec)
    assert.equal(second.ok, true, 'the continuation commits through the CURRENT run, never the fenced one')
    assert.equal(exec.calls.filter(call => call.includes('recent')).length, 1, 'run 2 is not discovery-due: the worker kept its pacing')
    assert.deepEqual(exec.calls[3], ['--profile', 'default', 'whoami'])
    const runTwo = host.commits.filter(commit => commit.run === 2)
    assert.deepEqual(runTwo.flatMap(commit => commit.batch.events.map(event => event.eventKey)), ['yzj:g1:m3'])

    // A remount (pause/reconfigure) drops the slot: the next run is a fresh worker.
    dispose()
    dispose = mountAdapter()
    exec.push(whoamiRun(), ok([conv('g1', '项目群', 2, 'm3')]))
    const third = await runCollector(adapterCtx(host, 3), exec)
    assert.equal(third.ok, true)
    assert.equal(exec.calls.filter(call => call.includes('recent')).length, 2, 'a fresh worker is discovery-due again')
    assert.equal(exec.calls.length, 7, 'watermark equals the stored cursor → no message read')
  } finally {
    dispose()
  }
})

test('adapter: a fatal round drops the worker so a re-enable re-verifies instead of replaying', async () => {
  resetTokens('default')
  resetCollectorWorkers()
  const host: AdapterHost = { value: v2Pinned('m1', ['m1']), revision: 0, commits: [], fenced: new Set() }
  const dispose = mountAdapter()
  try {
    const exec = queueExec([whoamiRun('u-other')])
    const outcome = await runCollector(adapterCtx(host, 1), exec)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok)
    assert.equal(outcome.failure.fatal, true)
    assert.equal(outcome.failure.code, 'account-changed')

    // Same mount (the Host re-armed after a re-enable): a retained fatal worker
    // would refuse without any CLI call; a fresh one re-verifies identity.
    exec.push(whoamiRun('u-other'))
    const again = await runCollector(adapterCtx(host, 2), exec)
    assert.equal(exec.calls.length, 2)
    assert.ok(!again.ok && again.failure.fatal === true)
  } finally {
    dispose()
  }
})

test('adapter: a logged-out CLI maps to a non-fatal auth-required failure the Host backs off', async () => {
  resetTokens('default')
  resetCollectorWorkers()
  const host: AdapterHost = { value: null, revision: 0, commits: [], fenced: new Set() }
  const dispose = mountAdapter()
  try {
    const exec = queueExec([
      fail(3, {
        type: 'authentication',
        subtype: 'credentials_missing',
        message: 'this command requires user identity',
        hint: '运行 yzj-cli auth login --device 重新认证',
      }),
    ])
    const outcome = await runCollector(adapterCtx(host, 1), exec)
    assert.equal(outcome.ok, false)
    assert.ok(!outcome.ok)
    assert.equal(outcome.failure.state, 'auth-required')
    assert.equal(outcome.failure.fatal, undefined)
    assert.equal(outcome.failure.retryAfterMs, null, 'auth needs a human; the Host backoff governs')
    assert.match(outcome.failure.message, /auth login/)
    assert.equal(host.commits.length, 0, 'a failed read never persists a cursor')
  } finally {
    dispose()
  }
})
