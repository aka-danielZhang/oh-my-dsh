/**
 * Collector acceptance gates S01–S14 (design §15.3), exercised against the real
 * registry, ingress, SQLite store and lifecycle code with a controllable test
 * collector. The Host owns the timer: the test's `pump()` fires whatever the
 * scheduler armed.
 *
 * @module dsh-quno/tests/collectors-gates
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QunoCollectorsService, type CollectorFactory, type CollectorRunContext, type CollectorRunOutcome } from '../src/collectors.ts'
import { QunoIngressError } from '../src/ingress.ts'
import { LIMITS } from '../src/contracts.ts'
import { openFixture } from './helpers.ts'
import type { CollectorDefinition } from '../src/types.ts'
import type { IngestAck, IngestBatch } from '../src/types.ts'

const logger = { info: () => {}, warn: () => {} }

function definition(type: string, patch: Partial<CollectorDefinition> = {}): CollectorDefinition {
  return {
    type,
    contractVersion: 'quno.collector/v2',
    implementationVersion: '0.1.0',
    displayName: type,
    description: 'test collectors',
    eventTypes: [{ type: 'test/changed' }],
    permissions: { reads: [] },
    schedule: { defaultIntervalSec: 60, minIntervalSec: 30, maxRunMs: 5000 },
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
  runtimes: CollectorRunContext<Record<string, unknown>>[]
  /** Disposals of the mount face (pause/reconfigure/stop paths). */
  mounts: number
  /** Outcome the next run returns (default `{ ok: true }`). */
  outcome?: CollectorRunOutcome
  failRun?: string
}

function fakeFactory(control: Control): CollectorFactory {
  return {
    validateConfig(raw) {
      if (typeof raw !== 'object' || raw === null) return { ok: false, message: 'object required' }
      return { ok: true, value: raw as Record<string, unknown> }
    },
    mount() {
      return () => { control.mounts += 1 }
    },
    async run(runtime) {
      control.runtimes.push(runtime)
      if (control.failRun !== undefined) throw new Error(control.failRun)
      return control.outcome ?? { ok: true }
    },
  }
}

async function settle(probe: () => boolean, pump: () => void, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  for (;;) {
    pump()
    if (probe()) return
    if (Date.now() - started > timeoutMs) throw new Error('settle timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function setup() {
  const fixture = openFixture()
  const clock = { now: fixture.now }
  const control: Control = { runtimes: [], mounts: 0 }
  /** Every armed scheduler callback, in arming order; stale ones are harmless. */
  const armed: (() => void)[] = []
  const service = new QunoCollectorsService({
    store: fixture.store,
    qunoId: 'quno',
    logger,
    now: () => clock.now,
    setTimer: callback => {
      armed.push(callback)
      return () => {}
    },
  })
  const pump = (): void => {
    const pending = armed.splice(0)
    for (const callback of pending) callback()
  }
  return { fixture, clock, control, service, pump }
}

test('S01 declaration negotiation rejects an unknown contract version and a bad schedule', () => {
  const { fixture, service } = setup()
  try {
    assert.throws(
      () => service.register(definition('test/bad', { contractVersion: 'quno.collectors/v9' }), fakeFactory({ runtimes: [], mounts: 0 })),
      /declaration rejected/,
    )
    assert.throws(
      () => service.register(definition('test/bad-order', {
        schedule: { defaultIntervalSec: 10, minIntervalSec: 30, maxRunMs: 1000 },
      }), fakeFactory({ runtimes: [], mounts: 0 })),
      /declaration rejected/,
    )
  } finally {
    fixture.store.close()
  }
})

test('S02 a collector run receives only its run context, with commit as the sole write face', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/basic'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/basic', config: {}, desiredState: 'enabled' })
    assert.equal(created.ok, true)
    await settle(() => control.runtimes.length === 1, pump)
    const runtime = control.runtimes[0]!
    assert.deepEqual(
      Object.keys(runtime).sort(),
      ['capabilities', 'checkpoint', 'checkpointEntries', 'commit', 'config', 'instanceId', 'limits', 'logger', 'runId', 'signal', 'sourceId', 'type'].sort(),
    )
    assert.equal(runtime.capabilities?.checkpointEntries, true, 'checkpoint-entries/v1 is declared')
    assert.equal(typeof runtime.checkpointEntries?.list, 'function')
    assert.equal(typeof runtime.commit, 'function')
    // The per-batch ingest limits ride the context: plugins never import the Host constants.
    assert.equal(runtime.limits.maxEventsPerBatch, LIMITS.maxBatchEvents)
    assert.equal(runtime.limits.maxBytesPerBatch, LIMITS.maxBatchBytes)
    assert.equal('schedule' in runtime, false)
    assert.equal('notify' in runtime, false)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S03 the same observation retried keeps one identity and one checkpoint advance', async () => {
  const { fixture, clock, control, service, pump } = setup()
  try {
    service.register(definition('test/retry'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/retry', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const runtime = control.runtimes[0]!
    const payload = {
      batchKey: 'same-batch',
      events: [{ eventKey: 'e1', type: 'test/changed', observedAt: new Date(clock.now).toISOString(), summary: 'one' }],
      checkpointAfter: { value: 'cursor-1', revision: runtime.checkpoint.revision },
    }
    const first = await runtime.commit(payload)
    const second = await runtime.commit(payload)
    assert.equal(second.batchId, (first as IngestAck).batchId)
    assert.equal((second as IngestAck).accepted[0]?.eventId, (first as IngestAck).accepted[0]?.eventId)
    assert.equal(fixture.store.maxIngestSeq(), 0)
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).checkpoint.revision, 1)
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
  fixture.store.updateCollectorInstance(instance.id, {
    checkpoint: { value: 'cursor-7', revision: 3 },
    now: clock.now,
  })
  const root = fixture.root
  fixture.store.close()

  const { QunoStore } = await import('../src/store.ts')
  const reopened = new QunoStore({ root })
  reopened.open(clock.now)
  try {
    const restored = reopened.getCollectorInstance(instance.id)
    assert.deepEqual(restored.checkpoint, { value: 'cursor-7', revision: 3 })
    assert.equal(restored.desiredState, 'paused')
  } finally {
    reopened.close()
  }
})

