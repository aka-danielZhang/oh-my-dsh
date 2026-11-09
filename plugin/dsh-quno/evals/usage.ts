/**
 * UsageLedger (design §5): deterministic aggregation over ModelRequestRecords
 * — no separate counters anywhere. Provider usage is recorded as returned;
 * requests without usage are counted in `usageMissing`, never treated as 0.
 *
 * @module dsh-quno/evals/usage
 */

/** The per-request usage shape every record carries (design §4.2). */
export interface RequestUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedInputTokens?: number
  readonly source: 'provider'
}

/** One aggregated bucket (role / model / session / stage / case / run). */
export interface UsageSummary {
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedInputTokens?: number
  readonly usageMissing: number
  readonly durationMs: number
}

/** The minimal record face the ledger consumes. */
export interface UsageRecord {
  readonly caseId?: string
  readonly role: string
  readonly sessionId: string
  readonly stage: string
  readonly durationMs: number
  readonly usage: RequestUsage | null
  readonly execution?: { readonly requested: { readonly provider: string; readonly model: string; readonly baseUrl: string } }
}

/** Derive RequestUsage from the provider's raw TokenUsage (or null). */
export function usageFromProvider(raw: {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
} | null | undefined): RequestUsage | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw.inputTokens !== 'number' || typeof raw.outputTokens !== 'number') return null
  return {
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    totalTokens: raw.inputTokens + raw.outputTokens,
    ...(typeof raw.cacheReadTokens === 'number' ? { cachedInputTokens: raw.cacheReadTokens } : {}),
    source: 'provider',
  }
}

function emptySummary(): UsageSummary {
  return { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageMissing: 0, durationMs: 0 }
}

function addTo(summary: { modelCalls: number; inputTokens: number; outputTokens: number; totalTokens: number; usageMissing: number; durationMs: number; cached?: number }, record: UsageRecord): void {
  summary.modelCalls += 1
  summary.durationMs += record.durationMs
  if (record.usage === null) {
    summary.usageMissing += 1
    return
  }
  summary.inputTokens += record.usage.inputTokens
  summary.outputTokens += record.usage.outputTokens
  summary.totalTokens += record.usage.totalTokens
  if (record.usage.cachedInputTokens !== undefined) {
    summary.cached = (summary.cached ?? 0) + record.usage.cachedInputTokens
  }
}

function finalize(summary: { modelCalls: number; inputTokens: number; outputTokens: number; totalTokens: number; usageMissing: number; durationMs: number; cached?: number }): UsageSummary {
  return {
    modelCalls: summary.modelCalls,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    totalTokens: summary.totalTokens,
    ...(summary.cached === undefined ? {} : { cachedInputTokens: summary.cached }),
    usageMissing: summary.usageMissing,
    durationMs: summary.durationMs,
  }
}

function groupBy<T extends string>(records: readonly UsageRecord[], key: (record: UsageRecord) => T): Record<string, UsageSummary> {
  const buckets = new Map<T, { modelCalls: number; inputTokens: number; outputTokens: number; totalTokens: number; usageMissing: number; durationMs: number; cached?: number }>()
  for (const record of records) {
    const bucketKey = key(record)
    const bucket = buckets.get(bucketKey) ?? (() => {
      const fresh = { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageMissing: 0, durationMs: 0 }
      buckets.set(bucketKey, fresh)
      return fresh
    })()
    addTo(bucket, record)
  }
  const out: Record<string, UsageSummary> = {}
  for (const [bucketKey, bucket] of buckets) out[bucketKey] = finalize(bucket)
  return out
}

/** The full ledger view over one run's request records. */
export function aggregateUsage(records: readonly UsageRecord[]): {
  readonly run: UsageSummary
  readonly byRole: Record<string, UsageSummary>
  readonly byModel: Record<string, UsageSummary>
  readonly bySession: Record<string, UsageSummary>
  readonly byStage: Record<string, UsageSummary>
  readonly byCase: Record<string, UsageSummary>
} {
  const run = finalize((() => {
    const bucket = { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, usageMissing: 0, durationMs: 0 }
    for (const record of records) addTo(bucket, record)
    return bucket
  })())
  return {
    run,
    byRole: groupBy(records, record => record.role),
    byModel: groupBy(records, record => `${record.execution?.requested.provider ?? '?'}/${record.execution?.requested.model ?? '?'}`),
    bySession: groupBy(records, record => record.sessionId),
    byStage: groupBy(records, record => record.stage),
    byCase: groupBy(records, record => record.caseId ?? '(unknown)'),
  }
}

