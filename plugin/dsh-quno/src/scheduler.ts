/**
 * The Quno pass loop: a bounded, model-free pass every couple of seconds,
 * plus an explicit wake when a durable Effect is enqueued.
 *
 * A pass never decides anything itself. It advances time-owned state
 * (exchanges, Eval deadlines), opens Eval batches from pending Triggers, runs
 * the durable Effect queue (which is what actually delivers candidates,
 * launches workers and relays reports) and asks the notification outbox to
 * deliver anything eligible. With no pending Trigger and no due record a pass
 * costs one cheap transaction and zero model calls.
 *
 * @module dsh-quno/scheduler
 */

import type { QunoStore } from './store.ts'
import type { Engine } from './core/engine.ts'
import type { QunoRecord } from './types.ts'

/** Timer abstraction so tests drive ticks deterministically. */
export interface SchedulerTimer {
  setTimeout(callback: () => void, delayMs: number): () => void
}

/** Largest delay a Node timer represents without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** How often the pass runs even with no external wake. */
const PASS_INTERVAL_MS = 2_000

/** One pass's observable outcome. */
export interface TickResult {
  readonly kind: 'empty' | 'paused' | 'busy' | 'ran' | 'error'
  readonly at: number
  readonly evalsOpened: number
  readonly evalsExpired: number
  readonly exchangesExpired: number
  readonly effectsHandled: number
  readonly error?: string
}

/** Dependencies of the pass loop. */
export interface SchedulerDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly engine: Engine
  readonly effects: { kick(): Promise<number> }
  readonly executor: { reconcile(now: number): Promise<{ readonly closed: number; readonly rearmed: number }> }
  readonly outbox: { kick(): Promise<void> }
  readonly timer: SchedulerTimer
  readonly logger: { warn(message: string): void; info?(message: string): void }
  readonly now?: () => number
  readonly onTick?: (result: TickResult) => void
  readonly passIntervalMs?: number
}

