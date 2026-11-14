/**
 * The on-demand read face of the yzj Sense (plan note 2026-11-08 §5): a
 * closed op whitelist served through the same CLI runner, failure
 * classification and per-profile rate budget as polling.
 *
 * The whitelist is the boundary: nothing outside the three read operations
 * ever reaches the CLI, a refusing payload is terminal (no CLI retry), and
 * the profile always comes from the RUNNING instance config — a payload
 * cannot name one. Every refusal reason is self-describing so the requester
 * can correct its next call instead of guessing.
 *
 * @module dsh-quno-sense-yzj/organ
 */

import { CALL_TIMEOUT_MS, classifyRun, hasMore, parseEnvelope, readList, type CliExec } from './cli.ts'
import { takeToken } from './round.ts'
import type { CliCallOutcome, CliOperationSpec } from '../../dsh-quno/src/cli-broker.ts'
import type { OrganExchangeRequest } from '../../dsh-quno/src/types.ts'

/** The closed set of on-demand read operations (v1 whitelist). */
export const ORGAN_OPS = ['im.group.recent', 'im.group.search', 'im.message.list'] as const
export type OrganOp = (typeof ORGAN_OPS)[number]

/**
 * Hard bounds of the v1 whitelist. `im.message.list` has no `--page` flag in
 * the current CLI (pagination is a `--msg-id` cursor), so v1 relays only the
 * newest window; the argv mapping was re-checked against the installed CLI
 * as the plan note requires.
 */
export const ORGAN_BOUNDS = {
  groupRecentLimit: 20,
  groupRecentPages: 10,
  groupSearchLimit: 20,
  groupSearchPages: 10,
  messageListLimit: 50,
  keywordMaxChars: 64,
  groupIdMaxChars: 64,
  /** Longest per-item string field relayed to the requester. */
  itemTextMaxChars: 4000,
} as const

/** One accepted payload, per-op normalized; `ok: false` carries the refusal. */
export type ParsedOrganPayload =
  | { readonly ok: true; readonly op: 'im.group.recent'; readonly limit: number; readonly page: number }
  | { readonly ok: true; readonly op: 'im.group.search'; readonly keyword: string; readonly limit: number; readonly page: number }
  | { readonly ok: true; readonly op: 'im.message.list'; readonly groupId: string; readonly limit: number }
  | { readonly ok: false; readonly reason: 'unsupported-op' | 'invalid-args'; readonly detail: string }

const ALLOWED_KEYS: Record<OrganOp, readonly string[]> = {
  'im.group.recent': ['limit', 'page'],
  'im.group.search': ['keyword', 'limit', 'page'],
  'im.message.list': ['groupId', 'limit'],
}

type BoundedInt = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly detail: string }

function boundedInt(params: Record<string, unknown>, key: string, max: number, fallback: number): BoundedInt {
  const raw = params[key]
  if (raw === undefined) return { ok: true, value: fallback }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > max) {
    return { ok: false, detail: `${key} 必须是 1-${String(max)} 的整数` }
  }
  return { ok: true, value: raw }
}

type BoundedString = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly detail: string }

function boundedString(params: Record<string, unknown>, key: string, max: number): BoundedString {
  const raw = params[key]
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, detail: `${key} 必须是 1-${String(max)} 字符的非空字符串` }
  const value = raw.trim()
  if (value.length > max) return { ok: false, detail: `${key} 超出 ${String(max)} 字符上限` }
  return { ok: true, value }
}

/**
 * Validate one exchange payload against the whitelist. Unknown keys are
 * refused (this also refuses a payload-borne profile), over-bound values are
 * refused rather than clipped — the caller must ask within the surface.
 */
