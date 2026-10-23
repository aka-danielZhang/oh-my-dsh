/**
 * The Quno Host service: one process-wide orchestrator that ties the durable
 * store, Sense lifecycle, routing, due queue, analysis runner, notification
 * outbox and delegated tasks together, and exposes the operations the preset
 * tools and the browser half call.
 *
 * @module dsh-quno/service
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_QUNO_CONFIG, mergeQunoConfig, parseQunoConfig } from './contracts.ts'
import { applyUserAction } from './attention.ts'
import { AgentAnalyzer } from './analyzer.ts'
import { buildQunoState } from './api.ts'
import { Router } from './routing.ts'
import { Runner } from './runner.ts'
import { Scheduler } from './scheduler.ts'
import { QunoSensesService } from './senses.ts'
import { Outbox, type HistoryReader, type MainConversationFace } from './outbox.ts'
import { TaskOrchestrator } from './tasks.ts'
import { registerQunoPresets } from './presets.ts'
import { QunoStore } from './store.ts'
import { recall, type RecallRequest, type RecallResult } from './recall.ts'
import type { AttentionAct } from './contracts.ts'
import type { QunoStatusSummary } from './host-face.ts'
import type { CheckNowResult, EnsureMainResult, QunoWireState } from './api-types.ts'
import type {
  AttentionItemRecord,
  AttentionStatus,
  QunoConfig,
  QunoRecord,
  TaskRecord,
} from './types.ts'

/** Structural face of the API session controller (create + cold resolve). */
interface SessionControllerFace {
  create(request: { readonly cwd?: string; readonly agentPreset?: string; readonly sessionId?: string }): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>
  resolveAgent(id: SessionId): Promise<{ readonly agent: Agent } | { readonly error: unknown }>
}

/** A classified Host-state failure the UI can show as-is. */
export class QunoStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'QunoStateError'
  }
}

/** Plugin-row configuration (schemastery normalizes it before `apply`). */
export interface QunoPluginConfig {
  readonly root?: string
  readonly name?: string
  readonly timeZone?: string
  readonly checkIntervalSec?: number
  readonly dryRun?: boolean
}

/** Quno's default data directory under the active DSH home. */
export function defaultQunoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] ?? joinHome()
  return `${home.replace(/\/+$/, '')}/quno`
}

function joinHome(): string {
  return `${homedir().replace(/\/+$/, '')}/.dsh`
}

/** One process-wide Quno orchestrator. */
export class QunoHost {
  /** Explicit Typert binding: the gateway resolves `ctx.quno` and dispatches strict descriptors through it. */
  readonly typertRemote = bindTypertRemote(this, 'quno')
  readonly qunoId = 'quno'
  readonly store: QunoStore
  readonly senses: QunoSensesService
  private readonly router: Router
  private readonly runner: Runner
  private readonly scheduler: Scheduler
  private readonly outbox: Outbox
  private readonly tasks: TaskOrchestrator
  private readonly history: HistoryReader
  private readonly main: MainConversationFace
  private readonly now: () => number
  private started = false
  private disposed = false
  private disposePresets: (() => Promise<void>) | undefined
  private maintenanceDispose: (() => void) | undefined
  private presetError: string | null = null

