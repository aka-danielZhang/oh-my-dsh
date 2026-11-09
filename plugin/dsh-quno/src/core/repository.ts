/**
 * The persistence port the domain Engine writes through.
 *
 * The Engine never opens a database, never reads the clock and never performs
 * I/O itself: callers hand it a repository (the SQLite one in production, the
 * in-memory one in domain tests) and a timestamp. This keeps every transition
 * testable as a pure command and makes the "same transaction" rule explicit:
 * every Engine command runs inside the caller's transaction.
 *
 * Nothing here exposes SQL: the port is deliberately a small set of domain
 * reads and writes, so the SQLite and memory implementations cannot drift in
 * behaviour without the domain tests catching it.
 *
 * @module dsh-quno/core/repository
 */

import type {
  AssignmentRecord,
  AttentionLink,
  DecisionId,
  DecisionRecord,
  EffectKind,
  EffectRecord,
  EndpointId,
  EvalId,
  EvalRecord,
  EvalStatus,
  ExchangeId,
  ExchangeMessageRecord,
  ExchangeRecord,
  ExchangeStatus,
  InputAttemptRecord,
  InputId,
  InputKind,
  SubscriptionMode,
  SubscriptionOrigin,
  SubscriptionRecord,
  ThreadId,
  ThreadRecord,
  TicketId,
  TicketInputRecord,
  TicketRecord,
  TriggerId,
  TriggerRecord,
  WorkerRunRecord,
  WorkerRunStatus,
} from './model.ts'

/** One Eval enqueue payload. */
export interface EffectInput {
  readonly kind: EffectKind
  readonly key: string
  readonly payload: unknown
  readonly now: number
  /** Earliest execution instant; defaults to `now`. */
  readonly dueAt?: number
}

/** One list filter for Tickets. */
export interface TicketFilter {
  /** Only Tickets without an `ended` marker. */
  readonly open?: boolean
  readonly limit?: number
  /** Restrict to Tickets whose `origin` mentions this Trigger. */
  readonly triggerId?: TriggerId
}

/** One list filter for Evals. */
export interface EvalFilter {
  readonly threadId?: ThreadId
  readonly status?: readonly EvalStatus[]
  readonly limit?: number
}

/** One list filter for inputs. */
export interface InputFilter {
  /** Only inputs with no delivered assignment. */
  readonly undelivered?: boolean
  /** Only inputs whose `readAt` is null. */
  readonly unread?: boolean
  /** Only human-authored inputs. */
  readonly humanOnly?: boolean
  /** Only inputs not yet acknowledged by a Report or handback. */
  readonly unacknowledged?: boolean
  readonly limit?: number
}

/** The persistence port. */
export interface DomainRepository {
  /** Run `work` atomically. Implementations may join an enclosing transaction. */
  transaction<T>(work: () => T): T

  // ------------------------------------------------------------- triggers
  findTrigger(sourceId: string, eventKey: string): TriggerRecord | undefined
  getTrigger(id: TriggerId): TriggerRecord | undefined
  getTriggers(ids: readonly TriggerId[]): readonly TriggerRecord[]
  insertTrigger(trigger: TriggerRecord): void
  listTriggerIdsByThread(threadId: ThreadId, limit: number): readonly TriggerId[]
  markTriggerPruned(id: TriggerId, prunedAt: number): void
  /** Mark one Trigger as filtered by the Source scope (kept, never routed). */
  recordFiltered(triggerId: TriggerId, reason: string): void
  filteredReason(triggerId: TriggerId): string | null

  // -------------------------------------------------------------- threads
  getThread(id: ThreadId): ThreadRecord | undefined
  getThreadByKey(qunoId: string, sourceId: string, threadKey: string): ThreadRecord | undefined
  listThreads(qunoId: string, filter?: { readonly limit?: number; readonly withPending?: boolean; readonly sourceId?: string }): readonly ThreadRecord[]
  insertThread(thread: ThreadRecord): void
  updateThread(id: ThreadId, patch: Partial<Pick<ThreadRecord, 'label' | 'lastAt' | 'correlatedThreadIds' | 'activeEvalId' | 'expiredCount' | 'meta' | 'closed'>>): void
  /** Pending Trigger ids in queue order (oldest first). */
  listPendingTriggerIds(threadId: ThreadId, limit?: number): readonly TriggerId[]
  addPending(threadId: ThreadId, triggerId: TriggerId, at: number): void
  removePending(threadId: ThreadId, triggerId: TriggerId): void
  countPending(threadId: ThreadId): number

