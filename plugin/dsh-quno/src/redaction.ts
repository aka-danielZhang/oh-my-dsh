/**
 * Credential redaction for everything a Worker session may surface (design
 * v2 §6.2: 凭据/环境变量不进检查视图; §9.4: tool data stays public ONLY
 * within the tool's declared face). Pure functions, shared by the client
 * tool cards and any Host-side summarizer.
 *
 * Rules:
 * - a denylist of key names drops the whole subtree at any depth;
 * - credential-shaped assignments inside free text (`token=…`,
 *   `Authorization: …`) are scrubbed to `…=<已脱敏>`;
 * - every projection is length-bounded and flagged when clipped.
 *
 * @module dsh-quno/redaction
 */

/** Keys whose values never surface, at any depth. */
const DENIED_KEY = /token|secret|password|passwd|credential|apikey|api[_-]?key|authorization|cookie|env(ironment)?|private[_-]?key/i

/** Credential-shaped assignments inside free text (`token=…`, `Authorization: …`). */
const CREDENTIAL_TEXT = /([\w.-]*(?:token|secret|password|passwd|apikey|api[_-]?key|authorization|credentials?|cookie)[\w.-]*)(\s*[:=]\s*)(\S+)/gi

/** Summary bounds for the tool cards. */
export const ARGS_CLIP = 400
export const RESULT_CLIP = 600

/**
 * Scrub credential-shaped assignments out of free text.
 * @param text - arbitrary text (arguments, results, worker prose).
 * @returns the scrubbed text; a credential echoed by a tool never surfaces.
 */
export function scrubText(text: string): string {
  return text.replace(CREDENTIAL_TEXT, (_match, key: string) => `${key}=<已脱敏>`)
}

/**
 * Deep-copy a JSON value dropping every denied key's subtree.
 * @param value - parsed JSON of any shape.
 * @returns the redacted copy.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (DENIED_KEY.test(key)) continue
      out[key] = redact(child)
    }
    return out
  }
  return value
}

/**
 * Parse the raw arguments JSON string.
 * @param raw - argument text as recorded on the call.
 * @returns the parsed value, or `null` when absent or unparsable.
 */
export function parseArgs(raw: string | null | undefined): unknown {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/**
 * Bounded, denylist-redacted summary of one raw tool-arguments string.
 * @param raw - argument text as recorded on the call.
 * @param limit - hard length bound.
 * @returns the redacted summary, or `null` without parsable arguments.
 */
export function redactedArgsSummary(raw: string | null | undefined, limit: number = ARGS_CLIP): string | null {
  const parsed = parseArgs(raw)
  if (parsed === null) return null
  return clip(scrubText(JSON.stringify(redact(parsed)) ?? ''), limit)
}

/**
 * Bounded, scrubbed summary of free text (result blocks, worker prose).
 * @param text - the raw text.
 * @param limit - hard length bound.
 * @returns the scrubbed, clipped text.
 */
export function redactedTextSummary(text: string, limit: number = RESULT_CLIP): string {
  return clip(scrubText(text), limit)
}

/**
 * Whether the redacted form of `raw` exceeds `limit` (truncation flag).
 * @param raw - argument text as recorded on the call.
 * @param limit - hard length bound.
 * @returns true when the summary was clipped.
 */
export function isArgsTruncated(raw: string | null | undefined, limit: number = ARGS_CLIP): boolean {
  const parsed = parseArgs(raw)
  if (parsed === null) return false
  return (JSON.stringify(redact(parsed)) ?? '').length > limit
}

/** Clip text to `limit` with an ellipsis marker. */
export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
