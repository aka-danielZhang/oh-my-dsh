/**
 * End-to-end domain flow: Trigger → Eval candidate → Decision → Assignment →
 * Input → Report → Router relay, driven through the durable Effect outbox
 * exactly as the Host wires it.
 *
 * No model and no SQLite are involved: this is the contract the real
 * composition must satisfy, and it fails loudly if any transaction boundary
 * forgets to enqueue or acknowledge a durable step.
 *
 * @module dsh-quno/tests/eval-flow
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryRepository } from '../src/core/memory-store.ts'
import { buildPolicy } from '../src/core/policy.ts'
import { Engine } from '../src/core/engine.ts'
import { EffectsRuntime } from '../src/app/effects.ts'
import { computeMetrics } from '../src/app/metrics.ts'
import type { EvalRecord, TriggerDraft } from '../src/core/model.ts'

const logger = { warn: () => {}, info: () => {} }

interface Flow {
  readonly repo: MemoryRepository
  readonly engine: Engine
  readonly effects: EffectsRuntime
  readonly state: { configRevision: number; paused: boolean; acceptMode: 'off' | 'observe' | 'auto'; evalTimeoutMs: number; rules: { id: string; sourceId?: string }[] }
  readonly candidates: EvalRecord[]
  readonly launches: string[]
  readonly inputs: string[]
  readonly relays: { ticketId?: string; assignmentId?: string }[]
  readonly now: () => number
}

function flow(patch: { acceptMode?: 'off' | 'observe' | 'auto'; rules?: { id: string; sourceId?: string }[] } = {}): Flow {
  const repo = new MemoryRepository()
  let counter = 0
  let clock = 1_000_000
  const state: Flow['state'] = {
    configRevision: 1,
    paused: false,
    acceptMode: patch.acceptMode ?? 'auto',
    evalTimeoutMs: 60_000,
    rules: patch.rules ?? [],
  }
  const candidates: EvalRecord[] = []
  const launches: string[] = []
  const inputs: string[] = []
  const relays: { ticketId?: string; assignmentId?: string }[] = []
  const engine = new Engine({
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
    nextId: (prefix) => `${prefix}_${String(++counter)}`,
    defaultCwd: '/tmp/quno-flow',
  })
  const now = (): number => (clock += 1000)
  const effects = new EffectsRuntime({
    repo,
    logger,
    now: () => clock,
    handlers: {
      'eval-delivery': async (effect) => {
        const payload = effect.payload as { evalId?: string; threadId?: string }
        let evalRecord: EvalRecord | null = null
        if (payload.evalId !== undefined) {
          const current = repo.getEval(payload.evalId)
          if (current === undefined || (current.status !== 'delivering' && current.status !== 'waiting-decision')) return
          evalRecord = current
        } else if (payload.threadId !== undefined) {
          evalRecord = engine.openEval(payload.threadId, now())
        }
        if (evalRecord === null || evalRecord.status !== 'delivering') return
        candidates.push(evalRecord)
        engine.candidateDelivered({ evalId: evalRecord.id, messageId: `quno:eval:${evalRecord.id}`, now: now() })
      },
      'assignment-launch': async (effect) => {
        const payload = effect.payload as { assignmentId: string }
        launches.push(payload.assignmentId)
        engine.assignmentStarted({ assignmentId: payload.assignmentId, now: now() })
      },
      'input-delivery': async (effect) => {
        const payload = effect.payload as { ticketId: string }
        const assignment = repo.findActiveAssignment(payload.ticketId)
        if (assignment === undefined) return
        const pending = repo.listInputsByTicket(payload.ticketId, { undelivered: true, limit: 20 })
        if (pending.length === 0) return
        inputs.push(...pending.map(input => input.id))
        engine.inputsDelivered({ ticketId: payload.ticketId, inputIds: pending.map(input => input.id), assignmentId: assignment.id, now: now() })
      },
      'router-relay': async (effect) => {
        relays.push(effect.payload as { ticketId?: string; assignmentId?: string })
      },
    },
  })
  return { repo, engine, effects, state, candidates, launches, inputs, relays, now }
}

function draft(eventKey: string, patch: Partial<TriggerDraft> = {}): TriggerDraft {
  return {
    qunoId: 'quno',
    sourceId: 'src_im',
    type: 'im.message.created',
    schema: 'quno.event/v1',
    threads: [{ source: 'src_im', id: 'group-1' }],
    actor: { source: 'im', id: 'user-1' },
    human: true,
    addressed: 'mention',
    occurredAt: 1_000_000,
    observedAt: 1_000_000,
    receivedAt: 1_000_000,
    summary: `summary ${eventKey}`,
    data: { key: eventKey },
    contentRef: null,
    channel: null,
    operation: 'upsert',
    priority: 'p2',
    deadline: null,
    correlationKeys: [],
    supersedesTriggerIds: [],
    parentTriggerIds: [],
    provenance: { kind: 'observed' },
    contentHash: `hash-${eventKey}`,
    configRevision: 1,
    expiresAt: null,
    ...patch,
    eventKey,
  }
}

function acceptFirst(flow: Flow): string {
  const candidate = flow.candidates[0]
  assert.ok(candidate)
  const outcome = flow.engine.decide({
    evalId: candidate.id,
    kind: 'accept',
    reason: 'needs work',
    title: '整理需求',
    goal: '读完上下文并给出结论',
    now: flow.now(),
  })
  assert.ok(outcome.ticket)
  return outcome.ticket.id
}

test('the happy path commits every durable step exactly once', async () => {
  const f = flow()
  f.engine.receive(draft('a'), f.now())
  f.engine.receive(draft('b'), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 1)
  assert.equal(f.candidates[0]?.triggerIds.length, 2)
  const ticketId = acceptFirst(f)
  await f.effects.kick()
  assert.equal(f.launches.length, 1)
  const assignment = f.repo.findActiveAssignment(ticketId)
  assert.ok(assignment)
  assert.equal(assignment.state, 'running')

  const follow = f.engine.receive(draft('follow'), f.now())
  assert.deepEqual(follow.followupOwners, [ticketId])
  await f.effects.kick()
  assert.equal(f.inputs.length, 1, 'the human follow-up reaches the executor')

  f.engine.report({
    assignmentId: assignment.id,
    report: { state: 'ready', summary: '完成了', at: f.now(), artifacts: [] },
    now: f.now(),
  })
  await f.effects.kick()
  assert.equal(f.relays.length, 1)
  assert.equal(f.relays[0]?.ticketId, ticketId)
  assert.equal(f.repo.getTicket(ticketId)?.ended?.outcome, 'completed')

  const metrics = computeMetrics(f.repo, 'quno', f.now())
  assert.equal(metrics.evals, 1)
  assert.equal(metrics.triggersJudged, 2)
  assert.equal(metrics.averageBatchSize, 2)
  assert.equal(metrics.accepted, 1)
  assert.equal(metrics.directAcceptRatio, 0)
  assert.equal(metrics.inputDeliveredLatencyMs.samples, 1)
  assert.equal(metrics.inputReadLatencyMs.samples, 1, 'the Report acknowledges the delivered input')
})

test('a 100-trigger burst becomes two bounded Evals, not one hundred Router calls', async () => {
  const f = flow()
  for (let index = 0; index < 100; index += 1) f.engine.receive(draft(`burst-${String(index)}`), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 1)
  assert.equal(f.candidates[0]?.triggerIds.length, 20, 'the eval batch is bounded')
  acceptFirst(f)
  await f.effects.kick()
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 2)
  assert.equal(f.candidates[1]?.triggerIds.length, 20)
})

test('an active Eval suppresses a second candidate for the same Thread', async () => {
  const f = flow()
  f.engine.receive(draft('a'), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 1)
  f.engine.receive(draft('b'), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 1, 'the running Eval keeps its batch')
  const threadId = f.repo.listThreads('quno', { limit: 5 })[0]?.id
  assert.ok(threadId)
  assert.equal(f.repo.countPending(threadId), 2, 'the active batch and the later trigger both wait')
})

test('observe mode records would_accept and creates no Ticket', async () => {
  const f = flow({ acceptMode: 'observe', rules: [{ id: 'rule', sourceId: 'src_im' }] })
  f.engine.receive(draft('bot', { human: false, addressed: null }), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 1)
  const candidate = f.candidates[0]
  assert.ok(candidate)
  const outcome = f.engine.decide({
    evalId: candidate.id,
    kind: 'accept',
    reason: 'would accept',
    title: '任务',
    goal: '目标',
    now: f.now(),
  })
  assert.equal(outcome.downgraded, true)
  assert.equal(outcome.ticket, null)
  assert.equal(f.repo.listTickets('quno', { limit: 5 }).length, 0)
  assert.equal(f.repo.findDecisionByEval(candidate.id)?.audit['wouldAccept'], true)
})

test('a stopped Ticket returns its unprocessed human follow-up to Eval', async () => {
  const f = flow()
  f.engine.receive(draft('a'), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  const ticketId = acceptFirst(f)
  await f.effects.kick()
  const follow = f.engine.receive(draft('follow'), f.now())
  assert.deepEqual(follow.followupOwners, [ticketId])
  // The input never reached the executor: stopping must return it to Eval.
  f.engine.stopTicket({ ticketId, by: 'human', reason: 'stop', now: f.now() })
  const threadId = f.repo.listThreads('quno', { limit: 5 })[0]?.id
  assert.ok(threadId)
  assert.deepEqual(f.repo.listPendingTriggerIds(threadId, 10), [follow.triggerId])
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 2, 'the returned message is evaluated again')
})

test('a policy change re-ranks the in-flight Eval and defers the new decision', async () => {
  const f = flow()
  f.engine.receive(draft('a'), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  const candidate = f.candidates[0]
  assert.ok(candidate)
  f.state.configRevision = 2
  f.state.acceptMode = 'observe'
  f.engine.policyChanged(f.now())
  await f.effects.kick()
  assert.equal(f.repo.getEval(candidate.id)?.status, 'unavailable')
  assert.equal(f.candidates.length, 2, 'the pending Trigger is re-evaluated under the new policy')
  const second = f.candidates[1]
  assert.ok(second)
  assert.equal(second.policyVersion, 'v2')
})

test('duplicate intake never creates a second input or a second candidate', async () => {
  const f = flow()
  f.engine.receive(draft('a'), f.now())
  f.engine.receive(draft('a'), f.now())
  f.engine.openEvals(f.now())
  await f.effects.kick()
  assert.equal(f.candidates.length, 1)
  assert.equal(f.candidates[0]?.triggerIds.length, 1)
})
