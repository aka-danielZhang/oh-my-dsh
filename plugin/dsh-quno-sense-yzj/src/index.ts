/**
 * dsh-quno-sense-yzj — a REAL Sense over Yunzhijia chat, collected through
 * the host's `yzj-cli` (never through HTTP, never with a token).
 *
 * Poll mode with two collection modes (design v2):
 *
 * - `focused` (new instances): every round binds the CLI identity, sweeps the
 *   recent-conversation catalog (page 1 + a persisted cross-round sweep),
 *   and submits ONLY direct @me group messages (structured `param.desc[]`
 *   evidence) and other people's private-chat messages. Everything else is a
 *   verified non-hit; the cursor still moves past it.
 * - `selected-groups` (legacy compatibility): the v1 behavior — collect
 *   every new message of the explicitly selected groups.
 *
 * Per-conversation initialization pins the newest boundary at enable time
 * (`focusedSince`); history before it is baseline, never replayed. Reads
 * only: no send, no read receipt, no attachment download.
 *
 * @module dsh-quno-sense-yzj
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type { SenseDefinition } from '../../dsh-quno/src/types.ts'
import type { SenseFactory, SenseHandle, SenseRuntime } from '../../dsh-quno/src/senses.ts'
import { SenseOptionsError } from '../../dsh-quno/src/senses.ts'
import { CALL_TIMEOUT_MS, CLI, classifyRun, hasMore, parseEnvelope, readList, type CliExec, type CliRun } from './cli.ts'
import { createYzjCapability } from './capability.ts'
import { handleOrganRequest, registerOrganInstance } from './organ.ts'
import { parseRecentConversations, toGroupOption } from './messages.ts'
import { createWorker, MIN_SHARD_GAP_MS, type RoundDeps } from './round.ts'
import { validateConfig, type YzjConfig } from './config.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-quno-sense-yzj'

/** Waits for the Quno Host to expose the Sense registry. */
export const inject = ['qunoSenses']

