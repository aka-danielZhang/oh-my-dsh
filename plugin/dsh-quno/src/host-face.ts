/**
 * The model-facing surface of the Quno Host service, shared by the preset
 * tools and implemented by the Host entry. Kept structural so the preset row
 * only needs the `quno` service key.
 *
 * @module dsh-quno/host-face
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttentionAct } from './contracts.ts'
import type { RecallRequest, RecallResult } from './recall.ts'
import type { AttentionItemRecord } from './types.ts'

/** Compact self-status shown to the model (not the full UI snapshot). */
export interface QunoStatusSummary {
  readonly enabled: boolean
  readonly mainSession: string
  readonly mutedUntil: number | null
  readonly nextCheckAt: number | null
  readonly attention: { readonly open: number; readonly waiting: number; readonly snoozed: number }
  readonly deliveries: { readonly pending: number; readonly deferred: number; readonly deadLetter: number }
  readonly tasks: { readonly running: number; readonly interrupted: number }
  readonly collectors: readonly { readonly label: string; readonly type: string; readonly health: string; readonly stale: boolean }[]
  readonly notices: { readonly pending: number; readonly inboxDurable: number; readonly blocked: number }
  /** Read-only Watchdog summary (never includes private bodies). */
  readonly watchdog: {
    readonly healthy: boolean
    readonly findings: readonly { readonly code: string; readonly severity: string; readonly detail: string; readonly count: number }[]
  }
}

/** One artifact a Worker reported. */
export interface TicketArtifactView {
  readonly kind: string
  readonly label: string
  readonly uri: string
}

/** The Ticket view the permanent conversation and the task card use. */
export interface TicketView {
  readonly id: string
  readonly title: string
  readonly goal: string
  readonly status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'waiting'
  /** The unified user-facing status from the TaskPresentation projection. */
  readonly presentationStatus: 'accepted' | 'running' | 'waiting' | 'needs-you' | 'done' | 'failed' | 'cancelled' | 'dropped'
  readonly mode: 'once' | 'persistent'
  readonly executorSessionId: string | null
  readonly result: string | null
  readonly artifacts: readonly TicketArtifactView[]
  readonly error: { readonly code: string; readonly message: string } | null
  readonly question: { readonly id: string; readonly question: string; readonly triggerId: string | null } | null
  readonly createdAt: number
  readonly settledAt: number | null
  readonly endedBy: string | null
}

/** One candidate Trigger as the Router tool renders it. */
export interface CandidateTriggerView {
  readonly triggerId: string
  readonly type: string
  readonly human: boolean
  readonly addressed: 'mention' | 'direct' | null
  readonly summary: string | null
  readonly occurredAt: number | null
  readonly actor: { readonly source: string; readonly id: string }
  readonly channel: { readonly source: string; readonly thread: string } | null
}

/** The bounded Eval candidate the Router reads. */
export interface EvalCandidateView {
  readonly evalId: string
  readonly threadId: string
  readonly threadLabel: string | null
  readonly strength: 'explicit' | 'inferred'
  readonly policyVersion: string
  readonly acceptMode: 'off' | 'observe' | 'auto'
  readonly status: string
  readonly triggers: readonly CandidateTriggerView[]
  readonly tickets: readonly { readonly id: string; readonly title: string; readonly mode: string }[]
}

/** Result of one Router decision. */
export interface EvalDecideView {
  readonly evalId: string
  readonly kind: 'accept' | 'stop' | 'ignore' | 'unavailable'
  readonly downgraded: boolean
  readonly ticketId: string | null
  readonly message: string
}

/** One explicit routing instruction (`quno_route`). */
export interface RouteItem {
  readonly triggerId: string
  readonly action: 'accept' | 'attach' | 'stop' | 'ignore'
  readonly ticketId?: string
  readonly title?: string
  readonly goal?: string
  readonly mode?: 'once' | 'persistent'
}

/** Result of one multi-item routing call. */
export interface RouteOutcome {
  readonly accepted: readonly string[]
  readonly attached: readonly string[]
  readonly stopped: readonly string[]
  readonly ignored: readonly string[]
  readonly errors: readonly { readonly index: number; readonly message: string }[]
}

/** What the preset tools rely on. */
export interface QunoServiceFace {
  /** Start one delegated Task from a Human Turn (idempotent per tool call). */
  startTask(
    input: { readonly title: string; readonly prompt: string; readonly plan?: string; readonly cwd?: string },
    parent: Agent,
    toolCallId?: string,
  ): Promise<TicketView>
  /** Read one Ticket's durable state. */
  getTask(taskId: string): TicketView
  /** The current Eval candidate (defaults are resolved by the tool). */
  evalCandidate(evalId?: string): EvalCandidateView | null
  /** Bounded object-graph read for a Human Turn (recent Triggers/Threads/Tickets). */
  readObjects(request: {
    readonly triggerId?: string
    readonly threadId?: string
    readonly ticketId?: string
    readonly limit?: number
  }): Record<string, unknown>
  /** Bounded object-graph read for one Eval. */
  evalRead(request: {
    readonly evalId?: string
    readonly triggerId?: string
    readonly threadId?: string
    readonly ticketId?: string
  }): Record<string, unknown> | null
  /** Submit the Eval decision. */
  evalDecide(input: {
    readonly evalId: string
    readonly kind: 'accept' | 'stop' | 'ignore' | 'unavailable'
    readonly reason?: string
    readonly title?: string
    readonly goal?: string
    readonly mode?: 'once' | 'persistent'
    readonly cwd?: string
  }): Promise<EvalDecideView>
  /** Apply 1–20 explicit routing instructions from a Human Turn. */
  routeCandidates(
    input: { readonly items: readonly RouteItem[] },
    parent: Agent,
    toolCallId: string,
  ): Promise<RouteOutcome>
  /** Add context/owned Thread subscriptions to a Ticket. */
  attachThreads(input: {
    readonly ticketId: string
    readonly threadIds: readonly string[]
    readonly mode?: 'owned' | 'context'
  }): { readonly attached: readonly string[] }
  /** Stop one Ticket from the conversation. */
  stopTicket(ticketId: string): TicketView
  /** Retry the executor work of one Ticket under the same Mandate. */
  retryTicket(ticketId: string): TicketView
  /** Write one note into a live Ticket. */
  noteTicket(ticketId: string, text: string): TicketView
  recall(request: RecallRequest): Promise<RecallResult>
  listAttention(statuses?: readonly string[]): readonly AttentionItemRecord[]
  actAttention(act: AttentionAct, channel: 'button' | 'natural'): Promise<AttentionItemRecord>
  mute(input: { readonly minutes?: number; readonly until?: string; readonly cancel?: boolean }): Promise<{ readonly mutedUntil: number | null }>
  statusSummary(): QunoStatusSummary
  /** Start one bounded asynchronous read for the Router; returns its id at once. */
  requestExchange(input: {
    readonly responder: string
    readonly kind?: 'request' | 'command'
    readonly payload: unknown
    readonly timeoutMs?: number
  }): { readonly requestId: string; readonly deadline: number; readonly message: string }
  /** Enqueue one proactive notification candidate produced by the Router. */
  notify(input: {
    readonly title: string
    readonly summary: string
    readonly body: string
    readonly why: string
    readonly topicKey?: string
    readonly itemIds?: readonly string[]
    readonly urgent?: boolean
  }): { readonly notificationId: string | null; readonly message: string }
}