/** Durable pass loop for one Quno. */
export class Scheduler {
  private timerDispose: (() => void) | undefined
  private running: Promise<TickResult> | undefined
  private stopped = false
  private pendingWork = false
  private paused = false
  private readonly now: () => number
  private readonly interval: number

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.interval = deps.passIntervalMs ?? PASS_INTERVAL_MS
  }

  /** Recover interrupted work, arm the pass loop and run one pass promptly. */
  start(): void {
    if (this.stopped) return
    const now = this.now()
    const quno = this.deps.store.getQuno(this.deps.qunoId)
    if (quno === undefined) {
      this.deps.logger.warn('dsh-quno: scheduler started without a provisioned Quno row')
      return
    }
    this.deps.store.heartbeat(now)
    void this.recover(now)
    this.armAt(now)
    void this.tick('startup')
  }

  /** Stop the loop; durable state is left for the next boot. */
  stop(): void {
    this.stopped = true
    this.timerDispose?.()
    this.timerDispose = undefined
  }

  /** Force one pass now (UI "立即检查" and tests). Joins an in-flight pass. */
  checkNow(_trigger = 'user'): Promise<TickResult> {
    return this.tick('manual')
  }

  /** A durable Effect was enqueued: wake the loop promptly. */
  scheduleAutoAnalysis(): void {
    if (this.stopped) return
    this.armAt(this.now())
  }

  /** Whether a pass is in flight. */
  get busy(): boolean {
    return this.running !== undefined
  }

  private async recover(now: number): Promise<void> {
    try {
      await this.deps.executor.reconcile(now)
      await this.deps.effects.kick()
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: startup recovery failed: ${(error as Error).message}`)
    }
  }

  private tick(_trigger: string): Promise<TickResult> {
    if (this.stopped) {
      return Promise.resolve(this.empty('paused'))
    }
    if (this.running !== undefined) {
      this.pendingWork = true
      return this.running
    }
    const run = this.pass().finally(() => {
      this.running = undefined
    })
    this.running = run
    return run
  }

  private async pass(): Promise<TickResult> {
    const now = this.now()
    const store = this.deps.store
    try {
      store.heartbeat(now)
      const quno = store.getQuno(this.deps.qunoId)
      if (quno === undefined) {
        return this.finish({ ...this.empty('error'), error: 'quno row missing' })
      }
      const config = quno.config
      if (!config.enabled) {
        if (!this.paused) {
          this.paused = true
          this.deps.engine.pauseEvals(now)
        }
        this.armAt(now + this.interval)
        return this.finish(this.empty('paused'))
      }
      if (this.paused) {
        this.paused = false
        this.deps.engine.resumeEvals(now)
      }

      const exchangesExpired = this.deps.engine.expireExchanges(now)
      const evalsExpired = this.deps.engine.expireEvals(now)
      const evalsOpened = this.deps.engine.openEvals(now, 20)
      const effectsHandled = await this.deps.effects.kick()
      try {
        await this.deps.outbox.kick()
      } catch (error) {
        this.deps.logger.warn(`dsh-quno: notification outbox pass failed: ${(error as Error).message}`)
      }
      const kind: TickResult['kind'] = evalsOpened + evalsExpired + exchangesExpired + effectsHandled > 0 ? 'ran' : 'empty'
      this.armAt(now + this.interval)
      return this.finish({
        kind,
        at: this.now(),
        evalsOpened,
        evalsExpired,
        exchangesExpired,
        effectsHandled,
      })
    } catch (error) {
      const message = (error as Error).message
      this.deps.logger.warn(`dsh-quno: pass failed: ${message}`)
      this.armAt(now + Math.min(60_000, Math.max(this.interval, 2_000)))
      return this.finish({ ...this.empty('error'), error: message })
    }
  }

  private empty(kind: TickResult['kind']): TickResult {
    return {
      kind,
      at: this.now(),
      evalsOpened: 0,
      evalsExpired: 0,
      exchangesExpired: 0,
      effectsHandled: 0,
    }
  }

  private finish(result: TickResult): TickResult {
    this.deps.onTick?.(result)
    return result
  }

  private arm(at: number): void {
    if (this.stopped) return
    this.timerDispose?.()
    this.timerDispose = undefined
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, at - this.now()))
    this.timerDispose = this.deps.timer.setTimeout(() => {
      this.timerDispose = undefined
      void this.tick('timer').finally(() => {
        if (this.stopped) return
        const next = this.now() + (this.pendingWork ? 50 : this.interval)
        this.pendingWork = false
        this.armAt(next)
      })
    }, delay)
  }

  private armAt(at: number): void {
    const now = this.now()
    this.arm(at <= now ? now : at)
  }

  /** Health summary for the status tool: is the loop paused, and why. */
  describe(quno: QunoRecord | undefined): { enabled: boolean; passIntervalMs: number; paused: boolean } {
    return {
      enabled: quno === undefined ? false : quno.config.enabled,
      passIntervalMs: this.interval,
      paused: quno === undefined ? true : !quno.config.enabled,
    }
  }
}

/**
 * A manual timer used by tests and by hosts that cannot mount the Cordis
 * timer plugin: it accepts explicit firing in virtual time.
 */
export class ManualTimer implements SchedulerTimer {
  private nextId = 1
  private readonly pending = new Map<number, { at: number; callback: () => void }>()
  private current = 0

  constructor(startAt = 0) {
    this.current = startAt
  }

  setTimeout(callback: () => void, delayMs: number): () => void {
    const id = this.nextId++
    this.pending.set(id, { at: this.current + delayMs, callback })
    return () => {
      this.pending.delete(id)
    }
  }

  /** Earliest scheduled instant, or null. */
  nextDue(): number | null {
    let earliest: number | null = null
    for (const entry of this.pending.values()) {
      if (earliest === null || entry.at < earliest) earliest = entry.at
    }
    return earliest
  }

  /** Advance virtual time and fire everything due, in order. */
  fireDue(limit = 10): number {
    let fired = 0
    for (;;) {
      if (fired >= limit) return fired
      let selectedId: number | undefined
      let selected: { at: number; callback: () => void } | undefined
      for (const [id, entry] of this.pending) {
        if (entry.at > this.current) continue
        if (selected === undefined || entry.at < selected.at) {
          selectedId = id
          selected = entry
        }
      }
      if (selected === undefined || selectedId === undefined) return fired
      this.pending.delete(selectedId)
      selected.callback()
      fired += 1
    }
  }

  /** Move virtual time forward without firing. */
  advance(ms: number): void {
    this.current += ms
  }

  /** Current virtual instant. */
  get now(): number {
    return this.current
  }
}
