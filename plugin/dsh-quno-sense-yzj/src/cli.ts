/**
 * yzj-cli process surface: spawn without a shell, JSON envelope parsing and
 * the two-layer failure classification (process exit code first, API
 * errorCode second).
 *
 * A logged-out CLI exits 3 with an `authentication` envelope and NO errorCode,
 * so an errorCode-only classifier would silently report "no new messages".
 *
 * @module dsh-quno-sense-yzj/cli
 */

/** CLI executable resolved through the sidecar PATH layering. */
export const CLI = 'yzj-cli'

/** Per-call deadline ceiling; a hung CLI must not stall the whole round. */
export const CALL_TIMEOUT_MS = 20_000

/** Raw result of one CLI invocation. */
export interface CliRun {
  /** Exit code, or null when the process never started. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** Spawn failure (`ENOENT` when the CLI is not installed) or `timeout`. */
  readonly failure: string | null
}

/** Injectable CLI runner (tests substitute it). */
export type CliExec = (args: readonly string[], signal: AbortSignal | undefined, timeoutMs: number) => Promise<CliRun>

/** Health-facing failure classification. */
export interface CliFailure {
  readonly state: 'auth-required' | 'unavailable' | 'degraded' | 'rate-limited'
  readonly code: string
  readonly detail: string
}

/** Raised inside a round so the caller can report one classified health state. */
export class CliFailureError extends Error {
  readonly failure: CliFailure

  constructor(failure: CliFailure) {
    super(failure.detail)
    this.name = 'CliFailureError'
    this.failure = failure
  }
}

/** Shape of the CLI's JSON envelope. */
export interface Envelope {
  readonly success: boolean
  readonly identity?: string
  readonly data?: unknown
  readonly error?: {
    readonly type?: string
    readonly subtype?: string
    readonly message?: string
    readonly hint?: string
    readonly code?: string | number
  }
}

/** Parse the CLI envelope from a stream (stdout on success, stderr on failure). */
export function parseEnvelope(text: string): Envelope | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  const start = trimmed.indexOf('{')
  if (start < 0) return null
  try {
    const parsed = JSON.parse(trimmed.slice(start)) as Envelope
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

/** The error object of a failure envelope printed on stderr. */
export function parseErrorEnvelope(stderr: string): NonNullable<Envelope['error']> | null {
  const envelope = parseEnvelope(stderr)
  return envelope?.error ?? null
}

/**
 * Classify one CLI run. Process-level signals win; exit 1 refines by API
 * errorCode. An explicit rate limit is its own health state with backoff.
 */
export function classifyRun(run: CliRun): CliFailure | null {
  if (run.failure !== null) {
    const detail =
      run.failure === 'ENOENT'
        ? `未找到 ${CLI}（宿主机未安装，或 PATH 未就绪）`
        : `调用 ${CLI} 失败：${run.failure}`
    return { state: 'unavailable', code: run.failure === 'ENOENT' ? 'cli-missing' : `cli-${run.failure}`, detail }
  }
  if (run.code === 0) {
    const envelope = parseEnvelope(run.stdout)
    if (envelope !== null && envelope.success === false) {
      return { state: 'degraded', code: 'exit0-error', detail: 'CLI 以 exit 0 返回了错误信封' }
    }
    return null
  }
  const error = parseErrorEnvelope(run.stderr)
  const message = error?.message ?? run.stderr.trim().slice(0, 300)
  const hint = error?.hint ?? ''
  const detail = hint === '' ? message : `${message}（${hint}）`
  if (run.code === 1) {
    const code = String(error?.code ?? '')
    if (code === '10000400' || code === '93001' || code === '43001') {
      return { state: 'auth-required', code: `api-${code}`, detail }
    }
    if (code === '429' || /rate\s*limit|限流/i.test(`${code} ${message}`)) {
      return { state: 'rate-limited', code: 'api-rate-limited', detail }
    }
    return { state: 'degraded', code: 'api-error', detail }
  }
  if (run.code === 2) {
    return { state: 'degraded', code: 'cli-usage', detail: `命令行参数错误（实现 bug）：${message}` }
  }
  if (run.code === 3) {
    const subtype = error?.subtype ?? 'authentication'
    return { state: 'auth-required', code: `auth-${subtype}`, detail }
  }
  if (run.code === 4) {
    if (/\b429\b|rate\s*limit|限流/i.test(`${error?.code ?? ''} ${message}`)) {
      return { state: 'rate-limited', code: 'network-rate-limited', detail }
    }
    return { state: 'unavailable', code: 'network', detail }
  }
  if (run.code === 5) {
    return { state: 'degraded', code: 'cli-internal', detail: `CLI 内部错误：${message}` }
  }
  return { state: 'degraded', code: `exit-${String(run.code ?? 'null')}`, detail }
}

/** Whether the envelope says the page has more records. */
export function hasMore(envelope: Envelope | null): boolean {
  if (envelope === null) return false
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return false
  return (data as Record<string, unknown>)['more'] === true
}

/** The bound identity of the logged-in CLI profile, as `whoami` reports it. */
export interface YzjIdentity {
  readonly openId: string
  readonly orgId: string | null
  readonly name: string | null
}

function stringField(data: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = data[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return null
}

/**
 * Extract the identity from a successful `whoami` envelope. `null` when the
 * shape is not understood — that is a protocol failure, never "logged out"
 * (a logged-out CLI never reaches here: it exits non-zero).
 */
export function parseIdentity(envelope: Envelope | null): YzjIdentity | null {
  if (envelope === null || envelope.success !== true) return null
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const openId = stringField(record, ['openId', 'openid', 'userId'])
  if (openId === null) return null
  return {
    openId,
    orgId: stringField(record, ['orgId', 'orgid', 'org']),
    name: stringField(record, ['name', 'userName', 'displayName']),
  }
}

/** Read `data.list` from an envelope; `null` when the shape violates the contract. */
export function readList(envelope: Envelope | null): readonly unknown[] | null {
  if (envelope === null || envelope.success !== true) return null
  const data = envelope.data
  if (typeof data !== 'object' || data === null) return null
  const list = (data as Record<string, unknown>)['list']
  return Array.isArray(list) ? list : null
}
