/**
 * Wire and storage value types shared by the Host collector/gateway and the
 * browser settings page. Everything crossing the Typert Remote seam is plain
 * JSON; the client never folds raw session events.
 *
 * @module dsh-usage-stats/types
 */

/** One persisted usage record (one line in a daily records JSONL file). */
export interface UsageRecord {
  /** Storage format version; readers skip unknown versions. */
  v: 1
  /** Event timestamp, Unix epoch milliseconds. */
  t: number
  /** Owning session id. */
  sid: string
  /** Assistant message id — the cross-session dedup key (fork seeds replay). */
  mid: string
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id. */
  model: string
  /** Uncached input tokens. */
  in: number
  /** Output tokens. */
  out: number
  /** Cache-read tokens, when reported. */
  cr?: number
  /** Cache-write tokens, when reported. */
  cw?: number
  /** Reasoning tokens, when reported (recorded, not counted in totals for v1). */
  rt?: number
  /** The owning step's start time (epoch ms), when seen — enables call-duration metrics. */
  sd?: number
}

/** Billed total of one record: in + cr + cw + out (disjoint accounting). */
export function recordTotal(record: UsageRecord): number {
  return record.in + record.out + (record.cr ?? 0) + (record.cw ?? 0)
}

/** The five headline cards plus supporting context. */
export interface UsageStatsSummary {
  /** Σ recordTotal over all retained records. */
  totalTokens: number
  /** Largest single-call total. */
  peakTokens: number
  /** Widest first→last usage-event span of one session, milliseconds. */
  longestChatMs: number
  /** Consecutive active days ending today or yesterday (local timezone), else 0. */
  currentStreakDays: number
  /** Longest run of consecutive active days ever retained. */
  longestStreakDays: number
  /** How many distinct local days have at least one record. */
  activeDays: number
  /** Earliest retained local date, `yyyy-mm-dd`; null when empty. */
  firstDate: string | null
  /** Latest retained local date, `yyyy-mm-dd`; null when empty. */
  lastDate: string | null
  /** Apparent output rate: Σ output tokens ÷ Σ call duration (step start → reply), tokens/s. */
  speedTokensPerSec: number | null
  /** Mean call duration (step start → reply), milliseconds. */
  avgCallMs: number | null
  /** Mean billed-input cache-hit share (cr ÷ (in+cr+cw)), 0..1. */
  cacheHitRate: number | null
  /** Counted calls over all retained records. */
  calls: number
  /** Snapshot generation time, epoch milliseconds. */
  generatedAt: number
}

/** Per-model token series for one day of the trend chart. */
export interface UsageStatsDailyModelEntry {
  /** Model key, `provider/model`. */
  model: string
  tokens: number
}

/** One day of the trend series. */
export interface UsageStatsDailyEntry {
  /** Local date, `yyyy-mm-dd`. */
  date: string
  total: number
  byModel: UsageStatsDailyModelEntry[]
}

/** Trend chart payload: one entry per day in the requested range, oldest first. */
export interface UsageStatsDaily {
  days: UsageStatsDailyEntry[]
}

/** Heatmap cell: one local day (daily/cumulative) or one week (weekly, `date` = Monday). */
export interface UsageStatsActivityCell {
  /** Local date key of the cell (`yyyy-mm-dd`). */
  date: string
  /** Cell value: day total, week total, or running cumulative total. */
  total: number
  /** Counted calls behind the cell (0 for cumulative). */
  calls: number
  /** Color bucket 0..4 (0 = no data); derived from the range max. */
  level: number
}

/** Heatmap payload over the trailing ~52 weeks. */
export interface UsageStatsActivity {
  mode: 'daily' | 'weekly' | 'cumulative'
  cells: UsageStatsActivityCell[]
  /** Largest cell total in the payload (drives legend/tooltips). */
  maxTotal: number
}

/** One share slice of the donut chart. */
export interface UsageStatsBreakdownSlice {
  /** Grouping key: provider id, or `provider/model`. */
  key: string
  /** Display label: provider display name, or bare model id. */
  label: string
  tokens: number
  /** Share of the range total, 0..1. */
  share: number
}

/** Donut payload grouped by provider or model over the requested range. */
export interface UsageStatsBreakdown {
  dim: 'model' | 'provider'
  /** Range total the shares are computed against. */
  total: number
  /** Slices sorted by tokens, descending. */
  slices: UsageStatsBreakdownSlice[]
}
