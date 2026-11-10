/**
 * Pure page-state derivations shared by the right panel's four views and the
 * detail pages. Everything here is a function of plain wire slices, so the
 * "which page do I show" decisions are covered by unit tests instead of being
 * re-derived (and mis-derived) inside components.
 *
 * The rule this module exists to enforce: an empty list, an unanswered
 * request and a failed request are three different states.
 *
 * @module dsh-quno/client/panel-state
 */

import type { QunoLocaleKey } from './locales.ts'

/** Shared visual tone vocabulary (maps onto theme state tokens). */
export type Tone = 'ok' | 'warn' | 'error' | 'idle'

// ─────────────────────────────────────────────────────────────────── tasks

/** Minimal task slice the grouping needs. */
export interface TaskLike {
  readonly status: string
}

/** The three task buckets the list renders; empty buckets are not rendered. */
export interface TaskGroups<T extends TaskLike> {
  readonly needsAction: readonly T[]
  readonly running: readonly T[]
  readonly settled: readonly T[]
}

/**
 * Split tasks into "needs action", "running" and "settled". `failed` and
 * `interrupted` are actionable (they can be resumed); `done` and `cancelled`
 * are settled. An unrecognised status stays visible in the tail instead of
 * silently disappearing, and its label reads 未知状态.
 * @param tasks - the wire task list.
 * @returns three buckets, each in wire order.
 */
export function groupTasks<T extends TaskLike>(tasks: readonly T[]): TaskGroups<T> {
  return {
    needsAction: tasks.filter(task => task.status === 'failed' || task.status === 'interrupted'),
    running: tasks.filter(task => task.status === 'running'),
    settled: tasks.filter(task => task.status === 'done' || task.status === 'cancelled' || !isKnownTaskStatus(task.status)),
  }
}

function isKnownTaskStatus(status: string): boolean {
  return status === 'running' || status === 'done' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
}

/** Locale key of one task status. */
export function taskStatusKey(status: string): QunoLocaleKey {
  switch (status) {
    case 'running': return 'taskStatusRunning'
    case 'done': return 'taskStatusDone'
    case 'failed': return 'taskStatusFailed'
    case 'interrupted': return 'taskStatusInterrupted'
    case 'cancelled': return 'taskStatusCancelled'
    default: return 'statusUnknown'
  }
}

/** Row tone of one task status. */
export function taskTone(status: string): Tone {
  switch (status) {
    case 'running': return 'ok'
    case 'done': return 'idle'
    case 'failed':
    case 'interrupted': return 'warn'
    case 'cancelled': return 'idle'
    default: return 'idle'
  }
}

/** Which detail sections belong to a task in a given status (and are present). */
export interface TaskSectionFlags {
  readonly plan: boolean
  readonly prompt: boolean
  readonly result: boolean
  readonly artifacts: boolean
  readonly error: boolean
  readonly child: boolean
  readonly resume: boolean
  readonly cancel: boolean
  readonly cancelledNote: boolean
}

/** Minimal task slice the section rules read. */
export interface TaskSectionInput {
  readonly status: string
  readonly plan: string | null
  readonly prompt: string | null
  readonly result: string | null
  readonly resultDigest: string | null
  readonly artifacts: readonly unknown[]
  readonly childSessionId: string | null
  readonly error: unknown | null
}

/**
 * Decide which task-detail sections exist. A section is shown only when the
 * task status calls for it AND the record actually has the content: an empty
 * heading above nothing is worse than no heading.
 * @param task - the wire task.
 * @returns one flag per section.
 */
export function taskSections(task: TaskSectionInput): TaskSectionFlags {
  const running = task.status === 'running'
  const done = task.status === 'done'
  const failed = task.status === 'failed'
  const interrupted = task.status === 'interrupted'
  const cancelled = task.status === 'cancelled'
  const hasResult = task.result !== null || task.resultDigest !== null
  return {
    plan: running && task.plan !== null && task.plan !== '',
    prompt: (running || failed || cancelled) && task.prompt !== null && task.prompt !== '',
    result: done && hasResult,
    artifacts: done && task.artifacts.length > 0,
    error: (failed || interrupted) && task.error !== null,
    child: (done || cancelled) && task.childSessionId !== null,
    resume: failed || interrupted,
    cancel: running || failed || interrupted,
    cancelledNote: cancelled,
  }
}

