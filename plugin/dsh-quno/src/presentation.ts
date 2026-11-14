/**
 * The single TaskPresentation projection (design §9.1): one pure function from
 * the durable facts (Ticket + Assignment + WorkerRun + latest Report) to what
 * the product shows.
 *
 * The main conversation's status answers, the task card, the task list and the
 * task detail ALL read this module. Nothing here writes back or derives a
 * second state: every field is recomputable from the persisted records, and a
 * replay produces the identical answer.
 *
 * Vocabulary rule: user-facing states never leak domain nouns (Worker,
 * Executor, Exchange). `accepted` vs `running` are deliberately distinct so a
 * launch failure or resource shortage shows "accepted (waiting for resources)"
 * instead of a forever-"running" lie.
 *
 * @module dsh-quno/presentation
 */

import type { AssignmentRecord, TicketRecord, WorkerReport, WorkerRunRecord } from './core/model.ts'

/** The user-visible task states (design §4.2). */
export type TaskUserStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'needs-you'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'dropped'

/**
 * Coarse activity buckets (design §4.3). Derived from registered tool
 * declarations and the latest report — never from model prose. `null` means
 * "no activity fact": the UI falls back to "last active at <time>".
 */
export type TaskActivityKind =
  | 'recent-groups'
  | 'read-messages'
  | 'read-file'
  | 'read-web'
  | 'summarize'
  | 'waiting-user'
  | 'waiting-event'
  | 'working'

/** Where a ticket's mandate came from — a machine enum, not localized copy. */
export type TaskOriginLabel = 'direct' | 'source'

/**
 * The agent preset an executor session is created with (`app/executor.ts`
 * mounts it). Lives here so the client can recognize worker sessions without
 * importing anything from the host side.
 */
export const EXECUTOR_PRESET = 'quno-task'

/**
 * Durable executor-session id convention: `quno-exec-<ticketId>` (assigned at
 * worker creation and mirrored by the store's COALESCE). The client uses the
 * prefix to recognize worker sessions and to recover the ticket id — the same
 * facts, never a second identity source.
 */
export const EXECUTOR_SESSION_PREFIX = 'quno-exec-'

/**
 * Recover the ticket id from an executor session id.
 * @param sessionId - a session id from any client surface.
 * @returns the ticket id, or `null` when the session is not a worker session.
 */
export function executorTicketIdOf(sessionId: string): string | null {
  return sessionId.startsWith(EXECUTOR_SESSION_PREFIX)
    ? sessionId.slice(EXECUTOR_SESSION_PREFIX.length)
    : null
}

/** The durable slices the projection reads. Structural (not full records). */
export interface TaskPresentationInput {
  readonly ticket: Pick<TicketRecord, 'mode' | 'ended' | 'question' | 'origin' | 'createdAt'>
  readonly assignment: Pick<
    AssignmentRecord,
    'state' | 'executorSessionId' | 'report' | 'createdAt' | 'deliveredAt'
  > | null
  readonly latestRun: Pick<WorkerRunRecord, 'status' | 'startedAt' | 'finishedAt'> | null
}

/** What the product shows for one task. */
export interface TaskPresentation {
  readonly status: TaskUserStatus
  readonly activityKind: TaskActivityKind | null
  readonly lastActivityAt: number | null
  readonly canCancel: boolean
  readonly canRetry: boolean
  readonly canAnswer: boolean
  /** True whenever the executor session can be resolved — running included. */
  readonly canViewActivity: boolean
  /** Stable discriminator of the latest result; persistent tickets use it to dedupe relays. */
  readonly resultRevision: string | null
  readonly origin: TaskOriginLabel
}

/**
 * Project one task's durable facts into the product presentation.
 * @param input - ticket plus its latest assignment/run slices.
 * @returns the recomputable presentation.
 */
