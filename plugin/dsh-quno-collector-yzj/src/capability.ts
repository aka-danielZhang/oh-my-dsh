/**
 * The yzj Sense's structured read capability (`yzj`).
 *
 * This is the capability a Worker sees through `quno_cli_call`: a closed
 * operation table with declared parameters, executed through the same runner,
 * the same failure classification and the same per-profile rate budget as
 * polling and as the asynchronous query face. The model names a capability and
 * an operation; it never names a binary, an argv, or a `--profile`.
 *
 * Targets are the configured collector instances of type `quno/yzj-im`. That is
 * the user's authorization: configuring an account authorizes reading it, and
 * a paused instance keeps its account available (only disabling or removing
 * the instance withdraws it). Credentials live in yzj-cli, never here.
 *
 * @module dsh-quno-sense-yzj/capability
 */

import { CALL_TIMEOUT_MS, type CliExec } from './cli.ts'
import { ORGAN_BOUNDS, parseOrganPayload, runYzjOperation } from './organ.ts'
import type { CliCapabilityProvider, CliOperationSpec } from '../../dsh-quno/src/cli-broker.ts'

/** The collector type whose configured instances are this capability's targets. */
export const YZJ_COLLECTOR_TYPE = 'quno/yzj-im'

/** Capability id the model names. */
export const YZJ_CAPABILITY = 'yzj'

/**
 * The declared read surface. Values mirror {@link ORGAN_BOUNDS} so the tool
 * schema and the runtime validator cannot disagree about a single bound.
 */
export const YZJ_OPERATIONS: Readonly<Record<string, CliOperationSpec>> = {
  'im.group.recent': {
    access: 'read',
    summary: '最近的会话目录（群聊与私聊），用于找到目标的 groupId',
    params: [
      { name: 'limit', kind: 'integer', min: 1, max: ORGAN_BOUNDS.groupRecentLimit, description: `每页条数（1-${String(ORGAN_BOUNDS.groupRecentLimit)}），默认上限` },
      { name: 'page', kind: 'integer', min: 1, max: ORGAN_BOUNDS.groupRecentPages, description: `页码（1-${String(ORGAN_BOUNDS.groupRecentPages)}），默认 1` },
    ],
  },
  'im.group.search': {
    access: 'read',
    summary: '按名称搜索会话，用于把群名换成 groupId',
    params: [
      { name: 'keyword', kind: 'string', required: true, maxChars: ORGAN_BOUNDS.keywordMaxChars, description: `搜索关键词（≤${String(ORGAN_BOUNDS.keywordMaxChars)} 字符）` },
      { name: 'limit', kind: 'integer', min: 1, max: ORGAN_BOUNDS.groupSearchLimit, description: `条数（1-${String(ORGAN_BOUNDS.groupSearchLimit)}）` },
      { name: 'page', kind: 'integer', min: 1, max: ORGAN_BOUNDS.groupSearchPages, description: `页码（1-${String(ORGAN_BOUNDS.groupSearchPages)}）` },
    ],
  },
  'im.message.list': {
    access: 'read',
    summary: '读取一个群或私聊窗口内的最新消息（按时间倒序窗口，不写回执）',
    params: [
      { name: 'groupId', kind: 'string', required: true, maxChars: ORGAN_BOUNDS.groupIdMaxChars, description: `会话 id（来自 im.group.recent/search）` },
      { name: 'limit', kind: 'integer', min: 1, max: ORGAN_BOUNDS.messageListLimit, description: `条数（1-${String(ORGAN_BOUNDS.messageListLimit)}）` },
    ],
  },
}

/** Read the CLI profile out of one configured instance; never from the model. */
function profileOf(config: Readonly<Record<string, unknown>>): string {
  const raw = config['yzjProfile']
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'default'
}

/**
 * Build the capability provider. `exec` is injected so tests can drive a real
 * child process or a stub without touching the provider.
 */
export function createYzjCapability(exec: CliExec): CliCapabilityProvider {
  return {
    capability: YZJ_CAPABILITY,
    title: '云之家',
    collectorType: YZJ_COLLECTOR_TYPE,
    operations: YZJ_OPERATIONS,
    timeoutMs: CALL_TIMEOUT_MS,
    maxOutputChars: 24_000,
    async execute(request) {
      const profile = profileOf(request.target.config)
      const parsed = parseOrganPayload({ op: request.operation, params: request.params })
      if (!parsed.ok) return { ok: false, code: parsed.reason, message: parsed.detail }
      return await runYzjOperation({
        parsed,
        profile,
        exec,
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        maxOutputChars: request.maxOutputChars,
      })
    },
  }
}
