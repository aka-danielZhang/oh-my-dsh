/**
 * Global dream-memory scheduler, auditable extraction runner, and bounded UI
 * gateway. Canonical memory content remains in the Markdown Store service.
 * @module dsh-ohmymemo/manager
 */

import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { foldConsumedWork, installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { StoreError } from './errors.ts'
import { decayFactor, horizonFor } from './capsule.ts'
import type { OhMyMemoService } from './service.ts'
import { managerDomainSpec } from './manager-domain.ts'
import {
  buildCuratorPrompt,
  buildDreamPrompt,
  cursorWatermarks,
  DREAM_MAINTENANCE_SESSION_PREFIX,
  dueCatchUpBoundary,
  extractDreamSource,
  nextScheduleBoundary,
  parseCuratorOutput,
  parseDreamOutput,
  type CuratorCatalogEntry,
  type DreamEvidence,
  type DreamSourceSession,
} from './dream.ts'
import type {
  DreamModelsSnapshot,
  DreamRunAudit,
  DreamRunSummary,
  DreamRuntimeState,
  MemoryDocument,
  MemoryOverview,
  MemoryTreeSnapshot,
  ReadMemoryFileRequest,
  RunNowResult,
  UpdateDreamSettingsRequest,
  CancelRunResult,
} from './manager-contract.ts'
import type { StoreUserConfig } from './types.ts'

/** Tunable bounds for the global maintainer row. */
export interface Config {
  maxSessionsScan: number
  maxSessionsPerRun: number
  maxMessagesPerSession: number
  maxMessageChars: number
  maxTranscriptBytes: number
  lookbackHours: number
  maxMemoriesPerRun: number
  maxCandidateContentChars: number
  candidateConfidence: number
  catchUpWindowHours: number
  runTimeoutMs: number
  agentMaxTokens: number
  deadLetterThreshold: number
  maxBrowseFiles: number
  maxFileReadBytes: number
  auditRetentionRuns: number
  curatorMaxEntries: number
}

export const Config: z<Config> = z.object({
  maxSessionsScan: z.number().step(1).min(1).max(1000).default(100),
  maxSessionsPerRun: z.number().step(1).min(1).max(100).default(12),
  maxMessagesPerSession: z.number().step(1).min(1).max(500).default(80),
  maxMessageChars: z.number().step(1).min(128).max(20_000).default(4000),
  maxTranscriptBytes: z.number().step(1).min(4096).max(1_048_576).default(96_000),
  lookbackHours: z.number().min(1).max(720).default(48),
  maxMemoriesPerRun: z.number().step(1).min(1).max(100).default(12),
  maxCandidateContentChars: z.number().step(1).min(64).max(16_000).default(300),
  candidateConfidence: z.number().min(0).max(1).default(0.82),
  catchUpWindowHours: z.number().min(1).max(168).default(36),
  runTimeoutMs: z.number().step(1).min(10_000).max(3_600_000).default(900_000),
  // Output budget must cover the worst-case JSON (maxMemoriesPerRun items of
  // maxCandidateContentChars + quote + metadata) AND the reasoning tokens a
  // thinking model spends from the same ceiling. The old 4_000 default was
  // the root cause of every-night max-tokens truncation.
  agentMaxTokens: z.number().step(1).min(256).max(65_536).default(16_384),
  // Consecutive deterministic output failures on the same evidence window
  // before the run is dead-lettered and its cursors advance anyway.
  deadLetterThreshold: z.number().step(1).min(2).max(10).default(3),
  maxBrowseFiles: z.number().step(1).min(1).max(10_000).default(1000),
  maxFileReadBytes: z.number().step(1).min(1024).max(1_048_576).default(262_144),
  auditRetentionRuns: z.number().step(1).min(1).max(1000).default(60),
  // Upper bound of catalog entries offered to the nightly curator, ordered
  // lowest decay-weight first (the stalest get their review chance first).
  curatorMaxEntries: z.number().step(1).min(8).max(512).default(64),
})

export const name = 'dsh-ohmymemo-manager'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'ohmymemo-dream': 'ohmymemo-dream'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ohMyMemoUi: OhMyMemoManager
  }
}

interface ActiveRun {
  jobId: JobId
  runId: string
  abort: AbortController
  done: Promise<JobOutcome>
}

type RunClaim = { ok: true } | { ok: false; detail: string; error?: unknown }

interface RunRequest {
  runId: string
  trigger: 'manual' | 'scheduled' | 'catch-up'
  scheduledFor: number | null
  startedAt: number
}

interface RunProgress {
  provider: string | null
  model: string | null
  agentSessionId: string | null
  promptHash: string | null
  sourceSessions: DreamRunAudit['sourceSessions']
  memoriesCreated: string[]
  memoriesRejected: number
  items: DreamRunSummary['items']
  cursors: Record<string, number>
  truncated: boolean
  /** Deterministic lifecycle maintenance outcome (runs even without evidence). */
  expiredMemories: number
  expiredCandidates: number
  maintenanceError: string | null
  /** Curator (auto_consolidation) outcome; zeros when the gate is off. */
  curatorRefreshed: number
  curatorMerged: number
  curatorRejected: number
  curatorError: string | null
}

interface SuccessfulRun {
  progress: RunProgress
  sourceMessages: number
}

/** Narrow structural view of the maintenance Agent handle (curator turn). */
interface MaintenanceAgentHandle {
  agent: {
    session: Session
    followup(message: UserMessage): unknown
    whenIdle(): Promise<unknown>
  }
  dispose(): Promise<unknown>
}

/**
 * A deterministic output failure: the model turn ended in a state no retry
 * can fix (uncompleted turn, empty text, unparseable or ungrounded output).
 * Only these accrue the dead-letter streak — timeouts, aborts, and provider
 * errors are infrastructure luck and must keep retrying.
 */
class DreamOutputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DreamOutputError'
  }
}

class DreamRunFailure extends Error {
  readonly progress: RunProgress
  readonly sourceMessages: number
  readonly poison: boolean

  constructor(message: string, progress: RunProgress, sourceMessages: number, cause: unknown, poison: boolean) {
    super(message, { cause })
    this.name = 'DreamRunFailure'
    this.progress = progress
    this.sourceMessages = sourceMessages
    this.poison = poison
  }
}