  // ---------------------------------------------------------------- evals
  insertEval(evalRecord: EvalRecord): void
  getEval(id: EvalId): EvalRecord | undefined
  updateEval(id: EvalId, patch: Partial<Pick<EvalRecord, 'status' | 'candidateMessageId' | 'deliveredAt' | 'deadline' | 'pausedAt' | 'expiryCount'>>): void
  findActiveEval(threadId: ThreadId): EvalRecord | undefined
  findEvalByCandidateMessage(messageId: string): EvalRecord | undefined
  listEvals(qunoId: string, filter?: EvalFilter): readonly EvalRecord[]
  /** Evals whose deadline passed and that are still open. */
  listTimedOutEvals(now: number, limit: number): readonly EvalRecord[]

  // ------------------------------------------------------------ decisions
  insertDecision(decision: DecisionRecord): void
  getDecision(id: DecisionId): DecisionRecord | undefined
  findDecisionByEval(evalId: EvalId): DecisionRecord | undefined
  findDecisionByTicket(ticketId: TicketId): DecisionRecord | undefined
  listDecisions(qunoId: string, limit: number): readonly DecisionRecord[]

  // -------------------------------------------------------------- tickets
  insertTicket(ticket: TicketRecord): void
  getTicket(id: TicketId): TicketRecord | undefined
  updateTicket(id: TicketId, patch: Partial<Pick<TicketRecord, 'title' | 'goal' | 'ended' | 'question' | 'channels' | 'mode' | 'updatedAt'>>): void
  listTickets(qunoId: string, filter?: TicketFilter): readonly TicketRecord[]
  findTicketByDecision(decisionId: DecisionId): TicketRecord | undefined

  // -------------------------------------------------------- subscriptions
  insertSubscription(subscription: SubscriptionRecord): void
  getSubscription(ticketId: TicketId, threadId: ThreadId): SubscriptionRecord | undefined
  listSubscriptionsByTicket(ticketId: TicketId): readonly SubscriptionRecord[]
  listSubscriptionsByThread(threadId: ThreadId): readonly SubscriptionRecord[]
  updateSubscription(id: string, patch: Partial<Pick<SubscriptionRecord, 'mode' | 'revision' | 'cancelledAt'>>): void

  // ---------------------------------------------------------- assignments
  insertAssignment(assignment: AssignmentRecord): void
  getAssignment(id: string): AssignmentRecord | undefined
  updateAssignment(id: string, patch: Partial<Pick<AssignmentRecord, 'state' | 'report' | 'deliveredAt' | 'idleAt' | 'endedReason' | 'directory'>>): void
  listAssignmentsByTicket(ticketId: TicketId): readonly AssignmentRecord[]
  findActiveAssignment(ticketId: TicketId): AssignmentRecord | undefined
  listAssignmentsByState(state: AssignmentRecord['state'], limit: number): readonly AssignmentRecord[]

  // ----------------------------------------------------------- worker runs
  insertWorkerRun(run: WorkerRunRecord): void
  getWorkerRun(id: string): WorkerRunRecord | undefined
  updateWorkerRun(id: string, patch: Partial<Pick<WorkerRunRecord, 'status' | 'leaseUntil' | 'turnId' | 'result' | 'error' | 'cost' | 'finishedAt' | 'inputIds'>>): void
  findRunningWorkerRun(assignmentId: string): WorkerRunRecord | undefined
  listWorkerRunsByAssignment(assignmentId: string): readonly WorkerRunRecord[]
  listOpenWorkerRuns(limit: number): readonly WorkerRunRecord[]
  countWorkerRuns(status: readonly WorkerRunStatus[]): number

  // ---------------------------------------------------------------- inputs
  insertInput(input: TicketInputRecord): void
  getInput(id: InputId): TicketInputRecord | undefined
  updateInput(id: InputId, patch: Partial<Pick<TicketInputRecord, 'deliveredTo' | 'deliveredAt' | 'readAt' | 'acknowledgedAt' | 'handedBackAt'>>): void
  listInputsByTicket(ticketId: TicketId, filter?: InputFilter): readonly TicketInputRecord[]
  listInputs(ids: readonly InputId[]): readonly TicketInputRecord[]
  findInputByTrigger(ticketId: TicketId, triggerId: TriggerId): TicketInputRecord | undefined

