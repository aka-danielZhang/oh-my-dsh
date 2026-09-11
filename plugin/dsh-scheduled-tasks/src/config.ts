/**
 * Row-config validation for the scheduler row (dsh-usage-stats posture:
 * hand-rolled and fail loud at mount — the runtime has no schemastery).
 *
 * Everything the design §8.2 names as "belongs in plugin config" lives here:
 * concurrency cap, catch-up window, task/instruction caps, run timeout, and
 * the cross-process lease wait.
 * @module dsh-scheduled-tasks/config
 */

/** Resolved scheduler config after validation and defaulting. */
export interface ScheduledTasksConfig {
  /** Global concurrent agent-run cap across all tasks. */
  maxConcurrentRuns: number
  /** How far back a missed boundary may still be caught up. */
  catchUpWindowMs: number
  /** Bounded wait for the per-task cross-process lease. */
  leaseTimeoutMs: number
  /** Hard cap on one run's Agent lifetime before it is cancelled. */
  runTimeoutMs: number
  /** Abort the lease wait and skip when another host holds the task. */
  claimTimeoutMs: number
}

const DEFAULTS: ScheduledTasksConfig = {
  maxConcurrentRuns: 2,
  catchUpWindowMs: 12 * 3_600_000,
  leaseTimeoutMs: 5_000,
  runTimeoutMs: 2 * 3_600_000,
  claimTimeoutMs: 5_000,
}

function readNumber(
  raw: Record<string, unknown>,
  key: keyof ScheduledTasksConfig,
  min: number,
  max: number,
): number {
  const value = raw[key]
  if (value === undefined) return DEFAULTS[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`dsh-scheduled-tasks: config "${key}" must be an integer between ${min} and ${max}`)
  }
  return value
}

/** Validate a composition row's `config` block, failing loud on nonsense. */
export function validateScheduledTasksConfig(raw: unknown): ScheduledTasksConfig {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-scheduled-tasks: config must be an object')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULTS)) throw new Error(`dsh-scheduled-tasks: unknown config field "${key}"`)
  }
  return {
    maxConcurrentRuns: readNumber(record, 'maxConcurrentRuns', 1, 8),
    catchUpWindowMs: readNumber(record, 'catchUpWindowMs', 60_000, 7 * 24 * 3_600_000),
    leaseTimeoutMs: readNumber(record, 'leaseTimeoutMs', 500, 120_000),
    runTimeoutMs: readNumber(record, 'runTimeoutMs', 60_000, 24 * 3_600_000),
    claimTimeoutMs: readNumber(record, 'claimTimeoutMs', 500, 120_000),
  }
}