export function presentTask(input: TaskPresentationInput): TaskPresentation {
  const { ticket, assignment, latestRun } = input
  const report = assignment?.report ?? null
  const ended = ticket.ended
  const lastActivityAt = latestActivityAt(report, latestRun, ticket.question, assignment)
  const origin = originOf(ticket)

  if (ended !== null) {
    const status: TaskUserStatus = ended.outcome === 'completed'
      ? 'done'
      : ended.outcome === 'failed'
        ? 'failed'
        : ended.outcome === 'stopped'
          ? 'cancelled'
          : 'dropped'
    return {
      status,
      activityKind: null,
      lastActivityAt,
      canCancel: false,
      canRetry: false,
      canAnswer: false,
      canViewActivity: assignment !== null,
      resultRevision: resultRevisionOf(report),
      origin,
    }
  }

  const base = { lastActivityAt, origin, resultRevision: resultRevisionOf(report) }

  // Open ticket. The question on the ticket is the strongest fact: a user
  // answer is pending regardless of what else is running.
  if (ticket.question !== null) {
    return { status: 'needs-you', activityKind: 'waiting-user', ...openFlags(ticket, assignment, true), ...base }
  }
  // A failed/blocked report without a recorded question still needs a human
  // decision (retry or give up); a waiting report without one is a wait for
  // external events — never a reason to bother the user.
  if (report !== null && (report.state === 'blocked' || report.state === 'failed')) {
    return { status: 'needs-you', activityKind: 'waiting-user', ...openFlags(ticket, assignment, true), ...base }
  }
  if (report !== null && report.state === 'waiting') {
    return { status: 'waiting', activityKind: 'waiting-event', ...openFlags(ticket, assignment, false), ...base }
  }

  // An active run, or an assignment holding one, means work is executing. A
  // `progress` report and a `ready` report on a still-open ticket both count
  // as running (a persistent ready is "a new result", not "the task is done").
  const runActive = latestRun !== null && (latestRun.status === 'running' || latestRun.status === 'prepared')
  const assignmentRunning = assignment?.state === 'running'
  if (runActive || assignmentRunning) {
    const kind: TaskActivityKind = report?.state === 'ready' ? 'summarize' : 'working'
    return { status: 'running', activityKind: kind, ...openFlags(ticket, assignment, false), ...base }
  }
  // Created but not yet executing: waiting for execution resources. This must
  // stay visibly distinct from running (launch failures never show "working").
  return { status: 'accepted', activityKind: null, ...openFlags(ticket, assignment, false), ...base }
}

/** Operation availability for an open ticket. */
interface OpenFlags {
  readonly canCancel: boolean
  readonly canRetry: boolean
  readonly canAnswer: boolean
  readonly canViewActivity: boolean
}

function openFlags(ticket: TaskPresentationInput['ticket'], assignment: TaskPresentationInput['assignment'], needsUser: boolean): OpenFlags {
  const report = assignment?.report ?? null
  return {
    canCancel: true,
    canRetry: needsUser && report !== null && (report.state === 'blocked' || report.state === 'failed'),
    canAnswer: needsUser,
    canViewActivity: assignment !== null,
  }
}

/**
 * The display-only Worker label (design v2 §9.1): derived from the ticket id
 * with a stable FNV-1a short hash. It is NOT a second identity — routing,
 * authorization and every command keep addressing the ticket id.
 * @param ticketId - the ticket's durable id.
 * @returns e.g. `Worker 02f803ec`.
 */
export function workerLabelOf(ticketId: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < ticketId.length; index += 1) {
    hash ^= ticketId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `Worker ${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Stable result discriminator: report timestamp plus its monotonic nonce. */
export function resultRevisionOf(report: WorkerReport | null): string | null {
  if (report === null) return null
  return `${String(report.at)}:${String(report.nonce ?? 0)}`
}

/** `direct` when the mandate came from a human turn; `source` otherwise. */
function originOf(ticket: TaskPresentationInput['ticket']): TaskOriginLabel {
  return ticket.origin.triggerId === null && ticket.origin.triggerIds.length === 0 ? 'direct' : 'source'
}

/**
 * The most recent real activity timestamp. Only recorded facts count — no
 * heartbeat, no "still working" fabrication.
 */
function latestActivityAt(
  report: WorkerReport | null,
  run: TaskPresentationInput['latestRun'],
  question: TaskPresentationInput['ticket']['question'],
  assignment: TaskPresentationInput['assignment'],
): number | null {
  let latest: number | null = null
  const consider = (value: number | null | undefined): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if (latest === null || value > latest) latest = value
  }
  consider(report?.at)
  consider(run?.finishedAt)
  consider(run?.startedAt)
  consider(question?.createdAt)
  consider(assignment?.deliveredAt)
  consider(assignment?.createdAt)
  return latest
}

// ────────────────────────────────────────────── activity label declarations

/**
 * Map one registered tool call onto the coarse activity kind (design §4.3:
 * labels come from tool/capability display declarations, not model prose).
 * Unknown tools fall back to the generic "working".
 * @param tool - the tool name as invoked.
 * @param argsHint - optional structured arguments the tool declares public.
 * @returns the activity kind.
 */
export function activityKindForTool(
  tool: string,
  argsHint: { readonly capability?: string; readonly operation?: string } | null,
): TaskActivityKind {
  if (tool === 'quno_cli_call') {
    if (argsHint?.capability === 'yzj' && typeof argsHint.operation === 'string') {
      if (argsHint.operation === 'im.group.recent') return 'recent-groups'
      if (argsHint.operation.startsWith('im.message')) return 'read-messages'
      if (argsHint.operation === 'im.group.search') return 'read-messages'
    }
    return 'working'
  }
  if (tool === 'quno_worker_report') return 'summarize'
  if (tool === 'quno_recall' || tool === 'quno_read') return 'read-messages'
  if (tool === 'read' || tool === 'read_file' || tool === 'list' || tool === 'glob' || tool === 'grep') return 'read-file'
  if (tool === 'web_fetch' || tool === 'web_search') return 'read-web'
  return 'working'
}
