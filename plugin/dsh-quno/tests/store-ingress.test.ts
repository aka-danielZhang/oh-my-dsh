import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoIngress, QunoIngressError } from '../src/ingress.ts'
import { QunoStateError } from '../src/core/model.ts'
import type { TriggerDraft } from '../src/core/model.ts'
import { Engine } from '../src/core/engine.ts'
import { SqliteRepository } from '../src/app/store.ts'
import { buildPolicy } from '../src/core/policy.ts'
import { QunoStore } from '../src/store.ts'
import { addSense, batch, envelope, openFixture, scratchHome } from './helpers.ts'

function bindingOf(fixture: ReturnType<typeof addSense>) {
  return {
    instance: fixture.instance,
    source: fixture.source,
    generation: fixture.instance.generation,
    configRevision: fixture.instance.configRevision,
  }
}

test('store: a provisioned Quno survives close/reopen and the lock is released', () => {
  const root = scratchHome()
  const now = Date.parse('2026-10-23T09:00:00.000Z')
  const first = new QunoStore({ root })
  first.open(now)
  first.ensureQuno({
    id: 'quno', name: 'Quno', persona: 'p', instructions: 'i', config: DEFAULT_QUNO_CONFIG, now,
  })
  first.close()

  const second = new QunoStore({ root })
  second.open(now + 1)
  try {
    const quno = second.getQuno('quno')
    assert.equal(quno?.name, 'Quno')
    assert.equal(quno?.config.checkIntervalSec, 300)
  } finally {
    second.close()
  }
})

test('store: a live foreign lock refuses a second writer', () => {
  const root = scratchHome()
  const now = Date.now()
  const first = new QunoStore({ root })
  first.open(now)
  try {
    // Rewrite the lock as a live foreign process; the store must refuse.
    writeFileSync(`${root}/quno.lock`, JSON.stringify({ pid: 1, at: now }))
    const second = new QunoStore({ root })
    assert.throws(() => second.open(now), /owns/)
  } finally {
    first.close()
  }
})

test('ingress: a batch commits events, receipt and checkpoint atomically', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const ack = ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'calendar/updated', subject: { key: 'evt-1', revision: '2' } }),
      envelope({ eventKey: 'e2', type: 'calendar/updated', subject: { key: 'evt-2', revision: '1' } }),
    ], {
      batchKey: 'b1',
      checkpointAfter: { value: 'cursor-1', revision: 0 },
    }), fixture.now)

    assert.equal(ack.acceptedCount, 2)
    assert.equal(ack.duplicateCount, 0)
    assert.equal(ack.checkpointRevision, 1)
    assert.equal(fixture.store.maxIngestSeq(), 1)
    const instance = fixture.store.getSenseInstance(sense.instance.id)
    assert.deepEqual(instance.checkpoint, { value: 'cursor-1', revision: 1 })
    assert.equal(instance.lastEventAt, fixture.now)
    assert.equal(fixture.store.findBatch(sense.source.id, 'b1')?.acceptedCount, 2)
  } finally {
    fixture.store.close()
  }
})

test('ingress: a replayed batch returns the stored ACK and creates nothing', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const payload = batch([
      envelope({ eventKey: 'e1', type: 'calendar/updated' }),
    ], { batchKey: 'same', checkpointAfter: { value: 'c1', revision: 0 } })
    const first = ingress.ingest(bindingOf(sense), payload, fixture.now)
    const before = fixture.store.maxIngestSeq()
    const second = ingress.ingest(bindingOf(sense), payload, fixture.now + 5000)
    assert.equal(second.batchId, first.batchId)
    assert.equal(second.acceptedCount, 1)
    assert.equal(fixture.store.maxIngestSeq(), before)
    assert.equal(fixture.store.getSenseInstance(sense.instance.id).checkpoint.revision, 1)
  } finally {
    fixture.store.close()
  }
})

test('ingress: the same event key with different content is an explicit conflict', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'calendar/updated', summary: 'version one' }),
    ], { batchKey: 'b1' }), fixture.now)
    const conflict = () => ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'calendar/updated', summary: 'version two' }),
    ], { batchKey: 'b2' }), fixture.now + 1)
    assert.throws(conflict, (error: unknown) => {
      assert.ok(error instanceof QunoIngressError)
      assert.equal(error.shape.code, 'identity-conflict')
      assert.equal(error.shape.index, 0)
      return true
    })
    // The first fact is untouched.
    assert.equal(fixture.store.maxIngestSeq(), 0)
  } finally {
    fixture.store.close()
  }
})

