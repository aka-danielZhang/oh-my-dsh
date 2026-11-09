/**
 * Domain tests for the Engine: the behaviour that must hold independently of
 * SQLite, Cordis or a live model.
 *
 * @module dsh-quno/tests/core-domain
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryRepository } from '../src/core/memory-store.ts'
import { buildPolicy, type PolicyRule } from '../src/core/policy.ts'
import { Engine, executorSessionIdFor, type EngineDeps } from '../src/core/engine.ts'
import type {
  EvalRecord,
  TicketRecord,
  TriggerDraft,
  WorkerReport,
} from '../src/core/model.ts'

interface Fixture {
  readonly repo: MemoryRepository
  readonly engine: Engine
  readonly state: {
    configRevision: number
    paused: boolean
    acceptMode: 'off' | 'observe' | 'auto'
    evalTimeoutMs: number
    rules: PolicyRule[]
  }
  readonly nextId: () => string
}

function fixture(patch: {
  acceptMode?: 'off' | 'observe' | 'auto'
  rules?: PolicyRule[]
  paused?: boolean
} = {}): Fixture {
  const repo = new MemoryRepository()
  let counter = 0
  const state: Fixture['state'] = {
    configRevision: 1,
    paused: patch.paused ?? false,
    acceptMode: patch.acceptMode ?? 'auto',
    evalTimeoutMs: 60_000,
    rules: patch.rules ?? [],
  }
  const deps: EngineDeps = {
    repo,
    qunoId: 'quno',
    policy: () => state,
    policySnapshot: (snapshot) => buildPolicy({
      version: `v${String(snapshot.configRevision)}`,
      paused: snapshot.paused,
      acceptMode: snapshot.acceptMode,
      evalTimeoutMs: snapshot.evalTimeoutMs,
      rules: snapshot.rules,
    }),
    nextId: (prefix) => {
      counter += 1
      return `${prefix}_${String(counter)}`
    },
    defaultCwd: '/tmp/quno-test',
  }
  return { repo, engine: new Engine(deps), state, nextId: () => `id_${String(++counter)}` }
}

let clock = 1_000_000

function now(): number {
  clock += 1000
  return clock
}

function draft(patch: Partial<TriggerDraft> & { eventKey: string; type?: string; thread?: string }): TriggerDraft {
  const at = now()
  const thread = patch.thread ?? 'group-1'
  return {
    qunoId: 'quno',
    sourceId: 'im',
    type: patch.type ?? 'im.message.created',
    schema: 'quno.event/v1',
    threads: [{ source: 'im', id: thread }],
    actor: { source: 'im', id: 'user-1' },
    human: true,
    addressed: 'mention',
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    summary: `message ${patch.eventKey}`,
    data: { text: patch.eventKey },
    contentRef: null,
    channel: null,
    operation: 'upsert',
    priority: 'p2',
    deadline: null,
    correlationKeys: [],
    supersedesTriggerIds: [],
    parentTriggerIds: [],
    provenance: { kind: 'observed' },
    contentHash: `hash-${patch.eventKey}`,
    configRevision: 1,
    expiresAt: null,
    ...patch,
    eventKey: patch.eventKey,
  }
}

function threadIdOf(f: Fixture, threadKey = 'group-1'): string {
  const thread = f.repo.listThreads('quno', { limit: 10 }).find(item => item.threadKey === threadKey)
  assert.ok(thread, `thread ${threadKey} should exist`)
  return thread.id
}

function acceptFirstEval(f: Fixture, title = '整理群里的需求'): { evalRecord: EvalRecord; ticket: TicketRecord } {
  const received = f.engine.receive(draft({ eventKey: 'evt-1' }), now())
  assert.equal(received.status, 'accepted')
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  const outcome = f.engine.decide({
    evalId: evalRecord.id,
    kind: 'accept',
    reason: 'human mention needs a ticket',
    title,
    goal: '读完上下文并给出结论',
    now: now(),
  })
  assert.ok(outcome.ticket)
  return { evalRecord, ticket: outcome.ticket }
}

test('intake creates one trigger, one primary thread and dedupes by identity', () => {
  const f = fixture()
  const first = f.engine.receive(draft({ eventKey: 'a' }), now())
  assert.equal(first.status, 'accepted')
  assert.equal(first.threadIds.length, 1)
  assert.equal(first.evalRequested, true)
  const duplicate = f.engine.receive(draft({ eventKey: 'a' }), now())
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.triggerId, first.triggerId)
  assert.throws(
    () => f.engine.receive({ ...draft({ eventKey: 'a' }), contentHash: 'different' }, now()),
    /already exists with different content/,
  )
})

test('intake records a filtered trigger without creating an Eval', () => {
  const repo = new MemoryRepository()
  let counter = 0
  const engine = new Engine({
    repo,
    qunoId: 'quno',
    policy: () => ({ configRevision: 1, paused: false, acceptMode: 'auto', evalTimeoutMs: 1000, rules: [] }),
    policySnapshot: (s) => buildPolicy({ version: 'v1', paused: s.paused, acceptMode: s.acceptMode, evalTimeoutMs: s.evalTimeoutMs, rules: s.rules }),
    nextId: (prefix) => `${prefix}_${String(++counter)}`,
    defaultCwd: '/tmp',
    filterTrigger: () => ({ filtered: true, reason: 'outside configured scope' }),
  })
  const outcome = engine.receive(draft({ eventKey: 'x' }), now())
  assert.equal(outcome.status, 'filtered')
  assert.equal(repo.countPending(threadIdOf({ repo, engine, state: {} as never, nextId: () => '' })), 0)
  assert.equal(repo.listEvals('quno', { limit: 10 }).length, 0)
})

test('a threaded trigger writes correlation edges for every declared thread', () => {
  const f = fixture()
  const outcome = f.engine.receive(draft({
    eventKey: 'multi',
    threads: [
      { source: 'im', id: 'group-1' },
      { source: 'pr', id: 'pull-42' },
    ],
  }), now())
  assert.equal(outcome.threadIds.length, 2)
  const primary = f.repo.getThread(outcome.threadIds[0] ?? '')
  const secondary = f.repo.getThread(outcome.threadIds[1] ?? '')
  assert.ok(primary && secondary)
  assert.deepEqual(primary.correlatedThreadIds, [secondary.id])
  assert.deepEqual(secondary.correlatedThreadIds, [primary.id])
})

test('openEvals creates one Eval per Thread and a delivery Effect', () => {
  const f = fixture()
  const received = f.engine.receive(draft({ eventKey: 'a' }), now())
  assert.equal(received.evalRequested, true)
  f.engine.receive(draft({ eventKey: 'b' }), now())
  assert.equal(f.engine.openEvals(now()), 1)
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  assert.equal(evalRecord.status, 'delivering')
  assert.equal(evalRecord.triggerIds.length, 2)
  const effect = f.repo.listDueEffects(now(), 10).find(item => item.kind === 'eval-delivery' && item.key === evalRecord.id)
  assert.ok(effect)
  assert.equal(effect.payload !== null, true)
})

test('not-admitted triggers record an ignore decision instead of a model call', () => {
  const f = fixture({ acceptMode: 'off' })
  f.engine.receive(draft({
    eventKey: 'bot-1',
    human: false,
    addressed: null,
    actor: { source: 'ci', id: 'build' },
  }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  assert.equal(evalRecord.status, 'decided')
  const decision = f.repo.findDecisionByEval(evalRecord.id)
  assert.ok(decision)
  assert.equal(decision.kind, 'ignore')
  assert.equal(decision.ticketId, null)
})

test('observe records would_accept and downgrades inferred accepts', () => {
  const f = fixture({
    acceptMode: 'observe',
    rules: [{ id: 'rule-bot', sourceId: 'im' }],
  })
  f.engine.receive(draft({
    eventKey: 'bot-2',
    human: false,
    addressed: null,
  }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  assert.equal(evalRecord.strength, 'inferred')
  const outcome = f.engine.decide({
    evalId: evalRecord.id,
    kind: 'accept',
    reason: 'this would be accepted automatically',
    title: '自动任务',
    goal: '被 observe 拦下',
    now: now(),
  })
  assert.equal(outcome.downgraded, true)
  assert.equal(outcome.decision.kind, 'ignore')
  assert.equal(outcome.decision.audit['wouldAccept'], true)
  assert.equal(outcome.ticket, null)
  assert.equal(f.repo.listTickets('quno', { limit: 10 }).length, 0)
})

test('accept writes Decision, Ticket, Mandate, Assignment, Subscription and launch Effect in one transaction', () => {
  const f = fixture()
  const { evalRecord, ticket } = acceptFirstEval(f)
  assert.equal(ticket.mode, 'once')
  assert.equal(ticket.mandate.strength, 'explicit')
  assert.equal(ticket.mandate.basis.via, 'addressed')
  assert.equal(ticket.mandate.permissionPreset, 'quno-task')
  assert.equal(ticket.decisionId === null, false)
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  assert.equal(assignment.state, 'pending')
  assert.equal(assignment.executorSessionId, executorSessionIdFor(ticket.id))
  const subscriptions = f.repo.listSubscriptionsByTicket(ticket.id)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0]?.mode, 'owned')
  const effect = f.repo.listDueEffects(now(), 10).find(item => item.kind === 'assignment-launch')
  assert.ok(effect)
  assert.equal(effect.key, assignment.id)
  const decision = f.repo.findDecisionByEval(evalRecord.id)
  assert.ok(decision)
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.ticketId, ticket.id)
})

test('repeating an accept returns the original Decision and Ticket', () => {
  const f = fixture()
  const { evalRecord, ticket } = acceptFirstEval(f)
  const repeat = f.engine.decide({
    evalId: evalRecord.id,
    kind: 'accept',
    reason: 'retry',
    title: 'ignored',
    goal: 'ignored',
    now: now(),
  })
  assert.equal(repeat.ticket?.id, ticket.id)
  assert.equal(f.repo.listTickets('quno', { limit: 10 }).length, 1)
  assert.equal(f.repo.listAssignmentsByTicket(ticket.id).length, 1)
})

test('a conflicting second decision is rejected', () => {
  const f = fixture()
  const { evalRecord } = acceptFirstEval(f)
  assert.throws(
    () => f.engine.decide({
      evalId: evalRecord.id,
      kind: 'ignore',
      reason: 'changed my mind',
      now: now(),
    }),
    /was already decided as accept/,
  )
})

test('directAccept is idempotent on sessionId + messageId + toolCallId', () => {
  const f = fixture()
  const input = {
    sessionId: 'main',
    messageId: 'msg-1',
    toolCallId: 'call-1',
    title: '查一下合同',
    goal: '整理关键条款',
    now: now(),
  }
  const first = f.engine.directAccept(input)
  const second = f.engine.directAccept({ ...input, now: now() })
  assert.equal(second.id, first.id)
  assert.equal(first.mandate.basis.via, 'direct')
  assert.equal(first.mandate.basis.sourceId, null)
  assert.equal(f.repo.listTickets('quno', { limit: 10 }).length, 1)
  assert.equal(f.repo.listAssignmentsByTicket(first.id).length, 1)
})

test('a human follow-up on an owned Thread suppresses Eval and becomes one idempotent input', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const before = f.repo.listEvals('quno', { limit: 10 }).length
  const received = f.engine.receive(draft({ eventKey: 'follow-1' }), now())
  assert.deepEqual(received.followupOwners, [ticket.id])
  assert.equal(received.evalRequested, false)
  assert.equal(received.inputIds.length, 1)
  assert.equal(f.repo.listEvals('quno', { limit: 10 }).length, before)
  assert.equal(f.repo.countPending(threadIdOf(f)), 0)
  const inputs = f.repo.listInputsByTicket(ticket.id)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]?.human, true)
  assert.equal(inputs[0]?.kind, 'trigger')
})

test('a bot message on a live owned Thread reaches the executor without re-Eval', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const received = f.engine.receive(draft({
    eventKey: 'bot-follow',
    human: false,
    addressed: null,
    actor: { source: 'im', id: 'bot' },
  }), now())
  assert.equal(received.evalRequested, false)
  assert.deepEqual(received.followupOwners, [])
  assert.equal(f.repo.listInputsByTicket(ticket.id).length, 1)
})

test('a context-only subscription routes input but never owns the follow-up', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  // Second trigger in a different thread creates a new Thread and Eval.
  const other = f.engine.receive(draft({ eventKey: 'other-1', thread: 'thread-2' }), now())
  const otherThread = other.threadIds[0] ?? ''
  f.engine.attach({ ticketId: ticket.id, threadIds: [otherThread], mode: 'context', origin: 'executor', now: now() })
  const follow = f.engine.receive(draft({ eventKey: 'other-2', thread: 'thread-2' }), now())
  assert.deepEqual(follow.followupOwners, [])
  assert.equal(follow.evalRequested, true)
  assert.equal(f.repo.listInputsByTicket(ticket.id).length, 1)
  assert.equal(f.repo.listInputsByTicket(ticket.id).filter(item => item.context).length, 1)
})

test('candidate delivery starts the timeout only after the candidate lands', () => {
  const f = fixture()
  f.engine.receive(draft({ eventKey: 'a' }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  assert.equal(evalRecord.deliveredAt, null)
  const delivered = f.engine.candidateDelivered({ evalId: evalRecord.id, messageId: 'quno:m1', now: now() })
  assert.ok(delivered)
  assert.equal(delivered.status, 'waiting-decision')
  assert.ok(delivered.deliveredAt !== null)
  assert.equal(delivered.deadline, delivered.deliveredAt + 60_000)
})

test('three eval timeouts end in unavailable and settle the pending batch', () => {
  const f = fixture()
  f.engine.receive(draft({ eventKey: 'a' }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  f.engine.candidateDelivered({ evalId: evalRecord.id, messageId: 'quno:m1', now: now() })
  const later = now() + 120_000
  assert.equal(f.engine.expireEvals(later), 1)
  let current = f.repo.getEval(evalRecord.id)
  assert.ok(current)
  assert.equal(current.expiryCount, 1)
  assert.equal(current.deliveredAt, null)
  f.engine.candidateDelivered({ evalId: evalRecord.id, messageId: 'quno:m1', now: later })
  assert.equal(f.engine.expireEvals(later + 120_000), 1)
  current = f.repo.getEval(evalRecord.id)
  assert.ok(current)
  assert.equal(current.expiryCount, 2)
  f.engine.candidateDelivered({ evalId: evalRecord.id, messageId: 'quno:m1', now: later + 120_000 })
  assert.equal(f.engine.expireEvals(later + 240_000), 1)
  current = f.repo.getEval(evalRecord.id)
  assert.ok(current)
  assert.equal(current.status, 'unavailable')
  const decision = f.repo.findDecisionByEval(evalRecord.id)
  assert.ok(decision)
  assert.equal(decision.kind, 'unavailable')
  assert.equal(f.repo.findActiveEval(evalRecord.threadId), undefined)
  assert.equal(f.repo.countPending(evalRecord.threadId), 0)
})

test('a ready report completes a once Ticket and enqueues a Router relay', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  f.engine.assignmentStarted({ assignmentId: assignment.id, now: now() })
  const report: WorkerReport = {
    state: 'ready',
    summary: '整理完成：三条需求',
    at: now(),
    artifacts: [{ kind: 'note', label: '结论', uri: 'note://result' }],
  }
  const outcome = f.engine.report({ assignmentId: assignment.id, report, now: now() })
  assert.equal(outcome.ended, true)
  assert.ok(outcome.ticket.ended)
  assert.equal(outcome.ticket.ended?.outcome, 'completed')
  const relay = f.repo.listDueEffects(now(), 20).find(item => item.kind === 'router-relay')
  assert.ok(relay)
  assert.equal(relay.key, ticket.id)
  const endedAssignment = f.repo.getAssignment(assignment.id)
  assert.equal(endedAssignment?.state, 'ended')
})

test('a blocked report keeps the Ticket open and records its question', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  const outcome = f.engine.report({
    assignmentId: assignment.id,
    report: {
      state: 'blocked',
      summary: '缺少访问权限',
      at: now(),
      artifacts: [],
      question: { question: '要用哪个账号登录？' },
    },
    now: now(),
  })
  assert.equal(outcome.ended, false)
  assert.equal(outcome.ticket.ended, null)
  assert.equal(outcome.ticket.question?.question, '要用哪个账号登录？')
})

test('stopTicket requeues unprocessed human follow-ups for a fresh Eval', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  f.engine.receive(draft({ eventKey: 'follow-1' }), now())
  const input = f.repo.listInputsByTicket(ticket.id)[0]
  assert.ok(input)
  f.engine.stopTicket({ ticketId: ticket.id, by: 'human', reason: 'not needed', now: now() })
  const stopped = f.repo.getTicket(ticket.id)
  assert.ok(stopped?.ended)
  assert.equal(stopped?.ended?.by, 'human')
  // The unread human message is returned to the thread's Evaluable stream.
  assert.equal(f.repo.countPending(threadIdOf(f)), 1)
  // A later human message is rejected by the stopped Ticket and evaluated anew.
  const next = f.engine.receive(draft({ eventKey: 'follow-2' }), now())
  assert.deepEqual(next.followupOwners, [])
  assert.equal(next.evalRequested, true)
})

test('handback returns the Trigger to Eval only after the last owner releases it', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  const follow = f.engine.receive(draft({ eventKey: 'follow-1' }), now())
  const triggerId = follow.triggerId
  const outcome = f.engine.handback({
    ticketId: ticket.id,
    triggerId,
    assignmentId: assignment.id,
    reason: 'out of scope',
    now: now(),
  })
  assert.equal(outcome.handedBack, true)
  assert.equal(outcome.returnedToEval, true)
  const input = f.repo.findInputByTrigger(ticket.id, triggerId)
  assert.ok(input?.handedBackAt !== null)
  assert.equal(f.repo.countPending(threadIdOf(f)), 1)
})

test('mandate revalidation blocks resuming a Ticket under a changed inferred policy', () => {
  const f = fixture({
    acceptMode: 'auto',
    rules: [{ id: 'rule-bot', sourceId: 'im' }],
  })
  f.engine.receive(draft({
    eventKey: 'bot-1',
    human: false,
    addressed: null,
  }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  const { ticket } = f.engine.decide({
    evalId: evalRecord.id,
    kind: 'accept',
    reason: 'rule matched',
    title: '自动任务',
    goal: '做点事',
    now: now(),
  }) as { decision: unknown; ticket: TicketRecord; downgraded: boolean }
  assert.ok(ticket)
  // A human stops the work, then the policy drops the rule; a retry must fail.
  f.engine.stopTicket({ ticketId: ticket.id, by: 'host', now: now() })
  f.state.configRevision = 2
  f.state.rules = []
  assert.throws(() => f.engine.retryTicket({ ticketId: ticket.id, now: now() }), /policy version changed/)
})

test('exchange responses return to the recorded requester, not a claimed replyTo', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const exchange = f.engine.requestExchange({
    kind: 'request',
    requester: `ticket:${ticket.id}`,
    responder: 'organ:calendar',
    payload: { query: 'tomorrow' },
    deadlineMs: 60_000,
    now: now(),
  })
  assert.throws(
    () => f.engine.completeExchange({
      exchangeId: exchange.id,
      responder: 'organ:other',
      result: { ok: true },
      now: now(),
    }),
    /only the addressed responder/,
  )
  const outcome = f.engine.completeExchange({
    exchangeId: exchange.id,
    responder: 'organ:calendar',
    result: { events: [] },
    now: now(),
  })
  assert.equal(outcome.late, false)
  assert.ok(outcome.inputId)
  const input = f.repo.getInput(outcome.inputId ?? '')
  assert.ok(input)
  assert.equal(input.ticketId, ticket.id)
  assert.equal(input.kind, 'response')
})

test('an expired exchange keeps a late response as evidence without reopening work', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const exchange = f.engine.requestExchange({
    kind: 'request',
    requester: `ticket:${ticket.id}`,
    responder: 'organ:calendar',
    payload: {},
    deadlineMs: 1000,
    now: now(),
  })
  assert.equal(f.engine.expireExchanges(now() + 5000), 1)
  const late = f.engine.completeExchange({
    exchangeId: exchange.id,
    responder: 'organ:calendar',
    result: { late: true },
    now: now() + 6000,
  })
  assert.equal(late.late, true)
  assert.equal(late.inputId, null)
  assert.equal(f.repo.listInputsByTicket(ticket.id).length, 0) // no TicketInput for a late response
})

test('effect merge bumps generation and a stale completion is rejected', () => {
  const repo = new MemoryRepository()
  const first = repo.enqueueEffect({ kind: 'input-delivery', key: 'ticket_1', payload: { v: 1 }, now: 100 })
  const second = repo.enqueueEffect({ kind: 'input-delivery', key: 'ticket_1', payload: { v: 2 }, now: 101 })
  assert.equal(first.seq, 1)
  assert.equal(second.seq, 2)
  assert.equal(second.generation, 2)
  assert.equal(repo.completeEffect('input-delivery', 'ticket_1', first.seq, first.generation), false)
  assert.equal(repo.completeEffect('input-delivery', 'ticket_1', second.seq, second.generation), true)
  assert.equal(repo.getEffect('input-delivery', 'ticket_1'), undefined)
})

test('policy change writes a PolicyInput to live Tickets and re-ranks in-flight Evals', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  f.engine.receive(draft({ eventKey: 'other', thread: 'thread-9' }), now())
  f.engine.openEvals(now())
  const active = f.repo.listEvals('quno', { status: ['delivering', 'waiting-decision'], limit: 10 })[0]
  assert.ok(active)
  f.state.configRevision = 2
  f.state.acceptMode = 'observe'
  const written = f.engine.policyChanged(now())
  assert.equal(written, 1)
  const policyInput = f.repo.listInputsByTicket(ticket.id).find(item => item.kind === 'policy')
  assert.ok(policyInput)
  const reRanked = f.repo.getEval(active.id)
  assert.equal(reRanked?.status, 'unavailable')
  const decision = f.repo.findDecisionByEval(active.id)
  assert.ok(decision)
  assert.equal(decision.kind, 'unavailable')
  assert.equal(f.repo.findActiveEval(active.threadId), undefined)
})

test('pause freezes Eval deadlines and resume shifts them by the paused duration', () => {
  const f = fixture()
  f.engine.receive(draft({ eventKey: 'a' }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  f.engine.candidateDelivered({ evalId: evalRecord.id, messageId: 'quno:m1', now: now() })
  const before = f.repo.getEval(evalRecord.id)
  assert.ok(before)
  const pausedAt = now()
  f.engine.pauseEvals(pausedAt)
  const paused = f.repo.getEval(evalRecord.id)
  assert.equal(paused?.pausedAt, pausedAt)
  const resumedAt = pausedAt + 30_000
  f.engine.resumeEvals(resumedAt)
  const resumed = f.repo.getEval(evalRecord.id)
  assert.equal(resumed?.pausedAt, null)
  assert.equal(resumed?.deadline, before.deadline + 30_000)
})

test('retryTicket reuses the same executor session under a new Assignment', () => {
  const f = fixture()
  const { ticket } = acceptFirstEval(f)
  const first = f.repo.findActiveAssignment(ticket.id)
  assert.ok(first)
  f.engine.stopTicket({ ticketId: ticket.id, by: 'host', reason: 'restart', now: now() })
  const retried = f.engine.retryTicket({ ticketId: ticket.id, now: now() })
  assert.notEqual(retried.id, first.id)
  assert.equal(retried.executorSessionId, first.executorSessionId)
  const reopened = f.repo.getTicket(ticket.id)
  assert.equal(reopened?.ended, null)
})