export function parseOrganPayload(payload: unknown): ParsedOrganPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'invalid-args', detail: 'payload 必须是 { op, params? } 对象' }
  }
  const record = payload as Record<string, unknown>
  const op = record['op']
  if (typeof op !== 'string' || !(ORGAN_OPS as readonly string[]).includes(op)) {
    return { ok: false, reason: 'unsupported-op', detail: `未知 op "${String(op)}"；可用 op：${ORGAN_OPS.join('、')}` }
  }
  const organOp = op as OrganOp
  const rawParams = record['params'] ?? {}
  if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
    return { ok: false, reason: 'invalid-args', detail: 'params 必须是对象' }
  }
  const params = rawParams as Record<string, unknown>
  const allowed = ALLOWED_KEYS[organOp]
  const unknownKeys = Object.keys(params).filter(key => !allowed.includes(key))
  if (unknownKeys.length > 0) {
    return { ok: false, reason: 'invalid-args', detail: `未知参数 ${unknownKeys.join('、')}（op ${organOp} 只接受 ${allowed.join('、')}）` }
  }
  if (organOp === 'im.group.recent') {
    const limit = boundedInt(params, 'limit', ORGAN_BOUNDS.groupRecentLimit, ORGAN_BOUNDS.groupRecentLimit)
    if (!limit.ok) return { ok: false, reason: 'invalid-args', detail: limit.detail }
    const page = boundedInt(params, 'page', ORGAN_BOUNDS.groupRecentPages, 1)
    if (!page.ok) return { ok: false, reason: 'invalid-args', detail: page.detail }
    return { ok: true, op: organOp, limit: limit.value, page: page.value }
  }
  if (organOp === 'im.group.search') {
    const keyword = boundedString(params, 'keyword', ORGAN_BOUNDS.keywordMaxChars)
    if (!keyword.ok) return { ok: false, reason: 'invalid-args', detail: keyword.detail }
    const limit = boundedInt(params, 'limit', ORGAN_BOUNDS.groupSearchLimit, ORGAN_BOUNDS.groupSearchLimit)
    if (!limit.ok) return { ok: false, reason: 'invalid-args', detail: limit.detail }
    const page = boundedInt(params, 'page', ORGAN_BOUNDS.groupSearchPages, 1)
    if (!page.ok) return { ok: false, reason: 'invalid-args', detail: page.detail }
    return { ok: true, op: organOp, keyword: keyword.value, limit: limit.value, page: page.value }
  }
  const groupId = boundedString(params, 'groupId', ORGAN_BOUNDS.groupIdMaxChars)
  if (!groupId.ok) return { ok: false, reason: 'invalid-args', detail: groupId.detail }
  const limit = boundedInt(params, 'limit', ORGAN_BOUNDS.messageListLimit, ORGAN_BOUNDS.messageListLimit)
  if (!limit.ok) return { ok: false, reason: 'invalid-args', detail: limit.detail }
  return { ok: true, op: organOp, groupId: groupId.value, limit: limit.value }
}

/** argv for one accepted payload; the profile always comes from the instance. */
function argvFor(parsed: Extract<ParsedOrganPayload, { readonly ok: true }>, profile: string): readonly string[] {
  const base = ['--profile', profile]
  switch (parsed.op) {
    case 'im.group.recent':
      return [...base, 'im', 'group', 'recent', '--limit', String(parsed.limit), '--page', String(parsed.page)]
    case 'im.group.search':
      return [...base, 'im', 'group', 'search', '--keyword', parsed.keyword, '--limit', String(parsed.limit), '--page', String(parsed.page)]
    case 'im.message.list':
      return [...base, 'im', 'message', 'list', '--group-id', parsed.groupId, '--limit', String(parsed.limit)]
  }
}

/**
 * Bound one CLI list to the whitelist shape: at most `limit` items, and no
 * string field longer than `itemTextMaxChars`. Everything clipped is reported
 * through `truncated` instead of being passed off as complete. `maxChars`
 * additionally drops trailing items once the serialized result would exceed
 * the caller's ceiling — the caller learns it got less, never silently.
 */
export function boundOrganList(
  list: readonly unknown[],
  limit: number,
  maxChars = Number.POSITIVE_INFINITY,
): { readonly items: readonly unknown[]; readonly truncated: boolean } {
  let truncated = list.length > limit
  const items: unknown[] = []
  let budget = maxChars
  for (const item of list.slice(0, limit)) {
    if (typeof item !== 'object' || item === null) {
      const cost = JSON.stringify(item)?.length ?? 0
      if (cost > budget) {
        truncated = true
        break
      }
      budget -= cost
      items.push(item)
      continue
    }
    const record: Record<string, unknown> = {}
    let clipped = false
    for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > ORGAN_BOUNDS.itemTextMaxChars) {
        record[key] = value.slice(0, ORGAN_BOUNDS.itemTextMaxChars)
        clipped = true
      } else {
        record[key] = value
      }
    }
    truncated = truncated || clipped
    const cost = JSON.stringify(record)?.length ?? 0
    if (cost > budget) {
      truncated = true
      break
    }
    budget -= cost
    items.push(record)
  }
  return { items, truncated }
}

