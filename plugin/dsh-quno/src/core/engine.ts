/**
 * The Engine: the only writer of Trigger, Thread, Eval, Decision, Mandate,
 * Ticket, Assignment, WorkerRun, TicketInput, Subscription and Exchange state.
 *
 * Every command runs inside the caller's transaction. A command that returns
 * normally has produced exactly one consistent domain fact; a command that
 * throws has left the previous fact alone. Post-commit work (model delivery,
 * process launch, external sends) is never performed here: the Engine only
 * enqueues a durable Effect, which the runtime executes after the commit.
 *
 * Role-specific interfaces keep the callable surface honest:
 *
 * - organs  produce Triggers and complete Exchanges;
 * - the Router decides Evals, accepts direct work and attaches threads;
 * - people stop/retry/re-evaluate a Ticket;
 * - an executor reports progress and reads its own inputs;
 * - settings changes write policy inputs and re-rank pending Evals.
 *
 * @module dsh-quno/core/engine
 */

import {
  assignmentIdForTicket,
  boundedCorrelationKeys,
  evalIsActive,
  evalMessageRequestId,
  fallbackThreadKey,
  inputIdFor,
  mergeCorrelation,
  primaryThreadOf,
  QunoConflictError,
  QunoStateError,
  reportIsTerminalResult,
  routerEndpoint,
  ticketEndpoint,
  ticketIdForEval,
  ticketInputIdForTrigger,
  threadRowId,
  hashToken,
  stableStringify,
} from './model.ts'
import type {
  ActorRef,
  AssignmentRecord,
  ChannelRef,
  DecisionId,
  DecisionKind,
  DecisionRecord,
  DeliveryMode,
  EvalId,
  EvalRecord,
  EvalStatus,
  ExchangeId,
  ExchangeKind,
  ExchangeMessageRecord,
  ExchangeRecord,
  InputKind,
  Mandate,
  MandateCli,
  PolicySnapshot,
  ReportState,
  SubscriptionMode,
  SubscriptionOrigin,
  SubscriptionRecord,
  ThreadId,
  ThreadRecord,
  ThreadRef,
  TicketId,
  TicketInputRecord,
  TicketRecord,
  TriggerDraft,
  TriggerId,
  TriggerRecord,
  WorkerReport,
  WorkerRunRecord,
} from './model.ts'
import { noteInputId, triggerInputId } from './repository.ts'
import type { DomainRepository, EffectInput } from './repository.ts'
import type { PolicyRule } from './policy.ts'

/** One config/policy snapshot the Engine needs. */
export interface EnginePolicyState {
  readonly configRevision: number
  readonly paused: boolean
  readonly acceptMode: 'off' | 'observe' | 'auto'
  readonly evalTimeoutMs: number
  readonly rules: readonly PolicyRule[]
}

/** Everything the Engine needs from its composition root. */
export interface EngineDeps {
  readonly repo: DomainRepository
  readonly qunoId: string
  readonly policy: () => EnginePolicyState
  readonly policySnapshot?: (state: EnginePolicyState) => PolicySnapshot
  readonly nextId: (prefix: string) => string
  readonly defaultCwd: string
  /** Source scope filter (absence = admit all). */
  readonly filterTrigger?: (trigger: TriggerRecord) => { readonly filtered: boolean; readonly reason: string | null }
  /**
   * The structured read-only CLI grant a newly accepted Ticket receives. Read
   * as a snapshot at accept time; absence grants nothing.
   */
  readonly cliGrant?: () => MandateCli
  readonly logger?: { warn(message: string): void }
}

/** Result of one intake command. */
export interface ReceiveOutcome {
  readonly status: 'accepted' | 'duplicate' | 'filtered'
  readonly triggerId: TriggerId
  readonly threadIds: readonly ThreadId[]
  readonly evalRequested: boolean
  readonly inputIds: readonly string[]
  readonly followupOwners: readonly TicketId[]
}

/** What the Router supplies when accepting an Eval. */
export interface AcceptDecisionInput {
  readonly evalId: EvalId
  readonly title: string
  readonly goal: string
  readonly mode?: 'once' | 'persistent'
  readonly cwd?: string
  readonly persistent?: boolean
  readonly now: number
}

/** One Eval decision command. */
export interface EvalDecisionInput {
  readonly evalId: EvalId
  readonly kind: DecisionKind
  readonly reason: string | null
  readonly title?: string
  readonly goal?: string
  readonly mode?: 'once' | 'persistent'
  readonly persistent?: boolean
  readonly cwd?: string
  readonly now: number
}

/** Result of one decision. */
export interface EvalDecisionOutcome {
  readonly decision: DecisionRecord
  readonly ticket: TicketRecord | null
  readonly downgraded: boolean
}

/** Direct human acceptance (permanent-conversation tool call). */
export interface DirectAcceptInput {
  readonly sessionId: string
  readonly messageId: string
  readonly toolCallId: string
  readonly title: string
  readonly goal: string
  readonly mode?: 'once' | 'persistent'
  readonly cwd?: string
  readonly now: number
}

/** One thread closed report. */
export interface ThreadClosedInput {
  readonly threadId: ThreadId
  readonly outcome: string
  readonly at: number
  readonly now: number
}

/** Worker report command. */
export interface WorkerReportInput {
  readonly assignmentId: string
  readonly report: WorkerReport
  readonly now: number
}

/** Result of a report. */
export interface WorkerReportOutcome {
  readonly ticket: TicketRecord
  readonly ended: boolean
  readonly relayed: boolean
}

/** Handback command. */
export interface HandbackInput {
  readonly ticketId: TicketId
  readonly triggerId: TriggerId
  readonly assignmentId: string
  readonly reason: string | null
  readonly now: number
}

/** Result of one handback. */
export interface HandbackOutcome {
  readonly handedBack: boolean
  readonly returnedToEval: boolean
  readonly remainingOwners: readonly TicketId[]
}

/** Exchange request from the Router or a Worker. */
export interface ExchangeRequestInput {
  readonly kind: ExchangeKind
  readonly requester: string
  readonly responder: string
  readonly payload: unknown
  readonly deadlineMs: number
  readonly ticketId?: TicketId
  readonly now: number
}

/** Result of an exchange completion. */
export interface ExchangeCompleteOutcome {
  readonly exchange: ExchangeRecord
  readonly late: boolean
  readonly inputId: string | null
}

/** Counts reported by one pass. */
export interface PassOutcome {
  readonly opened: number
  readonly expired: number
  readonly resumed: number
  readonly closedThreads: number
}

/** The Engine. Use the role-specific sub-interfaces in composition code. */
export class Engine {
  private readonly repo: DomainRepository

  constructor(private readonly deps: EngineDeps) {
    this.repo = deps.repo
  }

  // ---------------------------------------------------------------- policy

  /** The policy snapshot currently in force. */
  policySnapshot(): PolicySnapshot {
    const state = this.deps.policy()
    if (this.deps.policySnapshot !== undefined) return this.deps.policySnapshot(state)
    // Lazy import avoidance: the composition root normally injects the
    // snapshot builder; this fallback keeps `off` conservative.
    return {
      version: `v${String(state.configRevision)}`,
      paused: state.paused,
      acceptMode: state.acceptMode,
      evalTimeoutMs: state.evalTimeoutMs,
      gate: () => ({ admissible: state.acceptMode === 'auto', strength: 'inferred', basis: null, reason: null }),
      revalidate: () => ({ valid: false, reason: 'policy snapshot builder is not configured' }),
      admitsInferred: () => state.acceptMode === 'auto',
    }
  }

  // ------------------------------------------------------------- receiving

  /**
   * The only domain receive command. Called inside the caller's transaction
   * (one Sense batch = one transaction) so "received but never routed" cannot
   * survive a crash.
   */
  receive(draft: TriggerDraft, now: number): ReceiveOutcome {
    return this.repo.transaction(() => this.receiveInTransaction(draft, now))
  }

