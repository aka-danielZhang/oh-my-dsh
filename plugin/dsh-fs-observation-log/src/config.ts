/**
 * Plugin config validation. Hand-rolled on purpose: the built bundle must
 * carry zero `@deepseek-ai/*` runtime imports (see tsdown.config.ts), so no
 * schemastery — invalid values fail loud at mount, mirroring the repo's
 * "config missing/invalid throws at the earliest point" convention.
 * @module dsh-fs-observation-log/config
 */

/** Resolved plugin config after validation and defaulting. */
export interface ObservationLogConfig {
  /** Per-session evidence cap; on overflow the file is rewritten keeping the newest half. */
  maxEntriesPerSession: number
  /** Consecutive sidecar write failures before the store disables itself (fail-soft). */
  maxWriteFailures: number
}

/** Private sentinel for "no config row supplied at all". */
const DEFAULTS: ObservationLogConfig = {
  maxEntriesPerSession: 200,
  maxWriteFailures: 5,
}

function readNumber(raw: Record<string, unknown>, key: keyof ObservationLogConfig, min: number, max: number): number {
  const value = raw[key]
  if (value === undefined) return DEFAULTS[key] as number
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`dsh-fs-observation-log: config "${key}" must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Validate an unknown composition config into a complete {@link ObservationLogConfig}.
 * @param raw - the config object from the cordis row (or undefined/null).
 * @returns the resolved config with defaults filled in.
 * @throws on any field with an invalid type or out-of-range value — including
 *   the retired `inheritFork`/`maxLineageDepth` fields, so a stale preset that
 *   still passes them fails loud instead of silently keeping unsafe healing.
 */
export function validateConfig(raw: unknown): ObservationLogConfig {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-fs-observation-log: config must be an object')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-fs-observation-log: unknown config field "${key}"`)
  }
  return {
    maxEntriesPerSession: readNumber(record, 'maxEntriesPerSession', 2, 100_000),
    maxWriteFailures: readNumber(record, 'maxWriteFailures', 1, 1000),
  }
}