/** The declaration this Sense offers to Quno. */
export const definition: SenseDefinition = {
  type: 'quno/yzj-im',
  contractVersion: 'quno.sense/v1',
  implementationVersion: '0.3.0',
  displayName: '云之家群聊',
  description: '每 5 分钟检查云之家最近会话，接收直接 @你 及他人私聊。为识别 @，本机会读取候选会话的新消息，仅把命中消息交给 Quno。不发送消息、不标已读、不下载附件。',
  eventTypes: [{ type: 'im.message.created', summary: '@我或私聊的新消息' }],
  configFields: [
    {
      key: 'collectionMode',
      label: '采集模式',
      type: 'string',
      defaultValue: 'focused',
      options: [
        { value: 'focused', label: '聚焦模式（推荐）', description: '只收群聊里直接 @我 的消息和他人发来的私聊' },
        { value: 'selected-groups', label: '选定群模式（兼容旧行为）', description: '采集所选群聊的全部新消息' },
      ],
      help: '聚焦模式按 @证据过滤；选定群模式为 0.1.x 兼容行为。',
    },
    {
      key: 'groupIds',
      label: '群聊白名单',
      type: 'string',
      multiple: true,
      discover: true,
      help: '聚焦模式：留空自动发现全部群聊与私聊；选择群聊则只采这些群（私聊始终接收）。选定群模式：必选，采集其全部新消息。',
    },
    { key: 'yzjProfile', label: 'yzj-cli Profile', type: 'string', defaultValue: 'default', help: '对应 yzj-cli --profile；一个 profile 一组凭据与配置' },
    { key: 'intervalSec', label: '发现频率（秒）', type: 'number', min: 60, step: 30, defaultValue: 300, help: '检查最近会话新活动的周期；积压会话在本周期内持续分片消化，不整轮休眠' },
    { key: 'maxConversationsPerCheck', label: '每片消息请求数', type: 'number', min: 1, max: 200, step: 1, defaultValue: 20, advanced: true, help: '单个执行分片最多发起的消息读取请求；私聊/群聊各占一半，闲置互借' },
    { key: 'maxDiscoveryPages', label: '单次目录任务页数', type: 'number', min: 2, max: 10, step: 1, defaultValue: 5, advanced: true, help: '一次发现任务最多扫描的最近会话页数（每页 20 个）；续扫按请求预算持续推进' },
    { key: 'maxPagesPerGroup', label: '每会话单次最多页数', type: 'number', min: 1, max: 20, step: 1, defaultValue: 5, advanced: true, help: '每页 20 条；默认每次服务取 1 页后让出名额，空闲时可连读' },
    { key: 'freshnessThresholdSec', label: '陈旧阈值（秒）', type: 'number', min: 60, step: 60, defaultValue: 900, advanced: true },
    { key: 'pendingWaitThresholdSec', label: '排队延迟阈值（秒）', type: 'number', min: 60, step: 60, defaultValue: 600, advanced: true, help: '最老待检查会话等待超过该时长才报「采集延迟」' },
    { key: 'directoryStalledSec', label: '目录停滞阈值（秒）', type: 'number', min: 60, step: 60, defaultValue: 900, advanced: true, help: '目录扫描超过该时长无进展才报「扫描受阻」' },
  ],
  permissions: {
    reads: ['云之家候选会话的全部增量消息（经宿主机 yzj-cli；@识别需要读取候选群的新消息，仅命中消息提交为事件）'],
    credentialKinds: ['yzj-cli-login'],
    requiresModel: false,
  },
  runtime: {
    modes: ['poll'],
    defaultIntervalSec: 300,
    minIntervalSec: 60,
    concurrency: 1,
    timeoutMs: 30_000,
    quotas: { maxEventsPerCheck: 200, maxBytesPerCheck: 2 * 1024 * 1024 },
  },
  reliability: {
    checkpoint: 'cursor',
    replay: { kind: 'bounded' },
    changeCoverage: 'sampled',
    gapDetection: 'partial',
    readOriginal: false,
  },
  // First sight pins the newest boundary / focusedSince baseline; earlier
  // history is never replayed — "from the enable moment on" is the honest
  // description for both collection modes.
  firstSync: 'baseline-only',
  // On-demand read face (plan note 2026-11-08 §5): a closed op whitelist
  // served through the same CLI runner, classification and per-profile rate
  // budget as polling. The handler is bound lazily so the module-level
  // spawnCli const below is initialized by the time an exchange arrives.
  // reliability.readOriginal stays false on purpose: the stored event payload
  // is truncated (2000/4000 chars) and edit/recall events are invisible —
  // this exchange face is orthogonal to that declaration.
  organ: {
    handleRequest: (request) => handleOrganRequest(request, spawnCli),
  },
  defaults: {
    collectionMode: 'focused',
    intervalSec: 300,
    maxConversationsPerCheck: 20,
    maxDiscoveryPages: 5,
    maxPagesPerGroup: 5,
    yzjProfile: 'default',
    freshnessThresholdSec: 900,
    pendingWaitThresholdSec: 600,
    directoryStalledSec: 900,
  },
}

/** Minimal structural registry face. */
interface SenseRegistryFace {
  register(definition: unknown, factory: unknown): () => Promise<void>
}

/** Minimal structural face of the host's CLI capability broker. */
interface CliBrokerFace {
  register(provider: unknown): () => void
}

/** Register the Sense and its structured read capability while mounted. */
export function apply(ctx: Context): void {
  const registry = ctx.get('qunoSenses') as unknown as SenseRegistryFace | undefined
  if (registry === undefined) throw new Error('dsh-quno-sense-yzj: qunoSenses service is not mounted')
  ctx.effect(() => registry.register(definition, factory), 'dsh-quno-sense-yzj: registration')

  // The capability is a separate surface from polling: it stays available
  // while the instance is paused (configuring the account is the
  // authorization), and disappears with the plugin, not with a schedule.
  const broker = ctx.get('qunoCli') as unknown as CliBrokerFace | undefined
  if (broker === undefined) {
    ctx.logger.warn('dsh-quno-sense-yzj: qunoCli is not mounted; the structured read capability (quno_cli_call) stays unavailable')
    return
  }
  ctx.effect(() => broker.register(createYzjCapability(spawnCli)), 'dsh-quno-sense-yzj: cli capability')
}

