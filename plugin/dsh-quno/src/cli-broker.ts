/**
 * The structured CLI capability broker: the ONLY path from a Worker to an
 * external CLI.
 *
 * Plugins register a capability (an id, a closed operation table and one
 * executor), never a shell command. The broker owns every decision the model
 * must not make:
 *
 * - which capability/operation may run (closed tables, `access: 'read'` only);
 * - which arguments are legal (declared params; unknown keys are refused, so
 *   a payload can never smuggle `--profile`, `argv`, or another command);
 * - which configured target answers (collector instances of the provider's
 *   type — the user's configuration IS the authorization; a paused instance
 *   keeps its account available, a disabled or removed one does not);
 * - whether the Ticket's Mandate granted it at accept time;
 * - how long and how loud one call may be (timeout, output cap, concurrency).
 *
 * The executable and its argv are built by the adapter; no shell is involved
 * anywhere. Registration is a Cordis effect like every other Quno table, so an
 * unloaded plugin takes its capabilities with it.
 *
 * @module dsh-quno/cli-broker
 */

import { QunoStateError } from './core/model.ts'
import type { MandateCli } from './core/model.ts'
import type { CollectorInstanceRecord } from './types.ts'

/** One declared parameter of one operation. */
export interface CliParamSpec {
  readonly name: string
  readonly kind: 'integer' | 'string' | 'boolean'
  readonly required?: boolean
  readonly min?: number
  readonly max?: number
  readonly maxChars?: number
  readonly description: string
}

/**
 * One declared operation. `access: 'command'` is declarable so a provider can
 * describe its future write surface, but v1 never exposes it to a Worker.
 */
export interface CliOperationSpec {
  readonly access: 'read' | 'command'
  readonly summary: string
  readonly params: readonly CliParamSpec[]
}

/** One user-configured target: a CollectorInstance of the provider's type. */
export interface CliTarget {
  readonly id: string
  readonly label: string
  readonly health: string
  readonly config: Readonly<Record<string, unknown>>
}

/** One authorized, validated call handed to a provider. */
export interface CliCallRequest {
  readonly capability: string
  readonly target: CliTarget
  readonly operation: string
  readonly params: Readonly<Record<string, unknown>>
  readonly signal: AbortSignal
  readonly timeoutMs: number
  /** Hard ceiling for the serialized result; exceeding it is a provider bug. */
  readonly maxOutputChars: number
}

/**
 * The provider's honest result. Failures are data, not exceptions: the broker
 * turns them into a model-visible refusal carrying the provider's own code, so
 * `auth-required` and `rate-limited` stay distinguishable.
 */
export type CliCallOutcome =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable?: boolean }

/** One capability as a plugin declares it. */
export interface CliCapabilityProvider {
  /** Stable capability id the model names (`yzj`). */
  readonly capability: string
  /** Human label for discovery and refusals. */
  readonly title: string
  /** The collector type whose configured instances are this capability's targets. */
  readonly collectorType: string
  readonly operations: Readonly<Record<string, CliOperationSpec>>
  /** Per-call deadline ceiling; the broker caps it at {@link MAX_CALL_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Calls allowed in flight at once; default {@link DEFAULT_MAX_CONCURRENT}. */
  readonly maxConcurrent?: number
  /** Result ceiling; default {@link DEFAULT_MAX_OUTPUT_CHARS}. */
  readonly maxOutputChars?: number
  readonly execute: (request: CliCallRequest) => Promise<CliCallOutcome>
}

/** A target as discovery advertises it. */
export interface CliTargetView {
  readonly id: string
  readonly label: string
  readonly health: string
}

/** An operation as discovery advertises it. */
export interface CliParamView {
  readonly name: string
  readonly kind: 'integer' | 'string' | 'boolean'
  readonly required: boolean
  readonly description: string
  readonly min?: number
  readonly max?: number
  readonly maxChars?: number
}

/** An operation as discovery advertises it. */
export interface CliOperationView {
  readonly operation: string
  readonly access: 'read'
  readonly summary: string
  readonly params: readonly CliParamView[]
}

/** One capability as `quno_read.cliCapabilities` advertises it. */
export interface CliCapabilityView {
  readonly capability: string
  readonly title: string
  readonly targets: readonly CliTargetView[]
  readonly operations: readonly CliOperationView[]
}

