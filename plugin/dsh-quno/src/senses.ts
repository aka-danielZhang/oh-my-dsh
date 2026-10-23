/**
 * The Sense layer: registration of perception capabilities, instance
 * lifecycle, generation-scoped ingress and honest health.
 *
 * A Sense is trusted in-process code (v1): the contract boundary protects
 * data integrity, not the host from malicious plugins. The three lifecycle
 * axes stay separate — desired state, runtime lifecycle, health — so a paused
 * Sense is not "failed" and a degraded Sense is not "stopped".
 *
 * @module dsh-quno/senses
 */

import { parseHealthReport, parseSenseDefinition, SENSE_CONTRACT_VERSION } from './contracts.ts'
import { QunoIngress, QunoIngressError, readGapReport } from './ingress.ts'
import { backoffMs } from './util.ts'
import type { QunoStore } from './store.ts'
import type {
  ContractFailure,
  SenseHealthReport,
} from './contracts.ts'
import type {
  IngestAck,
  IngestBatch,
  QunoRecord,
  SenseCheckpoint,
  SenseDefinition,
  SenseDesiredState,
  SenseHealthDetail,
  SenseInstanceRecord,
  SenseTypeView,
  SourceRecord,
} from './types.ts'

/** What the Host gives one running Sense generation. */
export interface SenseRuntime<Config = Record<string, unknown>> {
  readonly instanceId: string
  readonly sourceId: string
  readonly type: string
  readonly config: Config
  readonly generation: number
  readonly checkpoint: SenseCheckpoint
  readonly signal: AbortSignal
  readonly limits: {
    readonly maxEventsPerCheck: number
    readonly maxBytesPerCheck: number
  }
  readonly logger: { info(message: string): void; warn(message: string): void }
  readonly ingress: {
    ingestBatch(batch: IngestBatch): Promise<IngestAck>
    reportHealth(report: SenseHealthReport): Promise<void>
  }
}

/** The handle a Sense returns from `start`; `stop` is idempotent. */
export interface SenseHandle {
  stop(): Promise<void> | void
}

/** Implemented by each `dsh-quno-sense-*` package. */
export interface SenseFactory<Config = Record<string, unknown>> {
  /** Validate and normalize the instance configuration. */
  validateConfig?(raw: unknown): { readonly ok: true; readonly value: Config } | { readonly ok: false; readonly message: string }
  /** Optional one-shot availability check before a run starts. */
  probe?(config: Config, runtime: Omit<SenseRuntime<Config>, 'ingress'>): Promise<{ readonly ok: boolean; readonly detail?: string }>
  /** Begin observing. Throw to report an unavailable source. */
  start(runtime: SenseRuntime<Config>): Promise<SenseHandle> | SenseHandle
}

/** Result of an instance command. */
export interface InstanceResult {
  readonly ok: boolean
  readonly error?: ContractFailure
}

/** Dependencies of the Sense service. */
export interface SenseServiceDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly logger: { info(message: string): void; warn(message: string): void }
  /** Called after instances change (UI refresh). */
  readonly onChange?: () => void
  /** Called after a batch commits (routing / scheduler wake). */
  readonly onIngest?: (ack: IngestAck, sourceId: string) => void
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void
  readonly now?: () => number
}

interface LiveInstance {
  readonly generation: number
  readonly controller: AbortController
  handle?: SenseHandle
  ingress?: QunoIngress
  retryDispose?: () => void
  readonly binding: {
    instance: SenseInstanceRecord
    source: SourceRecord
    generation: number
    configRevision: number
  }
}

interface RegisteredType {
  readonly definition: SenseDefinition
  readonly factory: SenseFactory
}

/** Registry + lifecycle owner for Sense instances. */
export class QunoSensesService {
  private readonly types = new Map<string, RegisteredType>()
  private readonly live = new Map<string, LiveInstance>()
  private readonly retryTimers = new Map<string, () => void>()
  private readonly now: () => number