  constructor(
    private readonly ctx: Context,
    private readonly config: QunoPluginConfig,
    private readonly logger: { info(message: string): void; warn(message: string): void },
  ) {
    this.now = () => Date.now()
    this.store = new QunoStore({
      root: config.root === undefined || config.root === '' ? defaultQunoRoot() : config.root,
      logger: { warn: message => logger.warn(message) },
    })
    const readHistory = async (sessionId: string): Promise<{ readonly events: readonly { seq: number; type: string; data: unknown }[] }> => {
      const sessionQuery = this.ctx.get('sessionQuery')
      if (sessionQuery === undefined) throw new Error('sessionQuery is not mounted')
      const snapshot = await sessionQuery.readSession(sessionId as SessionId)
      return { events: snapshot.events }
    }
    this.history = { readSession: readHistory }

    this.main = {
      sessionId: () => this.mainSessionId(),
      state: () => this.store.getQuno(this.qunoId)?.mainSessionState ?? 'unbound',
      live: () => {
        const id = this.mainSessionId()
        return id === null ? undefined : this.ctx.agents.get(id as SessionId)
      },
      resolve: async () => await this.resolveMainAgent(),
      flush: async (agent: Agent) => await this.ctx.sessions.flush(agent.session),
      markState: state => {
        const quno = this.store.getQuno(this.qunoId)
        if (quno === undefined) return
        this.store.setMainSession(this.qunoId, quno.mainSessionId, state, this.now())
      },
    }
    this.outbox = new Outbox({
      store: this.store,
      qunoId: this.qunoId,
      main: this.main,
      history: this.history,
      logger,
      now: this.now,
      onChange: () => {},
    })
    this.router = new Router(this.store, this.qunoId, logger)
    const analyzer = new AgentAnalyzer({
      ctx,
      logger,
      readEvents: ids => this.store.getEvents(ids),
      listAttention: () => this.store.listAttention(this.qunoId, undefined, 100),
      readSourceEvents: (sourceId, subjectKey, limit) => subjectKey === null
        ? this.store.listEventsAfter(-1, limit * 20).filter(event => event.sourceId === sourceId).slice(0, limit)
        : this.store.listEventsBySubject(sourceId, subjectKey, limit),
      listSources: () => this.store.listSources(this.qunoId).map(source => ({ id: source.id, type: source.type })),
    })
    this.runner = new Runner({ store: this.store, qunoId: this.qunoId, analyzer, logger })
    this.scheduler = new Scheduler({
      store: this.store,
      qunoId: this.qunoId,
      router: this.router,
      runner: this.runner,
      timer: {
        setTimeout: (callback, delayMs) => {
          const timer = ctx.get('timer')
          if (timer !== undefined) return timer.timeout(callback, delayMs)
          const handle = setTimeout(callback, delayMs)
          if (typeof handle === 'object' && 'unref' in handle) handle.unref()
          return () => { clearTimeout(handle) }
        },
      },
      logger,
      now: this.now,
      onTick: (result) => {
        if (result.kind === 'ran') void this.outbox.kick()
      },
    })
    this.tasks = new TaskOrchestrator({
      store: this.store,
      qunoId: this.qunoId,
      subagents: ctx.get('subagents') as never,
      jobs: ctx.get('jobs') as never,
      history: this.history,
      logger,
      defaultCwd: homedir(),
      now: this.now,
      onChange: () => {},
      onNotice: () => { void this.outbox.kick() },
    })
    this.senses = new QunoSensesService({
      store: this.store,
      qunoId: this.qunoId,
      logger,
      onIngest: () => {
        try {
          this.router.route(this.now())
        } catch (error) {
          logger.warn(`dsh-quno: routing after ingest failed: ${(error as Error).message}`)
        }
        void this.scheduler.checkNow('event')
      },
      setTimer: (callback, delayMs) => {
        const timer = ctx.get('timer')
        if (timer !== undefined) return timer.timeout(callback, delayMs)
        const handle = setTimeout(callback, delayMs)
        if (typeof handle === 'object' && 'unref' in handle) handle.unref()
        return () => { clearTimeout(handle) }
      },
      now: this.now,
    })
  }

