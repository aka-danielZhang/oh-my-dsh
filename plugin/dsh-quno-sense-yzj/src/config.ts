/**
 * Instance configuration (v2 §5).
 *
 * `collectionMode` is written explicitly by new instances; a config missing
 * the field is a legacy instance and validates under the old selected-groups
 * rules (required group ids, 600s default interval). Mode is never guessed
 * from the presence of `groupIds`.
 *
 * @module dsh-quno-sense-yzj/config
 */

/** `focused`: direct @me + private chats. `selected-groups`: legacy full firehose. */
export type CollectionMode = 'focused' | 'selected-groups'

/** Validated instance configuration. */
export interface YzjConfig {
  readonly collectionMode: CollectionMode
  /** focused: group whitelist (empty = auto-discovery); legacy: the required selection. */
  readonly groupIds: readonly string[]
  /** Near-activity discovery period (0.3.0: no longer a full-round sleep). */
  readonly intervalSec: number
  readonly maxDiscoveryPages: number
  /** Per-shard message-request budget (0.3.0: an execution shard, not a round). */
  readonly maxConversationsPerCheck: number
  readonly maxPagesPerGroup: number
  readonly yzjProfile: string
  readonly freshnessThresholdSec: number
  /** Oldest pending work waiting longer than this surfaces as 采集延迟 (0.3.0). */
  readonly pendingWaitThresholdSec: number
  /** Directory scan making no progress for this long surfaces as 扫描受阻 (0.3.0). */
  readonly directoryStalledSec: number
}

export function validateConfig(
  raw: unknown,
): { readonly ok: true; readonly value: YzjConfig } | { readonly ok: false; readonly message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: '配置必须是对象' }
  const record = raw as Record<string, unknown>
  const modeValue = record['collectionMode']
  if (modeValue !== undefined && modeValue !== null && modeValue !== 'focused' && modeValue !== 'selected-groups') {
    return { ok: false, message: `collectionMode 只能是 focused 或 selected-groups，收到：${String(modeValue)}` }
  }
  const mode: CollectionMode = modeValue === 'focused' ? 'focused' : 'selected-groups'
  const groupIds = parseGroupIds(record['groupIds'])
  if (groupIds.length > 50) return { ok: false, message: 'groupIds 最多 50 个' }
  if (mode === 'selected-groups' && groupIds.length === 0) {
    return { ok: false, message: '需要至少一个群 ID（groupIds）' }
  }
  const intervalSec = numberOr(record['intervalSec'], mode === 'focused' ? 300 : 600)
  if (intervalSec < 60) return { ok: false, message: 'intervalSec 不能小于 60' }
  const maxPagesPerGroup = clampInt(record['maxPagesPerGroup'], 1, 20, 5)
  const maxDiscoveryPages = clampInt(record['maxDiscoveryPages'], 2, 10, 5)
  const maxConversationsPerCheck = clampInt(record['maxConversationsPerCheck'], 1, 200, 20)
  const yzjProfile =
    typeof record['yzjProfile'] === 'string' && record['yzjProfile'].trim() !== ''
      ? record['yzjProfile'].trim()
      : 'default'
  const freshnessThresholdSec = Math.max(60, numberOr(record['freshnessThresholdSec'], mode === 'focused' ? 900 : 1800))
  const pendingWaitThresholdSec = Math.max(60, numberOr(record['pendingWaitThresholdSec'], 600))
  const directoryStalledSec = Math.max(60, numberOr(record['directoryStalledSec'], 900))
  return {
    ok: true,
    value: {
      collectionMode: mode,
      groupIds,
      intervalSec,
      maxDiscoveryPages,
      maxConversationsPerCheck,
      maxPagesPerGroup,
      yzjProfile,
      freshnessThresholdSec,
      pendingWaitThresholdSec,
      directoryStalledSec,
    },
  }
}

/** Accept an array or a comma/whitespace separated string, trimmed and de-duplicated. */
function parseGroupIds(value: unknown): string[] {
  const parts: string[] = []
  if (typeof value === 'string') {
    parts.push(...value.split(/[\s,，;；]+/))
  } else if (Array.isArray(value)) {
    for (const item of value) if (typeof item === 'string') parts.push(item)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = numberOr(value, fallback)
  return Math.min(max, Math.max(min, parsed))
}

/** Accept a finite number, rounding; anything else falls back. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}