  constructor(private readonly deps: SenseServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * Register one Sense type. Called by a Sense plugin's entry; a declaration
   * that fails the contract rejects the plugin loudly.
   */
  register(definitionInput: unknown, factory: SenseFactory): () => Promise<void> {
    const parsed = parseSenseDefinition(definitionInput)
    if (!parsed.ok) {
      throw new Error(`dsh-quno sense declaration rejected: ${parsed.error.message}`)
    }
    const definition = parsed.value
    if (this.types.has(definition.type)) {
      throw new Error(`dsh-quno sense type "${definition.type}" is already registered`)
    }
    this.types.set(definition.type, { definition, factory })
    this.deps.store.upsertSenseType({
      type: definition.type,
      contractVersion: Number(definition.contractVersion.split('/v')[1] ?? '1'),
      implementationVersion: definition.implementationVersion,
      definition,
      registeredAt: this.now(),
    })
    // Start instances that were waiting for this type.
    for (const instance of this.deps.store.listSenseInstances(this.deps.qunoId)) {
      if (instance.type === definition.type && instance.desiredState === 'enabled') {
        this.safeStart(instance.id)
      }
    }
    return async () => {
      this.types.delete(definition.type)
      for (const [instanceId, live] of this.live) {
        const instance = this.deps.store.getSenseInstance(instanceId)
        if (instance.type !== definition.type) continue
        await this.stopLive(instanceId, live, 'type unregistered')
      }
      this.deps.store.deleteSenseType(definition.type)
      this.deps.onChange?.()
    }
  }

  /** Whether a type is currently registered. */
  hasType(type: string): boolean {
    return this.types.has(type)
  }

  /** All known types with their instances (registered first, then historical). */
  list(): SenseTypeView[] {
    const views = new Map<string, SenseTypeView>()
    for (const [type, registered] of this.types) {
      views.set(type, {
        type,
        displayName: registered.definition.displayName,
        description: registered.definition.description,
        contractVersion: registered.definition.contractVersion,
        implementationVersion: registered.definition.implementationVersion,
        definition: registered.definition,
        instances: [],
      })
    }
    for (const instance of this.deps.store.listSenseInstances(this.deps.qunoId)) {
      const view = views.get(instance.type)
      if (view !== undefined) {
        views.set(instance.type, { ...view, instances: [...view.instances, instance] })
        continue
      }
      const stored = this.deps.store.listSenseTypes().find(row => row.type === instance.type)
      const definition = (stored?.definition ?? {}) as SenseDefinition
      views.set(instance.type, {
        type: instance.type,
        displayName: typeof definition.displayName === 'string' ? definition.displayName : instance.type,
        description: typeof definition.description === 'string' ? definition.description : '（来源声明缺失）',
        contractVersion: typeof definition.contractVersion === 'string' ? definition.contractVersion : SENSE_CONTRACT_VERSION,
        implementationVersion: typeof definition.implementationVersion === 'string' ? definition.implementationVersion : 'unknown',
        definition: definition as SenseDefinition,
        instances: [...(views.get(instance.type)?.instances ?? []), instance],
      })
    }
    return [...views.values()].sort((left, right) => left.type.localeCompare(right.type))
  }

  /**
   * Create one Sense instance and start it when requested.
   * @returns the instance, or a validation failure.
   */
  createInstance(input: {
    readonly type: string
    readonly label?: string
    readonly config: unknown
    readonly desiredState?: SenseDesiredState
  }): { readonly ok: true; readonly instance: SenseInstanceRecord } | { readonly ok: false; readonly error: ContractFailure } {
    const registered = this.types.get(input.type)
    if (registered === undefined) {
      return { ok: false, error: { code: 'unknown-type', message: `Sense 类型 ${input.type} 未注册` } }
    }
    const config = this.validateConfig(registered, input.config)
    if (!config.ok) return config
    const instance = this.deps.store.insertSenseInstance({
      id: `sense-${String(this.now())}-${Math.random().toString(36).slice(2, 8)}`,
      qunoId: this.deps.qunoId,
      type: input.type,
      label: input.label ?? registered.definition.displayName,
      config: config.value,
      desiredState: input.desiredState ?? 'enabled',
      now: this.now(),
    })
    if (instance.desiredState === 'enabled') this.safeStart(instance.id)
    this.deps.onChange?.()
    return { ok: true, instance }
  }

  /** Validate and persist a new configuration, restarting the generation. */
  async reconfigureInstance(instanceId: string, patch: {
    readonly label?: string
    readonly config?: unknown
    readonly desiredState?: SenseDesiredState
  }): Promise<InstanceResult> {
    const current = this.deps.store.getSenseInstance(instanceId)
    const registered = this.types.get(current.type)
    if (registered === undefined) {
      return { ok: false, error: { code: 'unknown-type', message: `Sense 类型 ${current.type} 未注册` } }
    }
    let config = current.config
    if (patch.config !== undefined) {
      const validated = this.validateConfig(registered, patch.config)
      if (!validated.ok) return validated
      config = validated.value
    }
    // Unified restart semantics: revoke the old generation, stop it, store the
    // new revision, then start again.
    const live = this.live.get(instanceId)
    if (live !== undefined) await this.stopLive(instanceId, live, 'reconfigured')
    const updated = this.deps.store.updateSenseInstance(instanceId, {
      label: patch.label ?? current.label,
      config,
      configRevision: current.configRevision + 1,
      desiredState: patch.desiredState ?? current.desiredState,
      lifecycle: 'stopped',
      now: this.now(),
    })
    if (updated.desiredState === 'enabled') this.safeStart(instanceId)
    this.deps.onChange?.()
    return { ok: true }
  }

  /** Pause observation: stop the generation, keep the checkpoint and history. */
  async pause(instanceId: string): Promise<InstanceResult> {
    return this.setDesiredState(instanceId, 'paused')
  }

  /** Resume observation: start a fresh generation from the persisted checkpoint. */
  async resume(instanceId: string): Promise<InstanceResult> {
    return this.setDesiredState(instanceId, 'enabled')
  }

  /** Disable and keep configuration/history. */
  async disable(instanceId: string): Promise<InstanceResult> {
    return this.setDesiredState(instanceId, 'disabled')
  }

  /** Delete one instance (its sources and events stay as history). */
  async remove(instanceId: string): Promise<InstanceResult> {
    const live = this.live.get(instanceId)
    if (live !== undefined) await this.stopLive(instanceId, live, 'removed')
    this.deps.store.deleteSenseInstance(instanceId)
    this.deps.onChange?.()
    return { ok: true }
  }

  private async setDesiredState(instanceId: string, desired: SenseDesiredState): Promise<InstanceResult> {
    const current = this.deps.store.getSenseInstance(instanceId)
    if (desired !== 'enabled') {
      const live = this.live.get(instanceId)
      if (live !== undefined) await this.stopLive(instanceId, live, `desired state ${desired}`)
    }
    const updated = this.deps.store.updateSenseInstance(instanceId, {
      desiredState: desired,
      lifecycle: desired === 'enabled' ? current.lifecycle : 'stopped',
      now: this.now(),
    })
    if (desired === 'enabled' && updated.desiredState === 'enabled') this.safeStart(instanceId)
    this.deps.onChange?.()
    return { ok: true }
  }

  private validateConfig(
    registered: RegisteredType,
    raw: unknown,
  ): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: ContractFailure } {
    const input = raw ?? registered.definition.defaults ?? {}
    if (registered.factory.validateConfig === undefined) {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, error: { code: 'validation', message: '配置必须是对象' } }
      }
      return { ok: true, value: input as Record<string, unknown> }
    }
    const result = registered.factory.validateConfig(input)
    if (!result.ok) return { ok: false, error: { code: 'validation', message: result.message } }
    return { ok: true, value: result.value as Record<string, unknown> }
  }

  /** Fire-and-forget start that never leaks an unhandled rejection (unload/close races). */
  private safeStart(instanceId: string): void {
    void this.startInstance(instanceId).catch((error: unknown) => {
      this.deps.logger.warn(`dsh-quno: sense start failed: ${(error as Error).message}`)
    })
  }

  private async startInstance(instanceId: string): Promise<void> {
    if (this.live.has(instanceId)) return
    const instance = this.deps.store.getSenseInstance(instanceId)
    if (instance.desiredState !== 'enabled') return
    const registered = this.types.get(instance.type)
    if (registered === undefined) {
      this.deps.store.updateSenseInstance(instanceId, {
        lifecycle: 'stopped',
        health: 'unknown',
        healthDetail: { state: 'unknown', detail: '感知器插件未加载' },
        now: this.now(),
      })
      return
    }
    const generation = this.deps.store.bumpGeneration(instanceId, this.now())
    const source = this.deps.store.ensureSource(instance, null, this.now())
    // A newly created (or restarted) source must participate in routing;
    // without a subscription its deliveries would never be generated.
    this.deps.store.ensureSubscriptions(this.deps.qunoId, [source], this.now())
    const controller = new AbortController()
    const binding = {
      instance: { ...instance, generation },
      source,
      generation,
      configRevision: instance.configRevision,
    }
    const live: LiveInstance = { generation, controller, binding }
    this.live.set(instanceId, live)
    this.deps.store.updateSenseInstance(instanceId, {
      lifecycle: 'starting',
      lastAttemptAt: this.now(),
      now: this.now(),
    })
    this.deps.onChange?.()

    const ingress = new QunoIngress(this.deps.store, this.deps.qunoId, {
      onCommitted: (ack, sourceId) => this.deps.onIngest?.(ack, sourceId),
      onGap: (sourceId, reason) => {
        this.deps.store.updateSenseInstance(instanceId, {
          health: 'degraded',
          healthDetail: { state: 'degraded', detail: `检测到数据缺口：${reason}` },
          now: this.now(),
        })
      },
    })
    live.ingress = ingress
    const runtime: SenseRuntime = {
      instanceId,
      sourceId: source.id,
      type: instance.type,
      config: instance.config,
      generation,
      checkpoint: instance.checkpoint,
      signal: controller.signal,
      limits: {
        maxEventsPerCheck: registered.definition.runtime.quotas?.maxEventsPerCheck ?? 100,
        maxBytesPerCheck: registered.definition.runtime.quotas?.maxBytesPerCheck ?? 1024 * 1024,
      },
      logger: {
        info: message => this.deps.logger.info(`[sense:${instance.type}] ${message}`),
        warn: message => this.deps.logger.warn(`[sense:${instance.type}] ${message}`),
      },
      ingress: {
        ingestBatch: async (batch) => {
          try {
            return ingress.ingest(live.binding, batch, this.now())
          } catch (error) {
            if (error instanceof QunoIngressError) throw error
            throw new QunoIngressError({
              code: 'temporarily-unavailable',
              message: (error as Error).message,
              retryable: true,
            })
          }
        },
        reportHealth: async (report) => {
          this.reportHealth(instanceId, generation, report)
        },
      },
    }

    try {
      if (registered.factory.probe !== undefined) {
        const probe = await withTimeout(
          registered.factory.probe(instance.config, runtime),
          registered.definition.runtime.timeoutMs,
        )
        if (!probe.ok) {
          throw new Error(probe.detail ?? '来源探测失败')
        }
      }
      const handle = await withTimeout(
        Promise.resolve(registered.factory.start(runtime)),
        registered.definition.runtime.timeoutMs,
      )
      live.handle = handle as SenseHandle
      if (controller.signal.aborted) {
        await Promise.resolve((handle as SenseHandle).stop()).catch(() => {})
        return
      }
      this.deps.store.updateSenseInstance(instanceId, {
        lifecycle: 'running',
        health: 'healthy',
        healthDetail: { state: 'healthy', lastAttemptAt: this.now(), consecutiveFailures: 0 },
        consecutiveFailures: 0,
        errorCode: null,
        nextRetryAt: null,
        now: this.now(),
      })
      this.deps.onChange?.()
    } catch (error) {
      const message = (error as Error).message
      this.live.delete(instanceId)
      const failures = instance.consecutiveFailures + 1
      this.deps.store.updateSenseInstance(instanceId, {
        lifecycle: 'failed',
        health: 'unavailable',
        healthDetail: { state: 'unavailable', detail: message, consecutiveFailures: failures },
        consecutiveFailures: failures,
        errorCode: 'start-failed',
        nextRetryAt: this.now() + backoffMs(failures),
        now: this.now(),
      })
      this.deps.logger.warn(`dsh-quno: sense ${instance.type} failed to start: ${message}`)
      this.deps.onChange?.()
      this.scheduleRetry(instanceId, failures)
    }
  }

  private scheduleRetry(instanceId: string, failures: number): void {
    if (failures > 5 || this.deps.setTimer === undefined) return
    if (this.live.has(instanceId)) return
    this.clearRetry(instanceId)
    const delay = backoffMs(failures)
    const dispose = this.deps.setTimer(() => {
      this.retryTimers.delete(instanceId)
      const current = this.deps.store.getSenseInstance(instanceId)
      if (current.desiredState !== 'enabled' || this.live.has(instanceId)) return
      this.safeStart(instanceId)
    }, delay)
    this.retryTimers.set(instanceId, dispose)
  }

  private clearRetry(instanceId: string): void {
    const dispose = this.retryTimers.get(instanceId)
    if (dispose === undefined) return
    this.retryTimers.delete(instanceId)
    dispose()
  }

  private async stopLive(instanceId: string, live: LiveInstance, reason: string): Promise<void> {
    if (this.live.get(instanceId) === live) this.live.delete(instanceId)
    this.clearRetry(instanceId)
    live.retryDispose?.()
    live.controller.abort(new Error(reason))
    if (live.handle !== undefined) {
      await withTimeout(Promise.resolve(live.handle.stop()), 10_000).catch((error: unknown) => {
        this.deps.logger.warn(`dsh-quno: sense stop failed: ${(error as Error).message}`)
      })
    }
    try {
      this.deps.store.updateSenseInstance(instanceId, {
        lifecycle: 'stopped',
        now: this.now(),
      })
    } catch {
      // the instance may have been removed
    }
    this.deps.onChange?.()
  }

  private reportHealth(instanceId: string, generation: number, report: unknown): void {
    const parsed = parseHealthReport(report)
    if (!parsed.ok) {
      this.deps.logger.warn(`dsh-quno: sense health report rejected: ${parsed.error.message}`)
      return
    }
    const instance = this.deps.store.getSenseInstance(instanceId)
    if (instance.generation !== generation) return
    const detail: SenseHealthDetail = {
      state: parsed.value.state,
      detail: parsed.value.detail,
      lastAttemptAt: parsed.value.lastAttemptAt ?? this.now(),
      lastSuccessfulSyncAt: parsed.value.lastSuccessfulSyncAt ?? instance.lastSuccessAt,
      lastEventAt: parsed.value.lastEventAt ?? instance.lastEventAt,
      consecutiveFailures: parsed.value.consecutiveFailures ?? instance.consecutiveFailures,
      errorCode: parsed.value.errorCode ?? null,
      nextRetryAt: parsed.value.nextRetryAt ?? null,
      coveredThrough: parsed.value.coveredThrough ?? null,
      sourceLagSec: parsed.value.sourceLagSec ?? null,
    }
    this.deps.store.updateSenseInstance(instanceId, {
      health: parsed.value.state,
      healthDetail: detail,
      lastAttemptAt: detail.lastAttemptAt ?? null,
      lastSuccessAt: detail.lastSuccessfulSyncAt ?? null,
      lastEventAt: detail.lastEventAt ?? null,
      consecutiveFailures: detail.consecutiveFailures ?? 0,
      errorCode: detail.errorCode ?? null,
      nextRetryAt: detail.nextRetryAt ?? null,
      now: this.now(),
    })
    this.deps.onChange?.()
  }

  /**
   * Restricted write entry for advanced Sense hosts and tests: a submission is
   * rejected unless it names the instance's CURRENT writable generation.
   */
  ingest(instanceId: string, generation: number, batch: unknown): IngestAck {
    const live = this.live.get(instanceId)
    if (live === undefined || live.generation !== generation || live.ingress === undefined) {
      throw new QunoIngressError({
        code: 'stale-generation',
        message: `Sense instance ${instanceId} generation ${String(generation)} is not writable`,
        retryable: false,
      })
    }
    return live.ingress.ingest(live.binding, batch, this.now())
  }

  /** Start every enabled persisted instance (plugin boot). */
  startAll(): void {
    for (const instance of this.deps.store.listSenseInstances(this.deps.qunoId)) {
      if (instance.desiredState === 'enabled') this.safeStart(instance.id)
    }
  }

  /** Stop every generation (plugin unload). Idempotent. */
  async stopAll(): Promise<void> {
    for (const dispose of this.retryTimers.values()) dispose()
    this.retryTimers.clear()
    const entries = [...this.live.entries()]
    this.live.clear()
    await Promise.all(entries.map(async ([instanceId, live]) => {
      live.retryDispose?.()
      live.controller.abort(new Error('plugin unloading'))
      if (live.handle !== undefined) {
        await withTimeout(Promise.resolve(live.handle.stop()), 5000).catch(() => {})
      }
      try {
        this.deps.store.updateSenseInstance(instanceId, { lifecycle: 'stopped', now: this.now() })
      } catch {
        // removed
      }
    }))
  }

  /** Health snapshot for the UI, including computed staleness and gaps. */
  healthSnapshot(): {
    readonly types: SenseTypeView[]
    readonly gaps: readonly { readonly sourceId: string; readonly at: number; readonly reason: string }[]
  } {
    const now = this.now()
    const types = this.list().map(view => ({
      ...view,
      instances: view.instances.map(instance => withStaleness(instance, view.definition, now)),
    }))
    const gaps = this.deps.store.listSources(this.deps.qunoId).flatMap((source) => {
      const gap = readGapReport(this.deps.store, source.id)
      return gap === undefined ? [] : [{ sourceId: source.id, at: gap.at, reason: gap.reason }]
    })
    return { types, gaps }
  }

  /** Resolve one instance's type definition (UI/config forms). */
  definitionOf(type: string): SenseDefinition | undefined {
    return this.types.get(type)?.definition
  }

  /** The Quno row (persona/instructions) for prompt assembly. */
  quno(): QunoRecord | undefined {
    return this.deps.store.getQuno(this.deps.qunoId)
  }
}

/** Add a computed `stale` flag based on the instance's own freshness threshold. */
function withStaleness(
  instance: SenseInstanceRecord,
  definition: SenseDefinition,
  now: number,
): SenseInstanceRecord & { readonly stale: boolean } {
  const thresholdSec = typeof instance.config['freshnessThresholdSec'] === 'number'
    ? instance.config['freshnessThresholdSec'] as number
    : definition.runtime.defaultIntervalSec * 3
  const last = instance.lastSuccessAt
  return { ...instance, stale: last === null ? true : now - last > thresholdSec * 1000 }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`sense operation timed out after ${String(ms)}ms`)), ms)
        if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The service shape Sense plugins consume through `ctx.get('qunoSenses')`. */
export interface QunoSensesFace {
  register(definition: unknown, factory: SenseFactory): () => Promise<void>
  hasType(type: string): boolean
}
