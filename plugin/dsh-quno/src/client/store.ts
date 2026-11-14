/**
 * Browser-side Quno model: one polling snapshot store plus thin command
 * wrappers over the `quno` Remote namespace. Components never touch the
 * Remote directly; slot `inject` hands them this store.
 *
 * The snapshot separates three cache layers so a detail view never forces a
 * full 15s refresh: the polled `state`, on-demand `noticeDetails` for
 * historical reports, and bounded `eventDetails` for evidence drill-downs.
 * `probes` holds explicit probe results, which are deliberately NOT health.
 *
 * Async reads are values, not `T | undefined`: a pending read, a failed read
 * and a record the Host reported as `null` are three different facts, and the
 * panel must not collapse them into "no content".
 *
 * @module dsh-quno/client/store
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CheckNowResult,
  EnsureMainResult,
  EventDetailWire,
  EventWire,
  NoticeDetailWire,
  QunoWireState,
  CollectorOptionsPageWire,
  CollectorProbeWire,
  WorkerDetailWire,
} from '../api-types.ts'

/**
 * One asynchronous read.
 * - `loading`: the request is in flight (and no older value is being kept);
 * - `ready`: the Host returned a value;
 * - `missing`: the Host explicitly returned `null` — the record does not exist;
 * - `error`: the transport or the Host rejected the read.
 */
export type AsyncValue<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly message: string }

/** Freshness of the recent-events list, tracked apart from the polled state. */
export type EventsStatus = 'loading' | 'ready' | 'error'

/** Structural face of the mounted Remote namespace. */
export interface QunoRemoteFace {
  state(): Promise<RemoteResult<QunoWireState>>
  ensureMain(request: { cwd: string; workspaceId?: string }): Promise<RemoteResult<EnsureMainResult>>
  updateConfig(request: { patch: Record<string, unknown> }): Promise<RemoteResult<QunoWireState>>
  updateProfile(request: {
    name?: string
    persona?: string
    instructions?: string
    modelProvider?: string
    model?: string
    reasoningEffort?: string | null
  }): Promise<RemoteResult<QunoWireState>>
  actAttention(request: {
    itemId: string
    action: 'processed' | 'later' | 'dismiss' | 'resume' | 'clarify'
    expectedRevision?: number
    snoozeMinutes?: number
    note?: string
  }): Promise<RemoteResult<QunoWireState>>
  checkNow(): Promise<RemoteResult<CheckNowResult>>
  createCollector(request: {
    type: string
    label?: string
    config?: Record<string, unknown>
    desiredState?: 'enabled' | 'paused' | 'disabled'
  }): Promise<RemoteResult<QunoWireState>>
  collectorCommand(request: {
    instanceId: string
    action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
    label?: string
    config?: Record<string, unknown>
  }): Promise<RemoteResult<QunoWireState>>
  probeCollector(request: { instanceId: string }): Promise<RemoteResult<CollectorProbeWire>>
  collectorOptions(request: {
    type: string
    field: string
    config?: Record<string, unknown>
    page?: number
    limit?: number
  }): Promise<RemoteResult<CollectorOptionsPageWire>>
  noticeDetail(request: { notificationId: string }): Promise<RemoteResult<NoticeDetailWire | null>>
  eventDetail(request: { eventId: string }): Promise<RemoteResult<EventDetailWire | null>>
  taskCommand(request: { taskId: string; action: 'resume' | 'abandon' | 'cancel' | 'answer'; text?: string }): Promise<RemoteResult<QunoWireState>>
  workerDetail(request: { ticketId: string }): Promise<RemoteResult<WorkerDetailWire>>
  mute(request: { minutes?: number; until?: string; cancel?: boolean }): Promise<RemoteResult<QunoWireState>>
  eventsRecent(request: { limit?: number }): Promise<RemoteResult<{ events: EventWire[] }>>
}

/** Immutable snapshot consumed through `useSyncExternalStore`. */
export interface QunoSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly state: QunoWireState | null
  /** Recent Collector events (动态 view); a failed fetch keeps the previous list. */
  readonly events: readonly EventWire[]
  /** Whether `events` is current. `error` never rewrites the list to empty. */
  readonly eventsStatus: EventsStatus
  readonly eventsError: string | null
  /** Explicit probe results, keyed by instance id (never merged into health). */
  readonly probes: Readonly<Record<string, CollectorProbeWire>>
  /** Historical notices fetched on demand, keyed by notification id. */
  readonly noticeDetails: Readonly<Record<string, AsyncValue<NoticeDetailWire>>>
  /** Evidence payloads fetched on demand, keyed by event id. */
  readonly eventDetails: Readonly<Record<string, AsyncValue<EventDetailWire>>>
  /** Read-only execution-record pages, keyed by `${taskId}@${cursor ?? 'head'}`. */
  readonly error: string | null
  readonly busy: boolean
}

const INITIAL: QunoSnapshot = {
  phase: 'idle',
  state: null,
  events: [],
  eventsStatus: 'loading',
  eventsError: null,
  probes: {},
  noticeDetails: {},
  eventDetails: {},
  error: null,
  busy: false,
}

