/**
 * Phase C tuning simulation: a burst after a long sleep, fairness across
 * sources, topic consolidation, per-hour notification ceilings and the
 * "time itself is a trigger" review path — all driven by deterministic ticks.
 *
 * @module dsh-quno/tests/tuning
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoIngress } from '../src/ingress.ts'
import { Outbox, type HistoryReader, type MainConversationFace } from '../src/outbox.ts'
import { Router } from '../src/routing.ts'
import { Runner, type AnalyzeRequest, type Analyzer, type AnalyzerOutput } from '../src/runner.ts'
import { ManualTimer, Scheduler } from '../src/scheduler.ts'
import { addSense, batch, envelope, openFixture } from './helpers.ts'
import type { QunoConfig, RunOutput } from '../src/types.ts'

const logger = { info: () => {}, warn: () => {} }

class ScriptedAnalyzer implements Analyzer {
  calls = 0
  requests: AnalyzeRequest[] = []
  constructor(private readonly answer: (request: AnalyzeRequest) => RunOutput) {}
  async analyze(request: AnalyzeRequest): Promise<AnalyzerOutput> {
    this.calls += 1
    this.requests.push(request)
    const output = this.answer(request)
    return {
      raw: JSON.stringify(output),
      provider: 'fake',
      model: 'fake',
      sessionId: null,
      cost: { promptChars: 100, outputChars: 50, modelCalls: 1, toolCalls: 0 },
    }
  }
}

function buildHarness(config: Partial<QunoConfig>, answer: (request: AnalyzeRequest) => RunOutput) {
  const fixture = openFixture({ quietHours: null })
  const clock = { now: fixture.now }
  const store = fixture.store
  store.updateQunoConfig('quno', { ...DEFAULT_QUNO_CONFIG, quietHours: null, ...config }, clock.now)
  const delivered: string[] = []
  const agent = {
    id: 'main-1',
    session: { id: 'main-1' },
    followup: (message: { id: string }) => { delivered.push(message.id) },
  } as unknown as Agent
  const main: MainConversationFace = {
    sessionId: () => 'main-1', state: () => 'ok', live: () => agent,
    resolve: async () => agent, flush: async () => true, markState: () => {},
  }
  const history: HistoryReader = { readSession: async () => ({ events: [] }) }
  const outbox = new Outbox({ store, qunoId: 'quno', main, history, logger, now: () => clock.now })
  const analyzer = new ScriptedAnalyzer(answer)
  const runner = new Runner({ store, qunoId: 'quno', analyzer, logger })
  const router = new Router(store, 'quno', logger)
  const timer = new ManualTimer(clock.now)
  const scheduler = new Scheduler({ store, qunoId: 'quno', router, runner, timer, logger, now: () => clock.now })
  store.setMainSession('quno', 'main-1', 'ok', clock.now)
  return { fixture, store, clock, delivered, outbox, analyzer, runtime: { router, scheduler } }
}

test('a 125-event burst after sleep drains in bounded batches without a model storm', async () => {
  const answer = (request: AnalyzeRequest) => {
    const events = request.events
    return {
      eventDecisions: events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
      attentionChanges: events.length === 0 ? [] : [{
        action: 'create' as const,
        topicKey: 'topic/shared',
        title: '共享主题',
        summary: `第 ${String(events[0]?.ingestSeq ?? 0)} 条`,
        material: true,
        evidence: events.slice(0, 3).map(event => ({ eventId: event.id })),
      }],
      notificationCandidates: [{ topicKey: 'topic/shared', reason: '有实质变化' }],
      uncertainties: [],
    }
  }
  const h = buildHarness({ budget: { ...DEFAULT_QUNO_CONFIG.budget, maxEventsPerRun: 10 } }, answer)
  try {
    const senseA = addSense(h.fixture, 'test/a')
    const senseB = addSense(h.fixture, 'test/b')
    h.store.ensureSubscriptions('quno', [senseA.source, senseB.source], h.clock.now)
    const ingress = new QunoIngress(h.store, 'quno')
    const binding = (sense: ReturnType<typeof addSense>) => ({
      instance: h.store.getSenseInstance(sense.instance.id),
      source: sense.source,
      generation: h.store.getSenseInstance(sense.instance.id).generation,
      configRevision: h.store.getSenseInstance(sense.instance.id).configRevision,
    })
    // 120 events from A and 5 from B arrive in one burst.
    for (let page = 0; page < 2; page += 1) {
      ingress.ingest(binding(senseA), batch(Array.from({ length: 60 }, (_value, index) =>
        envelope({ eventKey: `a-${String(page * 60 + index)}`, type: 'test/changed', summary: 'A' })), {
        batchKey: `burst-a-${String(page)}`,
        checkpointAfter: { value: `a-${String(page)}`, revision: page },
      }), h.clock.now)
    }
    ingress.ingest(binding(senseB), batch(Array.from({ length: 5 }, (_value, index) =>
      envelope({ eventKey: `b-${String(index)}`, type: 'test/changed', summary: 'B' })), {
      batchKey: 'burst-b',
      checkpointAfter: { value: 'b-0', revision: 0 },
    }), h.clock.now)
    h.runtime.router.route(h.clock.now)

    const sourceIds = new Set([senseA.source.id, senseB.source.id])
    assert.equal(h.store.countReadyDeliveries('quno', h.clock.now), 125)
    // First tick: bounded batch, fairness includes the minority source.
    const first = await h.runtime.scheduler.checkNow('timer')
    assert.equal(first.kind, 'ran')
    assert.equal(h.analyzer.requests[0]?.events.length, 10)
    const kinds = new Set(h.analyzer.requests[0]?.events.map(event => event.sourceId))
    assert.equal(kinds.size, 2, 'one source may not monopolise a batch')
    for (const id of kinds) assert.equal(sourceIds.has(id), true)

    // Drain: every further tick advances the virtual clock by a minute.
    let ticks = 1
    while (h.store.countReadyDeliveries('quno', h.clock.now) > 0 && ticks < 30) {
      h.clock.now += 60_000
      await h.runtime.scheduler.checkNow('timer')
      ticks += 1
    }
    assert.equal(h.store.countReadyDeliveries('quno', h.clock.now), 0, 'no starvation: everything is processed')
    assert.ok(h.analyzer.calls <= 14, `bounded model calls (got ${String(h.analyzer.calls)})`)
    const processed = h.store.countDeliveries('quno')
    assert.equal(processed['processed'], 125)
    // Exactly one attention item for the shared topic, not one per event.
    assert.equal(h.store.listAttention('quno').length, 1)
    // The empty tail costs nothing.
    const empty = await h.runtime.scheduler.checkNow('timer')
    assert.equal(empty.kind, 'empty')
    assert.equal(h.analyzer.calls <= 14, true)
  } finally {
    h.fixture.store.close()
  }
})

test('proactive notices respect the per-hour ceiling and minimum gap', async () => {
  const answer = (request: AnalyzeRequest) => ({
    eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
    attentionChanges: request.events.map((event, index) => ({
      action: 'create' as const,
      topicKey: `topic/${String(event.ingestSeq)}`,
      title: `主题 ${String(index)}`,
      summary: '变化',
      material: true,
    })),
    notificationCandidates: request.events.map(event => ({
      topicKey: `topic/${String(event.ingestSeq)}`,
      reason: '实质变化',
      body: `事件 ${String(event.ingestSeq)}`,
    })),
    uncertainties: [],
  })
  const h = buildHarness({ budget: { ...DEFAULT_QUNO_CONFIG.budget, maxEventsPerRun: 4 } }, answer)
  try {
    const sense = addSense(h.fixture, 'test/rate')
    h.store.ensureSubscriptions('quno', [sense.source], h.clock.now)
    const ingress = new QunoIngress(h.store, 'quno')
    ingress.ingest({
      instance: h.store.getSenseInstance(sense.instance.id),
      source: sense.source,
      generation: h.store.getSenseInstance(sense.instance.id).generation,
      configRevision: h.store.getSenseInstance(sense.instance.id).configRevision,
    }, batch(Array.from({ length: 8 }, (_value, index) =>
      envelope({ eventKey: `r-${String(index)}`, type: 'test/changed', summary: 'rate' })), {
      batchKey: 'rate-1',
      checkpointAfter: { value: 'r', revision: 0 },
    }), h.clock.now)
    h.runtime.router.route(h.clock.now)
    while (h.store.countReadyDeliveries('quno', h.clock.now) > 0) {
      await h.runtime.scheduler.checkNow('timer')
    }
    const notices = h.store.listNotices('quno', 100)
    assert.equal(notices.length, 8)

    await h.outbox.kick()
    assert.equal(h.delivered.length, 1, 'only one notice fits the minimum gap')
    h.clock.now += 11 * 60_000
    await h.outbox.kick()
    assert.equal(h.delivered.length, 2)
    h.clock.now += 11 * 60_000
    await h.outbox.kick()
    assert.equal(h.delivered.length, 3)
    h.clock.now += 11 * 60_000
    await h.outbox.kick()
    assert.equal(h.delivered.length, 3, 'the rolling-hour ceiling of three holds')
  } finally {
    h.fixture.store.close()
  }
})

test('an attention review instant triggers a run with no new events', async () => {
  const answer = (request: AnalyzeRequest) => ({
    eventDecisions: [],
    attentionChanges: request.attention.map(item => ({
      action: 'update' as const,
      itemId: item.id,
      topicKey: item.topicKey,
      expectedRevision: item.revision,
      summary: '复查后仍需要关注',
      material: false,
      nextReviewAt: request.now + 60 * 60_000,
    })),
    notificationCandidates: [],
    uncertainties: [],
  })
  const h = buildHarness({ checkIntervalSec: 300 }, answer)
  try {
    h.store.insertAttention({
      qunoId: 'quno',
      topicKey: 'topic/review',
      title: '待复查',
      summary: '等确认',
      status: 'open',
      subjectRefs: [],
      evidence: [],
      nextReviewAt: h.clock.now,
      snoozedUntil: null,
      material: true,
      cause: 'test',
      runId: null,
      now: h.clock.now,
    })
    const tick = await h.runtime.scheduler.checkNow('timer')
    assert.equal(tick.kind, 'ran')
    assert.equal(h.analyzer.requests[0]?.events.length, 0)
    assert.equal(h.analyzer.requests[0]?.attention.length, 1)
    const item = h.store.getAttentionByTopic('quno', 'topic/review')
    assert.equal(item?.summary, '复查后仍需要关注')
    assert.ok((item?.nextReviewAt ?? 0) > h.clock.now)
  } finally {
    h.fixture.store.close()
  }
})

test('retention keeps the log bounded without touching open work', () => {
  const h = buildHarness({}, (request: AnalyzeRequest) => ({
    eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
    attentionChanges: [],
    notificationCandidates: [],
    uncertainties: [],
  }))
  try {
    const sense = addSense(h.fixture, 'test/retention')
    const ingress = new QunoIngress(h.store, 'quno')
    ingress.ingest({
      instance: h.store.getSenseInstance(sense.instance.id),
      source: sense.source,
      generation: h.store.getSenseInstance(sense.instance.id).generation,
      configRevision: h.store.getSenseInstance(sense.instance.id).configRevision,
    }, batch([
      envelope({ eventKey: 'old-1', type: 'test/changed' }),
      envelope({ eventKey: 'old-2', type: 'test/changed' }),
    ], { batchKey: 'ret-1', checkpointAfter: { value: 'r', revision: 0 } }), h.clock.now)
    const later = h.clock.now + 40 * 24 * 60 * 60_000
    const pruned = h.store.pruneExpiredEvents(later, 30)
    assert.equal(pruned, 2)
    assert.equal(h.store.listEventsAfter(-1, 10).every(event => event.prunedAt !== null), true)
  } finally {
    h.fixture.store.close()
  }
})
