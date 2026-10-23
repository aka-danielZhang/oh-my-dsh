/**
 * One bounded thinking run: claim → analyze → validate → commit.
 *
 * The commit is a single transaction over attention revisions, delivery
 * settlement, the run result and the notification outbox. Nothing is settled
 * on the model's word: an event the output omits stays pending, a stale
 * attention revision aborts the whole commit, and a lease lost mid-run can
 * never write.
 *
 * @module dsh-quno/runner
 */

import { parseRunOutput } from './contracts.ts'
import { applyAttentionChanges, AttentionCommitError } from './attention.ts'
import { mergeNotificationCandidates } from './selection.ts'
import { sha256, truncateText } from './util.ts'
import type { QunoStore } from './store.ts'
import type {
  AttentionItemRecord,
  EventDecision,
  EventId,
  EventRecord,
  NoticePayload,
  NotificationCandidate,
  QunoConfig,
  QunoRecord,
  RunCost,
  RunId,
  RunOutput,
  RunRecord,
  SenseInstanceRecord,
} from './types.ts'

/** The exact vocabulary the analysis model must return (also embedded in its prompt). */
export const RUN_OUTPUT_CONTRACT = `Return ONE JSON object, no prose, with exactly these keys:
{
  "eventDecisions": [{ "eventId": "<id from the batch>", "decision": "processed|irrelevant|superseded|deferred", "reason": "<short>", "deferredUntil": <epoch ms, optional> }],
  "attentionChanges": [{
    "action": "create|update|resolve|dismiss|expire|wait|snooze",
    "itemId": "<existing item id, required for non-create>",
    "topicKey": "<stable topic key>",
    "expectedRevision": <existing item revision, required for non-create>,
    "title": "<short title>",
    "summary": "<what the user needs to know>",
    "status": "open|waiting|snoozed|resolved|dismissed|expired",
    "material": <true only when the deadline, owner, required action or blocker changed>,
    "evidence": [{ "eventId": "<batch id>" }],
    "nextReviewAt": <epoch ms or null>,
    "snoozedUntil": <epoch ms or null>,
    "subjectRefs": ["<stable subject key>"]
  }],
  "notificationCandidates": [{ "topicKey": "<same key>", "itemIds": ["<item id>"], "reason": "<why tell the user now>", "kind": "update|reminder", "reminderStage": <int>, "title": "<optional>", "body": "<optional user-facing summary>" }],
  "uncertainties": ["<what you could not determine>"]
}
Rules: decide every event you were given; use only ids present in the input; never invent facts; mark a change material only for a real change in deadline, owner, required action or blocker; a reminder needs a reminderStage. Time fields are absolute Unix epoch milliseconds (13 digits), computed from the current time stated above; never emit ISO strings, seconds, or relative times.`

/** What one analysis call needs. */
export interface AnalyzeRequest {
  readonly quno: QunoRecord
  readonly run: RunRecord
  readonly events: readonly EventRecord[]
  readonly attention: readonly AttentionItemRecord[]
  readonly senses: readonly SenseInstanceRecord[]
  readonly config: QunoConfig
  readonly now: number
  readonly signal: AbortSignal
}

/** Raw model answer plus accounting. */
export interface AnalyzerOutput {
  readonly raw: string
  readonly provider: string | null
  readonly model: string | null
  readonly sessionId: string | null
  readonly cost: Omit<RunCost, 'durationMs'>
}

/** A model-backed or injected analysis engine. */
export interface Analyzer {
  analyze(request: AnalyzeRequest): Promise<AnalyzerOutput>
  /** One bounded correction turn after an invalid answer. */
  repair?(request: AnalyzeRequest, previous: AnalyzerOutput, problem: string): Promise<AnalyzerOutput>
  /** Release the run's analysis session after the outcome is recorded. */
  finalize?(runId: string): Promise<void>
}

/** Run-level failure with a stable classification. */
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly cost?: Omit<RunCost, 'durationMs'>,
  ) {
    super(message)
    this.name = 'RunFailure'
  }
}

/** Outcome reported to the scheduler and the runs view. */
export interface RunOutcome {
  readonly runId: RunId
  readonly status: 'committed' | 'failed'
  readonly committed: number
  readonly deferred: number
  readonly released: number
  readonly notices: number
  readonly stopped: number
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean }
}