  private receiveInTransaction(draft: TriggerDraft, now: number): ReceiveOutcome {
    const existing = this.repo.findTrigger(draft.sourceId, draft.eventKey)
    if (existing !== undefined) {
      if (existing.contentHash !== draft.contentHash) {
        throw new QunoConflictError(
          'identity-conflict',
          `trigger "${draft.eventKey}" already exists with different content`,
        )
      }
      return {
        status: 'duplicate',
        triggerId: existing.id,
        threadIds: existing.threads.map(thread => thread.id),
        evalRequested: false,
        inputIds: [],
        followupOwners: [],
      }
    }

    const threadRefs = normalizeThreadRefs(draft.threads, draft.eventKey)
    if (threadRefs.length === 0) {
      throw new QunoStateError('thread-unresolved', 'a Trigger must resolve at least one Thread')
    }
    const trigger: TriggerRecord = {
      id: draft.id ?? this.deps.nextId('evt'),
      qunoId: this.deps.qunoId,
      sourceId: draft.sourceId,
      eventKey: draft.eventKey,
      type: draft.type,
      schema: draft.schema,
      threads: threadRefs,
      actor: draft.actor,
      human: draft.human,
      addressed: draft.addressed,
      occurredAt: draft.occurredAt,
      observedAt: draft.observedAt,
      receivedAt: draft.receivedAt,
      summary: draft.summary,
      data: draft.data,
      contentRef: draft.contentRef,
      channel: draft.channel,
      operation: draft.operation,
      priority: draft.priority,
      deadline: draft.deadline,
      correlationKeys: boundedCorrelationKeys(draft.correlationKeys),
      supersedesTriggerIds: draft.supersedesTriggerIds,
      parentTriggerIds: draft.parentTriggerIds,
      provenance: draft.provenance,
      contentHash: draft.contentHash,
      configRevision: draft.configRevision,
      expiresAt: draft.expiresAt,
      prunedAt: null,
    }
    this.repo.insertTrigger(trigger)

    const threads = threadRefs.map(ref => this.ensureThread(ref, trigger, now))
    const primary = threads[0]
    if (primary === undefined) throw new QunoStateError('thread-unresolved', 'primary Thread missing')
    this.updateCorrelation(threads, trigger.id)

    const filtered = this.deps.filterTrigger?.(trigger)
    if (filtered?.filtered === true) {
      this.repo.recordFiltered(trigger.id, filtered.reason ?? 'filtered by source scope')
      return {
        status: 'filtered',
        triggerId: trigger.id,
        threadIds: threads.map(thread => thread.id),
        evalRequested: false,
        inputIds: [],
        followupOwners: [],
      }
    }

    const policy = this.policySnapshot()
    const liveTickets = this.openTicketsForThreads(threads)
    const followupOwners: TicketId[] = []
    const ownedInputTickets = new Set<TicketId>()
    const inputIds: string[] = []
    const effectKeys: EffectInput[] = []

    for (const thread of threads) {
      const subscriptions = this.repo.listSubscriptionsByThread(thread.id)
      for (const subscription of subscriptions) {
        if (subscription.cancelledAt !== null) continue
        const ticket = this.repo.getTicket(subscription.ticketId)
        if (ticket === undefined) continue

        let liveTicket = ticket
        if (ticket.ended !== null) {
          // A stopped ticket never accepts new input; a source-ended ticket may
          // be resumed by an owned human follow-up under the SAME mandate, and
          // only when the policy still authorizes it. Bot/CI traffic never
          // revives an ended ticket.
          const resumable = subscription.mode === 'owned'
            && trigger.human
            && ticket.ended.by !== 'human'
            && canResumeTicket(ticket)
          const validity = resumable ? policy.revalidate(ticket.mandate) : { valid: false, reason: 'not resumable' }
          if (!resumable || !validity.valid) continue
          this.repo.updateTicket(ticket.id, { ended: null, updatedAt: now })
          this.repo.updateSubscription(subscription.id, {
            revision: subscription.revision + 1,
            cancelledAt: null,
          })
          this.resumeTicketWork(ticket.id, trigger.id, now)
          const resumed = this.repo.getTicket(ticket.id)
          if (resumed === undefined) continue
          liveTicket = resumed
        }

        const inputId = triggerInputId(liveTicket.id, trigger.id)
        if (this.repo.getInput(inputId) === undefined) {
          const input: TicketInputRecord = {
            id: inputId,
            qunoId: this.deps.qunoId,
            ticketId: liveTicket.id,
            kind: 'trigger',
            triggerId: trigger.id,
            exchangeId: null,
            human: trigger.human,
            context: subscription.mode === 'context',
            text: trigger.summary,
            createdAt: now,
            deliveredTo: null,
            deliveredAt: null,
            readAt: null,
            acknowledgedAt: null,
            handedBackAt: null,
          }
          this.repo.insertInput(input)
          inputIds.push(input.id)
          effectKeys.push({ kind: 'input-delivery', key: liveTicket.id, payload: { ticketId: liveTicket.id }, now })
        }
        if (subscription.mode === 'owned') {
          const recorded = this.repo.getInput(inputId)
          if (recorded !== undefined && recorded.handedBackAt === null) {
            ownedInputTickets.add(liveTicket.id)
            if (trigger.human) followupOwners.push(liveTicket.id)
          }
        }
      }
    }

    // Follow-up ownership suppresses the Eval: the owning executors judge the
    // message. Bot/CI input on a live owned subscription is handled by that
    // executor too (it can never revive an ended Ticket). Only when no live
    // executor owns the Thread does the batch fall back to Eval.
    const evalRequested = ownedInputTickets.size === 0
    if (evalRequested) {
      const active = this.repo.findActiveEval(primary.id)
      this.repo.addPending(primary.id, trigger.id, now)
      if (active === undefined) {
        effectKeys.push({ kind: 'eval-delivery', key: primary.id, payload: { threadId: primary.id }, now })
      }
    }
    // A fresh human follow-up answers an outstanding TicketQuestion.
    if (followupOwners.length > 0 && trigger.human) {
      for (const ticketId of followupOwners) {
        const ticket = this.repo.getTicket(ticketId)
        if (ticket?.question !== null && ticket?.question !== undefined) {
          this.repo.updateTicket(ticketId, { question: null, updatedAt: now })
        }
      }
    }
    for (const effect of effectKeys) this.repo.enqueueEffect(effect)

    // The live-ticket snapshot above is only used for gate context; intake
    // never mutates an unrelated Ticket.
    void liveTickets

    return {
      status: 'accepted',
      triggerId: trigger.id,
      threadIds: threads.map(thread => thread.id),
      evalRequested,
      inputIds,
      followupOwners,
    }
  }

  /** One source-owned thread is closed (e.g. a PR was merged). */
  threadClosed(input: ThreadClosedInput): void {
    this.repo.transaction(() => {
      const thread = this.repo.getThread(input.threadId)
      if (thread === undefined) throw new QunoStateError('unknown-thread', `thread ${input.threadId} is not known`)
      this.repo.updateThread(thread.id, { closed: { at: input.at, outcome: input.outcome } })
      for (const subscription of this.repo.listSubscriptionsByThread(thread.id)) {
        this.closeIfAllThreadsClosed(subscription.ticketId, input.now, 'source')
      }
    })
  }

  // ----------------------------------------------------------------- evals

  /**
   * Turn pending Triggers into one Eval per Thread: either a candidate for the
   * Router (admissible) or an immediate recorded ignore (not admissible, or
   * observe mode for inferred work).
   */
  openEvals(now: number, limit = 20): number {
    const policy = this.policySnapshot()
    if (policy.paused) return 0
    let opened = 0
    const threads = this.repo.listThreads(this.deps.qunoId, { limit: 500, withPending: true })
    for (const thread of threads) {
      if (opened >= limit) break
      if (this.repo.findActiveEval(thread.id) !== undefined) continue
      if (this.repo.countPending(thread.id) === 0) continue
      const made = this.repo.transaction(() => this.openEvalForThread(thread.id, policy, now))
      if (made) opened += 1
    }
    return opened
  }

  /** Open one Eval for one thread (idempotent while an active Eval exists). */
  openEval(threadId: ThreadId, now: number): EvalRecord | null {
    const policy = this.policySnapshot()
    return this.repo.transaction(() => this.openEvalForThread(threadId, policy, now))
  }

  private openEvalForThread(threadId: ThreadId, policy: PolicySnapshot, now: number): EvalRecord | null {
    const thread = this.repo.getThread(threadId)
    if (thread === undefined) return null
    const active = this.repo.findActiveEval(thread.id)
    if (active !== undefined) return active
    const batch = this.repo.listPendingTriggerIds(thread.id, 20)
    if (batch.length === 0) return null
    const triggers = this.repo.getTriggers(batch)
    if (triggers.length === 0) return null
    const tickets = this.openTicketsForThreads([thread])
    const gates = triggers.map(trigger => ({ trigger, gate: policy.gate(trigger, thread, tickets) }))
    const admitted = gates.filter(entry => entry.gate.admissible)
    const primary = triggers[0]
    if (primary === undefined) return null

    const evalId = this.deps.nextId('eval')
    const strongestStrength = admitted.some(entry => entry.gate.strength === 'explicit') ? 'explicit' : 'inferred'
    const basisEntry = admitted.find(entry => entry.gate.strength === strongestStrength) ?? admitted[0]
    const basis: Mandate['basis'] = basisEntry?.gate.basis ?? {
      via: 'admission',
      sourceId: primary.sourceId,
      scope: {},
      matchedRuleIds: [],
    }

    if (admitted.length === 0) {
      // No candidate is worth a model call. Record the judgement so the user
      // can audit why an event did or did not become work.
      const decision: DecisionRecord = {
        id: this.deps.nextId('dec'),
        qunoId: this.deps.qunoId,
        evalId,
        threadId: thread.id,
        triggerIds: batch,
        kind: 'ignore',
        strength: strongestStrength,
        reason: gates[0]?.gate.reason ?? 'not admissible',
        policyVersion: policy.version,
        ticketId: null,
        mandate: null,
        audit: {
          gates: gates.map(entry => ({
            triggerId: entry.trigger.id,
            admissible: entry.gate.admissible,
            strength: entry.gate.strength,
            reason: entry.gate.reason,
          })),
          wouldAccept: policy.acceptMode === 'observe' && gates.some(entry => entry.gate.basis !== null),
        },
        createdAt: now,
      }
      this.repo.insertDecision(decision)
      const evalRecord: EvalRecord = {
        id: evalId,
        qunoId: this.deps.qunoId,
        threadId: thread.id,
        triggerIds: batch,
        primaryTriggerId: primary.id,
        strength: strongestStrength,
        basis,
        policyVersion: policy.version,
        status: 'decided',
        candidateMessageId: null,
        startedAt: now,
        deliveredAt: null,
        deadline: now,
        pausedAt: null,
        expiryCount: 0,
      }
      this.repo.insertEval(evalRecord)
      this.repo.updateThread(thread.id, { activeEvalId: null, lastAt: now })
      this.settlePending(thread.id, batch)
      return evalRecord
    }

    const evalRecord: EvalRecord = {
      id: evalId,
      qunoId: this.deps.qunoId,
      threadId: thread.id,
      triggerIds: batch,
      primaryTriggerId: primary.id,
      strength: strongestStrength,
      basis,
      policyVersion: policy.version,
      status: 'delivering',
      candidateMessageId: null,
      startedAt: now,
      deliveredAt: null,
      deadline: now,
      pausedAt: null,
      expiryCount: 0,
    }
    this.repo.insertEval(evalRecord)
    this.repo.updateThread(thread.id, { activeEvalId: evalRecord.id })
    this.repo.enqueueEffect({
      kind: 'eval-delivery',
      key: evalRecord.id,
      payload: { evalId: evalRecord.id, threadId: thread.id },
      now,
    })
    return evalRecord
  }