  /** Open the store, recover persisted state, register presets and arm the queue. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const now = this.now()
    this.store.open(now)
    const quno = this.provision(now)
    void this.verifyMainSession()
    this.store.ensureSubscriptions(this.qunoId, this.store.listSources(this.qunoId), now)

    try {
      this.disposePresets = await registerQunoPresets(this.ctx)
    } catch (error) {
      this.presetError = (error as Error).message
      this.logger.warn(`dsh-quno: preset registration failed: ${this.presetError}`)
    }

    try {
      this.store.expireStaleRuns(now)
      this.router.route(now)
    } catch (error) {
      this.logger.warn(`dsh-quno: recovery failed: ${(error as Error).message}`)
    }
    this.senses.startAll()
    try {
      await this.tasks.reconcile()
    } catch (error) {
      this.logger.warn(`dsh-quno: task reconciliation failed: ${(error as Error).message}`)
    }
    try {
      await this.outbox.reconcile()
    } catch (error) {
      this.logger.warn(`dsh-quno: outbox reconciliation failed: ${(error as Error).message}`)
    }
    this.scheduler.start()
    void this.outbox.kick()
    this.armMaintenance()
    this.logger.info(
      `dsh-quno: started (main=${quno.mainSessionId ?? 'unbound'}, senses=${String(this.store.listSenseInstances(this.qunoId).length)})`,
    )
  }

  /** Stop timers and generations, then close the store. */
  async stop(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.maintenanceDispose?.()
    this.scheduler.stop()
    this.tasks.stop()
    await this.senses.stopAll().catch(() => {})
    await this.disposePresets?.().catch(() => {})
    this.store.close()
  }

  private provision(now: number): QunoRecord {
    const base = this.store.getQuno(this.qunoId, { required: false })
    if (base !== undefined) {
      const patched = this.configPatch(base.config)
      if (patched !== null) {
        return this.store.updateQunoConfig(this.qunoId, patched, now)
      }
      return base
    }
    const config = parseQunoConfig(this.configPatch(DEFAULT_QUNO_CONFIG) ?? DEFAULT_QUNO_CONFIG)
    return this.store.ensureQuno({
      id: this.qunoId,
      name: this.config.name ?? 'Quno',
      persona: '你是 Quno，用户的个人助理。',
      instructions: '关注用户在意的事，只在有真实变化时打扰；不臆造事实。',
      config: config.ok ? config.value : DEFAULT_QUNO_CONFIG,
      now,
    })
  }

  /** Apply plugin-row defaults over the persisted config (row config wins only on provision). */
  private configPatch(current: QunoConfig): QunoConfig | null {
    const patch: Record<string, unknown> = {}
    if (this.config.timeZone !== undefined) patch['timeZone'] = this.config.timeZone
    if (this.config.checkIntervalSec !== undefined) patch['checkIntervalSec'] = this.config.checkIntervalSec
    if (this.config.dryRun !== undefined) patch['dryRun'] = this.config.dryRun
    if (Object.keys(patch).length === 0) return null
    const merged = mergeQunoConfig(current, patch)
    return merged.ok ? merged.value : null
  }

  private armMaintenance(): void {
    const timer = this.ctx.get('timer')
    const run = (): void => {
      const now = this.now()
      const quno = this.store.getQuno(this.qunoId, { required: false })
      if (quno === undefined) return
      try {
        const events = this.store.pruneExpiredEvents(now, quno.config.retention.eventBodyDays)
        const runs = this.store.pruneRuns(now, quno.config.retention.runDiagnosticsDays)
        if (events + runs > 0) {
          this.logger.info(`dsh-quno: retention pruned ${String(events)} event bodies and ${String(runs)} run records`)
        }
      } catch (error) {
        this.logger.warn(`dsh-quno: retention failed: ${(error as Error).message}`)
      }
    }
    if (timer !== undefined) {
      this.maintenanceDispose = timer.interval(run, 6 * 60 * 60 * 1000)
    } else {
      const handle = setInterval(run, 6 * 60 * 60 * 1000)
      if (typeof handle === 'object' && 'unref' in handle) handle.unref()
      this.maintenanceDispose = () => { clearInterval(handle) }
    }
  }

  // ------------------------------------------------------------ conversation

  /** Durable binding, as the UI and tools see it. */
  mainSessionId(): string | null {
    return this.store.getQuno(this.qunoId, { required: false })?.mainSessionId ?? null
  }

  /** The exact live main-conversation Agent, if resident. */
  mainAgent(): Agent | undefined {
    const id = this.mainSessionId()
    return id === null ? undefined : this.ctx.agents.get(id as SessionId)
  }

