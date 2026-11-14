/**
 * The per-case trace: one JSONL event per node (stage) with machine-readable
 * refs, expected/actual and evidence paths.
 *
 * Stages the case never reached are finalized as `blocked` behind the first
 * failure — they must not be counted as passes and must not be reported as
 * the root cause.
 *
 * @module dsh-quno/evals/trace
 */

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactJson } from './redact.ts'

/** Every node the evaluator can observe on the Quno link. */
export type StageName =
  | 'source.ingest'
  | 'intake.thread'
  | 'eval.candidate'
  | 'eval.decision'
  | 'ticket.mandate'
  | 'assignment.launch'
  | 'input.delivery'
  | 'worker.execution'
  | 'worker.report'
  | 'router.relay'
  | 'notification.outbox'
  | 'notification.presented'
  | 'feedback.command'
  | 'recovery.restart'

/** The canonical stage order used to block everything behind a failure. */
export const STAGE_ORDER: readonly StageName[] = [
  'source.ingest',
  'intake.thread',
  'eval.candidate',
  'eval.decision',
  'ticket.mandate',
  'assignment.launch',
  'input.delivery',
  'worker.execution',
  'worker.report',
  'router.relay',
  'notification.outbox',
  'notification.presented',
  'feedback.command',
  'recovery.restart',
]

/** One structured trace event (design §6.1). */
export interface EvalTraceEvent {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  readonly stage: StageName
  readonly status: 'started' | 'passed' | 'failed' | 'blocked'
  readonly at: number
  readonly durationMs: number
  readonly refs: Record<string, unknown>
  readonly expected?: unknown
  readonly actual?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly evidence: readonly string[]
}

/** Relative evidence paths inside one attempt directory. */
export interface EvidencePaths {
  readonly trace: string
  readonly modelRequests: string
  readonly sessionIndex: string
  readonly failure: string
}

/** Writes one attempt's trace.jsonl and keeps the stage ledger for the report. */
export class TraceRecorder {
  private readonly started = new Map<StageName, number>()
  private readonly statuses = new Map<StageName, 'passed' | 'failed' | 'blocked'>()
  private readonly events: EvalTraceEvent[] = []

  constructor(
    private readonly meta: { readonly runId: string; readonly caseId: string; readonly attempt: number },
    private readonly dir: string,
    private readonly now: () => number,
  ) {}

  /** Evidence file paths for this attempt (relative to the run directory). */
  paths(): EvidencePaths {
    return {
      trace: join('cases', this.meta.caseId, `attempt-${String(this.meta.attempt)}`, 'trace.jsonl'),
      modelRequests: join('cases', this.meta.caseId, `attempt-${String(this.meta.attempt)}`, 'model-requests.jsonl'),
      sessionIndex: join('cases', this.meta.caseId, `attempt-${String(this.meta.attempt)}`, 'session-index.json'),
      failure: join('cases', this.meta.caseId, `attempt-${String(this.meta.attempt)}`, 'failure.json'),
    }
  }

  /** Absolute attempt directory. */
  get directory(): string {
    return this.dir
  }

  /** Mark a stage started (duration is measured to the next terminal call). */
  begin(stage: StageName): void {
    this.started.set(stage, this.now())
    this.write(stage, 'started', {}, undefined, undefined, undefined, [])
  }

  /** Record a passing stage. */
  pass(
    stage: StageName,
    refs: Record<string, unknown> = {},
    evidence: readonly string[] = [],
    detail?: { readonly expected?: unknown; readonly actual?: unknown },
  ): void {
    this.statuses.set(stage, 'passed')
    this.write(stage, 'passed', refs, detail?.expected, detail?.actual, undefined, evidence)
  }

  /** Record a failing stage with expected vs actual. */
  fail(
    stage: StageName,
    refs: Record<string, unknown> = {},
    error: { readonly code: string; readonly message: string },
    detail?: { readonly expected?: unknown; readonly actual?: unknown },
    evidence: readonly string[] = [],
  ): void {
    this.statuses.set(stage, 'failed')
    this.write(stage, 'failed', refs, detail?.expected, detail?.actual, error, evidence)
  }

  /**
   * Finalize: every stage without a terminal status becomes `blocked` — either
   * behind the first failure (downstream) or, with no failure at all, behind
   * an explicit reason (a case that intentionally does not walk the full link).
   */
  finalize(reason = 'case completed before this stage'): StageName | null {
    const firstFailure = [...this.statuses.entries()].find(([, status]) => status === 'failed')?.[0] ?? null
    for (const stage of STAGE_ORDER) {
      if (this.statuses.has(stage)) continue
      this.statuses.set(stage, 'blocked')
      this.write(stage, 'blocked', {}, undefined, undefined, { code: 'blocked', message: firstFailure === null ? reason : `blocked behind failed stage ${firstFailure}` }, [])
    }
    return firstFailure
  }

  /** All recorded events (for the report). */
  all(): readonly EvalTraceEvent[] {
    return this.events
  }

  /** Terminal status per stage. */
  statusOf(stage: StageName): 'passed' | 'failed' | 'blocked' | undefined {
    return this.statuses.get(stage)
  }

  private write(
    stage: StageName,
    status: EvalTraceEvent['status'],
    refs: Record<string, unknown>,
    expected: unknown,
    actual: unknown,
    error: EvalTraceEvent['error'],
    evidence: readonly string[],
  ): void {
    const startedAt = this.started.get(stage)
    const event: EvalTraceEvent = {
      runId: this.meta.runId,
      caseId: this.meta.caseId,
      attempt: this.meta.attempt,
      stage,
      status,
      at: this.now(),
      durationMs: startedAt === undefined ? 0 : Math.max(0, this.now() - startedAt),
      refs: redactJson(refs) as Record<string, unknown>,
      ...(expected === undefined ? {} : { expected: redactJson(expected) }),
      ...(actual === undefined ? {} : { actual: redactJson(actual) }),
      ...(error === undefined ? {} : { error }),
      evidence,
    }
    this.events.push(event)
    appendFileSync(this.file(), `${JSON.stringify(event)}\n`, 'utf8')
  }

  /** Overwrite-friendly full dump (used when a case fails before any stage ran). */
  dump(): void {
    writeFileSync(this.file(), this.events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  }

  private file(): string {
    return join(this.dir, 'trace.jsonl')
  }
}
