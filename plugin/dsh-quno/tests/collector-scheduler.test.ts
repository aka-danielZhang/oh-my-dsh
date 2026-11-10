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
  const warnings: string[] = []
  const service = new QunoCollectorsService({
    store: fixture.store,
    qunoId: 'quno',
    logger: { info: () => {}, warn: (message: string) => { warnings.push(message) } },
    now,
    setTimer: (callback, delayMs) => timer.setTimeout(callback, delayMs),
  })
  return { fixture, timer, control, service, warnings }
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
      run: (ctx) => new Promise<CollectorRunOutcome>(() => {
        // hangs forever; the deadline must cut it off
        control.runtimes.push(ctx)
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

    // The hung run keeps going in the background, but no later run will ever
    // fence it — the timeout itself revokes its write face.
    const hung = control.runtimes[0]!
    assert.equal(hung.signal.aborted, true)
    await assert.rejects(() => hung.commit({
      batchKey: 'late',
      events: [{ eventKey: 'late-1', type: 'test/changed', observedAt: new Date(BASE).toISOString(), summary: 'late' }],
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

test('health columns survive the run write: last event from the commit, last success across a failure', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    service.register(definition('sched/columns'), {
      async run(ctx) {
        control.runtimes.push(ctx)
        const scripted = control.outcomes.shift()
        if (scripted !== undefined) return scripted
        await ctx.commit({
          batchKey: `columns-${String(control.runtimes.length)}`,
          events: [{ eventKey: `e${String(control.runtimes.length)}`, type: 'test/changed', observedAt: new Date(BASE).toISOString(), summary: 'x' }],
          checkpointAfter: { value: 'c', revision: ctx.checkpoint.revision },
        })
        return { ok: true }
      },
    })
    const created = service.createInstance({ type: 'sched/columns', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    const afterSuccess = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(afterSuccess.lastEventAt, BASE, 'the run outcome must not erase the ingress-stamped last event')
    assert.equal(afterSuccess.lastSuccessAt, BASE)

    // The next run fails: both facts stay, in the columns and in the health JSON.
    control.outcomes.push({ ok: false, failure: { state: 'unavailable', code: 'down', message: '源不可用' } })
    timer.advance(timer.nextDue()! - timer.now)
    timer.fireDue()
    await drained()
    const afterFailure = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(afterFailure.health, 'unavailable')
    assert.equal(afterFailure.lastSuccessAt, BASE, 'a failed run keeps the previous success')
    assert.equal(afterFailure.lastEventAt, BASE)
    assert.equal(afterFailure.healthDetail?.lastSuccessfulSyncAt, BASE)
    assert.equal(afterFailure.healthDetail?.lastEventAt, BASE)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a run that throws backs off as run-threw instead of crashing the scheduler', async () => {
  const { fixture, timer, service } = setup()
  try {
    service.register(definition('sched/threw'), {
      async run() {
        throw new Error('plugin bug')
      },
    })
    const created = service.createInstance({ type: 'sched/threw', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    const instance = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(instance.health, 'degraded')
    assert.equal(instance.errorCode, 'run-threw')
    assert.equal(instance.consecutiveFailures, 1)
    assert.equal(instance.lifecycle, 'idle', 'a thrown run is a backoff, not a stop')
    assert.ok(timer.nextDue() !== null && instance.nextRetryAt === timer.nextDue())
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('pause stops the timer and the mount; resume re-mounts and runs immediately', async () => {
  const { fixture, timer, control, service } = setup()
  try {
    let mounted = 0
    service.register(definition('sched/pause'), {
      mount() {
        mounted += 1
        return () => { control.mounts += 1 }
      },
      async run(ctx) {
        control.runtimes.push(ctx)
        return { ok: true }
      },
    })
    const created = service.createInstance({ type: 'sched/pause', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 1)
    assert.equal(mounted, 1)

    await service.pause(created.instance.id)
    assert.equal(control.mounts, 1, 'pause disposes the mount')
    assert.equal(timer.nextDue(), null, 'a paused instance has no armed run')
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).lifecycle, 'stopped')

    await service.resume(created.instance.id)
    assert.equal(mounted, 2, 'resume mounts again for the current config')
    assert.equal(timer.nextDue(), timer.now, 'resume runs immediately')
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 2)
    assert.equal(fixture.store.getCollectorInstance(created.instance.id).lifecycle, 'idle')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a timer that fires for a vanished row logs instead of leaking a rejection', async () => {
  const { fixture, timer, control, service, warnings } = setup()
  try {
    service.register(definition('sched/vanish'), fakeFactory(control))
    const created = service.createInstance({ type: 'sched/vanish', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    // The row disappears behind the scheduler's back (no remove() → timer still armed).
    fixture.store.deleteCollectorInstance(created.instance.id)
    timer.fireDue()
    await drained()
    assert.equal(control.runtimes.length, 0)
    assert.ok(warnings.some(message => /could not start/.test(message)), 'the failure is logged, not thrown into the void')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a batch gap is recorded but does not pin health; only the run\'s issues degrade it', async () => {
  const { fixture, timer, service } = setup()
  try {
    const plans: ('routine-gap' | 'standing-gap')[] = ['routine-gap', 'standing-gap']
    service.register(definition('sched/gap'), {
      async run(ctx) {
        const plan = plans.shift()
        await ctx.commit({
          batchKey: `gap-${String(plan)}`,
          events: [],
          checkpointAfter: { value: 'c', revision: ctx.checkpoint.revision },
          gap: { reason: 'newest 还有更早历史（首轮只钉基线，不回放）' },
        })
        return plan === 'standing-gap'
          ? { ok: true, health: { issues: [{ code: 'init-window-exceeded', detail: '1 个会话存在待处理缺口' }] } }
          : { ok: true }
      },
    })
    const created = service.createInstance({ type: 'sched/gap', config: {}, desiredState: 'enabled' })
    assert.ok(created.ok)
    timer.fireDue()
    await drained()
    const routine = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(routine.health, 'healthy', 'a declared-routine batch gap does not leave the instance degraded')
    assert.equal(service.healthSnapshot().gaps.length, 1, 'the gap stays visible in the gap view')

    timer.advance(timer.nextDue()! - timer.now)
    timer.fireDue()
    await drained()
    const standing = fixture.store.getCollectorInstance(created.instance.id)
    assert.equal(standing.health, 'degraded', 'a coverage debt the run reports as an issue degrades')
    assert.equal(standing.errorCode, 'init-window-exceeded')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})
