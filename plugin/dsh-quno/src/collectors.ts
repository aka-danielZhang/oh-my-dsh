/**
 * The Collector layer: registration of collection capabilities, instance
 * lifecycle, Host-driven scheduling and honest health.
 *
 * A Collector is trusted in-process code: the contract boundary protects data
 * integrity, not the host from malicious plugins. The three lifecycle axes
 * stay separate — desired state, runtime lifecycle, health — so a paused
 * collector is not "failed" and a degraded collector is not "stopped".
 *
 * The Host owns ALL timing. A plugin never holds a timer: it implements
 * `run(ctx)` — one collection attempt that commits zero or more batches — and
 * the collection scheduler inside this service decides when the next run
 * happens (success hint → clamp, failure → backoff, fatal/timeout → stop).
 * Health is derived from run outcomes plus the extras a run returns; there is
 * no self-reported heartbeat between runs.
 *
 * @module dsh-quno/collectors
 */

import { parseCollectorDefinition, COLLECTOR_CONTRACT_VERSION } from './contracts.ts'
import type { CollectorHealthExtras, ContractFailure } from './contracts.ts'
import { QunoIngress, QunoIngressError, readGapReport } from './ingress.ts'
import type { IngressBinding, IngressTriggerSink } from './ingress.ts'
import { backoffMs } from './util.ts'
import type { QunoStore } from './store.ts'
import type {
  IngestAck,
  IngestBatch,
  QunoRecord,
  CollectorCheckpoint,
  CollectorDefinition,
  CollectorDesiredState,
  CollectorHealthDetail,
  CollectorHealthState,
  CollectorInstanceRecord,
  CollectorLifecycle,
  CollectorOption,
  CollectorTypeView,
} from './types.ts'

/** One field-option discovery request handed to a collector implementation. */
export interface CollectorOptionsRequest<Config = Record<string, unknown>> {
  readonly instanceId: string
  readonly type: string
  /** The config field that declared `discover: true`. */
  readonly field: string
  /**
   * The draft configuration. Partial on purpose: discovery runs before the
   * full instance configuration is valid (a profile, say, but no groups yet).
   */
  readonly config: Config
  /** 1-based page. */
  readonly page: number
  /** Page size the Host will honour; the implementation may return fewer. */
  readonly limit: number
  readonly signal: AbortSignal
}

/** What one discovery call returns; failures are classified by the Host. */
export interface CollectorOptionsResult {
  readonly options: readonly CollectorOption[]
  /** Whether another page exists. */
  readonly more?: boolean
  /** Optional human-readable note (login hint, quota note, …). */
  readonly detail?: string
}

/** A classified discovery failure, safe to show in the UI. */
export interface CollectorOptionsFailure {
  readonly code: string
  readonly message: string
}

/** What the Host hands to ONE collection run. */
export interface CollectorRunContext<Config = Record<string, unknown>> {
  readonly instanceId: string
  readonly sourceId: string
  readonly type: string
  readonly config: Config
  /**
   * Identity of this run — the generation-level write fence. A commit is
   * accepted while this run's generation is the instance's current one and
   * the instance is still enabled with the same config revision. The next
   * run, a reconfigure, pause/disable/remove and a Host timeout each revoke
   * it. Between two runs the LAST run's face stays writable until the next
   * run starts; a well-behaved collector only commits inside `run`.
   */
  readonly runId: number
  readonly checkpoint: CollectorCheckpoint
  /**
   * `checkpoint-entries/v1`: keyed per-entity checkpoint state with paginated
   * reads; writes ride `commit`'s `checkpointPatch` and land in the same
   * SQLite transaction. Absent on Hosts without the capability — collectors
   * must fall back to the single-blob checkpoint.
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
  readonly limits: {
    readonly maxEventsPerRun: number
    readonly maxBytesPerRun: number
  }
  readonly logger: { info(message: string): void; warn(message: string): void }
  /** The only write face. One run may commit several batches. */
  readonly commit: (batch: IngestBatch) => Promise<IngestAck>
  /** Aborted when the Host stops the instance, reconfigures it, or the run overruns `maxRunMs`. */
  readonly signal: AbortSignal
}

/** A classified run failure; the Host owns the retry schedule. */
export interface CollectorRunFailure {
  readonly state: 'auth-required' | 'rate-limited' | 'unavailable' | 'degraded'
  readonly code: string
  readonly message: string
  /** Host-honoured retry delay; `null`/absent falls back to the Host backoff. */
  readonly retryAfterMs?: number | null
  /** `true`: the Host stops scheduling this instance until reconfigure/re-enable. */
  readonly fatal?: boolean
}

/** What one run returns. `ok` runs may hint the next run time. */
export type CollectorRunOutcome =
  | { readonly ok: true; readonly nextRunAtMs?: number; readonly health?: CollectorHealthExtras }
  | { readonly ok: false; readonly failure: CollectorRunFailure; readonly health?: CollectorHealthExtras }

/** Handed to `mount` when an instance becomes active with a config. */
export interface CollectorMountContext<Config = Record<string, unknown>> {
  readonly instanceId: string
  readonly config: Config
}