test('S05 a stale run context may not write after a restart or reconfigure', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/gen'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/gen', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const stale = control.runtimes[0]!
    const before = fixture.store.getCollectorInstance(created.instance.id)
    const result = await service.reconfigureInstance(created.instance.id, { config: { changed: true } })
    assert.equal(result.ok, true)
    await settle(() => control.runtimes.length === 2, pump)
    const after = fixture.store.getCollectorInstance(created.instance.id)
    assert.ok(after.generation > before.generation)
    await assert.rejects(() => stale.commit({
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
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/empty'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/empty', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const runtime = control.runtimes[0]!
    const ack = await runtime.commit({
      batchKey: 'empty',
      events: [],
      checkpointAfter: { value: 'cursor-9', revision: runtime.checkpoint.revision },
    }) as { eventCount: number; acceptedCount: number }
    assert.equal(ack.eventCount, 0)
    assert.equal(ack.acceptedCount, 0)
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).checkpoint.value, 'cursor-9')
    assert.equal(fixture.store.maxIngestSeq(), -1)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S07 a pagination gap is reported and visible in health', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/gap'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/gap', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const runtime = control.runtimes[0]!
    await runtime.commit({
      batchKey: 'gapped',
      events: [],
      checkpointAfter: { value: 'cursor-1', revision: runtime.checkpoint.revision },
      gap: { reason: '仅取最近 100 条' },
    })
    const health = service.healthSnapshot()
    assert.equal(health.gaps.length, 1)
    assert.match(health.gaps[0]?.reason ?? '', /100/)
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).health, 'degraded')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S08 a storage failure never returns a fake ACK', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/backpressure'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/backpressure', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => fixture.store.getCollectorInstance(created.instance.id).lifecycle === 'running', pump)
    const runtime = control.runtimes[0]!
    const instance = fixture.store.getCollectorInstance(created.instance.id)
    fixture.store.close()
    await assert.rejects(() => runtime.commit({
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
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/stop'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/stop', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    await service.pause(created.instance.id)
    assert.equal(control.mounts, 1)
    await service.pause(created.instance.id)
    assert.equal(control.mounts, 1, 'a second pause is a no-op')
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).lifecycle, 'stopped')
    await service.stopAll()
    await service.stopAll()
  } finally {
    fixture.store.close()
  }
})