  /** The Router accepted delivery of the candidate message. */
  candidateDelivered(input: { readonly evalId: EvalId; readonly messageId: string; readonly now: number }): EvalRecord | null {
    return this.repo.transaction(() => {
      const evalRecord = this.repo.getEval(input.evalId)
      if (evalRecord === undefined) return null
      if (evalRecord.status === 'decided' || evalRecord.status === 'unavailable') return evalRecord
      const deliveredAt = evalRecord.deliveredAt ?? input.now
      this.repo.updateEval(evalRecord.id, {
        status: 'waiting-decision',
        candidateMessageId: evalRecord.candidateMessageId ?? input.messageId,
        deliveredAt,
        deadline: deliveredAt + this.policySnapshot().evalTimeoutMs,
      })
      return this.repo.getEval(evalRecord.id) ?? null
    })
  }

  /** The candidate could not be delivered (transport failure). */
  candidateDeliveryFailed(evalId: EvalId, reason: string, now: number): void {
    this.repo.transaction(() => {
      const evalRecord = this.repo.getEval(evalId)
      if (evalRecord === undefined) return
      this.repo.updateEval(evalId, { status: 'delivering' })
      this.repo.failEffect('eval-delivery', evalId, 0, 0, reason, now)
    })
  }

  /** Submit the Router's decision for one Eval. Idempotent per Eval. */
  decide(input: EvalDecisionInput): EvalDecisionOutcome {
    return this.repo.transaction(() => this.decideInTransaction(input))
  }

  private decideInTransaction(input: EvalDecisionInput): EvalDecisionOutcome {
    const evalRecord = this.repo.getEval(input.evalId)
    if (evalRecord === undefined) throw new QunoStateError('unknown-eval', `eval ${input.evalId} is not known`)
    const existing = this.repo.findDecisionByEval(evalRecord.id)
    if (existing !== undefined) {
      if (existing.kind !== input.kind) {
        throw new QunoConflictError('decision-conflict', `eval ${evalRecord.id} was already decided as ${existing.kind}`)
      }
      const ticket = existing.ticketId === null ? null : this.repo.getTicket(existing.ticketId) ?? null
      return { decision: existing, ticket, downgraded: existing.audit['downgraded'] === true }
    }
    if (!evalIsActive(evalRecord)) {
      // A late decision after timeout/unavailable is recorded as evidence but
      // can never create work.
      throw new QunoConflictError('eval-not-active', `eval ${evalRecord.id} is ${evalRecord.status}`)
    }
    const policy = this.policySnapshot()
    const thread = this.repo.getThread(evalRecord.threadId)
    if (thread === undefined) throw new QunoStateError('unknown-thread', 'eval thread vanished')

    const requested = input.kind
    const downgrade = requested === 'accept' && policy.acceptMode === 'observe' && evalRecord.strength === 'inferred'
    const effective: DecisionKind = downgrade ? 'ignore' : requested
    const audit: Record<string, unknown> = {
      requestedKind: requested,
      downgraded: downgrade,
      acceptMode: policy.acceptMode,
      strength: evalRecord.strength,
      gates: evalRecord.basis,
    }
    if (downgrade) audit['wouldAccept'] = true

    let ticket: TicketRecord | null = null
    let mandate: Mandate | null = null
    let ticketId: TicketId | null = null

    if (effective === 'accept') {
      const title = (input.title ?? '').trim()
      const goal = (input.goal ?? '').trim()
      if (title === '' || goal === '') {
        throw new QunoStateError('invalid-accept', 'accept requires a title and a goal')
      }
      ticketId = ticketIdForEval(evalRecord.id)
      const existingTicket = this.repo.getTicket(ticketId)
      if (existingTicket !== undefined) {
        const decision = this.repo.findDecisionByEval(evalRecord.id)
        return {
          decision: decision ?? this.insertDecisionRecord(evalRecord, 'accept', input, policy.version, existingTicket.id, existingTicket.mandate, audit),
          ticket: existingTicket,
          downgraded: false,
        }
      }
      const triggers = this.repo.getTriggers(evalRecord.triggerIds)
      const primary = triggers[0]
      mandate = {
        strength: evalRecord.strength,
        policyVersion: evalRecord.policyVersion,
        scope: 'ticket',
        actor: primary?.actor ?? { source: 'quno', id: 'quno' },
        basis: evalRecord.basis,
        permissionPreset: 'quno-task',
        cli: this.cliGrant(),
      }
      const mode = input.mode ?? (input.persistent === true ? 'persistent' : 'once')
      const channels = triggers.flatMap(trigger => trigger.channel === null ? [] : [trigger.channel])
      ticket = {
        id: ticketId,
        qunoId: this.deps.qunoId,
        title: title.slice(0, 120),
        goal: goal.slice(0, 20_000),
        decisionId: null,
        mandate,
        origin: {
          triggerId: primary?.id ?? null,
          triggerIds: evalRecord.triggerIds,
        },
        channels: dedupeChannels(channels),
        mode,
        ended: null,
        question: null,
        createdAt: input.now,
        updatedAt: input.now,
      }
      const decision = this.insertDecisionRecord(evalRecord, effective, input, policy.version, ticket.id, mandate, audit)
      ticket = { ...ticket, decisionId: decision.id }
      this.repo.insertTicket(ticket)

      // Owned primary + context-only follow-ups: a Ticket can read every Thread
      // of its origin batch but owns input on exactly one of them.
      const threadIds = new Set<ThreadId>([thread.id])
      for (const trigger of triggers) {
        for (const ref of trigger.threads) {
          const linked = this.repo.getThreadByKey(this.deps.qunoId, ref.source, ref.id)
          if (linked !== undefined) threadIds.add(linked.id)
        }
      }
      for (const threadId of threadIds) {
        const mode: SubscriptionMode = threadId === thread.id ? 'owned' : 'context'
        this.ensureSubscription(ticket.id, threadId, mode, 'eval', input.now)
      }

      const assignment = this.createAssignment(ticket, input.cwd, input.now)
      this.repo.updateThread(thread.id, { activeEvalId: null, lastAt: input.now })
      this.settlePending(thread.id, evalRecord.triggerIds)
      this.repo.updateEval(evalRecord.id, { status: 'decided' })
      this.repo.enqueueEffect({
        kind: 'assignment-launch',
        key: assignment.id,
        payload: { assignmentId: assignment.id, ticketId: ticket.id },
        now: input.now,
      })
      return { decision, ticket, downgraded: false }
    }

    const decision = this.insertDecisionRecord(evalRecord, effective, input, policy.version, null, null, audit)
    this.repo.updateEval(evalRecord.id, {
      status: effective === 'unavailable' ? 'unavailable' : 'decided',
    })
    this.repo.updateThread(thread.id, { activeEvalId: null, lastAt: input.now })
    this.settlePending(thread.id, evalRecord.triggerIds)
    return { decision, ticket: null, downgraded: downgrade }
  }

  private insertDecisionRecord(
    evalRecord: EvalRecord,
    kind: DecisionKind,
    input: EvalDecisionInput,
    policyVersion: string,
    ticketId: TicketId | null,
    mandate: Mandate | null,
    audit: Record<string, unknown>,
  ): DecisionRecord {
    const decision: DecisionRecord = {
      id: this.deps.nextId('dec'),
      qunoId: this.deps.qunoId,
      evalId: evalRecord.id,
      threadId: evalRecord.threadId,
      triggerIds: evalRecord.triggerIds,
      kind,
      strength: evalRecord.strength,
      reason: input.reason,
      policyVersion,
      ticketId,
      mandate,
      audit,
      createdAt: input.now,
    }
    this.repo.insertDecision(decision)
    return decision
  }

  /** Create a Ticket directly from a human tool call (no source Eval). */
  directAccept(input: DirectAcceptInput): TicketRecord {
    return this.repo.transaction(() => {
      const title = input.title.trim()
      const goal = input.goal.trim()
      if (title === '' || goal === '') throw new QunoStateError('invalid-accept', 'a task needs a title and a goal')
      const policy = this.policySnapshot()
      const ticketId = stableDirectTicketId(input.sessionId, input.messageId, input.toolCallId)
      const existing = this.repo.getTicket(ticketId)
      if (existing !== undefined) return existing
      const mandate: Mandate = {
        strength: 'explicit',
        policyVersion: policy.version,
        scope: 'ticket',
        actor: { source: 'desktop', id: input.sessionId },
        basis: {
          via: 'direct',
          sourceId: null,
          scope: { messageId: input.messageId, toolCallId: input.toolCallId },
          matchedRuleIds: [],
        },
        permissionPreset: 'quno-task',
        cli: this.cliGrant(),
      }
      const decision: DecisionRecord = {
        id: this.deps.nextId('dec'),
        qunoId: this.deps.qunoId,
        evalId: null,
        threadId: null,
        triggerIds: [],
        kind: 'accept',
        strength: 'explicit',
        reason: 'direct human request',
        policyVersion: policy.version,
        ticketId,
        mandate,
        audit: { via: 'direct', sessionId: input.sessionId, messageId: input.messageId, toolCallId: input.toolCallId },
        createdAt: input.now,
      }
      this.repo.insertDecision(decision)
      const ticket: TicketRecord = {
        id: ticketId,
        qunoId: this.deps.qunoId,
        title: title.slice(0, 120),
        goal: goal.slice(0, 20_000),
        decisionId: decision.id,
        mandate,
        origin: { triggerId: null, triggerIds: [] },
        channels: [],
        mode: input.mode ?? 'once',
        ended: null,
        question: null,
        createdAt: input.now,
        updatedAt: input.now,
      }
      this.repo.insertTicket(ticket)
      const assignment = this.createAssignment(ticket, input.cwd, input.now)
      this.repo.enqueueEffect({
        kind: 'assignment-launch',
        key: assignment.id,
        payload: { assignmentId: assignment.id, ticketId: ticket.id },
        now: input.now,
      })
      return ticket
    })
  }

