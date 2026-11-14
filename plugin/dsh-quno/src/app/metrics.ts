/**
 * Bounded operational metrics derived from durable rows.
 *
 * Every number is computed on demand from state the Engine already persisted;
 * there is no counter table to drift and no clock of its own. The report is
 * intentionally small: it answers whether the Eval/Router path is economical
 * (batches, direct-pass ratio, observe/auto acceptance) and whether input
 * delivery is honest (delivered → read → acknowledged latency).
 *
 * @module dsh-quno/app/metrics
 */

import type { DomainRepository } from '../core/repository.ts'

/** One latency distribution summary (milliseconds). */
export interface LatencySummary {
  readonly p50: number | null
  readonly p95: number | null
  readonly samples: number
}

/** The bounded metrics report. */
export interface EngineMetrics {
  readonly evals: number
  readonly triggersJudged: number
  /** Average Trigger batch size of opened Evals. */
  readonly averageBatchSize: number
  /** Decisions per 100 judged Triggers (Router call economy). */
  readonly decisionsPer100Triggers: number
  readonly accepted: number
  readonly ignored: number
  readonly unavailable: number
  /** Accepted Tickets whose Mandate came from a Human Turn. */
  readonly directAcceptRatio: number | null
  /** Observe-mode downgrades (`would_accept`) among decisions. */
  readonly wouldAcceptRecorded: number
  readonly inputDeliveredLatencyMs: LatencySummary
  readonly inputReadLatencyMs: LatencySummary
  readonly inputAcknowledgedLatencyMs: LatencySummary
}

/** Compute the report from durable rows (bounded scan). */
export function computeMetrics(repo: DomainRepository, qunoId: string, now: number): EngineMetrics {
  void now
  const evals = repo.listEvals(qunoId, { limit: 500 })
  const decisions = repo.listDecisions(qunoId, 500)
  let judged = 0
  for (const evalRecord of evals) judged += evalRecord.triggerIds.length
  const averageBatchSize = evals.length === 0 ? 0 : round(judged / evals.length)

  const accepted = decisions.filter(decision => decision.kind === 'accept').length
  const ignored = decisions.filter(decision => decision.kind === 'ignore').length
  const unavailable = decisions.filter(decision => decision.kind === 'unavailable').length
  const wouldAccept = decisions.filter(decision => decision.audit['wouldAccept'] === true || decision.audit['downgraded'] === true).length

  const directAccepted = decisions.filter(decision => decision.kind === 'accept' && decision.mandate?.basis.via === 'direct').length

  const delivered: number[] = []
  const read: number[] = []
  const acknowledged: number[] = []
  for (const ticket of repo.listTickets(qunoId, { limit: 200 })) {
    for (const input of repo.listInputsByTicket(ticket.id, { limit: 50 })) {
      if (input.deliveredAt !== null) delivered.push(Math.max(0, input.deliveredAt - input.createdAt))
      if (input.deliveredAt !== null && input.readAt !== null) read.push(Math.max(0, input.readAt - input.deliveredAt))
      if (input.acknowledgedAt !== null) acknowledged.push(Math.max(0, input.acknowledgedAt - input.createdAt))
    }
  }

  return {
    evals: evals.length,
    triggersJudged: judged,
    averageBatchSize,
    decisionsPer100Triggers: judged === 0 ? 0 : round((decisions.length / judged) * 100),
    accepted,
    ignored,
    unavailable,
    directAcceptRatio: accepted === 0 ? null : round(directAccepted / accepted),
    wouldAcceptRecorded: wouldAccept,
    inputDeliveredLatencyMs: summarize(delivered),
    inputReadLatencyMs: summarize(read),
    inputAcknowledgedLatencyMs: summarize(acknowledged),
  }
}

function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) return { p50: null, p95: null, samples: 0 }
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    samples: sorted.length,
  }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index] ?? 0
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
