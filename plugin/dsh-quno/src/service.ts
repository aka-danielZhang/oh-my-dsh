/**
 * The Quno Host service: the process-wide composition root.
 *
 * It owns exactly one SQLite store, one domain Engine, one Effect outbox, one
 * pass loop, one executor and one notification outbox, wires the Collector layer's
 * ingress into `Engine.receive` (same transaction), registers the agent presets
 * and exposes the narrow ops the preset tools and the browser half call.
 *
 * @module dsh-quno/service
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { bindTypertRemote } from '@deepseek-ai/dsh-typert-protocol'
import { DEFAULT_QUNO_CONFIG, mergeQunoConfig, parseQunoConfig } from './contracts.ts'
import { applyUserAction } from './attention.ts'
import {
  buildEventDetail,
  buildEvalDetail,
  buildExchangeDetail,
  buildNoticeDetail,
  buildQunoState,
  buildRecentEvents,
  buildThreadDetail,
  buildTicketDetail,
  buildTriggerDetail,
} from './api.ts'
import { QunoStore } from './store.ts'
import { SqliteRepository } from './app/store.ts'
import { Engine } from './core/engine.ts'
import type { EnginePolicyState } from './core/engine.ts'
import { buildPolicy } from './core/policy.ts'
import type { PolicyRule } from './core/policy.ts'
import { QunoStateError as QunoDomainError, collectorEndpoint, collectorInstanceOf, routerEndpoint } from './core/model.ts'
import type { EffectKind, EffectRecord, ExchangeKind, ThreadRef, TriggerDraft } from './core/model.ts'
import type { CollectorEndpointView, CollectorDefinition, CollectorInstanceRecord } from './types.ts'
import { SessionTransport } from './app/transport.ts'
import { EffectRetryError, EffectsRuntime } from './app/effects.ts'
import type { EffectHandler } from './app/effects.ts'
import { Executor } from './app/executor.ts'
import { Assessor } from './app/assessor.ts'
import { Watchdog } from './app/watchdog.ts'
import { computeMetrics } from './app/metrics.ts'
import type { EngineMetrics } from './app/metrics.ts'
import { latestHumanMessageId, currentEvalId } from './app/turn-kind.ts'
import { Scheduler } from './scheduler.ts'
import { QunoCollectorsService } from './collectors.ts'
import { Outbox, type HistoryReader, type MainConversationFace } from './outbox.ts'
import { registerQunoPresets } from './presets.ts'
import { recall, type RecallRequest, type RecallResult } from './recall.ts'
import type { AttentionAct } from './contracts.ts'
import type {
  EvalCandidateView,
  EvalDecideView,
  QunoServiceFace,
  QunoStatusSummary,
  RouteItem,
  RouteOutcome,
  TicketView,
} from './host-face.ts'
import type {
  CheckNowResult,
  EnsureMainResult,
  EventDetailWire,
  EventWire,
  EvalDetailWire,
  ExchangeDetailWire,
  NoticeDetailWire,
  QunoWireState,
  CollectorOptionsPageWire,
  CollectorProbeWire,
  ThreadDetailWire,
  TicketDetailWire,
  TriggerDetailWire,
} from './api-types.ts'
import type {
  AttentionItemRecord,
  AttentionStatus,
  EventEnvelope,
  NoticePayload,
  QunoConfig,
  QunoRecord,
} from './types.ts'
import { sha256, stableStringify, toMillis } from './util.ts'

/** Structural face of the API session controller (create + cold resolve). */
interface SessionControllerFace {
  create(request: { readonly cwd?: string; readonly workspaceId?: string; readonly agentPreset?: string; readonly sessionId?: string }): Promise<{ readonly sessionId: string; readonly agentPreset?: string }>
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

/** Constructor-only options; production callers use the defaults. */
export interface QunoHostOptions {
  /** Injectable clock (eval harness virtual time); default wall clock. */
  readonly now?: () => number
}

/**
 * The query gate (plan note 2026-11-08 F3): an endpoint is answerable only
 * when its instance is mounted AND its type declares the handler this kind
 * needs. Since the query face is request-only, a `command` exchange has no
 * answerer anywhere — the gate refuses it at the tool layer, so the
 * misleading "accepted, then capability-unavailable" path cannot happen.
 */
export function queryAdvertises(
  query: CollectorDefinition['query'] | undefined,
  kind: 'request' | 'command',
): boolean {
  return kind === 'request' && query?.handleRequest !== undefined
}

/**
 * Project mounted instances into the discovery view. Only query-facing
 * instances (a declared `handleRequest`) are listed — an endpoint on this
 * list is one the gate will let through, so the model can act on it without
 * guessing.
 */
export function collectorEndpointsOf(
  instances: readonly CollectorInstanceRecord[],
  queryFor: (instanceId: string) => CollectorDefinition['query'] | undefined,
): readonly CollectorEndpointView[] {
  const endpoints: CollectorEndpointView[] = []
  for (const instance of instances) {
    const query = queryFor(instance.id)
    if (query?.handleRequest === undefined) continue
    endpoints.push({
      endpoint: collectorEndpoint(instance.id),
      label: instance.label,
      type: instance.type,
      capabilities: {
        request: query.handleRequest !== undefined,
      },
      health: instance.health,
    })
  }
  return endpoints
}

/** Quno's default data directory under the active DSH home. */
export function defaultQunoRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['DSH_HOME'] ?? joinHome()
  return `${home.replace(/\/+$/, '')}/quno`
}

function joinHome(): string {
  return `${homedir().replace(/\/+$/, '')}/.dsh`
}