  /** Attach one Ticket to more Threads (Router `quno_thread_follow`). */
  attach(input: { readonly ticketId: TicketId; readonly threadIds: readonly ThreadId[]; readonly mode: SubscriptionMode; readonly origin: SubscriptionOrigin; readonly now: number }): readonly SubscriptionRecord[] {
    return this.repo.transaction(() => {
      const ticket = this.requireOpenTicket(input.ticketId)
      const made: SubscriptionRecord[] = []
      for (const threadId of input.threadIds) {
        const thread = this.repo.getThread(threadId)
        if (thread === undefined) throw new QunoStateError('unknown-thread', `thread ${threadId} is not known`)
        made.push(this.ensureSubscription(ticket.id, thread.id, input.mode, input.origin, input.now))
      }
      return made
    })
  }

  /** Write one note into a live Ticket. */
  note(input: { readonly ticketId: TicketId; readonly text: string; readonly human: boolean; readonly now: number; readonly revision?: string }): TicketInputRecord {
    return this.repo.transaction(() => {
      this.requireOpenTicket(input.ticketId)
      const revision = input.revision ?? this.deps.nextId('note')
      const id = noteInputId(input.ticketId, revision)
      const existing = this.repo.getInput(id)
      if (existing !== undefined) return existing
      const record: TicketInputRecord = {
        id,
        qunoId: this.deps.qunoId,
        ticketId: input.ticketId,
        kind: 'note',
        triggerId: null,
        exchangeId: null,
        human: input.human,
        context: false,
        text: input.text,
        createdAt: input.now,
        deliveredTo: null,
        deliveredAt: null,
        readAt: null,
        acknowledgedAt: null,
        handedBackAt: null,
      }
      this.repo.insertInput(record)
      this.repo.enqueueEffect({ kind: 'input-delivery', key: input.ticketId, payload: { ticketId: input.ticketId }, now: input.now })
      return record
    })
  }

  // -------------------------------------------------------- ticket actions

  /** Stop one Ticket. Idempotent; late worker writes are rejected by state. */
  stopTicket(input: { readonly ticketId: TicketId; readonly by: 'human' | 'host'; readonly reason?: string | null; readonly now: number }): TicketRecord {
    return this.repo.transaction(() => {
      const ticket = this.repo.getTicket(input.ticketId)
      if (ticket === undefined) throw new QunoStateError('unknown-ticket', `ticket ${input.ticketId} is not known`)
      if (ticket.ended !== null) return ticket
      const ended: TicketRecord = {
        ...ticket,
        ended: { at: input.now, by: input.by, outcome: 'stopped', reason: input.reason ?? null },
        question: null,
        updatedAt: input.now,
      }
      this.repo.updateTicket(ticket.id, { ended: ended.ended, question: null, updatedAt: input.now })
      const assignment = this.repo.findActiveAssignment(ticket.id)
      if (assignment !== undefined) {
        this.repo.updateAssignment(assignment.id, { state: 'ended', endedReason: 'stopped', idleAt: input.now })
        const run = this.repo.findRunningWorkerRun(assignment.id)
        if (run !== undefined) {
          this.repo.updateWorkerRun(run.id, {
            status: 'ended',
            finishedAt: input.now,
            error: { code: 'stopped', message: input.reason ?? 'ticket stopped' },
          })
        }
      }
      this.returnUnprocessedInputs(ticket.id, input.now)
      return this.repo.getTicket(ticket.id) ?? ended
    })
  }

  /** Retry the executor work of one Ticket (new Assignment, same Mandate). */
  retryTicket(input: { readonly ticketId: TicketId; readonly now: number }): AssignmentRecord {
    return this.repo.transaction(() => {
      const ticket = this.repo.getTicket(input.ticketId)
      if (ticket === undefined) throw new QunoStateError('unknown-ticket', `ticket ${input.ticketId} is not known`)
      if (ticket.ended !== null) {
        const policy = this.policySnapshot()
        const validity = policy.revalidate(ticket.mandate)
        if (!validity.valid) {
          throw new QunoStateError('mandate-invalid', validity.reason ?? 'the mandate no longer authorizes this work')
        }
        this.repo.updateTicket(ticket.id, { ended: null, updatedAt: input.now })
      }
      const active = this.repo.findActiveAssignment(ticket.id)
      if (active !== undefined) {
        const waiting = active.report !== null
          && (active.report.state === 'waiting' || active.report.state === 'blocked' || active.report.state === 'failed')
        if (active.state === 'running' && !waiting) {
          throw new QunoStateError('assignment-running', 'the Ticket already has a running executor')
        }
        this.repo.updateAssignment(active.id, {
          state: waiting ? 'running' : 'pending',
          endedReason: null,
          report: waiting ? active.report : null,
        })
        this.repo.enqueueEffect({
          kind: 'assignment-launch',
          key: active.id,
          payload: { assignmentId: active.id, ticketId: ticket.id, retry: true },
          now: input.now,
        })
        return active
      }
      const ticketNow = this.repo.getTicket(ticket.id)
      if (ticketNow === undefined) throw new QunoStateError('unknown-ticket', 'ticket vanished')
      const assignment = this.createAssignment(ticketNow, undefined, input.now)
      this.repo.enqueueEffect({
        kind: 'assignment-launch',
        key: assignment.id,
        payload: { assignmentId: assignment.id, ticketId: ticket.id },
        now: input.now,
      })
      return assignment
    })
  }

  /** Re-run one Thread's Eval from its pending Triggers. */
  reevaluate(input: { readonly threadId: ThreadId; readonly now: number }): EvalRecord | null {
    return this.repo.transaction(() => {
      const active = this.repo.findActiveEval(input.threadId)
      if (active !== undefined) {
        this.repo.updateEval(active.id, { status: 'unavailable' })
        this.repo.updateThread(input.threadId, { activeEvalId: null })
        for (const triggerId of active.triggerIds) this.repo.addPending(input.threadId, triggerId, input.now)
      }
      const made = this.openEvalForThread(input.threadId, this.policySnapshot(), input.now)
      return made
    })
  }

  /** Cancel one subscription (worker marking a Thread unrelated). */
  unsubscribe(input: { readonly subscriptionId: string; readonly now: number; readonly origin?: SubscriptionOrigin }): boolean {
    return this.repo.transaction(() => {
      const found = this.subscriptionById(input.subscriptionId)
      if (found === undefined) return false
      if (input.origin !== undefined && found.origin !== input.origin) {
        throw new QunoStateError('subscription-origin', 'this Thread can only be detached by its owner')
      }
      this.repo.updateSubscription(found.id, { cancelledAt: input.now, revision: found.revision + 1 })
      return true
    })
  }

  // ------------------------------------------------------------- executor

  /** The executor accepted the assignment and started one bounded turn. */
  assignmentStarted(input: { readonly assignmentId: string; readonly runId?: string; readonly now: number }): WorkerRunRecord | null {
    return this.repo.transaction(() => {
      const assignment = this.repo.getAssignment(input.assignmentId)
      if (assignment === undefined) return null
      if (assignment.state === 'ended') return null
      this.repo.updateAssignment(assignment.id, { state: 'running', deliveredAt: assignment.deliveredAt ?? input.now })
      const existing = this.repo.findRunningWorkerRun(assignment.id)
      if (existing !== undefined) return existing
      const ticket = this.repo.getTicket(assignment.ticketId)
      if (ticket === undefined || ticket.ended !== null) return null
      const run: WorkerRunRecord = {
        id: input.runId ?? `run_${assignment.id}_${String(this.repo.listWorkerRunsByAssignment(assignment.id).length + 1)}`,
        qunoId: this.deps.qunoId,
        ticketId: ticket.id,
        assignmentId: assignment.id,
        status: 'running',
        inputIds: [],
        fence: this.repo.bumpCounter('worker-fence'),
        leaseUntil: null,
        turnId: null,
        result: null,
        error: null,
        cost: null,
        startedAt: input.now,
        finishedAt: null,
      }
      this.repo.insertWorkerRun(run)
      return run
    })
  }

  /** Record that inputs were accepted by a session transport. */
  inputsDelivered(input: { readonly ticketId: TicketId; readonly inputIds: readonly string[]; readonly assignmentId: string; readonly now: number }): void {
    this.repo.transaction(() => {
      for (const inputId of input.inputIds) {
        const record = this.repo.getInput(inputId)
        if (record === undefined) continue
        if (record.deliveredAt !== null) continue
        this.repo.updateInput(inputId, { deliveredTo: input.assignmentId, deliveredAt: input.now })
      }
      const assignment = this.repo.getAssignment(input.assignmentId)
      if (assignment !== undefined && assignment.deliveredAt === null) {
        this.repo.updateAssignment(assignment.id, { deliveredAt: input.now })
      }
    })
  }

  /** Record that delivered inputs entered the model history. */
  inputsRead(input: { readonly ticketId: TicketId; readonly inputIds: readonly string[]; readonly now: number }): void {
    this.repo.transaction(() => {
      for (const inputId of input.inputIds) {
        const record = this.repo.getInput(inputId)
        if (record === undefined || record.readAt !== null) continue
        this.repo.updateInput(inputId, { readAt: input.now })
      }
    })
  }

