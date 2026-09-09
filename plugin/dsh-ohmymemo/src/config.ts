/**
 * Plugin row config validation. Hand-rolled like the blueprint: the built
 * bundle carries zero `@deepseek-ai/*` runtime imports, so no schemastery —
 * invalid values fail loud at mount.
 * @module dsh-ohmymemo/config
 */

/** Resolved plugin config after validation and defaulting. */
export interface OhMyMemoPluginConfig {
  /** Absolute store root override (tests/dev); default `$DSH_HOME/ohmymemo`. */
  root?: string
  /** Watch the store root for external edits. */
  watch: boolean
  /** Bounded wait for the cross-process writer lock, ms. */
  lockTimeoutMs: number
  /** Watcher event debounce, ms. */
  watchDebounceMs: number
}

const DEFAULTS = { watch: true, lockTimeoutMs: 5_000, watchDebounceMs: 120 }

/**
 * Validate an unknown composition config into a complete {@link OhMyMemoPluginConfig}.
 * @throws on any field with an invalid type or out-of-range value.
 */
export function validatePluginConfig(raw: unknown): OhMyMemoPluginConfig {
  if (raw === undefined || raw === null) return { ...DEFAULTS }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-ohmymemo: config must be an object')
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(key in DEFAULTS) && key !== 'root') throw new Error(`dsh-ohmymemo: unknown config field "${key}"`)
  }
  let root: string | undefined
  if (record.root !== undefined) {
    if (typeof record.root !== 'string' || record.root.length === 0 || !record.root.startsWith('/')) {
      throw new Error('dsh-ohmymemo: config "root" must be an absolute path')
    }
    root = record.root
  }
  const watch = readBoolean(record, 'watch')
  const lockTimeoutMs = readNumber(record, 'lockTimeoutMs', 100, 120_000)
  const watchDebounceMs = readNumber(record, 'watchDebounceMs', 10, 2_000)
  return { ...(root !== undefined ? { root } : {}), watch, lockTimeoutMs, watchDebounceMs }
}

function readBoolean(raw: Record<string, unknown>, key: keyof typeof DEFAULTS): boolean {
  const value = raw[key]
  if (value === undefined) return DEFAULTS[key] as boolean
  if (typeof value !== 'boolean') throw new Error(`dsh-ohmymemo: config "${key}" must be a boolean`)
  return value
}

function readNumber(raw: Record<string, unknown>, key: keyof typeof DEFAULTS, min: number, max: number): number {
  const value = raw[key]
  if (value === undefined) return DEFAULTS[key] as number
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`dsh-ohmymemo: config "${key}" must be an integer between ${min} and ${max}`)
  }
  return value
}
