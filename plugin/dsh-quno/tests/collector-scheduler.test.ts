/**
 * Host-side collection scheduling (collector redesign): the plugin never
 * holds a timer. Driven by the scheduler's ManualTimer, these tests pin the
 * contract: enable runs immediately, a success hint is clamped to
 * [now+1s, now+24h], failures back off (`retryAfterMs` first, then the
 * deterministic Host backoff), fatal failures and run timeouts stop
 * scheduling, health is derived from outcomes, and a stale run's commit is
 * refused.
 *
 * @module dsh-quno/tests/collector-scheduler
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ManualTimer } from '../src/scheduler.ts'
import { QunoCollectorsService, type CollectorFactory, type CollectorRunContext, type CollectorRunOutcome } from '../src/collectors.ts'
import { QunoIngressError } from '../src/ingress.ts'
import { openFixture } from './helpers.ts'
import type { CollectorDefinition } from '../src/types.ts'

const logger = { info: () => {}, warn: () => {} }

const BASE = Date.parse('2026-11-09T09:00:00.000Z')

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
  mounts: number
  outcomes: CollectorRunOutcome[]
}

function fakeFactory(control: Control): CollectorFactory {
  return {
    mount() {
      return () => { control.mounts += 1 }
    },
    async run(runtime) {
      control.runtimes.push(runtime)
      return control.outcomes.shift() ?? { ok: true }
    },
  }
}

function setup() {
  const fixture = openFixture()
  const timer = new ManualTimer(BASE)
  const now = (): number => timer.now
  const control: Control = { runtimes: [], mounts: 0, outcomes: [] }
  const service = new QunoCollectorsService({
    store: fixture.store,
    qunoId: 'quno',
    logger,
    now,
    setTimer: (callback, delayMs) => timer.setTimeout(callback, delayMs),
  })
  return { fixture, timer, control, service }
}

/** Wait until the (synchronous, microtask-driven) run pipeline settles. */
async function drained(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise(resolve => setTimeout(resolve, 1))
}