  /** Cold-resume the main conversation; undefined when unavailable. */
  async resolveMainAgent(): Promise<Agent | undefined> {
    const id = this.mainSessionId()
    if (id === null) return undefined
    const live = this.ctx.agents.get(id as SessionId)
    if (live !== undefined) return live
    const controller = this.ctx.get('sessionController') as unknown as SessionControllerFace | undefined
    if (controller === undefined) return undefined
    const result = await controller.resolveAgent(id as SessionId)
    return 'agent' in result ? result.agent : undefined
  }

  /**
   * Create or adopt the permanent conversation. A missing bound session is a
   * loud error, never a silent replacement.
   */
  async ensureMain(cwd: string): Promise<EnsureMainResult> {
    const quno = this.requireQuno()
    if (quno.mainSessionId !== null) {
      const exists = await this.sessionExists(quno.mainSessionId)
      if (!exists) {
        this.store.setMainSession(this.qunoId, quno.mainSessionId, 'missing', this.now())
        throw new QunoStateError('main-session-missing', '主对话会话已丢失；请先在设置里重新绑定或新建，Quno 不会悄悄换一个。')
      }
      if (quno.mainSessionState !== 'ok') {
        this.store.setMainSession(this.qunoId, quno.mainSessionId, 'ok', this.now())
      }
      return { sessionId: quno.mainSessionId, state: 'ok', created: false }
    }
    const controller = this.ctx.get('sessionController') as unknown as SessionControllerFace | undefined
    if (controller === undefined) {
      throw new QunoStateError('no-session-controller', '当前组合没有会话控制器，无法创建主对话')
    }
    const directory = resolveDirectory(cwd)
    const created = await controller.create({ cwd: directory, agentPreset: 'quno' })
    const sessionId = String(created.sessionId)
    this.store.setMainSession(this.qunoId, sessionId, 'ok', this.now())
    this.store.ensureSubscriptions(this.qunoId, this.store.listSources(this.qunoId), this.now())
    return { sessionId, state: 'ok', created: true }
  }

  private async verifyMainSession(): Promise<void> {
    const quno = this.store.getQuno(this.qunoId, { required: false })
    if (quno === undefined || quno.mainSessionId === null) return
    const exists = await this.sessionExists(quno.mainSessionId)
    if (!exists) {
      this.store.setMainSession(this.qunoId, quno.mainSessionId, 'missing', this.now())
      this.logger.warn(`dsh-quno: bound main session "${quno.mainSessionId}" is missing`)
    } else if (quno.mainSessionState !== 'ok') {
      this.store.setMainSession(this.qunoId, quno.mainSessionId, 'ok', this.now())
    }
  }

  private async sessionExists(sessionId: string): Promise<boolean> {
    try {
      return await this.ctx.sessionPersistence.stat(sessionId as SessionId) !== undefined
    } catch {
      return false
    }
  }

  /** Forward one durable session event to the delivery reconciler. */
  observeSession(sessionId: string, event: { readonly seq: number; readonly type: string; readonly data: unknown }): void {
    this.outbox.observe(sessionId, event)
  }

  // ------------------------------------------------------------ model tools

  /** Start a delegated read-only task (the model-facing tool path). */
  async startTask(input: { readonly title: string; readonly prompt: string; readonly cwd?: string }, parent: Agent): Promise<TaskRecord> {
    const quno = this.requireQuno()
    if (quno.mainSessionId === null) {
      throw new QunoStateError('main-unbound', '主对话尚未绑定，无法委派任务')
    }
    return await this.tasks.start({ ...input, parent })
  }

  /** Search the permanent conversation and its background sessions. */
  async recall(request: RecallRequest): Promise<RecallResult> {
    return await recall({
      ctx: this.ctx,
      store: this.store,
      qunoId: this.qunoId,
      mainSessionId: () => this.mainSessionId(),
      logger: this.logger,
    }, request)
  }

  /** Attention items, optionally filtered. */
  listAttention(statuses?: readonly string[]): readonly AttentionItemRecord[] {
    const allowed: AttentionStatus[] = ['open', 'waiting', 'snoozed', 'resolved', 'dismissed', 'expired']
    const filter = statuses?.filter((status): status is AttentionStatus => (allowed as string[]).includes(status))
    return this.store.listAttention(this.qunoId, filter === undefined || filter.length === 0 ? undefined : filter, 200)
  }