test('ingress: a whole batch is rejected when one event conflicts', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'calendar/updated', summary: 'one' }),
    ], { batchKey: 'b1' }), fixture.now)
    assert.throws(() => ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e2', type: 'calendar/updated' }),
      envelope({ eventKey: 'e1', type: 'calendar/updated', summary: 'different' }),
    ], { batchKey: 'b2' }), fixture.now), /already exists with different content/)
    assert.equal(fixture.store.maxIngestSeq(), 0, 'the valid sibling must not commit without its batch')
  } finally {
    fixture.store.close()
  }
})

test('ingress: a stale checkpoint revision is refused and retryable', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'x/y' }),
    ], { batchKey: 'b1', checkpointAfter: { value: 'c1', revision: 0 } }), fixture.now)
    assert.throws(() => ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e2', type: 'x/y' }),
    ], { batchKey: 'b2', checkpointAfter: { value: 'c2', revision: 0 } }), fixture.now), (error: unknown) => {
      assert.ok(error instanceof QunoIngressError)
      assert.equal(error.shape.code, 'checkpoint-conflict')
      assert.equal(error.shape.retryable, true)
      return true
    })
    assert.equal(fixture.store.maxIngestSeq(), 0)
  } finally {
    fixture.store.close()
  }
})

test('ingress: an old generation may not write after a restart', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const generation = fixture.store.bumpGeneration(sense.instance.id, fixture.now)
    assert.throws(() => ingress.ingest({
      instance: fixture.store.getSenseInstance(sense.instance.id),
      source: sense.source,
      generation: generation - 1,
      configRevision: fixture.store.getSenseInstance(sense.instance.id).configRevision,
    }, batch([envelope({ eventKey: 'e1', type: 'x/y' })], { batchKey: 'b1' }), fixture.now), (error: unknown) => {
      assert.ok(error instanceof QunoIngressError)
      assert.equal(error.shape.code, 'stale-generation')
      return true
    })
  } finally {
    fixture.store.close()
  }
})

test('ingress: an empty batch advances the checkpoint without creating events', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const ack = ingress.ingest(bindingOf(sense), {
      batchKey: 'empty-1',
      events: [],
      checkpointAfter: { value: 'c9', revision: 0 },
    }, fixture.now)
    assert.equal(ack.eventCount, 0)
    assert.equal(ack.checkpointRevision, 1)
    assert.equal(fixture.store.maxIngestSeq(), -1)
  } finally {
    fixture.store.close()
  }
})

test('store: outbox dedupes by material revision and merges same-topic pending rows', () => {
  const fixture = openFixture()
  try {
    const payload = { title: 't', body: 'b', summary: 's', why: 'w' }
    const first = fixture.store.enqueueNotice({
      qunoId: 'quno', topicKey: 'topic', materialRevision: 1, reminderStage: 0,
      kind: 'report', payload, eligibleAt: fixture.now, expiresAt: null, now: fixture.now,
    })
    assert.ok(first !== null)
    const duplicate = fixture.store.enqueueNotice({
      qunoId: 'quno', topicKey: 'topic', materialRevision: 1, reminderStage: 0,
      kind: 'report', payload, eligibleAt: fixture.now, expiresAt: null, now: fixture.now,
    })
    assert.equal(duplicate, null)
    const second = fixture.store.enqueueNotice({
      qunoId: 'quno', topicKey: 'topic', materialRevision: 2, reminderStage: 0,
      kind: 'report', payload, eligibleAt: fixture.now, expiresAt: null, now: fixture.now + 1,
    })
    assert.ok(second !== null)
    const merged = fixture.store.mergePendingNotices('quno', 'topic', second.id, fixture.now + 2)
    assert.equal(merged, 1)
    assert.equal(fixture.store.getNotice(first.id).status, 'superseded')
    assert.equal(fixture.store.getNotice(second.id).status, 'pending')
  } finally {
    fixture.store.close()
  }
})

