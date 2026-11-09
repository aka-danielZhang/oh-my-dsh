/**
 * The model gateway: ONE LlmAdapter registered for the eval provider, routing
 * by the requested model name (`router` / `worker`) to a live, replay or
 * scripted backend per role (design §3, §9).
 *
 * Every call is persisted to the attempt's `model-requests.jsonl` with the
 * fingerprinted request, the emitted chunks (replayable), the stop reason and
 * the usage — that file is both the replay source and the structural evidence
 * for tool-surface assertions.
 *
 * @module dsh-quno/evals/models/gateway
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { redactJson, redactText } from '../redact.ts'
import type { ModelPlan, ResolvedRoute } from '../plan.ts'
import { resolveRoute } from '../plan.ts'
import type { RequestUsage } from '../usage.ts'
import { usageFromProvider } from '../usage.ts'

/** Which conversation role a request belongs to. */
export type ModelRole = 'router' | 'worker'

/** Domain refs the request was serving when it fired (design §3.2). */
export interface NodeRefs {
  readonly triggerIds?: readonly string[]
  readonly threadId?: string
  readonly evalId?: string
  readonly decisionId?: string
  readonly ticketId?: string
  readonly assignmentId?: string
  readonly workerRunId?: string
  readonly exchangeId?: string
  readonly notificationId?: string
}

/** The node identity resolved at request time (stage/turn/step/refs). */
export interface NodeContext {
  readonly stage: string
  readonly turnId?: string
  readonly stepId?: string
  readonly refs: NodeRefs
}

/** Resolves the node identity for one model call (wired by the runner). */
export type NodeContextResolver = (sessionId: string, role: ModelRole) => NodeContext

/** The immutable run identity attached to every request (design §3.1). */
export interface RunContext {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  readonly seed: string
}

/** One recorded (or replayable) model exchange — the §4.1 evidence record. */
export interface ModelRequestRecord {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  readonly seq: number
  readonly role: ModelRole
  /** Requested (user-configured) vs provider-resolved routing. */
  readonly execution: {
    readonly requested: ResolvedRoute
    readonly resolved: ResolvedRoute
  }
  readonly sessionId: string
  readonly turnId?: string
  readonly stepId?: string
  readonly stage: string
  readonly refs: NodeRefs

  readonly at: number
  readonly durationMs: number
  /** sha256 over the assembled request (messages, system, session, tool names) — replay drift detection. */
  readonly fingerprint: string
  readonly request: {
    readonly messageCount: number
    readonly lastUserText: string
    readonly toolNames: readonly string[]
  }
  readonly output: {
    readonly text: string
    readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
    readonly finish: string
  }
  /** Provider usage verbatim; null = the provider returned nothing (never 0). */
  readonly usage: RequestUsage | null
  readonly mode: 'live' | 'replay' | 'scripted'
  readonly error?: string
  /** The exact chunk stream; recorded unless explicitly disabled. */
  readonly replayChunks?: readonly StreamChunk[]
}

export interface GatewayOptions {
  /** Mode per role, resolved by the CLI. */
  readonly modes: { readonly router: 'live' | 'replay' | 'scripted'; readonly worker: 'live' | 'replay' | 'scripted' }
  /** The attempt's model-requests.jsonl (recording target AND evidence). */
  readonly recordingFile?: string
  /** Hand-authored turn scripts for scripted mode (FIFO per role). */
  readonly scripts?: {
    router?: StreamChunk[][]
    worker?: StreamChunk[][]
  }
  /** The resolved ModelPlan (requested routing recorded on every request). */
  readonly plan?: ModelPlan
  /**
   * The PRODUCTION adapter (llm-pi-ai) for live mode: the gateway records and
   * delegates, never re-implementing the wire protocol (design: Live 主路径走
   * 生产原链路). Required for live; replay/scripted stay in-process.
   */
  readonly inner?: import('@deepseek-ai/dsh-llm').LlmAdapter
  /** The immutable run identity stamped on every request. */
  readonly runContext?: RunContext
  /** Sink for the run-level requests.jsonl (evidence aggregation). */
  readonly onRecord?: (record: ModelRequestRecord) => void
  /** Resolves stage/turn/step/refs for one call (wired once the runtime is up). */
  readonly now: () => number
}