// ──────────────────────────────────────────────────────────────────── runs

/** Normalised run status: the wire enum is closed, but older rows may not be. */
export type RunStatusKind = 'running' | 'committed' | 'failed' | 'interrupted' | 'unknown'

/** Map one wire run status onto the UI vocabulary. */
export function runStatusKind(status: string): RunStatusKind {
  switch (status) {
    case 'claimed':
    case 'running':
    case 'prepared':
    case 'delivering':
    case 'waiting-decision': return 'running'
    case 'committed':
    case 'ended':
    case 'decided':
    case 'consumed': return 'committed'
    case 'failed': return 'failed'
    case 'interrupted':
    case 'unavailable':
    case 'expired': return 'interrupted'
    default: return 'unknown'
  }
}

/** Locale key of one run status (never the raw enum). */
export function runStatusKey(status: string): QunoLocaleKey {
  switch (runStatusKind(status)) {
    case 'running': return 'runStatusRunning'
    case 'committed': return 'runStatusCommitted'
    case 'failed': return 'runStatusFailed'
    case 'interrupted': return 'runStatusInterrupted'
    case 'unknown': return 'statusUnknown'
  }
}

/** Row tone of one run status. */
export function runTone(status: string): Tone {
  switch (runStatusKind(status)) {
    case 'running': return 'ok'
    case 'committed': return 'idle'
    case 'failed': return 'error'
    case 'interrupted': return 'warn'
    case 'unknown': return 'idle'
  }
}

/** Locale key of one run trigger; unknown triggers fall back to the raw value. */
export function runTriggerKey(trigger: string): QunoLocaleKey | undefined {
  switch (trigger) {
    case 'schedule': return 'runTriggerSchedule'
    case 'user': return 'runTriggerUser'
    case 'event': return 'runTriggerEvent'
    case 'timer': return 'runTriggerTimer'
    default: return undefined
  }
}

// ─────────────────────────────────────────────────────────────────── collectors

/** One source row's single, highest-priority state. */
export type CollectorRowState =
  | 'auth-required'
  | 'unavailable'
  | 'rate-limited'
  | 'degraded'
  | 'paused'
  | 'disabled'
  | 'starting'
  | 'stale'
  | 'syncing'
  | 'ok'

/** Minimal Collector slice the row state needs. */
export interface CollectorRowInput {
  readonly desiredState: string
  readonly lifecycle: string
  readonly health: string
  readonly stale: boolean
  readonly lastSuccessAt: number | null
}

/**
 * Collapse the three health axes plus sync time into the one state a list row
 * shows, in the documented priority order: auth/unavailable, then
 * rate-limited/degraded, then paused/disabled, then starting, then stale, then
 * "never synced", then healthy.
 * @param instance - the wire instance slice.
 * @returns the single row state.
 */
export function collectorRowState(instance: CollectorRowInput): CollectorRowState {
  if (instance.health === 'auth-required' || instance.health === 'unavailable') return instance.health
  if (instance.health === 'rate-limited' || instance.health === 'degraded') return instance.health
  if (instance.desiredState === 'paused') return 'paused'
  if (instance.desiredState === 'disabled') return 'disabled'
  if (instance.lifecycle === 'starting') return 'starting'
  if (instance.stale) return 'stale'
  if (instance.lastSuccessAt === null) return 'syncing'
  return 'ok'
}

/**
 * Locale key of one runtime lifecycle value (`idle` is the resting state
 * between two Host-scheduled runs); null for a value this client predates.
 */
export function lifecycleKey(lifecycle: string): QunoLocaleKey | null {
  switch (lifecycle) {
    case 'idle': return 'lifecycleIdle'
    case 'starting': return 'lifecycleStarting'
    case 'running': return 'lifecycleRunning'
    case 'stopping': return 'lifecycleStopping'
    case 'stopped': return 'lifecycleStopped'
    case 'failed': return 'lifecycleFailed'
    default: return null
  }
}