/** Bounded on-demand caches: history reads stay small and never grow forever. */
const DETAIL_CACHE_LIMIT = 40

/** Polling store + command surface. */
export class QunoClientStore {
  private snapshot: QunoSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false
  /** Per-record request order: a slow answer must never overwrite a newer one. */
  private readonly noticeSeq = new Map<string, number>()
  private readonly eventSeq = new Map<string, number>()

  constructor(private readonly remote: QunoRemoteFace) {}

  /** Stable snapshot accessor. */
  readonly getSnapshot = (): QunoSnapshot => this.snapshot

  /** Stable subscription. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Begin polling; returns the stop function. */
  start(intervalMs = 15_000): () => void {
    if (this.timer === undefined) {
      void this.refresh()
      this.timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void this.refresh()
      }, intervalMs)
      if (typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref()
    }
    return () => {
      if (this.timer !== undefined) clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Pull one fresh snapshot. The state and the recent-events list fail
   * independently: a failed state read keeps the previous state (and reports
   * `error` only while nothing was ever loaded), a failed events read keeps
   * the previous list and marks the list stale.
   */
  async refresh(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      await this.refreshState()
      await this.refreshEvents()
    } finally {
      this.polling = false
    }
  }

  /** Bind or create the main conversation and return its id. */
  async ensureMain(cwd: string, workspaceId?: string): Promise<string> {
    const value = await this.run(() => this.remote.ensureMain({ cwd, ...(workspaceId === undefined ? {} : { workspaceId }) }))
    return value.sessionId
  }

  /** Merge and persist a configuration patch. */
  async updateConfig(patch: Record<string, unknown>): Promise<void> {
    await this.run(() => this.remote.updateConfig({ patch }))
  }

  /** Persist identity/model fields. */
  async updateProfile(patch: {
    name?: string
    persona?: string
    instructions?: string
    modelProvider?: string
    model?: string
    reasoningEffort?: string | null
  }): Promise<void> {
    await this.run(() => this.remote.updateProfile(patch))
  }

  /** Submit one attention decision. */
  async actAttention(request: {
    itemId: string
    action: 'processed' | 'later' | 'dismiss' | 'resume' | 'clarify'
    expectedRevision?: number
    snoozeMinutes?: number
    note?: string
  }): Promise<void> {
    await this.run(() => this.remote.actAttention(request))
  }

  /** Force one model-free-gated check. */
  async checkNow(): Promise<CheckNowResult> {
    return await this.run(() => this.remote.checkNow())
  }

  /** Create one Collector instance. */
  async createCollector(request: {
    type: string
    label?: string
    config?: Record<string, unknown>
    desiredState?: 'enabled' | 'paused' | 'disabled'
  }): Promise<void> {
    await this.run(() => this.remote.createCollector(request))
  }

  /** Pause/resume/disable/remove/reconfigure one Collector instance. */
  async collectorCommand(request: {
    instanceId: string
    action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
    label?: string
    config?: Record<string, unknown>
  }): Promise<void> {
    await this.run(() => this.remote.collectorCommand(request))
  }

  /**
   * Run a real probe. The result is stored beside the polled snapshot and is
   * never written into the instance's health.
   */
  async probeCollector(instanceId: string): Promise<CollectorProbeWire> {
    const result = await this.call(() => this.remote.probeCollector({ instanceId }))
    this.set({
      ...this.snapshot,
      probes: { ...this.snapshot.probes, [instanceId]: result },
    })
    return result
  }

  /** Discover one field's options from the Collector implementation. */
  async listCollectorOptions(request: {
    type: string
    field: string
    config?: Record<string, unknown>
    page?: number
    limit?: number
  }): Promise<CollectorOptionsPageWire> {
    return await this.call(() => this.remote.collectorOptions(request))
  }

  /**
   * Read one notice (with its current linked items) on demand.
   * A cached `ready`/`loading`/`missing` answer is returned as-is; `error`
   * answers are retried, so an explicit retry action is meaningful.
   */
  async loadNoticeDetail(notificationId: string): Promise<AsyncValue<NoticeDetailWire>> {
    const cached = this.snapshot.noticeDetails[notificationId]
    if (cached !== undefined && cached.status !== 'error') return cached

    const seq = this.nextSeq(this.noticeSeq, notificationId)
    this.patchNotice(notificationId, { status: 'loading' })

    let next: AsyncValue<NoticeDetailWire>
    try {
      const result = await this.remote.noticeDetail({ notificationId })
      next = !result.ok
        ? { status: 'error', message: `${result.error.code}: ${result.error.message}` }
        : result.value === null
          ? { status: 'missing' }
          : { status: 'ready', data: result.value }
    } catch (error) {
      next = { status: 'error', message: (error as Error).message }
    }

    if (this.noticeSeq.get(notificationId) !== seq) {
      return this.snapshot.noticeDetails[notificationId] ?? { status: 'loading' }
    }
    this.patchNotice(notificationId, next)
    return next
  }

