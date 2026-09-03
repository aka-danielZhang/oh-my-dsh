import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import HierarchicalCompactionEngine, { aggregateUsage } from '../src/index.ts'
import { mapInstruction, reduceInstruction, SUMMARY_SECTIONS } from '../src/prompts.ts'

const PROVIDER = 'hierarchy-test'
const MODEL = 'small-context'
const SIGNAL = new AbortController().signal
const STRUCTURED = SUMMARY_SECTIONS.map(section => `## ${section}\n- retained`).join('\n\n')

type OverflowWhen = (options: GenerateOptions, index: number) => boolean

/** alpha.5 TokenMeter registers session projections at construct time. */
function testContext(): Context {
  const ctx = new Context()
  Object.assign(ctx, { sessionProjections: { register() {} } })
  return ctx
}

class SummaryAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  readonly outcomes: ('overflow' | 'success')[] = []
  private readonly contextWindow: number
  private readonly output: string
  private readonly overflowWhen: OverflowWhen
  private remainingOverflows: number

  constructor(
    contextWindow: number,
    output = STRUCTURED,
    overflows = 0,
    overflowWhen: OverflowWhen = () => false,
  ) {
    super()
    this.contextWindow = contextWindow
    this.output = output
    this.remainingOverflows = overflows
    this.overflowWhen = overflowWhen
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.calls.length
    this.calls.push(options)
    if (this.remainingOverflows > 0 || this.overflowWhen(options, index)) {
      this.remainingOverflows -= this.remainingOverflows > 0 ? 1 : 0
      this.outcomes.push('overflow')
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
            message: 'simulated one-shot context overflow',
          },
        },
      }
      return
    }
    this.outcomes.push('success')
    yield { type: 'text-delta', index: 0, text: this.output }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ExposedEngine extends HierarchicalCompactionEngine {
  run(messages: readonly Message[], agent: Agent) {
    return this.summarize({ messages }, agent, SIGNAL)
  }

  runInput(input: { messages: readonly Message[]; tools?: readonly ToolSchema[] }, agent: Agent) {
    return this.summarize(input, agent, SIGNAL)
  }
}

function fixture(
  output = STRUCTURED,
  overflows = 0,
  replayTools = false,
  overflowWhen: OverflowWhen = () => false,
) {
  const ctx = testContext()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  const adapter = new SummaryAdapter(2400, output, overflows, overflowWhen)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const engine = new ExposedEngine(ctx, {
    auto: false,
    summarizationProvider: PROVIDER,
    summarizationModel: MODEL,
    chunkInputRatio: 0.5,
    maxTokens: 256,
    mapMaxTokens: 128,
    reduceMaxTokens: 256,
    maxDepth: 3,
    replayTools,
  })
  const session = Session.create(SessionId('hierarchical-engine-test'))
  const agent = {
    session,
    options: { provider: PROVIDER, model: MODEL },
  } as Agent
  return { adapter, agent, engine, session }
}

