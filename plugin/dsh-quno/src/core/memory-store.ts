/**
 * In-memory DomainRepository.
 *
 * It exists so the Engine's command semantics can be tested as a domain
 * problem: every write, idempotency rule, ordering and crash-window surrogate
 * is exercised here without SQLite. The SQLite repository must satisfy the
 * same port and the same tests; this implementation is the reference.
 *
 * Transactions are real: a throwing command restores the complete pre-write
 * state, so a partially applied command is never observable. Nested calls join
 * the outer transaction, mirroring the SQLite implementation.
 *
 * @module dsh-quno/core/memory-store
 */

import type {
  AssignmentRecord,
  AttentionLink,
  DecisionRecord,
  EffectRecord,
  EvalRecord,
  ExchangeMessageRecord,
  ExchangeRecord,
  InputAttemptRecord,
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
import type {
  DomainRepository,
  EvalFilter,
  InputFilter,
  TicketFilter,
} from './repository.ts'

interface PendingEntry {
  readonly triggerId: TriggerId
  readonly at: number
}

interface Snapshot {
  restore(): void
}

function keyOf(...parts: readonly (string | number)[]): string {
  return parts.join('\u0000')
}

/** Reference in-memory repository with transactional rollback. */
export class MemoryRepository implements DomainRepository {
  private triggers = new Map<string, TriggerRecord>()
  private triggerKeys = new Map<string, string>()
  private triggerOrder: string[] = []
  private filtered = new Map<string, string>()
  private threads = new Map<string, ThreadRecord>()
  private threadKeys = new Map<string, string>()
  private threadOrder: string[] = []
  private pending = new Map<string, PendingEntry[]>()
  private evals = new Map<string, EvalRecord>()
  private evalOrder: string[] = []
  private decisions = new Map<string, DecisionRecord>()
  private decisionOrder: string[] = []
  private tickets = new Map<string, TicketRecord>()
  private ticketOrder: string[] = []
  private subscriptions = new Map<string, SubscriptionRecord>()
  private subscriptionOrder: string[] = []
  private assignments = new Map<string, AssignmentRecord>()
  private assignmentOrder: string[] = []
  private runs = new Map<string, WorkerRunRecord>()
  private runOrder: string[] = []
  private inputs = new Map<string, TicketInputRecord>()
  private inputOrder: string[] = []
  private attempts = new Map<string, InputAttemptRecord>()
  private exchanges = new Map<string, ExchangeRecord>()
  private exchangeOrder: string[] = []
  private exchangeMessages = new Map<string, ExchangeMessageRecord>()
  private exchangeMessageOrder: string[] = []
  private effects = new Map<string, EffectRecord>()
  private attentionLinks: (AttentionLink & { readonly qunoId: string })[] = []
  private counters = new Map<string, number>()
  private depth = 0

  // --------------------------------------------------------------- helpers

  private snapshot(): Snapshot {
    const maps = {
      triggers: new Map(this.triggers),
      triggerKeys: new Map(this.triggerKeys),
      triggerOrder: [...this.triggerOrder],
      filtered: new Map(this.filtered),
      threads: new Map(this.threads),
      threadKeys: new Map(this.threadKeys),
      threadOrder: [...this.threadOrder],
      pending: new Map([...this.pending].map(([key, value]) => [key, [...value]])),
      evals: new Map(this.evals),
      evalOrder: [...this.evalOrder],
      decisions: new Map(this.decisions),
      decisionOrder: [...this.decisionOrder],
      tickets: new Map(this.tickets),
      ticketOrder: [...this.ticketOrder],
      subscriptions: new Map(this.subscriptions),
      subscriptionOrder: [...this.subscriptionOrder],
      assignments: new Map(this.assignments),
      assignmentOrder: [...this.assignmentOrder],
      runs: new Map(this.runs),
      runOrder: [...this.runOrder],
      inputs: new Map(this.inputs),
      inputOrder: [...this.inputOrder],
      attempts: new Map(this.attempts),
      exchanges: new Map(this.exchanges),
      exchangeOrder: [...this.exchangeOrder],
      exchangeMessages: new Map(this.exchangeMessages),
      exchangeMessageOrder: [...this.exchangeMessageOrder],
      effects: new Map(this.effects),
      attentionLinks: [...this.attentionLinks],
      counters: new Map(this.counters),
    }
    return {
      restore: () => {
        this.triggers = maps.triggers
        this.triggerKeys = maps.triggerKeys
        this.triggerOrder = maps.triggerOrder
        this.filtered = maps.filtered
        this.threads = maps.threads
        this.threadKeys = maps.threadKeys
        this.threadOrder = maps.threadOrder
        this.pending = maps.pending
        this.evals = maps.evals
        this.evalOrder = maps.evalOrder
        this.decisions = maps.decisions
        this.decisionOrder = maps.decisionOrder
        this.tickets = maps.tickets
        this.ticketOrder = maps.ticketOrder
        this.subscriptions = maps.subscriptions
        this.subscriptionOrder = maps.subscriptionOrder
        this.assignments = maps.assignments
        this.assignmentOrder = maps.assignmentOrder
        this.runs = maps.runs
        this.runOrder = maps.runOrder
        this.inputs = maps.inputs
        this.inputOrder = maps.inputOrder
        this.attempts = maps.attempts
        this.exchanges = maps.exchanges
        this.exchangeOrder = maps.exchangeOrder
        this.exchangeMessages = maps.exchangeMessages
        this.exchangeMessageOrder = maps.exchangeMessageOrder
        this.effects = maps.effects
        this.attentionLinks = maps.attentionLinks
        this.counters = maps.counters
      },
    }
  }

  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work()
    const snapshot = this.snapshot()
    this.depth += 1
    try {
      const value = work()
      this.depth -= 1
      return value
    } catch (error) {
      this.depth -= 1
      snapshot.restore()
      throw error
    }
  }

  // ------------------------------------------------------------- triggers

  findTrigger(sourceId: string, eventKey: string): TriggerRecord | undefined {
    const id = this.triggerKeys.get(keyOf(sourceId, eventKey))
    return id === undefined ? undefined : this.triggers.get(id)
  }

  getTrigger(id: TriggerId): TriggerRecord | undefined {
    return this.triggers.get(id)
  }

  getTriggers(ids: readonly TriggerId[]): readonly TriggerRecord[] {
    return ids.flatMap((id) => {
      const trigger = this.triggers.get(id)
      return trigger === undefined ? [] : [trigger]
    })
  }

  insertTrigger(trigger: TriggerRecord): void {
    this.triggers.set(trigger.id, trigger)
    this.triggerKeys.set(keyOf(trigger.sourceId, trigger.eventKey), trigger.id)
    this.triggerOrder.push(trigger.id)
  }

  listTriggerIdsByThread(threadId: ThreadId, limit: number): readonly TriggerId[] {
    const ids: TriggerId[] = []
    for (const id of this.triggerOrder) {
      const trigger = this.triggers.get(id)
      if (trigger === undefined) continue
      if (!trigger.threads.some(thread => thread.id === threadId)) continue
      ids.push(id)
      if (ids.length >= limit) break
    }
    return ids
  }

  markTriggerPruned(id: TriggerId, prunedAt: number): void {
    const trigger = this.triggers.get(id)
    if (trigger === undefined || trigger.prunedAt !== null) return
    this.triggers.set(id, { ...trigger, prunedAt })
  }

  recordFiltered(triggerId: TriggerId, reason: string): void {
    this.filtered.set(triggerId, reason)
  }

  filteredReason(triggerId: TriggerId): string | null {
    return this.filtered.get(triggerId) ?? null
  }

  // -------------------------------------------------------------- threads

  getThread(id: ThreadId): ThreadRecord | undefined {
    return this.threads.get(id)
  }

  getThreadByKey(qunoId: string, sourceId: string, threadKey: string): ThreadRecord | undefined {
    const id = this.threadKeys.get(keyOf(qunoId, sourceId, threadKey))
    return id === undefined ? undefined : this.threads.get(id)
  }

  listThreads(
    qunoId: string,
    filter: { readonly limit?: number; readonly withPending?: boolean; readonly sourceId?: string } = {},
  ): readonly ThreadRecord[] {
    const limit = filter.limit ?? 200
    const out: ThreadRecord[] = []
    for (const id of this.threadOrder) {
      const thread = this.threads.get(id)
      if (thread === undefined || thread.qunoId !== qunoId) continue
      if (filter.sourceId !== undefined && thread.sourceId !== filter.sourceId) continue
      if (filter.withPending === true && (this.pending.get(id)?.length ?? 0) === 0) continue
      out.push({ ...thread, pendingTriggerIds: (this.pending.get(id) ?? []).map(entry => entry.triggerId) })
      if (out.length >= limit) break
    }
    return out
  }

  insertThread(thread: ThreadRecord): void {
    this.threads.set(thread.id, thread)
    this.threadKeys.set(keyOf(thread.qunoId, thread.sourceId, thread.threadKey), thread.id)
    this.threadOrder.push(thread.id)
    this.pending.set(thread.id, [])
  }

  updateThread(
    id: ThreadId,
    patch: Partial<Pick<ThreadRecord, 'label' | 'lastAt' | 'correlatedThreadIds' | 'activeEvalId' | 'expiredCount' | 'meta' | 'closed'>>,
  ): void {
    const thread = this.threads.get(id)
    if (thread === undefined) return
    this.threads.set(id, { ...thread, ...patch })
  }

  listPendingTriggerIds(threadId: ThreadId, limit = 1000): readonly TriggerId[] {
    return (this.pending.get(threadId) ?? []).slice(0, limit).map(entry => entry.triggerId)
  }

  addPending(threadId: ThreadId, triggerId: TriggerId, at: number): void {
    const queue = this.pending.get(threadId) ?? []
    if (queue.some(entry => entry.triggerId === triggerId)) return
    queue.push({ triggerId, at })
    this.pending.set(threadId, queue)
  }

  removePending(threadId: ThreadId, triggerId: TriggerId): void {
    const queue = this.pending.get(threadId)
    if (queue === undefined) return
    this.pending.set(threadId, queue.filter(entry => entry.triggerId !== triggerId))
  }

  countPending(threadId: ThreadId): number {
    return this.pending.get(threadId)?.length ?? 0
  }

  // ---------------------------------------------------------------- evals

  insertEval(evalRecord: EvalRecord): void {
    this.evals.set(evalRecord.id, evalRecord)
    this.evalOrder.push(evalRecord.id)
  }

  getEval(id: string): EvalRecord | undefined {
    return this.evals.get(id)
  }

  updateEval(
    id: string,
    patch: Partial<Pick<EvalRecord, 'status' | 'candidateMessageId' | 'deliveredAt' | 'deadline' | 'pausedAt' | 'expiryCount'>>,
  ): void {
    const evalRecord = this.evals.get(id)
    if (evalRecord === undefined) return
    this.evals.set(id, { ...evalRecord, ...patch })
  }

  findActiveEval(threadId: ThreadId): EvalRecord | undefined {
    for (const id of this.evalOrder) {
      const evalRecord = this.evals.get(id)
      if (evalRecord === undefined || evalRecord.threadId !== threadId) continue
      if (evalRecord.status === 'delivering' || evalRecord.status === 'waiting-decision') return evalRecord
    }
    return undefined
  }

  findEvalByCandidateMessage(messageId: string): EvalRecord | undefined {
    for (const id of this.evalOrder) {
      const evalRecord = this.evals.get(id)
      if (evalRecord !== undefined && evalRecord.candidateMessageId === messageId) return evalRecord
    }
    return undefined
  }

  listEvals(qunoId: string, filter: EvalFilter = {}): readonly EvalRecord[] {
    const out: EvalRecord[] = []
    const limit = filter.limit ?? 100
    for (let index = this.evalOrder.length - 1; index >= 0; index -= 1) {
      const id = this.evalOrder[index]
      if (id === undefined) continue
      const evalRecord = this.evals.get(id)
      if (evalRecord === undefined || evalRecord.qunoId !== qunoId) continue
      if (filter.threadId !== undefined && evalRecord.threadId !== filter.threadId) continue
      if (filter.status !== undefined && !filter.status.includes(evalRecord.status)) continue
      out.push(evalRecord)
      if (out.length >= limit) break
    }
    return out
  }

  listTimedOutEvals(now: number, limit: number): readonly EvalRecord[] {
    const out: EvalRecord[] = []
    for (const id of this.evalOrder) {
      const evalRecord = this.evals.get(id)
      if (evalRecord === undefined) continue
      if (evalRecord.status !== 'delivering' && evalRecord.status !== 'waiting-decision') continue
      if (evalRecord.deliveredAt === null || evalRecord.pausedAt !== null) continue
      if (evalRecord.deadline >= now) continue
      out.push(evalRecord)
      if (out.length >= limit) break
    }
    return out
  }

  // ------------------------------------------------------------ decisions

  insertDecision(decision: DecisionRecord): void {
    this.decisions.set(decision.id, decision)
    this.decisionOrder.push(decision.id)
  }

  getDecision(id: string): DecisionRecord | undefined {
    return this.decisions.get(id)
  }

  findDecisionByEval(evalId: string): DecisionRecord | undefined {
    for (const id of this.decisionOrder) {
      const decision = this.decisions.get(id)
      if (decision !== undefined && decision.evalId === evalId) return decision
    }
    return undefined
  }

  findDecisionByTicket(ticketId: string): DecisionRecord | undefined {
    for (const id of this.decisionOrder) {
      const decision = this.decisions.get(id)
      if (decision !== undefined && decision.ticketId === ticketId) return decision
    }
    return undefined
  }

  listDecisions(qunoId: string, limit: number): readonly DecisionRecord[] {
    const out: DecisionRecord[] = []
    for (let index = this.decisionOrder.length - 1; index >= 0; index -= 1) {
      const id = this.decisionOrder[index]
      if (id === undefined) continue
      const decision = this.decisions.get(id)
      if (decision === undefined || decision.qunoId !== qunoId) continue
      out.push(decision)
      if (out.length >= limit) break
    }
    return out
  }

  // -------------------------------------------------------------- tickets

  insertTicket(ticket: TicketRecord): void {
    this.tickets.set(ticket.id, ticket)
    this.ticketOrder.push(ticket.id)
  }

  getTicket(id: TicketId): TicketRecord | undefined {
    return this.tickets.get(id)
  }

  updateTicket(
    id: TicketId,
    patch: Partial<Pick<TicketRecord, 'title' | 'goal' | 'ended' | 'question' | 'channels' | 'mode' | 'updatedAt'>>,
  ): void {
    const ticket = this.tickets.get(id)
    if (ticket === undefined) return
    this.tickets.set(id, { ...ticket, ...patch })
  }

  listTickets(qunoId: string, filter: TicketFilter = {}): readonly TicketRecord[] {
    const limit = filter.limit ?? 200
    const out: TicketRecord[] = []
    for (let index = this.ticketOrder.length - 1; index >= 0; index -= 1) {
      const id = this.ticketOrder[index]
      if (id === undefined) continue
      const ticket = this.tickets.get(id)
      if (ticket === undefined || ticket.qunoId !== qunoId) continue
      if (filter.open === true && ticket.ended !== null) continue
      if (filter.triggerId !== undefined && ticket.origin.triggerId !== filter.triggerId && !ticket.origin.triggerIds.includes(filter.triggerId)) continue
      out.push(ticket)
      if (out.length >= limit) break
    }
    return out
  }

  findTicketByDecision(decisionId: string): TicketRecord | undefined {
    for (const id of this.ticketOrder) {
      const ticket = this.tickets.get(id)
      if (ticket !== undefined && ticket.decisionId === decisionId) return ticket
    }
    return undefined
  }

  // -------------------------------------------------------- subscriptions

  insertSubscription(subscription: SubscriptionRecord): void {
    this.subscriptions.set(subscription.id, subscription)
    this.subscriptionOrder.push(subscription.id)
  }

  getSubscription(ticketId: TicketId, threadId: ThreadId): SubscriptionRecord | undefined {
    for (const id of this.subscriptionOrder) {
      const subscription = this.subscriptions.get(id)
      if (subscription !== undefined && subscription.ticketId === ticketId && subscription.threadId === threadId) return subscription
    }
    return undefined
  }

  listSubscriptionsByTicket(ticketId: TicketId): readonly SubscriptionRecord[] {
    return this.subscriptionOrder.flatMap((id) => {
      const subscription = this.subscriptions.get(id)
      return subscription !== undefined && subscription.ticketId === ticketId ? [subscription] : []
    })
  }

  listSubscriptionsByThread(threadId: ThreadId): readonly SubscriptionRecord[] {
    return this.subscriptionOrder.flatMap((id) => {
      const subscription = this.subscriptions.get(id)
      return subscription !== undefined && subscription.threadId === threadId ? [subscription] : []
    })
  }

  updateSubscription(id: string, patch: Partial<Pick<SubscriptionRecord, 'mode' | 'revision' | 'cancelledAt'>>): void {
    const subscription = this.subscriptions.get(id)
    if (subscription === undefined) return
    this.subscriptions.set(id, { ...subscription, ...patch })
  }

  // ---------------------------------------------------------- assignments

  insertAssignment(assignment: AssignmentRecord): void {
    this.assignments.set(assignment.id, assignment)
    this.assignmentOrder.push(assignment.id)
  }

  getAssignment(id: string): AssignmentRecord | undefined {
    return this.assignments.get(id)
  }

  updateAssignment(
    id: string,
    patch: Partial<Pick<AssignmentRecord, 'state' | 'report' | 'deliveredAt' | 'idleAt' | 'endedReason' | 'directory'>>,
  ): void {
    const assignment = this.assignments.get(id)
    if (assignment === undefined) return
    this.assignments.set(id, { ...assignment, ...patch })
  }

  listAssignmentsByTicket(ticketId: TicketId): readonly AssignmentRecord[] {
    return this.assignmentOrder.flatMap((id) => {
      const assignment = this.assignments.get(id)
      return assignment !== undefined && assignment.ticketId === ticketId ? [assignment] : []
    })
  }

  findActiveAssignment(ticketId: TicketId): AssignmentRecord | undefined {
    for (let index = this.assignmentOrder.length - 1; index >= 0; index -= 1) {
      const id = this.assignmentOrder[index]
      if (id === undefined) continue
      const assignment = this.assignments.get(id)
      if (assignment === undefined || assignment.ticketId !== ticketId) continue
      if (assignment.state !== 'ended') return assignment
    }
    return undefined
  }

  listAssignmentsByState(state: AssignmentRecord['state'], limit: number): readonly AssignmentRecord[] {
    const out: AssignmentRecord[] = []
    for (const id of this.assignmentOrder) {
      const assignment = this.assignments.get(id)
      if (assignment === undefined || assignment.state !== state) continue
      out.push(assignment)
      if (out.length >= limit) break
    }
    return out
  }

  // ----------------------------------------------------------- worker runs

  insertWorkerRun(run: WorkerRunRecord): void {
    this.runs.set(run.id, run)
    this.runOrder.push(run.id)
  }

  getWorkerRun(id: string): WorkerRunRecord | undefined {
    return this.runs.get(id)
  }

  updateWorkerRun(
    id: string,
    patch: Partial<Pick<WorkerRunRecord, 'status' | 'leaseUntil' | 'turnId' | 'result' | 'error' | 'cost' | 'finishedAt' | 'inputIds'>>,
  ): void {
    const run = this.runs.get(id)
    if (run === undefined) return
    this.runs.set(id, { ...run, ...patch })
  }

  findRunningWorkerRun(assignmentId: string): WorkerRunRecord | undefined {
    for (let index = this.runOrder.length - 1; index >= 0; index -= 1) {
      const id = this.runOrder[index]
      if (id === undefined) continue
      const run = this.runs.get(id)
      if (run === undefined || run.assignmentId !== assignmentId) continue
      if (run.status === 'prepared' || run.status === 'running') return run
    }
    return undefined
  }

  listWorkerRunsByAssignment(assignmentId: string): readonly WorkerRunRecord[] {
    return this.runOrder.flatMap((id) => {
      const run = this.runs.get(id)
      return run !== undefined && run.assignmentId === assignmentId ? [run] : []
    })
  }

  listOpenWorkerRuns(limit: number): readonly WorkerRunRecord[] {
    const out: WorkerRunRecord[] = []
    for (const id of this.runOrder) {
      const run = this.runs.get(id)
      if (run === undefined) continue
      if (run.status !== 'prepared' && run.status !== 'running') continue
      out.push(run)
      if (out.length >= limit) break
    }
    return out
  }

  countWorkerRuns(status: readonly WorkerRunStatus[]): number {
    let count = 0
    for (const run of this.runs.values()) {
      if (status.includes(run.status)) count += 1
    }
    return count
  }

  // ---------------------------------------------------------------- inputs

  insertInput(input: TicketInputRecord): void {
    this.inputs.set(input.id, input)
    this.inputOrder.push(input.id)
  }

  getInput(id: string): TicketInputRecord | undefined {
    return this.inputs.get(id)
  }

  updateInput(
    id: string,
    patch: Partial<Pick<TicketInputRecord, 'deliveredTo' | 'deliveredAt' | 'readAt' | 'acknowledgedAt' | 'handedBackAt'>>,
  ): void {
    const input = this.inputs.get(id)
    if (input === undefined) return
    this.inputs.set(id, { ...input, ...patch })
  }

  listInputsByTicket(ticketId: TicketId, filter: InputFilter = {}): readonly TicketInputRecord[] {
    const limit = filter.limit ?? 200
    const out: TicketInputRecord[] = []
    for (const id of this.inputOrder) {
      const input = this.inputs.get(id)
      if (input === undefined || input.ticketId !== ticketId) continue
      if (filter.undelivered === true && input.deliveredAt !== null) continue
      if (filter.unread === true && input.readAt !== null) continue
      if (filter.humanOnly === true && !input.human) continue
      if (filter.unacknowledged === true && input.acknowledgedAt !== null) continue
      out.push(input)
      if (out.length >= limit) break
    }
    return out
  }

  listInputs(ids: readonly string[]): readonly TicketInputRecord[] {
    return ids.flatMap((id) => {
      const input = this.inputs.get(id)
      return input === undefined ? [] : [input]
    })
  }

  findInputByTrigger(ticketId: TicketId, triggerId: TriggerId): TicketInputRecord | undefined {
    for (const id of this.inputOrder) {
      const input = this.inputs.get(id)
      if (input !== undefined && input.ticketId === ticketId && input.triggerId === triggerId) return input
    }
    return undefined
  }

  // -------------------------------------------------------------- attempts

  insertInputAttempt(attempt: InputAttemptRecord): void {
    this.attempts.set(keyOf(attempt.inputId, attempt.attempt), attempt)
  }

  updateInputAttempt(
    id: string,
    patch: Partial<Pick<InputAttemptRecord, 'status' | 'reason' | 'finishedAt' | 'messageId'>>,
  ): void {
    for (const [key, attempt] of this.attempts) {
      if (attempt.id !== id) continue
      this.attempts.set(key, { ...attempt, ...patch })
      return
    }
  }

  findInputAttempt(inputId: string, attempt: number): InputAttemptRecord | undefined {
    return this.attempts.get(keyOf(inputId, attempt))
  }

  // ------------------------------------------------------------- exchanges

  insertExchange(exchange: ExchangeRecord): void {
    this.exchanges.set(exchange.id, exchange)
    this.exchangeOrder.push(exchange.id)
  }

  getExchange(id: string): ExchangeRecord | undefined {
    return this.exchanges.get(id)
  }

  updateExchange(
    id: string,
    patch: Partial<Pick<ExchangeRecord, 'status' | 'responseMessageId' | 'attempts' | 'updatedAt'>>,
  ): void {
    const exchange = this.exchanges.get(id)
    if (exchange === undefined) return
    this.exchanges.set(id, { ...exchange, ...patch })
  }

  listExchanges(
    qunoId: string,
    filter: { readonly status?: readonly ExchangeRecord['status'][]; readonly limit?: number } = {},
  ): readonly ExchangeRecord[] {
    const limit = filter.limit ?? 100
    const out: ExchangeRecord[] = []
    for (let index = this.exchangeOrder.length - 1; index >= 0; index -= 1) {
      const id = this.exchangeOrder[index]
      if (id === undefined) continue
      const exchange = this.exchanges.get(id)
      if (exchange === undefined || exchange.qunoId !== qunoId) continue
      if (filter.status !== undefined && !filter.status.includes(exchange.status)) continue
      out.push(exchange)
      if (out.length >= limit) break
    }
    return out
  }

  listExchangesDue(now: number, limit: number): readonly ExchangeRecord[] {
    const out: ExchangeRecord[] = []
    for (const id of this.exchangeOrder) {
      const exchange = this.exchanges.get(id)
      if (exchange === undefined) continue
      if (exchange.status !== 'pending' && exchange.status !== 'delivered') continue
      if (exchange.deadline >= now) continue
      out.push(exchange)
      if (out.length >= limit) break
    }
    return out
  }

  insertExchangeMessage(message: ExchangeMessageRecord): void {
    this.exchangeMessages.set(message.id, message)
    this.exchangeMessageOrder.push(message.id)
  }

  getExchangeMessages(exchangeId: string): readonly ExchangeMessageRecord[] {
    return this.exchangeMessageOrder.flatMap((id) => {
      const message = this.exchangeMessages.get(id)
      return message !== undefined && message.exchangeId === exchangeId ? [message] : []
    })
  }

  findExchangeMessageByHash(exchangeId: string, kind: ExchangeMessageRecord['kind'], contentHash: string): ExchangeMessageRecord | undefined {
    for (const id of this.exchangeMessageOrder) {
      const message = this.exchangeMessages.get(id)
      if (message === undefined) continue
      if (message.exchangeId === exchangeId && message.kind === kind && message.contentHash === contentHash) return message
    }
    return undefined
  }

  updateExchangeFields(
    id: string,
    patch: Partial<Pick<ExchangeRecord, 'requester' | 'responder' | 'deadline'>>,
  ): void {
    const exchange = this.exchanges.get(id)
    if (exchange === undefined) return
    this.exchanges.set(id, { ...exchange, ...patch })
  }

  // --------------------------------------------------------------- effects

  enqueueEffect(input: { readonly kind: EffectRecord['kind']; readonly key: string; readonly payload: unknown; readonly now: number; readonly dueAt?: number }): EffectRecord {
    const key = keyOf(input.kind, input.key)
    const existing = this.effects.get(key)
    const record: EffectRecord = {
      kind: input.kind,
      key: input.key,
      payload: input.payload,
      seq: (existing?.seq ?? 0) + 1,
      generation: (existing?.generation ?? 0) + 1,
      attempts: 0,
      dueAt: input.dueAt ?? input.now,
      since: existing?.since ?? input.now,
      lastError: null,
    }
    this.effects.set(key, record)
    return record
  }

  listDueEffects(now: number, limit: number): readonly EffectRecord[] {
    return [...this.effects.values()]
      .filter(effect => effect.dueAt <= now)
      .sort((left, right) => left.dueAt - right.dueAt || left.seq - right.seq)
      .slice(0, limit)
  }

  getEffect(kind: EffectRecord['kind'], key: string): EffectRecord | undefined {
    return this.effects.get(keyOf(kind, key))
  }

  completeEffect(kind: EffectRecord['kind'], key: string, seq: number, generation: number): boolean {
    const handle = keyOf(kind, key)
    const effect = this.effects.get(handle)
    if (effect === undefined || effect.seq !== seq || effect.generation !== generation) return false
    this.effects.delete(handle)
    return true
  }

  failEffect(kind: EffectRecord['kind'], key: string, seq: number, generation: number, error: string, nextDueAt: number): boolean {
    const handle = keyOf(kind, key)
    const effect = this.effects.get(handle)
    if (effect === undefined || effect.seq !== seq || effect.generation !== generation) return false
    this.effects.set(handle, { ...effect, attempts: effect.attempts + 1, lastError: error, dueAt: nextDueAt })
    return true
  }

  // ------------------------------------------------------------- attention

  linkAttention(link: AttentionLink & { readonly qunoId: string }): void {
    if (this.attentionLinks.some(item => item.itemId === link.itemId && item.targetType === link.targetType && item.targetId === link.targetId)) return
    this.attentionLinks.push(link)
  }

  listAttentionLinks(itemId: string): readonly AttentionLink[] {
    return this.attentionLinks.filter(link => link.itemId === itemId)
  }

  listAttentionLinksByTarget(targetType: AttentionLink['targetType'], targetId: string): readonly AttentionLink[] {
    return this.attentionLinks.filter(link => link.targetType === targetType && link.targetId === targetId)
  }

  // --------------------------------------------------------------- helpers

  bumpCounter(name: string): number {
    const next = (this.counters.get(name) ?? 0) + 1
    this.counters.set(name, next)
    return next
  }
}