  // -------------------------------------------------------------- attempts
  insertInputAttempt(attempt: InputAttemptRecord): void
  updateInputAttempt(id: string, patch: Partial<Pick<InputAttemptRecord, 'status' | 'reason' | 'finishedAt' | 'messageId'>>): void
  findInputAttempt(inputId: InputId, attempt: number): InputAttemptRecord | undefined

  // ------------------------------------------------------------- exchanges
  insertExchange(exchange: ExchangeRecord): void
  getExchange(id: ExchangeId): ExchangeRecord | undefined
  updateExchange(id: ExchangeId, patch: Partial<Pick<ExchangeRecord, 'status' | 'responseMessageId' | 'attempts' | 'updatedAt'>>): void
  listExchanges(qunoId: string, filter?: { readonly status?: readonly ExchangeStatus[]; readonly limit?: number }): readonly ExchangeRecord[]
  listExchangesDue(now: number, limit: number): readonly ExchangeRecord[]
  insertExchangeMessage(message: ExchangeMessageRecord): void
  getExchangeMessages(exchangeId: ExchangeId): readonly ExchangeMessageRecord[]
  findExchangeMessageByHash(exchangeId: ExchangeId, kind: ExchangeMessageRecord['kind'], contentHash: string): ExchangeMessageRecord | undefined
  updateExchangeFields(id: ExchangeId, patch: Partial<Pick<ExchangeRecord, 'requester' | 'responder' | 'deadline'>>): void

  // --------------------------------------------------------------- effects
  enqueueEffect(input: EffectInput): EffectRecord
  listDueEffects(now: number, limit: number): readonly EffectRecord[]
  getEffect(kind: EffectKind, key: string): EffectRecord | undefined
  /** Remove a completed effect only when it is still the current generation. */
  completeEffect(kind: EffectKind, key: string, seq: number, generation: number): boolean
  /** Reschedule a failed effect only when it is still the current generation. */
  failEffect(kind: EffectKind, key: string, seq: number, generation: number, error: string, nextDueAt: number): boolean

  // -------------------------------------------------------------- attention
  linkAttention(link: AttentionLink & { readonly qunoId: string }): void
  listAttentionLinks(itemId: string): readonly AttentionLink[]
  listAttentionLinksByTarget(targetType: AttentionLink['targetType'], targetId: string): readonly AttentionLink[]

  // --------------------------------------------------------------- helpers
  /** One counter used for WorkerRun fences and diagnostics. */
  bumpCounter(name: string): number
}

/** Build the deterministic start cursor for a subscription (used by the app layer). */
export function subscriptionStartCursor(sourceId: string, origins: readonly SubscriptionOrigin[]): string {
  return `${sourceId}:${origins.join('+')}`
}

/** Reconciliation helper: whether a subscription accepts new Triggers on its Thread. */
export function subscriptionAccepts(subscription: SubscriptionRecord, triggerIngestSeq: number): boolean {
  if (subscription.cancelledAt !== null) return false
  return triggerIngestSeq > subscription.startIngestSeq
}

/** Whether a subscription is context-only (provides input, never owns a follow-up). */
export function contextOnly(mode: SubscriptionMode): boolean {
  return mode === 'context'
}

/** The stable input id for one Trigger into one Ticket. */
export function triggerInputId(ticketId: TicketId, triggerId: TriggerId): string {
  return `input_${ticketId}_trigger_${triggerId}`
}

/** The stable input id for one Exchange response into one Ticket. */
export function exchangeInputId(ticketId: TicketId, exchangeId: ExchangeId): string {
  return `input_${ticketId}_response_${exchangeId}`
}

/** The stable input id for one note into one Ticket (explicit revision keeps two notes distinct). */
export function noteInputId(ticketId: TicketId, revision: string): string {
  return `input_${ticketId}_note_${revision}`
}

/** Kind of a synthetic input. */
export function syntheticInputKind(kind: Exclude<InputKind, 'trigger' | 'response'>): InputKind {
  return kind
}

/** Endpoint of the assignee of one Ticket. */
export function assignmentEndpoint(sessionId: string): EndpointId {
  return `session:${sessionId}`
}
