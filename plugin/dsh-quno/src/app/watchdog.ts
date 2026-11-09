/**
 * The local, read-only Watchdog.
 *
 * It inspects durable state for states that should not persist silently:
 * candidates whose deadline passed, Effects that keep failing, pending
 * Threads with no Eval, and Tickets whose executor side has nothing running.
 *
 * Hard boundary: the Watchdog NEVER mutates prompts, permissions, Policy,
 * Tickets, Effects or Sources. It returns findings for the Host and the user;
 * acting on them is an explicit human (or Effect-retry) decision.
 *
 * @module dsh-quno/app/watchdog
 */

import type { DomainRepository } from '../core/repository.ts'
import type { QunoConfig } from '../types.ts'

/** One finding, ordered by severity. */
export interface WatchdogFinding {
  readonly code: string
  readonly severity: 'info' | 'warn' | 'error'
  readonly detail: string
  readonly count: number
}

/** The complete read-only report. */
export interface WatchdogReport {
  readonly at: number
  readonly healthy: boolean
  readonly findings: readonly WatchdogFinding[]
  readonly counts: {
    readonly timedOutEvals: number
    readonly failingEffects: number
    readonly idlePendingThreads: number
    readonly stuckAssignments: number
  }
}

/** Dependencies of the Watchdog. */
export interface WatchdogDeps {
  readonly repo: DomainRepository
  readonly qunoId: string
  readonly config: () => QunoConfig
  readonly now?: () => number
}

/** A read-only health inspection over durable domain state. */
export class Watchdog {
  private readonly now: () => number

  constructor(private readonly deps: WatchdogDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Inspect once; never writes. */
  inspect(): WatchdogReport {
    const now = this.now()
    const repo = this.deps.repo
    const config = this.deps.config()
    const findings: WatchdogFinding[] = []

    const timedOut = repo.listTimedOutEvals(now, 100)
    if (timedOut.length > 0) {
      findings.push({
        code: 'eval-timeout',
        severity: 'warn',
        detail: '有已交付却超过 deadline 的评估候选；pass 会在下一次运行时重排或记 unavailable',
        count: timedOut.length,
      })
    }

    const failing = repo.listDueEffects(now, 500).filter(effect => effect.attempts >= 3)
    if (failing.length > 0) {
      findings.push({
        code: 'effect-failing',
        severity: 'error',
        detail: '有连续失败三次以上的 Effect；检查主对话/Executor 可达性与器官能力声明',
        count: failing.length,
      })
    }

    const idleWindow = Math.max(60_000, config.checkIntervalSec * 1000)
    const threads = repo.listThreads(this.deps.qunoId, { limit: 200 })
    let idlePending = 0
    for (const thread of threads) {
      if (thread.pendingTriggerIds.length === 0) continue
      if (thread.activeEvalId !== null) continue
      if (thread.lastAt !== null && now - thread.lastAt < idleWindow) continue
      idlePending += 1
    }
    if (idlePending > 0) {
      findings.push({
        code: 'thread-pending-idle',
        severity: 'warn',
        detail: '有 Thread 的 pending Trigger 长时间没有 active Eval；检查 pass 是否暂停或 Effect 是否卡住',
        count: idlePending,
      })
    }

    let stuckAssignments = 0
    for (const assignment of repo.listAssignmentsByState('running', 200)) {
      const ticket = repo.getTicket(assignment.ticketId)
      if (ticket === undefined || ticket.ended !== null) continue
      if (repo.findRunningWorkerRun(assignment.id) !== undefined) continue
      const pending = repo.listInputsByTicket(ticket.id, { undelivered: true, limit: 1 })
      if (pending.length > 0) stuckAssignments += 1
    }
    if (stuckAssignments > 0) {
      findings.push({
        code: 'input-undelivered',
        severity: 'warn',
        detail: '有 Ticket 的输入未投递且没有运行中的 WorkerRun；下一次 pass 会重新唤醒 Executor',
        count: stuckAssignments,
      })
    }

    return {
      at: now,
      healthy: findings.every(finding => finding.severity === 'info'),
      findings,
      counts: {
        timedOutEvals: timedOut.length,
        failingEffects: failing.length,
        idlePendingThreads: idlePending,
        stuckAssignments,
      },
    }
  }
}
