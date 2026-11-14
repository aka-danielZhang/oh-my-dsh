/**
 * The v3 collection engine (redesign 2026-10-30): a continuously-progressing
 * work queue instead of monolithic rounds.
 *
 * One scheduler, one submitter, several work types that share a request
 * budget — never competing timers:
 *
 * - 近期发现: recent page 1 every `intervalSec` (default 300s) refreshes
 *   per-conversation watermarks; unchanged watermarks skip message reads.
 * - 目录续扫: persisted sweep page advances at a 2-pages/minute target,
 *   bounded per discovery task by `maxDiscoveryPages`.
 * - 消息增量 / 新会话初始化 / 冷会话探测: served from one fair queue —
 *   one page per service opportunity, then the conversation requeues, so
 *   backlog keeps flowing shard after shard instead of sleeping a full
 *   interval after 20 conversations.
 * - 失败重试: `retryNotBefore` gates selection; account-level failures pause
 *   everything, session-level failures back off independently.
 *
 * Budgets (design §4.2, calibration placeholders): an account request bucket
 * of 30 requests/minute shared per yzj profile within this Host, a shard cap
 * of `maxConversationsPerCheck` message requests or 30 seconds, and the
 * Host's per-check event/byte quotas — byte usage is actually consumed now.
 *
 * Invariants carried over from v2 (unchanged): a cursor only advances past a
 * proven contiguous prefix; the worker holds `{state, revision}` across
 * shards within its generation; an uncertain ACK retries the identical
 * batchKey/body; capacity overflow is refused loudly, never trimmed.
 *
 * @module dsh-quno-collector-yzj/round
 */

import {
  CALL_TIMEOUT_MS,
  CliFailureError,
  classifyRun,
  parseEnvelope,
  parseIdentity,
  readList,
  type CliExec,
  type CliFailure,
  type Envelope,
  type YzjIdentity,
} from './cli.ts'
import { orderOf, parseMessagePage, parseRecentConversations, type YzjMessage } from './messages.ts'
import { classifyFocused } from './filter.ts'
import {
  ENTRY_KEY_MIGRATION_DONE,
  ENTRY_KEY_MIGRATION_SNAPSHOT,
  ENTRY_KEY_SESSION_PREFIX,
  ENTRY_STORAGE_CAPACITY,
  INIT_BACKOFF_MINUTES,
  isLegacyBlobRoot,
  isV3Root,
  LABEL_CAP,
  MAX_SESSIONS,
  emptyV2,
  migrateV1,
  parseCheckpoint,
  pushSeen,
  serializeCheckpoint,
  serializeRoot,
  withGroup,
  type GroupCheckpoint,
  type V2Checkpoint,
} from './checkpoint.ts'
import type { YzjConfig } from './config.ts'
import type { EventEnvelope } from '../../dsh-quno/src/types.ts'

/** `im message list --limit` accepts 1–20; the CLI does not clip out-of-range values. */
export const PAGE_LIMIT = 20

/** Soft shard deadline; no new message request starts after it. */
export const SHARD_DEADLINE_MS = 30_000

/** Target gap between backlog-continuation shards (design §4.2). */
export const BACKLOG_CONTINUATION_MS = 5_000

/** Minimum delay the poll loop ever waits between shards. */
export const MIN_SHARD_GAP_MS = 1_000

/** Account request bucket: requests per minute (shared per profile, per Host). */
export const REQUESTS_PER_MINUTE = 30

/** Cold conversations become probe candidates after this long unserved. */
export const PROBE_AFTER_MS = 30 * 60_000

/** Sweep pacing target: 2 catalog pages per minute (design §4.1). */
export const SWEEP_PAGE_PACING_MS = 30_000

/** Identity conflict backoff. */
const IDENTITY_CONFLICT_BACKOFF_MS = 30 * 60_000

/** Consecutive same-cause init failures before a conversation reads 采集受阻. */
export const INIT_BLOCKED_THRESHOLD = 3

/** Everything one shard needs from the Collector runtime. */
export interface RoundDeps {
  readonly config: YzjConfig
  readonly generation: number
  readonly checkpointValue: string | null
  readonly checkpointRevision: number
  /**
   * `checkpoint-entries/v1` read face (Host capability). Present → the worker
   * keeps per-conversation entries and a small v3 root; writes ride
   * `ingestBatch`'s `checkpointPatch` in the same transaction. Absent → the
   * single-blob v2 checkpoint path.
   */
  readonly checkpointEntries?: {
    readonly list: (request: { readonly limit?: number; readonly afterKey?: string }) => {
      readonly entries: readonly { readonly key: string; readonly value: string }[]
      readonly count: number
      readonly revision: number
    }
    readonly get: (key: string) => { readonly key: string; readonly value: string } | undefined
  }
  readonly capabilities?: { readonly checkpointEntries: boolean }
  readonly limits: { readonly maxEventsPerCheck: number; readonly maxBytesPerCheck: number }
  readonly signal: AbortSignal
  readonly logger: { readonly info: (message: string) => void; readonly warn: (message: string) => void }
  readonly exec: CliExec
  readonly ingress: {
    readonly ingestBatch: (batch: {
      readonly batchKey: string
      readonly events: readonly EventEnvelope[]
      readonly checkpointAfter?: { readonly value: string; readonly revision: number } | null
      readonly checkpointPatch?: {
        readonly upserts?: readonly { readonly key: string; readonly value: string }[]
        readonly deletes?: readonly string[]
      } | null
      readonly complete?: boolean
      readonly gap?: { readonly reason: string } | null
    }) => Promise<{ readonly checkpointRevision: number }>
    readonly reportHealth: (report: {
      readonly state: 'healthy' | 'degraded' | 'rate-limited' | 'auth-required' | 'unavailable'
      readonly detail?: string
      readonly lastAttemptAt: number
      readonly lastSuccessfulSyncAt?: number
      readonly lastEventAt?: number
      readonly consecutiveFailures?: number
      readonly errorCode?: string | null
      readonly nextRetryAt?: number | null
      readonly sourceLagSec?: number | null
      readonly progress?: Record<string, unknown>
      readonly issues?: readonly { readonly code: string; readonly detail: string; readonly count?: number }[]
    }) => Promise<void>
  }
}

/** One shard's observable outcome (loop + tests). */
export interface RoundOutcome {
  readonly events: number
  /** Account-level failure: health reported, next shard backs off. */
  readonly failed: boolean
  /** The worker must stop: corrupt checkpoint, CAS conflict, stale generation or account change. */
  readonly fatal: boolean
  /** Performed initial pinning / baseline work. */
  readonly baseline: boolean
  /**
   * Epoch ms when due work exists again (token wait, backlog continuation,
   * next discovery). The loop sleeps until then, capped by the discovery
   * period; null means "nothing pending, discovery governs".
   */
  readonly nextWorkAtMs?: number | null
}

/** A coverage/happening note for the health detail (codes + counts, no text). */
interface IssueNote {
  readonly code: string
  readonly detail: string
}

/** A classified ingest refusal, detected structurally (no implementation import). */
class IngestRefusal extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'IngestRefusal'
  }
}

/** The worker must stop entirely — retrying would overwrite newer facts. */
class FatalRoundError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FatalRoundError'
  }
}

class BudgetExhausted extends Error {
  constructor(readonly nextWorkAtMs: number | null, message: string) {
    super(message)
    this.name = 'BudgetExhausted'
  }
}

/** One conversation's work target for this shard. */
interface SessionTarget {
  readonly conversationId: string
  readonly chatType: 1 | 2
  readonly label: string
}

/** Account request bucket shared by every instance of the same CLI profile. */
interface RequestBucket {
  tokens: number
  lastRefillMs: number
}

const buckets = new Map<string, RequestBucket>()

/**
 * Take one request token for `profile`. The bucket is process-wide so
 * multiple instances of the same profile share the account budget (design
 * §4.2); other processes' yzj-cli traffic is outside this Host's view.
 */
export function takeToken(profile: string, now: number): { readonly ok: boolean; readonly nextTokenAt: number } {
  const bucket = buckets.get(profile) ?? { tokens: REQUESTS_PER_MINUTE, lastRefillMs: now }
  buckets.set(profile, bucket)
  const elapsed = Math.max(0, now - bucket.lastRefillMs)
  bucket.tokens = Math.min(REQUESTS_PER_MINUTE, bucket.tokens + (elapsed / 60_000) * REQUESTS_PER_MINUTE)
  bucket.lastRefillMs = now
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { ok: true, nextTokenAt: now }
  }
  const waitMs = Math.ceil(((1 - bucket.tokens) * 60_000) / REQUESTS_PER_MINUTE)
  return { ok: false, nextTokenAt: now + waitMs }
}

/** Test seam: clear the shared account bucket for a profile. */
export function resetTokens(profile: string): void {
  buckets.delete(profile)
}

