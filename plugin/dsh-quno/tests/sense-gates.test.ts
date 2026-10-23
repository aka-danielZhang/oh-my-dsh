/**
 * Sense acceptance gates S01–S14 (design §15.3), exercised against the real
 * registry, ingress, SQLite store and lifecycle code with a controllable test
 * Sense.
 *
 * @module dsh-quno/tests/sense-gates
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QunoSensesService, type SenseFactory, type SenseHandle, type SenseRuntime } from '../src/senses.ts'
import { QunoIngressError } from '../src/ingress.ts'
import { openFixture } from './helpers.ts'
import type { SenseDefinition } from '../src/types.ts'

const logger = { info: () => {}, warn: () => {} }

function definition(type: string, patch: Partial<SenseDefinition> = {}): SenseDefinition {
  return {
    type,
    contractVersion: 'quno.sense/v1',
    implementationVersion: '0.1.0',
    displayName: type,
    description: 'test sense',
    eventTypes: [{ type: 'test/changed' }],
    permissions: { reads: [] },
    runtime: { modes: ['poll'], defaultIntervalSec: 60, minIntervalSec: 30, concurrency: 1, timeoutMs: 5000 },
    reliability: {
      checkpoint: 'cursor',
      replay: { kind: 'none' },
      changeCoverage: 'snapshot-diff',
      gapDetection: 'explicit',
      readOriginal: false,
    },
    ...patch,
  }
}

interface Control {
  runtimes: SenseRuntime<Record<string, unknown>>[]
  stops: number
  starts: number
  failStart?: string
}

function fakeFactory(control: Control): SenseFactory {
  return {
    validateConfig(raw) {
      if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'object required' }
      return { ok: true, value: raw as Record<string, unknown> }
    },
    start(runtime) {
      control.starts += 1
      control.runtimes.push(runtime)
      if (control.failStart !== undefined) throw new Error(control.failStart)
      const handle: SenseHandle = {
        stop() {
          control.stops += 1
        },
      }
      return handle
    },
  }
}

async function settle(probe: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error('settle timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function setup() {
  const fixture = openFixture()
  const clock = { now: fixture.now }
  const control: Control = { runtimes: [], stops: 0, starts: 0 }
  const retries: (() => void)[] = []
  const service = new QunoSensesService({
    store: fixture.store,
    qunoId: 'quno',
    logger,
    now: () => clock.now,
    setTimer: callback => {
      retries.push(callback)
      return () => {}
    },
  })
  return { fixture, clock, control, service, retries }
}

test('S01 declaration negotiation rejects an unknown contract version', () => {
  const { fixture, service } = setup()
  try {
    assert.throws(
      () => service.register(definition('test/bad', { contractVersion: 'quno.sense/v9' }), fakeFactory({ runtimes: [], stops: 0, starts: 0 })),
      /declaration rejected/,
    )
    assert.throws(
      () => service.register(definition('test/bad-order', {
        runtime: { modes: ['poll'], defaultIntervalSec: 10, minIntervalSec: 30, concurrency: 1, timeoutMs: 1000 },
      }), fakeFactory({ runtimes: [], stops: 0, starts: 0 })),
      /declaration rejected/,
    )
  } finally {
    fixture.store.close()
  }
})

test('S02 a Sense starts with no chat and no model, receiving only its runtime', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/basic'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/basic', config: {}, desiredState: 'enabled' })
    assert.equal(created.ok, true)
    await settle(() => control.runtimes.length === 1)
    const runtime = control.runtimes[0]!
    assert.deepEqual(
      Object.keys(runtime).sort(),
      ['checkpoint', 'config', 'generation', 'ingress', 'instanceId', 'limits', 'logger', 'signal', 'sourceId', 'type'].sort(),
    )
    assert.equal(typeof runtime.ingress.ingestBatch, 'function')
    assert.equal('schedule' in runtime, false)
    assert.equal('notify' in runtime, false)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S03 the same observation retried keeps one identity and one checkpoint advance', async () => {
  const { fixture, clock, control, service } = setup()
  try {
    service.register(definition('test/retry'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/retry', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const instance = fixture.store.getSenseInstance(created.instance.id)
    const payload = {
      batchKey: 'same-batch',
      events: [{ eventKey: 'e1', type: 'test/changed', observedAt: new Date(clock.now).toISOString(), summary: 'one' }],
      checkpointAfter: { value: 'cursor-1', revision: instance.checkpoint.revision },
    }
    const first = service.ingest(instance.id, instance.generation, payload)
    const second = service.ingest(instance.id, instance.generation, payload)
    assert.equal(second.batchId, first.batchId)
    assert.equal(second.accepted[0]?.eventId, first.accepted[0]?.eventId)
    assert.equal(fixture.store.maxIngestSeq(), 0)
    assert.equal(fixture.store.getSenseInstance(instance.id).checkpoint.revision, 1)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S04 persisted checkpoint and instance survive a restart', async () => {
  const { fixture, clock, control, service } = setup()
  const instance = (() => {
    service.register(definition('test/restart'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/restart', config: {}, desiredState: 'paused' })
    assert.ok(created.ok)
    return created.instance
  })()
  fixture.store.updateSenseInstance(instance.id, {
    checkpoint: { value: 'cursor-7', revision: 3 },
    now: clock.now,
  })
  const root = fixture.root
  fixture.store.close()

  const { QunoStore } = await import('../src/store.ts')
  const reopened = new QunoStore({ root })
  reopened.open(clock.now)
  try {
    const restored = reopened.getSenseInstance(instance.id)
    assert.deepEqual(restored.checkpoint, { value: 'cursor-7', revision: 3 })
    assert.equal(restored.desiredState, 'paused')
  } finally {
    reopened.close()
  }
})

test('S05 an old generation may not write after a restart or reconfigure', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/gen'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/gen', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const before = fixture.store.getSenseInstance(created.instance.id)
    const result = await service.reconfigureInstance(created.instance.id, { config: { changed: true } })
    assert.equal(result.ok, true)
    await settle(() => control.runtimes.length === 2)
    const after = fixture.store.getSenseInstance(created.instance.id)
    assert.ok(after.generation > before.generation)
    assert.throws(() => service.ingest(created.instance.id, before.generation, {
      batchKey: 'stale',
      events: [{ eventKey: 'x', type: 'test/changed', observedAt: new Date().toISOString(), summary: 'x' }],
    }), (error: unknown) => {
      assert.ok(error instanceof QunoIngressError)
      assert.equal(error.shape.code, 'stale-generation')
      return true
    })
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S06 an empty sync advances only the checkpoint', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/empty'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/empty', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const instance = fixture.store.getSenseInstance(created.instance.id)
    const ack = service.ingest(instance.id, instance.generation, {
      batchKey: 'empty',
      events: [],
      checkpointAfter: { value: 'cursor-9', revision: instance.checkpoint.revision },
    }) as { eventCount: number; acceptedCount: number }
    assert.equal(ack.eventCount, 0)
    assert.equal(ack.acceptedCount, 0)
    assert.equal(fixture.store.getSenseInstance(instance.id).checkpoint.value, 'cursor-9')
    assert.equal(fixture.store.maxIngestSeq(), -1)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S07 a pagination gap is reported and visible in health', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/gap'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/gap', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const instance = fixture.store.getSenseInstance(created.instance.id)
    service.ingest(instance.id, instance.generation, {
      batchKey: 'gapped',
      events: [],
      checkpointAfter: { value: 'cursor-1', revision: instance.checkpoint.revision },
      gap: { reason: '仅取最近 100 条' },
    })
    const health = service.healthSnapshot()
    assert.equal(health.gaps.length, 1)
    assert.match(health.gaps[0]?.reason ?? '', /100/)
    assert.equal(fixture.store.getSenseInstance(instance.id).health, 'degraded')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S08 a storage failure never returns a fake ACK', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/backpressure'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/backpressure', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => fixture.store.getSenseInstance(created.instance.id).lifecycle === 'running')
    const instance = fixture.store.getSenseInstance(created.instance.id)
    fixture.store.close()
    assert.throws(() => service.ingest(instance.id, instance.generation, {
      batchKey: 'no-ack',
      events: [{ eventKey: 'e', type: 'test/changed', observedAt: new Date().toISOString(), summary: 'x' }],
      checkpointAfter: { value: 'c', revision: instance.checkpoint.revision },
    }), (error: unknown) => {
      assert.ok(error instanceof QunoIngressError)
      assert.equal(error.shape.retryable, true)
      return true
    })
  } finally {
    // store already closed by the test
  }
})

test('S09 stop and pause are idempotent', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/stop'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/stop', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    await service.pause(created.instance.id)
    assert.equal(control.stops, 1)
    await service.pause(created.instance.id)
    assert.equal(control.stops, 1, 'a second pause is a no-op')
    assert.equal(fixture.store.getSenseInstance(created.instance.id).lifecycle, 'stopped')
    await service.stopAll()
    await service.stopAll()
  } finally {
    fixture.store.close()
  }
})

test('S10 a config change keeps the source identity and bumps the generation', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/identity'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/identity', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const sourceId = control.runtimes[0]?.sourceId
    const before = fixture.store.getSenseInstance(created.instance.id)
    await service.reconfigureInstance(created.instance.id, { config: { token: 'rotated' } })
    await settle(() => control.runtimes.length === 2)
    const after = fixture.store.getSenseInstance(created.instance.id)
    assert.equal(control.runtimes[1]?.sourceId, sourceId)
    assert.equal(after.configRevision, before.configRevision + 1)
    assert.ok(after.generation > before.generation)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S11 a derived observation keeps its lineage and is never resampled', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/derived'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/derived', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const instance = fixture.store.getSenseInstance(created.instance.id)
    const provenance = {
      kind: 'derived' as const,
      inputs: [{ eventKey: 'raw-1' }],
      processor: 'rule:v1',
      coverage: 'raw-1 only',
    }
    const payload = {
      batchKey: 'derived',
      events: [{
        eventKey: 'derived-1',
        type: 'test/changed',
        observedAt: new Date().toISOString(),
        summary: 'derived',
        provenance,
      }],
      checkpointAfter: { value: 'c', revision: instance.checkpoint.revision },
    }
    const ack = service.ingest(instance.id, instance.generation, payload)
    const stored = fixture.store.getEvent(ack.accepted[0]!.eventId)
    assert.deepEqual(stored?.provenance, provenance)
    const replay = service.ingest(instance.id, instance.generation, payload)
    assert.equal(replay.batchId, ack.batchId, 'a replayed batch returns the stored receipt')
    assert.equal(replay.accepted[0]?.eventId, ack.accepted[0]?.eventId, 'the observation identity is stable')
    assert.equal(fixture.store.getEvent(ack.accepted[0]!.eventId)?.contentHash, stored?.contentHash)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S12 a restarted generation resumes from the persisted checkpoint without resending', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/resume'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/resume', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const instance = fixture.store.getSenseInstance(created.instance.id)
    fixture.store.updateSenseInstance(instance.id, {
      checkpoint: { value: 'already-covered', revision: 5 },
      now: fixture.now,
    })
    await service.reconfigureInstance(created.instance.id, {})
    await settle(() => control.runtimes.length === 2)
    const runtime = control.runtimes[1]!
    assert.deepEqual(runtime.checkpoint, { value: 'already-covered', revision: 5 })
    assert.equal(fixture.store.maxIngestSeq(), -1, 'no historical event was re-emitted')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S13 one Sense failing to start does not block the others', async () => {
  const { fixture, control, service } = setup()
  const good: Control = { runtimes: [], stops: 0, starts: 0 }
  const bad: Control = { runtimes: [], stops: 0, starts: 0, failStart: 'source unavailable' }
  try {
    service.register(definition('test/good'), fakeFactory(good))
    service.register(definition('test/bad'), fakeFactory(bad))
    const a = service.createInstance({ type: 'test/good', config: {}, desiredState: 'enabled' })
    const b = service.createInstance({ type: 'test/bad', config: {}, desiredState: 'enabled' })
    assert.ok(a.ok && b.ok)
    await settle(() => fixture.store.getSenseInstance(a.instance.id).lifecycle === 'running'
      && fixture.store.getSenseInstance(b.instance.id).lifecycle === 'failed')
    assert.equal(fixture.store.getSenseInstance(a.instance.id).lifecycle, 'running')
    assert.equal(fixture.store.getSenseInstance(b.instance.id).lifecycle, 'failed')
    assert.equal(fixture.store.getSenseInstance(b.instance.id).health, 'unavailable')
    assert.ok(fixture.store.getSenseInstance(b.instance.id).nextRetryAt !== null)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S14 the Sense runtime exposes no business side-effect service', async () => {
  const { fixture, control, service } = setup()
  try {
    service.register(definition('test/surface'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/surface', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1)
    const runtime = control.runtimes[0]! as unknown as Record<string, unknown>
    const forbidden = ['notify', 'schedule', 'attention', 'tasks', 'quno', 'store', 'runner', 'outbox']
    for (const key of forbidden) assert.equal(key in runtime, false, `${key} must not leak into a Sense`)
    // The only write capability is the generation-checked ingress.
    assert.deepEqual(Object.keys(runtime.ingress as object).sort(), ['ingestBatch', 'reportHealth'])
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})
