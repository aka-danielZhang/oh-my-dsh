/**
 * Pure projections of the work surface (design v2 §4/§5/§9): entry counts,
 * worker-row activity text and the composer elect selector. No React, no
 * harness imports — this module is the node-testable half of the work UI;
 * the seat components live in the sibling tsx modules and only render.
 *
 * @module dsh-quno/client/work-model
 */

import { executorTicketIdOf } from '../presentation.ts'
import type { QunoTranslate } from './locales.ts'
import { formatClock } from './format.ts'
import { groupTasks, taskActivityKey, taskUserStatus, taskUserStatusKey, type TaskLike } from './panel-state.ts'

/** Badge counts behind the work entry (v2 §4.2): one badge, needs-you included. */
export interface WorkEntryCounts {
  readonly needsYou: number
  /** Everything in flight — accepted, running, waiting AND needs-you. */
  readonly active: number
}

/**
 * Pure count projection for the entry badge.
 * @param tasks - the polled task list, or `null` before the first snapshot.
 * @returns needs-you count and the total in-flight count (needs-you included,
 * so "2 项需要你" never reads as "2+2=4 项").
 */
export function workEntryCounts(tasks: readonly TaskLike[] | null): WorkEntryCounts {
  if (tasks === null) return { needsYou: 0, active: 0 }
  const groups = groupTasks(tasks)
  return { needsYou: groups.needsYou.length, active: groups.needsYou.length + groups.active.length }
}

/**
 * The accessible name (v2 §4.2): the number alone is never the name —
 * needs-you always wins the wording over plain in-flight work.
 */
export function workEntryAriaLabel(counts: WorkEntryCounts, t: QunoTranslate): string {
  return counts.needsYou > 0
    ? t('workEntryNeedsYou', { n: counts.needsYou })
    : t('workEntryActive', { n: counts.active })
}

/** Minimal task slice the worker row reads. */
export interface TaskSectionTask extends TaskLike {
  readonly id: string
  readonly title: string
  readonly question?: { readonly question: string } | null
  readonly error: { readonly message: string } | null
  readonly lastActivityAt?: number | null
  readonly settledAt: number | null
  readonly activityKind?: string | null
}

/** One line of "what is this worker doing right now" (v2 §5.3). */
export function workerRowActivity(task: TaskSectionTask, t: QunoTranslate): string | null {
  const status = taskUserStatus(task)
  const activityKey = taskActivityKey(task.activityKind)
  const activity = activityKey === null ? null : t(activityKey)
  switch (status) {
    case 'accepted': return t('taskActivityAccepted')
    case 'running': return activity ?? t('taskActivityWorking')
    case 'waiting': return activity ?? t('taskActivityWaitingEvent')
    case 'needs-you': return task.question?.question !== undefined && task.question.question !== ''
      ? task.question.question
      : (activity ?? t('taskActivityWaitingUser'))
    case 'done': return whenLabel(task.settledAt ?? task.lastActivityAt ?? null, t)
    case 'failed': return task.error !== null && task.error.message !== '' ? task.error.message : null
    case 'cancelled': return whenLabel(task.settledAt ?? task.lastActivityAt ?? null, t)
    case 'dropped': return whenLabel(task.lastActivityAt ?? task.settledAt ?? null, t)
  }
}

function whenLabel(at: number | null | undefined, t: QunoTranslate): string | null {
  if (at === null || at === undefined) return null
  return `${t('taskLastActive')} ${formatClock(at)}`
}

/** What the composer elect matched: the worker behind this session. */
export interface WorkerComposerMatch {
  readonly ticketId: string
}

/**
 * Pure chain selector (v2 §9.4 client half): elect only for executor
 * sessions, recognized by the durable id prefix. Program inputs bypass the
 * composer, so electing here never blocks TicketInput or worker output.
 */
export function selectWorkerComposer(owner: { readonly sessionId?: unknown }): WorkerComposerMatch | null {
  const sessionId = typeof owner.sessionId === 'string' ? owner.sessionId : null
  const ticketId = sessionId === null ? null : executorTicketIdOf(sessionId)
  return ticketId === null ? null : { ticketId }
}
