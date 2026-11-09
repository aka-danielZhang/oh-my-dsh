/**
 * The Watchdog is read-only: it reports stuck durable state and never mutates
 * it. These tests pin the findings and the no-write boundary.
 *
 * @module dsh-quno/tests/watchdog
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryRepository } from '../src/core/memory-store.ts'
import { buildPolicy } from '../src/core/policy.ts'
import { Engine } from '../src/core/engine.ts'
import { Watchdog } from '../src/app/watchdog.ts'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import type { TriggerDraft } from '../src/core/model.ts'

function fixture() {
  const repo = new MemoryRepository()
  let counter = 0
  let clock = 1_000_000
  const now = (): number => (clock += 1000)
  const engine = new Engine({
    repo,
    qunoId: 'quno',
    policy: () => ({ configRevision: 1, paused: false, acceptMode: 'auto', evalTimeoutMs: 1000, rules: [] }),
    policySnapshot: (state) => buildPolicy({ version: 'v1', paused: state.paused, acceptMode: state.acceptMode, evalTimeoutMs: state.evalTimeoutMs, rules: state.rules }),
    nextId: (prefix) => `${prefix}_${String(++counter)}`,
    defaultCwd: '/tmp',
  })
  const watchdog = new Watchdog({
    repo,
    qunoId: 'quno',
    config: () => ({ ...DEFAULT_QUNO_CONFIG, checkIntervalSec: 60, acceptMode: 'auto' }),
    now: () => clock,
  })
  return { repo, engine, watchdog, now, tick: (ms: number) => { clock += ms } }
}

function draft(eventKey: string): TriggerDraft {
  return {
    qunoId: 'quno',
    sourceId: 'src',
    eventKey,
    type: 'x/y',
    schema: 'quno.event/v1',
    threads: [{ source: 'src', id: 'thread-1' }],
    actor: { source: 'src', id: 'u' },
    human: true,
    addressed: 'mention',
    occurredAt: 1_000_000,
    observedAt: 1_000_000,
    receivedAt: 1_000_000,
    summary: 's',
    data: null,
    contentRef: null,
    channel: null,
    operation: 'upsert',
    priority: 'p2',
    deadline: null,
    correlationKeys: [],
    supersedesTriggerIds: [],
    parentTriggerIds: [],
    provenance: { kind: 'observed' },
    contentHash: `h-${eventKey}`,
    configRevision: 1,
    expiresAt: null,
  }
}

test('watchdog: an empty store is healthy and reports nothing', () => {
  const f = fixture()
  const report = f.watchdog.inspect()
  assert.equal(report.healthy, true)
  assert.deepEqual(report.findings, [])
  assert.equal(report.counts.timedOutEvals, 0)
})

test('watchdog: a delivered candidate past its deadline is reported without mutating it', () => {
  const f = fixture()
  f.engine.receive(draft('a'), f.now())
  f.engine.openEvals(f.now())
  const evalRecord = f.repo.listEvals('quno', { limit: 5 })[0]
  assert.ok(evalRecord)
  f.engine.candidateDelivered({ evalId: evalRecord.id, messageId: 'quno:1', now: f.now() })
  f.tick(5_000)
  const report = f.watchdog.inspect()
  assert.equal(report.healthy, false)
  assert.equal(report.counts.timedOutEvals, 1)
  assert.equal(f.repo.getEval(evalRecord.id)?.status, 'waiting-decision', 'inspection never settles the eval')
})

test('watchdog: repeated failing effects and undelivered inputs are reported', () => {
  const f = fixture()
  const ticket = f.engine.directAccept({
    sessionId: 'main',
    messageId: 'm1',
    toolCallId: 'c1',
    title: 'T',
    goal: 'G',
    now: f.now(),
  })
  const assignment = f.repo.findActiveAssignment(ticket.id)
  assert.ok(assignment)
  f.engine.assignmentStarted({ assignmentId: assignment.id, now: f.now() })
  f.engine.turnEnded({ assignmentId: assignment.id, now: f.now() })
  f.engine.note({ ticketId: ticket.id, text: 'more', human: true, now: f.now() })
  const effect = f.repo.getEffect('input-delivery', ticket.id)
  assert.ok(effect)
  f.repo.failEffect('input-delivery', ticket.id, effect.seq, effect.generation, 'boom', 0)
  f.repo.failEffect('input-delivery', ticket.id, effect.seq, effect.generation, 'boom', 0)
  f.repo.failEffect('input-delivery', ticket.id, effect.seq, effect.generation, 'boom', 0)
  const report = f.watchdog.inspect()
  assert.equal(report.counts.failingEffects, 1)
  assert.equal(report.counts.stuckAssignments, 1)
  assert.equal(report.findings.some(finding => finding.code === 'effect-failing'), true)
  assert.equal(report.findings.some(finding => finding.code === 'input-undelivered'), true)
})

test('watchdog: a pending Thread with no active Eval is reported only after the idle window', () => {
  const f = fixture()
  f.engine.receive(draft('a'), f.now())
  const thread = f.repo.listThreads('quno', { limit: 5 })[0]
  assert.ok(thread)
  f.repo.updateThread(thread.id, { lastAt: 1_000_000 })
  const early = f.watchdog.inspect()
  assert.equal(early.counts.idlePendingThreads, 0)
  f.tick(120_000)
  const late = f.watchdog.inspect()
  assert.equal(late.counts.idlePendingThreads, 1)
})