/** Locale key of one row state. */
export function collectorRowKey(state: CollectorRowState): QunoLocaleKey {
  switch (state) {
    case 'auth-required': return 'panelCollectorAuthRequired'
    case 'unavailable': return 'panelCollectorUnavailable'
    case 'rate-limited': return 'panelCollectorRateLimited'
    case 'degraded': return 'panelCollectorDegraded'
    case 'paused': return 'panelCollectorPaused'
    case 'disabled': return 'panelCollectorDisabled'
    case 'starting': return 'panelCollectorStarting'
    case 'stale': return 'panelCollectorStale'
    case 'syncing': return 'panelCollectorSyncing'
    case 'ok': return 'panelCollectorHealthy'
  }
}

/** Row tone of one row state. */
export function collectorRowTone(state: CollectorRowState): Tone {
  switch (state) {
    case 'auth-required':
    case 'unavailable': return 'error'
    case 'rate-limited':
    case 'degraded':
    case 'stale': return 'warn'
    case 'paused':
    case 'disabled':
    case 'starting':
    case 'syncing': return 'idle'
    case 'ok': return 'ok'
  }
}

/** Page-level state of the 动态 tab. */
export type CollectorPageState =
  | 'loading'
  | 'load-failed'
  | 'install-guide'
  | 'first-connect'
  | 'all-paused'
  | 'syncing'
  | 'empty'
  | 'list'

/** Inputs of the 动态 page-state decision. */
export interface CollectorPageInput {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly hasState: boolean
  readonly instanceCount: number
  readonly typeCount: number
  /** Instances whose desired state is `enabled` (the only ones that collect). */
  readonly enabledCount: number
  /** Enabled instances that never completed a sync (first sync in flight). */
  readonly awaitingFirstSync: number
  readonly eventCount: number
  /** Freshness of the recent-events list; an unread list is not an empty one. */
  readonly eventsStatus: 'loading' | 'ready' | 'error'
}

/**
 * Decide which 动态 page body renders. Ordering matters: a first-sync page is
 * never allowed to claim "nothing new", and a failed load is never allowed to
 * look like an empty install.
 * @param input - the state slices.
 * @returns the page discriminator.
 */
export function collectorPageState(input: CollectorPageInput): CollectorPageState {
  if (!input.hasState) return input.phase === 'error' ? 'load-failed' : 'loading'
  if (input.instanceCount === 0) return input.typeCount === 0 ? 'install-guide' : 'first-connect'
  if (input.enabledCount === 0) return 'all-paused'
  if (input.eventCount === 0 && input.awaitingFirstSync > 0) return 'syncing'
  if (input.eventCount === 0 && input.eventsStatus === 'ready') return 'empty'
  return 'list'
}

/** Whether a source's Collector declared that the original payload stays readable. */
export function sourceReadsOriginal(
  state: {
    readonly sources: readonly { readonly id: string; readonly type: string }[]
    readonly collectorTypes: readonly { readonly type: string; readonly reliability: { readonly readOriginal: boolean } | null }[]
  },
  sourceId: string | undefined,
): boolean {
  if (sourceId === undefined) return false
  const source = state.sources.find(candidate => candidate.id === sourceId)
  if (source === undefined) return false
  const type = state.collectorTypes.find(candidate => candidate.type === source.type)
  return type?.reliability?.readOriginal === true
}

/** Minimal slices needed to turn wire ids into human names. */
export interface NameLookupState {
  readonly sources: readonly { readonly id: string; readonly instanceId: string; readonly type: string }[]
  readonly collectors: readonly { readonly id: string; readonly label: string; readonly type: string }[]
  readonly collectorTypes: readonly { readonly type: string; readonly displayName: string }[]
}

/**
 * The readable name of one source: the instance's own label, else the type's
 * declared display name, else the raw type. Undefined only when the source is
 * gone, so callers can omit the line instead of printing an id.
 * @param state - snapshot slices.
 * @param sourceId - the source id from an event or gap.
 * @returns a human label, or undefined.
 */
