/**
 * Pure presentation helpers for the Quno browser surface.
 *
 * @module dsh-quno/client/format
 */

/** Format an epoch instant as a compact local date-time. */
export function formatClock(value: number | null): string {
  if (value === null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Parse a JSON object from a textarea. */
export function parseJsonObject(text: string): { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: '配置必须是 JSON 对象' }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, error: `JSON 解析失败：${(error as Error).message}` }
  }
}

/** Map a reported health state (plus staleness) to a UI tone. */
export function toneOf(health: string, stale: boolean): 'ok' | 'warn' | 'error' | 'idle' {
  if (health === 'healthy' && !stale) return 'ok'
  if (health === 'healthy' && stale) return 'warn'
  if (health === 'degraded' || health === 'rate-limited') return 'warn'
  if (health === 'auth-required' || health === 'unavailable') return 'error'
  return 'idle'
}

/** Truncate a text block for compact rows. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}
