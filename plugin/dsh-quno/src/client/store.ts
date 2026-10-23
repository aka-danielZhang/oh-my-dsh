/**
 * Browser-side Quno model: one polling snapshot store plus thin command
 * wrappers over the `quno` Remote namespace. Components never touch the
 * Remote directly; slot `inject` hands them this store.
 *
 * @module dsh-quno/client/store
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  CheckNowResult,
  EnsureMainResult,
  EventWire,
  QunoWireState,
} from '../api-types.ts'

/** Structural face of the mounted Remote namespace. */
export interface QunoRemoteFace {
  state(): Promise<RemoteResult<QunoWireState>>
  ensureMain(request: { cwd: string }): Promise<RemoteResult<EnsureMainResult>>
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
  createSense(request: {
    type: string
    label?: string
    config?: Record<string, unknown>
    desiredState?: 'enabled' | 'paused' | 'disabled'
  }): Promise<RemoteResult<QunoWireState>>
  senseCommand(request: {
    instanceId: string
    action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
    label?: string
    config?: Record<string, unknown>
  }): Promise<RemoteResult<QunoWireState>>
  taskCommand(request: { taskId: string; action: 'resume' | 'abandon' }): Promise<RemoteResult<QunoWireState>>
  mute(request: { minutes?: number; until?: string; cancel?: boolean }): Promise<RemoteResult<QunoWireState>>
  eventsRecent(request: { limit?: number }): Promise<RemoteResult<{ events: EventWire[] }>>
}

/** Immutable snapshot consumed through `useSyncExternalStore`. */
export interface QunoSnapshot {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly state: QunoWireState | null
  /** Recent Sense events (动态 view); a failed fetch keeps the previous list. */
  readonly events: readonly EventWire[]
  readonly error: string | null
  readonly busy: boolean
}

const INITIAL: QunoSnapshot = { phase: 'idle', state: null, events: [], error: null, busy: false }

/** Polling store + command surface. */
export class QunoClientStore {
  private snapshot: QunoSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false

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

  /** Pull one fresh snapshot. */
  async refresh(): Promise<void> {
    if (this.polling) return
    this.polling = true
    if (this.snapshot.phase === 'idle') this.set({ ...this.snapshot, phase: 'loading' })
    try {
      const result = await this.remote.state()
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const events = await this.refreshEvents()
      this.set({ phase: 'ready', state: result.value, events, error: null, busy: this.snapshot.busy })
    } catch (error) {
      this.set({
        phase: this.snapshot.state === null ? 'error' : 'ready',
        state: this.snapshot.state,
        events: this.snapshot.events,
        error: (error as Error).message,
        busy: this.snapshot.busy,
      })
    } finally {
      this.polling = false
    }
  }

  /** Fetch the recent-events summary; a failure degrades to the previous list. */
  private async refreshEvents(): Promise<readonly EventWire[]> {
    try {
      const result = await this.remote.eventsRecent({ limit: 20 })
      if (!result.ok) return this.snapshot.events
      return result.value.events
    } catch {
      return this.snapshot.events
    }
  }

  /** Bind or create the main conversation and return its id. */
  async ensureMain(cwd: string): Promise<string> {
    const value = await this.run(() => this.remote.ensureMain({ cwd }))
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

  /** Create one Sense instance. */
  async createSense(request: {
    type: string
    label?: string
    config?: Record<string, unknown>
    desiredState?: 'enabled' | 'paused' | 'disabled'
  }): Promise<void> {
    await this.run(() => this.remote.createSense(request))
  }

  /** Pause/resume/disable/remove/reconfigure one Sense instance. */
  async senseCommand(request: {
    instanceId: string
    action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'
    label?: string
    config?: Record<string, unknown>
  }): Promise<void> {
    await this.run(() => this.remote.senseCommand(request))
  }

  /** Resume or abandon one task. */
  async taskCommand(taskId: string, action: 'resume' | 'abandon'): Promise<void> {
    await this.run(() => this.remote.taskCommand({ taskId, action }))
  }

  /** Short-term mute state. */
  async mute(request: { minutes?: number; until?: string; cancel?: boolean }): Promise<void> {
    await this.run(() => this.remote.mute(request))
  }

  private async run<T>(operation: () => Promise<RemoteResult<T>>): Promise<T> {
    this.set({ ...this.snapshot, busy: true })
    try {
      const result = await operation()
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      await this.refresh()
      return result.value
    } finally {
      this.set({ ...this.snapshot, busy: false })
    }
  }

  private set(next: QunoSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