export function sourceDisplayName(state: NameLookupState, sourceId: string | undefined): string | undefined {
  if (sourceId === undefined) return undefined
  const source = state.sources.find(candidate => candidate.id === sourceId)
  if (source === undefined) return undefined
  const instance = state.collectors.find(candidate => candidate.id === source.instanceId)
  if (instance !== undefined && instance.label !== '') return instance.label
  const type = state.collectorTypes.find(candidate => candidate.type === source.type)
  return type?.displayName ?? source.type
}

/** The readable name of one Collector instance, falling back to its type. */
export function instanceDisplayName(state: NameLookupState, instanceId: string | undefined): string | undefined {
  if (instanceId === undefined) return undefined
  const instance = state.collectors.find(candidate => candidate.id === instanceId)
  if (instance === undefined) return undefined
  if (instance.label !== '') return instance.label
  return state.collectorTypes.find(candidate => candidate.type === instance.type)?.displayName ?? instance.type
}

/** Delivery counts that deserve a callout on the 运行 page. */
export interface DeliveryAnomaly {
  readonly deadLetter: number
  readonly deferred: number
}

/** Read the two delivery states that are not "normal" out of the metrics. */
export function deliveryAnomaly(deliveries: Record<string, number>): DeliveryAnomaly {
  return {
    deadLetter: deliveries['dead-letter'] ?? 0,
    deferred: deliveries['deferred'] ?? 0,
  }
}

/** Elapsed time of one run; an unfinished run counts up to `now`. */
export function runDurationMs(run: { readonly startedAt: number; readonly finishedAt: number | null }, now: number): number {
  const end = run.finishedAt ?? now
  return Math.max(0, end - run.startedAt)
}

/**
 * The duration to display: a settled run that never recorded a finish time has
 * no honest duration, so it reports `null` instead of counting up forever.
 * @param run - status plus the two timestamps.
 * @param now - current epoch ms.
 * @returns elapsed ms, or null when unknown.
 */
export function runDurationOf(
  run: { readonly status: string; readonly startedAt: number; readonly finishedAt: number | null },
  now: number,
): number | null {
  if (run.finishedAt === null && runStatusKind(run.status) !== 'running') return null
  return runDurationMs(run, now)
}

/** The honest lifecycle of a freshly created instance. */
export type CreationPhase = 'starting' | 'auth-required' | 'syncing' | 'ready' | 'failed'

/**
 * Report what a newly created instance is actually doing. Creation success is
 * never reported as sync success: the wizard shows the real first-sync state.
 * @param instance - the wire slice for the new instance.
 * @returns the phase the wizard renders.
 */
export function creationPhase(instance: {
  readonly lifecycle: string
  readonly health: string
  readonly lastSuccessAt: number | null
}): CreationPhase {
  if (instance.lifecycle === 'failed') return 'failed'
  if (instance.health === 'auth-required') return 'auth-required'
  if (instance.lifecycle === 'starting') return 'starting'
  if (instance.lastSuccessAt === null) return 'syncing'
  return 'ready'
}

// ───────────────────────────────────────────────────────────────── attention

/** Locale key of one attention status. */
export function attentionStatusKey(status: string): QunoLocaleKey {
  switch (status) {
    case 'open': return 'statusOpen'
    case 'waiting': return 'statusWaiting'
    case 'snoozed': return 'statusSnoozed'
    case 'resolved': return 'statusResolved'
    case 'dismissed': return 'statusDismissed'
    case 'expired': return 'statusExpired'
    default: return 'statusUnknown'
  }
}

/** Whether an attention item still expects the user (or Quno) to act. */
export function isActiveAttention(item: { readonly status: string }): boolean {
  return item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed'
}

/** Chip tone of one attention status. */
export function attentionTone(status: string): 'open' | 'wait' | 'snooze' | 'done' | 'fail' {
  switch (status) {
    case 'open': return 'open'
    case 'waiting': return 'wait'
    case 'snoozed': return 'snooze'
    case 'resolved': return 'done'
    case 'expired': return 'fail'
    default: return 'wait'
  }
}