/** Default per-call deadline. */
export const DEFAULT_CALL_TIMEOUT_MS = 20_000
/** Absolute ceiling a provider cannot raise. */
export const MAX_CALL_TIMEOUT_MS = 60_000
/** Default in-flight ceiling per capability. */
export const DEFAULT_MAX_CONCURRENT = 2
/** Default serialized-result ceiling. */
export const DEFAULT_MAX_OUTPUT_CHARS = 24_000

/** Dependencies of the broker. */
export interface CliBrokerDeps {
  /** Configured instances of this Quno (the authorization surface). */
  readonly listInstances: () => readonly CollectorInstanceRecord[]
}

/** One call as a Worker tool asks for it. */
export interface CliCallInput {
  readonly capability: string
  readonly operation: string
  readonly params: unknown
  readonly target?: string
  /** The Mandate snapshot of the calling Ticket; absent authorizes nothing. */
  readonly grant?: MandateCli
}

/** The resolved call the broker will execute. */
export interface CliCallResult {
  readonly capability: string
  readonly operation: string
  readonly target: CliTargetView
  readonly data: unknown
}

/** Why one call was refused before any process started. */
export type CliRefusalCode =
  | 'unknown-capability'
  | 'no-target'
  | 'ambiguous-target'
  | 'unknown-target'
  | 'unknown-operation'
  | 'operation-not-allowed'
  | 'invalid-params'
  | 'not-authorized'
  | 'capability-busy'
  | 'output-too-large'

/** Refuse before execution; the message is written to be actionable. */
function refuse(code: CliRefusalCode, message: string): never {
  throw new QunoStateError(code, message)
}

/** The process-wide capability table. One per Quno Host. */
export class CliCapabilityBroker {
  private readonly providers = new Map<string, CliCapabilityProvider>()
  private readonly inFlight = new Map<string, number>()

  constructor(private readonly deps: CliBrokerDeps) {}

  /**
   * Register one capability. A second registration of the same id is a bug
   * (two plugins claiming one surface), so it fails loudly instead of
   * silently replacing the first.
   */
  register(provider: CliCapabilityProvider): () => void {
    if (this.providers.has(provider.capability)) {
      throw new Error(`dsh-quno: CLI capability ${provider.capability} is already registered`)
    }
    this.providers.set(provider.capability, provider)
    return () => {
      if (this.providers.get(provider.capability) === provider) this.providers.delete(provider.capability)
    }
  }

  /** The discovery surface: only capabilities with at least one configured target. */
  describe(): readonly CliCapabilityView[] {
    const views: CliCapabilityView[] = []
    for (const provider of this.providers.values()) {
      const targets = this.targetsOf(provider)
      if (targets.length === 0) continue
      views.push({
        capability: provider.capability,
        title: provider.title,
        targets: targets.map(target => ({ id: target.id, label: target.label, health: target.health })),
        operations: Object.entries(provider.operations)
          .filter(([, spec]) => spec.access === 'read')
          .map(([operation, spec]) => ({
            operation,
            access: 'read' as const,
            summary: spec.summary,
            params: spec.params.map(param => ({
              name: param.name,
              kind: param.kind,
              required: param.required === true,
              description: param.description,
              ...(param.min === undefined ? {} : { min: param.min }),
              ...(param.max === undefined ? {} : { max: param.max }),
              ...(param.maxChars === undefined ? {} : { maxChars: param.maxChars }),
            })),
          })),
      })
    }
    return views
  }

  /**
   * The grant a newly accepted Ticket receives: every capability that has a
   * configured target right now, narrowed to its declared read operations.
   */
  grantSnapshot(): MandateCli {
    const capabilities: string[] = []
    const operations: Record<string, readonly string[]> = {}
    for (const provider of this.providers.values()) {
      if (this.targetsOf(provider).length === 0) continue
      const reads = Object.entries(provider.operations)
        .filter(([, spec]) => spec.access === 'read')
        .map(([operation]) => operation)
      if (reads.length === 0) continue
      capabilities.push(provider.capability)
      operations[provider.capability] = reads
    }
    return { capabilities, operations }
  }

  /** One capability's view, for refusal directories. */
  viewOf(capability: string): CliCapabilityView | undefined {
    return this.describe().find(view => view.capability === capability)
  }

