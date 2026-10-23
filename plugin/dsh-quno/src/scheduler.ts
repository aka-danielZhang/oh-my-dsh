/**
 * The Quno-owned due queue. A timer is only a wake-up hint: durable
 * `next_check_at`, ready deliveries and due attention items are the facts.
 * Every wake runs a model-free preflight, and an empty check costs zero model
 * calls (design §8.1).
 *
 * Guarantees:
 * - single flight per Quno: one run at a time, later work sets a pending flag;
 * - wake coalescing: sleep/hibernate produces ONE compensating check, never a
 *   burst of missed reminders;
 * - claiming is transactional and fenced; a lost lease can never commit;
 * - daily budget is checked before a model call, not after.
 *
 * @module dsh-quno/scheduler
 */

import { localClock, zonedToEpoch } from './util.ts'
import { selectDeliveries } from './selection.ts'
import { Router } from './routing.ts'
import { RunFailure } from './runner.ts'
import type { QunoStore, ReadyDelivery } from './store.ts'
import type { RunOutcome, Runner } from './runner.ts'
import type { QunoConfig, QunoRecord, RunRecord } from './types.ts'

/** Timer abstraction so tests drive ticks deterministically. */
export interface SchedulerTimer {
  setTimeout(callback: () => void, delayMs: number): () => void
}

/** Largest delay Node timers represent without clamping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Result kinds a tick can report. */
export type TickKind = 'empty' | 'paused' | 'budget' | 'busy' | 'ran' | 'error'

/** One scheduler tick's observable outcome. */
export interface TickResult {
  readonly kind: TickKind
  readonly at: number
  readonly readyDeliveries: number
  readonly dueAttention: number
  readonly run?: RunRecord
  readonly outcome?: RunOutcome
  readonly error?: string
}

/** Dependencies of the scheduler. */
export interface SchedulerDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly router: Router
  readonly runner: Runner
  readonly timer: SchedulerTimer
  readonly logger: { warn: (message: string) => void; info?: (message: string) => void }
  readonly now?: () => number
  /** Called after every tick (UI pushes, tests). */
  readonly onTick?: (result: TickResult) => void
  /** Backoff for retryable run failures; default 60s. */
  readonly retryDelayMs?: number
  /** Delay before an immediate follow-up tick (drain mode); default 1500ms. */
  readonly drainDelayMs?: number
}