function hash32(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function toIso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString()
}

/** Newest message by timestamp, falling back to the last row when unknown (v1 legacy pin). */
function pickNewest(messages: readonly YzjMessage[]): YzjMessage | null {
  let newest: YzjMessage | null = null
  for (const message of messages) {
    if (message.sentAt === null) continue
    if (newest === null || (newest.sentAt ?? 0) < message.sentAt) newest = message
  }
  return newest ?? messages[messages.length - 1] ?? null
}

/** Oldest standing debt across conversations (needsCatchUp or gap marker). */
function oldestDebtMs(state: V2Checkpoint): number | null {
  let oldest: number | null = null
  for (const group of Object.values(state.groups)) {
    if (!group.needsCatchUp && group.gap === null) continue
    const reference = group.lastAttemptAt !== null ? Date.parse(group.lastAttemptAt) : group.syncedAt
    if (reference === null || !Number.isFinite(reference)) continue
    if (oldest === null || reference < oldest) oldest = reference
  }
  return oldest
}

/** A mutable worker: one per Collector generation, holds the checkpoint across shards. */
export interface Worker {
  /** `previousFailures` feeds honest `consecutiveFailures` health reports. */
  runRound(previousFailures?: number): Promise<RoundOutcome>
}

export function createWorker(deps: RoundDeps & { readonly now?: () => number }): Worker {
  const config = deps.config
  const focused = config.collectionMode === 'focused'
  const started = parseCheckpoint(deps.checkpointValue)
  const entriesFace = deps.checkpointEntries
  const entriesMode = deps.capabilities?.checkpointEntries === true && entriesFace !== undefined
  // The v2 parser reads a v3 root as "unknown version" — in entries mode that
  // is the healthy shape, so the corrupt refusal below is blob-mode only.
  if (!entriesMode && started.kind === 'corrupt') {
    let cached: Promise<RoundOutcome> | null = null
    return {
      runRound() {
        if (cached !== null) return cached
        cached = deps.ingress
          .reportHealth({
            state: 'degraded',
            detail: `检查点损坏，采集已停止：${started.reason}。请暂停实例并人工处理，不要清空检查点。`,
            lastAttemptAt: deps.now?.() ?? Date.now(),
            consecutiveFailures: 1,
            errorCode: 'checkpoint-corrupt',
            nextRetryAt: null,
          })
          .then(() => ({ events: 0, failed: true, fatal: true, baseline: false }))
        return cached
      },
    }
  }

  let state: V2Checkpoint = started.kind === 'v2' ? started.state : started.kind === 'v1' ? migrateV1(started.state) : emptyV2()
  let revision = deps.checkpointRevision
  let lastGoodState = state
  let lastGoodRevision = revision
  let latestRevision = revision
  /** Lazily completed once per generation: entries load or blob→entries migration. */
  let loaded = false
  /** Referential snapshot of the last ACKed groups map — the entries-mode dirty set. */
  let committedGroups: Readonly<Record<string, GroupCheckpoint>> = state.groups
  /** Tracked-conversation ceiling: Host storage capacity in entries mode. */
  const sessionCap = entriesMode ? ENTRY_STORAGE_CAPACITY : MAX_SESSIONS
  let owner: YzjIdentity | null = null
  let fatal = false
  let seq = 0

  // Shard cadence: discovery every intervalSec, sweep pages paced, watermarks
  // refreshed by whatever the discovery actually read. All in-memory — a
  // restart simply rediscovers (the first shard is always discovery-due).
  let lastDiscoveryAt = 0
  let lastSweepPageAt = 0
  const watermarks = new Map<string, { readonly lastMsgId: string | null; readonly at: number }>()

  /** Byte usage of the current shard, fed by every commit. */
  let shardBytes = 0
  let lastCommitBytes = 0

  const nowMs = (): number => deps.now?.() ?? Date.now()

  /**
   * One-time generation setup: blob mode adopts the parsed seed; entries mode
   * loads the v3 root + per-conversation entries, migrating a legacy v2 blob
   * first (redesign §5.3: the writer pauses, the blob is preserved as a
   * read-only snapshot entry, session entries go in idempotent chunks, and
   * the final transaction switches the root to v3 with the `m:done` marker).
   */
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return
    loaded = true
    if (!entriesMode) {
      revision = deps.checkpointRevision
      lastGoodRevision = revision
      latestRevision = revision
      committedGroups = state.groups
      lastGoodState = state
      return
    }
    const raw = deps.checkpointValue
    if (raw !== null && raw.trim() !== '' && !isLegacyBlobRoot(raw) && !isV3Root(raw)) {
      throw new FatalRoundError('checkpoint-corrupt', '检查点既不是 v2 blob 也不是 v3 root，拒绝启动以避免重新建基线')
    }
    if (isLegacyBlobRoot(raw)) {
      await migrateBlobToEntries(raw as string)
    } else if (isV3Root(raw)) {
      await loadFromEntries(raw as string)
    } else {
      state = emptyV2()
      revision = deps.checkpointRevision
    }
    lastGoodState = state
    lastGoodRevision = revision
    latestRevision = revision
    committedGroups = state.groups
  }

  const migrationRoundStartedAt = nowMs()
  /**
   * Empty-batch ACKs that carry only checkpoint patches, chunked ≤100 entries.
   * The Host requires every empty batch to advance the checkpoint: interim
   * chunks rewrite the legacy blob verbatim (content unchanged, revision
   * forward), and the final chunk swaps in the v3 root with the done marker.
   */
  const flushMigrationChunk = async (upserts: readonly { key: string; value: string }[], final: boolean, legacyBlob: string): Promise<void> => {
    const entries = final
      ? [...upserts, { key: ENTRY_KEY_MIGRATION_DONE, value: new Date(nowMs()).toISOString() }]
      : upserts
    seq += 1
    const body = {
      batchKey: `yzj-mig:${String(deps.generation)}:${String(migrationRoundStartedAt)}:${String(seq)}:${hash32(JSON.stringify({ entries, final }))}`,
      events: [] as readonly EventEnvelope[],
      checkpointPatch: { upserts: entries },
      checkpointAfter: { value: final ? serializeRoot(state) : legacyBlob, revision },
      complete: true,
    }
    await attemptCommit(body)
    revision = latestRevision
    lastGoodRevision = latestRevision
  }

  const migrateBlobToEntries = async (blob: string): Promise<void> => {
    const parsed = parseCheckpoint(blob)
    if (parsed.kind !== 'v2') {
      throw new FatalRoundError('checkpoint-corrupt', 'legacy blob 解析失败，拒绝迁移')
    }
    state = parsed.state
    const snapshot = { key: ENTRY_KEY_MIGRATION_SNAPSHOT, value: blob.slice(0, 200_000) }
    const groups = Object.entries(state.groups)
    deps.logger.info(`dsh-quno-collector-yzj: migrating ${String(groups.length)} conversations to checkpoint entries`)
    let chunk: { key: string; value: string }[] = [snapshot]
    for (const [conversationId, group] of groups) {
      chunk.push({ key: ENTRY_KEY_SESSION_PREFIX + conversationId, value: JSON.stringify(group) })
      if (chunk.length >= 100) {
        await flushMigrationChunk(chunk, false, blob)
        chunk = []
      }
    }
    await flushMigrationChunk(chunk, true, blob)
  }

  const loadFromEntries = async (raw: string): Promise<void> => {
    const parsed = parseCheckpoint(JSON.stringify({ ...(JSON.parse(raw) as Record<string, unknown>), v: 2, groups: {} }))
    if (parsed.kind !== 'v2') {
      throw new FatalRoundError('checkpoint-corrupt', 'v3 root 字段无法解析')
    }
    state = parsed.state
    if (entriesFace === undefined) throw new FatalRoundError('checkpoint-corrupt', 'entries face unavailable')
    const groups: Record<string, GroupCheckpoint> = {}
    let afterKey: string | undefined
    for (;;) {
      const page = entriesFace.list({ limit: 200, afterKey })
      for (const entry of page.entries) {
        if (!entry.key.startsWith(ENTRY_KEY_SESSION_PREFIX)) continue
        try {
          groups[entry.key.slice(ENTRY_KEY_SESSION_PREFIX.length)] = JSON.parse(entry.value) as GroupCheckpoint
        } catch (error) {
          throw new FatalRoundError('checkpoint-corrupt', `会话状态条目损坏（${entry.key}）：${(error as Error).message}`)
        }
      }
      if (page.entries.length === 0) break
      afterKey = page.entries[page.entries.length - 1]?.key
      if (afterKey === undefined) break
    }
    state = { ...state, groups }
    revision = deps.checkpointRevision
  }

  /** Structurally classify an ingest error without importing the Host class. */
  const refusalOf = (error: unknown): string | null => {
    const candidate = error as { shape?: { code?: unknown }; code?: unknown }
    if (typeof candidate.shape?.code === 'string') return candidate.shape.code
    if (typeof candidate.code === 'string') return candidate.code
    return null
  }

  const attemptCommit = async (body: {
    readonly batchKey: string
    readonly events: readonly EventEnvelope[]
    readonly checkpointAfter?: { readonly value: string; readonly revision: number }
    readonly checkpointPatch?: { readonly upserts?: readonly { key: string; value: string }[]; readonly deletes?: readonly string[] }
    readonly complete?: boolean
    readonly gap?: { readonly reason: string } | null
  }): Promise<void> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const ack = await deps.ingress.ingestBatch(body)
        latestRevision = ack.checkpointRevision
        return
      } catch (error) {
        const code = refusalOf(error) ?? 'temporarily-unavailable'
        const retryable =
          code !== 'stale-generation' && code !== 'checkpoint-conflict' && code !== 'identity-conflict'
        if (attempt === 0 && retryable) {
          // Uncertain ACK: retry the IDENTICAL batchKey/body — never rebuild.
          continue
        }
        throw new IngestRefusal(code, (error as Error).message)
      }
    }
  }

  /** Capacity-checked persistence; overflow is a loud refusal, never a trim. */
  const commit = async (input: {
    readonly events: readonly EventEnvelope[]
    readonly state: V2Checkpoint
    readonly complete: boolean
    readonly gap?: { readonly reason: string } | null
    readonly roundStartedAt: number
    /** Empty batches are how positions, baselines and gaps are persisted. */
    readonly allowEmpty: boolean
  }): Promise<V2Checkpoint> => {
    if (input.events.length === 0 && !input.allowEmpty) {
      state = input.state
      lastGoodState = input.state
      return input.state
    }
    if (entriesMode) {
      // checkpoint-entries/v1: diff the groups map by reference, write only
      // what changed, and keep the root small. Events, patch, root and batch
      // receipt land in one Host transaction.
      const upserts: { key: string; value: string }[] = []
      const deletes: string[] = []
      for (const [conversationId, group] of Object.entries(input.state.groups)) {
        if (committedGroups[conversationId] !== group) {
          upserts.push({ key: ENTRY_KEY_SESSION_PREFIX + conversationId, value: JSON.stringify(group) })
        }
      }
      for (const conversationId of Object.keys(committedGroups)) {
        if (input.state.groups[conversationId] === undefined) deletes.push(ENTRY_KEY_SESSION_PREFIX + conversationId)
      }
      const rootValue = serializeRoot(input.state)
      if (Buffer.byteLength(rootValue, 'utf8') > 16 * 1024) {
        throw new FatalRoundError('checkpoint-capacity', 'v3 root 超出合理体积，拒绝提交')
      }
      const patchEmpty = upserts.length === 0 && deletes.length === 0
      if (input.events.length === 0 && patchEmpty) {
        state = input.state
        lastGoodState = input.state
        return input.state
      }
      seq += 1
      const fingerprint = hash32(JSON.stringify({
        r: rootValue,
        u: upserts.map(entry => entry.key),
        d: deletes,
        k: input.events.map(event => event.eventKey),
        f: input.complete,
        g: input.gap?.reason ?? null,
      }))
      const batchKey = `yzj:${String(deps.generation)}:${String(input.roundStartedAt)}:${String(seq)}:${fingerprint}`
      const body = {
        batchKey,
        events: input.events,
        checkpointAfter: { value: rootValue, revision },
        ...(patchEmpty ? {} : { checkpointPatch: { ...(upserts.length > 0 ? { upserts } : {}), ...(deletes.length > 0 ? { deletes } : {}) } }),
        complete: input.complete,
        ...(input.gap === undefined || input.gap === null ? {} : { gap: input.gap }),
      }
      await attemptCommit(body)
      state = input.state
      lastGoodState = input.state
      revision = latestRevision
      lastGoodRevision = latestRevision
      committedGroups = input.state.groups
      lastCommitBytes = rootValue.length + upserts.reduce((total, entry) => total + entry.value.length, 0)
      return input.state
    }
    const serialized = serializeCheckpoint(input.state)
    if (!serialized.ok) throw new FatalRoundError('checkpoint-capacity', `检查点超出容量预算（${serialized.reason}）`)
    lastCommitBytes = serialized.bytes
      + input.events.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0)
    seq += 1
    const fingerprint = hash32(JSON.stringify({
      k: input.events.map(event => event.eventKey),
      c: serialized.json,
      f: input.complete,
      g: input.gap?.reason ?? null,
    }))
    const batchKey = `yzj:${String(deps.generation)}:${String(input.roundStartedAt)}:${String(seq)}:${fingerprint}`
    const body = {
      batchKey,
      events: input.events,
      checkpointAfter: { value: serialized.json, revision },
      complete: input.complete,
      ...(input.gap === undefined || input.gap === null ? {} : { gap: input.gap }),
    }
    await attemptCommit(body)
    state = input.state
    lastGoodState = input.state
    revision = latestRevision
    lastGoodRevision = latestRevision
    return input.state
  }

  /**
   * One CLI call: consumes an account token, honours the shard deadline, and
   * enforces the per-call timeout. A token miss ends the shard with the next
   * token time attached.
   */
  const call = async (
    args: readonly string[],
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
  ): Promise<Envelope> => {
    const at = nowMs()
    const token = takeToken(config.yzjProfile, at)
    if (!token.ok) {
      budget.nextWorkAtMs = budget.nextWorkAtMs === null
        ? token.nextTokenAt
        : Math.min(budget.nextWorkAtMs, token.nextTokenAt)
      throw new BudgetExhausted(token.nextTokenAt, '账户请求桶已用尽，等待令牌')
    }
    const remaining = budget.deadlineAt - at
    if (remaining <= 0) throw new BudgetExhausted(budget.nextWorkAtMs, '分片时间预算用尽')
    const run = await deps.exec(args, deps.signal, Math.min(CALL_TIMEOUT_MS, Math.max(1000, remaining)))
    const failure = classifyRun(run)
    if (failure !== null) throw new CliFailureError(failure)
    const envelope = parseEnvelope(run.stdout)
    if (envelope === null) {
      throw new CliFailureError({ state: 'degraded', code: 'bad-envelope', detail: 'CLI 输出不是可解析的 JSON 信封' })
    }
    return envelope
  }

  const runRound = async (previousFailures = 0): Promise<RoundOutcome> => {
    if (fatal) return { events: 0, failed: true, fatal: true, baseline: false }
    const roundStartedAt = nowMs()
    const budget: { deadlineAt: number; nextWorkAtMs: number | null } = {
      deadlineAt: roundStartedAt + SHARD_DEADLINE_MS,
      nextWorkAtMs: null,
    }
    const notes: IssueNote[] = []
    let events = 0
    let baseline = false
    shardBytes = 0

    try {
      // -- 0. One-time setup: entries load or legacy-blob migration.
      await ensureLoaded()

      // -- 1. Identity: every shard that starts network work re-verifies.
      const envelope = await call(['--profile', config.yzjProfile, 'whoami'], budget)
      const identity = parseIdentity(envelope)
      if (identity === null) {
        throw new CliFailureError({ state: 'degraded', code: 'whoami-shape', detail: 'whoami 响应缺少可绑定的 openId' })
      }
      if (
        state.owner !== null &&
        (state.owner.openId !== identity.openId ||
          (identity.orgId !== null && state.owner.orgId !== null && state.owner.orgId !== identity.orgId))
      ) {
        fatal = true
        await deps.ingress.reportHealth({
          state: 'degraded',
          detail: '云之家账号身份与实例绑定的 (orgId, openId) 不一致，采集已停止。请为该账号新建实例，或在明确迁移语义后处理旧实例。',
          lastAttemptAt: roundStartedAt,
          consecutiveFailures: previousFailures + 1,
          errorCode: 'account-changed',
          nextRetryAt: null,
        }).catch(() => {})
        return { events: 0, failed: true, fatal: true, baseline: false }
      }
      owner = identity

      // -- 2. Structural first-commit: owner binding, v1→v2 migration and the
      // focused enable time must be durable BEFORE any message read.
      let structural = false
      if (state.owner === null) {
        state = { ...state, owner: { orgId: identity.orgId, openId: identity.openId } }
        structural = true
      }
      if (focused && state.focusedSince === null) {
        state = { ...state, focusedSince: new Date(roundStartedAt).toISOString() }
        structural = true
      }
      if (structural) {
        await commit({ events: [], state, complete: true, roundStartedAt, allowEmpty: true })
      }

      // -- 3. Discovery work, when due: page 1 every intervalSec, sweep pages
      // paced at 2/minute. Both refresh watermarks and the tracked set.
      if (focused) {
        await runDiscovery(budget, notes, roundStartedAt)
      }

      // -- 4. Selection and service: fair queue, one page per opportunity.
      const plan = selectWork(roundStartedAt)
      let served = 0
      for (const target of plan.serve) {
        if (deps.signal.aborted) break
        if (served >= config.maxConversationsPerCheck) break
        if (shardBytes >= deps.limits.maxBytesPerCheck) break
        if (nowMs() >= budget.deadlineAt) break
        const outcome = await collectSession(target, budget, notes, roundStartedAt)
        if (outcome.baseline) baseline = true
        events += outcome.events
        shardBytes += lastCommitBytes
        served += 1
      }
      const pending = plan.candidates - plan.serve.length
      const oldestPendingAgeSec = plan.oldestPendingAt === null
        ? null
        : Math.max(0, Math.round((roundStartedAt - plan.oldestPendingAt) / 1000))

      // -- 5. Health: progress is not a fault; only real blockages degrade.
      const summary = await healthReport({ roundStartedAt, notes, pending, oldestPendingAgeSec, events })
      const wake = wakeTime(budget, plan, roundStartedAt)
      return { events, failed: false, fatal: false, baseline, nextWorkAtMs: wake }
    } catch (error) {
      if (error instanceof FatalRoundError) {
        fatal = true
        await deps.ingress.reportHealth({
          state: 'degraded',
          detail: `采集已停止：${error.message}`,
          lastAttemptAt: roundStartedAt,
          consecutiveFailures: previousFailures + 1,
          errorCode: error.code,
          nextRetryAt: null,
        }).catch(() => {})
        return { events, failed: true, fatal: true, baseline }
      }
      if (error instanceof BudgetExhausted) {
        const summary = await healthReport({ roundStartedAt, notes, pending: null, oldestPendingAgeSec: null, events })
        void summary
        return { events, failed: false, fatal: false, baseline, nextWorkAtMs: error.nextWorkAtMs ?? (roundStartedAt + BACKLOG_CONTINUATION_MS) }
      }
      if (error instanceof CliFailureError) {
        await reportAccountFailure(error.failure, roundStartedAt, previousFailures + 1)
        return { events, failed: true, fatal: false, baseline }
      }
      if (error instanceof IngestRefusal) {
        if (error.code === 'quota-exceeded') {
          // Storage capacity is a hard stop: shrinking scope is a user choice.
          fatal = true
          await deps.ingress.reportHealth({
            state: 'degraded',
            detail: '检查点条目超出存储容量上限，采集已停止。请缩小群白名单或清理范围后再启用。',
            lastAttemptAt: roundStartedAt,
            consecutiveFailures: previousFailures + 1,
            errorCode: 'checkpoint-capacity',
            nextRetryAt: null,
          }).catch(() => {})
          return { events, failed: true, fatal: true, baseline }
        }
        if (error.code === 'validation') {
          // Structural refusal: retrying the same body can never succeed.
          fatal = true
          await deps.ingress.reportHealth({
            state: 'degraded',
            detail: `批次被 Host 结构校验拒绝，采集已停止：${error.message}`,
            lastAttemptAt: roundStartedAt,
            consecutiveFailures: previousFailures + 1,
            errorCode: 'validation',
            nextRetryAt: null,
          }).catch(() => {})
          return { events, failed: true, fatal: true, baseline }
        }
        if (error.code === 'stale-generation' || error.code === 'checkpoint-conflict') {
          fatal = true
          await deps.ingress.reportHealth({
            state: 'degraded',
            detail: `检查点已被并写入员推进（${error.code}），本采集代际停止`,
            lastAttemptAt: roundStartedAt,
            consecutiveFailures: previousFailures + 1,
            errorCode: error.code,
            nextRetryAt: null,
          }).catch(() => {})
          return { events, failed: true, fatal: true, baseline }
        }
        // Restore the last durably ACKed position; the next shard retries from there.
        state = lastGoodState
        revision = lastGoodRevision
        const now = nowMs()
        await deps.ingress.reportHealth({
          state: 'unavailable',
          detail: `批次提交未确认，已回到最近一次确认的位置，下片原样重试：${error.message}`,
          lastAttemptAt: roundStartedAt,
          consecutiveFailures: previousFailures + 1,
          errorCode: 'ack-uncertain',
          nextRetryAt: now + Math.max(config.intervalSec * 1000, 60_000),
        }).catch(() => {})
        return { events, failed: true, fatal: false, baseline }
      }
      throw error
    }
  }

  /** Assemble the shard's health report: progress by default, faults when real. */
  const healthReport = async (input: {
    readonly roundStartedAt: number
    readonly notes: readonly IssueNote[]
    readonly pending: number | null
    readonly oldestPendingAgeSec: number | null
    readonly events: number
  }): Promise<void> => {
    const now = nowMs()
    const tracked = Object.keys(state.groups).length
    const blocked = Object.values(state.groups).filter(group => group.gap?.code === 'init-blocked')
    const rejected = state.coverage.capacityRejectedIds ?? []
    const truncated = state.coverage.directoryTruncated
    const lastProgressAt = state.coverage.lastProgressAt ?? null

    // Structural issues headline; per-shard diagnostics follow. Standing gaps
    // stay visible in quiet shards — a clean pass never erases an unhandled
    // coverage debt (v2 §10).
    const issues: IssueNote[] = []
    if (blocked.length > 0) {
      issues.push({ code: 'session-blocked', detail: `${String(blocked.length)} 个会话初始化受阻，其余会话正常` })
    }
    const standing = new Map<string, number>()
    for (const group of Object.values(state.groups)) {
      if (group.gap === null || group.gap.code === 'init-blocked') continue
      standing.set(group.gap.code, (standing.get(group.gap.code) ?? 0) + 1)
    }
    for (const [code, count] of standing) {
      issues.push({ code, detail: `${String(count)} 个会话存在待处理缺口（${code}）` })
    }
    if (rejected.length > 0) {
      issues.push({ code: 'directory-capacity', detail: `部分会话未覆盖：至少 ${String(rejected.length)} 个（可缩小群白名单）` })
    }
    if (input.oldestPendingAgeSec !== null && input.oldestPendingAgeSec > config.pendingWaitThresholdSec) {
      issues.push({ code: 'collection-delayed', detail: `采集延迟：最老待检查会话已等待 ${String(Math.round(input.oldestPendingAgeSec / 60))} 分钟` })
    }
    if (truncated && lastProgressAt !== null && now - lastProgressAt > config.directoryStalledSec * 1000) {
      issues.push({ code: 'directory-stalled', detail: `目录扫描受阻：${String(Math.round((now - lastProgressAt) / 60000))} 分钟无进展（第 ${String(state.discovery.nextPage)} 页）` })
    }
    for (const note of input.notes) issues.push(note)

    const pendingText = input.pending === null
      ? ''
      : `，待检查 ${String(input.pending)} 个`
    const waitText = input.oldestPendingAgeSec === null
      ? ''
      : `，最早等待 ${input.oldestPendingAgeSec < 60 ? '1 分钟内' : `${String(Math.round(input.oldestPendingAgeSec / 60))} 分钟`}`
    const progressLine = `正在同步：已跟踪 ${String(tracked)} 个会话${pendingText}${waitText}`
      + (truncated ? `；目录已扫描到第 ${String(Math.max(1, state.discovery.nextPage - 1))} 页` : '')
    const degraded = issues.length > 0
    const detail = degraded
      ? `${progressLine}。${issues.map(issue => `${issue.code}: ${issue.detail}`).join('；')}`.slice(0, 1900)
      : progressLine
    const debt = oldestDebtMs(state)
    const oldestPendingAt = input.oldestPendingAgeSec === null
      ? null
      : now - input.oldestPendingAgeSec * 1000
    await deps.ingress.reportHealth({
      state: degraded ? 'degraded' : 'healthy',
      detail,
      lastAttemptAt: input.roundStartedAt,
      lastSuccessfulSyncAt: now,
      ...(input.events > 0 ? { lastEventAt: now } : {}),
      consecutiveFailures: 0,
      errorCode: degraded ? (issues[0]?.code ?? null) : null,
      nextRetryAt: null,
      sourceLagSec: debt === null ? null : Math.max(0, Math.round((now - debt) / 1000)),
      progress: {
        trackedConversations: tracked,
        ...(input.pending === null ? {} : { pendingConversations: input.pending }),
        blockedConversations: blocked.length,
        ...(oldestPendingAt === null ? {} : { oldestPendingAt }),
        ...(state.coverage.lastProgressAt !== undefined && state.coverage.lastProgressAt !== null
          ? { lastDirectoryProgressAt: state.coverage.lastProgressAt }
          : {}),
        ...(state.discovery.lastSweepCompletedAt !== null
          ? { lastSweepCompletedAt: Date.parse(state.discovery.lastSweepCompletedAt) }
          : {}),
        nextDiscoveryPage: state.discovery.nextPage,
        requestBudgetPerMinute: REQUESTS_PER_MINUTE,
      },
      issues: issues.map(issue => ({ code: issue.code, detail: issue.detail })),
    }).catch(() => {})
  }

  const reportAccountFailure = async (failure: CliFailure, startedAt: number, failures: number): Promise<void> => {
    const backoff =
      failure.state === 'auth-required'
        ? null
        : failure.state === 'rate-limited'
          ? Math.min(30 * 60_000, Math.max(config.intervalSec * 1000, 120_000))
          : Math.max(config.intervalSec * 1000, 60_000)
    await deps.ingress.reportHealth({
      state: failure.state,
      detail: failure.detail,
      lastAttemptAt: startedAt,
      consecutiveFailures: failures,
      errorCode: failure.code,
      ...(backoff === null ? { nextRetryAt: null } : { nextRetryAt: (deps.now?.() ?? Date.now()) + backoff }),
    }).catch(() => {})
  }

  // ------------------------------------------------------------- discovery

  const catalogScan = async (
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
    pageMode: 'discovery' | 'sweep',
    continuationPages: number,
    catalogSeen: Set<string>,
    notes: IssueNote[],
    roundStartedAt: number,
  ): Promise<void> => {
    const whitelist = config.groupIds
    let truncated = false
    const stateAtStart = state
    const reject = (conversationId: string): void => {
      const ids = new Set(state.coverage.capacityRejectedIds ?? [])
      if (!ids.has(conversationId) && ids.size < 500) {
        ids.add(conversationId)
        state = { ...state, coverage: { ...state.coverage, capacityRejectedIds: [...ids] } }
      }
    }
    const consider = (entry: ReturnType<typeof parseRecentConversations>[number]): void => {
      catalogSeen.add(entry.conversationId)
      watermarks.set(entry.conversationId, { lastMsgId: entry.lastMsgId, at: roundStartedAt })
      if (entry.groupType !== 1 && entry.groupType !== 2) return
      if (entry.groupType === 2 && whitelist.length > 0 && !whitelist.includes(entry.conversationId)) return
      const existing = state.groups[entry.conversationId]
      const seenAt = new Date(roundStartedAt).toISOString()
      if (existing !== undefined) {
        // Labels freeze at first observation — display names never churn events.
        const next: GroupCheckpoint = {
          ...existing,
          groupType: entry.groupType,
          label: existing.label !== '' ? existing.label : entry.name.slice(0, LABEL_CAP),
          lastSeenInRecentAt: seenAt,
        }
        if (next !== existing) state = withGroup(state, entry.conversationId, next)
        return
      }
      if (Object.keys(state.groups).length >= sessionCap) {
        reject(entry.conversationId)
        return
      }
      state = withGroup(state, entry.conversationId, {
        groupType: entry.groupType,
        label: entry.name.slice(0, LABEL_CAP),
        cursor: null,
        initialized: false,
        seen: [],
        lastSeenInRecentAt: seenAt,
        lastAttemptAt: null,
        syncedAt: null,
        needsCatchUp: false,
        retryNotBefore: null,
        pinnedAt: null,
        gap: null,
      })
    }

    let page = Math.max(2, state.discovery.nextPage)
    let sweepCompleted = false
    let readPages = 0
    const totalPages = (pageMode === 'discovery' ? 1 : 0) + continuationPages
    for (let index = 0; index < totalPages; index += 1) {
      const isPage1 = pageMode === 'discovery' && index === 0
      const pageNumber = isPage1 ? 1 : page
      const envelope = await call(['--profile', config.yzjProfile, 'im', 'group', 'recent', '--limit', String(PAGE_LIMIT), '--page', String(pageNumber)], budget)
      const shape = pageBoundaries(envelope, '最近会话')
      for (const entry of parseRecentConversations(shape.list)) consider(entry)
      readPages += 1
      if (isPage1) {
        lastDiscoveryAt = roundStartedAt
        if (!shape.more) {
          // The whole directory fits page 1: the sweep is complete without
          // spending calls on empty continuation pages.
          sweepCompleted = true
          page = 2
          break
        }
        truncated = true
        continue
      }
      lastSweepPageAt = roundStartedAt
      if (shape.more) {
        truncated = true
        page += 1
      } else {
        sweepCompleted = true
        break
      }
    }
    let changed = state !== stateAtStart
    if (truncated || sweepCompleted) {
      state = {
        ...state,
        discovery: {
          nextPage: sweepCompleted ? 2 : page,
          sweepStartedAt: state.discovery.sweepStartedAt ?? new Date(roundStartedAt).toISOString(),
          lastSweepCompletedAt: sweepCompleted ? new Date(roundStartedAt).toISOString() : state.discovery.lastSweepCompletedAt,
        },
        coverage: {
          ...state.coverage,
          directoryTruncated: truncated,
          lastProgressAt: roundStartedAt,
        },
      }
      changed = true
    }
    void readPages
    if (changed) {
      try {
        // The sweep position must be durable before message work continues.
        await commit({ events: [], state, complete: true, roundStartedAt, allowEmpty: true })
      } catch (error) {
        if (error instanceof FatalRoundError && error.code === 'checkpoint-capacity') {
          state = lastGoodState
          notes.push({ code: 'directory-capacity', detail: '目录状态超出检查点容量预算，本轮新增会话未纳入' })
          return
        }
        throw error
      }
    }
  }

  /** Page-1 refresh on its period; sweep pages paced independently. */
  const runDiscovery = async (
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
    notes: IssueNote[],
    roundStartedAt: number,
  ): Promise<void> => {
    const discoveryPeriodMs = config.intervalSec * 1000
    const discoveryDue = roundStartedAt - lastDiscoveryAt >= discoveryPeriodMs
    const sweepDue = state.coverage.directoryTruncated && roundStartedAt - lastSweepPageAt >= SWEEP_PAGE_PACING_MS
    if (!discoveryDue && !sweepDue) {
      scheduleWake(budget, Math.min(
        lastDiscoveryAt + discoveryPeriodMs,
        sweepDue ? roundStartedAt : Number.MAX_SAFE_INTEGER,
      ))
      return
    }
    const mode: 'discovery' | 'sweep' = discoveryDue ? 'discovery' : 'sweep'
    const continuationPages = discoveryDue
      ? Math.max(0, config.maxDiscoveryPages - 1)
      : Math.min(2, Math.max(1, config.maxDiscoveryPages - 1))
    const catalogSeen = new Set<string>()
    await catalogScan(budget, mode, continuationPages, catalogSeen, notes, roundStartedAt)

    // Whitelist entries whose conversation type was never confirmed stay
    // unresolved — displayed, never collected as a guess.
    if (config.groupIds.length > 0) {
      const unresolved = config.groupIds.filter((id) => {
        const group = state.groups[id]
        return group === undefined || group.groupType === null
      }).length
      if (unresolved > 0) {
        notes.push({ code: 'unresolved-type', detail: `${String(unresolved)} 个白名单会话类型未确认（最近会话里未见），未采集` })
      }
    }
  }

  const scheduleWake = (budget: { nextWorkAtMs: number | null }, at: number): void => {
    if (at === Number.MAX_SAFE_INTEGER) return
    budget.nextWorkAtMs = budget.nextWorkAtMs === null ? at : Math.min(budget.nextWorkAtMs, at)
  }

  // ------------------------------------------------------------ selection

  /**
   * Build this shard's service plan. Watermark-equal conversations are
   * skipped (freshness only — a stale cache never permanently suppresses a
   * probe); the whitelist re-applies here so scope changes affect existing
   * tracking immediately; ordering is oldest-served-first across both lanes
   * with initialization work front-loaded per lane (design §4.3).
   */
  const selectWork = (now: number): {
    readonly serve: readonly SessionTarget[]
    readonly candidates: number
    readonly oldestPendingAt: number | null
  } => {
    const freshWindowMs = focused ? config.intervalSec * 1000 + 5_000 : 0
    const candidates: SessionTarget[] = []
    const consider = (conversationId: string, group: GroupCheckpoint): void => {
      if (group.retryNotBefore !== null && group.retryNotBefore > now) return
      if (focused && group.initialized) {
        const watermark = watermarks.get(conversationId)
        const fresh = watermark !== undefined && now - watermark.at <= freshWindowMs
        if (fresh) {
          const equal = (watermark.lastMsgId ?? null) === (group.cursor ?? null)
          if (equal && !group.needsCatchUp && group.gap === null) return
        } else if (
          !group.needsCatchUp && group.gap === null && group.lastAttemptAt !== null
          && Number.isFinite(Date.parse(group.lastAttemptAt))
          && now - Date.parse(group.lastAttemptAt) < PROBE_AFTER_MS
        ) {
          return
        }
      }
      candidates.push({
        conversationId,
        chatType: (group.groupType === 1 ? 1 : 2),
        label: group.label !== '' ? group.label : conversationId,
      })
    }
    if (!focused) {
      for (const groupId of config.groupIds) {
        const group = state.groups[groupId]
        if (group === undefined) continue
        consider(groupId, group)
      }
    } else {
      for (const [groupId, group] of Object.entries(state.groups)) {
        if (group.groupType !== 1 && group.groupType !== 2) continue
        // Scope changes apply to existing tracking immediately; the cursor
        // survives removal from the whitelist.
        if (group.groupType === 2 && config.groupIds.length > 0 && !config.groupIds.includes(groupId)) continue
        consider(groupId, group)
      }
    }
    const lastAttemptMs = (target: SessionTarget): number => {
      const group = state.groups[target.conversationId]
      const parsed = group?.lastAttemptAt !== undefined && group.lastAttemptAt !== null ? Date.parse(group.lastAttemptAt) : NaN
      return Number.isFinite(parsed) ? parsed : 0
    }
    const byRotation = (left: SessionTarget, right: SessionTarget): number => lastAttemptMs(left) - lastAttemptMs(right)
    const orderLane = (items: readonly SessionTarget[]): readonly SessionTarget[] => {
      const init = items.filter(target => state.groups[target.conversationId]?.initialized === false).sort(byRotation)
      const rest = items.filter(target => state.groups[target.conversationId]?.initialized !== false).sort(byRotation)
      return [...init, ...rest]
    }
    const direct = orderLane(candidates.filter(target => target.chatType === 1))
    const groupLane = orderLane(candidates.filter(target => target.chatType === 2))
    const budget = focused ? config.maxConversationsPerCheck : config.groupIds.length
    const directBudget = Math.ceil(budget / 2)
    const groupBudget = budget - directBudget
    let serve = [...direct.slice(0, directBudget), ...groupLane.slice(0, groupBudget)]
    if (serve.length < budget) {
      // A lane with no candidates lends its spare to the other.
      const chosen = new Set(serve.map(target => target.conversationId))
      for (const target of [...direct, ...groupLane]) {
        if (serve.length >= budget) break
        if (chosen.has(target.conversationId)) continue
        chosen.add(target.conversationId)
        serve.push(target)
      }
    }
    const chosenIds = new Set(serve.map(target => target.conversationId))
    const unserved = candidates.filter(target => !chosenIds.has(target.conversationId))
    // Discovery/init/probe keep at least a fifth of the opportunities: if the
    // slice crowded initialization out entirely, swap the oldest init work in.
    if (budget >= 5) {
      const reserved = Math.ceil(budget / 5)
      const initServed = serve.filter(target => state.groups[target.conversationId]?.initialized === false).length
      if (initServed < reserved) {
        const initWaiting = unserved.find(target => state.groups[target.conversationId]?.initialized === false)
        if (initWaiting !== undefined) {
          serve = [...serve.slice(0, serve.length - 1), initWaiting]
        }
      }
    }
    const finalIds = new Set(serve.map(target => target.conversationId))
    const oldestUnserved = candidates
      .filter(target => !finalIds.has(target.conversationId))
      .reduce<number | null>((oldest, target) => {
        const at = lastAttemptMs(target)
        return at === 0 ? oldest : (oldest === null ? at : Math.min(oldest, at))
      }, null)
    return { serve, candidates: candidates.length, oldestPendingAt: oldestUnserved }
  }

  /** Earliest future wake: backlog continuation, token wait, or next discovery. */
  const wakeTime = (
    budget: { nextWorkAtMs: number | null },
    plan: { readonly candidates: number; readonly serve: readonly SessionTarget[] },
    roundStartedAt: number,
  ): number | null => {
    const candidates: number[] = []
    if (plan.serve.length < plan.candidates) candidates.push(roundStartedAt + BACKLOG_CONTINUATION_MS)
    if (budget.nextWorkAtMs !== null) candidates.push(budget.nextWorkAtMs)
    candidates.push(lastDiscoveryAt + config.intervalSec * 1000)
    if (state.coverage.directoryTruncated) candidates.push(lastSweepPageAt + SWEEP_PAGE_PACING_MS)
    const wake = candidates.reduce((min, at) => Math.min(min, at), Number.MAX_SAFE_INTEGER)
    return wake === Number.MAX_SAFE_INTEGER ? null : wake
  }

  // ------------------------------------------------------------ collection

  interface SessionOutcome {
    readonly events: number
    readonly baseline: boolean
  }

  const collectSession = async (
    target: SessionTarget,
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
    notes: IssueNote[],
    roundStartedAt: number,
  ): Promise<SessionOutcome> => {
    const existing = state.groups[target.conversationId]
    const seed: GroupCheckpoint = existing ?? {
      groupType: target.chatType,
      label: target.label,
      cursor: null,
      initialized: false,
      seen: [],
      lastSeenInRecentAt: null,
      lastAttemptAt: null,
      syncedAt: null,
      needsCatchUp: false,
      retryNotBefore: null,
      pinnedAt: null,
      gap: null,
    }
    // Every service attempt records its time and clears stale backoff state —
    // a failing conversation never keeps sorting to the queue head (§2 gap 1).
    const staged: GroupCheckpoint = { ...seed, lastAttemptAt: new Date(roundStartedAt).toISOString() }
    state = withGroup(state, target.conversationId, staged)
    try {
      if (!staged.initialized) return await initialize(target, staged, budget, notes, roundStartedAt)
      if (staged.cursor === null) return await collectEmptyInitialized(target, staged, budget, notes, roundStartedAt)
      return await collectIncremental(target, staged, budget, notes, roundStartedAt)
    } catch (error) {
      // Backoffs build on the CURRENT state (earlier pages of this session may
      // already have committed this shard), never on the stale seed.
      const current = state.groups[target.conversationId] ?? staged
      if (error instanceof CliFailureError && error.failure.state === 'degraded') {
        notes.push({ code: `session-${error.failure.code}`, detail: `${target.label}：${error.failure.detail.slice(0, 120)}` })
        const backed: GroupCheckpoint = {
          ...current,
          retryNotBefore: nowMs() + Math.max(config.intervalSec * 1000, 60_000),
        }
        state = withGroup(state, target.conversationId, backed)
        await commit({
          events: [],
          state,
          complete: false,
          gap: { reason: `${target.label}：${error.failure.detail.slice(0, 150)}` },
          roundStartedAt,
          allowEmpty: true,
        })
        return { events: 0, baseline: false }
      }
      if (error instanceof IngestRefusal && error.code === 'identity-conflict') {
        state = lastGoodState
        const backed: GroupCheckpoint = {
          ...(lastGoodState.groups[target.conversationId] ?? current),
          retryNotBefore: nowMs() + IDENTITY_CONFLICT_BACKOFF_MS,
          gap: { code: 'identity-conflict', count: 1, at: new Date(nowMs()).toISOString() },
        }
        state = withGroup(state, target.conversationId, backed)
        notes.push({ code: 'identity-conflict', detail: `${target.label}：事件内容与已提交事实冲突，该会话已暂停` })
        await commit({
          events: [],
          state,
          complete: false,
          gap: { reason: `${target.label}：事件身份冲突，会话已暂停等待人工核对` },
          roundStartedAt,
          allowEmpty: true,
        })
        return { events: 0, baseline: false }
      }
      throw error
    }
  }

  /** Walk the init failure ladder; three same-cause failures read 采集受阻. */
  const initFailure = (
    group: GroupCheckpoint,
    code: 'time-missing' | 'page-order-unverified' | 'invalid-message-id',
    roundStartedAt: number,
  ): GroupCheckpoint => {
    const failures = group.initFailCode === code ? (group.initFailures ?? 0) + 1 : 1
    const backoffMin = INIT_BACKOFF_MINUTES[Math.min(failures, INIT_BACKOFF_MINUTES.length) - 1]
    const blocked = failures >= INIT_BLOCKED_THRESHOLD
    return {
      ...group,
      initialized: false,
      initFailures: failures,
      initFailCode: code,
      retryNotBefore: roundStartedAt + backoffMin * 60_000,
      gap: {
        code: blocked ? 'init-blocked' : `init-${code}`,
        count: failures,
        at: new Date(roundStartedAt).toISOString(),
      },
    }
  }

  /**
   * First observation of a conversation: establish the newest boundary.
   * Focused pins only a provable boundary and submits post-enable matches;
   * legacy keeps v1 semantics (pin the newest by time, never replay).
   */
  const initialize = async (
    target: SessionTarget,
    group: GroupCheckpoint,
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
    notes: IssueNote[],
    roundStartedAt: number,
  ): Promise<SessionOutcome> => {
    const envelope = await call(['--profile', config.yzjProfile, 'im', 'message', 'list', '--group-id', target.conversationId, '--type', 'newest', '--limit', String(PAGE_LIMIT)], budget)
    const pageShape = pageBoundaries(envelope, '消息')
    const page = parseMessagePage(pageShape.list, target.conversationId)
    const more = pageShape.more

    if (page.invalid > 0) {
      notes.push({ code: 'invalid-message-id', detail: `${target.label}：初始化页存在 ${String(page.invalid)} 个缺 msgId 的对象，按退避重试` })
      const updated = initFailure({ ...group, lastAttemptAt: new Date(roundStartedAt).toISOString() }, 'invalid-message-id', roundStartedAt)
      state = withGroup(state, target.conversationId, updated)
      await commit({
        events: [],
        state,
        complete: false,
        gap: { reason: `${target.label}：初始化页缺 msgId（${String(updated.initFailures)} 次）` },
        roundStartedAt,
        allowEmpty: true,
      })
      return { events: 0, baseline: false }
    }
    const messages = page.messages
    if (messages.length === 0) {
      // Empty conversation: initialized with no cursor; later rounds read
      // `newest` again and filter by focusedSince.
      const updated: GroupCheckpoint = {
        ...group, initialized: true, cursor: null, syncedAt: nowMs(),
        initFailures: 0, initFailCode: null, gap: null,
      }
      state = withGroup(state, target.conversationId, updated)
      await commit({ events: [], state, complete: true, roundStartedAt, allowEmpty: true })
      return { events: 0, baseline: true }
    }

    if (!focused) {
      const newest = pickNewest(messages)
      const updated: GroupCheckpoint = {
        ...group,
        initialized: true,
        cursor: newest?.msgId ?? null,
        seen: pushSeen(group.seen, messages.map(message => message.msgId)),
        pinnedAt: nowMs(),
        syncedAt: nowMs(),
        initFailures: 0,
        initFailCode: null,
        gap: null,
      }
      state = withGroup(state, target.conversationId, updated)
      await commit({
        events: [],
        state,
        complete: !more,
        ...(more ? { gap: { reason: `${target.label}：newest 还有更早历史（首轮只钉基线，不回放）` } } : {}),
        roundStartedAt,
        allowEmpty: true,
      })
      return { events: 0, baseline: true }
    }

    // Focused: time parses and page order are diagnosed separately (§6.1) —
    // neither alone may invent a boundary, and both back off independently.
    const timeMissing = messages.some(message => message.sentAt === null)
    const ordered = orderOf(messages) === 'asc'
    if (timeMissing || !ordered) {
      const code = timeMissing ? 'time-missing' : 'page-order-unverified'
      notes.push({ code, detail: `${target.label}：${timeMissing ? '存在无法解析时间' : '页面顺序无法证明升序'}，退避重试（${String((group.initFailures ?? 0) + 1)}）` })
      const updated = initFailure({ ...group, lastAttemptAt: new Date(roundStartedAt).toISOString() }, code, roundStartedAt)
      state = withGroup(state, target.conversationId, updated)
      await commit({
        events: [],
        state,
        complete: false,
        gap: { reason: `${target.label}：${code}（第 ${String(updated.initFailures)} 次）` },
        roundStartedAt,
        allowEmpty: true,
      })
      return { events: 0, baseline: true }
    }
    const focusedSinceMs = state.focusedSince === null ? 0 : Date.parse(state.focusedSince)
    let batch: EventEnvelope[] = []
    for (const message of messages) {
      if ((message.sentAt ?? 0) <= focusedSinceMs) continue
      const verdict = classifyFocused(message, owner?.openId ?? '', target.chatType)
      if (verdict.kind === 'event') batch = [...batch, toEnvelope(message, target, verdict.evidence)]
      else if (verdict.kind === 'unknown') {
        notes.push({ code: 'relevance-unknown', detail: `${target.label}：${message.msgId} 相关性未知（${verdict.code}）` })
      }
    }
    const oldest = messages[0]?.sentAt ?? null
    if (more && oldest !== null && oldest > focusedSinceMs) {
      notes.push({ code: 'init-window-exceeded', detail: `${target.label}：启用后的消息可能超出初始化窗口，首版不做更早补采` })
    }
    const cursor = messages[messages.length - 1]?.msgId ?? null
    const updated: GroupCheckpoint = {
      ...group,
      initialized: true,
      cursor,
      seen: pushSeen(group.seen, messages.map(message => message.msgId)),
      pinnedAt: nowMs(),
      syncedAt: nowMs(),
      initFailures: 0,
      initFailCode: null,
      gap: null,
    }
    state = withGroup(state, target.conversationId, updated)
    await commit({
      events: batch,
      state,
      complete: !more,
      ...(more ? { gap: { reason: `${target.label}：newest 还有更早历史（基线只钉最新窗口）` } } : {}),
      roundStartedAt,
      allowEmpty: true,
    })
    return { events: batch.length, baseline: true }
  }

  /** Initialized while empty: read `newest` again and filter by focusedSince. */
  const collectEmptyInitialized = async (
    target: SessionTarget,
    group: GroupCheckpoint,
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
    notes: IssueNote[],
    roundStartedAt: number,
  ): Promise<SessionOutcome> => {
    const envelope = await call(['--profile', config.yzjProfile, 'im', 'message', 'list', '--group-id', target.conversationId, '--type', 'newest', '--limit', String(PAGE_LIMIT)], budget)
    const pageShape = pageBoundaries(envelope, '消息')
    const page = parseMessagePage(pageShape.list, target.conversationId)
    if (page.invalid > 0) {
      notes.push({ code: 'invalid-message-id', detail: `${target.label}：存在缺 msgId 的消息对象，退避重试` })
      const updated = initFailure(group, 'invalid-message-id', roundStartedAt)
      state = withGroup(state, target.conversationId, updated)
      return { events: 0, baseline: false }
    }
    const messages = page.messages.filter(message => !group.seen.includes(message.msgId))
    if (messages.length === 0) return { events: 0, baseline: false }
    if (!focused) {
      // v1: everything visible after an empty pin is new.
      const ordered = [...messages].sort((left, right) => (left.sentAt ?? 0) - (right.sentAt ?? 0))
      const batch = ordered.map(message => toEnvelope(message, target, 'direct-incoming'))
      const updated: GroupCheckpoint = {
        ...group,
        cursor: ordered[ordered.length - 1]?.msgId ?? null,
        seen: pushSeen(group.seen, ordered.map(message => message.msgId)),
        syncedAt: nowMs(),
      }
      state = withGroup(state, target.conversationId, updated)
      await commit({ events: batch, state, complete: !pageShape.more, roundStartedAt, allowEmpty: true })
      return { events: batch.length, baseline: false }
    }
    const timeMissing = messages.some(message => message.sentAt === null)
    const ordered = orderOf(messages) === 'asc'
    if (timeMissing || !ordered) {
      const code = timeMissing ? 'time-missing' : 'page-order-unverified'
      notes.push({ code, detail: `${target.label}：无法证明最新边界，退避重试` })
      const updated = initFailure(group, code, roundStartedAt)
      state = withGroup(state, target.conversationId, updated)
      await commit({
        events: [],
        state,
        complete: false,
        gap: { reason: `${target.label}：${code}` },
        roundStartedAt,
        allowEmpty: true,
      })
      return { events: 0, baseline: false }
    }
    const focusedSinceMs = state.focusedSince === null ? 0 : Date.parse(state.focusedSince)
    let batch: EventEnvelope[] = []
    for (const message of messages) {
      if ((message.sentAt ?? 0) <= focusedSinceMs) continue
      const verdict = classifyFocused(message, owner?.openId ?? '', target.chatType)
      if (verdict.kind === 'event') batch = [...batch, toEnvelope(message, target, verdict.evidence)]
      else if (verdict.kind === 'unknown') {
        notes.push({ code: 'relevance-unknown', detail: `${target.label}：${message.msgId} 相关性未知（${verdict.code}）` })
      }
    }
    const oldestFresh = messages[0]?.sentAt ?? null
    if (pageShape.more && oldestFresh !== null && oldestFresh > focusedSinceMs) {
      gaps_note(notes, target.label)
    }
    const updated: GroupCheckpoint = {
      ...group,
      cursor: messages[messages.length - 1]?.msgId ?? null,
      seen: pushSeen(group.seen, messages.map(message => message.msgId)),
      syncedAt: nowMs(),
    }
    state = withGroup(state, target.conversationId, updated)
    await commit({ events: batch, state, complete: !pageShape.more, roundStartedAt, allowEmpty: true })
    return { events: batch.length, baseline: false }
  }

  /** Forward-only incremental service: ONE page per opportunity, then requeue. */
  const collectIncremental = async (
    target: SessionTarget,
    seed: GroupCheckpoint,
    budget: { deadlineAt: number; nextWorkAtMs: number | null },
    notes: IssueNote[],
    roundStartedAt: number,
  ): Promise<SessionOutcome> => {
    const cursor = seed.cursor as string
    const envelope = await call(
      ['--profile', config.yzjProfile, 'im', 'message', 'list', '--group-id', target.conversationId, '--msg-id', cursor, '--type', 'new', '--limit', String(PAGE_LIMIT)],
      budget,
    )
    const pageShape = pageBoundaries(envelope, '消息')
    const parsed = parseMessagePage(pageShape.list, target.conversationId)
    const more = pageShape.more
    if (parsed.invalid > 0) {
      // The traversal boundary is unknown — never advance past this position.
      notes.push({ code: 'invalid-message-id', detail: `${target.label}：增量页存在缺 msgId 的对象，该页未消费，原位退避` })
      const updated: GroupCheckpoint = {
        ...seed,
        cursor,
        needsCatchUp: true,
        retryNotBefore: nowMs() + Math.max(config.intervalSec * 1000, 60_000),
      }
      state = withGroup(state, target.conversationId, updated)
      await commit({
        events: [],
        state,
        complete: false,
        gap: { reason: `${target.label}：增量页缺 msgId，未推进` },
        roundStartedAt,
        allowEmpty: true,
      })
      return { events: 0, baseline: false }
    }
    const fresh = parsed.messages.filter(message => message.msgId !== cursor && !seed.seen.includes(message.msgId))
    if (fresh.length === 0) {
      if (more) {
        notes.push({ code: 'zero-progress', detail: `${target.label}：增量页无新消息但 more:true，原位退避` })
        const updated: GroupCheckpoint = { ...seed, cursor, needsCatchUp: true }
        state = withGroup(state, target.conversationId, updated)
        await commit({
          events: [],
          state,
          complete: false,
          gap: { reason: `${target.label}：增量页无新消息但 more:true，原位退避` },
          roundStartedAt,
          allowEmpty: true,
        })
      }
      return { events: 0, baseline: false }
    }
    const direction = orderOf(fresh)
    if (direction !== 'asc') {
      notes.push({ code: 'protocol-order', detail: `${target.label}：增量页顺序为 ${direction}，该页不推进，原位退避` })
      const updated: GroupCheckpoint = { ...seed, cursor, needsCatchUp: true }
      state = withGroup(state, target.conversationId, updated)
      await commit({
        events: [],
        state,
        complete: false,
        gap: { reason: `${target.label}：增量页顺序异常（${direction}），未推进` },
        roundStartedAt,
        allowEmpty: true,
      })
      return { events: 0, baseline: false }
    }
    // Process the page as a contiguous prefix: every message is either
    // emitted (event/byte-budget-gated) or consumed silently; the cursor
    // follows the last processed message. The first message that no longer
    // fits ends the prefix — it stays for the next shard, never a half-page.
    let batch: EventEnvelope[] = []
    let batchBytes = 0
    let seen = seed.seen
    let endCursor = cursor
    let cut = false
    for (const message of fresh) {
      let outgoing: EventEnvelope | null = null
      if (!focused) {
        outgoing = toEnvelope(message, target, 'direct-incoming')
      } else {
        const verdict = classifyFocused(message, owner?.openId ?? '', target.chatType)
        if (verdict.kind === 'event') outgoing = toEnvelope(message, target, verdict.evidence)
        else if (verdict.kind === 'unknown') {
          notes.push({ code: 'relevance-unknown', detail: `${target.label}：${message.msgId} 相关性未知（${verdict.code}）` })
        }
      }
      if (outgoing !== null) {
        const eventBytes = Buffer.byteLength(JSON.stringify(outgoing), 'utf8')
        // The pending commit's checkpoint share is approximated by the last
        // commit's size — the budget consumes REAL bytes, not a guess (§2 gap 5).
        if (
          batch.length >= deps.limits.maxEventsPerCheck
          || shardBytes + lastCommitBytes + batchBytes + eventBytes > deps.limits.maxBytesPerCheck
        ) {
          cut = true
          break
        }
        batch = [...batch, outgoing]
        batchBytes += eventBytes
      }
      endCursor = message.msgId
      seen = pushSeen(seen, [message.msgId])
    }
    const events = batch.length
    const needsCatchUp = cut || more
    const updated: GroupCheckpoint = {
      ...seed,
      cursor: endCursor,
      seen,
      needsCatchUp,
      syncedAt: nowMs(),
      gap: null,
    }
    state = withGroup(state, target.conversationId, updated)
    await commit({
      events: batch,
      state,
      complete: !cut && !more,
      ...(needsCatchUp ? { gap: { reason: `${target.label}：预算内未读完，剩余顺延下片` } } : {}),
      roundStartedAt,
      allowEmpty: true,
    })
    return { events, baseline: false }
  }

  return { runRound }
}