  /**
   * Authorize, validate and execute one call. Every refusal throws a
   * `QunoStateError` whose code names the problem; nothing is spawned before
   * authorization, target resolution, membership and parameter checks pass.
   */
  async call(input: CliCallInput): Promise<CliCallResult> {
    const provider = this.providers.get(input.capability)
    if (provider === undefined) {
      refuse('unknown-capability', `没有注册名为 ${input.capability} 的 CLI 能力。${this.directory()}`)
    }
    const spec = provider.operations[input.operation]
    if (spec === undefined) {
      refuse(
        'unknown-operation',
        `${provider.title}（${provider.capability}）没有 operation ${input.operation}。可用：${this.operationDirectory(provider)}`,
      )
    }
    if (spec.access !== 'read') {
      refuse(
        'operation-not-allowed',
        `${input.operation} 属于写操作（access=${spec.access}），Worker 只能执行声明的只读操作`,
      )
    }
    const granted = input.grant?.capabilities.includes(provider.capability) === true
      && input.grant.operations[provider.capability]?.includes(input.operation) === true
    if (!granted) {
      refuse(
        'not-authorized',
        `本任务的 Mandate 未授权 ${provider.capability}/${input.operation}；如需该读取，请让主对话重新委派任务`,
      )
    }
    const target = this.resolveTarget(provider, input.target)
    const params = validateParams(spec, input.params, `${provider.capability}/${input.operation}`)
    const concurrency = provider.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    const running = this.inFlight.get(provider.capability) ?? 0
    if (running >= concurrency) {
      refuse('capability-busy', `${provider.title} 正在处理 ${String(running)} 个并发调用（上限 ${String(concurrency)}）；请稍后重试或改用其它能力`)
    }
    const timeoutMs = Math.min(provider.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, MAX_CALL_TIMEOUT_MS)
    const maxOutputChars = provider.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    const signal = AbortSignal.timeout(timeoutMs)
    this.inFlight.set(provider.capability, running + 1)
    try {
      let outcome: CliCallOutcome
      try {
        // The deadline is enforced here, not delegated to the provider: a
        // provider that ignores its signal must not hold the Worker turn open.
        outcome = await Promise.race([
          provider.execute({
            capability: provider.capability,
            target,
            operation: input.operation,
            params,
            signal,
            timeoutMs,
            maxOutputChars,
          }),
          deadline(
            `${provider.title} 的 ${input.operation}`,
            timeoutMs,
            signal,
          ),
        ])
      } catch (error) {
        if (error instanceof QunoStateError) throw error
        const message = error instanceof Error ? error.message : String(error)
        const timedOut = signal.aborted
        throw new QunoStateError(
          timedOut ? 'timeout' : 'provider-failed',
          timedOut
            ? `${provider.title} 的 ${input.operation} 超过 ${String(timeoutMs)}ms 未返回`
            : `${provider.title} 的 ${input.operation} 执行失败：${message}`,
        )
      }
      if (!outcome.ok) {
        throw new QunoStateError(
          outcome.code,
          `${provider.title} ${input.operation} 失败：${outcome.message}${outcome.retryable === true ? '（可稍后重试）' : ''}`,
        )
      }
      const serialized = serializeLength(outcome.data)
      if (serialized > maxOutputChars) {
        refuse(
          'output-too-large',
          `${provider.title} ${input.operation} 的结果约 ${String(serialized)} 字符，超过上限 ${String(maxOutputChars)}；请缩小 limit/范围后重试`,
        )
      }
      return {
        capability: provider.capability,
        operation: input.operation,
        target: { id: target.id, label: target.label, health: target.health },
        data: outcome.data,
      }
    } finally {
      const current = this.inFlight.get(provider.capability) ?? 1
      if (current <= 1) this.inFlight.delete(provider.capability)
      else this.inFlight.set(provider.capability, current - 1)
    }
  }

  /** One line naming the capabilities the model may actually use. */
  private directory(): string {
    const views = this.describe()
    if (views.length === 0) return '当前没有任何已配置的 CLI 能力。'
    return `当前可用：${views.map(view => `${view.capability}（${view.title}）`).join('、')}。`
  }

  private operationDirectory(provider: CliCapabilityProvider): string {
    const reads = Object.entries(provider.operations)
      .filter(([, spec]) => spec.access === 'read')
      .map(([operation]) => operation)
    return reads.length === 0 ? '（没有只读 operation）' : reads.join('、')
  }