/** Durable due-queue loop for one Quno. */
export class Scheduler {
  private timerDispose: (() => void) | undefined
  private running: Promise<TickResult> | undefined
  private stopped = false
  private pendingWork = false
  private controller: AbortController | undefined
  private readonly now: () => number

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Recover interrupted work, route anything unrouted, then arm the timer. */
  start(): void {
    if (this.stopped) return
    const now = this.now()
    const quno = this.deps.store.getQuno(this.deps.qunoId)
    if (quno === undefined) {
      this.deps.logger.warn('dsh-quno: scheduler started without a provisioned Quno row')
      return
    }
    try {
      const interrupted = this.deps.store.expireStaleRuns(now)
      if (interrupted.length > 0) {
        this.deps.logger.warn(`dsh-quno: interrupted ${String(interrupted.length)} run(s) after restart`)
      }
      this.deps.router.route(now)
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: startup recovery failed: ${(error as Error).message}`)
    }
    this.armAt(quno.nextCheckAt ?? now)
  }

  /** Stop the loop and cancel an in-flight run (the next boot re-queues it). */
  stop(): void {
    this.stopped = true
    this.timerDispose?.()
    this.timerDispose = undefined
    this.controller?.abort(new Error('quno scheduler stopped'))
  }

  /** Force one check now (UI "立即检查" and tests). Joins an in-flight tick. */
  checkNow(trigger = 'user'): Promise<TickResult> {
    return this.tick(trigger)
  }

  /** Whether a run is currently in flight. */
  get busy(): boolean {
    return this.running !== undefined
  }

  private tick(trigger: string): Promise<TickResult> {
    if (this.stopped) {
      return Promise.resolve({ kind: 'paused', at: this.now(), readyDeliveries: 0, dueAttention: 0 })
    }
    if (this.running !== undefined) {
      this.pendingWork = true
      return this.running
    }
    const run = this.runTick(trigger).finally(() => {
      this.running = undefined
      this.controller = undefined
    })
    this.running = run
    return run
  }

  private async runTick(trigger: string): Promise<TickResult> {
    const now = this.now()
    const store = this.deps.store
    try {
      store.heartbeat(now)
      const routed = this.deps.router.route(now)

      const quno = store.getQuno(this.deps.qunoId)
      if (quno === undefined) return this.finish({ kind: 'error', at: now, readyDeliveries: 0, dueAttention: 0, error: 'quno row missing' })
      const config = quno.config

      if (!config.enabled) {
        this.scheduleAt(now + config.checkIntervalSec * 1000)
        return this.finish({ kind: 'paused', at: now, readyDeliveries: 0, dueAttention: 0 })
      }

      const active = store.activeRun(this.deps.qunoId)
      if (active !== undefined) {
        if (active.claimExpiresAt !== null && active.claimExpiresAt < now) {
          store.expireStaleRuns(now)
        } else {
          this.pendingWork = true
          this.scheduleAt(now + Math.min(30_000, config.checkIntervalSec * 1000))
          return this.finish({ kind: 'busy', at: now, readyDeliveries: 0, dueAttention: 0, run: active })
        }
      }

      const ready = store.countReadyDeliveries(this.deps.qunoId, now)
      const due = store.countAttentionDue(this.deps.qunoId, now)
      if (ready === 0 && due === 0) {
        this.scheduleAt(now + config.checkIntervalSec * 1000)
        return this.finish({
          kind: 'empty',
          at: now,
          readyDeliveries: 0,
          dueAttention: 0,
        })
      }

      if (!this.withinBudget(quno, now)) {
        // Wake at local midnight; the preflight itself stays free.
        const midnight = this.localMidnight(quno)
        this.scheduleAt(midnight > now ? midnight : now + 60 * 60_000)
        return this.finish({ kind: 'budget', at: now, readyDeliveries: ready, dueAttention: due })
      }

      const candidates = this.pickDeliveries(config, now)
      const attention = store.listAttentionDue(this.deps.qunoId, now, 20)
      if (candidates.length === 0 && attention.length === 0) {
        this.scheduleAt(now + config.checkIntervalSec * 1000)
        return this.finish({ kind: 'empty', at: now, readyDeliveries: ready, dueAttention: due })
      }

      const runId = `${this.deps.qunoId}-run-${String(now)}-${Math.random().toString(36).slice(2, 8)}`
      const fence = store.nextFence(this.deps.qunoId)
      const claimExpiresAt = now + config.budget.runTimeoutSec * 1000 + 60_000
      const run = store.transaction(() => {
        const created = store.insertRun({
          id: runId,
          qunoId: this.deps.qunoId,
          kind: 'think',
          trigger,
          configRevision: quno.configRevision,
          fence,
          claimExpiresAt,
          inputEventIds: candidates.map(item => item.eventId),
          inputAttentionIds: attention.map(item => item.id),
          now,
        })
        store.claimDeliveries(this.deps.qunoId, created.id, created.inputEventIds, now)
        store.setNextCheckAt(this.deps.qunoId, now + config.checkIntervalSec * 1000)
        return created
      })

      this.controller = new AbortController()
      const timeout = setTimeout(() => {
        this.controller?.abort(new Error('quno run exceeded its time budget'))
      }, config.budget.runTimeoutSec * 1000)
      if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref()
      const outcome = await this.deps.runner.execute(run.id, this.controller.signal, this.now())
      clearTimeout(timeout)

      const after = this.now()
      const remaining = store.countReadyDeliveries(this.deps.qunoId, after)
      if (remaining > 0 || this.pendingWork) {
        this.pendingWork = false
        this.scheduleAt(after + (this.deps.drainDelayMs ?? 1500))
      } else {
        const nextDue = this.nextAttentionInstant(after)
        this.scheduleAt(Math.min(after + config.checkIntervalSec * 1000, nextDue ?? Number.POSITIVE_INFINITY))
      }
      return this.finish({
        kind: 'ran',
        at: after,
        readyDeliveries: ready,
        dueAttention: due,
        run,
        outcome,
      })
    } catch (error) {
      const failure = error as Error
      this.deps.logger.warn(`dsh-quno: scheduler tick failed: ${failure.message}`)
      this.scheduleAt(now + 60_000)
      return this.finish({
        kind: 'error',
        at: now,
        readyDeliveries: 0,
        dueAttention: 0,
        error: failure.message,
      })
    }
  }

  private pickDeliveries(config: QunoConfig, now: number): ReadyDelivery[] {
    const scan = Math.max(config.budget.maxEventsPerRun * 4, 50)
    const ready = this.deps.store.listReadyDeliveries(this.deps.qunoId, now, scan)
    return selectDeliveries(ready, config.budget.maxEventsPerRun)
  }

  private withinBudget(quno: QunoRecord, now: number): boolean {
    const start = this.localMidnight(quno)
    return this.deps.store.countRunsSince(this.deps.qunoId, start) < quno.config.budget.dailyModelRuns
  }

  private localMidnight(quno: QunoRecord): number {
    const clock = localClock(this.now(), quno.config.timeZone)
    return zonedToEpoch(clock.dayKey, 0, quno.config.timeZone)
  }

  private nextAttentionInstant(now: number): number | null {
    const items = this.deps.store.listAttention(this.deps.qunoId, ['open', 'waiting', 'snoozed'], 200)
    let earliest: number | null = null
    for (const item of items) {
      if (item.nextReviewAt === null || item.nextReviewAt <= now) continue
      if (earliest === null || item.nextReviewAt < earliest) earliest = item.nextReviewAt
    }
    return earliest
  }

  private finish(result: TickResult): TickResult {
    this.deps.onTick?.(result)
    return result
  }

  private scheduleAt(at: number): void {
    if (this.stopped) return
    this.timerDispose?.()
    this.timerDispose = undefined
    const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, at - this.now()))
    this.timerDispose = this.deps.timer.setTimeout(() => {
      this.timerDispose = undefined
      void this.tick('timer')
    }, delay)
  }

  private armAt(at: number): void {
    const now = this.now()
    this.scheduleAt(at <= now ? now : at)
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

/** Export for tests that classify a failed run. */
export { RunFailure }
