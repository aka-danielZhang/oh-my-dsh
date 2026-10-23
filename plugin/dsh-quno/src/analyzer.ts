/**
 * Prompt assembly and the model-backed analysis engine.
 *
 * The main conversation never receives raw events; the analysis agent is a
 * hidden, restricted, short-lived session that can only read the evidence it
 * was given.
 *
 * @module dsh-quno/analyzer
 */

import { homedir } from 'node:os'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-agent-default-model'

import { RUN_OUTPUT_CONTRACT, type AnalyzeRequest, type Analyzer, type AnalyzerOutput } from './runner.ts'
import { localClock, toIso, truncateText } from './util.ts'
import type { AttentionItemRecord, EventRecord } from './types.ts'

/** Per-event structured-data cap inside the prompt. */
const EVENT_DATA_CHARS = 1200

/** One durable session event as the analyzer reads it. */
interface AnalysisEvent {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** Read-only observation face (the real sessionQuery conforms). */
interface SessionReader {
  observeSession(
    id: SessionId,
    options: { readonly signal: AbortSignal; readonly projectionMode: 'none' },
  ): Promise<{ readonly events: readonly AnalysisEvent[]; [Symbol.dispose](): void }>
}

/** Render the bounded analysis prompt. */
export function buildAnalysisPrompt(request: AnalyzeRequest): string {
  const { quno, events, attention, senses, config, now } = request
  const clock = localClock(now, config.timeZone)
  const lines: string[] = []
  lines.push('你是 Quno 的分析引擎，运行在隔离的只读会话里。用户看不到这条消息；你只输出结构化 JSON，交给 Host 校验后落库。')
  lines.push(`当前时间：${toIso(now)}（${config.timeZone} 本地 ${clock.dayKey} ${clock.hhmm}）`)
  lines.push(`通知策略：${config.notificationPolicy.mode === 'meaningful' ? '只汇报有意义的变化' : '每轮汇总一次'}；安静时段：${config.quietHours === null ? '无' : `${config.quietHours.start}–${config.quietHours.end}`}`)
  if (quno.instructions.trim() !== '') lines.push(`用户给 Quno 的职责说明：${truncateText(quno.instructions, 2000)}`)

  lines.push('')
  lines.push('## 来源健康')
  if (senses.length === 0) {
    lines.push('（暂无已配置的感知器）')
  } else {
    for (const sense of senses) {
      lines.push(`- ${sense.label}（${sense.type}）：${sense.health}；最后成功同步 ${fmt(sense.lastSuccessAt)}；连续失败 ${String(sense.consecutiveFailures)} 次`)
    }
  }

  lines.push('')
  lines.push('## 现有关注事项（修改必须带 itemId + expectedRevision）')
  if (attention.length === 0) {
    lines.push('（无）')
  } else {
    for (const item of attention) lines.push(renderAttention(item))
  }

  lines.push('')
  lines.push('## 本轮新事件（只能使用这里的 eventId）')
  if (events.length === 0) {
    lines.push('（本轮没有新事件，只有到期事项需要复查）')
  } else {
    let budget = Math.max(4000, config.budget.maxContextChars - lines.join('\n').length)
    for (const event of events) {
      const rendered = renderEvent(event)
      if (rendered.length > budget) break
      budget -= rendered.length
      lines.push(rendered)
    }
  }

  lines.push('')
  lines.push('## 输出要求')
  lines.push(RUN_OUTPUT_CONTRACT)
  lines.push('如果本轮没有任何值得打扰用户的变化，notificationCandidates 返回空数组。不要为了显得勤奋而编造事项。')
  return lines.join('\n')
}

function fmt(value: number | null): string {
  return value === null ? '从未' : (toIso(value) ?? '未知')
}

function renderAttention(item: AttentionItemRecord): string {
  const parts = [
    `- [${item.topicKey}] id=${item.id} revision=${String(item.revision)} status=${item.status}`,
    `标题：${item.title}；摘要：${truncateText(item.summary, 600)}`,
  ]
  if (item.nextReviewAt !== null) parts.push(`下次复查：${fmt(item.nextReviewAt)}`)
  const evidence = item.evidence.slice(0, 5).map(point => point.eventId ?? point.quote ?? point.itemId ?? '').filter(Boolean)
  if (evidence.length > 0) parts.push(`证据：${evidence.join(', ')}`)
  return parts.join(' ')
}

function renderEvent(event: EventRecord): string {
  const data = event.data === null || event.data === undefined
    ? ''
    : truncateText(JSON.stringify(event.data), EVENT_DATA_CHARS)
  const when = event.occurredAt === null ? `采集于 ${fmt(event.observedAt)}` : `发生于 ${fmt(event.occurredAt)}`
  return [
    `- eventId=${event.id} type=${event.type} operation=${event.operation} ${when}`,
    `  主体：${event.subjectKey ?? '（无）'}${event.subjectRevision === null ? '' : `@${event.subjectRevision}`}；来源建议优先级：${event.priority}${event.deadline === null ? '' : `；截止：${fmt(event.deadline)}`}`,
    `  摘要：${event.summary === null ? '（无摘要）' : truncateText(event.summary, 800)}`,
    ...(data === '' ? [] : [`  结构化内容：${data}`]),
    `  血缘：${event.provenance.kind}${event.provenance.kind === 'derived' ? `（${event.provenance.processor}，覆盖：${event.provenance.coverage}）` : ''}`,
  ].join('\n')
}

/** The correction turn: one bounded attempt, never an unbounded self-repair loop. */
export function buildCorrectionPrompt(problem: string): string {
  return `上一条回复没有通过结构校验：${problem}

请只输出一个符合要求的 JSON 对象（不要代码块、不要解释）。如果无法确定某个字段，宁可少报一条事项，也不要编造 id 或 revision。所有时间字段是 Unix epoch 毫秒（13 位整数）：请基于输入中给出的当前时间重新计算，不要输出 ISO 字符串、秒级时间戳或相对时间。`
}

/** Services the agent-backed analyzer needs. */
export interface AnalyzerDeps {
  readonly ctx: Context
  readonly logger: { warn: (message: string) => void; info?: (message: string) => void }
  readonly readEvents: (ids: readonly string[]) => readonly EventRecord[]
  readonly listAttention: () => readonly AttentionItemRecord[]
  readonly readSourceEvents: (sourceId: string, subjectKey: string | null, limit: number) => readonly EventRecord[]
  readonly listSources: () => readonly { readonly id: string; readonly type: string }[]
}

interface LiveAnalysis {
  readonly agent: Agent
  readonly dispose: () => Promise<void>
}

/** A real model run in an isolated, read-only session. */
export class AgentAnalyzer implements Analyzer {
  private readonly live = new Map<string, LiveAnalysis>()

