/**
 * End-to-end pipeline test (Phases A–C) with a deterministic analyzer:
 * ingest → route → preflight → claim → analyze → validate → commit →
 * notify → present, plus quiet hours, dry-run, revision conflicts, deferral,
 * budget and zero-model empty checks.
 *
 * @module dsh-quno/tests/pipeline
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoIngress } from '../src/ingress.ts'
import { Outbox, type HistoryReader, type MainConversationFace, type SessionEventLike } from '../src/outbox.ts'
import { Router } from '../src/routing.ts'
import { Runner, type AnalyzeRequest, type Analyzer, type AnalyzerOutput } from '../src/runner.ts'
import { ManualTimer, Scheduler } from '../src/scheduler.ts'
import type { QunoStore } from '../src/store.ts'
import type { NoticeRecord, QunoConfig, RunOutput } from '../src/types.ts'
import { addSense, batch, envelope, openFixture } from './helpers.ts'

const logger = { info: () => {}, warn: () => {} }

class FakeAnalyzer implements Analyzer {
  calls = 0
  repairs = 0
  requests: AnalyzeRequest[] = []
  constructor(
    private readonly answer: (request: AnalyzeRequest) => RunOutput | Error,
    private readonly correction?: (request: AnalyzeRequest, problem: string) => RunOutput | Error,
  ) {}

  async analyze(request: AnalyzeRequest): Promise<AnalyzerOutput> {
    this.calls += 1
    this.requests.push(request)
    const output = this.answer(request)
    if (output instanceof Error) throw output
    return {
      raw: JSON.stringify(output),
      provider: 'fake',
      model: 'fake',
      sessionId: null,
      cost: { promptChars: 100, outputChars: 200, modelCalls: 1, toolCalls: 0 },
    }
  }

  async repair(request: AnalyzeRequest, _previous: AnalyzerOutput, problem: string): Promise<AnalyzerOutput> {
    if (this.correction === undefined) throw new Error('no correction scripted')
    this.repairs += 1
    const output = this.correction(request, problem)
    if (output instanceof Error) throw output
    return {
      raw: JSON.stringify(output),
      provider: 'fake',
      model: 'fake',
      sessionId: null,
      cost: { promptChars: 150, outputChars: 220, modelCalls: 1, toolCalls: 0 },
    }
  }
}

interface Harness {
  readonly fixture: ReturnType<typeof openFixture>
  readonly store: QunoStore
  readonly ingress: QunoIngress
  readonly sense: ReturnType<typeof addSense>
  readonly analyzer: FakeAnalyzer
  readonly outbox: Outbox
  readonly scheduler: Scheduler
  readonly timer: ManualTimer
  readonly clock: { now: number }
  readonly delivered: { id: string; content: unknown }[]
  readonly history: { events: SessionEventLike[] }
  readonly setConfig: (patch: Partial<QunoConfig>) => void
}

function harness(
  answer: (request: AnalyzeRequest) => RunOutput | Error,
  options: { readonly failFollowupTimes?: number; readonly correction?: (request: AnalyzeRequest, problem: string) => RunOutput | Error } = {},
): Harness {
  const fixture = openFixture({ quietHours: null })
  const store = fixture.store
  const sense = addSense(fixture)
  store.ensureSubscriptions('quno', [sense.source], fixture.now)
  const ingress = new QunoIngress(store, 'quno')
  const delivered: { id: string; content: unknown }[] = []
  const history = { events: [] as SessionEventLike[] }
  let followupFailures = options.failFollowupTimes ?? 0
  const agent = {
    id: 'main-1',
    session: { id: 'main-1' },
    followup: (message: { id: string; content: unknown }) => {
      if (followupFailures > 0) {
        followupFailures -= 1
        throw new Error('transport closed')
      }
      delivered.push({ id: message.id, content: message.content })
    },
  } as unknown as Agent
  const main: MainConversationFace = {
    sessionId: () => 'main-1',
    state: () => 'ok',
    live: () => agent,
    resolve: async () => agent,
    flush: async () => true,
    markState: () => {},
  }
  const reader: HistoryReader = { readSession: async () => ({ events: history.events }) }
  const outbox = new Outbox({ store, qunoId: 'quno', main, history: reader, logger, now: () => clock.now })
  const router = new Router(store, 'quno', logger)
  const analyzer = new FakeAnalyzer(answer, options.correction)
  const runner = new Runner({ store, qunoId: 'quno', analyzer, logger })
  const timer = new ManualTimer(fixture.now)
  const clock = { now: fixture.now }
  const scheduler = new Scheduler({
    store,
    qunoId: 'quno',
    router,
    runner,
    timer,
    logger,
    now: () => clock.now,
    drainDelayMs: 1,
  })
  store.setMainSession('quno', 'main-1', 'ok', fixture.now)
  const setConfig = (patch: Partial<QunoConfig>): void => {
    store.updateQunoConfig('quno', { ...store.getQuno('quno')!.config, ...patch }, clock.now)
  }
  return { fixture, store, ingress, sense, analyzer, outbox, scheduler, timer, clock, delivered, history, setConfig }
}

function ingest(h: Harness, keys: readonly string[]): void {
  h.ingress.ingest({
    instance: h.store.getSenseInstance(h.sense.instance.id),
    source: h.sense.source,
    generation: h.store.getSenseInstance(h.sense.instance.id).generation,
    configRevision: h.store.getSenseInstance(h.sense.instance.id).configRevision,
  }, batch(keys.map(key => envelope({ eventKey: key, type: 'calendar/event-updated', summary: `事项 ${key}` }))), h.clock.now)
}

function processAll(request: AnalyzeRequest): RunOutput {
  return {
    eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
    attentionChanges: request.events.map((event, index) => ({
      action: 'create' as const,
      topicKey: `topic/${String(index)}`,
      title: `事项 ${String(index)}`,
      summary: '需要确认时间',
      material: true,
      evidence: [{ eventId: event.id }],
      nextReviewAt: null,
    })),
    notificationCandidates: request.events.map((_event, index) => ({
      topicKey: `topic/${String(index)}`,
      reason: '时间冲突',
      itemIds: [],
    })),
    uncertainties: [],
  }
}

test('ingest → route → think → notify → present closes the loop', async () => {
  const h = harness(processAll)
  try {
    ingest(h, ['a', 'b'])
    const first = await h.scheduler.checkNow('user')
    assert.equal(first.kind, 'ran')
    assert.equal(first.outcome?.status, 'committed')
    assert.equal(h.analyzer.calls, 1)
    const attention = h.store.listAttention('quno')
    assert.equal(attention.length, 2)
    const deliveries = h.store.listDeliveries('quno', 10)
    assert.equal(deliveries.filter(delivery => delivery.status === 'processed').length, 2)

    await h.outbox.kick()
    assert.equal(h.delivered.length >= 1, true)
    const message = h.delivered[0]!
    const notices = h.store.listNotices('quno', 10)
    assert.equal(notices.length, 2)
    const durable = notices.filter(notice => notice.status === 'inbox-durable')
    assert.equal(durable.length >= 1, true)
    // Presentation evidence: the exact delivered message appears, then an answer.
    h.outbox.observe('main-1', { seq: 10, type: 'user/message', data: { id: message.id } })
    h.outbox.observe('main-1', { seq: 11, type: 'assistant/message', data: { message: { content: [] } } })
    const after = h.store.listNotices('quno', 10)
    assert.equal(after.some(notice => notice.status === 'presented'), true)
  } finally {
    h.fixture.store.close()
  }
})

test('an empty check makes zero model calls', async () => {
  const h = harness(processAll)
  try {
    const result = await h.scheduler.checkNow('timer')
    assert.equal(result.kind, 'empty')
    assert.equal(h.analyzer.calls, 0)
  } finally {
    h.fixture.store.close()
  }
})

test('deferred events wait for their instant and then run again', async () => {
  const h = harness((request) => {
    if (request.events.length === 0) throw new Error('unexpected empty run')
    return {
      eventDecisions: request.events.map(event => ({
        eventId: event.id,
        decision: 'deferred' as const,
        reason: 'waiting for confirmation',
        deferredUntil: request.now + 10 * 60_000,
      })),
      attentionChanges: [],
      notificationCandidates: [],
      uncertainties: [],
    }
  })
  try {
    ingest(h, ['later'])
    const first = await h.scheduler.checkNow('event')
    assert.equal(first.outcome?.status, 'committed')
    assert.equal(h.store.listDeliveries('quno', 10)[0]?.status, 'deferred')

    const soon = await h.scheduler.checkNow('timer')
    assert.equal(soon.kind, 'empty', 'not yet eligible')
    assert.equal(h.analyzer.calls, 1)

    h.clock.now += 11 * 60_000
    const second = await h.scheduler.checkNow('timer')
    assert.equal(second.kind, 'ran')
    assert.equal(h.analyzer.calls, 2)
  } finally {
    h.fixture.store.close()
  }
})

test('a stale attention revision aborts the commit and keeps the event pending', async () => {
  let phase = 0
  let itemId = ''
  let staleRevision = 0
  const h = harness((request) => {
    phase += 1
    if (phase === 1) {
      return {
        eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
        attentionChanges: [{
          action: 'create',
          topicKey: 'topic/review',
          title: '评审',
          summary: '第一版',
          material: true,
        }],
        notificationCandidates: [],
        uncertainties: [],
      }
    }
    return {
      eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
      attentionChanges: [{
        action: 'update',
        itemId,
        topicKey: 'topic/review',
        expectedRevision: staleRevision,
        title: '评审',
        summary: '陈旧覆盖',
        material: true,
      }],
      notificationCandidates: [],
      uncertainties: [],
    }
  })
  try {
    ingest(h, ['first'])
    await h.scheduler.checkNow('event')
    const item = h.store.getAttentionByTopic('quno', 'topic/review')
    assert.ok(item !== undefined)
    itemId = item.id
    staleRevision = item.revision - 1

    ingest(h, ['second'])
    const outcome = await h.scheduler.checkNow('event')
    assert.equal(outcome.outcome?.status, 'failed')
    assert.equal(outcome.outcome?.error?.code, 'revision-conflict')
    assert.equal(h.store.getAttentionItem(item.id)?.summary, '第一版')
    const delivery = h.store.listDeliveries('quno', 10).find(entry => entry.status === 'pending')
    assert.ok(delivery !== undefined, 'the event stays pending for re-evaluation')
  } finally {
    h.fixture.store.close()
  }
})

test('quiet hours hold proactive notices and merge the same topic', async () => {
  const h = harness(processAll)
  try {
    // 23:00 local Asia/Shanghai with a 22:00-08:00 quiet window.
    h.clock.now = Date.parse('2026-10-23T15:00:00.000Z')
    h.setConfig({ quietHours: { start: '22:00', end: '08:00' } })
    ingest(h, ['quiet'])
    await h.scheduler.checkNow('event')
    await h.outbox.kick()
    const notice = h.store.listNotices('quno', 10)[0]
    assert.equal(notice?.status, 'pending')
    assert.equal(notice?.reason, 'quiet-hours hold')
    assert.ok((notice?.eligibleAt ?? 0) > h.clock.now)
    assert.equal(h.delivered.length, 0)
  } finally {
    h.fixture.store.close()
  }
})

test('dry-run records the notice without delivering it', async () => {
  const h = harness(processAll)
  try {
    h.setConfig({ dryRun: true })
    ingest(h, ['dry'])
    await h.scheduler.checkNow('event')
    const notice = h.store.listNotices('quno', 10)[0]
    assert.equal(notice?.status, 'suppressed')
    assert.equal(notice?.reason, 'dry-run')
    await h.outbox.kick()
    assert.equal(h.delivered.length, 0)
  } finally {
    h.fixture.store.close()
  }
})

test('the daily budget blocks a model run without losing the work', async () => {
  const h = harness(processAll)
  try {
    h.setConfig({ budget: { ...DEFAULT_QUNO_CONFIG.budget, dailyModelRuns: 0 } })
    ingest(h, ['budget'])
    const result = await h.scheduler.checkNow('event')
    assert.equal(result.kind, 'budget')
    assert.equal(h.analyzer.calls, 0)
    assert.equal(h.store.listDeliveries('quno', 10)[0]?.status, 'pending')
  } finally {
    h.fixture.store.close()
  }
})

test('an invalid answer gets one repair turn, then fails honestly', async () => {
  let calls = 0
  const h = harness(() => {
    calls += 1
    return new Error('not json')
  })
  try {
    ingest(h, ['bad'])
    const result = await h.scheduler.checkNow('event')
    assert.equal(result.outcome?.status, 'failed')
    assert.equal(result.outcome?.error?.code, 'analyzer-error')
    assert.equal(calls, 1)
    assert.equal(h.store.listDeliveries('quno', 10)[0]?.status, 'pending')
  } finally {
    h.fixture.store.close()
  }
})

test('outbox reconciliation re-delivers a reliably absent uncertain notice', async () => {
  const h = harness(processAll)
  try {
    ingest(h, ['reconcile'])
    await h.scheduler.checkNow('event')
    await h.outbox.kick()
    const notice: NoticeRecord | undefined = h.store.listNotices('quno', 10)[0]
    assert.ok(notice !== undefined)
    h.store.transitionNotice(notice.id, ['inbox-durable'], { status: 'uncertain', reason: 'crash window', now: h.clock.now })
    // The message never landed in the durable log.
    h.history.events = []
    const result = await h.outbox.reconcile()
    assert.equal(result.redelivered, 1)
    const after = h.store.getNotice(notice.id)
    assert.equal(after.status, 'pending')
    assert.equal(after.messageId, null)
  } finally {
    h.fixture.store.close()
  }
})

test('a followup failure is retried after its backoff instead of being lost', async () => {
  const h = harness(processAll, { failFollowupTimes: 1 })
  try {
    ingest(h, ['retry-me'])
    await h.scheduler.checkNow('event')
    await h.outbox.kick()
    const failed = h.store.listNotices('quno', 10)[0]
    assert.equal(failed?.status, 'retryable-failure')
    assert.ok((failed?.eligibleAt ?? 0) > h.clock.now)
    assert.equal(h.delivered.length, 0)

    await h.outbox.kick()
    assert.equal(h.delivered.length, 0, 'not yet eligible')
    h.clock.now += 5 * 60_000
    await h.outbox.kick()
    assert.equal(h.store.listNotices('quno', 10)[0]?.status, 'inbox-durable')
    assert.equal(h.delivered.length, 1)
  } finally {
    h.fixture.store.close()
  }
})

test('an impossible semantic value gets one correction turn instead of failing the run', async () => {
  const badTime = (request: AnalyzeRequest): RunOutput => ({
    eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
    attentionChanges: [{
      action: 'create',
      topicKey: 'topic/epoch',
      title: '时间字段',
      summary: '第一次写错了 epoch',
      material: true,
      nextReviewAt: request.now - 400 * 24 * 60 * 60_000,
    }],
    notificationCandidates: [],
    uncertainties: [],
  })
  const h = harness(badTime, {
    correction: (request) => ({
      eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
      attentionChanges: [{
        action: 'create',
        topicKey: 'topic/epoch',
        title: '时间字段',
        summary: '修正后的关注',
        material: true,
        nextReviewAt: request.now + 60 * 60_000,
      }],
      notificationCandidates: [],
      uncertainties: [],
    }),
  })
  try {
    ingest(h, ['bad-epoch'])
    const result = await h.scheduler.checkNow('event')
    assert.equal(result.outcome?.status, 'committed')
    assert.equal(h.analyzer.calls, 1)
    assert.equal(h.analyzer.repairs, 1)
    const item = h.store.getAttentionByTopic('quno', 'topic/epoch')
    assert.equal(item?.summary, '修正后的关注')
    assert.equal(item?.nextReviewAt, h.clock.now + 60 * 60_000)
  } finally {
    h.fixture.store.close()
  }
})

test('a correction that repeats the mistake fails honestly', async () => {
  const badTime = (request: AnalyzeRequest): RunOutput => ({
    eventDecisions: request.events.map(event => ({ eventId: event.id, decision: 'processed' as const })),
    attentionChanges: [{
      action: 'create',
      topicKey: 'topic/epoch2',
      title: '时间字段',
      summary: '还是错',
      material: true,
      nextReviewAt: 1234,
    }],
    notificationCandidates: [],
    uncertainties: [],
  })
  const h = harness(badTime, { correction: badTime })
  try {
    ingest(h, ['bad-epoch-2'])
    const result = await h.scheduler.checkNow('event')
    assert.equal(result.outcome?.status, 'failed')
    assert.equal(result.outcome?.error?.code, 'invalid-change')
    assert.equal(h.analyzer.repairs, 1)
    assert.equal(h.store.listAttention('quno').length, 0)
  } finally {
    h.fixture.store.close()
  }
})