/** Dependencies of the runner. */
export interface RunnerDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly analyzer: Analyzer
  readonly logger: { warn: (message: string) => void; info?: (message: string) => void }
}

/** Turn one run through analysis and commit. */
export class Runner {
  constructor(private readonly deps: RunnerDeps) {}

  /**
   * Execute one claimed run.
   * @param runId - run claimed by the scheduler.
   * @param signal - run-level cancellation (timeout or unload).
   * @param now - injectable clock.
   * @returns the committed or failed outcome (never throws for a run failure).
   */
  async execute(runId: RunId, signal: AbortSignal, now = Date.now()): Promise<RunOutcome> {
    const { store } = this.deps
    const run = store.getRun(runId)
    const quno = store.getQuno(this.deps.qunoId)
    if (quno === undefined) throw new Error('quno row disappeared during a run')
    const events = store.getEvents(run.inputEventIds)
    const attention = run.inputAttentionIds.flatMap((id) => {
      const item = store.getAttentionItem(id)
      return item === undefined ? [] : [item]
    })
    const senses = store.listSenseInstances(this.deps.qunoId)
    const startedAt = Date.now()
    const controller = new AbortController()
    const stop = (): void => controller.abort(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) controller.abort(signal.reason)

    const request: AnalyzeRequest = {
      quno,
      run,
      events,
      attention,
      senses,
      config: quno.config,
      now,
      signal: controller.signal,
    }

    let analyzed: AnalyzerOutput | undefined
    try {
      analyzed = await this.analyze(request)
      const parsed = this.parse(analyzed.raw, quno.config)
      let output: RunOutput
      if (parsed.ok) {
        output = parsed.value
      } else {
        if (this.deps.analyzer.repair === undefined) {
          throw new RunFailure('invalid-output', parsed.error.message, false, analyzed.cost)
        }
        const repaired = await this.deps.analyzer.repair(request, analyzed, parsed.error.message)
        analyzed = repaired
        const second = this.parse(repaired.raw, quno.config)
        if (!second.ok) throw new RunFailure('invalid-output', second.error.message, false, repaired.cost)
        output = second.value
      }
      let outcome: RunOutcome
      try {
        outcome = this.commit(run, output, {
          provider: analyzed.provider,
          model: analyzed.model,
          cost: { ...analyzed.cost, durationMs: Date.now() - startedAt },
          now,
        })
      } catch (error) {
        // A structurally valid answer can still propose an impossible value
        // (a bad epoch, an unknown item). Give the model exactly one chance to
        // correct it; the first transaction rolled back, so nothing leaked.
        if (!(error instanceof AttentionCommitError) || error.code !== 'invalid-change'
          || this.deps.analyzer.repair === undefined) throw error
        const repaired = await this.deps.analyzer.repair(request, analyzed, error.message)
        analyzed = repaired
        const second = this.parse(repaired.raw, quno.config)
        if (!second.ok) throw new RunFailure('invalid-output', second.error.message, false, repaired.cost)
        outcome = this.commit(run, second.value, {
          provider: repaired.provider,
          model: repaired.model,
          cost: { ...repaired.cost, durationMs: Date.now() - startedAt },
          now,
        })
      }
      return outcome
    } catch (error) {
      const failure = error instanceof RunFailure
        ? error
        : error instanceof AttentionCommitError
          ? new RunFailure(error.code, error.message, error.code === 'revision-conflict')
          : new RunFailure('run-error', (error as Error).message, true, analyzed?.cost)
      this.fail(runId, failure, now)
      return {
        runId,
        status: 'failed',
        committed: 0,
        deferred: 0,
        released: run.inputEventIds.length,
        notices: 0,
        stopped: run.inputEventIds.length,
        error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      }
    } finally {
      signal.removeEventListener('abort', stop)
      await this.deps.analyzer.finalize?.(runId)
    }
  }

  private async analyze(request: AnalyzeRequest): Promise<AnalyzerOutput> {
    try {
      return await this.deps.analyzer.analyze(request)
    } catch (error) {
      if (request.signal.aborted) {
        throw new RunFailure('timeout', 'run exceeded its time budget or was cancelled', true)
      }
      throw new RunFailure('analyzer-error', (error as Error).message, true)
    }
  }