  /** One transport attempt failed; unread inputs stay queued for the next run. */
  deliveryFailed(input: { readonly ticketId: TicketId; readonly inputIds: readonly string[]; readonly reason: string; readonly retryAt: number; readonly now: number }): void {
    this.repo.transaction(() => {
      for (const inputId of input.inputIds) {
        const record = this.repo.getInput(inputId)
        if (record === undefined) continue
        if (record.readAt !== null) continue
        this.repo.updateInput(inputId, { deliveredTo: null, deliveredAt: null })
      }
      this.repo.enqueueEffect({
        kind: 'input-delivery',
        key: input.ticketId,
        payload: { ticketId: input.ticketId, reason: input.reason },
        now: input.now,
        dueAt: input.retryAt,
      })
    })
  }

  /** A session turn ended; the bounded run is over. */
  turnEnded(input: { readonly assignmentId: string; readonly now: number }): void {
    this.repo.transaction(() => {
      const assignment = this.repo.getAssignment(input.assignmentId)
      if (assignment === undefined) return
      const run = this.repo.findRunningWorkerRun(assignment.id)
      if (run !== undefined) {
        this.repo.updateWorkerRun(run.id, { status: 'ended', finishedAt: input.now })
      }
      if (assignment.state !== 'ended') this.repo.updateAssignment(assignment.id, { idleAt: input.now })
    })
  }

  /** Structured Worker Report: T5. */
  report(input: WorkerReportInput): WorkerReportOutcome {
    return this.repo.transaction(() => {
      const assignment = this.repo.getAssignment(input.assignmentId)
      if (assignment === undefined) throw new QunoStateError('unknown-assignment', `assignment ${input.assignmentId} is not known`)
      const ticket = this.repo.getTicket(assignment.ticketId)
      if (ticket === undefined) throw new QunoStateError('unknown-ticket', 'assignment ticket vanished')
      if (ticket.ended !== null) {
        throw new QunoStateError('ticket-ended', 'this Ticket has already ended; reports are closed')
      }
      const report = { ...normalizeReport(input.report, input.now), nonce: this.repo.bumpCounter('report-nonce') }
      this.repo.updateAssignment(assignment.id, { report, idleAt: input.now })
      const run = this.repo.findRunningWorkerRun(assignment.id)
      if (run !== undefined) {
        this.repo.updateWorkerRun(run.id, {
          status: report.state === 'failed' ? 'failed' : 'ended',
          finishedAt: input.now,
          result: { state: report.state, summary: report.summary },
          error: report.state === 'failed' ? { code: 'worker-failed', message: report.summary } : null,
        })
      }
      // A Report acknowledges the inputs delivered to this assignment.
      for (const record of this.repo.listInputsByTicket(ticket.id, { limit: 200 })) {
        if (record.deliveredTo !== assignment.id || record.acknowledgedAt !== null) continue
        this.repo.updateInput(record.id, { acknowledgedAt: input.now, readAt: record.readAt ?? input.now })
      }

      const question = report.question === undefined
        ? null
        : {
          id: `q_${assignment.id}_${String(input.now)}`,
          question: report.question.question,
          triggerId: report.question.triggerId ?? null,
          createdAt: input.now,
        }
      this.repo.updateTicket(ticket.id, { question, updatedAt: input.now })

      let ended = false
      if (report.state === 'dropped') {
        this.endTicket(ticket.id, 'executor', 'dropped', report.summary, input.now)
        ended = true
      } else if (report.state === 'ready' && ticket.mode === 'once' && this.noOpenFollowedThreads(ticket.id)) {
        this.endTicket(ticket.id, 'executor', 'completed', report.summary, input.now)
        ended = true
      } else if (report.state === 'ready' && ticket.mode === 'persistent') {
        // Persistent work stays open; the result is relayed for acceptance.
      } else if (report.state === 'ready') {
        // A once Ticket with an open followed Thread waits for that Thread.
      }

      this.repo.enqueueEffect({
        kind: 'router-relay',
        key: ticket.id,
        payload: { ticketId: ticket.id, assignmentId: assignment.id, reportState: report.state },
        now: input.now,
      })
      const latest = this.repo.getTicket(ticket.id) ?? ticket
      return { ticket: latest, ended, relayed: true }
    })
  }

  /** Worker hands one Trigger back because it is out of scope. */
  handback(input: HandbackInput): HandbackOutcome {
    return this.repo.transaction(() => {
      const ticket = this.repo.getTicket(input.ticketId)
      if (ticket === undefined) throw new QunoStateError('unknown-ticket', `ticket ${input.ticketId} is not known`)
      const record = this.repo.findInputByTrigger(ticket.id, input.triggerId)
      if (record === undefined || !record.human) {
        throw new QunoStateError('unknown-input', 'this Trigger was not delivered to the Ticket')
      }
      if (record.handedBackAt !== null) {
        return { handedBack: false, returnedToEval: false, remainingOwners: [] }
      }
      this.repo.updateInput(record.id, { handedBackAt: input.now, acknowledgedAt: input.now })
      const remaining = this.remainingOwners(input.triggerId, ticket.id)
      let returnedToEval = false
      if (remaining.length === 0) {
        const trigger = this.repo.getTrigger(input.triggerId)
        const primary = trigger === undefined ? null : primaryThreadOf(trigger)
        if (primary !== null) {
          const thread = this.repo.getThreadByKey(this.deps.qunoId, primary.source, primary.id)
          if (thread !== undefined) {
            this.repo.addPending(thread.id, input.triggerId, input.now)
            if (this.repo.findActiveEval(thread.id) === undefined) {
              this.repo.enqueueEffect({ kind: 'eval-delivery', key: thread.id, payload: { threadId: thread.id }, now: input.now })
            }
            returnedToEval = true
          }
        }
      }
      return { handedBack: true, returnedToEval, remainingOwners: remaining }
    })
  }

  /** Worker adds a context-only subscription for another Thread. */
  followForContext(input: { readonly ticketId: TicketId; readonly threadIds: readonly ThreadId[]; readonly now: number }): readonly SubscriptionRecord[] {
    return this.attach({ ticketId: input.ticketId, threadIds: input.threadIds, mode: 'context', origin: 'executor', now: input.now })
  }

  /** Worker detached one executor-added context Thread. */
  markUnrelated(input: { readonly subscriptionId: string; readonly now: number }): boolean {
    return this.unsubscribe({ subscriptionId: input.subscriptionId, origin: 'executor', now: input.now })
  }

  // ------------------------------------------------------------- exchanges

  /** Create one asynchronous paired exchange (request payload + delivery effect). */
  requestExchange(input: ExchangeRequestInput): ExchangeRecord {
    return this.repo.transaction(() => {
      const exchangeId = this.deps.nextId('exch')
      const requestMessageId = `quno:exchange:${exchangeId}`
      const exchange: ExchangeRecord = {
        id: exchangeId,
        qunoId: this.deps.qunoId,
        kind: input.kind,
        requester: input.requester,
        responder: input.responder,
        status: 'pending',
        deadline: input.now + Math.max(1000, input.deadlineMs),
        requestMessageId,
        responseMessageId: null,
        attempts: 0,
        createdAt: input.now,
        updatedAt: input.now,
      }
      this.repo.insertExchange(exchange)
      const message: ExchangeMessageRecord = {
        id: requestMessageId,
        exchangeId,
        kind: 'request',
        producerEndpoint: input.requester,
        payload: input.payload,
        contentRef: null,
        contentHash: contentHashOf(input.payload),
        responseTo: null,
        createdAt: input.now,
      }
      this.repo.insertExchangeMessage(message)
      this.repo.enqueueEffect({
        kind: 'exchange-delivery',
        key: exchangeId,
        payload: { exchangeId, kind: input.kind, responder: input.responder, payload: input.payload },
        now: input.now,
      })
      return exchange
    })
  }

  /** Mark an exchange delivery attempt as accepted by the responder. */
  exchangeDelivered(exchangeId: ExchangeId, now: number): void {
    this.repo.transaction(() => {
      const exchange = this.repo.getExchange(exchangeId)
      if (exchange === undefined || exchange.status !== 'pending') return
      this.repo.updateExchange(exchangeId, { status: 'delivered', attempts: exchange.attempts + 1, updatedAt: now })
    })
  }

  /**
   * A responder completed an Exchange. The requester is read from the durable
   * ExchangeRecord, never from the response payload.
   */
  completeExchange(input: { readonly exchangeId: ExchangeId; readonly responder: string; readonly result: unknown; readonly now: number }): ExchangeCompleteOutcome {
    return this.repo.transaction(() => {
      const exchange = this.repo.getExchange(input.exchangeId)
      if (exchange === undefined) throw new QunoStateError('unknown-exchange', `exchange ${input.exchangeId} is not known`)
      if (exchange.responder !== input.responder) {
        throw new QunoStateError('wrong-responder', 'only the addressed responder may complete this exchange')
      }
      const hash = contentHashOf(input.result)
      const existing = this.repo.findExchangeMessageByHash(exchange.id, 'response', hash)
      if (existing !== undefined) {
        const ticketInput = this.inputForExchange(exchange, existing, input.now, false)
        return { exchange, late: exchange.status === 'expired' || exchange.status === 'cancelled', inputId: ticketInput }
      }
      const late = exchange.status === 'expired' || exchange.status === 'cancelled' || exchange.status === 'failed'
      const messageId = `quno:exchange:${exchange.id}:response`
      const message: ExchangeMessageRecord = {
        id: messageId,
        exchangeId: exchange.id,
        kind: 'response',
        producerEndpoint: input.responder,
        payload: input.result,
        contentRef: null,
        contentHash: hash,
        responseTo: exchange.requestMessageId,
        createdAt: input.now,
      }
      this.repo.insertExchangeMessage(message)
      if (late) {
        // Late evidence is kept but cannot reopen cancelled or expired work.
        const updated = this.repo.getExchange(exchange.id) ?? exchange
        return { exchange: updated, late: true, inputId: null }
      }
      if (exchange.status === 'consumed' || exchange.status === 'responded') {
        return { exchange, late: false, inputId: null }
      }
      this.repo.updateExchange(exchange.id, { status: 'responded', responseMessageId: messageId, updatedAt: input.now })
      const ticketInputId = this.inputForExchange(exchange, message, input.now, true)
      return { exchange: { ...exchange, status: 'responded', responseMessageId: messageId }, late: false, inputId: ticketInputId }
    })
  }

