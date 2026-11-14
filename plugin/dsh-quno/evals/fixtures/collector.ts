/**
 * The fixture collector (design §2 L3): a synthetic collector registered through the
 * REAL `qunoCollectors` registry, producing Triggers through the REAL ingress
 * (dedupe, checkpoint, same-transaction Trigger/Thread commit) and answering
 * Exchanges through the REAL query capability surface.
 *
 * All fixture content is synthetic; nothing here touches a real source.
 *
 * @module dsh-quno/evals/fixtures/collector
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EventEnvelope, IngestBatch, IngestAck, CollectorDefinition } from '../../src/types.ts'
import type { CollectorFactory, CollectorRunContext } from '../../src/collectors.ts'

/** The synthetic source type mounted for cases. */
export const EVAL_COLLECTOR_TYPE = 'eval/synthetic'

/** The op set of the plan §5 whitelist, mirrored by the contract double. */
const WHITELIST_OPS = ['im.group.recent', 'im.group.search', 'im.message.list'] as const

/**
 * The plan §5 whitelist as a contract double: the same refusal reasons the
 * real yzj collector enforces, so cases can exercise the refusal→Input plumbing.
 * The matrix itself is pinned by dsh-quno-collector-yzj node tests; this double
 * must never make a whitelist case pass that the real collector would refuse.
 * `null` means the payload is inside the whitelist.
 */
export function whitelistRefusal(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return 'invalid-args：payload 必须是 { op, params? } 对象'
  }
  const record = payload as Record<string, unknown>
  const op = record['op']
  if (typeof op !== 'string' || !(WHITELIST_OPS as readonly string[]).includes(op)) {
    return `unsupported-op：未知 op "${String(op)}"；可用 op：${WHITELIST_OPS.join('、')}`
  }
  const rawParams = record['params']
  if (rawParams === undefined) return null
  if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
    return 'invalid-args：params 必须是对象'
  }
  const limit = (rawParams as Record<string, unknown>)['limit']
  if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > (op === 'im.message.list' ? 50 : 20))) {
    return 'invalid-args：limit 超出该 op 的上限'
  }
  return null
}

/** One pre-programmed Exchange response (consumed on the next request). */
interface ProgrammedResponse {
  readonly payload: unknown
}

/** State + entry points for the synthetic collector. */
export class EvalCollector {
  private readonly runtimes = new Map<string, CollectorRunContext>()
  private readonly checkpointRevisions = new Map<string, number>()
  private programmed: ProgrammedResponse | undefined
  private whitelist = false
  private counter = 0

  /** Register the type on the real collectors service (idempotent per context). */
  mountOn(ctx: Context): void {
    const collectors = ctx.get('qunoCollectors') as {
      register(definition: unknown, factory: unknown): () => Promise<void>
    } | undefined
    if (collectors === undefined) throw new Error('eval collector: the qunoCollectors service is not mounted')
    void collectors.register(this.definition(), this.factory())
  }

  /** Program the next Exchange response payload (exchangeResponse step). */
  programResponse(payload: unknown): void {
    this.programmed = { payload }
  }

  /**
   * Serve the §5 whitelist contract double instead of the echo response for
   * the current attempt (whitelist cases only; each attempt composes a fresh
   * runtime, so the toggle never leaks across cases).
   */
  setWhitelist(on: boolean): void {
    this.whitelist = on
  }

  /** Create one enabled instance through the real service; returns its id. */
  async createInstance(collectors: { createInstance(input: { type: string; config: Record<string, unknown> }): { readonly ok: boolean; readonly instance?: { readonly id: string }; readonly error?: unknown } }, config: Record<string, unknown> = {}, pump?: () => void): Promise<string> {
    const result = collectors.createInstance({ type: EVAL_COLLECTOR_TYPE, config: { label: '评测合成来源', ...config } })
    if (!result.ok || result.instance === undefined) {
      throw new Error(`eval collector instance failed: ${JSON.stringify(result.error)}`)
    }
    const instanceId = result.instance.id
    // The Host arms the first run on the virtual timer; pump it so the run
    // context (and its commit face) exists before the case drives ingests.
    await waitFor(5_000, () => {
      pump?.()
      return this.runtimes.has(instanceId)
    }, 'eval collector instance did not start')
    return instanceId
  }