  private parse(raw: string, config: QunoConfig): ReturnType<typeof parseRunOutput> {
    const json = extractJson(raw)
    if (json === undefined) {
      return { ok: false, error: { code: 'validation', message: 'the answer does not contain a JSON object' } }
    }
    return parseRunOutput(json, config.budget)
  }

  private commit(
    run: RunRecord,
    output: RunOutput,
    meta: { provider: string | null; model: string | null; cost: RunCost; now: number },
  ): RunOutcome {
    const { store } = this.deps
    const qunoId = this.deps.qunoId
    const { now } = meta
    const input = new Set(run.inputEventIds)
    let committed = 0
    let deferred = 0
    let notices = 0
    let released = 0

    store.transaction(() => {
      this.assertFence(run, now)
      // 1. Event dispositions. Only input ids may be decided; capped by budget.
      const decisions = new Map<EventId, EventDecision>()
      for (const decision of output.eventDecisions) {
        if (!input.has(decision.eventId)) {
          throw new RunFailure('invalid-output', `decision cites event "${decision.eventId}" outside the run input`, false)
        }
        if (decisions.has(decision.eventId)) continue
        decisions.set(decision.eventId, decision)
      }
      for (const event of store.getEvents([...decisions.keys()])) {
        const decision = decisions.get(event.id)
        if (decision === undefined) continue
        switch (decision.decision) {
          case 'processed':
            store.settleDelivery(run.id, event.id, 'processed', decision.reason ?? null, now)
            committed += 1
            break
          case 'irrelevant':
            store.settleDelivery(run.id, event.id, 'ignored', decision.reason ?? null, now)
            committed += 1
            break
          case 'superseded':
            store.settleDelivery(run.id, event.id, 'processed', decision.reason ?? 'superseded', now)
            committed += 1
            break
          case 'deferred': {
            const until = clampDefer(decision.deferredUntil, now)
            store.deferDelivery(run.id, event.id, until, decision.reason ?? null, now)
            deferred += 1
            break
          }
        }
      }

      // 2. Attention changes (revision CAS inside).
      const applied = applyAttentionChanges(store, qunoId, output.attentionChanges, run.id, now)

      // 3. Notification outbox.
      notices = this.enqueueNotices(run, output, applied, meta.now)

      // 4. Commit the run and release everything the model omitted.
      released = store.releaseDeliveries(run.id, now + 60_000)
      store.commitRun(run.id, output, meta.cost, now)
      store.updateRunStatus(run.id, 'committed', {
        provider: meta.provider,
        model: meta.model,
        finishedAt: now,
      })
    })

    return {
      runId: run.id,
      status: 'committed',
      committed,
      deferred,
      released,
      notices,
      stopped: 0,
    }
  }

  private enqueueNotices(
    run: RunRecord,
    output: RunOutput,
    applied: ReturnType<typeof applyAttentionChanges>,
    now: number,
  ): number {
    const { store } = this.deps
    const quno = store.getQuno(this.deps.qunoId)
    if (quno === undefined) return 0
    const config = quno.config
    let candidates = mergeNotificationCandidates(output.notificationCandidates)
    if (config.notificationPolicy.mode === 'every-run'
      && candidates.length === 0
      && (output.eventDecisions.length > 0 || output.attentionChanges.length > 0)) {
      candidates = [{
        topicKey: `digest/${String(run.id)}`,
        reason: 'every-run digest',
        kind: 'update',
        title: '本轮检查结果',
        body: summarizeRun(output),
      }]
    }
    if (config.notificationPolicy.mode === 'meaningful') {
      candidates = candidates.filter((candidate) => {
        if (candidate.kind === 'reminder') return true
        if (applied.materialTopics.has(candidate.topicKey)) return true
        return (candidate.itemIds ?? [])
          .some(id => applied.materialTopics.has(topicOf(applied.items, id)))
      })
    }
    let enqueued = 0
    for (const candidate of candidates) {
      const items = (candidate.itemIds ?? [])
        .flatMap(id => applied.items.filter(item => item.id === id))
      const topicItem = items[0] ?? store.getAttentionByTopic(this.deps.qunoId, candidate.topicKey)
      const materialRevision = topicItem?.materialRevision ?? Math.max(1, run.fence)
      const payload = buildNoticePayload(candidate, topicItem, config)
      const record = store.enqueueNotice({
        qunoId: this.deps.qunoId,
        topicKey: candidate.topicKey,
        materialRevision,
        reminderStage: candidate.reminderStage ?? 0,
        kind: 'report',
        payload,
        eligibleAt: now,
        expiresAt: now + config.retention.noticeDays * 24 * 60 * 60_000,
        now,
      })
      if (record === null) continue
      enqueued += 1
      if (config.dryRun) {
        store.transitionNotice(record.id, ['pending'], {
          status: 'suppressed',
          reason: 'dry-run',
          now,
        })
      }
    }
    return enqueued
  }