test('store: attention revision CAS rejects stale writes and records history', () => {
  const fixture = openFixture()
  try {
    const item = fixture.store.insertAttention({
      qunoId: 'quno',
      topicKey: 'calendar/review',
      title: '评审改期',
      summary: '10:00',
      status: 'open',
      subjectRefs: [],
      evidence: [],
      nextReviewAt: null,
      snoozedUntil: null,
      material: true,
      cause: 'run:create',
      runId: null,
      now: fixture.now,
    })
    assert.equal(item.revision, 1)
    const stale = fixture.store.updateAttentionCas({
      id: item.id, expectedRevision: 0, patch: { summary: 'stale' }, cause: 'run:update', runId: null, now: fixture.now,
    })
    assert.equal(stale, undefined)
    const updated = fixture.store.updateAttentionCas({
      id: item.id,
      expectedRevision: 1,
      patch: { status: 'resolved', material: true },
      cause: 'user:processed',
      runId: null,
      now: fixture.now + 1,
    })
    assert.equal(updated?.revision, 2)
    assert.equal(updated?.materialRevision, 2)
    assert.equal(updated?.status, 'resolved')
    const history = fixture.store.listAttentionHistory(item.id)
    assert.equal(history.length, 2)
    assert.equal(history[0]?.toStatus, 'resolved')
  } finally {
    fixture.store.close()
  }
})


test('ingress: the domain Trigger sink commits with the batch and rolls back with it', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const repo = new SqliteRepository(fixture.store)
    const engine = new Engine({
      repo,
      qunoId: 'quno',
      policy: () => ({ configRevision: 1, paused: false, acceptMode: 'auto', evalTimeoutMs: 60_000, rules: [] }),
      policySnapshot: (state) => buildPolicy({
        version: 'v1',
        paused: state.paused,
        acceptMode: state.acceptMode,
        evalTimeoutMs: state.evalTimeoutMs,
        rules: state.rules,
      }),
      nextId: (() => { let index = 0; return (prefix: string) => `${prefix}_${String(++index)}` })(),
      defaultCwd: '/tmp',
    })
    let fail = false
    const sink = {
      receive: (input: { envelope: { eventKey: string; type: string; summary?: string }; sourceId: string; receivedAt: number; configRevision: number; contentHash: string }) => {
        if (fail) throw new QunoStateError('thread-unresolved', 'forced sink failure')
        const draft: TriggerDraft = {
          qunoId: 'quno',
          sourceId: input.sourceId,
          eventKey: input.envelope.eventKey,
          type: input.envelope.type,
          schema: 'quno.event/v1',
          threads: [{ source: input.sourceId, id: 'subject-1' }],
          actor: { source: input.sourceId, id: 'u1' },
          human: true,
          addressed: 'mention',
          occurredAt: input.receivedAt,
          observedAt: input.receivedAt,
          receivedAt: input.receivedAt,
          summary: input.envelope.summary ?? null,
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
          contentHash: input.contentHash,
          configRevision: input.configRevision,
          expiresAt: null,
        }
        engine.receive(draft, input.receivedAt)
      },
    }
    const ingress = new QunoIngress(fixture.store, 'quno', {}, sink)
    const ack = ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'ok-1', type: 'test/changed' }),
    ], { batchKey: 'b-sink-1' }), fixture.now)
    assert.equal(ack.acceptedCount, 1)
    const threads = repo.listThreads('quno', { limit: 10 })
    assert.equal(threads.length, 1)
    assert.equal(threads[0]?.threadKey, 'subject-1')
    assert.equal(repo.countPending(threads[0]?.id ?? ''), 1)

    fail = true
    let refused: unknown
    try {
      ingress.ingest(bindingOf(sense), batch([
        envelope({ eventKey: 'bad-1', type: 'test/changed' }),
      ], { batchKey: 'b-sink-2' }), fixture.now)
    } catch (error) {
      refused = error
    }
    assert.ok(refused instanceof QunoIngressError)
    assert.equal(refused.shape.code, 'thread-unresolved')
    assert.equal(fixture.store.dbFindEventId(sense.source.id, 'bad-1'), undefined, 'the event row rolled back')
    assert.equal(fixture.store.findBatch(sense.source.id, 'b-sink-2'), undefined, 'no receipt for a failed T1')
    fail = false
  } finally {
    fixture.store.close()
  }
})
