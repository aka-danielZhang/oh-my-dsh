/**
 * The SQLite repository must behave exactly like the in-memory reference:
 * same ids, same transaction boundaries, same idempotency. These tests run
 * the Engine against a real scratch SQLite file and re-open it to prove that
 * the state (and the Effect queue) is durable.
 *
 * @module dsh-quno/tests/core-sqlite
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addSense, openFixture } from './helpers.ts'
import { QunoStore } from '../src/store.ts'
import { SqliteRepository } from '../src/app/store.ts'
import { buildPolicy } from '../src/core/policy.ts'
import { Engine } from '../src/core/engine.ts'
import type { TriggerDraft } from '../src/core/model.ts'

interface SqliteFixture {
  readonly store: QunoStore
  readonly repo: SqliteRepository
  readonly engine: Engine
  readonly state: {
    configRevision: number
    paused: boolean
    acceptMode: 'off' | 'observe' | 'auto'
    evalTimeoutMs: number
    rules: { readonly id: string; readonly sourceId?: string }[]
  }
}

function sqliteFixture(store: QunoStore, root: string, now: number): SqliteFixture {
  void root
  let counter = 0
  const repo = new SqliteRepository(store)
  const state: SqliteFixture['state'] = {
    configRevision: 1,
    paused: false,
    acceptMode: 'auto',
    evalTimeoutMs: 60_000,
    rules: [],
  }
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
    defaultCwd: '/tmp/quno-sqlite',
  })
  return { store, repo, engine, state }
}

let clock = 1_700_000_000_000

function now(): number {
  clock += 1000
  return clock
}

function draft(patch: Partial<TriggerDraft> & { eventKey: string; thread?: string }): TriggerDraft {
  const at = now()
  return {
    qunoId: 'quno',
    sourceId: 'src_test',
    type: 'im.message.created',
    schema: 'quno.event/v1',
    threads: [{ source: 'src_test', id: patch.thread ?? 'group-1' }],
    actor: { source: 'im', id: 'user-1' },
    human: true,
    addressed: 'mention',
    occurredAt: at,
    observedAt: at,
    receivedAt: at,
    summary: `summary ${patch.eventKey}`,
    data: { key: patch.eventKey },
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

test('sqlite repository: the full accept → report → relay path persists', () => {
  const fixture = openFixture()
  const { store } = fixture
  addSense(fixture, 'test/im')
  // The stable source id is derived from the Sense instance; use it.
  const source = store.listSources('quno')[0]
  assert.ok(source)
  const f = sqliteFixture(store, fixture.root, fixture.now)
  const received = f.engine.receive(draft({ eventKey: 'evt-1', sourceId: source.id }), now())
  assert.equal(received.status, 'accepted')
  assert.equal(received.evalRequested, true)
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  assert.equal(evalRecord.triggerIds.length, 1)
  const outcome = f.engine.decide({
    evalId: evalRecord.id,
    kind: 'accept',
    reason: 'needs work',
    title: '整理需求',
    goal: '读完上下文',
    now: now(),
  })
  assert.ok(outcome.ticket)
  const ticket = outcome.ticket
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  f.engine.report({
    assignmentId: assignment.id,
    report: { state: 'ready', summary: '完成', at: now(), artifacts: [] },
    now: now(),
  })
  const ended = f.repo.getTicket(ticket.id)
  assert.equal(ended?.ended?.outcome, 'completed')
  const relay = f.repo.listDueEffects(now(), 20).find(item => item.kind === 'router-relay')
  assert.ok(relay)

  // Re-open the same file: every durable fact survives.
  store.close()
  const reopened = new QunoStore({ root: fixture.root })
  reopened.open(now())
  const repo = new SqliteRepository(reopened)
  const ticketAfter = repo.getTicket(ticket.id)
  assert.equal(ticketAfter?.ended?.outcome, 'completed')
  const evalAfter = repo.getEval(evalRecord.id)
  assert.equal(evalAfter?.status, 'decided')
  const relayAfter = repo.listDueEffects(now(), 20).find(item => item.kind === 'router-relay')
  assert.ok(relayAfter)
  assert.equal(repo.getTrigger(received.triggerId)?.eventKey, 'evt-1')
  reopened.close()
})

test('sqlite repository: follow-up input and handback survive the transaction', () => {
  const fixture = openFixture()
  const { store } = fixture
  addSense(fixture, 'test/im')
  const source = store.listSources('quno')[0]
  assert.ok(source)
  const f = sqliteFixture(store, fixture.root, fixture.now)
  f.engine.receive(draft({ eventKey: 'evt-1', sourceId: source.id }), now())
  f.engine.openEvals(now())
  const evalRecord = f.repo.listEvals('quno', { limit: 10 })[0]
  assert.ok(evalRecord)
  const accepted = f.engine.decide({ evalId: evalRecord.id, kind: 'accept', reason: null, title: 'T', goal: 'G', now: now() })
  const ticket = accepted.ticket
  assert.ok(ticket)
  const follow = f.engine.receive(draft({ eventKey: 'evt-2', sourceId: source.id }), now())
  assert.deepEqual(follow.followupOwners, [ticket.id])
  const inputs = f.repo.listInputsByTicket(ticket.id)
  assert.equal(inputs.length, 1)
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  const back = f.engine.handback({
    ticketId: ticket.id,
    triggerId: follow.triggerId,
    assignmentId: assignment.id,
    reason: 'not mine',
    now: now(),
  })
  assert.equal(back.handedBack, true)
  assert.equal(back.returnedToEval, true)
  const pending = f.repo.listPendingTriggerIds(evalRecord.threadId, 10)
  assert.deepEqual(pending, [follow.triggerId])
  store.close()
})

test('sqlite repository: duplicate trigger identity is refused without side effects', () => {
  const fixture = openFixture()
  const { store } = fixture
  addSense(fixture, 'test/im')
  const source = store.listSources('quno')[0]
  assert.ok(source)
  const f = sqliteFixture(store, fixture.root, fixture.now)
  const first = f.engine.receive(draft({ eventKey: 'evt-1', sourceId: source.id }), now())
  const dup = f.engine.receive(draft({ eventKey: 'evt-1', sourceId: source.id }), now())
  assert.equal(dup.status, 'duplicate')
  assert.equal(dup.triggerId, first.triggerId)
  assert.throws(
    () => f.engine.receive({ ...draft({ eventKey: 'evt-1', sourceId: source.id }), contentHash: 'other' }, now()),
    /already exists with different content/,
  )
  assert.equal(f.repo.listThreads('quno', { limit: 10 }).length, 1)
  store.close()
})

test('sqlite migration: legacy tasks become Tickets and Assignments idempotently', () => {
  const fixture = openFixture()
  const { store } = fixture
  const db = store.handle()
  const at = fixture.now
  db.prepare(`INSERT INTO tasks (id, quno_id, child_session_id, parent_session_id, title, prompt,
    status, result, artifacts_json, created_at, updated_at, settled_at)
    VALUES (?, 'quno', 'child-1', 'main-1', '旧任务', '做点事', 'done', '结果', '[{"kind":"note","label":"l","uri":"note://x"}]', ?, ?, ?)`)
    .run('task_legacy_1', at, at, at)
  db.prepare(`INSERT INTO tasks (id, quno_id, child_session_id, parent_session_id, title, prompt,
    status, artifacts_json, created_at, updated_at)
    VALUES (?, 'quno', 'child-2', 'main-1', '中断任务', '继续', 'interrupted', '[]', ?, ?)`)
    .run('task_legacy_2', at, at)
  db.prepare(`INSERT INTO deliveries (id, quno_id, event_id, status, priority, eligible_at, created_at)
    VALUES ('del_1', 'quno', 'evt_legacy_1', 'pending', 'p2', ?, ?)`).run(at, at)
  db.prepare(`INSERT INTO events (id, source_id, event_key, subject_key, subject_revision, type, schema,
    operation, occurred_at, observed_at, received_at, ingest_seq, summary, data_json, priority, deadline,
    provenance_json, content_hash, sense_config_revision)
    VALUES ('evt_legacy_1', 'src_legacy', 'legacy-1', 'subject-1', NULL, 'im.message.created', 'quno.event/v1',
    'upsert', ?, ?, ?, 99, '旧事件', '{"x":1}', 'p2', NULL, '{"kind":"observed"}', 'hash-legacy', 1)`)
    .run(at, at, at)

  store.backfillDomainV3(at)
  store.backfillDomainV3(at) // idempotent

  const repo = new SqliteRepository(store)
  const done = repo.getTicket('task_legacy_1')
  assert.ok(done)
  assert.equal(done.ended?.outcome, 'completed')
  const doneAssignments = repo.listAssignmentsByTicket('task_legacy_1')
  assert.equal(doneAssignments.length, 1)
  assert.equal(doneAssignments[0]?.executorSessionId, 'child-1')
  assert.equal(doneAssignments[0]?.report?.state, 'ready')
  assert.equal(doneAssignments[0]?.report?.artifacts.length, 1)
  const interrupted = repo.getTicket('task_legacy_2')
  assert.ok(interrupted)
  assert.equal(interrupted.ended, null)
  const interruptedAssignments = repo.listAssignmentsByTicket('task_legacy_2')
  assert.equal(interruptedAssignments.length, 1)
  assert.equal(interruptedAssignments[0]?.state, 'pending')
  assert.equal(interruptedAssignments[0]?.report?.state, 'blocked')

  // The legacy event now has a Thread, a Trigger edge and a pending Eval slot.
  const threads = repo.listThreads('quno', { limit: 10 })
  assert.equal(threads.length, 1)
  assert.equal(threads[0]?.threadKey, 'subject-1')
  assert.deepEqual(repo.listPendingTriggerIds(threads[0]?.id ?? '', 10), ['evt_legacy_1'])
  const launchEffects = repo.listDueEffects(at, 100).filter(item => item.kind === 'assignment-launch')
  assert.equal(launchEffects.length, 1)
  assert.equal(launchEffects[0]?.key, 'assign_task_legacy_2_1')
  store.close()
})

test('sqlite repository: effect merge and stale completion follow the port contract', () => {
  const fixture = openFixture()
  const { store } = fixture
  const repo = new SqliteRepository(store)
  const first = repo.enqueueEffect({ kind: 'input-delivery', key: 'ticket_1', payload: { revision: 1 }, now: 100 })
  const second = repo.enqueueEffect({ kind: 'input-delivery', key: 'ticket_1', payload: { revision: 2 }, now: 101 })
  assert.equal(second.seq, 2)
  assert.equal(second.generation, 2)
  assert.equal(repo.completeEffect('input-delivery', 'ticket_1', first.seq, first.generation), false)
  assert.equal(repo.completeEffect('input-delivery', 'ticket_1', second.seq, second.generation), true)
  assert.equal(repo.getEffect('input-delivery', 'ticket_1'), undefined)
  store.close()
})

test('retention never prunes a body that unsettled domain work still cites', () => {
  const fixture = openFixture()
  const { store } = fixture
  addSense(fixture, 'test/im')
  const source = store.listSources('quno')[0]
  assert.ok(source)
  const f = sqliteFixture(store, fixture.root, fixture.now)
  f.engine.receive(draft({ eventKey: 'keep', sourceId: source.id }), now())
  const thread = f.repo.listThreads('quno', { limit: 5 })[0]
  assert.ok(thread)
  f.engine.openEvals(now())
  const later = now() + 40 * 24 * 60 * 60 * 1000
  assert.equal(store.pruneExpiredEvents(later, 30), 0, 'a pending Eval keeps its evidence')
  const evalRecord = f.repo.listEvals('quno', { limit: 5 })[0]
  assert.ok(evalRecord)
  f.engine.decide({ evalId: evalRecord.id, kind: 'ignore', reason: 'no work', now: now() })
  assert.equal(f.repo.countPending(thread.id), 0)
  assert.equal(store.pruneExpiredEvents(later, 30), 1, 'settled evidence may prune after the body window')
  const pruned = f.repo.listTriggerIdsByThread(thread.id, 5)
  assert.equal(pruned.length, 1, 'the Trigger identity and lineage survive the body prune')
  const trigger = f.repo.getTrigger(pruned[0] ?? '')
  assert.ok(trigger?.prunedAt !== null)
  assert.equal(trigger?.data, null)
  store.close()
})