const STATE_KEY = 'dream'

/** Host authority for the Memory settings section and nightly extraction. */
export class OhMyMemoManager extends TypertRemoteService {
  static Config: z<Config> = Config
  static inject = [
    'ohMyMemo',
    'agents',
    'agentDefaultModel',
    'llm',
    'sessionQuery',
    'sessions',
    'tools',
    'systemPrompt',
    'storageDomain',
    'jobs',
    'timer',
  ]

  private readonly config: Config
  private domain?: Domain<typeof managerDomainSpec>
  private stateTable?: KvTable<string, DreamRuntimeState>
  private runsTable?: KvTable<string, DreamRunAudit>
  private state: DreamRuntimeState = initialState()
  private operationTail: Promise<void> = Promise.resolve()
  private scheduledTimer?: () => void
  private currentRun?: ActiveRun
  private accepting = true

  constructor(ctx: Context, config: Config) {
    super(ctx, 'ohMyMemoUi')
    this.config = config
  }

  protected async [Service.init](): Promise<void> {
    this.bindDomain(await this.ctx.storageDomain.open(managerDomainSpec))
    this.ctx.effect(() => () => this.teardown(), `${name}: drain and close domain`)
    this.loadStateFromDomain()

    this.ctx.effect(() => this.ctx.jobs.attachController(name), `${name}: jobs controller`)
    this.ctx.effect(() => this.memo.subscribe((change) => {
      if (change.type !== 'config-updated') return
      void this.enqueue(() => this.reconcileSchedule('config')).catch(error => this.logFailure('config reconciliation', error))
    }), `${name}: config watch`)

    void this.mountSchedulerAfterBoot()
  }

  /** Current settings, run status, Store health, and bounded file count. */
  async overview(): Promise<MemoryOverview> {
    await this.operationTail
    const config = this.memo.configSnapshot()
    const stats = this.memo.stats()
    const watch = this.memo.watchStatus()
    const tree = this.memo.displayTree(this.config.maxBrowseFiles, this.config.maxFileReadBytes)
    const route = this.dreamRoute(config.config)
    return {
      configRevision: config.hash,
      dream: {
        enabled: config.config.allow_inference_candidates,
        scheduleLocalTime: config.config.dream_schedule_local_time,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
        modelProvider: route.provider,
        model: route.model,
        effort: route.effort,
        status: this.state.status,
        activeJobId: this.state.activeJobId,
        lastAttemptAt: this.state.lastAttemptAt,
        lastSuccessAt: this.state.lastSuccessAt,
        nextRunAt: this.state.nextRunAt,
        lastResult: this.state.lastResult === null ? null : structuredClone(this.state.lastResult),
      },
      watch: {
        active: watch.active,
        degradedReason: watch.degradedReason ?? null,
      },
      counts: stats,
      files: { count: tree.files.length, truncated: tree.truncated },
    }
  }

  /** CAS-update the operative dream-memory switch, schedule, or extraction model. */
  async updateDreamSettings(request: UpdateDreamSettingsRequest): Promise<MemoryOverview> {
    this.assertAccepting()
    await this.memo.updateConfig({
      ifHash: request.ifRevision,
      patch: {
        ...(request.enabled === undefined ? {} : { allow_inference_candidates: request.enabled }),
        ...(request.scheduleLocalTime === undefined ? {} : { dream_schedule_local_time: request.scheduleLocalTime }),
        ...(request.modelProvider === undefined ? {} : { dream_model_provider: request.modelProvider }),
        ...(request.model === undefined ? {} : { dream_model: request.model }),
        ...(request.effort === undefined ? {} : { dream_effort: request.effort }),
      },
    })
    await this.operationTail
    return this.overview()
  }

  /** Model and reasoning-effort catalog for the dream-extraction pickers. */
  async models(): Promise<DreamModelsSnapshot> {
    const config = this.memo.configSnapshot().config
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    const route = this.dreamRoute(config)
    const options = [{ key: 'default', label: `跟随默认模型（${fallback.provider} / ${fallback.model}）` }]
    let total = 0
    for (const provider of this.ctx.llm.listProviders()) {
      try {
        const models = await this.ctx.llm.listModels(provider.id)
        for (const item of models) {
          if (total >= 40) break
          if (typeof item.id !== 'string') continue
          options.push({ key: `${provider.id}/${item.id}`, label: `${provider.id} / ${item.id}` })
          total += 1
        }
      } catch {
        // Provider listing failure skips that provider.
      }
      if (total >= 40) break
    }
    const efforts = [{ key: 'default', label: '跟随默认' }]
    for (const entry of await this.routeEfforts(route.provider, route.model)) {
      const info = entry as { id?: unknown; name?: unknown }
      if (typeof info.id !== 'string') continue
      efforts.push({ key: info.id, label: typeof info.name === 'string' ? info.name : info.id })
    }
    const modelOverride = config.dream_model_provider !== '' && config.dream_model !== ''
    return {
      defaultRoute: { provider: fallback.provider, model: fallback.model },
      options,
      efforts,
      currentModelKey: modelOverride ? `${config.dream_model_provider}/${config.dream_model}` : 'default',
      currentEffortKey: config.dream_effort === '' ? 'default' : config.dream_effort,
    }
  }

  /** Return the bounded browser-facing Markdown file index. */
  async tree(): Promise<MemoryTreeSnapshot> {
    return this.memo.displayTree(this.config.maxBrowseFiles, this.config.maxFileReadBytes)
  }

  /** Read one indexed Markdown file with privacy redaction and stale-tree fencing. */
  async read(request: ReadMemoryFileRequest): Promise<MemoryDocument> {
    return this.memo.displayDocument(request, {
      maxFiles: this.config.maxBrowseFiles,
      maxBytes: this.config.maxFileReadBytes,
    })
  }

  /** Start one manual extraction if the feature is enabled and idle. */
  async runNow(): Promise<RunNowResult> {
    this.assertAccepting()
    return this.enqueue(async () => {
      const currentConfig = this.memo.configSnapshot().config
      if (!currentConfig.allow_inference_candidates) return { started: false, reason: 'disabled' }
      if (this.currentRun !== undefined) {
        return { started: false, reason: 'already-running', jobId: String(this.currentRun.jobId) }
      }
      const jobId = await this.startRun({ trigger: 'manual', scheduledFor: null })
      return { started: true, jobId: String(jobId) }
    })
  }