  /**
   * A responder refused or could not answer. Retryable failures reschedule the
   * delivery; a terminal failure leaves evidence for the requester and never
   * pretends a result exists.
   */
  failExchange(input: {
    readonly exchangeId: ExchangeId
    readonly responder: string
    readonly reason: string
    readonly retryable: boolean
    readonly now: number
  }): void {
    this.repo.transaction(() => {
      const exchange = this.repo.getExchange(input.exchangeId)
      if (exchange === undefined) return
      if (exchange.responder !== input.responder) return
      if (exchange.status !== 'pending' && exchange.status !== 'delivered') return
      if (input.retryable && exchange.attempts < 3) {
        this.repo.updateExchange(exchange.id, {
          status: 'pending',
          attempts: exchange.attempts + 1,
          updatedAt: input.now,
        })
        this.repo.enqueueEffect({
          kind: 'exchange-delivery',
          key: exchange.id,
          payload: { exchangeId: exchange.id, kind: exchange.kind, responder: exchange.responder },
          now: input.now,
          dueAt: input.now + 5_000 * 2 ** exchange.attempts,
        })
        return
      }
      this.repo.updateExchange(exchange.id, { status: 'failed', updatedAt: input.now })
      this.settleExchangeFailure(exchange, 'failed', input.reason, input.now)
    })
  }