/** One process-wide Quno composition. */
export class QunoHost implements QunoServiceFace {
  /** Explicit Typert binding: the gateway resolves `ctx.quno` and dispatches strict descriptors through it. */
  readonly typertRemote = bindTypertRemote(this, 'quno')
  readonly qunoId = 'quno'
  readonly store: QunoStore
  readonly repo: SqliteRepository
  readonly engine: Engine
  readonly transport: SessionTransport
  readonly assessor: Assessor
  readonly executor: Executor
  readonly effects: EffectsRuntime
  readonly watchdog: Watchdog
  readonly collectors: QunoCollectorsService
  private readonly scheduler: Scheduler
  private readonly outbox: Outbox
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
    options: QunoHostOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.store = new QunoStore({
      root: config.root === undefined || config.root === '' ? defaultQunoRoot() : config.root,
      logger: { warn: message => logger.warn(message) },
    })
    this.repo = new SqliteRepository(this.store)
    this.engine = new Engine({
      repo: this.repo,
      qunoId: this.qunoId,
      policy: () => this.policyState(),
      policySnapshot: (state) => buildPolicy({
        version: `v${String(state.configRevision)}`,
        paused: state.paused,
        acceptMode: state.acceptMode,
        evalTimeoutMs: state.evalTimeoutMs,
        rules: state.rules,
      }),
      nextId: prefix => `${prefix}_${String(this.now())}_${Math.random().toString(36).slice(2, 8)}`,
      defaultCwd: homedir(),
      logger,
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
    this.transport = new SessionTransport({ ctx, logger })
    this.assessor = new Assessor({
      engine: this.engine,
      repo: this.repo,
      transport: this.transport,
      resolveRouter: () => this.resolveMainAgent(),
      logger,
      now: this.now,
    })
    this.executor = new Executor({
      ctx,
      engine: this.engine,
      repo: this.repo,
      qunoId: this.qunoId,
      logger,
      now: this.now,
      transport: this.transport,
      resolveRouter: () => this.resolveMainAgent(),
      modelSelection: () => this.executorModel(),
      maxTokens: () => this.store.getQuno(this.qunoId, { required: false })?.config.budget.maxOutputTokens ?? 8192,
      defaultCwd: homedir(),
      maxWorkers: 4,
      resolveExchangeResponder: (endpoint, kind) => this.queryAdvertises(endpoint, kind),
      listCollectors: () => this.collectorEndpoints(),
      onChange: () => {},
    })
    this.effects = new EffectsRuntime({
      repo: this.repo,
      handlers: this.effectHandlers(),
      logger,
      now: this.now,
    })
    this.watchdog = new Watchdog({
      repo: this.repo,
      qunoId: this.qunoId,
      config: () => this.requireQuno().config,
      now: this.now,
    })
    this.scheduler = new Scheduler({
      store: this.store,
      qunoId: this.qunoId,
      engine: this.engine,
      effects: this.effects,
      executor: this.executor,
      outbox: this.outbox,
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
      onTick: () => {
        void this.outbox.kick()
      },
    })
    this.collectors = new QunoCollectorsService({
      store: this.store,
      qunoId: this.qunoId,
      logger,
      triggerSink: { receive: input => this.receiveTrigger(input) },
      onIngest: () => this.scheduler.scheduleAutoAnalysis(),
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

  /** Open the store, recover persisted state, register presets and arm the loop. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const now = this.now()
    this.store.open(now)
    const quno = this.provision(now)
    void this.verifyMainSession()

    try {
      this.disposePresets = await registerQunoPresets(this.ctx)
    } catch (error) {
      this.presetError = (error as Error).message
      this.logger.warn(`dsh-quno: preset registration failed: ${this.presetError}`)
    }

    try {
      await this.executor.reconcile(now)
      await this.effects.kick()
    } catch (error) {
      this.logger.warn(`dsh-quno: domain recovery failed: ${(error as Error).message}`)
    }
    this.collectors.startAll()
    try {
      await this.outbox.reconcile()
    } catch (error) {
      this.logger.warn(`dsh-quno: outbox reconciliation failed: ${(error as Error).message}`)
    }
    this.scheduler.start()
    void this.outbox.kick()
    this.armMaintenance()
    this.logger.info(
      `dsh-quno: started (main=${quno.mainSessionId ?? 'unbound'}, collectors=${String(this.store.listCollectorInstances(this.qunoId).length)})`,
    )
  }

  /** Stop timers and generations, then close the store. */
  async stop(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.maintenanceDispose?.()
    this.scheduler.stop()
    this.effects.stop()
    this.executor.stop()
    await this.collectors.stopAll().catch(() => {})
    await this.disposePresets?.().catch(() => {})
    this.store.close()
  }

  private provision(now: number): QunoRecord {
    const base = this.store.getQuno(this.qunoId, { required: false })
    if (base !== undefined) {
      const patched = this.configPatch(base.config)
      if (patched !== null) return this.store.updateQunoConfig(this.qunoId, patched, now)
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
  async ensureMain(cwd: string, workspaceId?: string): Promise<EnsureMainResult> {
    const quno = this.requireQuno()
    if (quno.mainSessionId !== null) {
      const exists = await this.sessionExists(quno.mainSessionId)
      if (!exists) {
        this.store.setMainSession(this.qunoId, quno.mainSessionId, 'missing', this.now())
        throw new QunoStateError('main-session-missing', '主对话会话已丢失；请先恢复原会话，Quno 不会悄悄换一个。')
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
    const registry = this.ctx.get('workspaceRegistry') as {
      list?: () => readonly { readonly id: string }[]
    } | undefined
    let target = workspaceId
    if ((target === undefined || target === '') && registry?.list !== undefined) {
      try { target = registry.list()[0]?.id } catch { /* optional service */ }
    }
    const created = target !== undefined && target !== ''
      ? await controller.create({ workspaceId: target, agentPreset: 'quno' })
        .catch(async () => await controller.create({ cwd: directory, agentPreset: 'quno' }))
      : await controller.create({ cwd: directory, agentPreset: 'quno' })
    const sessionId = String(created.sessionId)
    this.store.setMainSession(this.qunoId, sessionId, 'ok', this.now())
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

  /** Forward one durable session event to the delivery reconciler and executor. */
  observeSession(sessionId: string, event: { readonly seq: number; readonly type: string; readonly data: unknown }): void {
    this.outbox.observe(sessionId, event)
    this.executor.observe(sessionId, event)
  }

  // -------------------------------------------------------------- domain sink

  /**
   * The Collector ingress sink. Runs INSIDE the batch transaction (T1): the
   * Trigger, its Threads, the fan-out inputs and the pending Eval slot commit
   * together with the event row and the checkpoint.
   */
  private receiveTrigger(input: {
    readonly envelope: EventEnvelope
    readonly eventId: string
    readonly sourceId: string
    readonly receivedAt: number
    readonly configRevision: number
    readonly contentHash: string
  }): { readonly triggerId: string } {
    const envelope = input.envelope
    const threads = this.threadsFor(envelope, input.sourceId)
    const provenance = envelope.provenance ?? { kind: 'observed' as const }
    const draft: TriggerDraft = {
      id: input.eventId,
      qunoId: this.qunoId,
      sourceId: input.sourceId,
      eventKey: envelope.eventKey,
      type: envelope.type,
      schema: envelope.schema ?? 'quno.event/v1',
      threads,
      actor: envelope.actor ?? { source: input.sourceId, id: '' },
      human: envelope.human === true,
      addressed: envelope.addressed ?? null,
      occurredAt: toMillis(envelope.occurredAt),
      observedAt: toMillis(envelope.observedAt) ?? input.receivedAt,
      receivedAt: input.receivedAt,
      summary: envelope.summary ?? null,
      data: envelope.data ?? null,
      contentRef: envelope.contentRef ?? null,
      channel: envelope.channel ?? null,
      operation: envelope.operation ?? 'upsert',
      priority: envelope.priority ?? 'p2',
      deadline: toMillis(envelope.deadline),
      correlationKeys: envelope.correlationKeys ?? [],
      supersedesTriggerIds: envelope.supersedesEventIds ?? [],
      parentTriggerIds: envelope.parentEventIds ?? [],
      provenance: provenance as never,
      contentHash: input.contentHash,
      configRevision: input.configRevision,
      expiresAt: toMillis(envelope.expiresAt),
    }
    const outcome = this.engine.receive(draft, input.receivedAt)
    return { triggerId: outcome.triggerId }
  }

  /** Resolve the Threads of one envelope without guessing identities. */
  private threadsFor(envelope: EventEnvelope, sourceId: string): readonly ThreadRef[] {
    if (envelope.subject !== undefined && envelope.subject.key !== '') {
      return [{ source: sourceId, id: envelope.subject.key }]
    }
    return [{ source: sourceId, id: `object:${envelope.eventKey}` }]
  }

  private policyState(): EnginePolicyState {
    const quno = this.store.getQuno(this.qunoId, { required: false })
    const config = quno?.config ?? DEFAULT_QUNO_CONFIG
    const rules: PolicyRule[] = (config.autoSourceIds ?? []).map(sourceId => ({ id: `source:${sourceId}`, sourceId }))
    return {
      configRevision: quno?.configRevision ?? 1,
      paused: !config.enabled,
      acceptMode: config.acceptMode ?? 'observe',
      evalTimeoutMs: Math.max(30, config.budget.runTimeoutSec) * 1000,
      rules,
    }
  }

  private pausedNow(): boolean {
    const quno = this.store.getQuno(this.qunoId, { required: false })
    return quno !== undefined && !quno.config.enabled
  }

  private queryAdvertises(endpoint: string, kind: 'request' | 'command'): boolean {
    const instanceId = collectorInstanceOf(endpoint)
    if (instanceId === null) return false
    return queryAdvertises(this.collectors.queryCapabilitiesForInstance(instanceId), kind)
  }

  /**
   * The exchange-facing instances, as the discovery surface advertises them.
   * Membership is the truth the gate enforces: everything listed here passes
   * `queryAdvertises`, so the model can act on this list without guessing.
   */
  collectorEndpoints(): readonly CollectorEndpointView[] {
    return collectorEndpointsOf(
      this.store.listCollectorInstances(this.qunoId),
      instanceId => this.collectors.queryCapabilitiesForInstance(instanceId),
    )
  }

  /** One-line collector directory for refusal messages; empty says so explicitly. */
  private queryDirectoryText(): string {
    const collectors = this.collectorEndpoints()
    if (collectors.length === 0) return '当前没有任何可应答的采集器。'
    return `当前可用：${collectors.map(collector => `${collector.endpoint}（${collector.label}）`).join('、')}。`
  }

  // ------------------------------------------------------------- effect plan

  private effectHandlers(): Partial<Record<EffectKind, EffectHandler>> {
    return {
      'eval-delivery': async (effect, signal) => {
        if (this.pausedNow()) throw new EffectRetryError('quno is paused', 30_000)
        const payload = effect.payload as { readonly evalId?: string; readonly threadId?: string }
        if (payload.evalId !== undefined) {
          const evalRecord = this.repo.getEval(payload.evalId)
          if (evalRecord === undefined) return
          if (evalRecord.status !== 'delivering' && evalRecord.status !== 'waiting-decision') return
          await this.assessor.deliverEval(evalRecord.id, signal)
          return
        }
        if (payload.threadId === undefined) return
        const opened = this.engine.openEval(payload.threadId, this.now())
        if (opened !== null && opened.status === 'delivering') {
          await this.assessor.deliverEval(opened.id, signal)
        }
      },
      'assignment-launch': async (effect, signal) => {
        const payload = effect.payload as { readonly assignmentId?: string }
        if (payload.assignmentId === undefined) return
        await this.executor.launch(payload.assignmentId, signal)
      },
      'input-delivery': async (effect, signal) => {
        const payload = effect.payload as { readonly ticketId?: string }
        if (payload.ticketId === undefined) return
        await this.executor.deliverInputs(payload.ticketId, signal)
      },
      'router-relay': async (effect, signal) => {
        if (this.pausedNow()) throw new EffectRetryError('quno is paused', 30_000)
        const payload = effect.payload as {
          readonly ticketId?: string
          readonly assignmentId?: string
          readonly exchangeId?: string
        }
        if (payload.exchangeId !== undefined) {
          await this.assessor.relayExchange(payload.exchangeId, signal)
          return
        }
        if (payload.ticketId === undefined) return
        await this.assessor.relayReport(payload.ticketId, payload.assignmentId ?? null, signal)
      },
      'notice': async () => {
        await this.outbox.kick()
      },
      'exchange-delivery': async (effect, signal) => {
        await this.deliverExchange(effect, signal)
      },
      'channel-reply': async () => {
        // External writes are deliberately disabled in this version.
      },
    }
  }

  /** Dispatch one durable Exchange to its responding collector query face. */
  private async deliverExchange(effect: EffectRecord, signal: AbortSignal): Promise<void> {
    const payload = effect.payload as { readonly exchangeId?: string; readonly responder?: string }
    if (payload.exchangeId === undefined || payload.responder === undefined) return
    const exchange = this.repo.getExchange(payload.exchangeId)
    if (exchange === undefined || (exchange.status !== 'pending' && exchange.status !== 'delivered')) return
    const endpoint = exchange.responder
    const instanceId = collectorInstanceOf(endpoint)
    const query = instanceId === null ? undefined : this.collectors.queryCapabilitiesForInstance(instanceId)
    const requestMessage = this.repo.getExchangeMessages(exchange.id).find(message => message.kind === 'request')
    const handler = exchange.kind === 'request' ? query?.handleRequest : undefined
    if (handler === undefined || requestMessage === undefined) {
      this.engine.failExchange({
        exchangeId: exchange.id,
        responder: endpoint,
        reason: 'capability-unavailable',
        retryable: false,
        now: this.now(),
      })
      return
    }
    this.engine.exchangeDelivered(exchange.id, this.now())
    const timeout = Math.max(1000, exchange.deadline - this.now())
    const dispatchSignal = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
    try {
      await handler.call(query, {
        exchangeId: exchange.id,
        endpoint,
        payload: requestMessage.payload,
        signal: dispatchSignal,
        completeExchange: async (result: unknown) => {
          this.engine.completeExchange({ exchangeId: exchange.id, responder: endpoint, result, now: this.now() })
        },
        failExchange: async (reason: string, retryable: boolean) => {
          this.engine.failExchange({ exchangeId: exchange.id, responder: endpoint, reason, retryable, now: this.now() })
        },
      })
    } catch (error) {
      const message = (error as Error).message
      try {
        this.engine.failExchange({ exchangeId: exchange.id, responder: endpoint, reason: message, retryable: true, now: this.now() })
      } catch {
        // A missing exchange after a concurrent cancellation is a no-op.
      }
    }
  }

  // ------------------------------------------------------------ model tools

  /** Start one delegated read-only Task from a Human Turn. */
  async startTask(
    input: { readonly title: string; readonly prompt: string; readonly plan?: string; readonly cwd?: string },
    parent: Agent,
    toolCallId?: string,
  ): Promise<TicketView> {
    const quno = this.requireQuno()
    if (quno.mainSessionId === null) throw new QunoStateError('main-unbound', '主对话尚未绑定，无法委派任务')
    const messageId = latestHumanMessageId(parent) ?? `session:${String(parent.session.id)}`
    const ticket = this.engine.directAccept({
      sessionId: String(parent.session.id),
      messageId,
      toolCallId: toolCallId ?? `${messageId}:quno_task`,
      title: input.title,
      goal: input.prompt,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      now: this.now(),
    })
    this.scheduler.scheduleAutoAnalysis()
    return this.ticketView(ticket.id)
  }

  /** Read one delegated Ticket's durable status and result. */
  getTask(taskId: string): TicketView {
    const ticket = this.repo.getTicket(taskId)
    if (ticket === undefined) throw new QunoStateError('unknown-task', `任务 ${taskId} 不存在`)
    return this.ticketView(ticket.id)
  }

  /** The Eval candidate the Router is currently asked to judge. */
  evalCandidate(evalId?: string): EvalCandidateView | null {
    const id = evalId ?? this.latestEvalIdForMain()
    if (id === null) return null
    const view = this.engine.candidateView(id)
    if (view === null) return null
    const policy = this.engine.policySnapshot()
    return {
      evalId: view.eval.id,
      threadId: view.eval.threadId,
      threadLabel: view.thread?.label ?? view.thread?.threadKey ?? null,
      strength: view.eval.strength,
      policyVersion: view.eval.policyVersion,
      acceptMode: policy.acceptMode,
      status: view.eval.status,
      triggers: view.admissible.map(entry => ({
        triggerId: entry.triggerId,
        type: entry.type,
        human: entry.human,
        addressed: entry.addressed,
        summary: entry.summary,
        occurredAt: entry.occurredAt,
        actor: view.triggers.find(trigger => trigger.id === entry.triggerId)?.actor ?? { source: 'unknown', id: '' },
        channel: entry.channel === null ? null : { source: entry.channel.source, thread: entry.channel.thread },
      })),
      tickets: view.tickets.map(ticket => ({ id: ticket.id, title: ticket.title, mode: ticket.mode })),
    }
  }

  /** Bounded object-graph read for a Human Turn. */
  readObjects(request: {
    readonly triggerId?: string
    readonly threadId?: string
    readonly ticketId?: string
    readonly limit?: number
  }): Record<string, unknown> {
    if (request.triggerId !== undefined) {
      const trigger = this.repo.getTrigger(request.triggerId)
      if (trigger === undefined) return { found: false, message: 'trigger 不存在或已过期' }
      const threads = trigger.threads.flatMap((ref) => {
        const thread = this.repo.getThreadByKey(this.qunoId, ref.source, ref.id)
        return thread === undefined ? [] : [{ id: thread.id, sourceId: thread.sourceId, threadKey: thread.threadKey, label: thread.label }]
      })
      return {
        found: true,
        trigger: {
          id: trigger.id,
          sourceId: trigger.sourceId,
          type: trigger.type,
          operation: trigger.operation,
          summary: trigger.summary,
          occurredAt: trigger.occurredAt,
          human: trigger.human,
          addressed: trigger.addressed,
          actor: trigger.actor,
          data: bounded(trigger.data),
        },
        threads,
      }
    }
    if (request.threadId !== undefined) {
      return { found: true, thread: bounded(buildThreadDetail(this, request.threadId)) }
    }
    if (request.ticketId !== undefined) {
      return { found: true, ticket: bounded(buildTicketDetail(this, request.ticketId)) }
    }
    const limit = Math.min(20, Math.max(1, request.limit ?? 10))
    const threads = this.repo.listThreads(this.qunoId, { limit: 10 }).map(thread => ({
      id: thread.id,
      sourceId: thread.sourceId,
      threadKey: thread.threadKey,
      label: thread.label,
      pending: thread.pendingTriggerIds.length,
      lastAt: thread.lastAt,
    }))
    const triggerIds = [...new Set(threads.flatMap(thread => this.repo.listTriggerIdsByThread(thread.id, limit)))].slice(-limit)
    const triggers = triggerIds.flatMap((id) => {
      const trigger = this.repo.getTrigger(id)
      return trigger === undefined ? [] : [{
        id: trigger.id,
        type: trigger.type,
        summary: trigger.summary,
        occurredAt: trigger.occurredAt,
        human: trigger.human,
        addressed: trigger.addressed,
        threadIds: trigger.threads.map(ref => ref.id),
      }]
    })
    const tickets = this.repo.listTickets(this.qunoId, { limit: 20 }).map(ticket => ({
      id: ticket.id,
      title: ticket.title,
      status: ticket.ended === null ? 'open' : ticket.ended.outcome,
      mode: ticket.mode,
      question: ticket.question,
    }))
    return { found: true, threads, triggers, tickets, collectors: this.collectorEndpoints() }
  }

  /** Bounded object-graph read for the current Eval. */
  evalRead(request: {
    readonly evalId?: string
    readonly triggerId?: string
    readonly threadId?: string
    readonly ticketId?: string
  }): Record<string, unknown> | null {
    const evalId = request.evalId ?? this.latestEvalIdForMain()
    if (evalId === null) return null
    const view = this.engine.candidateView(evalId)
    if (view === null) return null
    const result: Record<string, unknown> = {
      eval: {
        id: view.eval.id,
        status: view.eval.status,
        strength: view.eval.strength,
        policyVersion: view.eval.policyVersion,
        threadId: view.eval.threadId,
        triggerIds: view.eval.triggerIds,
      },
      triggers: view.triggers.map(trigger => ({
        id: trigger.id,
        type: trigger.type,
        human: trigger.human,
        addressed: trigger.addressed,
        actor: trigger.actor,
        summary: trigger.summary,
        occurredAt: trigger.occurredAt,
        contentRef: trigger.contentRef,
        channel: trigger.channel,
        data: bounded(trigger.data),
      })),
      thread: view.thread === undefined
        ? null
        : {
          id: view.thread.id,
          sourceId: view.thread.sourceId,
          threadKey: view.thread.threadKey,
          label: view.thread.label,
          lastAt: view.thread.lastAt,
          closed: view.thread.closed,
        },
      tickets: view.tickets.map(ticket => ({ id: ticket.id, title: ticket.title, mode: ticket.mode, ended: ticket.ended })),
    }
    if (request.triggerId !== undefined && !view.eval.triggerIds.includes(request.triggerId)) return null
    if (request.threadId !== undefined && request.threadId !== view.eval.threadId) return null
    if (request.ticketId !== undefined && !view.tickets.some(ticket => ticket.id === request.ticketId)) return null
    return result
  }

  /** Submit the Router's Eval decision. */
  async evalDecide(input: {
    readonly evalId: string
    readonly kind: 'accept' | 'stop' | 'ignore' | 'unavailable'
    readonly reason?: string
    readonly title?: string
    readonly goal?: string
    readonly mode?: 'once' | 'persistent'
    readonly cwd?: string
  }): Promise<EvalDecideView> {
    const outcome = this.engine.decide({
      evalId: input.evalId,
      kind: input.kind,
      reason: input.reason ?? null,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.goal === undefined ? {} : { goal: input.goal }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      now: this.now(),
    })
    this.scheduler.scheduleAutoAnalysis()
    return {
      evalId: input.evalId,
      kind: outcome.decision.kind,
      downgraded: outcome.downgraded,
      ticketId: outcome.ticket?.id ?? null,
      message: outcome.ticket !== null
        ? `已受理，任务「${outcome.ticket.title}」已在后台开始。`
        : outcome.downgraded
          ? '当前为 observe 模式：只记录 would_accept，未创建任务。'
          : `已记录决定：${outcome.decision.kind}。`,
    }
  }

  /** Apply 1–20 explicit routing instructions from a Human Turn. */
  async routeCandidates(
    input: { readonly items: readonly RouteItem[] },
    parent: Agent,
    toolCallId: string,
  ): Promise<RouteOutcome> {
    const messageId = latestHumanMessageId(parent) ?? `session:${String(parent.session.id)}`
    const accepted: string[] = []
    const attached: string[] = []
    const stopped: string[] = []
    const ignored: string[] = []
    const errors: { index: number; message: string }[] = []
    for (const [index, item] of input.items.entries()) {
      try {
        switch (item.action) {
          case 'accept': {
            const ticket = this.engine.directAccept({
              sessionId: String(parent.session.id),
              messageId,
              toolCallId: `${messageId}:route:${item.triggerId}`,
              title: item.title ?? '处理来源事件',
              goal: item.goal ?? `处理 Trigger ${item.triggerId}`,
              ...(item.mode === undefined ? {} : { mode: item.mode }),
              now: this.now(),
            })
            accepted.push(ticket.id)
            break
          }
          case 'attach': {
            if (item.ticketId === undefined) throw new QunoDomainError('invalid-route', 'attach needs a ticketId')
            const trigger = this.repo.getTrigger(item.triggerId)
            if (trigger === undefined) throw new QunoDomainError('unknown-trigger', 'unknown trigger')
            const threads = trigger.threads.flatMap((ref) => {
              const thread = this.repo.getThreadByKey(this.qunoId, ref.source, ref.id)
              return thread === undefined ? [] : [thread.id]
            })
            this.engine.attach({
              ticketId: item.ticketId,
              threadIds: threads,
              mode: 'context',
              origin: 'source',
              now: this.now(),
            })
            attached.push(item.ticketId)
            break
          }
          case 'stop': {
            if (item.ticketId === undefined) throw new QunoDomainError('invalid-route', 'stop needs a ticketId')
            this.engine.stopTicket({ ticketId: item.ticketId, by: 'human', reason: 'stopped from the conversation', now: this.now() })
            stopped.push(item.ticketId)
            break
          }
          case 'ignore':
            ignored.push(item.triggerId)
            break
        }
      } catch (error) {
        errors.push({ index, message: (error as Error).message })
      }
    }
    this.scheduler.scheduleAutoAnalysis()
    return { accepted, attached, stopped, ignored, errors }
  }

  /** Attach Threads to a Ticket. */
  attachThreads(input: { readonly ticketId: string; readonly threadIds: readonly string[]; readonly mode?: 'owned' | 'context' }): { readonly attached: readonly string[] } {
    const subscriptions = this.engine.attach({
      ticketId: input.ticketId,
      threadIds: input.threadIds,
      mode: input.mode ?? 'context',
      origin: 'source',
      now: this.now(),
    })
    return { attached: subscriptions.map(subscription => subscription.threadId) }
  }

  /** Stop a Ticket from the conversation. */
  stopTicket(ticketId: string): TicketView {
    this.engine.stopTicket({ ticketId, by: 'human', reason: 'stopped from the conversation', now: this.now() })
    return this.ticketView(ticketId)
  }

  /** Retry a Ticket's executor work under the same Mandate. */
  retryTicket(ticketId: string): TicketView {
    this.engine.retryTicket({ ticketId, now: this.now() })
    this.scheduler.scheduleAutoAnalysis()
    return this.ticketView(ticketId)
  }

  /** Write one note into a live Ticket. */
  noteTicket(ticketId: string, text: string): TicketView {
    this.engine.note({ ticketId, text, human: true, now: this.now() })
    this.scheduler.scheduleAutoAnalysis()
    return this.ticketView(ticketId)
  }

  /** Start one asynchronous read owned by the Router. */
  requestExchange(input: {
    readonly responder: string
    readonly kind?: 'request' | 'command'
    readonly payload: unknown
    readonly timeoutMs?: number
  }): { readonly requestId: string; readonly deadline: number; readonly message: string } {
    if (!this.queryAdvertises(input.responder, input.kind ?? 'request')) {
      throw new QunoStateError('unknown-responder', `没有挂载可响应 ${input.responder} 的采集器。${this.queryDirectoryText()} 端点先用 quno_read 的 collectors 列表查询，不要猜。`)
    }
    const exchange = this.engine.requestExchange({
      kind: input.kind ?? 'request',
      requester: routerEndpoint(this.qunoId),
      responder: input.responder,
      payload: input.payload,
      deadlineMs: Math.min(600_000, Math.max(1000, input.timeoutMs ?? 60_000)),
      now: this.now(),
    })
    this.scheduler.scheduleAutoAnalysis()
    return {
      requestId: exchange.id,
      deadline: exchange.deadline,
      message: `已发起异步读取 ${exchange.id}；结果稍后作为评估/汇报输入回来。`,
    }
  }

  /** Enqueue one proactive notification candidate produced by the Router. */
  notify(input: {
    readonly title: string
    readonly summary: string
    readonly body: string
    readonly why: string
    readonly topicKey?: string
    readonly itemIds?: readonly string[]
    readonly urgent?: boolean
  }): { readonly notificationId: string | null; readonly message: string } {
    const quno = this.requireQuno()
    const now = this.now()
    if (quno.mutedUntil !== null && quno.mutedUntil > now) {
      return { notificationId: null, message: '当前处于静默期，这条通知不会主动推送。' }
    }
    const payload: NoticePayload = {
      title: input.title.slice(0, 120),
      body: input.body.slice(0, 8000),
      summary: input.summary.slice(0, 200),
      why: input.why.slice(0, 500),
      ...(input.itemIds === undefined ? {} : { itemIds: input.itemIds }),
      ...(input.urgent === true ? { urgent: true } : {}),
    }
    const notice = this.store.enqueueNotice({
      qunoId: this.qunoId,
      topicKey: input.topicKey ?? `router:${sha256(stableStringify(payload)).slice(0, 16)}`,
      materialRevision: 1,
      reminderStage: 0,
      kind: 'report',
      payload,
      eligibleAt: now,
      expiresAt: null,
      now,
    })
    if (notice === null) return { notificationId: null, message: '已有相同主题的待发通知，已合并。' }
    this.repo.enqueueEffect({ kind: 'notice', key: notice.id, payload: { notificationId: notice.id }, now })
    this.scheduler.scheduleAutoAnalysis()
    return { notificationId: notice.id, message: '已进入通知队列，合适的时机再展示给用户。' }
  }

  /** Search the permanent conversation and its executor sessions. */
  async recall(request: RecallRequest): Promise<RecallResult> {
    return await recall({
      ctx: this.ctx,
      store: this.store,
      qunoId: this.qunoId,
      mainSessionId: () => this.mainSessionId(),
      backgroundSessions: () => {
        const seen = new Set<string>()
        const sessions: { sessionId: string; kind: 'task' }[] = []
        for (const ticket of this.repo.listTickets(this.qunoId, { limit: 50 })) {
          for (const assignment of this.repo.listAssignmentsByTicket(ticket.id)) {
            if (assignment.executorSessionId === '' || seen.has(assignment.executorSessionId)) continue
            seen.add(assignment.executorSessionId)
            sessions.push({ sessionId: assignment.executorSessionId, kind: 'task' })
          }
        }
        return sessions
      },
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
    const tickets = this.repo.listTickets(this.qunoId, { open: true, limit: 200 })
    const notices = this.store.listNotices(this.qunoId, 200)
    const effects = this.repo.listDueEffects(this.now(), 200)
    const waitingEvals = this.repo.listEvals(this.qunoId, { status: ['delivering', 'waiting-decision'], limit: 200 })
    const watchdog = this.watchdog.inspect()
    const collectors = this.collectors.healthSnapshot().types.flatMap(view => view.instances.map(instance => ({
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
        pending: effects.filter(effect => effect.kind === 'input-delivery').length,
        deferred: waitingEvals.length,
        deadLetter: effects.filter(effect => effect.attempts >= 3).length,
      },
      tasks: {
        running: tickets.filter(ticket => ticket.question === null).length,
        interrupted: tickets.filter(ticket => ticket.question !== null).length,
      },
      collectors,
      notices: {
        pending: notices.filter(notice => notice.status === 'pending').length,
        inboxDurable: notices.filter(notice => notice.status === 'inbox-durable').length,
        blocked: notices.filter(notice => notice.status === 'delivery-blocked').length,
      },
      watchdog: {
        healthy: watchdog.healthy,
        findings: watchdog.findings.map(finding => ({
          code: finding.code,
          severity: finding.severity,
          detail: finding.detail,
          count: finding.count,
        })),
      },
    }
  }

  // ---------------------------------------------------------- Remote methods

  /** Full bounded settings snapshot (called by the gateway). */
  async state(): Promise<QunoWireState> {
    return buildQunoState(this)
  }

  /** Bind or create the main conversation from the browser. */
  async ensureMainForClient(request: { readonly cwd: string; readonly workspaceId?: string }): Promise<EnsureMainResult> {
    return await this.ensureMain(request.cwd, request.workspaceId)
  }

  /** Bounded recent-events summary for the panel's 动态 view (called by the gateway). */
  async eventsRecentForClient(request: { readonly limit?: number }): Promise<{ readonly events: EventWire[] }> {
    return { events: await buildRecentEvents(this, request.limit ?? 20) }
  }

  /** Merge a validated config patch. */
  async updateConfig(request: { readonly patch: Record<string, unknown> }): Promise<QunoWireState> {
    const quno = this.requireQuno()
    const merged = mergeQunoConfig(quno.config, request.patch)
    if (!merged.ok) throw new QunoStateError(merged.error.code, merged.error.message)
    this.store.updateQunoConfig(this.qunoId, merged.value, this.now())
    const before = quno.config
    const policyRelevant = before.enabled !== merged.value.enabled
      || before.acceptMode !== merged.value.acceptMode
      || before.autoSourceIds.join('\u0000') !== merged.value.autoSourceIds.join('\u0000')
    if (policyRelevant) this.engine.policyChanged(this.now())
    this.scheduler.scheduleAutoAnalysis()
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

  /** Create a Collector instance. */
  async createCollector(request: {
    readonly type: string
    readonly label?: string
    readonly config?: Record<string, unknown>
    readonly desiredState?: 'enabled' | 'paused' | 'disabled'
  }): Promise<QunoWireState> {
    const result = this.collectors.createInstance({
      type: request.type,
      ...(request.label === undefined ? {} : { label: request.label }),
      config: request.config ?? {},
      ...(request.desiredState === undefined ? {} : { desiredState: request.desiredState }),
    })
    if (!result.ok) throw new QunoStateError(result.error.code, result.error.message)
    return await this.state()
  }

  /** Pause/resume/disable/remove/reconfigure one Collector instance. */
  async collectorCommand(request: {
    readonly instanceId: string
    readonly action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
    readonly label?: string
    readonly config?: Record<string, unknown>
  }): Promise<QunoWireState> {
    switch (request.action) {
      case 'pause': await this.collectors.pause(request.instanceId); break
      case 'resume': await this.collectors.resume(request.instanceId); break
      case 'disable': await this.collectors.disable(request.instanceId); break
      case 'remove': await this.collectors.remove(request.instanceId); break
      case 'reconfigure': {
        const result = await this.collectors.reconfigureInstance(request.instanceId, {
          ...(request.label === undefined ? {} : { label: request.label }),
          ...(request.config === undefined ? {} : { config: request.config }),
        })
        if (!result.ok) throw new QunoStateError(result.error?.code ?? 'invalid', result.error?.message ?? '配置无效')
        break
      }
    }
    return await this.state()
  }

  /**
   * Probe one instance for real (no restart, no config revision bump, no
   * checkpoint movement, and explicitly NOT reported as a successful sync).
   */
  async probeCollector(request: { readonly instanceId: string }): Promise<CollectorProbeWire> {
    const result = await this.collectors.probeInstance(request.instanceId)
    return {
      ok: result.ok,
      code: result.code,
      message: result.message,
      at: result.at,
      durationMs: result.durationMs,
    }
  }

  /** Field-level option discovery (cloud groups, calendars, …). */
  async collectorOptions(request: {
    readonly type: string
    readonly field: string
    readonly config?: Record<string, unknown>
    readonly page?: number
    readonly limit?: number
  }): Promise<CollectorOptionsPageWire> {
    const page = await this.collectors.listFieldOptions({
      type: request.type,
      field: request.field,
      ...(request.config === undefined ? {} : { config: request.config }),
      ...(request.page === undefined ? {} : { page: request.page }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
    })
    return {
      ok: page.ok,
      options: page.options.map(option => ({ ...option })),
      more: page.more,
      ...(page.detail === undefined ? {} : { detail: page.detail }),
      ...(page.error === undefined ? {} : { error: { code: page.error.code, message: page.error.message } }),
    }
  }

  /** One historical notice plus the current state of its linked items. */
  async noticeDetail(request: { readonly notificationId: string }): Promise<NoticeDetailWire | null> {
    return await buildNoticeDetail(this, request.notificationId)
  }

  /** One bounded event payload for an evidence drill-down. */
  async eventDetail(request: { readonly eventId: string }): Promise<EventDetailWire | null> {
    return await buildEventDetail(this, request.eventId)
  }

  /** One Trigger body, loaded on demand (never part of the polling snapshot). */
  async triggerDetail(request: { readonly triggerId: string }): Promise<TriggerDetailWire | null> {
    return buildTriggerDetail(this, request.triggerId)
  }

  /** One Thread with subscriptions and recent Triggers. */
  async threadDetail(request: { readonly threadId: string }): Promise<ThreadDetailWire | null> {
    return buildThreadDetail(this, request.threadId)
  }

  /** One Ticket with assignments, inputs and report. */
  async ticketDetail(request: { readonly ticketId: string }): Promise<TicketDetailWire | null> {
    return buildTicketDetail(this, request.ticketId)
  }

  /** One Eval with its decision audit. */
  async evalDetail(request: { readonly evalId: string }): Promise<EvalDetailWire | null> {
    return buildEvalDetail(this, request.evalId)
  }

  /** One Exchange with its durable messages. */
  async exchangeDetail(request: { readonly exchangeId: string }): Promise<ExchangeDetailWire | null> {
    return buildExchangeDetail(this, request.exchangeId)
  }

  /** Resume, abandon or cancel an open Ticket. */
  async taskCommandForClient(request: {
    readonly taskId: string
    readonly action: 'resume' | 'abandon' | 'cancel'
  }): Promise<QunoWireState> {
    if (request.action === 'cancel' || request.action === 'abandon') {
      this.engine.stopTicket({ ticketId: request.taskId, by: 'human', reason: `user ${request.action}`, now: this.now() })
    } else {
      this.engine.retryTicket({ ticketId: request.taskId, now: this.now() })
    }
    this.scheduler.scheduleAutoAnalysis()
    return await this.state()
  }

  /** Resume or abandon an open Ticket. */
  async taskCommand(request: { readonly taskId: string; readonly action: 'resume' | 'abandon' | 'cancel' }): Promise<QunoWireState> {
    return await this.taskCommandForClient(request)
  }

  /** Short-term mute from the UI. */
  async muteForClient(request: { readonly minutes?: number; readonly until?: string; readonly cancel?: boolean }): Promise<QunoWireState> {
    await this.mute(request)
    return await this.state()
  }

  /** Bounded operational metrics for support and acceptance tables. */
  metrics(): EngineMetrics {
    return computeMetrics(this.repo, this.qunoId, this.now())
  }

  /** Diagnostics for tests and support: preset registration failure, if any. */
  get presetFailure(): string | null {
    return this.presetError
  }

  /** The executor model selection (Quno profile first, harness default second). */
  private executorModel(): { provider: string; model: string; reasoningEffort?: string } | undefined {
    const quno = this.store.getQuno(this.qunoId, { required: false })
    const fallback = this.ctx.get('agentDefaultModel')?.currentSelection()
    const provider = quno !== undefined && quno.modelProvider !== '' ? quno.modelProvider : fallback?.provider
    const model = quno !== undefined && quno.model !== '' ? quno.model : fallback?.model
    if (provider === undefined || model === undefined) return undefined
    const reasoningEffort = quno?.reasoningEffort ?? (quno?.model === '' ? fallback?.reasoningEffort : undefined)
    return {
      provider,
      model,
      ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }),
    }
  }

  /** The Eval id carried by the latest Quno-originated main message. */
  private latestEvalIdForMain(): string | null {
    return currentEvalId(this.mainAgent())
  }

  private ticketView(ticketId: string): TicketView {
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined) throw new QunoStateError('unknown-task', `任务 ${ticketId} 不存在`)
    const assignment = this.repo.findActiveAssignment(ticket.id) ?? this.repo.listAssignmentsByTicket(ticket.id).at(-1)
    const report = assignment?.report ?? null
    const ended = ticket.ended
    const status: TicketView['status'] = ended !== null
      ? ended.outcome === 'completed' ? 'done'
        : ended.outcome === 'failed' ? 'failed'
          : ended.outcome === 'stopped' ? 'cancelled'
            : 'done'
      : ticket.question !== null
        ? 'interrupted'
        : assignment?.state === 'running' ? 'running' : 'waiting'
    const result = report === null ? null : report.summary
    const error = report !== null && report.state === 'failed'
      ? { code: 'task-failed', message: report.summary }
      : ended !== null && ended.outcome === 'failed'
        ? { code: 'task-failed', message: ended.reason ?? '任务失败' }
        : null
    return {
      id: ticket.id,
      title: ticket.title,
      goal: ticket.goal,
      status,
      mode: ticket.mode,
      executorSessionId: assignment?.executorSessionId ?? null,
      result,
      artifacts: (report?.artifacts ?? []).map(artifact => ({ kind: artifact.kind, label: artifact.label, uri: artifact.uri })),
      error,
      question: ticket.question === null ? null : { id: ticket.question.id, question: ticket.question.question, triggerId: ticket.question.triggerId },
      createdAt: ticket.createdAt,
      settledAt: ended?.at ?? null,
      endedBy: ended?.by ?? null,
    }
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

/** Re-exported for the UI's "why" rendering. */
export { currentEvalId }

/** The exchange kinds a Router request may use. */
export type { ExchangeKind }

/** Bounded JSON used by detail views. */
function bounded(value: unknown): unknown {
  if (value === null || value === undefined) return null
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return null
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : JSON.parse(text) as unknown
  } catch {
    return '（无法序列化）'
  }
}

/** Bridge for the old task status tool shape. */
export type { TicketView }