  /** Cancel the active process-local run; dormant scheduling remains enabled. */
  async cancelRun(): Promise<CancelRunResult> {
    this.assertAccepting()
    return this.enqueue(async () => {
      const active = this.currentRun
      if (active === undefined) return { cancelled: false }
      this.ctx.jobs.kill(active.jobId, undefined, 'cancelled from Memory settings')
      return { cancelled: true }
    })
  }

  private async mountSchedulerAfterBoot(): Promise<void> {
    try {
      const loader = this.ctx.get('loader') as { await(): Promise<void> } | undefined
      await loader?.await()
      if (!this.accepting) return
      await this.enqueue(() => this.reconcileSchedule('startup'))
    } catch (error) {
      if (this.accepting) this.logFailure('startup reconciliation', error)
    }
  }

  private async reconcileSchedule(reason: 'startup' | 'config' | 'wake'): Promise<void> {
    if (!this.accepting) return
    const currentConfig = this.memo.configSnapshot().config
    const now = new Date()
    if (this.currentRun !== undefined) {
      if (!currentConfig.allow_inference_candidates) {
        this.clearScheduledTimer()
        this.state = { ...this.state, nextRunAt: null }
        this.ctx.jobs.kill(this.currentRun.jobId, undefined, 'dream memory disabled')
        return
      }
      const nextRunAt = nextScheduleBoundary(now, currentConfig.dream_schedule_local_time).getTime()
      this.state = { ...this.state, nextRunAt }
      this.armScheduledTimer(nextRunAt)
      return
    }

    if (currentConfig.allow_inference_candidates) {
      const provisionalNext = nextScheduleBoundary(now, currentConfig.dream_schedule_local_time).getTime()
      this.state = { ...this.state, nextRunAt: provisionalNext }
      this.armScheduledTimer(provisionalNext)
    } else {
      this.state = { ...this.state, nextRunAt: null }
      this.clearScheduledTimer()
    }

    let enabled = false
    let nextRunAt: number | null = null
    let due: number | undefined
    await this.memo.withMaintenanceLease(async () => {
      await this.refreshDomain()
      await this.recoverInterruptedRun()
      const config = this.memo.configSnapshot().config
      enabled = config.allow_inference_candidates
      if (!enabled) {
        await this.replaceState({ nextRunAt: null })
        return
      }
      nextRunAt = nextScheduleBoundary(now, config.dream_schedule_local_time).getTime()
      due = reason === 'config' ? undefined : dueCatchUpBoundary(
        now,
        config.dream_schedule_local_time,
        this.state.lastScheduledFor,
        this.config.catchUpWindowHours * 3_600_000,
      )
      await this.replaceState({ nextRunAt })
    })

    if (!enabled || nextRunAt === null) {
      this.clearScheduledTimer()
      return
    }
    this.armScheduledTimer(nextRunAt)
    if (due === undefined) return
    await this.startRun({ trigger: reason === 'wake' ? 'scheduled' : 'catch-up', scheduledFor: due })
  }

  private armScheduledTimer(nextRunAt: number): void {
    this.clearScheduledTimer()
    const delay = Math.max(1, nextRunAt - Date.now())
    this.scheduledTimer = this.ctx.timer.timeout(() => {
      this.scheduledTimer = undefined
      void this.enqueue(() => this.reconcileSchedule('wake')).catch(error => this.logFailure('scheduled wake', error))
    }, delay)
  }

  private clearScheduledTimer(): void {
    this.scheduledTimer?.()
    this.scheduledTimer = undefined
  }

  private async startRun(input: { trigger: RunRequest['trigger']; scheduledFor: number | null }): Promise<JobId> {
    // Execution-time gate: queued callers (runNow, scheduled wake) must not
    // start a run that escapes the teardown drain after shutdown began.
    this.assertAccepting()
    if (this.currentRun !== undefined) return this.currentRun.jobId
    const request: RunRequest = {
      runId: `dream-${randomUUID()}`,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor,
      startedAt: Date.now(),
    }
    const abort = new AbortController()
    const registered = Promise.withResolvers<void>()
    const claimed = Promise.withResolvers<RunClaim>()
    let done!: Promise<JobOutcome>
    const jobId = this.ctx.jobs.start({
      kind: 'ohmymemo-dream',
      label: 'OhMyMemo dream-memory extraction',
      outputLimitBytes: 4096,
      run: () => {
        done = registered.promise.then(() => this.runLifecycle(request, abort, claimed))
        return {
          cancel: reason => abort.abort(new Error(reason ?? 'dream-memory run cancelled')),
          done,
        }
      },
    })
    this.currentRun = { jobId, runId: request.runId, abort, done }
    registered.resolve()
    const claim = await claimed.promise
    if (!claim.ok && claim.error !== undefined) throw claim.error
    return jobId
  }

