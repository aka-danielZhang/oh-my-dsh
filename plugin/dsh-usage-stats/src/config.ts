/**
 * Plugin config validation. Hand-rolled on purpose: the built bundle must
 * carry zero `@deepseek-ai/*` runtime imports (see tsdown.config.ts), so no
 * schemastery — invalid values fail loud at mount, mirroring the repo's
 * "config missing/invalid throws at the earliest point" convention
 * (dsh-fs-observation-log's config posture).
 * @module dsh-usage-stats/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Resolved plugin config after validation and defaulting. */
export interface UsageStatsConfig {
  /** Days a daily records file survives; aggregates stay forever. */
  retentionDays: number
  /** Debounce window for state/aggregates flushes, milliseconds. */
  flushIntervalMs: number
  /** Consecutive disk write failures before the disk side disables itself. */
  maxWriteFailures: number
}

const DEFAULTS: UsageStatsConfig = {
  retentionDays: 400,
  flushIntervalMs: 2_000,
  maxWriteFailures: 5,
}

function readNumber(
  raw: Record<string, unknown>,
  key: keyof UsageStatsConfig,
  min: number,
  max: number,
): number {
  const value = raw[key]
  if (value === undefined) return DEFAULTS[key] as number
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`dsh-usage-stats: config "${key}" must be an integer between ${min} and ${max}`)
  }
  return value
}

/**
 * Validate an unknown composition config into a complete {@link UsageStatsConfig}.
 * @param raw - the config object from the cordis row (or undefined/null).
 * @returns the resolved config with defaults filled in.
 * @throws on any field with an invalid type, out-of-range value, or unknown key.
 */
export function validateConfig(raw: unknown): UsageStatsConfig {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-usage-stats: config must be an object')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-usage-stats: unknown config field "${key}"`)
  }
  return {
    retentionDays: readNumber(record, 'retentionDays', 7, 3_650),
    flushIntervalMs: readNumber(record, 'flushIntervalMs', 250, 60_000),
    maxWriteFailures: readNumber(record, 'maxWriteFailures', 1, 1_000),
  }
}

/**
 * The store directory: `<DSH_HOME>/usage-stats` (DSH_HOME mirrors the
 * harness convention, like dsh-fs-observation-log's sidecar root).
 * @param envHome - `process.env.DSH_HOME`.
 * @param home - `os.homedir()` (injectable for tests).
 */
export function usageStatsDir(envHome: string | undefined, home: string): string {
  return join(envHome !== undefined && envHome.length > 0 ? envHome : join(home, '.dsh'), 'usage-stats')
}