test('enable runs immediately; the next run lands one declared interval later', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    service.register(definition('sched/immediate'), fakeFactory(control))
    const created = service.createInstance({ type: 'sched/immediate', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    assert.equal(timer.nextDue(), BASE, 'the first run is armed for now')
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 1)
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).lifecycle, 'idle')
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).health, 'healthy')
    assert.equal(timer.nextDue(), BASE + 60_000, 'no hint → one default interval later')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a success hint is clamped to [now+1s, now+24h]', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    const tight = { runtimes: [], mounts: 0, outcomes: [{ ok: true, nextRunAtMs: BASE + 200 }] }
    service.register(definition('sched/tight'), fakeFactory(tight as Control))
    const created = service.createInstance({ type: 'sched/tight', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 0)
    assert.equal(timer.nextDue(), BASE + 1_000, 'a sub-second hint is raised to the 1s floor')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a hint past 24h is capped', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    const far = { runtimes: [], mounts: 0, outcomes: [{ ok: true, nextRunAtMs: BASE + 25 * 3600_000 }] }
    service.register(definition('sched/far'), fakeFactory(far as Control))
    const created = service.createInstance({ type: 'sched/far', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    assert.equal(timer.nextDue(), BASE + 24 * 3600_000, 'a hint past 24h is capped at now+24h')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a non-fatal failure backs off and counts consecutiveFailures; retryAfterMs wins', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    service.register(definition('sched/backoff', { schedule: { defaultIntervalSec: 1, minIntervalSec: 1, maxRunMs: 5000 } }), {
      mount() {
        return () => { control.mounts += 1 }
      },
      async run() {
        control.runtimes.push({} as CollectorRunContext)
        return control.outcomes.shift() ?? { ok: false, failure: { state: 'unavailable', code: 'down', message: '源不可用' } }
      },
    })
    const created = service.createInstance({ type: 'sched/backoff', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    const instance = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(instance.health, 'unavailable')
    assert.equal(instance.consecutiveFailures, 1)
    assert.equal(instance.errorCode, 'down')
    // backoffMs(1) ≈ 10–11.5s > the 1s interval: the deterministic backoff wins.
    const due = timer.nextDue()
    assert.ok(due !== null && due >= BASE + 10_000 && due <= BASE + 12_000, `backoff due ${String(due)}`)
    assert.equal(instance.nextRetryAt, due)

    // A retryAfterMs hint replaces the ladder (feed's Retry-After): the next
    // run is at `due + 42s`, computed from the clock at that run.
    control.outcomes.push({ ok: false, failure: { state: 'rate-limited', code: 'rate-limited', message: '429', retryAfterMs: 42_000 } })
    timer.advance(due! - timer.now)
    timer.fireDue()
    await drained()
    assert.equal(timer.nextDue(), due! + 42_000, 'retryAfterMs is honoured')
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).consecutiveFailures, 2)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a fatal failure stops scheduling until reconfigure', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    service.register(definition('sched/fatal'), {
      ...fakeFactory(control),
      async run() {
        control.runtimes.push({} as CollectorRunContext)
        return { ok: false, failure: { state: 'auth-required', code: 'account-changed', message: '账号已更换', fatal: true } }
      },
    })
    const created = service.createInstance({ type: 'sched/fatal', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    const instance = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(instance.lifecycle, 'failed')
    assert.equal(instance.health, 'auth-required')
    assert.equal(instance.nextRetryAt, null)
    assert.equal(timer.nextDue(), null, 'no more runs are scheduled')

    // A reconfigure re-arms: the human acted.
    const result = await service.reconfigureInstance(created.instance.id, { config: { retried: true } })
    assert.equal(result.ok, true)
    assert.equal(timer.nextDue(), timer.now, 'reconfigure runs the instance immediately')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a run that overruns maxRunMs is aborted hard and stops scheduling', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    service.register(definition('sched/slow', { schedule: { defaultIntervalSec: 60, minIntervalSec: 30, maxRunMs: 1000 } }), {
      mount() {
        return () => { control.mounts += 1 }
      },
      run: () => new Promise<CollectorRunOutcome>(() => {
        // hangs forever; the deadline must cut it off
      }),
    })
    const created = service.createInstance({ type: 'sched/slow', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await new Promise(resolve => setTimeout(resolve, 1_200))
    const instance = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(instance.lifecycle, 'failed')
    assert.equal(instance.health, 'unavailable')
    assert.equal(instance.errorCode, 'run-timeout')
    assert.equal(timer.nextDue(), null)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a run in flight defers the timer; a newer run fences the older context', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    let release: ((outcome: CollectorRunOutcome) => void) | undefined
    service.register(definition('sched/fence'), {
      mount() {
        return () => { control.mounts += 1 }
      },
      run: (ctx) => new Promise<CollectorRunOutcome>((resolve, reject) => {
        control.runtimes.push(ctx)
        release = resolve
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true })
      }),
    })
    const created = service.createInstance({ type: 'sched/fence', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 1)
    const runCtx = control.runtimes[0]!

    // While the run is in flight a timer fire is a no-op (no second run).
    timer.advance(120_000)
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 1, 'no overlapping run')

    // The commit face works while the run is current.
    const ack = await runCtx.commit({
      batchKey: 'fence-1',
      events: [{ eventKey: 'f1', type: 'test/changed', observedAt: new Date().toISOString(), summary: 'f' }],
      checkpointAfter: { value: 'c1', revision: runCtx.checkpoint.revision },
    })
    assert.equal(ack.acceptedCount, 1)

    // Finishing the run schedules the next one; starting it bumps the
    // generation, which fences the old context's writes.
    release?.({ ok: true })
    await drained()
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).lifecycle, 'idle')
    const due = timer.nextDue()
    assert.ok(due !== null)
    timer.advance(due - timer.now)
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 2, 'the next run started')
    await assert.rejects(() => runCtx.commit({
      batchKey: 'fence-2',
      events: [{ eventKey: 'f2', type: 'test/changed', observedAt: new Date().toISOString(), summary: 'f' }],
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

test('health is derived from outcomes: issues degrade a success, extras ride through', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    control.outcomes.push({
      ok: true,
      nextRunAtMs: BASE + 60_000,
      health: {
        detail: '正在同步',
        coveredThrough: '2026-11-09T09:00:00Z',
        sourceLagSec: 42,
        progress: { trackedConversations: 7 },
        issues: [{ code: 'collection-delayed', detail: '采集延迟' }],
      },
    })
    service.register(definition('sched/health'), fakeFactory(control))
    const created = service.createInstance({ type: 'sched/health', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    const instance = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(instance.health, 'degraded', 'issues on a successful run degrade health')
    assert.equal(instance.errorCode, 'collection-delayed')
    assert.equal(instance.lastSuccessAt, BASE)
    assert.equal(instance.healthDetail?.sourceLagSec, 42)
    assert.equal(instance.healthDetail?.coveredThrough, '2026-11-09T09:00:00Z')
    assert.equal((instance.healthDetail?.progress as { trackedConversations?: number }).trackedConversations, 7)
    assert.deepEqual(instance.healthDetail?.issues?.map(issue => issue.code), ['collection-delayed'])
    assert.equal(instance.nextRetryAt, null, 'a success never carries a retry time')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})
