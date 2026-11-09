/**
 * The durable Effect outbox runtime (the Action Outbox).
 *
 * Domain commands never perform post-commit work themselves: they enqueue an
 * Effect in the same transaction as the state they changed. This runtime is
 * the only executor of Effects. Three rules make crashes and duplicates
 * boring:
 *
 * 1. an Effect is executed only while `(seq, generation)` still match the row
 *    that was read, so a newer intent supersedes an old execution;
 * 2. success deletes the row, failure reschedules it with exponential backoff
 *    while keeping the row (pause/shutdown never loses waiting work);
 * 3. a handler must be idempotent on the domain identity it carries, because
 *    a crash after the side effect and before completion replays it.
 *
 * @module dsh-quno/app/effects
 */

import type { EffectKind, EffectRecord } from '../core/model.ts'
import type { DomainRepository } from '../core/repository.ts'

/** A handler failure that asks for a concrete retry instant. */
export class EffectRetryError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message)
    this.name = 'EffectRetryError'
  }
}

/** One Effect handler. Throwing reschedules; returning completes. */
export type EffectHandler = (effect: EffectRecord, signal: AbortSignal) => Promise<void>

/** Dependencies of the runtime. */
export interface EffectsRuntimeDeps {
  readonly repo: DomainRepository
  readonly handlers: Partial<Record<EffectKind, EffectHandler>>
  readonly logger: { warn(message: string): void; info?(message: string): void }
  readonly now?: () => number
  /** Delay for one failed attempt (attempts already counted). */
  readonly backoff?: (attempts: number) => number
  /** Effects handled per drain call (bounds one wake's work). */
  readonly maxPerPass?: number
}

/** Default retry delay: 2s, 4s, 8s … capped at 10 minutes. */
export function defaultBackoff(attempts: number): number {
  const base = 2_000 * 2 ** Math.min(9, Math.max(0, attempts - 1))
  return Math.min(10 * 60_000, base)
}

/** The single consumer of the persistent Effect queue. */
export class EffectsRuntime {
  private draining: Promise<number> | undefined
  private stopped = false
  private readonly controller = new AbortController()
  private readonly now: () => number
  private readonly maxPerPass: number
  private readonly backoff: (attempts: number) => number

  constructor(private readonly deps: EffectsRuntimeDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.maxPerPass = deps.maxPerPass ?? 20
    this.backoff = deps.backoff ?? defaultBackoff
  }

  /** Stop accepting new work; in-flight handlers observe the signal. */
  stop(): void {
    this.stopped = true
    this.controller.abort(new Error('quno effects runtime stopped'))
  }

  /** Execute every currently due Effect (single flight). */
  kick(): Promise<number> {
    if (this.draining !== undefined) return this.draining
    this.draining = this.drain().finally(() => {
      this.draining = undefined
    })
    return this.draining
  }

  private async drain(): Promise<number> {
    if (this.stopped) return 0
    let handled = 0
    for (;;) {
      if (this.stopped || handled >= this.maxPerPass) return handled
      const due = this.deps.repo.listDueEffects(this.now(), this.maxPerPass - handled)
      if (due.length === 0) return handled
      for (const effect of due) {
        if (this.stopped) return handled
        handled += 1
        await this.runOne(effect)
      }
    }
  }

  private async runOne(effect: EffectRecord): Promise<void> {
    const handler = this.deps.handlers[effect.kind]
    if (handler === undefined) {
      this.deps.logger.warn(`dsh-quno: no handler registered for effect ${effect.kind}:${effect.key}`)
      this.deps.repo.failEffect(
        effect.kind,
        effect.key,
        effect.seq,
        effect.generation,
        `no handler for ${effect.kind}`,
        this.now() + 60_000,
      )
      return
    }
    // Re-read immediately before the side effect: a newer payload wins and
    // the old execution is dropped instead of stomping on it.
    const current = this.deps.repo.getEffect(effect.kind, effect.key)
    if (current === undefined || current.seq !== effect.seq || current.generation !== effect.generation) {
      return
    }
    try {
      await handler(current, this.controller.signal)
      this.deps.repo.completeEffect(current.kind, current.key, current.seq, current.generation)
    } catch (error) {
      const retry = error instanceof EffectRetryError ? error : undefined
      const message = error instanceof Error ? error.message : String(error)
      const next = retry?.retryAfterMs !== undefined
        ? this.now() + retry.retryAfterMs
        : this.now() + this.backoff(effect.attempts + 1)
      const rescheduled = this.deps.repo.failEffect(current.kind, current.key, current.seq, current.generation, message, next)
      if (rescheduled) {
        this.deps.logger.warn(`dsh-quno: effect ${current.kind}:${current.key} failed (attempt ${String(current.attempts + 1)}): ${message}`)
      }
    }
  }
}