  private async runLifecycle(
    request: RunRequest,
    controller: AbortController,
    claimed: PromiseWithResolvers<RunClaim>,
  ): Promise<JobOutcome> {
    let claimSettled = false
    const settleClaim = (claim: RunClaim): void => {
      if (claimSettled) return
      claimSettled = true
      claimed.resolve(claim)
    }
    try {
      return await this.memo.withMaintenanceLease(async () => {
        await this.refreshDomain()
        await this.recoverInterruptedRun()
        const config = this.memo.configSnapshot().config
        if (!config.allow_inference_candidates || controller.signal.aborted) {
          const detail = controller.signal.aborted ? 'dream-memory run cancelled before claim' : 'dream memory is disabled'
          this.clearCurrentRun(request.runId)
          settleClaim(request.trigger === 'manual' ? { ok: false, detail, error: new Error(detail) } : { ok: false, detail })
          return { status: 'killed', detail }
        }
        if (request.scheduledFor !== null && this.state.lastScheduledFor !== null && this.state.lastScheduledFor >= request.scheduledFor) {
          const detail = 'scheduled boundary was already completed by another host'
          this.clearCurrentRun(request.runId)
          settleClaim({ ok: false, detail })
          return { status: 'completed', detail }
        }
        try {
          const active = this.currentRun
          if (active === undefined || active.runId !== request.runId) throw new Error('dream-memory Job registration was lost before claim')
          await this.replaceState({
            status: 'running',
            activeRunId: request.runId,
            activeJobId: String(active.jobId),
            activeTrigger: request.trigger,
            lastAttemptAt: request.startedAt,
          })
        } catch (error) {
          this.clearCurrentRun(request.runId)
          settleClaim({ ok: false, detail: errorMessage(error), error })
          return { status: 'failed', detail: errorMessage(error) }
        }
        settleClaim({ ok: true })
        try {
          const result = await this.ctx.agents.withoutInitiator(() => this.executeRun(request, controller))
          return await this.enqueue(() => this.finishRun(request, result, controller.signal))
        } catch (error) {
          return await this.enqueue(() => this.failRun(request, error, controller.signal))
        }
      })
    } catch (error) {
      const detail = errorMessage(error)
      this.clearCurrentRun(request.runId)
      settleClaim({ ok: false, detail, error })
      this.logFailure('dream-memory lifecycle', error)
      return { status: controller.signal.aborted ? 'killed' : 'failed', detail }
    } finally {
      settleClaim({ ok: false, detail: 'dream-memory lifecycle ended before claim' })
      this.clearCurrentRun(request.runId)
    }
  }

  /** Effective dream-extraction route: config override, else the harness default. */
  private dreamRoute(config: StoreUserConfig): { provider: string; model: string; effort: string } {
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    return {
      provider: config.dream_model_provider !== '' ? config.dream_model_provider : fallback.provider,
      model: config.dream_model !== '' ? config.dream_model : fallback.model,
      effort: config.dream_effort !== '' ? config.dream_effort : fallback.reasoningEffort ?? '',
    }
  }

  /** Effort ids the exact route exposes (empty when the route declares none). */
  private async routeEfforts(provider: string, model: string): Promise<readonly unknown[]> {
    try {
      const info = await this.ctx.llm.resolveModelInfo(provider, model)
      const reasoning = info === undefined || info === null ? undefined : info.reasoning
      return reasoning === undefined || !Array.isArray(reasoning.efforts) ? [] : reasoning.efforts
    } catch {
      return []
    }
  }