/**
 * Execute one already-validated operation. This is the single CLI execution
 * path: the Sense's asynchronous Organ face and the Worker's synchronous
 * `quno_cli_call` both end up here, so argv construction, failure
 * classification and the shared per-profile rate budget cannot drift apart.
 */
export async function runYzjOperation(input: {
  readonly parsed: Extract<ParsedOrganPayload, { readonly ok: true }>
  readonly profile: string
  readonly exec: CliExec
  readonly signal: AbortSignal | undefined
  readonly timeoutMs: number
  readonly maxOutputChars?: number
}): Promise<CliCallOutcome> {
  // The on-demand read shares the polling budget of the same profile — one
  // rate limiter per profile, never a separate on-demand quota.
  const token = takeToken(input.profile, Date.now())
  if (!token.ok) {
    const waitMs = Math.max(0, token.nextTokenAt - Date.now())
    return {
      ok: false,
      code: 'rate-limited',
      message: `与轮询共享的每分钟请求预算已用尽，约 ${String(waitMs)}ms 后恢复`,
      retryable: true,
    }
  }
  const run = await input.exec(argvFor(input.parsed, input.profile), input.signal, input.timeoutMs)
  const failure = classifyRun(run)
  if (failure !== null) {
    const retryable = failure.state === 'rate-limited' || (failure.state === 'unavailable' && failure.code !== 'cli-missing')
    return { ok: false, code: failure.state, message: failure.detail, retryable }
  }
  const envelope = parseEnvelope(run.stdout)
  const list = readList(envelope)
  if (envelope === null || list === null) {
    return { ok: false, code: 'bad-envelope', message: 'CLI 返回内容无法解析为 { success, data.list } 信封' }
  }
  if (envelope.success !== true) {
    return { ok: false, code: 'cli-error', message: envelope.error?.message ?? 'CLI 返回失败信封' }
  }
  const bounded = boundOrganList(list, input.parsed.limit, input.maxOutputChars)
  return {
    ok: true,
    data: {
      op: input.parsed.op,
      count: bounded.items.length,
      more: hasMore(envelope),
      truncated: bounded.truncated,
      list: bounded.items,
    },
  }
}

interface OrganInstanceRegistration {
  readonly profile: string
}

/** Running instances whose on-demand face is live; keyed by instance id. */
const instances = new Map<string, OrganInstanceRegistration>()

/**
 * Register one running instance's on-demand face. Called from the factory's
 * `start` (the profile is the RUNNING config); the returned disposer removes
 * it again on stop, so a stopped instance never answers exchanges.
 */
export function registerOrganInstance(instanceId: string, profile: string): () => void {
  instances.set(instanceId, { profile })
  return () => {
    instances.delete(instanceId)
  }
}

/**
 * Serve one exchange from the whitelist. Refusals are terminal except the
 * shared-rate-budget and network classes, which ride the engine's bounded
 * retry; an auth failure stays terminal here because the instance health
 * face already reports it and recovery needs an out-of-band login.
 */
export async function handleOrganRequest(request: OrganExchangeRequest, exec: CliExec): Promise<void> {
  const instanceId = request.endpoint.startsWith('organ:') ? request.endpoint.slice('organ:'.length) : ''
  const instance = instanceId === '' ? undefined : instances.get(instanceId)
  if (instance === undefined) {
    await request.failExchange('instance-not-running：该实例未在运行；重启实例或用 quno_read 重新发现端点', false)
    return
  }
  const parsed = parseOrganPayload(request.payload)
  if (!parsed.ok) {
    await request.failExchange(`${parsed.reason}：${parsed.detail}`, false)
    return
  }
  const outcome = await runYzjOperation({
    parsed,
    profile: instance.profile,
    exec,
    signal: request.signal,
    timeoutMs: CALL_TIMEOUT_MS,
  })
  if (!outcome.ok) {
    await request.failExchange(`${outcome.code}：${outcome.message}`, outcome.retryable === true)
    return
  }
  await request.completeExchange(outcome.data)
}