/** The factory. */
export const factory: SenseFactory<YzjConfig> = {
  validateConfig,
  async probe(config) {
    // The probe answers one question: can this host run yzj-cli at all? Login
    // state is NOT a probe failure — a logged-out CLI must start the instance
    // so its health can read `auth-required` and recover after `auth login`.
    const run = await spawnCli(['--profile', config.yzjProfile, 'contact', 'user', 'get'], undefined, CALL_TIMEOUT_MS)
    if (run.failure === 'ENOENT') {
      return { ok: false, detail: `无法执行 ${CLI}：宿主机未安装或 PATH 未就绪` }
    }
    return { ok: true }
  },
  /**
   * Recent-conversation discovery for the `groupIds` whitelist. Uses the same
   * CLI runner and error classification as collection; failures are raised as
   * `SenseOptionsError` so the Host can hand the real reason to the wizard
   * (`auth-required` is not "no groups"). Private chats are shown disabled —
   * focused mode collects them automatically, no selection needed.
   */
  async listOptions(request) {
    const raw = request.config as Partial<YzjConfig> | undefined
    const profile = typeof raw?.yzjProfile === 'string' && raw.yzjProfile.trim() !== ''
      ? raw.yzjProfile.trim()
      : 'default'
    const limit = Math.min(20, Math.max(1, request.limit))
    const run = await spawnCli(
      ['--profile', profile, 'im', 'group', 'recent', '--limit', String(limit), '--page', String(request.page)],
      request.signal,
      CALL_TIMEOUT_MS,
    )
    const failure = classifyRun(run)
    if (failure !== null) throw new SenseOptionsError(failure.code, failure.detail)
    const envelope = parseEnvelope(run.stdout)
    if (envelope === null) throw new SenseOptionsError('bad-envelope', 'CLI 返回内容无法解析')
    if (envelope.success !== true) {
      throw new SenseOptionsError('bad-envelope', envelope.error?.message ?? 'CLI 返回失败信封')
    }
    const list = readList(envelope)
    if (list === null) throw new SenseOptionsError('bad-envelope', 'CLI 响应缺少 data.list 数组')
    return {
      options: parseRecentConversations(list).map(toGroupOption),
      more: hasMore(envelope),
    }
  },
  start(runtime) {
    // The on-demand face resolves the per-instance profile from the RUNNING
    // config; it exists only while this generation is live, so a stopped or
    // disabled instance never answers exchanges.
    const disposeOrgan = registerOrganInstance(runtime.instanceId, runtime.config.yzjProfile)
    const polling = startPolling(runtime, spawnCli)
    return {
      stop() {
        polling.stop()
        disposeOrgan()
      },
    }
  },
}

/**
 * Shard loop: one worker per generation holds the checkpoint across shards. A
 * successful shard continues at its reported `nextWorkAtMs` (backlog
 * continuation ≈5s, token wait, or the next discovery period) — never an
 * unconditional full-interval sleep. A failed shard backs off; a fatal one
 * (account changed, CAS conflict, corrupt checkpoint) stops the loop.
 */
