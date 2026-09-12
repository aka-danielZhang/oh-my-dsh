/**
 * dsh-scheduled-tasks, host half — the `scheduled-tasks-core` row.
 *
 * The `scheduledTasks` service owns three things (design §5, §8):
 *
 * 1. **User task CRUD** over the `dsh_scheduled_tasks` Storage Domain with
 *    revision-fenced mutations (no last-write-wins anywhere).
 * 2. **The global scheduler**: one one-shot timer armed to the earliest
 *    daily boundary across enabled tasks, a 12h bounded catch-up for the
 *    single most recent missed boundary, per-task cross-process leases,
 *    fenced commit intents for crash recovery, and an overlap policy that
 *    records `skipped` instead of ever double-running one task.
 * 3. **The managed-provider registry**: read-only system-task projections
 *    contributed by other plugins (dsh-ohmymemo's dream memory is the first).
 *    Providers are effect-owned: unregistering on fiber unwind, and one
 *    provider failing never degrades the user list.
 *
 * Every run is one ordinary root Session created through the webhook
 * transaction (./launch.ts); the scheduler only claims boundaries, launches,
 * and settles. Task instruction never enters logs, job labels, or error
 * details — only task ids, run ids, and classified errors.
 * @module dsh-scheduled-tasks
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import { validateScheduledTasksConfig, type ScheduledTasksConfig } from './config.ts'
import {
  LIMITS,
  resolveTimeZone,
  scheduleFromSpec,
  scheduleRule,
  scheduleSpecError,
  type CatalogSnapshot,
  type CreateTaskRequest,
  type ListSnapshot,
  type ManagedTaskRow,
  type ManagedTaskState,
  type RemoveTaskRequest,
  type DeleteRunRequest,
  type RunList,
  type ScheduleSpec,
  type SetEnabledRequest,
  type TaskIdRequest,
  type TaskActivity,
  type TaskRecord,
  type TaskRunAudit,
  type TaskRunSummary,
  type TaskRuntimeRecord,
  type TaskRow,
  type UpdateTaskRequest,
  type UserTaskRow,
} from './contract.ts'
import { scheduledTasksDomainSpec } from './domain.ts'
import { launchTaskSession, mintRunIds } from './launch.ts'
import { TaskLease, TaskLeaseBusyError } from './lease.ts'
import { dueCatchUpBoundary, nextBoundary, scheduleLabel } from './schedule.ts'

/** Cordis service name this row provides. */
export const SERVICE_NAME = 'scheduledTasks'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-scheduled-tasks'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Global scheduled-task registry and scheduler (this row). */
    scheduledTasks: ScheduledTasksService
  }
}

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'scheduled-task-run': 'scheduled-task-run'
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Programmatic input admitted by one scheduled-task boundary claim. */
    'scheduled-task': {
      readonly kind: 'scheduled-task'
      readonly taskId: string
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The id names a managed (system) task; mutations are refused. */
    'TASK_MANAGED_READ_ONLY': {}
    /** No user task carries this id. */
    'TASK_NOT_FOUND': {}
    /** Another writer advanced the task's revision; re-read and retry. */
    'TASK_REVISION_CONFLICT': {}
    /** The task has an active run; edit/delete stay refused until it ends. */
    'TASK_BUSY': {}
    /** The user-task table is at its cap. */
    'TASK_LIMIT_REACHED': {}
    'TASK_RUN_NOT_FOUND': {}
    /** Field-level validation refused the request. */
    'TASK_VALIDATION': {}
  }
}

/** Read-only system-task projection contributed by another plugin. */
export interface ManagedTaskProvider {
  /** Reverse-DNS style id, e.g. `system.ohmymemo.dream`. */
  id: string
  /** Stable list position among managed rows (smaller first). */
  order: number
  title: string
  instructionSummary: string
  sourceLabel: string
  capabilities: {
    editable: false
    pausable: false
    deletable: false
    runnable: false
  }
  /** Fresh state per query — never a cached second source of truth. */
  snapshot(signal: AbortSignal): Promise<ManagedTaskState>
}

/** Structural view of the query engine's lease reads (instance-agnostic). */
interface SessionQueryView {
  observeSession(sessionId: SessionId, options: {
    signal?: AbortSignal
    projectionMode: 'none'
  }): { events: ReadonlyArray<{ type?: unknown }>, [Symbol.dispose]: () => void }
}

/** Structural view of the sessions service actually used here. */
interface SessionsView {
  flush(session: unknown): Promise<void>
}

/** Default runtime row for a fresh task. */
function initialRuntime(taskId: string): TaskRuntimeRecord {
  return {
    version: 1,
    taskId,
    sessionId: null,
    activeRunId: null,
    activeJobId: null,
    activeSessionId: null,
    lastScheduledFor: null,
    nextRunAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    fence: 0,
    runCount: 0,
    lastResult: null,
  }
}

/** Project one task + runtime row onto the wire view. */
function userRowOf(task: TaskRecord, runtime: TaskRuntimeRecord, activity: TaskActivity): UserTaskRow {
  return {
    kind: 'user',
    id: task.id,
    revision: task.revision,
    title: task.title,
    instruction: task.instruction,
    schedule: task.schedule,
    enabled: task.enabled,
    execution: task.execution,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    activity,
    nextRunAt: task.enabled ? runtime.nextRunAt : null,
    lastAttemptAt: runtime.lastAttemptAt,
    lastSuccessAt: runtime.lastSuccessAt,
    lastResult: runtime.lastResult,
    runCount: runtime.runCount ?? 0,
    sessionId: runtime.sessionId ?? null,
  }
}

/** Classified error text: message only, bounded — no instruction content. */
function classify(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 200 ? `${text.slice(0, 199)}…` : text
}

/**
 * The `scheduledTasks` service: global user-task scheduler plus the managed
 * (system-task) projection registry. Typert Remote methods serve the
 * settings page; `registerManaged` serves other plugins.
 */
export class ScheduledTasksService extends TypertRemoteService {
  static inject = [
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'jobs',
    'llm',
    'permissionPresets',
    'sessionQuery',
    'sessionTitle',
    'sessions',
    'storageDomain',
    'timer',
    'workspaceRegistry',
  ]