/** Implemented by each `dsh-quno-collector-*` package. */
export interface CollectorFactory<Config = Record<string, unknown>> {
  /** Validate and normalize the instance configuration. */
  validateConfig?(raw: unknown): { readonly ok: true; readonly value: Config } | { readonly ok: false; readonly message: string }
  /** Optional one-shot availability check before a run starts. */
  probe?(config: Config, ctx: Omit<CollectorRunContext<Config>, 'commit' | 'signal' | 'runId'>): Promise<{ readonly ok: boolean; readonly detail?: string }>
  /**
   * Optional field-level option discovery (recent groups, calendars, …).
   * Only called for fields whose declaration sets `discover: true`; must be
   * side-effect free and must not require a valid complete configuration.
   */
  listOptions?(request: CollectorOptionsRequest<Config>): Promise<CollectorOptionsResult>
  /** One Host-scheduled collection attempt. */
  run(ctx: CollectorRunContext<Config>): Promise<CollectorRunOutcome>
  /**
   * Called when the instance is enabled or reconfigured; the returned
   * disposer runs on pause/disable/remove/unregister/reconfigure. Instances
   * that answer on-demand exchanges bind their query face here.
   */
  mount?(m: CollectorMountContext<Config>): (() => void) | void
}

/** Result of one explicit probe (never a lifecycle transition). */
export interface CollectorProbeResult {
  readonly ok: boolean
  /** Machine code: `ok`, `unsupported`, `probe-failed`, `timeout`. */
  readonly code: string
  readonly message: string
  readonly at: number
  readonly durationMs: number
}

/**
 * A classified discovery failure raised by a collector implementation.
 *
 * The contract is STRUCTURAL: any Error whose `name` is
 * `'CollectorOptionsError'` and that carries a string `code`. Collector
 * plugins MUST NOT value-import this class — an installed tarball bundles its
 * own copy, so `instanceof` against the Host's class is always false. They
 * throw a structurally equivalent error instead; the Host recognises it with
 * `isCollectorOptionsError`.
 */
export class CollectorOptionsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CollectorOptionsError'
  }
}

/** Structural check for a classified discovery failure (works across module copies). */
export function isCollectorOptionsError(error: unknown): error is Error & { readonly code: string } {
  if (!(error instanceof Error)) return false
  return error.name === 'CollectorOptionsError' && typeof (error as { code?: unknown }).code === 'string'
}

/** One discovery response after Host-side bounding and validation. */
export interface CollectorOptionsPage {
  readonly ok: boolean
  readonly options: readonly CollectorOption[]
  readonly more: boolean
  readonly detail?: string
  readonly error?: CollectorOptionsFailure
}

/** Result of an instance command. */
export interface InstanceResult {
  readonly ok: boolean
  readonly error?: ContractFailure
}

/** Dependencies of the collector service. */
export interface CollectorServiceDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly logger: { info(message: string): void; warn(message: string): void }
  /** Called after instances change (UI refresh). */
  readonly onChange?: () => void
  /** Called after a batch commits (scheduler wake). */
  readonly onIngest?: (ack: IngestAck, sourceId: string) => void
  /** The domain receive seam invoked inside the same transaction as the batch. */
  readonly triggerSink?: IngressTriggerSink
  /** Injectable timer seam (tests drive the scheduler with a ManualTimer). */
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void
  readonly now?: () => number
}

/** One registered collector type. */
interface RegisteredType {
  readonly definition: CollectorDefinition
  readonly factory: CollectorFactory
}

/** One run in flight. */
interface LiveRun {
  readonly runId: number
  readonly controller: AbortController
  readonly binding: IngressBinding
  promise: Promise<void>
  /** Set when this run's commits reported an upstream gap (health input). */
  gapReason?: string
}

/** Per-instance scheduling + mount state. */
interface InstanceRuntime {
  timerDispose?: () => void
  mountDispose?: (() => void) | void
  mountedConfigRevision?: number
  run?: LiveRun
}

/** Largest delay a Node timer represents without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Scheduling bounds: a hint may be tight, never zero; never past 24h. */
const MIN_RUN_GAP_MS = 1_000
const MAX_SCHEDULE_DELAY_MS = 24 * 60 * 60 * 1000

/**
 * Registry + Host-side collection scheduler for collector instances.
 *
 * One instance, one single-shot timer at a time, earliest due first. Enable /
 * reconfigure / boot run the instance immediately; success schedules the
 * plugin's hint (or the declared default interval) clamped to
 * `[now+1s, now+24h]`; a non-fatal failure backs off (`retryAfterMs` first,
 * then the deterministic Host backoff); a fatal failure or a run overrunning
 * `maxRunMs` stops scheduling until a human acts.
 */
export class QunoCollectorsService {
  private readonly types = new Map<string, RegisteredType>()
  private readonly runtimes = new Map<string, InstanceRuntime>()
  private readonly now: () => number