function startPolling(runtime: SenseRuntime<YzjConfig>, exec: CliExec): SenseHandle {
  const worker = createWorker({
    config: runtime.config,
    generation: runtime.generation,
    checkpointValue: runtime.checkpoint.value,
    checkpointRevision: runtime.checkpoint.revision,
    checkpointEntries: runtime.checkpointEntries,
    capabilities: runtime.capabilities,
    limits: runtime.limits,
    signal: runtime.signal,
    logger: runtime.logger,
    exec,
    // The Host's ingest face is structurally the worker's (IngestBatch is a
    // superset since checkpoint-entries/v1); the variance here is read-only.
    ingress: runtime.ingress as RoundDeps['ingress'],
  })
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0

  const backoffMs = (): number =>
    Math.max(runtime.config.intervalSec * 1000, Math.min(30 * 60_000, 60_000 * 2 ** (failures - 1)))

  const schedule = (delayMs: number): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, delayMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  const tick = async (): Promise<void> => {
    if (stopped || runtime.signal.aborted) return
    try {
      const outcome = await worker.runRound(failures)
      if (outcome.fatal) {
        // Account changed / checkpoint refused: this generation is done.
        stopped = true
        return
      }
      if (outcome.failed) {
        failures += 1
        schedule(backoffMs())
        return
      }
      failures = 0
      const at = outcome.nextWorkAtMs ?? (Date.now() + runtime.config.intervalSec * 1000)
      const delay = Math.max(MIN_SHARD_GAP_MS, Math.min(at - Date.now(), runtime.config.intervalSec * 1000))
      schedule(delay)
    } catch (error) {
      failures += 1
      runtime.logger.warn(`采集分片失败：${(error as Error).message}`)
      schedule(backoffMs())
    }
  }

  void tick()
  return {
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

/** Spawn `yzj-cli` with a deadline and no shell. */
export const spawnCli: CliExec = async (args, signal, timeoutMs) => {
  return await new Promise<CliRun>((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const finish = (run: CliRun): void => {
      if (settled) return
      settled = true
      resolve(run)
    }
    let child: ChildProcess
    try {
      child = spawn(CLI, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'spawn-failed'
      finish({ code: null, stdout: '', stderr: '', failure: code })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr, failure: 'timeout' })
    }, timeoutMs)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish({ code: null, stdout, stderr, failure: 'aborted' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish({ code: null, stdout, stderr, failure: error.code ?? 'spawn-failed' })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      finish({ code, stdout, stderr, failure: null })
    })
  })
}

export default { name, inject, apply, definition, factory }

// Convenience re-exports: the pure surface the tests (and curious neighbors)
// consume without reaching into internals.
export { validateConfig } from './config.ts'
export type { YzjConfig, CollectionMode } from './config.ts'
export { CALL_TIMEOUT_MS, CLI, classifyRun, hasMore, parseEnvelope, parseErrorEnvelope } from './cli.ts'
export type { CliExec, CliFailure, CliRun, Envelope, YzjIdentity } from './cli.ts'
export { boundOrganList, handleOrganRequest, ORGAN_BOUNDS, ORGAN_OPS, parseOrganPayload, registerOrganInstance } from './organ.ts'
export type { OrganOp, ParsedOrganPayload } from './organ.ts'
export {
  extractAtMentions,
  orderOf,
  parseMessagePage,
  parseRecentConversations,
  parseSentAt,
  toGroupOption,
} from './messages.ts'
export type { RecentConversation, YzjMessage } from './messages.ts'
export { classifyFocused } from './filter.ts'
export type { FocusedSkipReason, FocusedUnknownCode, FocusedVerdict } from './filter.ts'
export {
  CAPACITY_REJECTED_CAP,
  CHECKPOINT_MAX_BYTES,
  ENTRY_KEY_MIGRATION_DONE,
  ENTRY_KEY_MIGRATION_SNAPSHOT,
  ENTRY_KEY_SESSION_PREFIX,
  ENTRY_STORAGE_CAPACITY,
  INIT_BACKOFF_MINUTES,
  LABEL_CAP,
  MAX_SESSIONS,
  SEEN_CAP,
  emptyV2,
  isLegacyBlobRoot,
  isV3Root,
  migrateV1,
  parseCheckpoint,
  serializeCheckpoint,
  serializeRoot,
} from './checkpoint.ts'
export type { ParsedCheckpoint, V1Checkpoint, V2Checkpoint } from './checkpoint.ts'
export {
  BACKLOG_CONTINUATION_MS,
  INIT_BLOCKED_THRESHOLD,
  MIN_SHARD_GAP_MS,
  PROBE_AFTER_MS,
  REQUESTS_PER_MINUTE,
  SHARD_DEADLINE_MS,
  SWEEP_PAGE_PACING_MS,
  createWorker,
  resetTokens,
  takeToken,
  toEnvelope,
} from './round.ts'
export type { RoundDeps, RoundOutcome, Worker } from './round.ts'