  private fail(runId: RunId, failure: RunFailure, now: number): void {
    const { store } = this.deps
    try {
      store.transaction(() => {
        store.failRun(runId, { code: failure.code, message: failure.message, retryable: failure.retryable }, now)
        store.releaseDeliveries(runId, now + (failure.retryable ? 60_000 : 10 * 60_000))
      })
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: failed to record run failure: ${(error as Error).message}`)
    }
  }

  private assertFence(run: RunRecord, now: number): void {
    const current = this.deps.store.getRun(run.id)
    if (current.fence !== run.fence) {
      throw new RunFailure('fence-lost', 'a newer run claimed this work', false)
    }
    if (current.status !== 'claimed' && current.status !== 'running') {
      throw new RunFailure('fence-lost', `run is ${current.status}`, false)
    }
    if (current.claimExpiresAt !== null && current.claimExpiresAt < now) {
      throw new RunFailure('lease-expired', 'the run lease expired before the commit', true)
    }
  }
}

function topicOf(items: readonly AttentionItemRecord[], itemId: string): string {
  return items.find(item => item.id === itemId)?.topicKey ?? ''
}

/** Extract the first balanced JSON object from model prose/fences. */
export function extractJson(raw: string): unknown {
  const text = raw.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = fenced?.[1] !== undefined ? [fenced[1], text] : [text]
  for (const candidate of candidates) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as unknown
    } catch {
      continue
    }
  }
  return undefined
}

function clampDefer(value: number | undefined, now: number): number {
  if (value === undefined || !Number.isFinite(value)) return now + 15 * 60_000
  const max = now + 30 * 24 * 60 * 60_000
  return Math.min(max, Math.max(now + 60_000, Math.round(value)))
}

function summarizeRun(output: RunOutput): string {
  const parts: string[] = []
  if (output.eventDecisions.length > 0) parts.push(`处理了 ${String(output.eventDecisions.length)} 条事件`)
  if (output.attentionChanges.length > 0) parts.push(`更新了 ${String(output.attentionChanges.length)} 条关注事项`)
  return parts.length === 0 ? '本轮没有需要汇报的变化。' : `${parts.join('，')}。`
}

/** Build the deterministic notice the user later sees and can act on. */
export function buildNoticePayload(
  candidate: NotificationCandidate,
  item: AttentionItemRecord | undefined,
  config: QunoConfig,
): NoticePayload {
  const title = candidate.title ?? item?.title ?? 'Quno 有新消息'
  const body = candidate.body ?? item?.summary ?? candidate.reason
  const lines = [body]
  const evidence = item?.evidence ?? []
  if (evidence.length > 0) {
    const readable = evidence
      .slice(0, 3)
      .map(point => point.quote ?? point.eventId ?? point.itemId ?? '')
      .filter(Boolean)
    if (readable.length > 0) lines.push(`依据：${truncateText(readable.join('；'), 400)}`)
  }
  if (config.notificationPolicy.mode !== 'meaningful') {
    lines.push(`原因：${candidate.reason}`)
  }
  const itemIds = candidate.itemIds ?? (item === undefined ? [] : [item.id])
  if (itemIds.length > 0) lines.push('操作：已处理 / 一小时后提醒 / 不再关注')
  return {
    title: truncateText(title, 120),
    body: truncateText(lines.join('\n\n'), 6000),
    summary: truncateText(candidate.reason, 110),
    why: truncateText(candidate.reason, 500),
    itemIds,
  }
}

/** Hash a run's raw answer for a tamper-evident diagnostic trail. */
export function outputDigest(raw: string): string {
  return sha256(raw)
}