  constructor(private readonly deps: CollectorServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * Register one collector type. Called by a collector plugin's entry; a
   * declaration that fails the contract rejects the plugin loudly.
   */
  register(definitionInput: unknown, factory: CollectorFactory): () => Promise<void> {
    const parsed = parseCollectorDefinition(definitionInput)
    if (!parsed.ok) {
      throw new Error(`dsh-quno collector declaration rejected: ${parsed.error.message}`)
    }
    const definition = parsed.value
    if (this.types.has(definition.type)) {
      throw new Error(`dsh-quno collector type "${definition.type}" is already registered`)
    }
    this.types.set(definition.type, { definition, factory })
    this.deps.store.upsertCollectorType({
      type: definition.type,
      contractVersion: Number(definition.contractVersion.split('/v')[1] ?? '1'),
      implementationVersion: definition.implementationVersion,
      definition,
      registeredAt: this.now(),
    })
    // Activate instances that were waiting for this type: mount + run now.
    for (const instance of this.deps.store.listCollectorInstances(this.deps.qunoId)) {
      if (instance.type !== definition.type || instance.desiredState !== 'enabled') continue
      this.ensureMount(instance)
      this.arm(instance.id, this.now())
    }
    return async () => {
      this.types.delete(definition.type)
      for (const instance of this.deps.store.listCollectorInstances(this.deps.qunoId)) {
        if (instance.type !== definition.type) continue
        await this.stopInstance(instance.id, 'type unregistered')
      }
      this.deps.store.deleteCollectorType(definition.type)
      this.deps.onChange?.()
    }
  }

  /** Whether a type is currently registered. */
  hasType(type: string): boolean {
    return this.types.has(type)
  }

  /** All known types with their instances (registered first, then historical). */
  list(): CollectorTypeView[] {
    const views = new Map<string, CollectorTypeView>()
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
    for (const instance of this.deps.store.listCollectorInstances(this.deps.qunoId)) {
      const view = views.get(instance.type)
      if (view !== undefined) {
        views.set(instance.type, { ...view, instances: [...view.instances, instance] })
        continue
      }
      const stored = this.deps.store.listCollectorTypes().find(row => row.type === instance.type)
      const definition = (stored?.definition ?? {}) as CollectorDefinition
      views.set(instance.type, {
        type: instance.type,
        displayName: typeof definition.displayName === 'string' ? definition.displayName : instance.type,
        description: typeof definition.description === 'string' ? definition.description : '（来源声明缺失）',
        contractVersion: typeof definition.contractVersion === 'string' ? definition.contractVersion : COLLECTOR_CONTRACT_VERSION,
        implementationVersion: typeof definition.implementationVersion === 'string' ? definition.implementationVersion : 'unknown',
        definition: definition as CollectorDefinition,
        instances: [...(views.get(instance.type)?.instances ?? []), instance],
      })
    }
    return [...views.values()].sort((left, right) => left.type.localeCompare(right.type))
  }

  /**
   * Create one collector instance and start it when requested.
   * @returns the instance, or a validation failure.
   */
  createInstance(input: {
    readonly type: string
    readonly label?: string
    readonly config: unknown
    readonly desiredState?: CollectorDesiredState
  }): { readonly ok: true; readonly instance: CollectorInstanceRecord } | { readonly ok: false; readonly error: ContractFailure } {
    const registered = this.types.get(input.type)
    if (registered === undefined) {
      return { ok: false, error: { code: 'unknown-type', message: `采集器类型 ${input.type} 未注册` } }
    }
    const config = this.validateConfig(registered, input.config)
    if (!config.ok) return config
    const instance = this.deps.store.insertCollectorInstance({
      id: `col-${String(this.now())}-${Math.random().toString(36).slice(2, 8)}`,
      qunoId: this.deps.qunoId,
      type: input.type,
      label: input.label ?? registered.definition.displayName,
      config: config.value,
      desiredState: input.desiredState ?? 'enabled',
      now: this.now(),
    })
    if (instance.desiredState === 'enabled') {
      this.ensureMount(instance)
      this.arm(instance.id, this.now())
    }
    this.deps.onChange?.()
    return { ok: true, instance }
  }

  /** Validate and persist a new configuration, remounting and rerunning. */
  async reconfigureInstance(instanceId: string, patch: {
    readonly label?: string
    readonly config?: unknown
    readonly desiredState?: CollectorDesiredState
  }): Promise<InstanceResult> {
    const current = this.deps.store.getCollectorInstance(instanceId)
    const registered = this.types.get(current.type)
    if (registered === undefined) {
      return { ok: false, error: { code: 'unknown-type', message: `采集器类型 ${current.type} 未注册` } }
    }
    let config = current.config
    if (patch.config !== undefined) {
      // A `null` value on a declared secret field means "keep the stored one":
      // the browser never receives secret values, so it cannot echo them back.
      const draft = { ...(patch.config as Record<string, unknown>) }
      for (const field of registered.definition.configFields ?? []) {
        if (field.secret !== true || draft[field.key] !== null) continue
        const stored = current.config[field.key]
        if (stored === undefined) delete draft[field.key]
        else draft[field.key] = stored
      }
      const validated = this.validateConfig(registered, draft)
      if (!validated.ok) return validated
      config = validated.value
    }
    // Unified restart semantics: stop the in-flight run and the timer, drop
    // the mount (it binds the OLD config), store the new revision, then arm.
    await this.stopInstance(instanceId, 'reconfigured')
    const updated = this.deps.store.updateCollectorInstance(instanceId, {
      label: patch.label ?? current.label,
      config,
      configRevision: current.configRevision + 1,
      desiredState: patch.desiredState ?? current.desiredState,
      lifecycle: 'idle',
      now: this.now(),
    })
    if (updated.desiredState === 'enabled') {
      this.ensureMount(updated)
      this.arm(instanceId, this.now())
    }
    this.deps.onChange?.()
    return { ok: true }
  }

  /** Pause collection: stop runs, keep the checkpoint and history. */
  async pause(instanceId: string): Promise<InstanceResult> {
    return this.setDesiredState(instanceId, 'paused')
  }

  /** Resume collection: mount and run from the persisted checkpoint. */
  async resume(instanceId: string): Promise<InstanceResult> {
    return this.setDesiredState(instanceId, 'enabled')
  }

  /** Disable and keep configuration/history. */
  async disable(instanceId: string): Promise<InstanceResult> {
    return this.setDesiredState(instanceId, 'disabled')
  }

  /** Delete one instance (its sources and events stay as history). */
  async remove(instanceId: string): Promise<InstanceResult> {
    await this.stopInstance(instanceId, 'removed')
    this.deps.store.deleteCollectorInstance(instanceId)
    this.runtimes.delete(instanceId)
    this.deps.onChange?.()
    return { ok: true }
  }

  /**
   * Run the collector's own availability check without touching lifecycle,
   * configuration revisions or the checkpoint. Probe success is NOT a sync
   * success and must never be reported as one.
   */
  async probeInstance(instanceId: string): Promise<CollectorProbeResult> {
    const at = this.now()
    const instance = this.deps.store.getCollectorInstance(instanceId)
    const registered = this.types.get(instance.type)
    if (registered === undefined) {
      return { ok: false, code: 'unsupported', message: '采集器类型当前未加载，无法探测', at, durationMs: 0 }
    }
    if (registered.factory.probe === undefined) {
      return { ok: false, code: 'unsupported', message: '该采集器没有提供探测能力', at, durationMs: 0 }
    }
    const source = this.deps.store.listSources(this.deps.qunoId).find(candidate => candidate.instanceId === instanceId)
    const probeCtx: Omit<CollectorRunContext, 'commit' | 'signal' | 'runId'> = {
      instanceId,
      sourceId: source?.id ?? `probe-${instanceId}`,
      type: instance.type,
      config: instance.config,
      checkpoint: instance.checkpoint,
      checkpointEntries: {
        list: (request: { readonly limit?: number; readonly afterKey?: string }) => {
          const entries = this.deps.store.listCheckpointEntries(instanceId, request)
          return {
            entries,
            count: this.deps.store.countCheckpointEntries(instanceId),
            revision: this.deps.store.getCollectorInstance(instanceId).checkpoint.revision,
          }
        },
        get: (key: string) => this.deps.store.getCheckpointEntry(instanceId, key),
      },
      capabilities: { checkpointEntries: true },
      limits: {
        maxEventsPerRun: registered.definition.schedule.quotas?.maxEventsPerRun ?? 100,
        maxBytesPerRun: registered.definition.schedule.quotas?.maxBytesPerRun ?? 1024 * 1024,
      },
      logger: {
        info: message => this.deps.logger.info(`[collector:${instance.type}] ${message}`),
        warn: message => this.deps.logger.warn(`[collector:${instance.type}] ${message}`),
      },
    }
    const startedAt = Date.now()
    try {
      const result = await withTimeout(
        registered.factory.probe(instance.config as never, probeCtx as never),
        registered.definition.schedule.maxRunMs,
        'collector probe',
      )
      const durationMs = Date.now() - startedAt
      return result.ok
        ? { ok: true, code: 'ok', message: result.detail ?? '探测成功', at, durationMs }
        : { ok: false, code: 'probe-failed', message: result.detail ?? '探测失败', at, durationMs }
    } catch (error) {
      const durationMs = Date.now() - startedAt
      const message = (error as Error).message
      const timeout = message.includes('timed out')
      return {
        ok: false,
        code: timeout ? 'timeout' : 'probe-failed',
        message: timeout ? `探测超时（${String(registered.definition.schedule.maxRunMs)}ms）` : message,
        at,
        durationMs,
      }
    }
  }

  /**
   * Discover one field's options through the collector implementation. Works
   * for a type plus a DRAFT configuration, so the onboarding wizard can offer
   * real choices before an instance exists. The Host only allows fields that
   * declared `discover: true`, bounds the page, and sanitizes every option.
   */
  async listFieldOptions(input: {
    readonly type: string
    readonly field: string
    readonly config?: unknown
    readonly page?: number
    readonly limit?: number
  }): Promise<CollectorOptionsPage> {
    const registered = this.types.get(input.type)
    if (registered === undefined) {
      return { ok: false, options: [], more: false, error: { code: 'unsupported', message: '采集器类型当前未加载' } }
    }
    const field = (registered.definition.configFields ?? []).find(candidate => candidate.key === input.field)
    if (field === undefined) {
      return { ok: false, options: [], more: false, error: { code: 'unknown-field', message: `未声明的配置字段：${input.field}` } }
    }
    if (field.discover !== true) {
      return { ok: false, options: [], more: false, error: { code: 'not-discoverable', message: `字段 ${input.field} 不支持远程选项发现` } }
    }
    if (registered.factory.listOptions === undefined) {
      return { ok: false, options: [], more: false, error: { code: 'unsupported', message: '该采集器没有实现选项发现' } }
    }
    const page = Math.min(200, Math.max(1, Math.trunc(input.page ?? 1)))
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 20)))
    const controller = new AbortController()
    const config = input.config ?? registered.definition.defaults ?? {}
    try {
      const result = await withTimeout(
        registered.factory.listOptions({
          instanceId: '',
          type: input.type,
          field: input.field,
          config: config as never,
          page,
          limit,
          signal: controller.signal,
        }),
        registered.definition.schedule.maxRunMs,
        'collector discovery',
      )
      const options = sanitizeOptions(result.options, limit)
      return {
        ok: true,
        options,
        more: result.more === true,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      }
    } catch (error) {
      if (isCollectorOptionsError(error)) {
        return { ok: false, options: [], more: false, error: { code: error.code, message: error.message } }
      }
      const message = (error as Error).message
      return {
        ok: false,
        options: [],
        more: false,
        error: { code: message.includes('timed out') ? 'timeout' : 'discovery-failed', message },
      }
    }
  }

  /** Whether the registered implementation offers a real probe. */
  supportsProbe(type: string): boolean {
    return this.types.get(type)?.factory.probe !== undefined
  }

  private async setDesiredState(instanceId: string, desired: CollectorDesiredState): Promise<InstanceResult> {
    if (desired !== 'enabled') {
      await this.stopInstance(instanceId, `desired state ${desired}`)
    }
    const current = this.deps.store.getCollectorInstance(instanceId)
    const updated = this.deps.store.updateCollectorInstance(instanceId, {
      desiredState: desired,
      lifecycle: desired === 'enabled' ? 'idle' : 'stopped',
      now: this.now(),
    })
    if (desired === 'enabled') {
      this.ensureMount(updated)
      this.arm(instanceId, this.now())
    }
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

  /** The query capabilities of one collector instance (by instance id). */
  queryCapabilitiesForInstance(instanceId: string): CollectorDefinition['query'] | undefined {
    const instance = this.deps.store.listCollectorInstances(this.deps.qunoId).find(candidate => candidate.id === instanceId)
    if (instance === undefined) return undefined
    return this.types.get(instance.type)?.definition.query
  }

  // ------------------------------------------------------------- scheduling

  private runtimeFor(instanceId: string): InstanceRuntime {
    let rt = this.runtimes.get(instanceId)
    if (rt === undefined) {
      rt = {}
      this.runtimes.set(instanceId, rt)
    }
    return rt
  }

  /** (Re)arm the instance's single-shot timer, earliest due wins. */
  private arm(instanceId: string, atMs: number): void {
    const rt = this.runtimeFor(instanceId)
    rt.timerDispose?.()
    rt.timerDispose = undefined
    if (this.deps.setTimer === undefined) return
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, atMs - this.now()))
    rt.timerDispose = this.deps.setTimer(() => {
      rt.timerDispose = undefined
      // Fire-and-forget must never leak an unhandled rejection (a row deleted
      // or the store closed between arming and firing).
      void this.runInstance(instanceId).catch((error: unknown) => {
        this.deps.logger.warn(`dsh-quno: collector run could not start: ${(error as Error).message}`)
      })
    }, delay)
  }

  private clearTimer(instanceId: string): void {
    const rt = this.runtimes.get(instanceId)
    rt?.timerDispose?.()
    if (rt !== undefined) rt.timerDispose = undefined
  }

  /** Bind the factory's mount face for the CURRENT config (idempotent). */
  private ensureMount(instance: CollectorInstanceRecord): void {
    const registered = this.types.get(instance.type)
    if (registered === undefined) return
    const rt = this.runtimeFor(instance.id)
    if (rt.mountedConfigRevision === instance.configRevision) return
    this.disposeMount(instance.id)
    if (registered.factory.mount !== undefined) {
      rt.mountDispose = registered.factory.mount({ instanceId: instance.id, config: instance.config })
    }
    rt.mountedConfigRevision = instance.configRevision
  }

  private disposeMount(instanceId: string): void {
    const rt = this.runtimes.get(instanceId)
    if (rt === undefined || rt.mountDispose === undefined) return
    try {
      rt.mountDispose()
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: collector mount dispose failed: ${(error as Error).message}`)
    }
    rt.mountDispose = undefined
    rt.mountedConfigRevision = undefined
  }

  /** Stop timer + run + mount for one instance (every stop path funnels here). */
  private async stopInstance(instanceId: string, reason: string): Promise<void> {
    this.clearTimer(instanceId)
    const rt = this.runtimes.get(instanceId)
    const run = rt?.run
    if (rt !== undefined && run !== undefined) {
      run.controller.abort(new Error(reason))
      await run.promise.catch(() => {})
      if (rt.run === run) rt.run = undefined
    }
    this.disposeMount(instanceId)
    try {
      this.deps.store.updateCollectorInstance(instanceId, { lifecycle: 'stopped', now: this.now() })
    } catch {
      // the instance may have been removed
    }
    this.deps.onChange?.()
  }

  /** Timer callback: launch one run for the instance (if eligible). */
  private async runInstance(instanceId: string): Promise<void> {
    const rt = this.runtimeFor(instanceId)
    if (rt?.run !== undefined) return // a run is in flight; its outcome schedules next
    const instance = this.deps.store.getCollectorInstance(instanceId)
    if (instance.desiredState !== 'enabled') return
    const registered = this.types.get(instance.type)
    if (registered === undefined) {
      this.deps.store.updateCollectorInstance(instanceId, {
        lifecycle: 'stopped',
        health: 'unknown',
        healthDetail: { state: 'unknown', detail: '采集器插件未加载' },
        now: this.now(),
      })
      this.deps.onChange?.()
      return
    }
    const runId = this.deps.store.bumpGeneration(instanceId, this.now())
    const source = this.deps.store.ensureSource(instance, null, this.now())
    // A source must participate in routing; without a subscription its
    // deliveries would never be generated.
    this.deps.store.ensureSubscriptions(this.deps.qunoId, [source], this.now())
    const controller = new AbortController()
    const binding: IngressBinding = {
      instance: { ...instance, generation: runId },
      source,
      generation: runId,
      configRevision: instance.configRevision,
    }
    const live: LiveRun = {
      runId,
      controller,
      binding,
      promise: Promise.resolve(),
    }
    const ingress = new QunoIngress(this.deps.store, this.deps.qunoId, {
      onCommitted: (ack, sourceId) => this.deps.onIngest?.(ack, sourceId),
      onGap: (sourceId, gapReason) => {
        // The gap rides this run's health: the outcome write merges it, so a
        // successful run that saw a gap still lands as degraded.
        if (sourceId === binding.source.id) live.gapReason = gapReason
        const latest = this.deps.store.getCollectorInstance(instanceId)
        this.deps.store.updateCollectorInstance(instanceId, {
          health: 'degraded',
          healthDetail: { ...(latest.healthDetail ?? {}), state: 'degraded', detail: `检测到数据缺口：${gapReason}` },
          now: this.now(),
        })
        this.deps.onChange?.()
      },
    }, this.deps.triggerSink)

    const runCtx: CollectorRunContext = {
      instanceId,
      sourceId: source.id,
      type: instance.type,
      config: instance.config,
      runId,
      checkpoint: instance.checkpoint,
      checkpointEntries: {
        list: (request: { readonly limit?: number; readonly afterKey?: string }) => {
          const entries = this.deps.store.listCheckpointEntries(instanceId, request)
          return {
            entries,
            count: this.deps.store.countCheckpointEntries(instanceId),
            revision: this.deps.store.getCollectorInstance(instanceId).checkpoint.revision,
          }
        },
        get: (key: string) => this.deps.store.getCheckpointEntry(instanceId, key),
      },
      capabilities: { checkpointEntries: true },
      limits: {
        maxEventsPerRun: registered.definition.schedule.quotas?.maxEventsPerRun ?? 100,
        maxBytesPerRun: registered.definition.schedule.quotas?.maxBytesPerRun ?? 1024 * 1024,
      },
      logger: {
        info: message => this.deps.logger.info(`[collector:${instance.type}] ${message}`),
        warn: message => this.deps.logger.warn(`[collector:${instance.type}] ${message}`),
      },
      commit: async (batch) => {
        try {
          return ingress.ingest(binding, batch, this.now())
        } catch (error) {
          if (error instanceof QunoIngressError) throw error
          throw new QunoIngressError({
            code: 'temporarily-unavailable',
            message: (error as Error).message,
            retryable: true,
          })
        }
      },
      signal: controller.signal,
    }

    const startedAt = this.now()
    this.deps.store.updateCollectorInstance(instanceId, {
      lifecycle: 'running',
      lastAttemptAt: startedAt,
      now: this.now(),
    })
    this.deps.onChange?.()

    live.promise = this.executeRun(instanceId, registered.definition, runCtx, controller, startedAt, live)
    rt.run = live
  }

  /** Drive one run to completion and derive health + the next schedule. */
  private async executeRun(
    instanceId: string,
    definition: CollectorDefinition,
    ctx: CollectorRunContext,
    controller: AbortController,
    startedAt: number,
    live: LiveRun,
  ): Promise<void> {
    try {
      const factory = this.requireFactory(instanceId)
      const outcome = await withTimeout(
        Promise.resolve(factory.run(ctx)),
        definition.schedule.maxRunMs,
        'collector run',
      )
      if (controller.signal.aborted) return // stopped/reconfigured mid-run: state already written
      this.applyOutcome(instanceId, definition, outcome, startedAt, live)
    } catch (error) {
      if (controller.signal.aborted) return
      const message = (error as Error).message
      if (message.startsWith('collector run timed out')) {
        // A run that ignores its deadline is stopped hard: abort the signal,
        // revoke its write face (no later run will ever fence it — scheduling
        // stops here) and stop scheduling until a human acts.
        controller.abort(new Error('run timed out'))
        this.revokeWrites(instanceId)
        this.writeHealth(instanceId, {
          state: 'unavailable',
          detail: `采集运行超时（${String(definition.schedule.maxRunMs)}ms），已停止调度`,
          lastAttemptAt: startedAt,
          consecutiveFailures: this.deps.store.getCollectorInstance(instanceId).consecutiveFailures + 1,
          errorCode: 'run-timeout',
          nextRetryAt: null,
        }, 'failed')
      } else {
        // A run that throws instead of returning a failure is degraded noise,
        // not a plugin crash: back off like any other non-fatal failure.
        this.applyFailure(instanceId, definition, {
          state: 'degraded',
          code: 'run-threw',
          message,
        }, startedAt, undefined, live)
      }
      this.deps.logger.warn(`dsh-quno: collector ${ctx.type} run failed: ${message}`)
    } finally {
      const current = this.runtimes.get(instanceId)
      if (current !== undefined && current.run !== undefined && current.run.runId === ctx.runId) {
        current.run = undefined
      }
    }
  }

  /** Bump the generation so every outstanding commit face is refused. */
  private revokeWrites(instanceId: string): void {
    try {
      this.deps.store.bumpGeneration(instanceId, this.now())
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: collector write revocation failed: ${(error as Error).message}`)
    }
  }

  private requireFactory(instanceId: string): CollectorFactory {
    const instance = this.deps.store.getCollectorInstance(instanceId)
    const registered = this.types.get(instance.type)
    if (registered === undefined) throw new Error(`collector type ${instance.type} unregistered mid-run`)
    return registered.factory
  }

  /** Derive health + the next schedule from one run outcome. */
  private applyOutcome(
    instanceId: string,
    definition: CollectorDefinition,
    outcome: CollectorRunOutcome,
    startedAt: number,
    live: LiveRun,
  ): void {
    if (outcome.ok) {
      this.applySuccess(instanceId, definition, outcome, startedAt, live)
    } else {
      this.applyFailure(instanceId, definition, outcome.failure, startedAt, outcome.health, live)
    }
  }

  private applySuccess(
    instanceId: string,
    definition: CollectorDefinition,
    outcome: Extract<CollectorRunOutcome, { ok: true }>,
    startedAt: number,
    live: LiveRun,
  ): void {
    const now = this.now()
    const extras = outcome.health ?? {}
    const issues = extras.issues ?? []
    const gapReason = live.gapReason
    const degraded = issues.length > 0 || gapReason !== undefined
    const rawNext = typeof outcome.nextRunAtMs === 'number' && Number.isFinite(outcome.nextRunAtMs)
      ? outcome.nextRunAtMs
      : now + definition.schedule.defaultIntervalSec * 1000
    const next = Math.min(Math.max(rawNext, now + MIN_RUN_GAP_MS), now + MAX_SCHEDULE_DELAY_MS)
    this.writeHealth(instanceId, {
      state: degraded ? 'degraded' : 'healthy',
      ...(gapReason !== undefined
        ? { detail: `检测到数据缺口：${gapReason}` }
        : extras.detail === undefined ? {} : { detail: extras.detail }),
      lastAttemptAt: startedAt,
      lastSuccessfulSyncAt: now,
      consecutiveFailures: 0,
      errorCode: degraded ? (issues[0]?.code ?? 'gap-reported') : null,
      nextRetryAt: null,
      ...(extras.coveredThrough === undefined ? {} : { coveredThrough: extras.coveredThrough }),
      ...(extras.sourceLagSec === undefined ? {} : { sourceLagSec: extras.sourceLagSec }),
      ...(extras.progress === undefined ? {} : { progress: extras.progress }),
      ...(issues.length > 0 ? { issues } : {}),
    }, 'idle')
    this.arm(instanceId, next)
  }

  private applyFailure(
    instanceId: string,
    definition: CollectorDefinition,
    failure: CollectorRunFailure,
    startedAt: number,
    extras?: CollectorHealthExtras,
    live?: LiveRun,
  ): void {
    const now = this.now()
    const instance = this.deps.store.getCollectorInstance(instanceId)
    if (failure.fatal === true) {
      // Stop scheduling; only a reconfigure/re-enable (or type reload) runs again.
      this.writeHealth(instanceId, {
        state: failure.state,
        detail: failure.message,
        lastAttemptAt: startedAt,
        consecutiveFailures: instance.consecutiveFailures + 1,
        errorCode: failure.code,
        nextRetryAt: null,
        ...(extras?.coveredThrough === undefined ? {} : { coveredThrough: extras.coveredThrough }),
        ...(extras?.sourceLagSec === undefined ? {} : { sourceLagSec: extras.sourceLagSec }),
        ...(extras?.progress === undefined ? {} : { progress: extras.progress }),
        ...(extras?.issues === undefined ? {} : { issues: extras.issues }),
      }, 'failed')
      return
    }
    const failures = instance.consecutiveFailures + 1
    const retryAfterMs = typeof failure.retryAfterMs === 'number' && failure.retryAfterMs > 0
      ? failure.retryAfterMs
      : backoffMs(failures)
    const next = Math.max(now + definition.schedule.defaultIntervalSec * 1000, now + retryAfterMs)
    this.writeHealth(instanceId, {
      state: failure.state,
      detail: failure.message,
      lastAttemptAt: startedAt,
      consecutiveFailures: failures,
      errorCode: failure.code,
      nextRetryAt: next,
      ...(extras?.coveredThrough === undefined ? {} : { coveredThrough: extras.coveredThrough }),
      ...(extras?.sourceLagSec === undefined ? {} : { sourceLagSec: extras.sourceLagSec }),
      ...(extras?.progress === undefined ? {} : { progress: extras.progress }),
      ...(extras?.issues === undefined ? {} : { issues: extras.issues }),
    }, 'idle')
    this.arm(instanceId, next)
  }

  /**
   * Host-derived health write. `lifecycle` is written only when given; the
   * extras ride inside `healthDetail` (wire-compatible with the old
   * self-reported shape).
   */
  private writeHealth(
    instanceId: string,
    detail: CollectorHealthDetail,
    lifecycle?: Extract<CollectorLifecycle, 'idle' | 'running' | 'stopped' | 'failed'>,
  ): void {
    try {
      const current = this.deps.store.getCollectorInstance(instanceId)
      // A run does not own the "last success" and "last event" facts: a failed
      // run keeps the previous success, and last_event_at belongs to the
      // ingress (stamped inside the commit transaction). The columns are only
      // patched when this write carries a value — `undefined` keeps the row,
      // `null` would erase it — and the health JSON carries both forward.
      const merged: CollectorHealthDetail = {
        ...detail,
        lastSuccessfulSyncAt: detail.lastSuccessfulSyncAt ?? current.lastSuccessAt,
        lastEventAt: detail.lastEventAt ?? current.lastEventAt,
      }
      this.deps.store.updateCollectorInstance(instanceId, {
        health: detail.state as CollectorHealthState,
        healthDetail: merged,
        ...(detail.lastAttemptAt === undefined ? {} : { lastAttemptAt: detail.lastAttemptAt }),
        ...(detail.lastSuccessfulSyncAt === undefined ? {} : { lastSuccessAt: detail.lastSuccessfulSyncAt }),
        ...(detail.lastEventAt === undefined ? {} : { lastEventAt: detail.lastEventAt }),
        consecutiveFailures: detail.consecutiveFailures ?? 0,
        errorCode: detail.errorCode ?? null,
        nextRetryAt: detail.nextRetryAt ?? null,
        ...(lifecycle === undefined ? {} : { lifecycle }),
        now: this.now(),
      })
    } catch (error) {
      // A health write must never turn into an unhandled rejection while the
      // host is shutting down (store already closed): log and move on.
      this.deps.logger.warn(`dsh-quno: collector health write failed: ${(error as Error).message}`)
      return
    }
    this.deps.onChange?.()
  }

  /** Start every enabled persisted instance (plugin boot). */
  startAll(): void {
    for (const instance of this.deps.store.listCollectorInstances(this.deps.qunoId)) {
      if (instance.desiredState === 'enabled') {
        this.ensureMount(instance)
        this.arm(instance.id, this.now())
      }
    }
  }

  /** Stop every run, timer and mount (plugin unload). Idempotent. */
  async stopAll(): Promise<void> {
    const entries = [...this.runtimes.entries()]
    await Promise.all(entries.map(async ([instanceId]) => {
      this.clearTimer(instanceId)
      const rt = this.runtimes.get(instanceId)
      const run = rt?.run
      if (rt !== undefined && run !== undefined) {
        run.controller.abort(new Error('plugin unloading'))
        await run.promise.catch(() => {})
        if (rt.run === run) rt.run = undefined
      }
      this.disposeMount(instanceId)
      try {
        this.deps.store.updateCollectorInstance(instanceId, { lifecycle: 'stopped', now: this.now() })
      } catch {
        // removed
      }
    }))
  }

  /** Health snapshot for the UI, including computed staleness and gaps. */
  healthSnapshot(): {
    readonly types: CollectorTypeView[]
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
  definitionOf(type: string): CollectorDefinition | undefined {
    return this.types.get(type)?.definition
  }

  /** The Quno row (persona/instructions) for prompt assembly. */
  quno(): QunoRecord | undefined {
    return this.deps.store.getQuno(this.deps.qunoId)
  }
}