function recordKey(role: ModelRole, seq: number): string {
  return `${role}:${String(seq)}`
}

/** Fingerprint of one request: sha256 over messages, system and tool names. */
export function fingerprintOf(options: GenerateOptions): string {
  return createHash('sha256').update(JSON.stringify({
    messages: options.messages,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    tools: (options.tools ?? []).map(tool => tool.name),
  })).digest('hex')
}

/** The sessionId a request belongs to (loop-stamped; best effort). */
function sessionOf(options: GenerateOptions): string {
  return options.sessionId === undefined ? '(unknown)' : String(options.sessionId)
}

/** The conversation role of one request, from its SESSION identity. */
export function roleOfSession(sessionId: string): ModelRole {
  return sessionId.startsWith('quno-exec-') ? 'worker' : 'router'
}

function lastUserText(options: GenerateOptions): string {
  for (let index = options.messages.length - 1; index >= 0; index -= 1) {
    const message = options.messages[index]
    if (message === undefined || message.role !== 'user') continue
    const content = message.content as readonly { type?: string; text?: string }[]
    return content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').slice(0, 400)
  }
  return ''
}

function toolCallBlocks(chunks: readonly StreamChunk[]): { id: string; name: string; arguments: string }[] {
  const calls: { id: string; name: string; arguments: string }[] = []
  for (const chunk of chunks) {
    if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call') continue
    calls.push({ id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
  }
  return calls
}

/**
 * The gateway. Owns per-role request counters, the recording file, the replay
 * index and the scripted script queues.
 */
export class ModelGateway {
  /** Request counters per role (internal; also used by the adapter). */
  readonly counters: Record<ModelRole, number> = { router: 0, worker: 0 }
  /** Completed exchanges (internal; also used by the adapter). */
  readonly requests: ModelRequestRecord[] = []
  private replay: Map<string, ModelRequestRecord> | undefined
  private readonly adapter: GatewayAdapter
  /** Node-context resolver, wired by the runner once the runtime is up. */
  private contextResolver: NodeContextResolver | undefined

  constructor(private readonly options: GatewayOptions) {
    this.adapter = new GatewayAdapter(options, this)
  }

  /** The LlmAdapter to register for the eval provider. */
  llmAdapter(): LlmAdapter {
    return this.adapter
  }

  /** Calls issued so far, optionally per role (budget accounting). */
  calls(role?: ModelRole): number {
    return role === undefined ? this.requests.length : this.counters[role]
  }

  /** All completed exchanges (for checks and the report). */
  record(): readonly ModelRequestRecord[] {
    return this.requests
  }

  /** Build the replay index from a previous live run's recording file. */
  useRecording(file: string): void {
    const index = new Map<string, ModelRequestRecord>()
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const record = JSON.parse(line) as ModelRequestRecord
        if (record.replayChunks === undefined) continue
        index.set(recordKey(record.role, record.seq), record)
      }
    }
    this.replay = index
  }

  /** The recorded exchange for one role/seq, if any (adapter access). */
  recordingFor(role: ModelRole, seq: number): ModelRequestRecord | undefined {
    return this.replay?.get(recordKey(role, seq))
  }

  /** Wire the node-context resolver (runner calls this after runtime.start). */
  setContextResolver(resolver: NodeContextResolver): void {
    this.contextResolver = resolver
  }

  /** The current node context (or an honest unknown fallback). */
  contextFor(sessionId: string, role: ModelRole): NodeContext {
    if (this.contextResolver !== undefined) {
      try {
        return this.contextResolver(sessionId, role)
      } catch {
        // Context resolution must never break the model call itself.
      }
    }
    return { stage: 'unknown', refs: {} }
  }

  /** Push one scripted turn at runtime (cases that build turns dynamically). */
  pushScript(role: ModelRole, chunks: readonly StreamChunk[]): void {
    const scripts = this.options.scripts
    if (scripts === undefined) throw new Error('pushScript requires scripted scripts to be initialized')
    const queue = scripts[role] ??= []
    queue.push([...chunks])
  }

  /** Finalize the recording file (evidence is appended incrementally). */
  saveRecording(): void {
    if (this.options.recordingFile === undefined) return
    mkdirSync(dirname(this.options.recordingFile), { recursive: true })
    writeFileSync(
      this.options.recordingFile,
      this.requests.map(record => JSON.stringify(redactJson(record))).join('\n') + '\n',
      'utf8',
    )
  }

  private appendEvidence(record: ModelRequestRecord): void {
    if (this.options.recordingFile === undefined) return
    mkdirSync(dirname(this.options.recordingFile), { recursive: true })
    appendFileSync(this.options.recordingFile, `${JSON.stringify(redactJson(record))}\n`, 'utf8')
  }

  /** Adapter-side emit path: record + append evidence + run-level sink. */
  emit(record: ModelRequestRecord): void {
    this.requests.push(record)
    this.appendEvidence(record)
    this.options.onRecord?.(record)
  }
}