  /** Apply an explicit user decision. */
  async actAttention(act: AttentionAct, channel: 'button' | 'natural'): Promise<AttentionItemRecord> {
    const result = applyUserAction(this.store, this.qunoId, act, channel, this.now())
    return result.item
  }

  /** Short-term "don't bother me" state (never long-term memory). */
  async mute(input: { readonly minutes?: number; readonly until?: string; readonly cancel?: boolean }): Promise<{ readonly mutedUntil: number | null }> {
    if (input.cancel === true) {
      this.store.setMutedUntil(this.qunoId, null, this.now())
      return { mutedUntil: null }
    }
    let until: number
    if (input.until !== undefined) {
      const parsed = Date.parse(input.until)
      if (!Number.isFinite(parsed)) throw new QunoStateError('invalid-time', '静默截止时间不是合法时间')
      until = parsed
    } else if (input.minutes !== undefined) {
      until = this.now() + Math.min(10_080, Math.max(1, input.minutes)) * 60_000
    } else {
      until = this.now() + 24 * 60 * 60_000
    }
    if (until <= this.now()) {
      this.store.setMutedUntil(this.qunoId, null, this.now())
      return { mutedUntil: null }
    }
    this.store.setMutedUntil(this.qunoId, until, this.now())
    return { mutedUntil: until }
  }

  /** Compact status for the model's self-description. */
  statusSummary(): QunoStatusSummary {
    const quno = this.requireQuno()
    const attention = this.store.listAttention(this.qunoId, ['open', 'waiting', 'snoozed'], 500)
    const deliveries = this.store.countDeliveries(this.qunoId)
    const tasks = this.store.listTasks(this.qunoId, undefined, 200)
    const notices = this.store.listNotices(this.qunoId, 200)
    const senses = this.senses.healthSnapshot().types.flatMap(view => view.instances.map(instance => ({
      label: instance.label,
      type: instance.type,
      health: instance.health,
      stale: (instance as { stale?: boolean }).stale === true,
    })))
    return {
      enabled: quno.config.enabled,
      mainSession: quno.mainSessionId === null ? '未绑定' : quno.mainSessionState === 'ok' ? '已绑定' : quno.mainSessionState,
      mutedUntil: quno.mutedUntil,
      nextCheckAt: quno.nextCheckAt,
      attention: {
        open: attention.filter(item => item.status === 'open').length,
        waiting: attention.filter(item => item.status === 'waiting').length,
        snoozed: attention.filter(item => item.status === 'snoozed').length,
      },
      deliveries: {
        pending: deliveries['pending'] ?? 0,
        deferred: deliveries['deferred'] ?? 0,
        deadLetter: deliveries['dead-letter'] ?? 0,
      },
      tasks: {
        running: tasks.filter(task => task.status === 'running').length,
        interrupted: tasks.filter(task => task.status === 'interrupted').length,
      },
      senses,
      notices: {
        pending: notices.filter(notice => notice.status === 'pending').length,
        inboxDurable: notices.filter(notice => notice.status === 'inbox-durable').length,
        blocked: notices.filter(notice => notice.status === 'delivery-blocked').length,
      },
    }
  }

  // ---------------------------------------------------------- Remote methods

  /** Full bounded settings snapshot (called by the gateway). */
  async state(): Promise<QunoWireState> {
    return buildQunoState(this)
  }

  /** Bind or create the main conversation from the browser. */
  async ensureMainForClient(request: { readonly cwd: string }): Promise<EnsureMainResult> {
    return await this.ensureMain(request.cwd)
  }

  /** Merge a validated config patch. */
  async updateConfig(request: { readonly patch: Record<string, unknown> }): Promise<QunoWireState> {
    const quno = this.requireQuno()
    const merged = mergeQunoConfig(quno.config, request.patch)
    if (!merged.ok) throw new QunoStateError(merged.error.code, merged.error.message)
    this.store.updateQunoConfig(this.qunoId, merged.value, this.now())
    return await this.state()
  }