  /**
   * Ingest one batch through the REAL generation-checked ingress: same
   * transaction as the Host's Trigger/Thread/ACK commit. The run context's
   * commit face is generation-bound; the fixture always holds the LATEST one
   * and mirrors the store's checkpoint revision locally, so the CAS is based
   * on the current revision.
   */
  async ingest(instanceId: string, envelopes: readonly EventEnvelope[]): Promise<IngestAck> {
    const runtime = this.runtimes.get(instanceId)
    if (runtime === undefined) throw new Error(`eval collector ${instanceId} is not running`)
    const revision = this.checkpointRevisions.get(instanceId) ?? runtime.checkpoint.revision
    const batch: IngestBatch = {
      batchKey: `eval-batch-${String(++this.counter)}`,
      events: envelopes,
      checkpointAfter: { value: `eval-cursor-${String(this.counter)}`, revision },
    }
    const ack = await runtime.commit(batch)
    this.checkpointRevisions.set(instanceId, revision + 1)
    return ack
  }

  /** The sourceId of one instance (for policy rules and evidence refs). */
  sourceIdOf(instanceId: string): string {
    const runtime = this.runtimes.get(instanceId)
    if (runtime === undefined) throw new Error(`eval collector ${instanceId} is not running`)
    return runtime.sourceId
  }

  /** The honest declaration: five reliability fields, synthetic scope. */
  private definition(): CollectorDefinition {
    return {
      type: EVAL_COLLECTOR_TYPE,
      contractVersion: 'quno.collector/v2',
      implementationVersion: '0.1.0',
      displayName: '评测合成来源',
      description: '只服务于链路评测的合成来源：按批提交合成事件，按预置负载响应异步读取。',
      eventTypes: [{ type: 'eval.event', summary: '合成事件' }],
      configFields: [{ key: 'label', label: '显示名', type: 'string' }],
      permissions: { reads: ['nothing real — synthetic fixture'], requiresModel: false },
      schedule: {
        defaultIntervalSec: 60,
        minIntervalSec: 60,
        maxRunMs: 5_000,
        quotas: { maxEventsPerRun: 100 },
      },
      reliability: {
        checkpoint: 'cursor',
        replay: { kind: 'none' },
        changeCoverage: 'all-changes',
        gapDetection: 'explicit',
        readOriginal: false,
      },
      firstSync: 'baseline-only',
      query: {
        handleRequest: async (request) => {
          if (this.whitelist) {
            const refusal = whitelistRefusal(request.payload)
            if (refusal !== null) {
              await request.failExchange(refusal, false)
              return
            }
            const op = (request.payload as { readonly op?: unknown }).op
            await request.completeExchange({ op, count: 0, more: false, truncated: false, list: [] })
            return
          }
          const payload = this.programmed?.payload ?? { ok: true, echo: request.payload }
          this.programmed = undefined
          await request.completeExchange(payload)
        },
      },
    }
  }

  /**
   * The factory: each Host-scheduled run stores the CURRENT run context so
   * tests can drive its commit face; the run itself commits nothing.
   */
  private factory(): CollectorFactory {
    return {
      run: async (ctx: CollectorRunContext) => {
        this.runtimes.set(ctx.instanceId, ctx)
        return { ok: true }
      },
    }
  }
}

/** Deadline-bounded predicate wait (all eval waits have a deadline). */
export async function waitFor(deadlineMs: number, predicate: () => boolean, description: string): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - startedAt > deadlineMs) throw new Error(`timed out after ${String(deadlineMs)}ms waiting for ${description}`)
    await sleep(25)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One synthetic envelope with eval-sane defaults. */
export function evalEnvelope(patch: Partial<EventEnvelope> & { readonly eventKey: string; readonly type: string }): EventEnvelope {
  return {
    observedAt: new Date().toISOString(),
    summary: `合成事件 ${patch.eventKey}`,
    data: { key: patch.eventKey },
    subject: { key: patch.eventKey },
    ...patch,
  }
}
