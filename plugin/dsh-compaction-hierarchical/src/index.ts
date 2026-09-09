/**
 * Hierarchical map-reduce summarizer for the stock DSH compaction transaction.
 *
 * The class inherits pressure policy, retention, durable locking, surface
 * replacement, convergence checks, `/compact`, and overflow recovery from
 * BasicCompactionEngine. Only the protected summarization hook changes.
 */

import type { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  BlockAssembler,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createUserMessage,
  LlmError,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-token-meter'
import { basicConfig, basicSupportsHierarchy, Config, resolveHierarchyConfig } from './config.ts'
import type { HierarchicalCompactionConfig, ResolvedHierarchyConfig } from './config.ts'
import {
  estimateMessages,
  OversizedCompactionUnitError,
  planMessageChunks,
  splitMessageChunk,
  toolBalancedUnits,
} from './planner.ts'
import {
  framePartialSummary,
  mapInstruction,
  reduceInstruction,
  validateStructuredSummary,
} from './prompts.ts'

export type { HierarchicalCompactionConfig } from './config.ts'
export { Config } from './config.ts'
export {
  OversizedCompactionUnitError,
  planMessageChunks,
  splitMessageChunk,
  toolBalancedUnits,
} from './planner.ts'

const PLUGIN_ID = 'dsh-compaction-hierarchical'
const CHARS_PER_TOKEN = 4
const ENVELOPE_OVERHEAD = 4

interface SummarizationInput {
  readonly system?: string
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

type TextBlock = Extract<ContentBlock, { type: 'text' }>

type SummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & (
  | { rawOutput: ContentBlock[]; llmStreamCall: true }
  | { rawOutput?: ContentBlock[]; llmStreamCall?: never }
)

interface SummaryTarget {
  readonly provider: string
  readonly model: string
  readonly oneShotMaxTokens: number
}

interface StageResult {
  readonly summary: TextBlock[]
  readonly rawOutput: ContentBlock[]
  readonly usage?: TokenUsage
}

interface SourceSpan {
  readonly messages: Message[]
  readonly start: number
  readonly end: number
}

interface PartialSummary {
  readonly message: Message
  readonly result: StageResult
  readonly start: number
  readonly end: number
}

/** Compaction Provider using bounded map calls followed by recursive reduction. */
export class HierarchicalCompactionEngine extends BasicCompactionEngine {
  static override Config = Config

  /** Validated hierarchy policy, separate from the inherited pressure policy. */
  readonly hierarchy: ResolvedHierarchyConfig

  /** Whether the installed stock engine owns the same bounded fallback. */
  private readonly stockOwnsHierarchy: boolean

  constructor(
    ctx: Context,
    config: HierarchicalCompactionConfig = {},
    stockOwnsHierarchy = basicSupportsHierarchy(BasicCompactionEngine.Config),
  ) {
    super(ctx, basicConfig(
      config,
      stockOwnsHierarchy ? BasicCompactionEngine.Config : {},
    ))
    this.hierarchy = resolveHierarchyConfig(config)
    this.stockOwnsHierarchy = stockOwnsHierarchy
    ctx.logger.info(
      'dsh-compaction-hierarchical: active (chunkInputRatio=%d, maxDepth=%d)',
      this.hierarchy.chunkInputRatio,
      this.hierarchy.maxDepth,
    )
  }

  /**
   * Delegate fitting inputs unchanged; otherwise map balanced chunks and reduce
   * their structured checkpoints until exactly one remains.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    signal?.throwIfAborted()
    if (this.stockOwnsHierarchy) return super.summarize(input, agent, signal)
    const target = this.resolveSummaryTarget(agent)
    const model = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)
    const contextWindow = model.context?.contextWindow
    if (contextWindow === undefined || !Number.isSafeInteger(contextWindow) || contextWindow < 1) {
      throw new Error(
        `hierarchical compaction: no positive integer context capacity for summary target ${target.provider}/${target.model}`,
      )
    }
    const inputBudget = Math.floor(contextWindow * this.hierarchy.chunkInputRatio)
    this.assertStageOutputReserve(
      contextWindow,
      inputBudget,
      this.hierarchy.mapMaxTokens,
      'map',
    )

    const estimate = (message: Message): number => this.ctx.tokenMeter.estimateMessage(message)
    const units = toolBalancedUnits(input.messages)
    const totalUnits = units.length
    const oneShotTokens = this.estimateCallInput(
      input,
      mapInstruction(totalUnits, totalUnits, totalUnits),
      true,
      estimate,
    )
    let hadFailedLlmAttempt = false
    const oneShotFits = oneShotTokens <= inputBudget
      && inputBudget + target.oneShotMaxTokens <= contextWindow
    if (oneShotFits) {
      try {
        return await super.summarize(input, agent, signal)
      } catch (error) {
        if (!hasErrorCode(error, CONTEXT_WINDOW_EXCEEDED_CODE)) throw error
        hadFailedLlmAttempt = true
      }
    }

    const mapReserve = this.estimateFixedInput(
      input,
      mapInstruction(totalUnits, totalUnits, totalUnits),
      this.hierarchy.replayTools,
      estimate,
    )
    const mapMessageBudget = this.messageBudget(inputBudget, mapReserve, 'map')
    const chunks = planMessageChunks(input.messages, mapMessageBudget, estimate)
    if (chunks.length === 0) {
      throw new Error('hierarchical compaction: oversized input produced no map chunks')
    }

    const calls: StageResult[] = []
    const pendingMap = this.sourceSpans(chunks)
    let partials: PartialSummary[] = []
    while (pendingMap.length > 0) {
      signal?.throwIfAborted()
      const span = pendingMap.shift()
      if (span === undefined) break
      try {
        const result = await this.runStage(
          { ...input, messages: span.messages },
          mapInstruction(span.start, span.end, totalUnits),
          target,
          this.hierarchy.mapMaxTokens,
          agent,
          signal,
        )
        calls.push(result)
        partials.push(this.partial(
          result,
          span.start,
          span.end,
          `map source units ${span.start}-${span.end}`,
        ))
      } catch (error) {
        if (signal?.aborted || !hasErrorCode(error, CONTEXT_WINDOW_EXCEEDED_CODE)) throw error
        hadFailedLlmAttempt = true
        const split = this.splitMapSpan(span, estimate)
        if (split === null) {
          throw indivisibleOverflow(`map source unit ${span.start}`, error)
        }
        pendingMap.unshift(split[1])
        pendingMap.unshift(split[0])
      }
    }
    this.assertCoverage(partials, totalUnits, 'map stage')
    if (partials.length > 1) {
      this.assertStageOutputReserve(
        contextWindow,
        inputBudget,
        this.hierarchy.reduceMaxTokens,
        'reduce',
      )
    }

    let usedReduce = false
    for (let round = 1; partials.length > 1; round += 1) {
      if (round > this.hierarchy.maxDepth) {
        throw new Error(
          `hierarchical compaction: reduction did not converge within ${this.hierarchy.maxDepth} round(s)`,
        )
      }
      const reduceReserve = this.estimateFixedInput(
        input,
        reduceInstruction(round, totalUnits, totalUnits, totalUnits),
        this.hierarchy.replayTools,
        estimate,
      )
      const reduceMessageBudget = this.messageBudget(inputBudget, reduceReserve, `reduce round ${round}`)
      let groups: Message[][]
      try {
        groups = planMessageChunks(
          partials.map(partial => partial.message),
          reduceMessageBudget,
          estimate,
        )
      } catch (error) {
        if (error instanceof Error) {
          error.message = `hierarchical compaction: reduce round ${round}: ${error.message}`
        }
        throw error
      }
      if (groups.length >= partials.length) {
        throw new Error(
          `hierarchical compaction: reduce round ${round} cannot combine any partial summaries; `
          + 'increase chunkInputRatio or lower mapMaxTokens/reduceMaxTokens',
        )
      }

      const byMessage = new Map<string, PartialSummary>(
        partials.map(partial => [partial.message.id, partial]),
      )
      const pendingReduce = groups.map(group => this.reduceSpan(group, byMessage))
      const next: PartialSummary[] = []
      while (pendingReduce.length > 0) {
        signal?.throwIfAborted()
        const span = pendingReduce.shift()
        if (span === undefined) break
        try {
          const result = await this.runStage(
            { ...input, messages: span.messages },
            reduceInstruction(round, span.start, span.end, totalUnits),
            target,
            this.hierarchy.reduceMaxTokens,
            agent,
            signal,
          )
          calls.push(result)
          next.push(this.partial(
            result,
            span.start,
            span.end,
            `reduce round ${round} source units ${span.start}-${span.end}`,
          ))
        } catch (error) {
          if (signal?.aborted || !hasErrorCode(error, CONTEXT_WINDOW_EXCEEDED_CODE)) throw error
          hadFailedLlmAttempt = true
          const splitMessages = splitMessageChunk(span.messages, estimate)
          if (splitMessages === null) {
            throw indivisibleOverflow(
              `reduce round ${round} partial ${span.start}-${span.end}`,
              error,
            )
          }
          if (next.length + pendingReduce.length + 2 >= partials.length) {
            throw new Error(
              `hierarchical compaction: reduce round ${round} made no progress after adaptive splitting `
              + `(${partials.length} -> ${next.length + pendingReduce.length + 2})`,
              { cause: error },
            )
          }
          pendingReduce.unshift(this.reduceSpan(splitMessages[1], byMessage))
          pendingReduce.unshift(this.reduceSpan(splitMessages[0], byMessage))
        }
      }
      if (next.length >= partials.length) {
        throw new Error(
          `hierarchical compaction: reduce round ${round} made no progress after adaptive splitting `
          + `(${partials.length} -> ${next.length})`,
        )
      }
      partials = next
      usedReduce = true
      this.assertCoverage(partials, totalUnits, `reduce round ${round}`)
    }

    const final = partials[0]
    if (final === undefined) throw new Error('hierarchical compaction: map stage produced no summaries')
    const usage = hadFailedLlmAttempt
      ? undefined
      : aggregateUsage(calls.map(call => call.usage))
    const result = {
      summary: final.result.summary,
      rawOutput: final.result.rawOutput,
      provider: target.provider,
      model: target.model,
      maxTokens: usedReduce ? this.hierarchy.reduceMaxTokens : this.hierarchy.mapMaxTokens,
      ...(usage === undefined ? {} : { usage }),
    }
    if (!hadFailedLlmAttempt && calls.length === 1) {
      return { ...result, llmStreamCall: true }
    }
    return result
  }

  /** Assign stable source-unit ranges to the initial greedy map chunks. */
  private sourceSpans(chunks: readonly Message[][]): SourceSpan[] {
    let start = 1
    return chunks.map((messages) => {
      const unitCount = toolBalancedUnits(messages).length
      const span = { messages, start, end: start + unitCount - 1 }
      start = span.end + 1
      return span
    })
  }

  /** Bisect one failed map span while preserving its stable source coordinates. */
  private splitMapSpan(
    span: SourceSpan,
    estimate: (message: Message) => number,
  ): [SourceSpan, SourceSpan] | null {
    const split = splitMessageChunk(span.messages, estimate)
    if (split === null) return null
    const leftEnd = span.start + toolBalancedUnits(split[0]).length - 1
    return [
      { messages: split[0], start: span.start, end: leftEnd },
      { messages: split[1], start: leftEnd + 1, end: span.end },
    ]
  }

  /** Recover one reduce group's stable source range from its partial identities. */
  private reduceSpan(
    messages: Message[],
    byMessage: ReadonlyMap<string, PartialSummary>,
  ): SourceSpan {
    const represented = messages.map((message) => {
      const partial = byMessage.get(message.id)
      if (partial === undefined) {
        throw new Error('hierarchical compaction: reducer group lost partial-summary identity')
      }
      return partial
    })
    const first = represented[0]
    const last = represented.at(-1)
    if (first === undefined || last === undefined) {
      throw new Error('hierarchical compaction: reducer produced an empty work group')
    }
    return { messages, start: first.start, end: last.end }
  }

  /** Prove adaptive children preserve complete ordered source coverage. */
  private assertCoverage(
    partials: readonly PartialSummary[],
    totalUnits: number,
    stage: string,
  ): void {
    let expected = 1
    for (const partial of partials) {
      if (partial.start !== expected || partial.end < partial.start) {
        throw new Error(`hierarchical compaction: ${stage} lost chronological source coverage`)
      }
      expected = partial.end + 1
    }
    if (partials.length === 0 || expected !== totalUnits + 1) {
      throw new Error(`hierarchical compaction: ${stage} did not cover every source unit`)
    }
  }

  /** Resolve the same configured/latest/agent summary route precedence as basic. */
  private resolveSummaryTarget(agent: Agent): SummaryTarget {
    const header = agent.session.requestHeader()?.config
    const routed = header !== undefined
      && header.provider.length > 0
      && header.model.length > 0
      ? { provider: header.provider, model: header.model }
      : undefined
    const agentTarget = agent.options.provider !== undefined
      && agent.options.provider.length > 0
      && agent.options.model !== undefined
      && agent.options.model.length > 0
      ? { provider: agent.options.provider, model: agent.options.model }
      : undefined
    const conversation = routed ?? agentTarget
    const override = conversation === undefined
      ? undefined
      : this.config.modelPolicies.find(policy => (
        policy.provider === conversation.provider && policy.model === conversation.model
      ))
    const provider = override?.summarizationProvider ?? this.config.summarizationProvider
    const model = override?.summarizationModel ?? this.config.summarizationModel
    const configured = provider.length === 0 ? undefined : { provider, model }
    const target = configured ?? routed ?? agentTarget
    if (target === undefined) {
      throw new Error(
        'hierarchical compaction: no summary provider/model; configure both fields or route one request',
      )
    }
    return {
      provider: target.provider,
      model: target.model,
      oneShotMaxTokens: override?.maxTokens ?? this.config.maxTokens,
    }
  }

  /** Ensure one stage generation cap fits outside its input budget. */
  private assertStageOutputReserve(
    contextWindow: number,
    inputBudget: number,
    outputTokens: number,
    stage: string,
  ): void {
    if (inputBudget + outputTokens > contextWindow) {
      throw new Error(
        `hierarchical compaction: ${stage} input budget ${inputBudget} plus output reserve ${outputTokens} `
        + `exceeds summary context ${contextWindow}`,
      )
    }
  }

  /** Price a complete auxiliary call input. */
  private estimateCallInput(
    input: SummarizationInput,
    instruction: string,
    includeTools: boolean,
    estimate: (message: Message) => number,
  ): number {
    return this.estimateFixedInput(input, instruction, includeTools, estimate)
      + estimateMessages(input.messages, estimate)
  }

  /** Price the repeated header and final instruction for one stage. */
  private estimateFixedInput(
    input: SummarizationInput,
    instruction: string,
    includeTools: boolean,
    estimate: (message: Message) => number,
  ): number {
    const systemTokens = input.system === undefined
      ? 0
      : Math.ceil(input.system.length / CHARS_PER_TOKEN) + ENVELOPE_OVERHEAD
    const toolsTokens = !includeTools || input.tools === undefined || input.tools.length === 0
      ? 0
      : Math.ceil(JSON.stringify(input.tools).length / CHARS_PER_TOKEN) + ENVELOPE_OVERHEAD
    return systemTokens + toolsTokens + estimate(this.instructionMessage(instruction))
  }

  /** Derive positive room for stage messages after fixed input. */
  private messageBudget(inputBudget: number, fixedTokens: number, stage: string): number {
    const budget = inputBudget - fixedTokens
    if (budget < 1) {
      throw new Error(
        `hierarchical compaction: ${stage} system/tools/instruction need ~${fixedTokens} tokens, `
        + `above the ${inputBudget}-token call input budget`,
      )
    }
    return budget
  }

  /** Run one private map or reduce model call and require structured text. */
  private async runStage(
    input: SummarizationInput,
    instruction: string,
    target: SummaryTarget,
    maxTokens: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<StageResult> {
    signal?.throwIfAborted()
    const assembler = new BlockAssembler()
    const options: GenerateOptions = {
      provider: target.provider,
      model: target.model,
      messages: [...input.messages, this.instructionMessage(instruction)],
      ...input.system === undefined ? {} : { system: input.system },
      ...this.hierarchy.replayTools && input.tools !== undefined ? { tools: [...input.tools] } : {},
      maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...signal === undefined ? {} : { signal },
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const finishFailure = finishError(assembler.finish)
    if (finishFailure !== undefined) throw finishFailure

    const rawOutput = assembler.blocks()
    if (contentHasImage(rawOutput)) {
      throw new LlmError('hierarchical compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
    }
    const summary = rawOutput.filter((block): block is TextBlock => block.type === 'text')
    validateStructuredSummary(summary, 'hierarchical compaction stage')
    return {
      summary,
      rawOutput,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }

  /** Convert one validated stage result into immutable reducer data. */
  private partial(result: StageResult, start: number, end: number, stage: string): PartialSummary {
    const text = validateStructuredSummary(result.summary, stage)
    return {
      message: createUserMessage({
        content: [{ type: 'text', text: framePartialSummary(text, start, end) }],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      }),
      result,
      start,
      end,
    }
  }

  /** Create the final user instruction for an auxiliary call. */
  private instructionMessage(text: string): Message {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    })
  }
}

/** Build the terminal diagnostic for a provider-rejected atomic span. */
function indivisibleOverflow(stage: string, cause: unknown): Error {
  const error = new OversizedCompactionUnitError(
    `hierarchical compaction: ${stage} still exceeds the provider context window and is indivisible`,
    { cause },
  ) as OversizedCompactionUnitError & { code?: string }
  error.code = CONTEXT_WINDOW_EXCEEDED_CODE
  return error
}

/** Match a structured error code without depending on an error class instance. */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code
}

/** Map a terminal stage finish to a fail-closed error. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': {
      const error = new Error(
        'hierarchical compaction stage truncated at the token cap',
      ) as Error & { code?: string }
      error.code = 'MAX_TOKENS'
      return error
    }
    default:
      return undefined
  }
}

/** Sum disjoint provider usage across every map and reduce call. */
export function aggregateUsage(usages: readonly (TokenUsage | undefined)[]): TokenUsage | undefined {
  if (usages.length === 0 || usages.some(usage => usage === undefined)) return undefined
  const present = usages as readonly TokenUsage[]
  const total: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
  }
  for (const usage of present) {
    total.inputTokens += usage.inputTokens
    total.outputTokens += usage.outputTokens
    if (usage.cacheReadTokens !== undefined) {
      total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens
    }
    if (usage.cacheWriteTokens !== undefined) {
      total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    }
    if (usage.reasoningTokens !== undefined) {
      total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens
    }
  }
  return total
}

export default HierarchicalCompactionEngine