  /**
   * One terminal failure/expiry, two durable consequences:
   *
   * 1. the reason itself becomes an `error` ExchangeMessage (evidence — a
   *    later reader never has to reconstruct why nothing arrived);
   * 2. the requester receives a durable input/relay pointing at that evidence.
   *
   * Retryable attempts never reach here: they reschedule in `failExchange`
   * and expire only when the deadline really passed.
   */
  private settleExchangeFailure(
    exchange: ExchangeRecord,
    outcome: 'failed' | 'expired',
    reason: string,
    now: number,
  ): void {
    const payload = { outcome, reason, responder: exchange.responder }
    this.repo.insertExchangeMessage({
      id: `quno:exchange:${exchange.id}:error`,
      exchangeId: exchange.id,
      kind: 'error',
      producerEndpoint: exchange.responder,
      payload,
      contentRef: null,
      contentHash: contentHashOf(payload),
      responseTo: exchange.requestMessageId,
      createdAt: now,
    })
    const ticketId = ticketIdFromEndpoint(exchange.requester)
    if (ticketId === null) {
      // Router requester: the failure is relayed into the permanent
      // conversation instead of being silently dropped with the Effect.
      this.repo.enqueueEffect({
        kind: 'router-relay',
        key: `exchange:${exchange.id}`,
        payload: { exchangeId: exchange.id },
        now,
      })
      return
    }
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined || ticket.ended !== null) return
    const id = inputIdFor({ ticketId, kind: 'response', exchangeId: exchange.id })
    if (this.repo.getInput(id) !== undefined) return
    const label = outcome === 'expired' ? '异步读取超时' : '异步读取失败'
    this.repo.insertInput({
      id,
      qunoId: this.deps.qunoId,
      ticketId,
      kind: 'response',
      triggerId: null,
      exchangeId: exchange.id,
      human: false,
      context: false,
      text: `${label}：${reason}`,
      createdAt: now,
      deliveredTo: null,
      deliveredAt: null,
      readAt: null,
      acknowledgedAt: null,
      handedBackAt: null,
    })
    this.repo.enqueueEffect({ kind: 'input-delivery', key: ticketId, payload: { ticketId }, now })
  }

  /** The structured read-only CLI grant recorded on a newly accepted Ticket. */
  private cliGrant(): MandateCli {
    return this.deps.cliGrant?.() ?? { capabilities: [], operations: {} }
  }

  /** Mark a response consumed by the requester's turn. */
  consumeExchange(exchangeId: ExchangeId, now: number): void {
    this.repo.transaction(() => {
      const exchange = this.repo.getExchange(exchangeId)
      if (exchange === undefined || exchange.status !== 'responded') return
      this.repo.updateExchange(exchangeId, { status: 'consumed', updatedAt: now })
    })
  }

  /**
   * Expire exchanges past their deadline. Expiry is a terminal outcome, not a
   * quiet state change: the reason is persisted and the requester is woken
   * exactly like a failure. Late responses stay evidence-only.
   */
  expireExchanges(now: number, limit = 50): number {
    let expired = 0
    for (const exchange of this.repo.listExchangesDue(now, limit)) {
      this.repo.transaction(() => {
        const current = this.repo.getExchange(exchange.id)
        if (current === undefined) return
        if (current.status !== 'pending' && current.status !== 'delivered') return
        this.repo.updateExchange(current.id, { status: 'expired', updatedAt: now })
        expired += 1
        const waitedSec = Math.max(1, Math.round((now - current.createdAt) / 1000))
        this.settleExchangeFailure(
          current,
          'expired',
          `${current.responder} 在 ${String(waitedSec)}s 内没有返回结果（deadline 已过）`,
          now,
        )
      })
    }
    return expired
  }

  // -------------------------------------------------------------- policies

  /** Settings changed: write a PolicyInput to live Tickets and re-rank pending Evals. */
  policyChanged(now: number): number {
    return this.repo.transaction(() => {
      const policy = this.policySnapshot()
      let written = 0
      for (const ticket of this.repo.listTickets(this.deps.qunoId, { open: true, limit: 500 })) {
        const id = inputIdFor({
          ticketId: ticket.id,
          kind: 'policy',
          revision: policy.version,
        })
        if (this.repo.getInput(id) !== undefined) continue
        const record: TicketInputRecord = {
          id,
          qunoId: this.deps.qunoId,
          ticketId: ticket.id,
          kind: 'policy',
          triggerId: null,
          exchangeId: null,
          human: false,
          context: true,
          text: `Policy ${policy.version}: acceptMode=${policy.acceptMode}`,
          createdAt: now,
          deliveredTo: null,
          deliveredAt: null,
          readAt: null,
          acknowledgedAt: null,
          handedBackAt: null,
        }
        this.repo.insertInput(record)
        this.repo.enqueueEffect({ kind: 'input-delivery', key: ticket.id, payload: { ticketId: ticket.id }, now })
        written += 1
      }
      // Evals admitted under an older policy are re-ranked rather than
      // silently decided under the new rules.
      for (const evalRecord of this.repo.listEvals(this.deps.qunoId, { limit: 500 })) {
        if (!evalIsActive(evalRecord) || evalRecord.policyVersion === policy.version) continue
        this.repo.updateEval(evalRecord.id, { status: 'unavailable' })
        this.repo.updateThread(evalRecord.threadId, { activeEvalId: null })
        for (const triggerId of evalRecord.triggerIds) this.repo.addPending(evalRecord.threadId, triggerId, now)
        const decision: DecisionRecord = {
          id: this.deps.nextId('dec'),
          qunoId: this.deps.qunoId,
          evalId: evalRecord.id,
          threadId: evalRecord.threadId,
          triggerIds: evalRecord.triggerIds,
          kind: 'unavailable',
          strength: evalRecord.strength,
          reason: 'policy changed while the eval was in flight',
          policyVersion: policy.version,
          ticketId: null,
          mandate: null,
          audit: { previousPolicyVersion: evalRecord.policyVersion },
          createdAt: now,
        }
        this.repo.insertDecision(decision)
        this.repo.enqueueEffect({ kind: 'eval-delivery', key: evalRecord.threadId, payload: { threadId: evalRecord.threadId }, now })
      }
      return written
    })
  }

  /** Freeze active Eval deadlines while Quno is paused. */
  pauseEvals(now: number): number {
    let paused = 0
    for (const evalRecord of this.repo.listEvals(this.deps.qunoId, { status: ['delivering', 'waiting-decision'], limit: 500 })) {
      if (evalRecord.pausedAt !== null) continue
      this.repo.updateEval(evalRecord.id, { pausedAt: now })
      paused += 1
    }
    return paused
  }

  /** Shift frozen deadlines forward by the paused duration. */
  resumeEvals(now: number): number {
    let resumed = 0
    for (const evalRecord of this.repo.listEvals(this.deps.qunoId, { status: ['delivering', 'waiting-decision'], limit: 500 })) {
      if (evalRecord.pausedAt === null) continue
      const shift = Math.max(0, now - evalRecord.pausedAt)
      this.repo.updateEval(evalRecord.id, { pausedAt: null, deadline: evalRecord.deadline + shift })
      resumed += 1
    }
    return resumed
  }

  // ----------------------------------------------------------------- passes

  /** Expire candidates that were delivered but never decided (bounded retries). */
  expireEvals(now: number, limit = 50): number {
    let expired = 0
    for (const evalRecord of this.repo.listTimedOutEvals(now, limit)) {
      this.repo.transaction(() => {
        const current = this.repo.getEval(evalRecord.id)
        if (current === undefined) return
        if (current.expiryCount < 2) {
          // Re-queue the same batch under the SAME eval id: a transport retry
          // must never create a second batch for the same triggers.
          this.repo.updateEval(current.id, {
            expiryCount: current.expiryCount + 1,
            status: 'delivering',
            deliveredAt: null,
            deadline: 0,
          })
          this.repo.enqueueEffect({
            kind: 'eval-delivery',
            key: current.id,
            payload: { evalId: current.id, threadId: current.threadId, retry: true },
            now,
          })
          expired += 1
          return
        }
        this.repo.updateEval(current.id, { status: 'unavailable', expiryCount: current.expiryCount + 1 })
        this.repo.updateThread(current.threadId, { activeEvalId: null })
        const decision: DecisionRecord = {
          id: this.deps.nextId('dec'),
          qunoId: this.deps.qunoId,
          evalId: current.id,
          threadId: current.threadId,
          triggerIds: current.triggerIds,
          kind: 'unavailable',
          strength: current.strength,
          reason: 'the eval candidate timed out three times',
          policyVersion: current.policyVersion,
          ticketId: null,
          mandate: null,
          audit: { expiryCount: current.expiryCount + 1 },
          createdAt: now,
        }
        this.repo.insertDecision(decision)
        this.settlePending(current.threadId, current.triggerIds)
        expired += 1
      })
    }
    return expired
  }

  /** Launch/recover assignments and deliver pending inputs (called after effects). */
  recover(now: number): PassOutcome {
    let resumed = 0
    for (const assignment of this.repo.listAssignmentsByState('pending', 50)) {
      const ticket = this.repo.getTicket(assignment.ticketId)
      if (ticket === undefined || ticket.ended !== null) continue
      this.repo.enqueueEffect({
        kind: 'assignment-launch',
        key: assignment.id,
        payload: { assignmentId: assignment.id, ticketId: ticket.id },
        now,
      })
      resumed += 1
    }
    return { opened: 0, expired: 0, resumed, closedThreads: 0 }
  }

  // -------------------------------------------------------------- read side

  /** The current candidate view the Router tool renders. */
  candidateView(evalId: EvalId): CandidateView | null {
    const evalRecord = this.repo.getEval(evalId)
    if (evalRecord === undefined) return null
    const thread = this.repo.getThread(evalRecord.threadId)
    const triggers = this.repo.getTriggers(evalRecord.triggerIds)
    const tickets = thread === undefined ? [] : this.openTicketsForThreads([thread])
    return {
      eval: evalRecord,
      thread,
      triggers,
      tickets,
      admissible: triggers.map(trigger => ({
        triggerId: trigger.id,
        type: trigger.type,
        human: trigger.human,
        addressed: trigger.addressed,
        summary: trigger.summary,
        occurredAt: trigger.occurredAt,
        channel: trigger.channel,
      })),
    }
  }

  /** Latest Eval for a Thread (diagnostics). */
  activeEvalForThread(threadId: ThreadId): EvalRecord | undefined {
    return this.repo.findActiveEval(threadId)
  }

  /** All subscriptions of one Ticket. */
  subscriptionsForTicket(ticketId: TicketId): readonly SubscriptionRecord[] {
    return this.repo.listSubscriptionsByTicket(ticketId)
  }

  // ------------------------------------------------------------- internals

  private ensureThread(ref: ThreadRef, trigger: TriggerRecord, now: number): ThreadRecord {
    const existing = this.repo.getThreadByKey(this.deps.qunoId, ref.source, ref.id)
    if (existing !== undefined) {
      const lastAt = existing.lastAt === null ? trigger.observedAt : Math.max(existing.lastAt, trigger.observedAt)
      const label = existing.label ?? (trigger.summary === null ? null : trigger.summary.slice(0, 120))
      if (lastAt !== existing.lastAt || label !== existing.label) {
        this.repo.updateThread(existing.id, { lastAt, label })
      }
      return { ...existing, lastAt, label }
    }
    const thread: ThreadRecord = {
      id: threadRowId(ref.source, ref.id),
      qunoId: this.deps.qunoId,
      sourceId: ref.source,
      threadKey: ref.id,
      label: trigger.summary === null ? null : trigger.summary.slice(0, 120),
      lastAt: trigger.observedAt,
      correlatedThreadIds: [],
      pendingTriggerIds: [],
      activeEvalId: null,
      expiredCount: 0,
      meta: {},
      closed: null,
    }
    this.repo.insertThread(thread)
    return thread
  }

  private updateCorrelation(threads: readonly ThreadRecord[], _triggerId: TriggerId): void {
    if (threads.length < 2) return
    for (const thread of threads) {
      const others = threads.filter(candidate => candidate.id !== thread.id).map(candidate => candidate.id)
      const merged = mergeCorrelation(thread.correlatedThreadIds, others)
      if (merged.length !== thread.correlatedThreadIds.length) {
        this.repo.updateThread(thread.id, { correlatedThreadIds: merged })
      }
    }
  }

  private openTicketsForThreads(threads: readonly ThreadRecord[]): readonly TicketRecord[] {
    const ids = new Set<TicketId>()
    for (const thread of threads) {
      for (const subscription of this.repo.listSubscriptionsByThread(thread.id)) {
        if (subscription.cancelledAt !== null) continue
        const ticket = this.repo.getTicket(subscription.ticketId)
        if (ticket !== undefined && ticket.ended === null) ids.add(ticket.id)
      }
    }
    return [...ids].flatMap((id) => {
      const ticket = this.repo.getTicket(id)
      return ticket === undefined ? [] : [ticket]
    })
  }

  private settlePending(threadId: ThreadId, triggerIds: readonly TriggerId[]): void {
    for (const triggerId of triggerIds) this.repo.removePending(threadId, triggerId)
  }

  private ensureSubscription(
    ticketId: TicketId,
    threadId: ThreadId,
    mode: SubscriptionMode,
    origin: SubscriptionOrigin,
    now: number,
  ): SubscriptionRecord {
    const existing = this.repo.getSubscription(ticketId, threadId)
    if (existing !== undefined) {
      if (existing.mode !== mode || existing.cancelledAt !== null) {
        this.repo.updateSubscription(existing.id, { mode, cancelledAt: null, revision: existing.revision + 1 })
      }
      return { ...existing, mode, cancelledAt: null }
    }
    const subscription: SubscriptionRecord = {
      id: `sub_${ticketId}_${hashToken(threadId)}`,
      qunoId: this.deps.qunoId,
      ticketId,
      threadId,
      mode,
      origin,
      startIngestSeq: 0,
      revision: 1,
      cancelledAt: null,
      createdAt: now,
    }
    this.repo.insertSubscription(subscription)
    return subscription
  }

  private createAssignment(ticket: TicketRecord, cwd: string | undefined, now: number): AssignmentRecord {
    const ordinal = this.repo.listAssignmentsByTicket(ticket.id).length + 1
    const assignment: AssignmentRecord = {
      id: assignmentIdForTicket(ticket.id, ordinal),
      ticketId: ticket.id,
      state: 'pending',
      executorSessionId: executorSessionIdFor(ticket.id),
      directory: cwd ?? this.deps.defaultCwd,
      report: null,
      deliveredAt: null,
      idleAt: null,
      endedReason: null,
      createdAt: now,
    }
    this.repo.insertAssignment(assignment)
    return assignment
  }

  /** Reopen the executor side of a Ticket that just resumed. */
  private resumeTicketWork(ticketId: TicketId, triggerId: TriggerId, now: number): void {
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined) return
    void triggerId
    const assignment = this.repo.findActiveAssignment(ticket.id)
    if (assignment !== undefined) {
      if (assignment.state === 'pending') {
        this.repo.enqueueEffect({
          kind: 'assignment-launch',
          key: assignment.id,
          payload: { assignmentId: assignment.id, ticketId: ticket.id, resume: true },
          now,
        })
      }
      return
    }
    const created = this.createAssignment(ticket, undefined, now)
    this.repo.enqueueEffect({
      kind: 'assignment-launch',
      key: created.id,
      payload: { assignmentId: created.id, ticketId: ticket.id, resume: true },
      now,
    })
  }

  private endTicket(
    ticketId: TicketId,
    by: 'human' | 'executor' | 'source' | 'host',
    outcome: 'completed' | 'failed' | 'dropped' | 'stopped' | 'closed',
    reason: string | null,
    now: number,
  ): void {
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined || ticket.ended !== null) return
    this.repo.updateTicket(ticket.id, {
      ended: { at: now, by, outcome, reason },
      question: null,
      updatedAt: now,
    })
    const assignment = this.repo.findActiveAssignment(ticket.id)
    if (assignment !== undefined) {
      this.repo.updateAssignment(assignment.id, { state: 'ended', endedReason: outcome, idleAt: now })
      const run = this.repo.findRunningWorkerRun(assignment.id)
      if (run !== undefined) this.repo.updateWorkerRun(run.id, { status: 'ended', finishedAt: now })
    }
    this.returnUnprocessedInputs(ticket.id, now)
  }

  private returnUnprocessedInputs(ticketId: TicketId, now: number): void {
    for (const record of this.repo.listInputsByTicket(ticketId, { limit: 500 })) {
      if (!record.human || record.triggerId === null) continue
      if (record.acknowledgedAt !== null || record.handedBackAt !== null) continue
      const trigger = this.repo.getTrigger(record.triggerId)
      const primary = trigger === undefined ? null : primaryThreadOf(trigger)
      if (primary === null) continue
      const thread = this.repo.getThreadByKey(this.deps.qunoId, primary.source, primary.id)
      if (thread === undefined) continue
      // The message goes back to the Evaluable stream; already-owned messages
      // stay owned because the owner is the one that just ended.
      this.repo.addPending(thread.id, record.triggerId, now)
      if (this.repo.findActiveEval(thread.id) === undefined) {
        this.repo.enqueueEffect({ kind: 'eval-delivery', key: thread.id, payload: { threadId: thread.id }, now })
      }
    }
  }

  private remainingOwners(triggerId: TriggerId, excludeTicketId: TicketId): readonly TicketId[] {
    const trigger = this.repo.getTrigger(triggerId)
    if (trigger === undefined) return []
    const owners: TicketId[] = []
    for (const ref of trigger.threads) {
      const thread = this.repo.getThreadByKey(this.deps.qunoId, ref.source, ref.id)
      if (thread === undefined) continue
      for (const subscription of this.repo.listSubscriptionsByThread(thread.id)) {
        if (subscription.mode !== 'owned' || subscription.cancelledAt !== null) continue
        if (subscription.ticketId === excludeTicketId) continue
        const ticket = this.repo.getTicket(subscription.ticketId)
        if (ticket === undefined || ticket.ended !== null) continue
        const record = this.repo.findInputByTrigger(ticket.id, triggerId)
        if (record !== undefined && record.handedBackAt !== null) continue
        owners.push(ticket.id)
      }
    }
    return owners
  }

  /**
   * A Ticket's owned Thread is the work itself; only followed (context)
   * Threads keep a once Ticket open after a `ready` report. A persistent
   * Ticket additionally waits for its owned Thread to be closed by the Source.
   */
  private noOpenFollowedThreads(ticketId: TicketId, includeOwned = false): boolean {
    for (const subscription of this.repo.listSubscriptionsByTicket(ticketId)) {
      if (subscription.cancelledAt !== null) continue
      if (subscription.mode === 'owned' && !includeOwned) continue
      const thread = this.repo.getThread(subscription.threadId)
      if (thread === undefined) continue
      if (thread.closed === null) return false
    }
    return true
  }

  private closeIfAllThreadsClosed(ticketId: TicketId, now: number, by: 'executor' | 'source' | 'host'): void {
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined || ticket.ended !== null) return
    if (!this.noOpenFollowedThreads(ticketId, ticket.mode === 'persistent')) return
    const assignment = this.repo.findActiveAssignment(ticket.id)
    const report = assignment?.report ?? null
    if (report === null) {
      // Nothing to deliver yet: keep the Ticket until the executor reports.
      if (assignment === undefined || assignment.state === 'ended') {
        this.endTicket(ticket.id, by, 'closed', 'all followed Threads are closed', now)
      }
      return
    }
    if (!reportIsTerminalResult(report.state)) return
    this.endTicket(ticket.id, by, report.state === 'dropped' ? 'dropped' : 'completed', report.summary, now)
  }

  private requireOpenTicket(ticketId: TicketId): TicketRecord {
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined) throw new QunoStateError('unknown-ticket', `ticket ${ticketId} is not known`)
    if (ticket.ended !== null) throw new QunoStateError('ticket-ended', 'this Ticket has already ended')
    return ticket
  }

  private subscriptionById(id: string): SubscriptionRecord | undefined {
    for (const ticket of this.repo.listTickets(this.deps.qunoId, { limit: 500 })) {
      for (const subscription of this.repo.listSubscriptionsByTicket(ticket.id)) {
        if (subscription.id === id) return subscription
      }
    }
    return undefined
  }

  private inputForExchange(
    exchange: ExchangeRecord,
    message: ExchangeMessageRecord,
    now: number,
    create: boolean,
  ): string | null {
    const ticketId = ticketIdFromEndpoint(exchange.requester)
    if (ticketId === null) {
      // Router requester: the response becomes a relay to the permanent
      // conversation rather than a TicketInput.
      if (create) {
        this.repo.enqueueEffect({
          kind: 'router-relay',
          key: `exchange:${exchange.id}`,
          payload: { exchangeId: exchange.id, responseMessageId: message.id },
          now,
        })
      }
      return null
    }
    const ticket = this.repo.getTicket(ticketId)
    if (ticket === undefined) return null
    if (ticket.ended !== null) return null
    const id = inputIdFor({ ticketId, kind: 'response', exchangeId: exchange.id })
    if (this.repo.getInput(id) !== undefined) return id
    if (!create) return id
    const record: TicketInputRecord = {
      id,
      qunoId: this.deps.qunoId,
      ticketId,
      kind: 'response',
      triggerId: null,
      exchangeId: exchange.id,
      human: false,
      context: false,
      text: summarizePayload(message.payload),
      createdAt: now,
      deliveredTo: null,
      deliveredAt: null,
      readAt: null,
      acknowledgedAt: null,
      handedBackAt: null,
    }
    this.repo.insertInput(record)
    this.repo.enqueueEffect({ kind: 'input-delivery', key: ticketId, payload: { ticketId }, now })
    return id
  }
}