/** Add a computed `stale` flag based on the instance's own freshness threshold. */
function withStaleness(
  instance: CollectorInstanceRecord,
  definition: CollectorDefinition,
  now: number,
): CollectorInstanceRecord & { readonly stale: boolean } {
  const thresholdSec = typeof instance.config['freshnessThresholdSec'] === 'number'
    ? instance.config['freshnessThresholdSec'] as number
    : definition.schedule.defaultIntervalSec * 3
  const last = instance.lastSuccessAt
  return { ...instance, stale: last === null ? true : now - last > thresholdSec * 1000 }
}

/** Bound and sanitize discovered options; duplicate values keep their first entry. */
function sanitizeOptions(options: readonly CollectorOption[], limit: number): CollectorOption[] {
  const seen = new Set<string>()
  const out: CollectorOption[] = []
  for (const option of options) {
    if (out.length >= limit) break
    if (typeof option.value !== 'string') continue
    const value = option.value.trim()
    if (value === '' || value.length > 400 || seen.has(value)) continue
    const label = typeof option.label === 'string' && option.label.trim() !== ''
      ? option.label.trim().slice(0, 300)
      : value
    seen.add(value)
    out.push({
      value,
      label,
      ...(typeof option.description === 'string' && option.description.trim() !== ''
        ? { description: option.description.trim().slice(0, 400) }
        : {}),
      ...(option.disabled === true ? { disabled: true } : {}),
      ...(typeof option.disabledReason === 'string' && option.disabledReason.trim() !== ''
        ? { disabledReason: option.disabledReason.trim().slice(0, 300) }
        : {}),
    })
  }
  return out
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${String(ms)}ms`)), ms)
        if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The service shape collector plugins consume through `ctx.get('qunoCollectors')`. */
export interface QunoCollectorsFace {
  register(definition: unknown, factory: CollectorFactory): () => Promise<void>
  hasType(type: string): boolean
}
