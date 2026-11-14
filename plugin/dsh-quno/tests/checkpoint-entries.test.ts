import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QunoIngress, QunoIngressError } from '../src/ingress.ts'
import { QunoStore } from '../src/store.ts'
import { addSense, batch, envelope, openFixture } from './helpers.ts'

function bindingOf(fixture: ReturnType<typeof addSense>) {
  return {
    instance: fixture.instance,
    source: fixture.source,
    generation: fixture.instance.generation,
    configRevision: fixture.instance.configRevision,
  }
}

test('store: schema v2 creates the entries table; CRUD, pagination and capacity work', () => {
  const fixture = openFixture()
  try {
    const store = fixture.store
    assert.equal(store.countCheckpointEntries('sense-x'), 0)

    store.applyCheckpointPatch('sense-x', {
      upserts: [
        { key: 'c:g1', value: '{"cursor":"m1"}' },
        { key: 'c:g2', value: '{"cursor":"m2"}' },
        { key: 'm:done', value: '2026-10-30T00:00:00.000Z' },
      ],
    }, fixture.now, QunoStore.CHECKPOINT_ENTRIES_CAPACITY)
    assert.equal(store.countCheckpointEntries('sense-x'), 3)

    // Stable key order with strict afterKey resumption.
    const page1 = store.listCheckpointEntries('sense-x', { limit: 2 })
    assert.deepEqual(page1.map(entry => entry.key), ['c:g1', 'c:g2'])
    const page2 = store.listCheckpointEntries('sense-x', { limit: 2, afterKey: page1[1]?.key })
    assert.deepEqual(page2.map(entry => entry.key), ['m:done'])

    assert.equal(store.getCheckpointEntry('sense-x', 'c:g1')?.value, '{"cursor":"m1"}')
    assert.equal(store.getCheckpointEntry('sense-x', 'nope'), undefined)

    store.applyCheckpointPatch('sense-x', { deletes: ['c:g1'] }, fixture.now + 1, QunoStore.CHECKPOINT_ENTRIES_CAPACITY)
    assert.equal(store.countCheckpointEntries('sense-x'), 2)
  } finally {
    fixture.store.close()
  }
})

test('store: a patch pushing past the storage target is a loud quota failure', () => {
  const fixture = openFixture()
  try {
    assert.throws(
      () => fixture.store.applyCheckpointPatch(
        'sense-x',
        { upserts: [{ key: 'c:over', value: 'v' }] },
        fixture.now,
        0,
      ),
      /storage target/,
    )
    assert.equal(fixture.store.countCheckpointEntries('sense-x'), 0)
  } finally {
    fixture.store.close()
  }
})

test('ingress: events, root checkpoint, patch and receipt commit in one transaction', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const first = batch(
      [envelope({ eventKey: 'k1', type: 'im.message.created' })],
      {
        checkpointAfter: { value: '{"v":3}', revision: 0 },
        checkpointPatch: { upserts: [{ key: 'c:g1', value: '{"cursor":"m1"}' }] },
      },
    )
    const ack = ingress.ingest(bindingOf(sense), first)
    assert.equal(ack.acceptedCount, 1)
    assert.equal(ack.checkpointRevision, 1)
    const instance = fixture.store.getSenseInstance(sense.instance.id)
    assert.equal(instance.checkpoint.value, '{"v":3}')
    assert.equal(instance.checkpoint.revision, 1)
    assert.equal(fixture.store.getCheckpointEntry(sense.instance.id, 'c:g1')?.value, '{"cursor":"m1"}')

    // Retrying the SAME batch key returns the stored receipt without reapplying.
    const replay = ingress.ingest(bindingOf(sense), first)
    assert.equal(replay.acceptedCount, 1, 'stored receipt replays')
    assert.equal(fixture.store.countCheckpointEntries(sense.instance.id), 1, 'the patch is not reapplied')
  } finally {
    fixture.store.close()
  }
})

test('ingress: the batch hash covers the patch — same key, different patch conflicts', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const first = batch([envelope({ eventKey: 'k1', type: 'im.message.created' })], {
      checkpointAfter: { value: '{"v":3}', revision: 0 },
      checkpointPatch: { upserts: [{ key: 'c:g1', value: '{"cursor":"m1"}' }] },
    })
    ingress.ingest(bindingOf(sense), first)
    // Same batchKey, different patch content → identity conflict, not a dup ACK.
    const mutated = { ...first, checkpointPatch: { upserts: [{ key: 'c:g1', value: '{"cursor":"M2"}' }] } }
    assert.throws(
      () => ingress.ingest(bindingOf(sense), mutated),
      (error: unknown) => error instanceof QunoIngressError && error.shape.code === 'identity-conflict',
    )
  } finally {
    fixture.store.close()
  }
})

test('ingress: a patch past the storage target rolls the whole batch back', () => {
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    // Fill the instance to its storage target first.
    const filler = Array.from({ length: QunoStore.CHECKPOINT_ENTRIES_CAPACITY }, (_, index) => ({
      key: `c:f${String(index)}`,
      value: 'v',
    }))
    fixture.store.applyCheckpointPatch(sense.instance.id, { upserts: filler }, fixture.now, QunoStore.CHECKPOINT_ENTRIES_CAPACITY)
    assert.throws(
      () => ingress.ingest(bindingOf(sense), batch(
        [envelope({ eventKey: 'k1', type: 'im.message.created' })],
        { checkpointPatch: { upserts: [{ key: 'c:new', value: 'v' }] } },
      )),
      (error: unknown) => error instanceof QunoIngressError && error.shape.code === 'quota-exceeded',
    )
    // Atomicity: neither the event nor the batch receipt survived.
    assert.equal(fixture.store.dbFindEventId(sense.source.id, 'k1'), undefined)
    assert.equal(fixture.store.countCheckpointEntries(sense.instance.id), QunoStore.CHECKPOINT_ENTRIES_CAPACITY)
  } finally {
    fixture.store.close()
  }
})