/** The gateway adapter: the requested model name selects the role. */
class GatewayAdapter extends LlmAdapter {
  constructor(
    private readonly options: GatewayOptions,
    private readonly gateway: ModelGateway,
  ) {
    super()
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const sessionId = sessionOf(options)
    const role: ModelRole = roleOfSession(sessionId)
    const mode = this.options.modes[role]
    const seq = ++this.gateway.counters[role]
    const startedAt = this.options.now()
    const wallStartedAt = Date.now()
    const fingerprint = fingerprintOf(options)
    const node = this.gateway.contextFor(sessionId, role)
    const plan = this.options.plan
    const requested: ResolvedRoute = plan !== undefined
      ? resolveRoute(plan[role])
      : { provider: options.provider, model: options.model, baseUrl: '' }
    const run = this.options.runContext
    const chunks: StreamChunk[] = []
    let errorMessage: string | undefined
    try {
      if (mode === 'scripted') {
        const script = this.options.scripts?.[role]?.shift()
        if (script === undefined) {
          throw new Error(
            `scripted ${role} script exhausted at request ${String(seq)}; add a turn to the case script `
            + `(last user text: "${lastUserText(options)}")`,
          )
        }
        for (const chunk of script) {
          chunks.push(chunk)
          yield chunk
        }
      } else if (mode === 'replay') {
        const record = this.gateway.recordingFor(role, seq)
        if (record === undefined) {
          throw new Error(
            `replay has no recording for ${role} request ${String(seq)}; run live mode first or point --replay at a recording`,
          )
        }
        if (record.fingerprint !== fingerprint) {
          throw new Error(
            `replay input drift for ${role} request ${String(seq)}: the assembled request differs from the recording `
            + `(last user text now "${lastUserText(options)}" vs recorded "${record.request.lastUserText}"; `
            + `tools now [${(options.tools ?? []).map(tool => tool.name).join(', ')}] vs recorded [${record.request.toolNames.join(', ')}])`,
          )
        }
        for (const chunk of record.replayChunks ?? []) {
          chunks.push(chunk)
          yield chunk
        }
      } else {
        const inner = this.options.inner
        if (inner === undefined) {
          throw new Error('live mode requires the production adapter (llm-pi-ai); it was not mounted')
        }
        // Recording proxy with bounded transport retry (design: 网络瞬断按明确
        // 分类有限重试). Attempts are buffered: a partially-yielded stream is
        // never re-yielded, and only the final attempt's chunks reach the loop.
        const delaysMs = [10_000, 30_000, 60_000, 90_000]
        for (let attemptNo = 0; ; attemptNo += 1) {
          chunks.length = 0
          let retryable = false
          for await (const chunk of inner.stream(options)) {
            chunks.push(chunk)
          }
          const terminal = chunks.find(chunk => chunk.type === 'finish')
          if (terminal !== undefined && terminal.type === 'finish' && terminal.reason.kind === 'error') {
            const message = String((terminal.reason as { failure?: { message?: string } }).failure?.message ?? '')
            retryable = /429|overloaded|RATE_LIMIT|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch (failed|NetworkError)|\b5\d\d\b/.test(message)
          }
          if (!retryable || attemptNo >= delaysMs.length) break
          await new Promise(resolve => setTimeout(resolve, delaysMs[attemptNo]))
        }
        for (const chunk of chunks) {
          yield chunk
        }
      }
    } catch (error) {
      errorMessage = redactText((error as Error).message)
      throw error
    } finally {
      const finish = chunks.find(chunk => chunk.type === 'finish')
      const rawUsage = chunks.find(chunk => chunk.type === 'usage')
      const usage = usageFromProvider(rawUsage !== undefined && rawUsage.type === 'usage' ? rawUsage.usage : null)
      const record: ModelRequestRecord = {
        ...(run ?? { runId: '', caseId: '', attempt: 0, seed: '' }),
        seq,
        role,
        execution: {
          requested,
          // The adapter IS the resolution boundary: what it sent (live) or
          // executed (scripted/replay) is exactly this route.
          resolved: requested,
        },
        sessionId,
        ...(node.turnId === undefined ? {} : { turnId: node.turnId }),
        ...(node.stepId === undefined ? {} : { stepId: node.stepId }),
        stage: node.stage,
        refs: node.refs,
        at: startedAt,
        // Wall-clock duration: virtual-clock steps would measure ~0 and hide
        // real latency (design §5 keeps durationMs separate from tokens).
        durationMs: Math.max(0, Date.now() - wallStartedAt),
        fingerprint,
        request: {
          messageCount: options.messages.length,
          lastUserText: lastUserText(options),
          toolNames: (options.tools ?? []).map(tool => tool.name),
        },
        output: {
          text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
          toolCalls: toolCallBlocks(chunks),
          finish: finish !== undefined && finish.type === 'finish'
            ? finish.reason.kind
            : errorMessage !== undefined ? 'error' : 'unknown',
        },
        usage,
        mode,
        // A terminal error finish carries the provider failure (the loop
        // normalizes adapter failures into finish chunks); surface it so the
        // report can classify PROVIDER problems honestly.
        ...(errorMessage === undefined
          ? finish !== undefined && finish.type === 'finish' && finish.reason.kind === 'error'
            ? { error: redactText(String((finish.reason as { failure?: { message?: string } }).failure?.message ?? 'model request failed')) }
            : {}
          : { error: errorMessage }),
        // The exact chunk stream makes the recording replayable.
        replayChunks: chunks,
      }
      this.gateway.emit(record)
    }
  }
}
interface SSEPayload {
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null
      readonly tool_calls?: readonly {
        readonly index?: number
        readonly id?: string
        readonly function?: { readonly name?: string; readonly arguments?: string }
      }[]
    }
    readonly finish_reason?: string | null
  }[]
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
}

