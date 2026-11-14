/**
 * Redaction for the evidence bundle: credentials and provider-private headers
 * must never land in traces, model recordings or reports.
 *
 * The fixtures are synthetic, so the only realistic leak paths are live API
 * keys read from the environment and authorization headers. Both are scrubbed
 * here before anything is written to disk.
 *
 * @module dsh-quno/evals/redact
 */

/** Patterns that look like credentials inside arbitrary text. */
const SECRET_PATTERNS: readonly RegExp[] = [
  // Word-boundary anchor: a bare `sk-` also matches inside words like
  // `task-quiet-success` (case ids trip the scan otherwise).
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Credential assignments require an explicit [:=] separator — a space after
  // the word is prose ("authorization status") and must not match (found by
  // round-12: the model's English reply tripped the loose separator class).
  /api[-_]?key["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi,
  /authorization["']?\s*[:=]\s*["']?[^\s"']{8,}/gi,
]

/** Environment-sourced secret values collected once per process. */
const envSecrets: readonly string[] = Object.entries(process.env)
  .filter(([key, value]) => typeof value === 'string' && value.length >= 8 && /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))
  .map(([, value]) => value as string)

/** Replace every credential-looking substring with a stable placeholder. */
export function redactText(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]')
  for (const secret of envSecrets) {
    if (out.includes(secret)) out = out.replaceAll(secret, '[REDACTED]')
  }
  return out
}

/** Deep redaction of JSON-serializable values. */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[deep]'
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(entry => redactJson(entry, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[redactText(key)] = redactJson(entry, depth + 1)
    }
    return out
  }
  return value
}

/** True when a string still contains credential-looking material. */
export function looksSensitive(text: string): boolean {
  return SECRET_PATTERNS.some(pattern => pattern.test(text)) || envSecrets.some(secret => text.includes(secret))
}