  private async executeRun(request: RunRequest, controller: AbortController): Promise<SuccessfulRun> {
    const timeout = AbortSignal.timeout(this.config.runTimeoutMs)
    const signal = AbortSignal.any([controller.signal, timeout])
    const progress = emptyProgress()
    let sourceMessages = 0
    try {
      signal.throwIfAborted()
      const source = await this.collectSources(signal)
      progress.cursors = source.emptyCursors
      const promptInput = buildDreamPrompt(source.sessions, {
        maxTranscriptBytes: this.config.maxTranscriptBytes,
        maxMemories: this.config.maxMemoriesPerRun,
        maxContentChars: this.config.maxCandidateContentChars,
      })
      // Cursor safety: prompt fitting is ordered by wall-clock time, but durable
      // logs advance by seq — advance only through each session's contiguous
      // fitted seq prefix (see cursorWatermarks for the full rationale).
      const watermarks = cursorWatermarks(source.sessions, promptInput.evidence.values())
      for (const [sessionId, watermark] of watermarks) {
        progress.cursors[sessionId] = Math.max(progress.cursors[sessionId] ?? -1, watermark)
      }
      progress.sourceSessions = source.sessions.flatMap((session) => {
        const included = [...promptInput.evidence.values()].filter(item => item.sessionId === session.sessionId)
        if (included.length === 0) return []
        const cursor = progress.cursors[session.sessionId]
        return [{
          sessionId: session.sessionId,
          capturedThroughSeq: cursor !== undefined && cursor >= 0 ? cursor : null,
          messageCount: included.length,
        }]
      })
      sourceMessages = promptInput.messageCount
      if (sourceMessages === 0) {
        // No new evidence to extract — the deterministic maintenance sweep
        // still runs: expiry is evidence-independent housekeeping.
        await this.runMaintenanceSegment(progress)
        return { progress, sourceMessages }
      }

      const configSnapshot = this.memo.configSnapshot().config
      const fallback = this.ctx.agentDefaultModel.currentSelection()
      const route = this.dreamRoute(configSnapshot)
      const model = { ...fallback, ...modelOverrides(configSnapshot, fallback, await this.routeEfforts(route.provider, route.model)) }
      progress.provider = model.provider
      progress.model = model.model
      progress.promptHash = `sha256:${hashString(promptInput.prompt)}`
      const agentSessionId = `${DREAM_MAINTENANCE_SESSION_PREFIX}${randomUUID()}` as SessionId
      progress.agentSessionId = String(agentSessionId)
      const handle = await this.ctx.agents.create({
        sessionId: agentSessionId,
        // The extractor is text-in/text-out (no tools) and never reads the
        // filesystem, so any validated absolute cwd works; the neutral home
        // directory keeps the session ungrouped (see maintenanceCwd).
        meta: { cwd: this.maintenanceCwd() },
        agentOptions: {
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
          maxTokens: this.config.agentMaxTokens,
        },
        signal,
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: model, assembled: undefined })
          agentCtx.tools.presentAs('native')
          agentCtx.tools.restrict({ allow: [] })
          agentCtx.tools.guard(() => 'OhMyMemo maintenance Agents cannot execute tools')
        },
      })
      const onAbort = (): void => handle.agent.cancel({ kind: 'hook', reason: 'dream-memory run cancelled' })
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await handle.agent.whenIdle()
        signal.throwIfAborted()
        // Supported reads only: the live `agent.session` internals are not a
        // public contract (a wild resumed shape lacked `events` and crashed
        // runs), so event windows come from the sessionQuery observation lease.
        const before = await this.ctx.sessionQuery.observeSession(agentSessionId, { signal, projectionMode: 'none' })
        let firstSeq: number
        try {
          firstSeq = (before.events.at(-1)?.seq ?? -1) + 1
        } finally {
          before[Symbol.dispose]()
        }
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: promptInput.prompt }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'notice',
            summary: 'bounded dream-memory extraction batch',
          },
        }))
        await handle.agent.whenIdle()
        await this.ctx.sessions.flush(handle.agent.session)
        const after = await this.ctx.sessionQuery.observeSession(agentSessionId, { signal, projectionMode: 'none' })
        let suffix: SessionEvent[]
        try {
          suffix = after.events.filter(event => event.seq >= firstSeq)
        } finally {
          after[Symbol.dispose]()
        }
        // A max-tokens ending is salvageable: the parse below recovers the
        // complete prefix of the memories array. Everything else but a clean
        // completion is a deterministic output failure.
        const outcome = turnOutcome(suffix)
        if (outcome !== 'completed' && outcome !== 'max-tokens') {
          throw new DreamOutputError(`dream-memory Agent did not complete (${outcome})`)
        }
        const output = lastAssistantText(suffix)
        // Parse failures (garbage, truncation with no usable prefix, or a
        // well-formed response with ungrounded items) are deterministic
        // output failures — wrap them so the dead-letter streak counts them.
        let parsed
        try {
          parsed = parseDreamOutput(output, promptInput.evidence, {
            maxMemories: this.config.maxMemoriesPerRun,
            maxContentChars: this.config.maxCandidateContentChars,
          })
        } catch (error) {
          throw new DreamOutputError(`dream-memory extraction output invalid: ${errorMessage(error)}`, { cause: error })
        }
        progress.truncated = outcome === 'max-tokens' || parsed.truncated
        progress.memoriesRejected += parsed.rejected
        for (const proposal of parsed.proposals) {
          signal.throwIfAborted()
          const scope = proposal.scope === 'user'
            ? 'user'
            : this.memo.scopeForCwd(proposal.evidence.cwd)
          if (scope === undefined || this.memo.hasMemoryKey(scope, proposal.kind, proposal.key)) {
            progress.memoriesRejected += 1
            continue
          }
          try {
            // Product decision: dream extraction writes directly as formal,
            // recallable memories — no candidate gate, no manual promotion.
            // Evidence grounding, append-origin filtering, secret fail-closed,
            // key dedupe, and the tombstone barrier below remain the rails.
            const created = await this.memo.remember({
              content: proposal.content,
              kind: proposal.kind,
              scope: proposal.scope,
              ...(proposal.evidence.cwd === undefined ? {} : { cwd: proposal.evidence.cwd }),
              key: proposal.key,
              cardinality: proposal.kind === 'episodic' ? 'multiple' : 'single',
              importance: proposal.importance,
              pinned: true,
              privacy: 'normal',
              confirmed: false,
              confidence: this.config.candidateConfidence,
              tags: proposal.tags,
              ...(proposal.validUntil !== undefined ? { validUntil: proposal.validUntil } : {}),
              sources: [{
                type: 'cross_session_inference',
                session_id: proposal.evidence.sessionId,
                event_seq: proposal.evidence.seq,
                message_id: proposal.evidence.messageId,
                quote_hash: proposal.quoteHash,
                quote_preview: proposal.quote,
                observed_at: new Date(proposal.evidence.time).toISOString(),
              }],
            })
            progress.memoriesCreated.push(created.id)
            progress.items.push({ key: proposal.key, kind: proposal.kind, content: proposal.content })
          } catch (error) {
            if (!isMemoryPolicyRefusal(error)) throw error
            progress.memoriesRejected += 1
            this.logFailure('memory policy rejection', error)
          }
        }
        await this.runMaintenanceSegment(progress)
        if (configSnapshot.auto_consolidation) {
          await this.runCuratorSegment(handle, agentSessionId, promptInput.evidence, promptInput.lines, progress, signal)
        }
        return { progress, sourceMessages }
      } finally {
        signal.removeEventListener('abort', onAbort)
        await handle.dispose()
      }
    } catch (error) {
      const failure = timeout.aborted && !controller.signal.aborted
        ? new Error(`dream-memory run exceeded ${this.config.runTimeoutMs}ms`, { cause: error })
        : error
      throw new DreamRunFailure(errorMessage(failure), progress, sourceMessages, failure, failure instanceof DreamOutputError)
    }
  }

  /**
   * Deterministic lifecycle maintenance after the extraction segment:
   * candidate sweep + expiry archive (see the store's
   * runLifecycleMaintenance). Failures are recorded in the audit detail and
   * logged — they must not poison the extraction result or the dead-letter
   * streak, which counts only deterministic output failures.
   */
  private async runMaintenanceSegment(progress: RunProgress): Promise<void> {
    try {
      const report = await this.memo.runLifecycleMaintenance()
      progress.expiredCandidates = report.candidatesExpired.length
      progress.expiredMemories = report.memoriesExpired.length
    } catch (error) {
      progress.maintenanceError = errorMessage(error)
      this.logFailure('lifecycle maintenance', error)
    }
  }

  /**
   * Curator segment (gated by `auto_consolidation`): a second followup turn
   * on the SAME maintenance Agent — no new session, same route/abort chain.
   * Input is the active-memory catalog (bounded, lowest weight first) plus
   * the extractor's evidence window; the model only PROPOSES
   * refresh/merge/keep, and every proposal faces code-side guardrails:
   * grounding (exact quote substring of a cited event), catalog membership
   * (confirmed/sensitive entries are never listed), same scope+kind for
   * merges. Curator failure is partial success — recorded in the audit
   * detail, never poisoning the extractor's dead-letter streak.
   */
  private async runCuratorSegment(
    handle: MaintenanceAgentHandle,
    agentSessionId: SessionId,
    evidence: Map<string, DreamEvidence>,
    evidenceLines: string[],
    progress: RunProgress,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const catalog = this.memo.curatorCatalog()
      if (catalog.entries.length === 0) return
      const now = new Date()
      const weightOf = (entry: CuratorCatalogEntry): number =>
        entry.importance * decayFactor(
          { confirmed: false, created_at: entry.created_at, ...(entry.last_evidenced_at !== undefined ? { last_evidenced_at: entry.last_evidenced_at } : {}) },
          now,
          horizonFor(entry.kind, catalog.horizons),
        )
      // Stalest first: the entries closest to silent expiry get their review
      // chance before the bound cuts the catalog.
      const bounded = [...catalog.entries]
        .sort((left, right) => weightOf(left) - weightOf(right) || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
        .slice(0, this.config.curatorMaxEntries)
      const prompt = buildCuratorPrompt({ catalog: bounded, evidenceLines })

      signal.throwIfAborted()
      const baseline = await this.ctx.sessionQuery.observeSession(agentSessionId, { signal, projectionMode: 'none' })
      let firstSeq: number
      try {
        firstSeq = (baseline.events.at(-1)?.seq ?? -1) + 1
      } finally {
        baseline[Symbol.dispose]()
      }
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: {
          kind: 'plugin',
          plugin: name,
          form: 'notice',
          summary: 'bounded memory curator batch',
        },
      }))
      await handle.agent.whenIdle()
      await this.ctx.sessions.flush(handle.agent.session)
      const after = await this.ctx.sessionQuery.observeSession(agentSessionId, { signal, projectionMode: 'none' })
      let suffix: SessionEvent[]
      try {
        suffix = after.events.filter(event => event.seq >= firstSeq)
      } finally {
        after[Symbol.dispose]()
      }
      const outcome = turnOutcome(suffix)
      if (outcome !== 'completed' && outcome !== 'max-tokens') {
        throw new Error(`curator Agent did not complete (${outcome})`)
      }
      const parsed = parseCuratorOutput(lastAssistantText(suffix), evidence)

      // Guardrails: only catalog-listed ids are touchable; every proposal is
      // advisory until the store's own checks accept it.
      const catalogIds = new Set(bounded.map((entry) => entry.id))
      const absorbed = new Set<string>()
      for (const proposal of parsed.merge) {
        if (!catalogIds.has(proposal.survivor) || !catalogIds.has(proposal.absorbed) || absorbed.has(proposal.absorbed) || absorbed.has(proposal.survivor)) {
          progress.curatorRejected += 1
          continue
        }
        try {
          await this.memo.mergeMemories({
            survivorId: proposal.survivor,
            absorbedId: proposal.absorbed,
            reason: 'curator merge: near-duplicate of the survivor',
          })
          absorbed.add(proposal.absorbed)
          progress.curatorMerged += 1
        } catch (error) {
          progress.curatorRejected += 1
          this.logFailure('curator merge proposal', error)
        }
      }
      for (const proposal of parsed.refresh) {
        if (!catalogIds.has(proposal.id)) {
          progress.curatorRejected += 1
          continue
        }
        try {
          await this.memo.refreshEvidence({
            id: proposal.id,
            evidencedAt: new Date(proposal.evidence.time).toISOString(),
            source: {
              type: 'cross_session_inference',
              session_id: proposal.evidence.sessionId,
              event_seq: proposal.evidence.seq,
              message_id: proposal.evidence.messageId,
              quote_hash: proposal.quoteHash,
              quote_preview: proposal.quote,
              observed_at: new Date(proposal.evidence.time).toISOString(),
            },
            reason: 'curator refresh: evidence window restates the fact',
          })
          progress.curatorRefreshed += 1
        } catch (error) {
          progress.curatorRejected += 1
          this.logFailure('curator refresh proposal', error)
        }
      }
    } catch (error) {
      if (signal.aborted) throw error
      progress.curatorError = errorMessage(error)
      this.logFailure('curator segment', error)
    }
  }

  /**
   * Validated absolute cwd for the maintenance session. The stock
   * deployment:persona prompt section renders `{{cwd}}`, which only resolves
   * when the session carries one — a cwd-less agent dies at prompt assembly.
   * The extractor never touches the filesystem, so the value is pure
   * plumbing: always the home directory. Deliberately NOT the evidence's
   * workspace — pointing the session at a repo made prompt assembly pull in
   * that repo's AGENTS.md (tens of KB of unrelated instructions paid on
   * every run) and grouped the maintenance sessions under that workspace.
   * Home keeps them ungrouped and cheap.
   */
  private maintenanceCwd(): string {
    return homedir()
  }

  private async collectSources(signal: AbortSignal): Promise<{
    sessions: DreamSourceSession[]
    emptyCursors: Record<string, number>
  }> {
    const records = (await this.ctx.sessionQuery.listSessions(signal))
      .filter(record => record.header.origin !== 'subagent' && !String(record.header.id).startsWith(DREAM_MAINTENANCE_SESSION_PREFIX))
      .slice(0, this.config.maxSessionsScan)
    const sessions: DreamSourceSession[] = []
    const emptyCursors: Record<string, number> = {}
    const cutoffMs = Date.now() - this.config.lookbackHours * 3_600_000
    for (const record of records) {
      signal.throwIfAborted()
      try {
        const observation = await this.ctx.sessionQuery.observeSession(record.header.id, { signal, projectionMode: 'none' })
        try {
          const source = extractDreamSource({
            session: observation.header,
            inheritedEventCount: observation.inheritedEventCount,
            events: observation.events,
          }, this.state.cursors[String(record.header.id)], {
            cutoffMs,
            maxMessages: this.config.maxMessagesPerSession,
            maxMessageChars: this.config.maxMessageChars,
          })
          if (source.messages.length > 0) sessions.push(source)
          else if (source.capturedThroughSeq !== null) emptyCursors[source.sessionId] = source.capturedThroughSeq
        } finally {
          observation[Symbol.dispose]()
        }
      } catch (error) {
        if (signal.aborted) signal.throwIfAborted()
        this.logFailure(`session read ${String(record.header.id)}`, error)
      }
    }
    sessions.sort((left, right) => right.lastEventAt - left.lastEventAt || left.sessionId.localeCompare(right.sessionId))
    return { sessions: sessions.slice(0, this.config.maxSessionsPerRun), emptyCursors }
  }

  private async finishRun(request: RunRequest, result: SuccessfulRun, signal: AbortSignal): Promise<JobOutcome> {
    const finishedAt = Date.now()
    const cancelled = signal.aborted
    const summary: DreamRunSummary = {
      runId: request.runId,
      trigger: request.trigger,
      startedAt: request.startedAt,
      finishedAt,
      status: cancelled ? 'cancelled' : 'success',
      sourceSessions: result.progress.sourceSessions.length,
      sourceMessages: result.sourceMessages,
      memoriesCreated: result.progress.memoriesCreated.length,
      memoriesRejected: result.progress.memoriesRejected,
      items: cancelled ? [] : result.progress.items,
      truncated: cancelled ? false : result.progress.truncated,
      expiredMemories: result.progress.expiredMemories,
      expiredCandidates: result.progress.expiredCandidates,
      curatorRefreshed: result.progress.curatorRefreshed,
      curatorMerged: result.progress.curatorMerged,
      curatorRejected: result.progress.curatorRejected,
      detail: cancelled ? 'cancelled before commit' : null,
    }
    if (!cancelled && summary.truncated) {
      summary.detail = `output hit the model's max-token ceiling; ${summary.memoriesCreated} memor(y/ies) salvaged from the complete prefix`
    }
    if (!cancelled && result.progress.maintenanceError !== null) {
      const suffix = `lifecycle maintenance failed: ${result.progress.maintenanceError}`
      summary.detail = summary.detail === null ? suffix : `${summary.detail}; ${suffix}`
    }
    if (!cancelled && result.progress.curatorError !== null) {
      const suffix = `curator failed: ${result.progress.curatorError}`
      summary.detail = summary.detail === null ? suffix : `${summary.detail}; ${suffix}`
    }
    await this.persistAudit(auditFrom(request, result.progress, summary))
    if (cancelled) {
      // Cancellation raced a finished extraction. Never advance cursors or the
      // scheduled boundary: the next run must re-examine the same evidence
      // (already-created candidates are deduplicated by their deterministic keys).
      await this.commitState({
        ...this.state,
        status: summary.status,
        activeRunId: null,
        activeJobId: null,
        activeTrigger: null,
        lastResult: summary,
      })
      return { status: 'killed', detail: 'cancelled before commit' }
    }
    await this.commitState({
      ...this.state,
      status: summary.status,
      activeRunId: null,
      activeJobId: null,
      activeTrigger: null,
      lastSuccessAt: finishedAt,
      lastScheduledFor: request.scheduledFor ?? this.state.lastScheduledFor,
      lastResult: summary,
      failureStreak: null,
      cursors: { ...this.state.cursors, ...result.progress.cursors },
    })
    return {
      status: summary.status === 'success' ? 'completed' : 'killed',
      detail: `${summary.memoriesCreated} memor(y/ies) created`,
      output: JSON.stringify({ runId: summary.runId, memoriesCreated: summary.memoriesCreated }),
    }
  }

  private async failRun(request: RunRequest, error: unknown, signal: AbortSignal): Promise<JobOutcome> {
    const finishedAt = Date.now()
    const cancelled = signal.aborted
    const detail = errorMessage(error)
    const progress = error instanceof DreamRunFailure ? error.progress : emptyProgress()
    const sourceMessages = error instanceof DreamRunFailure ? error.sourceMessages : 0
    // Dead-letter accounting: only deterministic output failures on the same
    // evidence window accrue the streak. At the threshold, advance this
    // run's cursors anyway so the next scheduled run moves past the toxic
    // window instead of re-buying the identical failure every night.
    let streak: DreamRuntimeState['failureStreak'] = null
    let cursorsPatch: Record<string, number> = {}
    let deadLettered = false
    if (!cancelled && error instanceof DreamRunFailure && error.poison && progress.promptHash !== null) {
      const previous = this.state.failureStreak
      const count = previous !== null && previous.promptHash === progress.promptHash ? previous.count + 1 : 1
      if (count >= this.config.deadLetterThreshold) {
        cursorsPatch = progress.cursors
        deadLettered = true
      } else {
        streak = { promptHash: progress.promptHash, count }
      }
    }
    const summary: DreamRunSummary = {
      runId: request.runId,
      trigger: request.trigger,
      startedAt: request.startedAt,
      finishedAt,
      status: cancelled ? 'cancelled' : 'error',
      sourceSessions: progress.sourceSessions.length,
      sourceMessages,
      memoriesCreated: progress.memoriesCreated.length,
      memoriesRejected: progress.memoriesRejected,
      items: [],
      truncated: progress.truncated,
      expiredMemories: progress.expiredMemories,
      expiredCandidates: progress.expiredCandidates,
      curatorRefreshed: progress.curatorRefreshed,
      curatorMerged: progress.curatorMerged,
      curatorRejected: progress.curatorRejected,
      detail: deadLettered
        ? `${detail}; dead-lettered after ${this.config.deadLetterThreshold} consecutive failures, evidence window skipped`
        : detail,
    }
    await this.persistAudit(auditFrom(request, progress, summary))
    await this.commitState({
      ...this.state,
      status: summary.status,
      activeRunId: null,
      activeJobId: null,
      activeTrigger: null,
      lastResult: summary,
      failureStreak: streak,
      cursors: deadLettered ? { ...this.state.cursors, ...cursorsPatch } : this.state.cursors,
    })
    this.logFailure(deadLettered ? 'dream-memory run (dead-lettered)' : 'dream-memory run', error)
    return { status: cancelled ? 'killed' : 'failed', detail: summary.detail ?? undefined }
  }

  private async persistAudit(audit: DreamRunAudit): Promise<void> {
    const table = this.requireRunsTable()
    await table.put(audit.runId, audit)
    const excess = [...table.entries()]
      .sort((left, right) => left[1].finishedAt - right[1].finishedAt)
      .slice(0, Math.max(0, table.size - this.config.auditRetentionRuns))
    for (const [runId] of excess) await table.delete(runId)
  }

  private async replaceState(patch: Partial<DreamRuntimeState>): Promise<void> {
    await this.commitState({ ...this.state, ...patch })
  }

  private async commitState(next: DreamRuntimeState): Promise<void> {
    await this.requireStateTable().put(STATE_KEY, structuredClone(next))
    this.state = next
  }

  private bindDomain(domain: Domain<typeof managerDomainSpec>): void {
    this.domain = domain
    this.stateTable = domain.table('state')
    this.runsTable = domain.table('runs')
  }

  private loadStateFromDomain(): void {
    const stored = this.requireStateTable().get(STATE_KEY)
    this.state = stored === undefined ? initialState() : structuredClone(stored)
  }

  private async refreshDomain(): Promise<void> {
    await this.closeDomain()
    this.bindDomain(await this.ctx.storageDomain.open(managerDomainSpec))
    this.loadStateFromDomain()
  }

  private async teardown(): Promise<void> {
    this.accepting = false
    this.clearScheduledTimer()
    try {
      const active = this.currentRun
      if (active !== undefined) {
        active.abort.abort(new Error('OhMyMemo manager is unloading'))
        await active.done
      }
      await this.operationTail
    } finally {
      await this.closeDomain()
    }
  }

  private async closeDomain(): Promise<void> {
    const current = this.domain
    this.domain = undefined
    this.stateTable = undefined
    this.runsTable = undefined
    await current?.close()
  }

  private async recoverInterruptedRun(): Promise<void> {
    if (this.state.status !== 'running') return
    const finishedAt = Date.now()
    const interrupted: DreamRunSummary = {
      runId: this.state.activeRunId ?? 'interrupted',
      trigger: this.state.activeTrigger ?? 'scheduled',
      startedAt: this.state.lastAttemptAt ?? finishedAt,
      finishedAt,
      status: 'error',
      sourceSessions: 0,
      sourceMessages: 0,
      memoriesCreated: 0,
      memoriesRejected: 0,
      items: [],
      truncated: false,
      expiredMemories: 0,
      expiredCandidates: 0,
      curatorRefreshed: 0,
      curatorMerged: 0,
      curatorRejected: 0,
      detail: 'previous process ended before the dream-memory run settled',
    }
    await this.replaceState({
      status: 'error',
      activeRunId: null,
      activeJobId: null,
      activeTrigger: null,
      lastResult: interrupted,
    })
  }

  private requireStateTable(): KvTable<string, DreamRuntimeState> {
    if (this.stateTable === undefined) throw new Error(`${name}: state table is not ready`)
    return this.stateTable
  }

  private requireRunsTable(): KvTable<string, DreamRunAudit> {
    if (this.runsTable === undefined) throw new Error(`${name}: runs table is not ready`)
    return this.runsTable
  }

  private get memo(): OhMyMemoService {
    const service = this.ctx.ohMyMemo
    if (service === undefined) throw new Error(`${name}: ohMyMemo service is unavailable`)
    return service
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private clearCurrentRun(runId: string): void {
    if (this.currentRun?.runId === runId) this.currentRun = undefined
  }

  private assertAccepting(): void {
    if (!this.accepting) throw new Error(`${name}: service is disposing`)
  }

  private logFailure(action: string, error: unknown): void {
    this.ctx.logger.warn(`${name}: ${action} failed: ${errorMessage(error)}`)
  }
}