  /**
   * Read one event payload on demand. Same `AsyncValue` discipline as
   * {@link loadNoticeDetail}: `missing` only when the Host says `null`.
   */
  async loadEventDetail(eventId: string): Promise<AsyncValue<EventDetailWire>> {
    const cached = this.snapshot.eventDetails[eventId]
    if (cached !== undefined && cached.status !== 'error') return cached

    const seq = this.nextSeq(this.eventSeq, eventId)
    this.patchEvent(eventId, { status: 'loading' })

    let next: AsyncValue<EventDetailWire>
    try {
      const result = await this.remote.eventDetail({ eventId })
      next = !result.ok
        ? { status: 'error', message: `${result.error.code}: ${result.error.message}` }
        : result.value === null
          ? { status: 'missing' }
          : { status: 'ready', data: result.value }
    } catch (error) {
      next = { status: 'error', message: (error as Error).message }
    }

    if (this.eventSeq.get(eventId) !== seq) {
      return this.snapshot.eventDetails[eventId] ?? { status: 'loading' }
    }
    this.patchEvent(eventId, next)
    return next
  }

  /** Resume, abandon, cancel one task — or forward the user's answer into it. */
  async taskCommand(taskId: string, action: 'resume' | 'abandon' | 'cancel' | 'answer', text?: string): Promise<void> {
    await this.run(() => this.remote.taskCommand({ taskId, action, ...(text === undefined ? {} : { text }) }))
  }

  /**
   * One worker's inspect-opening facts (design v2 §9.3): a one-shot read, NOT
   * a polled projection — the Host resolves the executor session from the
   * ticket id at open time, so a stale snapshot can never send the client to
   * the wrong session.
   */
  workerDetail(ticketId: string): Promise<RemoteResult<WorkerDetailWire>> {
    return this.remote.workerDetail({ ticketId })
  }


  /** Short-term mute state. */
  async mute(request: { minutes?: number; until?: string; cancel?: boolean }): Promise<void> {
    await this.run(() => this.remote.mute(request))
  }

  /** Read the polled state; failures keep whatever was already loaded. */
  private async refreshState(): Promise<void> {
    if (this.snapshot.phase === 'idle') this.set({ ...this.snapshot, phase: 'loading' })
    try {
      const result = await this.remote.state()
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      this.set({ ...this.snapshot, phase: 'ready', state: result.value, error: null })
    } catch (error) {
      this.set({
        ...this.snapshot,
        phase: this.snapshot.state === null ? 'error' : 'ready',
        error: (error as Error).message,
      })
    }
  }

  /**
   * Read the recent-events summary independently of the polled state. The
   * status only degrades to `loading` on a first read: a background retry
   * never blanks a list the user is already reading.
   */
  private async refreshEvents(): Promise<void> {
    try {
      const result = await this.remote.eventsRecent({ limit: 20 })
      if (!result.ok) {
        this.set({
          ...this.snapshot,
          eventsStatus: 'error',
          eventsError: `${result.error.code}: ${result.error.message}`,
        })
        return
      }
      this.set({
        ...this.snapshot,
        events: result.value.events,
        eventsStatus: 'ready',
        eventsError: null,
      })
    } catch (error) {
      this.set({ ...this.snapshot, eventsStatus: 'error', eventsError: (error as Error).message })
    }
  }

  private async run<T>(operation: () => Promise<RemoteResult<T>>): Promise<T> {
    this.set({ ...this.snapshot, busy: true })
    try {
      const value = await this.call(operation)
      await this.refresh()
      return value
    } catch (error) {
      // A rejected command is the moment the local revision is most likely
      // stale (an attention CAS conflict, another window's edit). Refresh
      // before rethrowing so the retry copy can point at real data.
      await this.refresh()
      throw error
    } finally {
      this.set({ ...this.snapshot, busy: false })
    }
  }

  private async call<T>(operation: () => Promise<RemoteResult<T>>): Promise<T> {
    const result = await operation()
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }

  private patchNotice(notificationId: string, value: AsyncValue<NoticeDetailWire>): void {
    this.set({
      ...this.snapshot,
      noticeDetails: bounded({ ...this.snapshot.noticeDetails, [notificationId]: value }),
    })
  }

  private patchEvent(eventId: string, value: AsyncValue<EventDetailWire>): void {
    this.set({
      ...this.snapshot,
      eventDetails: bounded({ ...this.snapshot.eventDetails, [eventId]: value }),
    })
  }


  private nextSeq(map: Map<string, number>, key: string): number {
    const seq = (map.get(key) ?? 0) + 1
    map.set(key, seq)
    return seq
  }

  private set(next: QunoSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** Keep the most recently inserted entries of a record cache. */
function bounded<T>(record: Record<string, T>): Record<string, T> {
  const keys = Object.keys(record)
  if (keys.length <= DETAIL_CACHE_LIMIT) return record
  const drop = keys.slice(0, keys.length - DETAIL_CACHE_LIMIT)
  const next = { ...record }
  for (const key of drop) delete next[key]
  return next
}