function user(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function instruction(options: GenerateOptions): string {
  const block = options.messages.at(-1)?.content.find(candidate => candidate.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

function sourceRange(options: GenerateOptions): [number, number] | null {
  const match = /source units (\d+)-(\d+) of \d+/.exec(instruction(options))
  return match === null ? null : [Number(match[1]), Number(match[2])]
}

function isReduce(options: GenerateOptions): boolean {
  return instruction(options).includes('reduce round')
}

function partialCount(options: GenerateOptions): number {
  return options.messages.filter(message => message.content.some(block => (
    block.type === 'text' && block.text.includes('<partial-summary')
  ))).length
}

test('fitting input delegates to the stock one-shot summarizer', async () => {
  const { adapter, agent, engine, session } = fixture()
  const result = await engine.run([user('small')], agent)
  assert.equal(adapter.calls.length, 1)
  assert.equal(result.llmStreamCall, true)
  assert.equal(adapter.calls[0]?.purpose, 'compaction')
  assert.equal(adapter.calls[0]?.sessionId, session.id)
})

test('a provider-confirmed one-shot overflow falls back to one bounded map call', async () => {
  const { adapter, agent, engine } = fixture(STRUCTURED, 1)
  const result = await engine.run([user('small')], agent)
  assert.equal(adapter.calls.length, 2)
  assert.equal(result.llmStreamCall, undefined)
  assert.equal(result.maxTokens, 128)
  assert.equal(result.usage, undefined)
})

test('provider overflow on one atomic map unit terminates without retrying it', async () => {
  const { adapter, agent, engine } = fixture(STRUCTURED, 2)
  await assert.rejects(
    engine.run([user('small')], agent),
    /map source unit 1.*provider context window.*indivisible/,
  )
  assert.equal(adapter.calls.length, 2)
  assert.deepEqual(adapter.outcomes, ['overflow', 'overflow'])
})

test('provider-overflowed map spans split recursively without replaying successful siblings', async () => {
  const { adapter, agent, engine } = fixture(
    STRUCTURED,
    0,
    false,
    options => !isReduce(options) && (sourceRange(options)?.[1] ?? 0) > (sourceRange(options)?.[0] ?? 0),
  )
  const messages = Array.from({ length: 5 }, (_, index) => user(`${index}: ${'x'.repeat(1200)}`))
  const result = await engine.run(messages, agent)
  const mapAttempts = adapter.calls.map((call, index) => ({
    range: sourceRange(call),
    outcome: adapter.outcomes[index],
    reduce: isReduce(call),
  })).filter(attempt => !attempt.reduce && attempt.range !== null)
  const successfulLeaves = mapAttempts
    .filter(attempt => attempt.outcome === 'success')
    .map(attempt => attempt.range)

  assert.deepEqual(successfulLeaves, [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]])
  assert.equal(mapAttempts.filter(attempt => attempt.range?.[0] === 1 && attempt.range[1] === 1).length, 1)
  assert.ok(mapAttempts.some(attempt => attempt.outcome === 'overflow'))
  assert.equal(result.usage, undefined)
  assert.equal(result.llmStreamCall, undefined)
})

test('omitting replayed tools can make hierarchy converge in one marked map call', async () => {
  const { adapter, agent, engine } = fixture()
  const tools: ToolSchema[] = [{
    name: 'large-schema',
    description: 'x'.repeat(5000),
    parameters: { type: 'object', properties: {} },
  }]
  const result = await engine.runInput({ messages: [user('small')], tools }, agent)
  assert.equal(adapter.calls.length, 1)
  assert.equal(adapter.calls[0]?.tools, undefined)
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.maxTokens, 128)
})

test('replayTools forwards schemas to every map and reduce call', async () => {
  const { adapter, agent, engine } = fixture(STRUCTURED, 0, true)
  const tools: ToolSchema[] = [{
    name: 'read',
    description: 'Read one file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  }]
  const messages = Array.from({ length: 5 }, () => user('x'.repeat(1200)))
  await engine.runInput({ messages, tools }, agent)
  assert.ok(adapter.calls.length >= 3)
  assert.ok(adapter.calls.every(call => call.tools?.[0]?.name === 'read'))
})

test('instruction reserves price the widest multi-digit source coordinates', async () => {
  const totalUnits = 12
  const { adapter, agent, engine } = fixture()
  const messages = Array.from(
    { length: totalUnits },
    (_, index) => user(`${index}: ${'x'.repeat(1200)}`),
  )
  await engine.run(messages, agent)

  assert.ok(adapter.calls.length > 0)
  let sawDoubleDigitOrdinal = false
  for (const call of adapter.calls) {
    const text = instruction(call)
    const range = /source units (\d+)-(\d+) of (\d+)/.exec(text)
    if (range === null) {
      assert.fail(`call instruction lacks a source range: ${text.slice(0, 80)}`)
    }
    const startText = range[1] ?? ''
    const endText = range[2] ?? ''
    const totalText = range[3] ?? ''
    assert.equal(Number(totalText), totalUnits)
    sawDoubleDigitOrdinal ||= Number(startText) >= 10 || Number(endText) >= 10

    // The widest-coordinate instruction is a true upper bound for every
    // actual call, which is exactly what the fixed-input reserve prices.
    const reduceRound = /reduce round (\d+)/.exec(text)?.[1]
    const widest = reduceRound === undefined
      ? mapInstruction(totalUnits, totalUnits, totalUnits)
      : reduceInstruction(Number(reduceRound), totalUnits, totalUnits, totalUnits)
    assert.ok(
      text.length <= widest.length,
      `actual instruction (${text.length}) exceeds the widest-coordinate reserve (${widest.length})`,
    )
  }
  assert.ok(sawDoubleDigitOrdinal, 'expected at least one span with a two-digit ordinal')
})

test('oversized input maps chunks, reduces them, and aggregates usage honestly', async () => {
  const { adapter, agent, engine, session } = fixture()
  const messages = Array.from({ length: 5 }, (_, index) => user(`${index}: ${'x'.repeat(1200)}`))
  const result = await engine.run(messages, agent)

  assert.ok(adapter.calls.length >= 3)
  assert.equal(result.llmStreamCall, undefined)
  assert.deepEqual(result.usage, {
    inputTokens: adapter.calls.length * 10,
    outputTokens: adapter.calls.length * 5,
    cacheReadTokens: adapter.calls.length * 2,
  })
  assert.equal(result.provider, PROVIDER)
  assert.equal(result.model, MODEL)
  assert.equal(result.maxTokens, 256)
  assert.ok(adapter.calls.every(call => call.purpose === 'compaction'))
  assert.ok(adapter.calls.every(call => call.sessionId === session.id))
  assert.ok(adapter.calls.some(call => call.messages.some(message => (
    message.content.some(block => block.type === 'text' && block.text.includes('<partial-summary'))
  ))))
  const mappedOrdinals = adapter.calls
    .filter(call => !call.messages.some(message => message.content.some(block => (
      block.type === 'text' && block.text.includes('<partial-summary')
    ))))
    .flatMap(call => call.messages)
    .flatMap(message => message.content)
    .map(block => block.type === 'text' ? /^(\d+): /.exec(block.text)?.[1] : undefined)
    .filter((value): value is string => value !== undefined)
  assert.deepEqual(mappedOrdinals, ['0', '1', '2', '3', '4'])
})

test('provider-overflowed reduce spans split locally and omit incomplete usage', async () => {
  let rejectedReduce = false
  const { adapter, agent, engine } = fixture(
    STRUCTURED,
    0,
    false,
    (options) => {
      if (!rejectedReduce && isReduce(options)) {
        rejectedReduce = true
        return true
      }
      return false
    },
  )
  const messages = Array.from({ length: 5 }, (_, index) => user(`${index}: ${'x'.repeat(1200)}`))
  const result = await engine.run(messages, agent)

  assert.equal(rejectedReduce, true)
  assert.ok(adapter.calls.some((call, index) => isReduce(call) && adapter.outcomes[index] === 'overflow'))
  assert.ok(adapter.calls.some((call, index) => isReduce(call) && adapter.outcomes[index] === 'success'))
  assert.equal(result.maxTokens, 256)
  assert.equal(result.usage, undefined)
  assert.equal(result.llmStreamCall, undefined)
})

test('adaptive reduce splitting stops before a no-progress round can repeat', async () => {
  const { adapter, agent, engine } = fixture(
    STRUCTURED,
    0,
    false,
    options => isReduce(options) && partialCount(options) > 1,
  )
  const messages = Array.from({ length: 5 }, (_, index) => user(`${index}: ${'x'.repeat(1200)}`))
  await assert.rejects(
    engine.run(messages, agent),
    /reduce round 1 made no progress after adaptive splitting/,
  )
  assert.equal(adapter.calls.some(call => instruction(call).includes('reduce round 2')), false)
})

test('a malformed map result fails before a checkpoint can be returned', async () => {
  const { agent, engine } = fixture('not a structured checkpoint')
  const messages = Array.from({ length: 5 }, () => user('x'.repeat(1200)))
  await assert.rejects(engine.run(messages, agent), /required heading/)
})

test('an oversized partial identifies the reduce round that cannot consume it', async () => {
  const oversized = SUMMARY_SECTIONS
    .map(section => `## ${section}\n${'x'.repeat(2000)}`)
    .join('\n\n')
  const { agent, engine } = fixture(oversized)
  const messages = Array.from({ length: 5 }, () => user('x'.repeat(1200)))
  await assert.rejects(engine.run(messages, agent), /reduce round 1:.*indivisible/)
})

test('output reserve incompatible with the summary model fails before streaming', async () => {
  const ctx = testContext()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  const adapter = new SummaryAdapter(1000)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const engine = new ExposedEngine(ctx, {
    auto: false,
    summarizationProvider: PROVIDER,
    summarizationModel: MODEL,
    chunkInputRatio: 0.9,
    maxTokens: 200,
    mapMaxTokens: 200,
    reduceMaxTokens: 200,
  })
  const agent = {
    session: Session.create(SessionId('bad-reserve')),
    options: { provider: PROVIDER, model: MODEL },
  } as Agent
  await assert.rejects(engine.run([user('large')], agent), /output reserve/)
  assert.equal(adapter.calls.length, 0)
})

test('a single map result does not require an unused reduce reserve', async () => {
  const ctx = testContext()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  const adapter = new SummaryAdapter(1000)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const engine = new ExposedEngine(ctx, {
    auto: false,
    summarizationProvider: PROVIDER,
    summarizationModel: MODEL,
    chunkInputRatio: 0.5,
    maxTokens: 900,
    mapMaxTokens: 100,
    reduceMaxTokens: 600,
  })
  const agent = {
    session: Session.create(SessionId('single-map-reserve')),
    options: { provider: PROVIDER, model: MODEL },
  } as Agent
  const result = await engine.run([user('small')], agent)
  assert.equal(adapter.calls.length, 1)
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.maxTokens, 100)
})

test('a model-specific one-shot cap that cannot fit routes directly to hierarchy', async () => {
  const ctx = testContext()
  void new LlmRuntime(ctx)
  void new TokenMeter(ctx)
  const adapter = new SummaryAdapter(2400)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  const engine = new ExposedEngine(ctx, {
    auto: false,
    summarizationProvider: PROVIDER,
    summarizationModel: MODEL,
    chunkInputRatio: 0.5,
    maxTokens: 256,
    mapMaxTokens: 128,
    reduceMaxTokens: 256,
    modelPolicies: [{ provider: PROVIDER, model: MODEL, maxTokens: 1300 }],
  })
  const agent = {
    session: Session.create(SessionId('model-policy-reserve')),
    options: { provider: PROVIDER, model: MODEL },
  } as Agent
  const result = await engine.run([user('small')], agent)
  assert.equal(adapter.calls.length, 1)
  assert.equal(result.llmStreamCall, true)
  assert.equal(result.maxTokens, 128)
})

test('aggregateUsage requires every stage and preserves absent optional counters', () => {
  assert.equal(aggregateUsage([]), undefined)
  assert.equal(aggregateUsage([
    { inputTokens: 2, outputTokens: 3 },
    undefined,
  ]), undefined)
  assert.deepEqual(aggregateUsage([
    { inputTokens: 2, outputTokens: 3 },
    { inputTokens: 5, outputTokens: 7, reasoningTokens: 11 },
  ]), {
    inputTokens: 7,
    outputTokens: 10,
    reasoningTokens: 11,
  })
})