function initialState(): DreamRuntimeState {
  return {
    version: 1,
    status: 'idle',
    activeRunId: null,
    activeJobId: null,
    activeTrigger: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastScheduledFor: null,
    nextRunAt: null,
    lastResult: null,
    failureStreak: null,
    cursors: {},
  }
}

function emptyProgress(): RunProgress {
  return {
    provider: null,
    model: null,
    agentSessionId: null,
    promptHash: null,
    sourceSessions: [],
    memoriesCreated: [],
    memoriesRejected: 0,
    items: [],
    cursors: {},
    truncated: false,
    expiredMemories: 0,
    expiredCandidates: 0,
    maintenanceError: null,
    curatorRefreshed: 0,
    curatorMerged: 0,
    curatorRejected: 0,
    curatorError: null,
  }
}

function auditFrom(request: RunRequest, progress: RunProgress, summary: DreamRunSummary): DreamRunAudit {
  return {
    version: 1,
    runId: request.runId,
    trigger: request.trigger,
    scheduledFor: request.scheduledFor,
    startedAt: request.startedAt,
    finishedAt: summary.finishedAt,
    status: summary.status,
    provider: progress.provider,
    model: progress.model,
    agentSessionId: progress.agentSessionId,
    promptHash: progress.promptHash,
    sourceSessions: progress.sourceSessions.map(item => ({ ...item })),
    memoriesCreated: [...progress.memoriesCreated],
    memoriesRejected: progress.memoriesRejected,
    truncated: progress.truncated,
    expiredMemories: progress.expiredMemories,
    expiredCandidates: progress.expiredCandidates,
    curatorRefreshed: progress.curatorRefreshed,
    curatorMerged: progress.curatorMerged,
    curatorRejected: progress.curatorRejected,
    detail: summary.detail,
  }
}

