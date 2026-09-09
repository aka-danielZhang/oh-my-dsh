/**
 * Number and duration formatting for the usage-stats page. All copy lives in
 * ./locales.ts; this module is pure math over the formatter's language.
 *
 * @module dsh-usage-stats/client/format
 */

import type { UsageStatsLocaleKey } from './locales.ts'

/** Translator bound by the page (replaces `{placeholder}` segments). */
export type Translate = (key: UsageStatsLocaleKey, params?: Record<string, string | number>) => string

/**
 * Compact token count: Chinese uses 万 (12,345 → 1.2万); the Latin profile
 * uses K/M (12,345 → 12.3K).
 */
export function formatTokens(value: number, t: Translate, compact: boolean): string {
  if (!Number.isFinite(value)) return '—'
  if (compact && value < 1_000) return String(Math.round(value))
  if (compact && value < 10_000) return trim(value / 1_000) + t('format.thousand')
  if (value < 10_000) return group(value)
  if (value < 100_000_000) return trim(value / 10_000) + t('format.tenThousand')
  if (value < 1_000_000_000) return trim(value / 100_000_000) + t('format.tenThousand')
  return trim(value / 1_000_000_000) + t('format.million')
}

/** Grouped plain integer (12,345,678). */
export function group(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** At most one decimal, trailing zeros trimmed. */
function trim(value: number): string {
  return (Math.round(value * 10) / 10).toString()
}

/** Duration in milliseconds as “X 分钟” / “X 小时 Y 分”. */
export function formatDuration(ms: number, t: Translate): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `<1 ${t('format.unit.minute')}`
  if (minutes < 60) return `${minutes} ${t('format.unit.minute')}`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? `${hours} ${t('format.unit.hour')}`
    : `${hours} ${t('format.unit.hour')} ${rest} ${t('format.unit.minute')}`
}

/** Relative age of the generatedAt stamp. */
export function formatRelative(ms: number, t: Translate, now = Date.now()): string {
  const delta = Math.max(0, now - ms)
  if (delta < 60_000) return t('format.justNow')
  if (delta < 3_600_000) return t('format.minutesAgo', { n: Math.floor(delta / 60_000) })
  return t('format.hoursAgo', { n: Math.floor(delta / 3_600_000) })
}

/** Share as a percentage with one decimal. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  return `${trim(share * 100)}%`
}