/**
 * Incremental SSE → StreamChunk assembler for OpenAI-compatible chat streams
 * (DeepSeek API shape). Pure and network-free so the protocol mapping is
 * locally testable: the tool-call ids emitted here are what the loop persists
 * and echoes back as `toolCallId`, so provider ids must be preserved verbatim.
 */
export class SseAssembler {
  private textOpen = false
  private text = ''
  private readonly slots = new Map<number, number>()
  private readonly calls: { id: string; name: string; arguments: string }[] = []
  private nextSlot = 1
  private finish: StreamChunk | null = null
  private usage: StreamChunk | null = null

  /** Consume one SSE line; returns the StreamChunks it produced. */
  push(line: string): StreamChunk[] {
    const produced: StreamChunk[] = []
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) return produced
    const payload = trimmed.slice('data:'.length).trim()
    if (payload === '[DONE]') return produced
    let parsed: SSEPayload
    try {
      parsed = JSON.parse(payload) as SSEPayload
    } catch {
      return produced
    }
    const choice = parsed.choices?.[0]
    const delta = choice?.delta
    if (delta?.content !== undefined && delta.content !== null && delta.content !== '') {
      if (!this.textOpen) {
        this.textOpen = true
        produced.push({ type: 'block-start', index: 0, blockType: 'text' })
      }
      this.text += delta.content
      produced.push({ type: 'text-delta', index: 0, text: delta.content })
    }
    for (const call of delta?.tool_calls ?? []) {
      const callIndex = call.index ?? 0
      let slot = this.slots.get(callIndex)
      if (slot === undefined) {
        slot = this.nextSlot++
        this.slots.set(callIndex, slot)
        // Keep the provider-issued id; synthesize only when absent (and then
        // keep synthesizing consistently for the whole block).
        const entry = { id: call.id ?? `call_${String(callIndex)}`, name: '', arguments: '' }
        this.calls.push(entry)
        produced.push({ type: 'block-start', index: slot, blockType: 'tool-call' })
      }
      const entry = this.calls[slot - 1]!
      if (call.id !== undefined) entry.id = call.id
      if (call.function?.name !== undefined) entry.name = call.function.name
      const argsDelta = call.function?.arguments ?? ''
      entry.arguments += argsDelta
      produced.push({
        type: 'tool-call-delta',
        index: slot,
        id: ToolCallId(entry.id),
        ...(entry.name === '' ? {} : { name: entry.name }),
        argumentsDelta: argsDelta,
      })
    }
    if (choice?.finish_reason != null) {
      const reason = choice.finish_reason === 'tool_calls' ? 'tool-calls' : choice.finish_reason
      this.finish = {
        type: 'finish',
        reason: reason === 'stop' || reason === 'tool-calls'
          ? { kind: reason }
          : reason === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' },
      }
    }
    if (parsed.usage !== undefined) {
      this.usage = {
        type: 'usage',
        usage: { inputTokens: parsed.usage.prompt_tokens ?? 0, outputTokens: parsed.usage.completion_tokens ?? 0 },
      }
    }
    return produced
  }

  /** Terminal chunks: block-end for every open block (provider index order), then usage and finish. */
  finalize(): StreamChunk[] {
    const produced: StreamChunk[] = []
    if (this.textOpen) produced.push({ type: 'block-end', index: 0, block: { type: 'text', text: this.text } })
    for (const [, slot] of [...this.slots.entries()].sort((a, b) => a[0] - b[0])) {
      const call = this.calls[slot - 1]!
      produced.push({ type: 'block-end', index: slot, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments } })
    }
    if (this.usage !== null) produced.push(this.usage)
    produced.push(this.finish ?? { type: 'finish', reason: { kind: 'stop' } })
    return produced
  }
}