  /** Configured instances of the provider's type; disabled ones are withdrawn. */
  private targetsOf(provider: CliCapabilityProvider): readonly CliTarget[] {
    return this.deps.listInstances()
      .filter(instance => instance.type === provider.collectorType && instance.desiredState !== 'disabled')
      .map(instance => ({
        id: instance.id,
        label: instance.label,
        health: instance.health,
        config: instance.config,
      }))
  }

  private resolveTarget(provider: CliCapabilityProvider, requested: string | undefined): CliTarget {
    const targets = this.targetsOf(provider)
    if (targets.length === 0) {
      refuse(
        'no-target',
        `${provider.title}（${provider.capability}）还没有配置任何账号：先在采集器里添加 ${provider.collectorType} 实例并完成登录`,
      )
    }
    if (requested === undefined) {
      if (targets.length === 1 && targets[0] !== undefined) return targets[0]
      refuse(
        'ambiguous-target',
        `${provider.title} 配置了 ${String(targets.length)} 个账号，请在 target 里指定：${targets.map(target => `${target.id}（${target.label}）`).join('、')}`,
      )
    }
    const found = targets.find(target => target.id === requested)
    if (found === undefined) {
      refuse(
        'unknown-target',
        `${provider.title} 没有 target ${requested}。可用：${targets.map(target => `${target.id}（${target.label}）`).join('、')}`,
      )
    }
    return found
  }
}

/** Serialized size of one result, or 0 when it cannot be serialized. */
function serializeLength(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : text.length
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/** Reject when the call's deadline signal aborts, whatever the provider does. */
function deadline(label: string, timeoutMs: number, signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const fail = (): void => {
      reject(new QunoStateError('timeout', `${label} 超过 ${String(timeoutMs)}ms 未返回`))
    }
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

/**
 * Validate one parameter object against a declared operation. Unknown keys are
 * refused — that is what keeps `profile`, `argv` or a second command out of
 * the payload — and out-of-bound values are refused rather than clipped, so a
 * caller learns the real surface instead of silently getting less.
 */
export function validateParams(
  spec: CliOperationSpec,
  raw: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  const params = raw === undefined || raw === null ? {} : raw
  if (typeof params !== 'object' || Array.isArray(params)) {
    refuse('invalid-params', `${label} 的 params 必须是对象`)
  }
  const record = params as Record<string, unknown>
  const declared = new Map(spec.params.map(param => [param.name, param]))
  const unknown = Object.keys(record).filter(key => !declared.has(key))
  if (unknown.length > 0) {
    const allowed = spec.params.length === 0 ? '（无参数）' : spec.params.map(param => param.name).join('、')
    refuse('invalid-params', `${label} 不接受参数 ${unknown.join('、')}；可用参数：${allowed}`)
  }
  const normalized: Record<string, unknown> = {}
  for (const param of spec.params) {
    const value = record[param.name]
    if (value === undefined || value === null) {
      if (param.required === true) {
        refuse('invalid-params', `${label} 缺少必填参数 ${param.name}（${param.description}）`)
      }
      continue
    }
    if (param.kind === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        refuse('invalid-params', `${label} 的 ${param.name} 必须是整数`)
      }
      const min = param.min ?? 1
      const max = param.max ?? Number.MAX_SAFE_INTEGER
      if (value < min || value > max) {
        refuse('invalid-params', `${label} 的 ${param.name} 必须在 ${String(min)}-${String(max)} 之间`)
      }
      normalized[param.name] = value
      continue
    }
    if (param.kind === 'boolean') {
      if (typeof value !== 'boolean') refuse('invalid-params', `${label} 的 ${param.name} 必须是布尔值`)
      normalized[param.name] = value
      continue
    }
    if (typeof value !== 'string') {
      refuse('invalid-params', `${label} 的 ${param.name} 必须是字符串`)
    }
    const trimmed = value.trim()
    if (trimmed === '') refuse('invalid-params', `${label} 的 ${param.name} 不能为空`)
    const maxChars = param.maxChars ?? 256
    if (trimmed.length > maxChars) {
      refuse('invalid-params', `${label} 的 ${param.name} 超出 ${String(maxChars)} 字符上限`)
    }
    normalized[param.name] = trimmed
  }
  return normalized
}
