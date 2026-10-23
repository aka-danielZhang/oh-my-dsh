import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoIngress, QunoIngressError } from '../src/ingress.ts'
import { Router, matchesFilter } from '../src/routing.ts'
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

test('routing: deliveries are per-Quno, idempotent, and the watermark advances', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    fixture.store.ensureSubscriptions('quno', [sense.source], fixture.now)
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'calendar/updated' }),
      envelope({ eventKey: 'e2', type: 'calendar/updated' }),
    ], { batchKey: 'b1' }), fixture.now)

    const router = new Router(fixture.store, 'quno')
    const first = router.route(fixture.now)
    assert.equal(first.scanned, 2)
    assert.equal(first.inserted, 2)
    assert.equal(fixture.store.countReadyDeliveries('quno', fixture.now), 2)

    const second = router.route(fixture.now)
    assert.equal(second.inserted, 0)
    assert.equal(fixture.store.countReadyDeliveries('quno', fixture.now), 2)
  } finally {
    fixture.store.close()
  }
})

test('routing: a subscription created from now does not backfill', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'old', type: 'calendar/updated' }),
    ], { batchKey: 'b1' }), fixture.now)
    // Subscription starts after the event exists.
    fixture.store.ensureSubscriptions('quno', [sense.source], fixture.now + 10)
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'new', type: 'calendar/updated' }),
    ], { batchKey: 'b2' }), fixture.now + 20)
    const router = new Router(fixture.store, 'quno')
    const result = router.route(fixture.now + 30)
    assert.equal(result.inserted, 1, 'only the event after the subscription start routes')
  } finally {
    fixture.store.close()
  }
})

test('routing: deterministic filters keep unrelated events out', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'a', type: 'calendar/updated', summary: '评审改期' }),
      envelope({ eventKey: 'b', type: 'mail/received', summary: '广告' }),
    ], { batchKey: 'b1' }), fixture.now)
    const [first, second] = fixture.store.listEventsAfter(-1, 10)
    assert.ok(first !== undefined && second !== undefined)
    const routed = fixture.store.transaction(() => {
      assert.equal(matchesFilter({ types: ['calendar/updated'] }, first, -1), true)
      assert.equal(matchesFilter({ types: ['calendar/updated'] }, second, -1), false)
      assert.equal(matchesFilter({ summaryIncludes: ['评审'] }, first, -1), true)
      assert.equal(matchesFilter({ summaryIncludes: ['评审'] }, second, -1), false)
      assert.equal(matchesFilter({ priorityAtLeast: 'p1' }, first, -1), false)
      return 0
    })
    assert.equal(routed, 0)
  } finally {
    fixture.store.close()
  }
})

test('store: run fence recovery releases claimed deliveries', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    fixture.store.ensureSubscriptions('quno', [sense.source], fixture.now)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'e1', type: 'x/y' }),
    ], { batchKey: 'b1' }), fixture.now)
    new Router(fixture.store, 'quno').route(fixture.now)

    const run = fixture.store.insertRun({
      id: 'run_1',
      qunoId: 'quno',
      kind: 'think',
      trigger: 'schedule',
      configRevision: 1,
      fence: 1,
      claimExpiresAt: fixture.now + 1000,
      inputEventIds: [],
      inputAttentionIds: [],
      now: fixture.now,
    })
    const ready = fixture.store.listReadyDeliveries('quno', fixture.now, 10)
    fixture.store.claimDeliveries('quno', run.id, ready.map(item => item.eventId), fixture.now)
    assert.equal(fixture.store.listReadyDeliveries('quno', fixture.now, 10).length, 0)

    const interrupted = fixture.store.expireStaleRuns(fixture.now + 2000)
    assert.equal(interrupted.length, 1)
    assert.equal(interrupted[0]?.status, 'interrupted')
    assert.equal(fixture.store.listReadyDeliveries('quno', fixture.now + 2000, 10).length, 1)
    const delivery = fixture.store.listDeliveries('quno', 10)[0]
    assert.equal(delivery?.attempts, 1)
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

test('store: retention prunes unreferenced event bodies but keeps evidence under open work', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    fixture.store.ensureSubscriptions('quno', [sense.source], fixture.now)
    const ingress = new QunoIngress(fixture.store, 'quno')
    ingress.ingest(bindingOf(sense), batch([
      envelope({ eventKey: 'pending', type: 'x/y' }),
      envelope({ eventKey: 'orphan', type: 'x/y' }),
    ], { batchKey: 'b1' }), fixture.now)
    new Router(fixture.store, 'quno').route(fixture.now)
    const rowsAfterRoute = fixture.store.listEventsAfter(-1, 10)
    const orphan = rowsAfterRoute.find(row => row.eventKey === 'orphan')
    assert.ok(orphan !== undefined)
    fixture.store.settleDeliveryDirect('quno', orphan.id, 'processed', 'test', fixture.now)
    const later = fixture.now + 40 * 24 * 60 * 60 * 1000
    const pruned = fixture.store.pruneExpiredEvents(later, 30)
    assert.equal(pruned, 1)
    const rows = fixture.store.listEventsAfter(-1, 10)
    for (const row of rows) {
      if (row.eventKey === 'orphan') {
        assert.equal(row.data, null)
        assert.equal(row.prunedAt, later)
      } else {
        assert.notEqual(row.data, null, 'an unsettled delivery keeps its evidence')
      }
    }
  } finally {
    fixture.store.close()
  }
})