/**
 * Map assembled GenerateOptions onto the OpenAI chat messages shape.
 *
 * The assistant's tool-call blocks keep their PROVIDER-issued ids: the tool
 * result messages reference the same id (`toolCallId`), and providers reject
 * histories where `tool_calls[].id` does not match the paired tool rows
 * (found by review; covered by tests/eval-gateway.test.ts).
 */
export function toOpenAiMessages(options: Pick<GenerateOptions, 'messages' | 'system'>): unknown[] {
  const out: unknown[] = []
  if (options.system !== undefined) out.push({ role: 'system', content: options.system })
  for (const message of options.messages) {
    const content = message.content as readonly { type?: string; text?: string; name?: string; arguments?: string; id?: string }[]
    if (message.role === 'system' || message.role === 'developer') {
      out.push({ role: 'system', content: content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') })
    } else if (message.role === 'user') {
      const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      out.push({ role: 'user', content: text === '' ? '（空）' : text })
    } else if (message.role === 'assistant') {
      const text = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      const calls = content.filter(block => block.type === 'tool-call')
      out.push({
        role: 'assistant',
        ...(text === '' ? {} : { content: text }),
        ...(calls.length === 0
          ? {}
          : {
            tool_calls: calls.map((block, index) => ({
              // The ORIGINAL provider id, never a positional alias.
              id: block.id !== undefined && block.id !== '' ? block.id : `call_${String(index)}`,
              type: 'function',
              function: { name: block.name ?? '', arguments: block.arguments ?? '{}' },
            })),
          }),
      })
    } else if (message.role === 'tool') {
      out.push({
        role: 'tool',
        content: content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n'),
        tool_call_id: (message as { toolCallId?: string }).toolCallId ?? '',
      })
    }
  }
  return out
}