  constructor(private readonly deps: AnalyzerDeps) {}

  async analyze(request: AnalyzeRequest): Promise<AnalyzerOutput> {
    return await this.runTurn(request, buildAnalysisPrompt(request))
  }

  async repair(request: AnalyzeRequest, previous: AnalyzerOutput, problem: string): Promise<AnalyzerOutput> {
    const live = this.live.get(request.run.id)
    if (live === undefined) throw new Error('cannot repair without a live analysis session')
    return await this.runTurn(request, buildCorrectionPrompt(problem))
  }

  /** Dispose the run's analysis session (the durable log stays on disk). */
  async finalize(runId: string): Promise<void> {
    const live = this.live.get(runId)
    if (live === undefined) return
    this.live.delete(runId)
    await live.dispose().catch((error: unknown) => {
      this.deps.logger.warn(`dsh-quno: analysis session disposal failed: ${(error as Error).message}`)
    })
  }

  private async runTurn(request: AnalyzeRequest, prompt: string): Promise<AnalyzerOutput> {
    const { ctx } = this.deps
    const sessionQuery = ctx.get('sessionQuery') as unknown as SessionReader | undefined
    const fallback = ctx.get('agentDefaultModel')?.currentSelection()
    const provider = request.quno.modelProvider !== '' ? request.quno.modelProvider : fallback?.provider
    const model = request.quno.model !== '' ? request.quno.model : fallback?.model
    const reasoningEffort = request.quno.reasoningEffort
      ?? (request.quno.model === '' ? fallback?.reasoningEffort : undefined)
    if (provider === undefined || model === undefined) {
      throw new Error('no model route is configured for Quno analysis and the harness has no default model')
    }

    let live = this.live.get(request.run.id)
    if (live === undefined) {
      const sessionId = `quno-analysis-${request.run.id}-${Math.random().toString(36).slice(2, 8)}` as SessionId
      const selection = {
        provider,
        model,
        ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
      }
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: homedir(), origin: 'subagent' },
        agentOptions: { ...selection, maxTokens: request.config.budget.maxOutputTokens },
        signal: request.signal,
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          agentCtx.tools.presentAs('native')
          agentCtx.tools.restrict({ allow: [] })
          this.registerReadTools(agentCtx, request)
        },
      })
      live = { agent: handle.agent, dispose: async () => { await handle.dispose() } }
      this.live.set(request.run.id, live)
    }

    const agent = live.agent
    await agent.whenIdle()
    const firstSeq = await this.lastSeq(agent, sessionQuery)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'quno-analysis', form: 'notice', summary: 'bounded analysis batch' },
    }))
    await agent.whenIdle()
    const sessions = ctx.get('sessions')
    if (sessions !== undefined) await sessions.flush(agent.session)
    const suffix = await this.suffix(agent, sessionQuery, firstSeq)
    const turnEnd = findTurnEnd(suffix)
    if (turnEnd.kind !== 'completed' && turnEnd.kind !== 'max-tokens') {
      throw new Error(`analysis turn ended with ${turnEnd.kind}${turnEnd.detail === undefined ? '' : `: ${turnEnd.detail}`}`)
    }
    const raw = lastAssistantText(suffix)
    if (raw.trim() === '') throw new Error('the analysis model returned no text')
    return {
      raw,
      provider,
      model,
      sessionId: String(agent.session.id),
      cost: {
        promptChars: prompt.length,
        outputChars: raw.length,
        modelCalls: 1,
        toolCalls: suffix.filter(event => event.type === 'tool/call').length,
      },
    }
  }

  private async lastSeq(agent: Agent, sessionQuery: SessionReader | undefined): Promise<number> {
    if (sessionQuery === undefined) {
      const events = agent.session.snapshotEvents()
      return (events.at(-1)?.seq ?? -1) + 1
    }
    const observation = await sessionQuery.observeSession(agent.session.id, {
      signal: AbortSignal.timeout(10_000),
      projectionMode: 'none',
    })
    try {
      return (observation.events.at(-1)?.seq ?? -1) + 1
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private async suffix(
    agent: Agent,
    sessionQuery: SessionReader | undefined,
    firstSeq: number,
  ): Promise<readonly AnalysisEvent[]> {
    if (sessionQuery === undefined) {
      return agent.session.snapshotEvents().filter(event => event.seq >= firstSeq)
    }
    const observation = await sessionQuery.observeSession(agent.session.id, {
      signal: AbortSignal.timeout(10_000),
      projectionMode: 'none',
    })
    try {
      return observation.events.filter(event => event.seq >= firstSeq)
    } finally {
      observation[Symbol.dispose]()
    }
  }

  private registerReadTools(agentCtx: Context, request: AnalyzeRequest): void {
    const deps = this.deps
    const allowed = new Set(request.run.inputEventIds)
    for (const item of request.attention) {
      for (const evidence of item.evidence) if (evidence.eventId !== undefined) allowed.add(evidence.eventId)
    }
    const sources = new Set(deps.listSources().map(source => source.id))
    let toolCalls = 0
    agentCtx.tools.guard((exec) => {
      if (!exec.name.startsWith('quno_')) return '分析会话只能使用 Quno 只读工具'
      if (toolCalls >= request.config.budget.maxToolCalls) return '本轮工具调用预算已用完，请直接给出结论'
      toolCalls += 1
      return undefined
    })

    agentCtx.tools.register(defineTool({
      name: 'quno_read_events',
      description: '读取本轮授权的事件原文（只能读取批内事件与事项证据）。',
      parameters: {
        eventIds: { type: 'array', items: { type: 'string' }, description: '要回读的事件 id' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            events: { type: 'array', items: { type: 'json' }, required: true },
            rejected: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const ids = (args as { eventIds?: string[] }).eventIds ?? []
        const rejected = ids.filter(id => !allowed.has(id)).slice(0, 20)
        return {
          events: deps.readEvents(ids.filter(id => allowed.has(id))).map(renderEventJson),
          rejected,
        }
      },
    }))

    agentCtx.tools.register(defineTool({
      name: 'quno_list_attention',
      description: '列出当前关注事项（只读）。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { items: { type: 'array', items: { type: 'json' }, required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute() {
        return { items: deps.listAttention().map(renderAttentionJson) }
      },
    }))

    agentCtx.tools.register(defineTool({
      name: 'quno_read_source',
      description: '按来源/主体回读最近事件（只读，限长）。',
      parameters: {
        sourceId: { type: 'string', description: '来源 id' },
        subjectKey: { type: 'string', description: '主体稳定键，可选' },
        limit: { type: 'integer', description: '最多条数（1-20）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            events: { type: 'array', items: { type: 'json' }, required: true },
            rejected: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const input = args as { sourceId?: string; subjectKey?: string; limit?: number }
        if (input.sourceId === undefined || !sources.has(input.sourceId)) return { events: [], rejected: true }
        const limit = Math.min(20, Math.max(1, input.limit ?? 10))
        return {
          events: deps.readSourceEvents(input.sourceId, input.subjectKey ?? null, limit).map(renderEventJson),
          rejected: false,
        }
      },
    }))
  }
}

function renderEventJson(event: EventRecord): JsonValue {
  return {
    eventId: event.id,
    type: event.type,
    operation: event.operation,
    subjectKey: event.subjectKey,
    subjectRevision: event.subjectRevision,
    occurredAt: event.occurredAt,
    summary: event.summary,
    data: event.data,
    provenance: event.provenance,
    priority: event.priority,
    deadline: event.deadline,
  } as unknown as JsonValue
}

function renderAttentionJson(item: AttentionItemRecord): JsonValue {
  return {
    id: item.id,
    topicKey: item.topicKey,
    title: item.title,
    summary: item.summary,
    status: item.status,
    revision: item.revision,
    materialRevision: item.materialRevision,
    nextReviewAt: item.nextReviewAt,
    evidence: item.evidence,
  } as unknown as JsonValue
}

function findTurnEnd(events: readonly { type: string; data: unknown }[]): { kind: string; detail?: string } {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'turn/end') continue
    const data = event.data as { reason?: unknown } | undefined
    const reason = data?.reason
    if (typeof reason === 'string') return { kind: reason }
    if (typeof reason === 'object' && reason !== null) {
      const record = reason as Record<string, unknown>
      const kind = typeof record['kind'] === 'string' ? record['kind'] : 'unknown'
      const error = record['error']
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>)['message']
        if (typeof message === 'string') return { kind, detail: message }
      }
      return { kind }
    }
    return { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

function lastAssistantText(events: readonly { type: string; data: unknown }[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly unknown[] } } | undefined
    const content = data?.message?.content ?? []
    const text = content.flatMap((block) => {
      if (typeof block !== 'object' || block === null) return []
      const record = block as Record<string, unknown>
      return record['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
    }).join('\n')
    if (text.trim() !== '') return text
  }
  return ''
}

/** Declare the analysis program source on the durable message. */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'quno-analysis': {
      readonly kind: 'quno-analysis'
      readonly form: 'notice'
      readonly summary: string
    }
  }
}