  /** Update identity/model fields. */
  async updateProfile(request: {
    readonly name?: string
    readonly persona?: string
    readonly instructions?: string
    readonly modelProvider?: string
    readonly model?: string
    readonly reasoningEffort?: string | null
  }): Promise<QunoWireState> {
    this.store.updateQunoProfile(this.qunoId, request, this.now())
    return await this.state()
  }

  /** Button path for the report actions. */
  async actAttentionForClient(request: {
    readonly itemId: string
    readonly action: 'processed' | 'later' | 'dismiss' | 'resume' | 'clarify'
    readonly expectedRevision?: number
    readonly snoozeMinutes?: number
    readonly note?: string
  }): Promise<QunoWireState> {
    await this.actAttention({
      itemId: request.itemId,
      action: request.action,
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      ...(request.snoozeMinutes === undefined ? {} : { snoozeMinutes: request.snoozeMinutes }),
      ...(request.note === undefined ? {} : { note: request.note }),
    }, 'button')
    return await this.state()
  }

  /** Manual "check now". */
  async checkNow(): Promise<CheckNowResult> {
    const result = await this.scheduler.checkNow('user')
    return { kind: result.kind, at: result.at }
  }

  /** Create a Sense instance. */
  async createSense(request: {
    readonly type: string
    readonly label?: string
    readonly config?: Record<string, unknown>
    readonly desiredState?: 'enabled' | 'paused' | 'disabled'
  }): Promise<QunoWireState> {
    const result = this.senses.createInstance({
      type: request.type,
      ...(request.label === undefined ? {} : { label: request.label }),
      config: request.config ?? {},
      ...(request.desiredState === undefined ? {} : { desiredState: request.desiredState }),
    })
    if (!result.ok) throw new QunoStateError(result.error.code, result.error.message)
    return await this.state()
  }

  /** Pause/resume/disable/remove/reconfigure one Sense instance. */
  async senseCommand(request: {
    readonly instanceId: string
    readonly action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
    readonly label?: string
    readonly config?: Record<string, unknown>
  }): Promise<QunoWireState> {
    switch (request.action) {
      case 'pause': await this.senses.pause(request.instanceId); break
      case 'resume': await this.senses.resume(request.instanceId); break
      case 'disable': await this.senses.disable(request.instanceId); break
      case 'remove': await this.senses.remove(request.instanceId); break
      case 'reconfigure': {
        const result = await this.senses.reconfigureInstance(request.instanceId, {
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.config === undefined ? {} : { config: request.config }),
        })
        if (!result.ok) throw new QunoStateError(result.error?.code ?? 'invalid', result.error?.message ?? '配置无效')
        break
      }
    }
    return await this.state()
  }

  /** Resume or abandon an interrupted task. */
  async taskCommand(request: { readonly taskId: string; readonly action: 'resume' | 'abandon' }): Promise<QunoWireState> {
    if (request.action === 'abandon') {
      this.tasks.abandon(request.taskId)
    } else {
      const agent = await this.resolveMainAgent()
      if (agent === undefined) throw new QunoStateError('main-offline', '主对话当前无法唤醒，稍后再试')
      await this.tasks.resume(request.taskId, agent)
    }
    return await this.state()
  }

  /** Short-term mute from the UI. */
  async muteForClient(request: { readonly minutes?: number; readonly until?: string; readonly cancel?: boolean }): Promise<QunoWireState> {
    await this.mute(request)
    return await this.state()
  }

  /** Diagnostics for tests and support: preset registration failure, if any. */
  get presetFailure(): string | null {
    return this.presetError
  }

  private requireQuno(): QunoRecord {
    const quno = this.store.getQuno(this.qunoId)
    if (quno === undefined) throw new QunoStateError('not-provisioned', 'Quno 状态尚未初始化')
    return quno
  }
}

function resolveDirectory(cwd: string): string {
  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  } catch {
    // fall through
  }
  return homedir()
}
