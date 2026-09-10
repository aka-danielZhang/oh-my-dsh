/**
 * Locale-profile formatters for the usage-stats page: token counts (zh 万/亿,
 * en K/M/B), axis-compact tokens, percentages, durations, and `yyyy-mm-dd`
 * date rendering. Every product-visible word lives here behind the profile —
 * chart components never hardcode units. Pure math and tables only, so both
 * node:test and jsdom specs exercise the same code.
 *
 * @module dsh-usage-stats/client/format
 */

/** The two formatter profiles the page distinguishes (zh-first). */
export type UsageStatsLang = 'zh' | 'en'

/** Map an arbitrary locale id (`zh`, `zh-TW`, `en-US`, …) onto a profile. */
export function resolveLang(localeId: string): UsageStatsLang {
  return localeId.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Full token count for summary values and tooltips.
 *
 * zh: `9,999` / `1.2万` / `3.5亿` — 万 below 10^8, 亿 above, promoting a
 * rounded `10000万` to `1亿`. en: `999` / `12.3K` / `1.2M` / `2.3B`.
 */
export function formatTokens(value: number, lang: UsageStatsLang): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 0) return formatTokens(-value, lang)
  if (lang === 'zh') {
    if (value < 10_000) return group(value)
    if (value < 100_000_000) {
      const wan = round1(value / 10_000)
      return wan < 10_000 ? `${trim(wan)}万` : `${trim(round1(wan / 10_000))}亿`
    }
    return `${trim(round1(value / 100_000_000))}亿`
  }
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const k = round1(value / 1_000)
    return k < 1_000 ? `${trim(k)}K` : `${trim(round1(k / 1_000))}M`
  }
  if (value < 1_000_000_000) {
    const m = round1(value / 1_000_000)
    return m < 1_000 ? `${trim(m)}M` : `${trim(round1(m / 1_000))}B`
  }
  return `${trim(round1(value / 1_000_000_000))}B`
}

/**
 * Axis-compact token count: same scales as {@link formatTokens} but tighter —
 * no digit grouping below the scale and at most one decimal — so long ticks
 * (`1000万`) never blow up the plot gutter.
 */
export function formatTokensAxis(value: number, lang: UsageStatsLang): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 0) return formatTokensAxis(-value, lang)
  if (lang === 'zh') {
    if (value < 10_000) return String(Math.round(value))
    if (value < 100_000_000) {
      const wan = round1(value / 10_000)
      return wan < 10_000 ? `${trim(wan)}万` : `${trim(round1(wan / 10_000))}亿`
    }
    return `${trim(round1(value / 100_000_000))}亿`
  }
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) {
    const k = round1(value / 1_000)
    return k < 1_000 ? `${trim(k)}K` : `${trim(round1(k / 1_000))}M`
  }
  if (value < 1_000_000_000) {
    const m = round1(value / 1_000_000)
    return m < 1_000 ? `${trim(m)}M` : `${trim(round1(m / 1_000))}B`
  }
  return `${trim(round1(value / 1_000_000_000))}B`
}

/** Grouped plain integer (12,345,678). */
export function group(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

/** Share (0..1) as a percentage with at most one decimal. */
export function formatShare(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return '0%'
  return `${trim(round1(share * 100))}%`
}

/** Apparent output rate, tokens per second. */
export function formatSpeed(tokensPerSec: number | null): string {
  if (tokensPerSec === null || !Number.isFinite(tokensPerSec)) return '—'
  return `${trim(round1(tokensPerSec))} tok/s`
}

/** Percentage for a 0..1 ratio, `—` when unknown. */
export function formatPercent(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return '—'
  return `${trim(round1(ratio * 100))}%`
}

/** Call duration in milliseconds as “X 分钟” / “1 小时 5 分” / “X min” / “1 h 5 min”. */
export function formatDuration(ms: number | null, lang: UsageStatsLang): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return lang === 'zh' ? '<1 分钟' : '<1 min'
  if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟` : `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (lang === 'zh') {
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** Relative age of the generatedAt stamp. */
export function formatRelative(ms: number, lang: UsageStatsLang, now = Date.now()): string {
  const delta = Math.max(0, now - ms)
  if (delta < 60_000) return lang === 'zh' ? '刚刚' : 'just now'
  if (delta < 3_600_000) {
    const n = Math.floor(delta / 60_000)
    return lang === 'zh' ? `${n} 分钟前` : `${n} min ago`
  }
  const h = Math.floor(delta / 3_600_000)
  return lang === 'zh' ? `${h} 小时前` : `${h} h ago`
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const

interface DateParts {
  year: number
  month: number
  day: number
}

/** Split a `yyyy-mm-dd` key into parts; invalid input yields undefined. */
function dateParts(dateKey: string): DateParts | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  return { year, month, day }
}

/** `9月6日` (zh) or `Sep 6` (en) from a `yyyy-mm-dd` key. */
export function formatDateShort(dateKey: string, lang: UsageStatsLang): string {
  const parts = dateParts(dateKey)
  if (parts === undefined) return dateKey
  if (lang === 'zh') return `${parts.month}月${parts.day}日`
  return `${MONTHS_SHORT[parts.month - 1]} ${parts.day}`
}

/**
 * Full date with the year — `2026年9月6日` / `September 6, 2026`. The year is
 * the whole point of this form (tooltip titles, long spans), so it always
 * renders even when it matches the current one.
 */
export function formatDateFull(dateKey: string, lang: UsageStatsLang): string {
  const parts = dateParts(dateKey)
  if (parts === undefined) return dateKey
  if (lang === 'zh') return `${parts.year}年${parts.month}月${parts.day}日`
  return `${MONTHS_LONG[parts.month - 1]} ${parts.day}, ${parts.year}`
}

/**
 * Month-and-day form that keeps the year only when it differs from the
 * current local year — used by the header meta line (`自 2025年9月8日 起`).
 */
export function formatDateWithImplicitYear(dateKey: string, lang: UsageStatsLang, now = new Date()): string {
  const parts = dateParts(dateKey)
  if (parts === undefined) return dateKey
  if (parts.year === now.getFullYear()) return formatDateShort(dateKey, lang)
  return formatDateFull(dateKey, lang)
}

/** Local-calendar `yyyy-mm-dd` of a Date — never the UTC `toISOString()` slip. */
export function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local `yyyy-mm-dd` of N days ago (0 = today). */
export function localDaysAgoKey(days: number, now = new Date()): string {
  const shifted = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)
  return localDateKey(shifted)
}

/** Day count between two `yyyy-mm-dd` keys (to − from); NaN when unparseable. */
export function daysBetween(from: string, to: string): number {
  const a = dateParts(from)
  const b = dateParts(to)
  if (a === undefined || b === undefined) return Number.NaN
  const utc = (p: DateParts): number => Date.UTC(p.year, p.month - 1, p.day)
  return Math.round((utc(b) - utc(a)) / 86_400_000)
}

/** One decimal, trailing zeros trimmed (`1.0` → `1`, `1.25` → `1.3`). */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function trim(value: number): string {
  return String(value)
}