/**
 * End reason of the extraction turn, validating consumed work first.
 * `max-tokens` is recoverable (prefix salvage); every other non-completed
 * reason is a deterministic output failure for the caller to classify.
 */
function turnOutcome(events: readonly SessionEvent[]): string {
  const consumed = foldConsumedWork(events)
  if (consumed.droppedUnrun) throw new DreamOutputError('dream-memory Agent dropped queued input')
  return consumed.end?.data.reason.kind ?? 'missing'
}

function lastAssistantText(events: readonly SessionEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter((block): block is Extract<(typeof event.data.message.content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  throw new DreamOutputError('dream-memory Agent returned no text response')
}

function hashString(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function isMemoryPolicyRefusal(error: unknown): boolean {
  if (!(error instanceof StoreError)) return false
  return [
    'OHMYMEMO_BAD_REQUEST',
    'OHMYMEMO_CONTENT_TOO_LARGE',
    'OHMYMEMO_INVALID_KEY',
    'OHMYMEMO_INVALID_SCOPE',
    'OHMYMEMO_SECRET_REFUSED',
    'OHMYMEMO_SINGLE_KEY_CONFLICT',
    'OHMYMEMO_TOMBSTONE_BARRIER',
  ].includes(error.code)
}

/**
 * Config-driven route overrides for one dream run. The configured effort is
 * validated against the route's declared levels; an unknown id falls back to
 * the route default rather than sending an invalid request.
 */
function modelOverrides(config: StoreUserConfig, fallback: ModelSelection, efforts: readonly unknown[]): Partial<ModelSelection> {
  const patch: Partial<ModelSelection> = {}
  if (config.dream_model_provider !== '') patch.provider = config.dream_model_provider
  if (config.dream_model !== '') patch.model = config.dream_model
  if (config.dream_effort !== '') {
    const match = efforts.find(effort => String((effort as { id?: unknown }).id ?? effort) === config.dream_effort)
    if (match !== undefined) patch.reasoningEffort = (match as { id: ModelSelection['reasoningEffort'] }).id
  }
  return patch
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default OhMyMemoManager