/** A bounded read model for the Router's `quno_eval` tool. */
export interface CandidateView {
  readonly eval: EvalRecord
  readonly thread: ThreadRecord | undefined
  readonly triggers: readonly TriggerRecord[]
  readonly tickets: readonly TicketRecord[]
  readonly admissible: readonly {
    readonly triggerId: TriggerId
    readonly type: string
    readonly human: boolean
    readonly addressed: 'mention' | 'direct' | null
    readonly summary: string | null
    readonly occurredAt: number | null
    readonly channel: ChannelRef | null
  }[]
}

/** Role-scoped Engine surface used by Organ/Sense adapters. */
export type EngineForOrgans = Pick<Engine, 'receive' | 'threadClosed' | 'completeExchange' | 'exchangeDelivered' | 'activeEvalForThread'>
/** Role-scoped Engine surface used by the permanent-conversation Router. */
export type EngineForRouter = Pick<
  Engine,
  | 'decide'
  | 'directAccept'
  | 'attach'
  | 'note'
  | 'candidateView'
  | 'candidateDelivered'
  | 'requestExchange'
  | 'policySnapshot'
>
/** Role-scoped Engine surface used by explicit user actions. */
export type EngineForPeople = Pick<Engine, 'stopTicket' | 'retryTicket' | 'reevaluate' | 'unsubscribe'>
/** Role-scoped Engine surface used by executor sessions. */
export type EngineForExecutor = Pick<
  Engine,
  'assignmentStarted'
  | 'inputsDelivered'
  | 'inputsRead'
  | 'deliveryFailed'
  | 'turnEnded'
  | 'report'
  | 'handback'
  | 'followForContext'
  | 'markUnrelated'
  | 'requestExchange'
  | 'consumeExchange'
  | 'subscriptionsForTicket'
>
/** Role-scoped Engine surface used by settings changes. */
export type EngineForSettings = Pick<Engine, 'policyChanged' | 'pauseEvals' | 'resumeEvals'>

// ------------------------------------------------------------------ helpers

/** Normalize the declared Threads: primary first, deduplicated, never empty. */
export function normalizeThreadRefs(refs: readonly ThreadRef[], eventKey: string): readonly ThreadRef[] {
  const out: ThreadRef[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    if (ref.source === '' || ref.id === '') continue
    const key = `${ref.source}\u0000${ref.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  if (out.length === 0) out.push({ source: 'quno', id: fallbackThreadKey(eventKey) })
  return out
}

/** The stable executor session id one Ticket reuses across Assignments. */
export function executorSessionIdFor(ticketId: TicketId): string {
  return `quno-exec-${ticketId}`
}

/** Deterministic direct-click Ticket id (retry of the same tool call reuses it). */
export function stableDirectTicketId(sessionId: string, messageId: string, toolCallId: string): TicketId {
  return `ticket_direct_${hashToken(`${sessionId}\u0000${messageId}\u0000${toolCallId}`)}`
}

/** Extract the Ticket id from a `ticket:<id>` endpoint. */
export function ticketIdFromEndpoint(endpoint: string): TicketId | null {
  return endpoint.startsWith('ticket:') ? endpoint.slice('ticket:'.length) : null
}

/** Whether a finished Ticket may be resumed by a later owned human message. */
export function canResumeTicket(ticket: Pick<TicketRecord, 'ended'>): boolean {
  if (ticket.ended === null) return false
  if (ticket.ended.by === 'human') return false
  return ticket.ended.outcome === 'closed' || ticket.ended.outcome === 'dropped' || ticket.ended.outcome === 'completed' || ticket.ended.outcome === 'failed'
}

/** Normalize a Worker report: bounded text, bounded artifacts, absolute time. */
export function normalizeReport(report: WorkerReport, now: number): WorkerReport {
  const state: ReportState = report.state
  return {
    state,
    summary: report.summary.slice(0, 8000),
    at: report.at === 0 ? now : report.at,
    artifacts: report.artifacts.slice(0, 20),
    ...(report.question === undefined ? {} : { question: { question: report.question.question.slice(0, 2000), ...(report.question.triggerId === undefined ? {} : { triggerId: report.question.triggerId }) } }),
  }
}

/** Deduplicate channel refs by (source, thread, address). */
export function dedupeChannels(channels: readonly ChannelRef[]): readonly ChannelRef[] {
  const out: ChannelRef[] = []
  const seen = new Set<string>()
  for (const channel of channels) {
    const key = `${channel.source}\u0000${channel.thread}\u0000${JSON.stringify(channel.address)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(channel)
  }
  return out
}

/** Stable content hash for idempotent exchange messages. */
export function contentHashOf(value: unknown): string {
  return hashToken(stableStringify(value))
}

/** Short bounded summary of an exchange payload. */
export function summarizePayload(payload: unknown): string {
  const text = stableStringify(payload)
  return text.length > 2000 ? `${text.slice(0, 2000)}…` : text
}

/** Bind one Trigger to one Ticket input; exported for tests. */
export function ticketInputId(ticketId: TicketId, triggerId: TriggerId): string {
  return ticketInputIdForTrigger(ticketId, triggerId)
}

/** Router endpoint helper used by composition code (no model semantics). */
export function routerTicketEndpoint(ticketId: TicketId): string {
  return ticketEndpoint(ticketId)
}

/** The router endpoint of one Quno as a string (composition convenience). */
export function routerEndpointFor(qunoId: string): string {
  return routerEndpoint(qunoId)
}

/** Stable request id for an eval candidate delivery. */
export function candidateRequestId(evalId: EvalId): string {
  return evalMessageRequestId(evalId)
}

/** Actor used by programmatic host actions. */
export const HOST_ACTOR: ActorRef = { source: 'host', id: 'quno' }

/** Export for role adapters. */
export type { EvalStatus, InputKind, DeliveryMode }
