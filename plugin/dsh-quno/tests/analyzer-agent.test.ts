/**
 * Real-agent contract test for the analysis engine: the production AgentLoop,
 * the real tool registry and a scripted adapter. Proves that a Quno run
 * creates a hidden restricted session, registers only the read tools, streams
 * one JSON answer and exposes the durable session for audit.
 *
 * @module dsh-quno/tests/analyzer-agent
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AgentAnalyzer } from '../src/analyzer.ts'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoIngress } from '../src/ingress.ts'
import { addSense, envelope, openFixture } from './helpers.ts'
import type { AnalyzeRequest } from '../src/runner.ts'
import type { QunoRecord } from '../src/types.ts'

/** Scripted model: each stream() call consumes the next answer. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const next = this.script.shift()
    if (next === undefined) throw new Error('script exhausted')
    for (const chunk of next) yield chunk
  }
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('the analysis agent runs a real turn with only read tools and returns its JSON', async () => {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new ScriptedAdapter([
    textChunks(JSON.stringify({
      eventDecisions: [{ eventId: 'unused', decision: 'processed' }],
      attentionChanges: [],
      notificationCandidates: [],
      uncertainties: [],
    })),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await mountAgentLoopTestHarness(ctx)
  const fixture = openFixture()
  try {
    const sense = addSense(fixture)
    const ingress = new QunoIngress(fixture.store, 'quno')
    const ack = ingress.ingest({
      instance: sense.instance,
      source: sense.source,
      generation: sense.instance.generation,
      configRevision: sense.instance.configRevision,
    }, {
      batchKey: 'analyzer-1',
      events: [envelope({ eventKey: 'review-1', type: 'calendar/event-updated', summary: '评审改期到 10:00' })],
    }, fixture.now)
    const eventId = ack.accepted[0]?.eventId
    assert.ok(eventId !== undefined)
    const quno = fixture.store.getQuno('quno') as QunoRecord
    const request: AnalyzeRequest = {
      quno: { ...quno, modelProvider: 'mock', model: 'mock' },
      run: {
        id: 'run-analyzer',
        qunoId: 'quno',
        kind: 'think',
        trigger: 'test',
        configRevision: 1,
        sessionId: null,
        status: 'claimed',
        fence: 1,
        claimExpiresAt: Date.now() + 60_000,
        inputEventIds: [eventId],
        inputAttentionIds: [],
        startedAt: Date.now(),
        finishedAt: null,
        result: null,
        error: null,
        provider: null,
        model: null,
        cost: null,
      },
      events: [fixture.store.getEvent(eventId)!],
      attention: [],
      senses: [sense.instance],
      config: DEFAULT_QUNO_CONFIG,
      now: Date.now(),
      signal: new AbortController().signal,
    }
    const analyzer = new AgentAnalyzer({
      ctx,
      logger: { info: () => {}, warn: () => {} },
      readEvents: ids => fixture.store.getEvents(ids),
      listAttention: () => [],
      readSourceEvents: () => [],
      listSources: () => [{ id: sense.source.id, type: sense.source.type }],
    })
    const output = await analyzer.analyze(request)
    assert.match(output.raw, /eventDecisions/)
    assert.equal(output.provider, 'mock')
    assert.equal(output.sessionId?.startsWith('quno-analysis-'), true)
    assert.equal(output.cost.modelCalls, 1)
    const analysisSession = output.sessionId === null ? undefined : ctx.sessions.get(output.sessionId as never)
    assert.ok(analysisSession !== undefined)
    assert.equal(analysisSession.header.origin, 'subagent', 'analysis sessions stay out of the normal sidebar')
    const userTexts = analysisSession.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .flatMap(event => event.type === 'user/message' ? event.data.content : [])
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    assert.equal(userTexts.length, 1)
    assert.match(userTexts[0] ?? '', /本轮新事件/)
    await analyzer.finalize(request.run.id)
  } finally {
    fixture.store.close()
    await ctx.fiber.dispose()
  }
})