  private readonly config: ScheduledTasksConfig
  private domain?: Domain<typeof scheduledTasksDomainSpec>
  private tasks?: KvTable<string, TaskRecord>
  private runtimeTable?: KvTable<string, TaskRuntimeRecord>
  private runsTable?: KvTable<string, TaskRunAudit>
  private readonly managed = new Map<string, ManagedTaskProvider>()
  private readonly leases = new Map<string, TaskLease>()
  private readonly locksRoot: string
  private timerDisposer?: () => void
  private activeRuns = 0
  private operationTail: Promise<void> = Promise.resolve()
  private accepting = true

  constructor(ctx: Context, rawConfig?: unknown) {
    super(ctx, SERVICE_NAME)
    this.config = validateScheduledTasksConfig(rawConfig)
    const envHome = process.env.DSH_HOME
    this.locksRoot = join(envHome !== undefined && envHome.length > 0 ? envHome : join(homedir(), '.dsh'), 'scheduled-tasks', 'locks')
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  protected async [Service.init](): Promise<void> {
    this.bindDomain(await this.ctx.storageDomain.open(scheduledTasksDomainSpec))
    this.ctx.effect(() => this.ctx.jobs.attachController(`${name}:runs`), `${name}: jobs controller`)
    this.ctx.effect(() => async () => {
      this.accepting = false
      this.clearTimer()
      // Drain in-flight mutations so durable writes land before the medium
      // closes; the storage facility closes still-open domains on unmount.
      await this.operationTail.catch(() => undefined)
      await this.refreshTail.catch(() => undefined)
      const old = this.domain
      this.domain = undefined
      this.tasks = undefined
      this.runtimeTable = undefined
      this.runsTable = undefined
      await old?.close()
    }, `${name}: drain and close domain`)
    await this.recoverAllInterrupted()
    await this.reconcile('startup')
  }

  private async bindDomain(domain: Domain<typeof scheduledTasksDomainSpec>): Promise<void> {
    this.domain = domain
    this.tasks = domain.table('tasks')
    this.runtimeTable = domain.table('runtime')
    this.runsTable = domain.table('runs')
  }

  /** Reopen the domain inside a lease so another host's writes are visible.
   *  Close first — the facility frees the name only when the old handle
   *  closes, so opening before closing throws `already-open`. Concurrent
   *  callers share one serialized refresh (the enqueue tail covers
   *  mutations; leases serialize the cross-process paths). */
  private refreshTail: Promise<void> = Promise.resolve()

  private refreshDomain(): Promise<void> {
    const run = this.refreshTail.catch(() => undefined).then(async () => {
      if (!this.accepting) return
      const old = this.domain
      this.domain = undefined
      this.tasks = undefined
      this.runtimeTable = undefined
      this.runsTable = undefined
      await old?.close()
      this.bindDomain(await this.ctx.storageDomain.open(scheduledTasksDomainSpec))
    })
    this.refreshTail = run
    return run
  }

  /** Serialize mutations through one tail so durable writes never interleave. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(fn, fn)
    this.operationTail = run.then(() => undefined, () => undefined)
    return run
  }

  private requireTasks(): KvTable<string, TaskRecord> {
    if (this.tasks === undefined) throw new Error(`${name}: task table is not ready`)
    return this.tasks
  }

  private requireRuntime(): KvTable<string, TaskRuntimeRecord> {
    if (this.runtimeTable === undefined) throw new Error(`${name}: runtime table is not ready`)
    return this.runtimeTable
  }

  private requireRuns(): KvTable<string, TaskRunAudit> {
    if (this.runsTable === undefined) throw new Error(`${name}: run table is not ready`)
    return this.runsTable
  }

  private leaseFor(taskId: string): TaskLease {
    let lease = this.leases.get(taskId)
    if (lease === undefined) {
      lease = new TaskLease(join(this.locksRoot, `${taskId}.lock`), {
        timeoutMs: this.config.leaseTimeoutMs,
      })
      this.leases.set(taskId, lease)
    }
    return lease
  }

  // ------------------------------------------------------------------
  // Managed-provider registry (read-only system tasks)
  // ------------------------------------------------------------------

  /**
   * Register one managed task projection. The returned disposer removes it —
   * register inside `ctx.effect` so provider rows come and go with their own
   * fibers. Unknown or failing providers degrade only their own row.
   */
  registerManaged(provider: ManagedTaskProvider): () => void {
    if (this.managed.has(provider.id)) {
      throw new Error(`${name}: managed task "${provider.id}" is already registered`)
    }
    this.managed.set(provider.id, provider)
    return () => {
      if (this.managed.get(provider.id) === provider) this.managed.delete(provider.id)
    }
  }

  private async managedRows(): Promise<ManagedTaskRow[]> {
    const providers = [...this.managed.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    return Promise.all(providers.map(async (provider): Promise<ManagedTaskRow> => {
      const observedAt = Date.now()
      try {
        const state = await provider.snapshot(AbortSignal.timeout(2_000))
        return {
          kind: 'managed',
          id: provider.id,
          order: provider.order,
          title: provider.title,
          instructionSummary: provider.instructionSummary,
          sourceLabel: provider.sourceLabel,
          schedule: state.schedule,
          scheduleState: state.scheduleState,
          activity: state.activity,
          lastAttemptAt: state.lastAttemptAt,
          lastSuccessAt: state.lastSuccessAt,
          nextRunAt: state.nextRunAt,
          detail: state.detail,
          observedAt,
        }
      } catch (error) {
        this.ctx.logger.warn(`scheduled-tasks: managed provider "${provider.id}" failed: ${classify(error)}`)
        return {
          kind: 'managed',
          id: provider.id,
          order: provider.order,
          title: provider.title,
          instructionSummary: provider.instructionSummary,
          sourceLabel: provider.sourceLabel,
          schedule: { kind: 'daily', localTime: '00:00', timeZone: 'UTC', timeZonePolicy: 'host-local' },
          scheduleState: 'paused',
          activity: 'unavailable',
          lastAttemptAt: null,
          lastSuccessAt: null,
          nextRunAt: null,
          detail: null,
          observedAt,
        }
      }
    }))
  }

  // ------------------------------------------------------------------
  // Remote: list / catalog
  // ------------------------------------------------------------------

  /** Unified snapshot: managed rows first, user tasks by `createdAt` ascending. */
  async list(): Promise<ListSnapshot> {
    await this.operationTail
    const tasks = this.requireTasks()
    const runtimeTable = this.requireRuntime()
    const records = [...tasks.entries()]
      .map(([, record]) => record)
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    const rows: TaskRow[] = []
    for (const record of records) {
      const runtime = runtimeTable.get(record.id) ?? initialRuntime(record.id)
      rows.push(userRowOf(record, runtime, this.userActivityOf(runtime)))
    }
    rows.push(...await this.managedRows())
    return { observedAt: Date.now(), tasks: rows }
  }

  /** Single-attempt activity projection (design §3): the schedule state
   *  (`enabled`) is separate; this is only what the current/last attempt did. */
  private userActivityOf(runtime: TaskRuntimeRecord): TaskActivity {
    if (runtime.activeRunId !== null) return 'running'
    if (runtime.lastResult !== null) return runtime.lastResult.status
    return 'idle'
  }

  /** Workspace / preset / permission / model options for the edit form. */
  async catalog(): Promise<CatalogSnapshot> {
    const workspaceRegistry = this.ctx.get('workspaceRegistry') as { list(): Array<{ path: string, title: string }> } | undefined
    const agentPresets = this.ctx.get('agentPresets') as {
      list(): Promise<Array<{ id: string, name?: string, broken?: string }>>
      get defaultId(): string
    } | undefined
    const permissionPresets = this.ctx.get('permissionPresets') as {
      get names(): readonly string[]
      get defaultPreset(): string
    } | undefined
    const agentDefaultModel = this.ctx.get('agentDefaultModel') as { currentSelection(): { provider: string, model: string, reasoningEffort?: string } } | undefined
    const llm = this.ctx.get('llm') as {
      listProviders(): Array<{ id: string, name: string }>
      listModels(provider: string): Promise<Array<{ id?: unknown, name?: unknown }>>
      resolveModelInfo(provider: string, model: string): Promise<{ reasoning?: { efforts?: Array<unknown>, defaultEffort?: unknown } } | null | undefined>
    } | undefined
    if (workspaceRegistry === undefined || agentPresets === undefined || permissionPresets === undefined || agentDefaultModel === undefined || llm === undefined) {
      throw new Error(`${name}: catalog services are not mounted`)
    }

    const defaultPreset = agentPresets.defaultId
    const presets = (await agentPresets.list())
      .filter(preset => preset.broken === undefined)
      .map(preset => ({ id: preset.id, name: preset.name ?? null, isDefault: preset.id === defaultPreset }))
      .sort((left, right) => left.id.localeCompare(right.id))

    const permissionDefault = permissionPresets.defaultPreset
    const permissions = [...permissionPresets.names]
      .map(preset => ({ name: preset, isDefault: preset === permissionDefault }))

    const selection = agentDefaultModel.currentSelection()
    const models: CatalogSnapshot['models'] = []
    let total = 0
    for (const provider of llm.listProviders()) {
      if (total >= 40) break
      let items: Array<{ id?: unknown, name?: unknown }>
      try {
        items = await llm.listModels(provider.id)
      } catch {
        continue
      }
      for (const item of items) {
        if (total >= 40) break
        if (typeof item.id !== 'string' || item.id.length === 0) continue
        let efforts: string[] = []
        let defaultEffort: string | undefined
        try {
          const info = await llm.resolveModelInfo(provider.id, item.id)
          const reasoning = info?.reasoning
          if (reasoning !== undefined) {
            const declared = reasoning.efforts
            if (Array.isArray(declared)) {
              // LlmReasoningEffortInfo is { id, name, description? }; plain
              // strings are tolerated for forward compatibility.
              efforts = declared
                .map(effort => typeof effort === 'string' ? effort : typeof (effort as { id?: unknown }).id === 'string' ? (effort as { id: string }).id : '')
                .filter(effort => effort !== '')
            }
            const declaredDefault = reasoning.defaultEffort
            if (typeof declaredDefault === 'string' && declaredDefault.length > 0) defaultEffort = declaredDefault
          }
        } catch {
          efforts = []
        }
        const displayName = typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id
        models.push({
          provider: provider.id,
          providerName: provider.name,
          model: item.id,
          name: displayName,
          ...defaultEffort === undefined ? {} : { defaultEffort },
          efforts,
        })
        total += 1
      }
    }

    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const suggested = [...new Set([
      hostZone,
      'UTC',
      'Asia/Shanghai',
      'Asia/Hong_Kong',
      'Asia/Tokyo',
      'Asia/Singapore',
      'Europe/London',
      'Europe/Berlin',
      'America/New_York',
      'America/Los_Angeles',
    ])]

    return {
      workspaces: workspaceRegistry.list().map(workspace => ({ path: workspace.path, title: workspace.title })),
      agentPresets: presets,
      permissionPresets: permissions,
      models,
      defaultSelection: {
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoningEffort ?? null,
      },
      defaultAgentPreset: defaultPreset,
      defaultPermissionPreset: permissionDefault,
      timeZone: hostZone,
      suggestedTimeZones: suggested,
    }
  }

  // ------------------------------------------------------------------
  // Remote: create / update / setEnabled / remove
  // ------------------------------------------------------------------

  /** Create one user task; the IANA zone is pinned here (design §6). */
  async create(request: CreateTaskRequest): Promise<UserTaskRow> {
    return this.enqueue(async () => {
      const tasks = this.requireTasks()
      if (tasks.size >= LIMITS.maxTasks) {
        throw new RemoteError('TASK_LIMIT_REACHED', `scheduled tasks are capped at ${LIMITS.maxTasks}`, {})
      }
      const validated = this.validateFields(request.title, request.instruction, request.schedule, request.timeZone, request.workspacePath)
      await this.verifyExecution(request.agentPreset, request.permissionPreset, request.model)

      const now = Date.now()
      const id = `task-${randomUUID()}`
      const schedule = scheduleFromSpec(request.schedule, validated.timeZone)
      const record: TaskRecord = {
        version: 1,
        id,
        revision: 1,
        owner: 'user',
        title: validated.title,
        instruction: validated.instruction,
        schedule,
        enabled: request.enabled,
        execution: {
          workspacePath: request.workspacePath,
          agentPreset: request.agentPreset,
          permissionPreset: request.permissionPreset,
          model: request.model === null ? null : { ...request.model },
        },
        createdAt: now,
        updatedAt: now,
      }
      await tasks.put(id, record)
      const runtime = initialRuntime(id)
      runtime.nextRunAt = record.enabled ? nextBoundary(now, scheduleRule(schedule), schedule.timeZone) : null
      await this.requireRuntime().put(id, runtime)
      void this.reconcile('config').catch(error => this.ctx.logger.warn(`scheduled-tasks: reconcile after create failed: ${classify(error)}`))
      return userRowOf(record, runtime, 'idle')
    })
  }

  /** Full-snapshot update under a revision fence; refused mid-run. */
  async update(request: UpdateTaskRequest): Promise<UserTaskRow> {
    return this.enqueue(async () => {
      this.refuseManaged(request.id)
      const tasks = this.requireTasks()
      const existing = tasks.get(request.id)
      if (existing === undefined) throw new RemoteError('TASK_NOT_FOUND', `no scheduled task "${request.id}"`, {})
      if (existing.revision !== request.ifRevision) {
        throw new RemoteError('TASK_REVISION_CONFLICT', `task "${request.id}" changed elsewhere (revision ${existing.revision})`, {})
      }
      const runtime = this.requireRuntime().get(request.id) ?? initialRuntime(request.id)
      if (runtime.activeRunId !== null) {
        throw new RemoteError('TASK_BUSY', 'the task is executing; edit after the current run ends', {})
      }
      if (request.workspacePath !== existing.execution.workspacePath) {
        throw new RemoteError('TASK_VALIDATION', 'the workspace is bound to the task session and cannot change after creation', {})
      }
      const validated = this.validateFields(request.title, request.instruction, request.schedule, request.timeZone ?? existing.schedule.timeZone, request.workspacePath)
      await this.verifyExecution(request.agentPreset, request.permissionPreset, request.model)

      const schedule = scheduleFromSpec(request.schedule, validated.timeZone)
      const next: TaskRecord = {
        ...existing,
        title: validated.title,
        instruction: validated.instruction,
        schedule,
        enabled: request.enabled,
        execution: {
          workspacePath: request.workspacePath,
          agentPreset: request.agentPreset,
          permissionPreset: request.permissionPreset,
          model: request.model === null ? null : { ...request.model },
        },
        revision: existing.revision + 1,
        updatedAt: Date.now(),
      }
      await tasks.put(request.id, next)
      const runtimeNext: TaskRuntimeRecord = {
        ...runtime,
        nextRunAt: next.enabled ? nextBoundary(Date.now(), scheduleRule(schedule), schedule.timeZone) : null,
      }
      await this.requireRuntime().put(request.id, runtimeNext)
      void this.reconcile('config').catch(error => this.ctx.logger.warn(`scheduled-tasks: reconcile after update failed: ${classify(error)}`))
      return userRowOf(next, runtimeNext, 'idle')
    })
  }

  /** Row-level run/pause under a revision fence. Pausing never interrupts a
   *  run already in flight (design §3). */
  async setEnabled(request: SetEnabledRequest): Promise<UserTaskRow> {
    return this.enqueue(async () => {
      this.refuseManaged(request.id)
      const tasks = this.requireTasks()
      const existing = tasks.get(request.id)
      if (existing === undefined) throw new RemoteError('TASK_NOT_FOUND', `no scheduled task "${request.id}"`, {})
      if (existing.revision !== request.ifRevision) {
        throw new RemoteError('TASK_REVISION_CONFLICT', `task "${request.id}" changed elsewhere (revision ${existing.revision})`, {})
      }
      const next: TaskRecord = {
        ...existing,
        enabled: request.enabled,
        revision: existing.revision + 1,
        updatedAt: Date.now(),
      }
      await tasks.put(request.id, next)
      const runtimeTable = this.requireRuntime()
      const runtime = runtimeTable.get(request.id) ?? initialRuntime(request.id)
      const runtimeNext: TaskRuntimeRecord = {
        ...runtime,
        nextRunAt: next.enabled ? nextBoundary(Date.now(), scheduleRule(next.schedule), next.schedule.timeZone) : null,
      }
      await runtimeTable.put(request.id, runtimeNext)
      void this.reconcile('config').catch(error => this.ctx.logger.warn(`scheduled-tasks: reconcile after toggle failed: ${classify(error)}`))
      return userRowOf(next, runtimeNext, this.userActivityOf(runtimeNext))
    })
  }

  /** Delete the definition and its future schedule; run audits persist.
   *  Refused while a run is active (design §9). The wire method is
   *  `deleteTask`: `remove` collides with the client namespace service's
   *  own uninstall method (RemoteNamespaceService.remove). */
  async deleteTask(request: RemoveTaskRequest): Promise<{ removed: true }> {
    return this.enqueue(async () => {
      this.refuseManaged(request.id)
      const tasks = this.requireTasks()
      const existing = tasks.get(request.id)
      if (existing === undefined) throw new RemoteError('TASK_NOT_FOUND', `no scheduled task "${request.id}"`, {})
      if (existing.revision !== request.ifRevision) {
        throw new RemoteError('TASK_REVISION_CONFLICT', `task "${request.id}" changed elsewhere (revision ${existing.revision})`, {})
      }
      const runtime = this.requireRuntime().get(request.id) ?? initialRuntime(request.id)
      if (runtime.activeRunId !== null) {
        throw new RemoteError('TASK_BUSY', 'the task is executing; delete after the current run ends', {})
      }
      await tasks.delete(request.id)
      await this.requireRuntime().delete(request.id)
      this.leases.delete(request.id)
      void this.reconcile('config').catch(error => this.ctx.logger.warn(`scheduled-tasks: reconcile after remove failed: ${classify(error)}`))
      return { removed: true as const }
    })
  }

  /** Run one task immediately (`manual` trigger). Allowed on paused tasks —
   *  the explicit click is the intent — refused while a run is active, and it
   *  never touches the schedule cursor the boundary walker owns. The claim
   *  itself is fired without awaiting: the mutation queue must not be held for
   *  the duration of an agent run (same posture as the scheduler's own
   *  fire-and-forget). */
  async runNow(request: TaskIdRequest): Promise<UserTaskRow> {
    return this.enqueue(async () => {
      this.refuseManaged(request.id)
      await this.refreshDomain()
      const task = this.requireTasks().get(request.id)
      if (task === undefined) throw new RemoteError('TASK_NOT_FOUND', `no scheduled task "${request.id}"`, {})
      const runtime = this.requireRuntime().get(request.id) ?? initialRuntime(request.id)
      if (runtime.activeRunId !== null) {
        throw new RemoteError('TASK_BUSY', 'the task is executing; it cannot run again until the current run settles', {})
      }
      void this.claimAndRun({ task, boundary: Date.now(), trigger: 'manual' })
        .catch(error => this.ctx.logger.warn(`scheduled-tasks: manual run of task "${task.id}" failed: ${classify(error)}`))
      return userRowOf(task, runtime, this.userActivityOf(runtime))
    })
  }

  /** Run history of one task, latest first and bounded (design §9 历史页). */
  async listRuns(request: TaskIdRequest): Promise<RunList> {
    return this.enqueue(async () => {
      this.refuseManaged(request.id)
      await this.refreshDomain()
      if (this.requireTasks().get(request.id) === undefined) {
        throw new RemoteError('TASK_NOT_FOUND', `no scheduled task "${request.id}"`, {})
      }
      const runs = [...this.requireRuns().entries()]
        .filter(([, audit]) => audit.taskId === request.id)
        .sort((left, right) => right[1].scheduledFor - left[1].scheduledFor
          || right[1].startedAt - left[1].startedAt
          || right[0].localeCompare(left[0]))
        .slice(0, LIMITS.maxRunHistory)
        .map(([, audit]) => ({
          runId: audit.runId,
          trigger: audit.trigger,
          scheduledFor: audit.scheduledFor,
          startedAt: audit.startedAt,
          finishedAt: audit.finishedAt,
          status: audit.status,
          durationMs: audit.finishedAt === null ? null : Math.max(0, audit.finishedAt - audit.startedAt),
        }))
      return { runs }
    })
  }

  /** Remove one history row; the active run's row cannot be removed. */
  async deleteRun(request: DeleteRunRequest): Promise<{ removed: true }> {
    return this.enqueue(async () => {
      this.refuseManaged(request.id)
      await this.refreshDomain()
      if (this.requireTasks().get(request.id) === undefined) {
        throw new RemoteError('TASK_NOT_FOUND', `no scheduled task "${request.id}"`, {})
      }
      const runtime = this.requireRuntime().get(request.id)
      if (runtime?.activeRunId === request.runId) {
        throw new RemoteError('TASK_BUSY', 'the run is executing; its record cannot be removed right now', {})
      }
      const runs = this.requireRuns()
      const audit = runs.get(request.runId)
      if (audit === undefined || audit.taskId !== request.id) {
        throw new RemoteError('TASK_RUN_NOT_FOUND', `no run "${request.runId}" on task "${request.id}"`, {})
      }
      await runs.delete(request.runId)
      return { removed: true as const }
    })
  }

  /** Managed ids never reach user-task mutations (Host-enforced, design §2.4). */
  private refuseManaged(id: string): void {
    if (this.managed.has(id) || id.startsWith('system.')) {
      throw new RemoteError('TASK_MANAGED_READ_ONLY', `"${id}" is a system task managed by its own plugin`, {})
    }
  }

  /** Shared field validation for create/update. */
  private validateFields(
    rawTitle: string,
    rawInstruction: string,
    schedule: ScheduleSpec,
    timeZoneCandidate: string | undefined,
    workspacePath: string,
  ): { title: string, instruction: string, timeZone: string } {
    const title = rawTitle.trim()
    const instruction = rawInstruction.trim()
    if (title.length < 1 || title.length > LIMITS.maxTitleChars) {
      throw new RemoteError('TASK_VALIDATION', `title must be 1..${LIMITS.maxTitleChars} characters`, {})
    }
    if (instruction.length < 1 || instruction.length > LIMITS.maxInstructionChars) {
      throw new RemoteError('TASK_VALIDATION', `instruction must be 1..${LIMITS.maxInstructionChars} characters`, {})
    }
    const scheduleError = scheduleSpecError(schedule)
    if (scheduleError !== null) {
      throw new RemoteError('TASK_VALIDATION', `invalid schedule: ${scheduleError}`, {})
    }
    if (!workspacePath.startsWith('/')) {
      throw new RemoteError('TASK_VALIDATION', 'workspacePath must be an absolute path', {})
    }
    try {
      return { title, instruction, timeZone: resolveTimeZone(timeZoneCandidate ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')) }
    } catch {
      throw new RemoteError('TASK_VALIDATION', `unknown IANA time zone ${JSON.stringify(timeZoneCandidate ?? '')}`, {})
    }
  }

  /** Fail early (and loudly) when a pinned preset pair or route is unusable. */
  private async verifyExecution(
    agentPreset: string,
    permissionPreset: string,
    model: { provider: string, model: string, reasoningEffort?: string } | null,
  ): Promise<void> {
    const permissionPresets = this.ctx.get('permissionPresets') as { resolve(name: string): unknown } | undefined
    const agentPresets = this.ctx.get('agentPresets') as { resolve(id?: string): Promise<unknown> } | undefined
    if (permissionPresets === undefined || agentPresets === undefined) {
      throw new Error(`${name}: preset services are not mounted`)
    }
    permissionPresets.resolve(permissionPreset)
    await agentPresets.resolve(agentPreset)
    if (model !== null) {
      const llm = this.ctx.get('llm') as { resolveCallConfig(config: { provider: string, model: string, reasoningEffort?: string }): Promise<unknown> } | undefined
      if (llm === undefined) throw new Error(`${name}: llm runtime is not mounted`)
      try {
        await llm.resolveCallConfig({
          provider: model.provider,
          model: model.model,
          ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
        })
      } catch (error) {
        throw new RemoteError('TASK_VALIDATION', `model route ${model.provider}/${model.model} is unavailable: ${classify(error)}`, {})
      }
    }
  }

  // ------------------------------------------------------------------
  // Scheduler: single timer, due collection, bounded concurrency
  // ------------------------------------------------------------------

  private async reconcile(reason: 'startup' | 'config' | 'wake'): Promise<void> {
    return this.enqueue(async () => {
      if (!this.accepting) return
      await this.refreshDomain()
      const now = Date.now()
      const tasks = this.requireTasks()
      const runtimeTable = this.requireRuntime()
      let earliest: number | null = null
      const due: Array<{ task: TaskRecord, boundary: number, trigger: 'scheduled' | 'catch-up' }> = []

      for (const [id, task] of [...tasks.entries()]) {
        const runtime = runtimeTable.get(id) ?? initialRuntime(id)
        const rule = scheduleRule(task.schedule)
        const nextAt = task.enabled
          ? nextBoundary(now, rule, task.schedule.timeZone)
          : null
        if (runtime.nextRunAt !== nextAt) {
          await runtimeTable.put(id, { ...runtime, nextRunAt: nextAt })
        }
        if (!task.enabled || nextAt === null) continue
        earliest = earliest === null ? nextAt : Math.min(earliest, nextAt)
        const boundary = dueCatchUpBoundary(
          now,
          rule,
          task.schedule.timeZone,
          runtime.lastScheduledFor,
          runtime.activeRunId !== null,
          this.config.catchUpWindowMs,
        )
        if (boundary !== undefined) {
          due.push({ task, boundary, trigger: reason === 'startup' ? 'catch-up' : 'scheduled' })
        }
      }

      // Stable order: boundary, then creation time, then id (design §8.2).
      due.sort((left, right) =>
        left.boundary - right.boundary
        || left.task.createdAt - right.task.createdAt
        || left.task.id.localeCompare(right.task.id))
      for (const item of due) {
        if (this.activeRuns >= this.config.maxConcurrentRuns) break
        this.activeRuns += 1
        void this.claimAndRun(item)
          .catch(error => this.ctx.logger.warn(`scheduled-tasks: task "${item.task.id}" claim failed: ${classify(error)}`))
          .finally(() => {
            this.activeRuns -= 1
            if (this.accepting) {
              void this.reconcile('wake').catch(error => this.ctx.logger.warn(`scheduled-tasks: post-run reconcile failed: ${classify(error)}`))
            }
          })
      }
      this.armTimer(earliest)
    })
  }

  private armTimer(nextAt: number | null): void {
    this.clearTimer()
    if (nextAt === null) return
    const delay = Math.max(1, nextAt - Date.now())
    this.timerDisposer = this.ctx.timer.timeout(() => {
      this.timerDisposer = undefined
      void this.reconcile('wake').catch(error => this.ctx.logger.warn(`scheduled-tasks: scheduled wake failed: ${classify(error)}`))
    }, delay)
  }

  private clearTimer(): void {
    this.timerDisposer?.()
    this.timerDisposer = undefined
  }

  // ------------------------------------------------------------------
  // Claim → launch → settle, all under the per-task lease
  // ------------------------------------------------------------------

  private async claimAndRun(item: { task: TaskRecord, boundary: number, trigger: 'scheduled' | 'catch-up' | 'manual' }): Promise<void> {
    const { task, boundary, trigger } = item
    const lease = this.leaseFor(task.id)
    try {
      await lease.withLock(async () => {
        if (!this.accepting) return
        await this.refreshDomain()
        // Under the lease the snapshot is fresh: re-check everything the
        // decision depends on (design §8.3). A manual run is an explicit user
        // intent: a paused task still runs, the schedule cursor stays untouched
        // (it belongs to the boundary walker), and an overlap warns instead of
        // writing a skipped audit row.
        const manual = trigger === 'manual'
        const fresh = this.requireTasks().get(task.id)
        if (fresh === undefined) return
        if (!manual && !fresh.enabled) return
        const runtime = this.requireRuntime().get(task.id) ?? initialRuntime(task.id)
        if (!manual && runtime.lastScheduledFor !== null && runtime.lastScheduledFor >= boundary) return
        if (runtime.activeRunId !== null) {
          if (manual) {
            this.ctx.logger.warn(`scheduled-tasks: manual run of task "${task.id}" skipped; a run is already active`)
            return
          }
          await this.recordSkipped(task, runtime, boundary, trigger)
          return
        }

        const ids = mintRunIds()
        // One task owns ONE session: the id is bound at the first claim and
        // every later run submits into the same session.
        const sessionId = runtime.sessionId ?? ids.sessionId
        const fence = runtime.fence + 1
        const audit: TaskRunAudit = {
          version: 1,
          runId: ids.runId,
          taskId: task.id,
          definitionRevision: fresh.revision,
          trigger,
          scheduledFor: boundary,
          sessionId,
          fence,
          commitIntent: 'claimed',
          startedAt: Date.now(),
          finishedAt: null,
          status: 'claiming',
          detail: null,
        }
        await this.requireRuns().put(ids.runId, audit)
        await this.requireRuntime().put(task.id, {
          ...runtime,
          sessionId,
          activeRunId: ids.runId,
          activeSessionId: sessionId,
          lastScheduledFor: manual ? runtime.lastScheduledFor : boundary,
          lastAttemptAt: audit.startedAt,
          fence,
          runCount: (runtime.runCount ?? 0) + 1,
        })
        await this.runLifecycle(fresh, ids.runId, sessionId, fence)
      })
    } catch (error) {
      if (error instanceof TaskLeaseBusyError) {
        // Another host holds the task's lease and owns this boundary.
        this.ctx.logger.warn(`scheduled-tasks: task "${task.id}" lease busy; boundary left to the holder`)
        return
      }
      throw error
    }
  }

  /** Register the Job and drive one run to its settled outcome. */
  private async runLifecycle(
    task: TaskRecord,
    runId: string,
    sessionId: string,
    fence: number,
  ): Promise<void> {
    const abort = new AbortController()
    this.runAborts.set(runId, abort)
    const registered = Promise.withResolvers<void>()
    let done!: Promise<JobOutcome>
    try {
      // Job label carries the title only — never the instruction (design §10).
      const jobId = this.ctx.jobs.start({
        kind: 'scheduled-task-run',
        label: `定时任务「${task.title}」`,
        outputLimitBytes: 2048,
        run: () => {
          done = registered.promise.then(() => this.executeRun(task, runId, sessionId, fence, abort))
          return {
            cancel: (reason?: string) => abort.abort(new Error(reason ?? 'cancelled')),
            done,
          }
        },
      })
      await this.requireRuntime().put(task.id, {
        ...(this.requireRuntime().get(task.id) ?? initialRuntime(task.id)),
        activeJobId: String(jobId),
      })
      registered.resolve()
    } catch (error) {
      registered.resolve()
      this.runAborts.delete(runId)
      await this.settleRun(task.id, runId, fence, 'error', `job registration failed: ${classify(error)}`)
      return
    }
    try {
      await done
    } finally {
      this.runAborts.delete(runId)
    }
  }

  private readonly runAborts = new Map<string, AbortController>()

  /** Submit the run into the task's bound session and wait for it to settle.
   *  First run creates the session; later runs reattach or resume it. */
  private async executeRun(
    task: TaskRecord,
    runId: string,
    sessionId: string,
    fence: number,
    abort: AbortController,
  ): Promise<JobOutcome> {
    const runTimeout = AbortSignal.timeout(this.config.runTimeoutMs)
    const signal = AbortSignal.any([abort.signal, runTimeout])
    let ownedHandle: import('./launch.ts').TaskLaunchHandle['ownedHandle'] = null
    try {
      signal.throwIfAborted()
      const launch = await launchTaskSession(this.ctx, {
        taskId: task.id,
        runId,
        sessionId,
        title: `[定时] ${task.title} · ${scheduleLabel(scheduleRule(task.schedule))}`,
        instruction: task.instruction,
        workspacePath: task.execution.workspacePath,
        agentPreset: task.execution.agentPreset,
        permissionPreset: task.execution.permissionPreset,
        model: task.execution.model,
      }, signal)
      ownedHandle = launch.ownedHandle
      // Fence the session-created intent before anything else observes a
      // half-launched run (design §8.3).
      await this.markSessionCreated(runId, fence, String(launch.sessionId))
      await this.requireRuntime().put(task.id, {
        ...(this.requireRuntime().get(task.id) ?? initialRuntime(task.id)),
        activeSessionId: String(launch.sessionId),
      })

      let outcome: 'success' | 'error' = 'error'
      let detail: string | null = null
      try {
        await launch.agent.whenIdle()
        const sessions = this.ctx.get('sessions') as SessionsView | undefined
        if (sessions !== undefined) await sessions.flush(launch.agent.session)
        outcome = await this.judgeSessionOutcome(String(launch.sessionId))
      } catch (error) {
        detail = classify(error)
        outcome = 'error'
      }
      // Cancellation wins over a rough session outcome; run-timeout expiry is
      // an error, a plugin stop / job kill is a cancellation (design §3).
      const status: 'success' | 'error' | 'cancelled' = abort.signal.aborted
        ? 'cancelled'
        : runTimeout.aborted
          ? 'error'
          : outcome
      if (status === 'error' && detail === null) detail = 'session ended without a reply'
      await this.settleRun(task.id, runId, fence, status, detail)
      return {
        status: status === 'success' ? 'completed' : status === 'cancelled' ? 'killed' : 'failed',
        detail: detail ?? undefined,
      }
    } catch (error) {
      const status = abort.signal.aborted ? 'cancelled' : 'error'
      await this.settleRun(task.id, runId, fence, status, classify(error))
      return { status: status === 'cancelled' ? 'killed' : 'failed', detail: classify(error) }
    } finally {
      // A created/resumed handle belongs to this run; a live reattach never
      // disposes an agent another holder owns.
      if (ownedHandle !== null) {
        try {
          await ownedHandle.dispose()
        } catch (disposeError) {
          this.ctx.logger.warn(`scheduled-tasks: session dispose after run failed: ${classify(disposeError)}`)
        }
      }
    }
  }

  /** Whether the run's session finished its turn with an assistant reply. */
  private async judgeSessionOutcome(sessionId: string): Promise<'success' | 'error'> {
    const query = this.ctx.get('sessionQuery') as SessionQueryView | undefined
    if (query === undefined) return 'success' // cannot observe — assume admitted
    const observation = query.observeSession(sessionId as SessionId, { projectionMode: 'none', signal: AbortSignal.timeout(1_500) })
    try {
      const events = observation.events
      for (let index = events.length - 1; index >= 0; index--) {
        const type = events[index]?.type
        if (type === 'assistant/message') return 'success'
        if (type === 'user/message') break
      }
      return events.length === 0 ? 'error' : 'success'
    } finally {
      observation[Symbol.dispose]()
    }
  }

  // ------------------------------------------------------------------
  // Fenced terminal writes and crash recovery
  // ------------------------------------------------------------------

  /** Persist the session-created intent under the claim's fence. */
  private async markSessionCreated(runId: string, fence: number, sessionId: string): Promise<void> {
    const runs = this.requireRuns()
    const audit = runs.get(runId)
    if (audit === undefined || audit.fence !== fence || audit.commitIntent !== 'claimed') return
    await runs.put(runId, { ...audit, commitIntent: 'session-created', sessionId, status: 'running' })
  }

  /** Overlap policy: one bounded `skipped` audit, cursor advanced (§8.3). */
  private async recordSkipped(
    task: TaskRecord,
    runtime: TaskRuntimeRecord,
    boundary: number,
    trigger: 'scheduled' | 'catch-up',
  ): Promise<void> {
    const runId = `skip-${randomUUID()}`
    const now = Date.now()
    await this.requireRuns().put(runId, {
      version: 1,
      runId,
      taskId: task.id,
      definitionRevision: task.revision,
      trigger,
      scheduledFor: boundary,
      sessionId: null,
      fence: runtime.fence,
      commitIntent: 'terminal',
      startedAt: now,
      finishedAt: now,
      status: 'skipped',
      detail: 'previous run still active; boundary not queued',
    })
    await this.requireRuntime().put(task.id, {
      ...runtime,
      lastScheduledFor: boundary,
      lastResult: { runId, trigger, finishedAt: now, status: 'skipped', detail: '上一轮仍在执行，本次到点跳过' },
    })
  }

  /**
   * Fenced terminal settlement: write the terminal intent first, then roll
   * the outcome forward into runtime. Recovery replays the roll-forward
   * idempotently; stale fences are dropped.
   */
  private async settleRun(
    taskId: string,
    runId: string,
    fence: number,
    status: 'success' | 'error' | 'cancelled',
    detail: string | null,
  ): Promise<void> {
    try {
      await this.leaseFor(taskId).withLock(async () => {
        await this.refreshDomain()
        const runs = this.requireRuns()
        const audit = runs.get(runId)
        if (audit === undefined) return
        if (audit.fence !== fence) return // stale writer
        if (audit.commitIntent === 'terminal' && audit.status !== 'claiming' && audit.status !== 'running') return // already settled
        const finishedAt = Date.now()
        const summary: TaskRunSummary = { runId, trigger: audit.trigger, finishedAt, status, detail }
        await runs.put(runId, { ...audit, commitIntent: 'terminal', status, finishedAt, detail })
        const runtimeTable = this.requireRuntime()
        const runtime = runtimeTable.get(taskId) ?? initialRuntime(taskId)
        if (runtime.activeRunId !== null && runtime.activeRunId !== runId && runtime.fence > fence) return
        await runtimeTable.put(taskId, {
          ...runtime,
          activeRunId: null,
          activeJobId: null,
          activeSessionId: null,
          lastResult: summary,
          lastSuccessAt: status === 'success' ? finishedAt : runtime.lastSuccessAt,
          fence,
        })
      })
    } catch (error) {
      if (error instanceof TaskLeaseBusyError) {
        // Settling with the lease held is fine: recovery finishes it later.
        this.ctx.logger.warn(`scheduled-tasks: settle lease busy for "${taskId}"; recovery will finish it`)
        return
      }
      throw error
    }
  }

  /**
   * Recover runs interrupted by a dead process (design §12): claimed and
   * session-created orphans settle as interrupted errors — the boundary was
   * consumed and is never re-executed; terminal intents finish their
   * roll-forward idempotently.
   */
  private async recoverAllInterrupted(): Promise<void> {
    const runtimeTable = this.requireRuntime()
    const stale = [...runtimeTable.entries()].filter(([, runtime]) => runtime.activeRunId !== null)
    for (const [taskId] of stale) {
      try {
        await this.leaseFor(taskId).withLock(async () => {
          if (!this.accepting) return
          await this.refreshDomain()
          const runtime = this.requireRuntime().get(taskId)
          if (runtime === undefined || runtime.activeRunId === null) return // handled elsewhere
          const runId = runtime.activeRunId
          const audit = this.requireRuns().get(runId)
          if (audit === undefined) {
            await this.requireRuntime().put(taskId, {
              ...runtime,
              activeRunId: null,
              activeJobId: null,
              activeSessionId: null,
              lastResult: { runId, trigger: 'scheduled', finishedAt: Date.now(), status: 'error', detail: 'interrupted: run audit missing' },
            })
            return
          }
          if (audit.commitIntent === 'terminal') {
            await this.rollForward(audit)
            return
          }
          await this.settleInterrupted(taskId, audit)
        })
      } catch (error) {
        if (error instanceof TaskLeaseBusyError) continue // another host owns the recovery
        this.ctx.logger.warn(`scheduled-tasks: recovery for "${taskId}" failed: ${classify(error)}`)
      }
    }
  }

  /** Complete a terminal intent's unfinished roll-forward (idempotent). */
  private async rollForward(audit: TaskRunAudit): Promise<void> {
    if (audit.status === 'running' || audit.status === 'claiming') return // not terminal after all
    const runtimeTable = this.requireRuntime()
    const runtime = runtimeTable.get(audit.taskId) ?? initialRuntime(audit.taskId)
    if (runtime.activeRunId !== null && runtime.activeRunId !== audit.runId) return
    const summary: TaskRunSummary = {
      runId: audit.runId,
      trigger: audit.trigger,
      finishedAt: audit.finishedAt ?? audit.startedAt,
      status: audit.status === 'skipped' ? 'skipped' : audit.status,
      detail: audit.detail,
    }
    await runtimeTable.put(audit.taskId, {
      ...runtime,
      activeRunId: null,
      activeJobId: null,
      activeSessionId: null,
      lastResult: summary,
      lastSuccessAt: summary.status === 'success' ? summary.finishedAt : runtime.lastSuccessAt,
    })
  }

  /** Settle a claimed/session-created orphan as an interrupted error. */
  private async settleInterrupted(taskId: string, audit: TaskRunAudit): Promise<void> {
    const finishedAt = Date.now()
    const detail = audit.commitIntent === 'session-created'
      ? 'interrupted: the previous host ended while the session was running'
      : 'interrupted: the previous host ended before the session launched'
    await this.requireRuns().put(audit.runId, {
      ...audit,
      commitIntent: 'terminal',
      status: 'error',
      finishedAt,
      detail,
    })
    const runtimeTable = this.requireRuntime()
    const runtime = runtimeTable.get(taskId) ?? initialRuntime(taskId)
    await runtimeTable.put(taskId, {
      ...runtime,
      activeRunId: null,
      activeJobId: null,
      activeSessionId: null,
      lastResult: { runId: audit.runId, trigger: audit.trigger, finishedAt, status: 'error', detail },
    })
  }
}

export default ScheduledTasksService