test('S10 a config change keeps the source identity and bumps the generation', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/identity'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/identity', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const sourceId = control.runtimes[0]?.sourceId
    const before = fixture.store.getCollectorInstance(created.instance.id)
    await service.reconfigureInstance(created.instance.id, { config: { token: 'rotated' } })
    await settle(() => control.runtimes.length === 2, pump)
    const after = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(control.runtimes[1]?.sourceId, sourceId)
    assert.equal(after.configRevision, before.configRevision + 1)
    assert.ok(after.generation > before.generation)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S11 a derived observation keeps its lineage and is never resampled', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/derived'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/derived', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const runtime = control.runtimes[0]!
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
      checkpointAfter: { value: 'c', revision: runtime.checkpoint.revision },
    }
    const ack = await runtime.commit(payload) as IngestAck
    const stored = fixture.store.getEvent(ack.accepted[0]!.eventId)
    assert.deepEqual(stored?.provenance, provenance)
    const replay = await runtime.commit(payload) as IngestAck
    assert.equal(replay.batchId, ack.batchId, 'a replayed batch returns the stored receipt')
    assert.equal(replay.accepted[0]?.eventId, ack.accepted[0]?.eventId, 'the observation identity is stable')
    assert.equal(fixture.store.getEvent(ack.accepted[0]!.eventId)?.contentHash, stored?.contentHash)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S12 a restarted run resumes from the persisted checkpoint without resending', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/resume'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/resume', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    fixture.store.updateCollectorInstance(created.instance.id, {
      checkpoint: { value: 'already-covered', revision: 5 },
      now: fixture.now,
    })
    await service.reconfigureInstance(created.instance.id, {})
    await settle(() => control.runtimes.length === 2, pump)
    const runtime = control.runtimes[1]!
    assert.deepEqual(runtime.checkpoint, { value: 'already-covered', revision: 5 })
    assert.equal(fixture.store.maxIngestSeq(), -1, 'no historical event was re-emitted')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S13 one collector failing its run does not block the others', async () => {
  const { fixture, control, service, pump } = setup()
  const good: Control = { runtimes: [], mounts: 0 }
  const bad: Control = {
    runtimes: [],
    mounts: 0,
    outcome: { ok: false, failure: { state: 'unavailable', code: 'start-failed', message: 'source unavailable' } },
  }
  try {
    service.register(definition('test/good'), fakeFactory(good))
    service.register(definition('test/bad'), fakeFactory(bad))
    const a = service.createInstance({ type: 'test/good', config: {}, desiredState: 'enabled' })
    const b = service.createInstance({ type: 'test/bad', config: {}, desiredState: 'enabled' })
    assert.ok(a.ok && b.ok)
    await settle(
      () => good.runtimes.length >= 1
        && fixture.store.getCollectorInstance(b.instance.id).health === 'unavailable'
        && fixture.store.getCollectorInstance(b.instance.id).nextRetryAt !== null,
      pump,
    )
    assert.equal(fixture.store.getCollectorInstance(a.instance.id).health, 'healthy')
    assert.equal(fixture.store.getCollectorInstance(b.instance.id).health, 'unavailable')
    assert.ok(fixture.store.getCollectorInstance(b.instance.id).nextRetryAt !== null)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('S14 the run context exposes no business side-effect service', async () => {
  const { fixture, control, service, pump } = setup()
  try {
    service.register(definition('test/surface'), fakeFactory(control))
    const created = service.createInstance({ type: 'test/surface', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    await settle(() => control.runtimes.length === 1, pump)
    const runtime = control.runtimes[0]! as unknown as Record<string, unknown>
    const forbidden = ['notify', 'schedule', 'attention', 'tasks', 'quno', 'store', 'runner', 'outbox', 'ingress']
    for (const key of forbidden) assert.equal(key in runtime, false, `${key} must not leak into a collector run`)
    // The only write capability is the generation-checked commit face.
    assert.deepEqual(Object.keys(runtime).filter(key => typeof runtime[key] === 'function'), ['commit'])
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

/** One batch helper for the scheduler tests. */
export function batchOf(key: string, revision: number): IngestBatch {
  return {
    batchKey: key,
    events: [{ eventKey: `${key}-e1`, type: 'test/changed', observedAt: new Date().toISOString(), summary: key }],
    checkpointAfter: { value: `cursor-${key}`, revision },
  }
}