function gaps_note(notes: IssueNote[], label: string): void {
  notes.push({ code: 'init-window-exceeded', detail: `${label}：启用后的消息可能超出初始化窗口，首版不做更早补采` })
}

/**
 * Envelope → raw list + boolean `more`. A missing list or a missing
 * non-boolean `more` is a protocol failure, never an empty page (v2 §3) —
 * normalizing it to "nothing new" could advance a cursor over unread data.
 */
function pageBoundaries(
  envelope: Envelope,
  what: string,
): { readonly list: readonly unknown[]; readonly more: boolean } {
  const list = readList(envelope)
  if (list === null) {
    throw new CliFailureError({ state: 'degraded', code: 'protocol-shape', detail: `${what}响应缺少 data.list 数组` })
  }
  const data = envelope.data
  const more = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)['more'] : undefined
  if (typeof more !== 'boolean') {
    throw new CliFailureError({ state: 'degraded', code: 'protocol-shape', detail: `${what}响应缺少布尔型 more 字段` })
  }
  return { list, more }
}

/** Build the immutable event envelope for one message (v2 §9). */
export function toEnvelope(
  message: YzjMessage,
  target: { readonly conversationId: string; readonly chatType: 1 | 2; readonly label: string },
  evidence: 'yzj-param-desc-at' | 'direct-incoming',
): EventEnvelope {
  const label = target.label !== '' ? target.label : target.conversationId
  const occurredAt = toIso(message.sentAt)
  if (target.chatType === 2 && evidence === 'direct-incoming') {
    // Legacy selected-groups envelope: the v1 data shape, priority p2.
    const text = message.text ?? (message.msgType === null ? '（无文本）' : `（${message.msgType}）`)
    return {
      eventKey: `yzj:${target.conversationId}:${message.msgId}`,
      type: 'im.message.created',
      schema: 'quno.yzj-im.message/v1',
      subject: { key: message.msgId, revision: message.msgId, label: label.slice(0, 200) },
      operation: 'upsert',
      occurredAt,
      observedAt: new Date().toISOString(),
      summary: `${label}：${text.slice(0, 200)}`,
      data: {
        groupId: target.conversationId,
        msgId: message.msgId,
        senderOpenId: message.fromOpenId,
        msgType: message.msgType,
        text: message.text === null ? null : message.text.slice(0, 2000),
        occurredAt,
        mentionedMe: null,
      },
      priority: 'p2',
      deadline: null,
      provenance: { kind: 'observed', collector: 'dsh-quno-collector-yzj' },
      correlationKeys: [`yzj-group:${target.conversationId}`],
    }
  }
  const isMention = evidence === 'yzj-param-desc-at'
  const rawText = message.text ?? ''
  const textTruncated = rawText.length > 4000
  const text = textTruncated ? rawText.slice(0, 4000) : rawText
  const prefix = isMention ? '@我：' : '私聊：'
  const body = text === '' ? (message.msgType === null ? '（无文本）' : `（${message.msgType}）`) : text
  const summary = `${label} · ${prefix}${body}`
  return {
    eventKey: `yzj:${target.conversationId}:${message.msgId}`,
    type: 'im.message.created',
    schema: 'quno.yzj-im.message/v1',
    subject: { key: message.msgId, revision: message.msgId, label: label.slice(0, 200) },
    operation: 'upsert',
    occurredAt,
    observedAt: new Date().toISOString(),
    summary: summary.length > 200 ? `${summary.slice(0, 199)}…` : summary,
    data: {
      groupId: target.conversationId,
      chatType: target.chatType === 1 ? 'direct' : 'group',
      msgId: message.msgId,
      senderOpenId: message.fromOpenId,
      senderName: null,
      direction: 'incoming',
      msgType: message.msgType,
      text,
      textTruncated,
      replyToMsgId: null,
      occurredAt,
      mentionedMe: isMention ? true : null,
      mentionEvidence: isMention ? 'yzj-param-desc-at' : null,
    },
    priority: 'p1',
    deadline: null,
    provenance: { kind: 'observed', collector: 'dsh-quno-collector-yzj' },
    correlationKeys: isMention
      ? [`yzj-group:${target.conversationId}`, 'yzj-mentioned-me']
      : [`yzj-group:${target.conversationId}`, `yzj-direct:${target.conversationId}`],
  }
}
