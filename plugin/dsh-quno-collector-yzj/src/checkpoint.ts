/**
 * The opaque checkpoint document (v2 §8): a versioned JSON string the Host
 * stores without interpreting. Corrupt or unknown-version checkpoints are a
 * hard stop — never silently reset to empty (that would re-baseline and
 * silently skip history).
 *
 * Capacity discipline: the Host caps checkpoint values at 200,000 characters;
 * this plugin keeps itself under a conservative 160 KiB UTF-8 and 200
 * conversations. Overflow is refused loudly (the round keeps serving tracked
 * conversations and reports a directory-capacity gap) — cursors are never
 * silently dropped to make room.
 *
 * @module dsh-quno-collector-yzj/checkpoint
 */

/** UTF-8 byte ceiling this plugin self-enforces (Host hard limit: 200,000 chars). */
export const CHECKPOINT_MAX_BYTES = 160 * 1024

/** Maximum tracked conversations; beyond it new sessions become explicit debt. */
export const MAX_SESSIONS = 200

/** Per-conversation duplicate-suppression ring. Seen is not a durable cursor. */
export const SEEN_CAP = 20

/** Frozen display labels stay bounded; real names come only from the catalog. */
export const LABEL_CAP = 80

/** Bounded dedup set of conversations rejected by capacity (display "at least N"). */
export const CAPACITY_REJECTED_CAP = 500

/**
 * Initialization failure backoff ladder (minutes). Consecutive same-cause
 * failures walk the ladder; three in a row surface as "采集受阻" while other
 * conversations keep flowing (redesign §4.3/§8.1).
 */
export const INIT_BACKOFF_MINUTES: readonly number[] = [1, 2, 5, 15, 30]

/** Entries-mode key prefixes and markers (kept opaque to the Host). */
export const ENTRY_KEY_SESSION_PREFIX = 'c:'
export const ENTRY_KEY_MIGRATION_SNAPSHOT = 'm:v2'
export const ENTRY_KEY_MIGRATION_DONE = 'm:done'

/**
 * Per-instance entry storage target in entries mode. The Host enforces the
 * same number; the plugin checks first so the fault names the cause.
 */
export const ENTRY_STORAGE_CAPACITY = 10_000

/** The v3 root document: everything except the per-conversation groups. */
export function serializeRoot(state: V2Checkpoint): string {
  return JSON.stringify({
    v: 3,
    owner: state.owner,
    focusedSince: state.focusedSince,
    discovery: state.discovery,
    coverage: state.coverage,
  })
}

/** Whether a raw checkpoint value is a legacy v2 blob (needs migration). */
export function isLegacyBlobRoot(value: string | null): boolean {
  if (value === null || value.trim() === '') return false
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    return parsed['v'] === 2 && typeof parsed['groups'] === 'object' && parsed['groups'] !== null
  } catch {
    return false
  }
}

/** Whether the raw value is a v3 root document. */
export function isV3Root(value: string | null): boolean {
  if (value === null || value.trim() === '') return false
  try {
    return (JSON.parse(value) as Record<string, unknown>)['v'] === 3
  } catch {
    return false
  }
}

/** One conversation's durable position. */
export interface GroupCheckpoint {
  /** 1 = private chat, 2 = group chat; null = seen but type unconfirmed. */
  readonly groupType: number | null
  /** Catalog display name, frozen at observation time (never re-resolved). */
  readonly label: string
  /** Last ACKed message id; null = initialized while empty. */
  readonly cursor: string | null
  /** True once a baseline/newest boundary has been established. */
  readonly initialized: boolean
  readonly seen: readonly string[]
  /** ISO instants for display; epoch ms only for scheduling order. */
  readonly lastSeenInRecentAt: string | null
  readonly lastAttemptAt: string | null
  readonly syncedAt: number | null
  /** More pages exist but the round budget ran out; catch up before skipping. */
  readonly needsCatchUp: boolean
  /** Session-level backoff: not selected before this epoch ms. */
  readonly retryNotBefore: number | null
  /** v1 legacy baseline pin time, preserved through migration. */
  readonly pinnedAt: number | null
  /** Bounded: code + count + boundary instant, never message text. */
  readonly gap: { readonly code: string; readonly count: number; readonly at: string } | null
  /** Consecutive initialization failures of the same cause (0.3.0 scheduling rework). */
  readonly initFailures?: number
  /** Last initialization failure code (`time-missing`, `page-order-unverified`, …). */
  readonly initFailCode?: string | null
}

/** The v2 checkpoint document. */
export interface V2Checkpoint {
  readonly v: 2
  readonly owner: { readonly orgId: string | null; readonly openId: string } | null
  /** Instance-level enable instant (ISO); initialization window for all sessions. */
  readonly focusedSince: string | null
  readonly discovery: {
    /** Next catalog page to sweep; 2 after a completed sweep, 1 before start. */
    readonly nextPage: number
    readonly sweepStartedAt: string | null
    readonly lastSweepCompletedAt: string | null
  }
  readonly groups: Readonly<Record<string, GroupCheckpoint>>
  readonly coverage: {
    /** True while the last sweep ended on `more:true` — display lag, honestly. */
    readonly directoryTruncated: boolean
    /** Conversations seen but not collectable (capacity, unresolved type). */
    readonly unresolvedCount: number
    /** Epoch ms of the last time the catalog scan actually advanced (0.3.0). */
    readonly lastProgressAt?: number | null
    /** Conversation ids rejected by capacity, deduped and bounded (0.3.0). */
    readonly capacityRejectedIds?: readonly string[]
  }
}

/** The v1 checkpoint document (selected-groups only). */
export interface V1Checkpoint {
  readonly v: 1
  readonly groups: Readonly<Record<string, V1Group>>
}

export interface V1Group {
  readonly cursor: string | null
  readonly pinnedAt: number | null
  readonly seen: readonly string[]
  readonly syncedAt: number | null
}

export type ParsedCheckpoint =
  | { readonly kind: 'empty' }
  | { readonly kind: 'v1'; readonly state: V1Checkpoint }
  | { readonly kind: 'v2'; readonly state: V2Checkpoint }
  | { readonly kind: 'corrupt'; readonly reason: string }

export function emptyV2(): V2Checkpoint {
  return {
    v: 2,
    owner: null,
    focusedSince: null,
    discovery: { nextPage: 1, sweepStartedAt: null, lastSweepCompletedAt: null },
    groups: {},
    coverage: { directoryTruncated: false, unresolvedCount: 0, lastProgressAt: null, capacityRejectedIds: [] },
  }
}

/** Read the persisted checkpoint. Corruption is reported, never swallowed. */
export function parseCheckpoint(value: string | null): ParsedCheckpoint {
  if (value === null || value.trim() === '') return { kind: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    return { kind: 'corrupt', reason: `checkpoint JSON 无法解析：${(error as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'corrupt', reason: 'checkpoint 不是 JSON 对象' }
  }
  const record = parsed as Record<string, unknown>
  if (record['v'] === 1) return parseV1(record)
  if (record['v'] === 2) return parseV2(record)
  return { kind: 'corrupt', reason: `checkpoint 版本未知：${String(record['v'])}` }
}

function parseV1(record: Record<string, unknown>): ParsedCheckpoint {
  const groups: Record<string, V1Group> = {}
  const raw = record['groups']
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [groupId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const entry = value as Record<string, unknown>
      groups[groupId] = {
        cursor: typeof entry['cursor'] === 'string' ? entry['cursor'] : null,
        pinnedAt: typeof entry['pinnedAt'] === 'number' ? entry['pinnedAt'] : null,
        seen: Array.isArray(entry['seen']) ? entry['seen'].filter((id): id is string => typeof id === 'string') : [],
        syncedAt: typeof entry['syncedAt'] === 'number' ? entry['syncedAt'] : null,
      }
    }
  }
  return { kind: 'v1', state: { v: 1, groups } }
}

function parseV2(record: Record<string, unknown>): ParsedCheckpoint {
  const ownerRaw = record['owner']
  let owner: V2Checkpoint['owner'] = null
  if (typeof ownerRaw === 'object' && ownerRaw !== null && !Array.isArray(ownerRaw)) {
    const entry = ownerRaw as Record<string, unknown>
    if (typeof entry['openId'] === 'string' && entry['openId'] !== '') {
      const orgId = entry['orgId']
      owner = { openId: entry['openId'], orgId: typeof orgId === 'string' ? orgId : null }
    }
  }
  const discoveryRaw = record['discovery']
  const discovery: V2Checkpoint['discovery'] = {
    nextPage: typeof (discoveryRaw as Record<string, unknown> | null)?.['nextPage'] === 'number'
      ? Math.max(1, Math.trunc((discoveryRaw as Record<string, unknown>)['nextPage'] as number))
      : 1,
    sweepStartedAt: typeof (discoveryRaw as Record<string, unknown> | null)?.['sweepStartedAt'] === 'string'
      ? (discoveryRaw as Record<string, unknown>)['sweepStartedAt'] as string
      : null,
    lastSweepCompletedAt: typeof (discoveryRaw as Record<string, unknown> | null)?.['lastSweepCompletedAt'] === 'string'
      ? (discoveryRaw as Record<string, unknown>)['lastSweepCompletedAt'] as string
      : null,
  }
  const coverageRaw = record['coverage'] as Record<string, unknown> | null
  const rejectedRaw = coverageRaw?.['capacityRejectedIds']
  const rejected = Array.isArray(rejectedRaw)
    ? [...new Set(rejectedRaw.filter((id): id is string => typeof id === 'string'))]
    : null
  const coverage: V2Checkpoint['coverage'] = {
    directoryTruncated: coverageRaw?.['directoryTruncated'] === true,
    unresolvedCount: typeof coverageRaw?.['unresolvedCount'] === 'number'
      ? Math.max(0, Math.trunc(coverageRaw['unresolvedCount'] as number))
      : 0,
    ...(typeof coverageRaw?.['lastProgressAt'] === 'number'
      ? { lastProgressAt: coverageRaw['lastProgressAt'] as number }
      : {}),
    ...(rejected !== null ? { capacityRejectedIds: rejected.slice(0, CAPACITY_REJECTED_CAP) } : {}),
  }
  const groups: Record<string, GroupCheckpoint> = {}
  const rawGroups = record['groups']
  if (typeof rawGroups === 'object' && rawGroups !== null && !Array.isArray(rawGroups)) {
    for (const [groupId, value] of Object.entries(rawGroups as Record<string, unknown>)) {
      const parsed = parseGroup(groupId, value)
      if (parsed !== null) groups[groupId] = parsed
    }
  }
  return {
    kind: 'v2',
    state: {
      v: 2,
      owner,
      focusedSince: typeof record['focusedSince'] === 'string' ? record['focusedSince'] : null,
      discovery,
      groups,
      coverage,
    },
  }
}

function parseGroup(groupId: string, value: unknown): GroupCheckpoint | null {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  const gapRaw = entry['gap']
  const gap =
    typeof gapRaw === 'object' && gapRaw !== null && typeof (gapRaw as Record<string, unknown>)['code'] === 'string'
      ? {
        code: (gapRaw as Record<string, unknown>)['code'] as string,
        count: typeof (gapRaw as Record<string, unknown>)['count'] === 'number'
          ? Math.max(1, Math.trunc((gapRaw as Record<string, unknown>)['count'] as number))
          : 1,
        at: typeof (gapRaw as Record<string, unknown>)['at'] === 'string'
          ? (gapRaw as Record<string, unknown>)['at'] as string
          : '',
      }
      : null
  return {
    groupType: typeof entry['groupType'] === 'number' ? entry['groupType'] : null,
    label: typeof entry['label'] === 'string' ? entry['label'].slice(0, LABEL_CAP) : '',
    cursor: typeof entry['cursor'] === 'string' ? entry['cursor'] : null,
    initialized: entry['initialized'] === true,
    seen: Array.isArray(entry['seen'])
      ? entry['seen'].filter((id): id is string => typeof id === 'string').slice(-SEEN_CAP)
      : [],
    lastSeenInRecentAt: typeof entry['lastSeenInRecentAt'] === 'string' ? entry['lastSeenInRecentAt'] : null,
    lastAttemptAt: typeof entry['lastAttemptAt'] === 'string' ? entry['lastAttemptAt'] : null,
    syncedAt: typeof entry['syncedAt'] === 'number' ? entry['syncedAt'] : null,
    needsCatchUp: entry['needsCatchUp'] === true,
    retryNotBefore: typeof entry['retryNotBefore'] === 'number' ? entry['retryNotBefore'] : null,
    pinnedAt: typeof entry['pinnedAt'] === 'number' ? entry['pinnedAt'] : null,
    gap,
    ...(typeof entry['initFailures'] === 'number' ? { initFailures: Math.max(0, Math.trunc(entry['initFailures'] as number)) } : {}),
    ...(entry['initFailCode'] === null || typeof entry['initFailCode'] === 'string'
      ? { initFailCode: entry['initFailCode'] as string | null }
      : {}),
  }
}

/**
 * Migrate a v1 checkpoint: every committed cursor/seen/pin/sync time survives.
 * Migrated groups count as initialized (their baseline was pinned under v1),
 * so switching to focused never replays or skips what v1 already anchored.
 */
export function migrateV1(v1: V1Checkpoint): V2Checkpoint {
  const groups: Record<string, GroupCheckpoint> = {}
  for (const [groupId, group] of Object.entries(v1.groups)) {
    groups[groupId] = {
      groupType: null,
      label: '',
      cursor: group.cursor,
      initialized: true,
      seen: group.seen.slice(-SEEN_CAP),
      lastSeenInRecentAt: null,
      lastAttemptAt: null,
      syncedAt: group.syncedAt,
      needsCatchUp: false,
      retryNotBefore: null,
      pinnedAt: group.pinnedAt,
      gap: null,
    }
  }
  return { ...emptyV2(), groups }
}

/** Update helpers (structural sharing keeps unchanged groups referentially equal). */
export function withGroups(state: V2Checkpoint, groups: Record<string, GroupCheckpoint>): V2Checkpoint {
  return { ...state, groups }
}

export function withGroup(state: V2Checkpoint, groupId: string, group: GroupCheckpoint): V2Checkpoint {
  return withGroups(state, { ...state.groups, [groupId]: group })
}

/** Append to a conversation's seen ring, keeping the newest `SEEN_CAP` ids. */
export function pushSeen(previous: readonly string[], added: readonly string[]): readonly string[] {
  const merged = [...previous, ...added]
  return merged.length <= SEEN_CAP ? merged : merged.slice(merged.length - SEEN_CAP)
}

export interface SerializeResult {
  readonly ok: true
  readonly json: string
  readonly bytes: number
}
export interface SerializeOverflow {
  readonly ok: false
  readonly reason: 'session-capacity' | 'byte-capacity'
  readonly sessions: number
  readonly bytes: number
}

/**
 * Serialize under the plugin's capacity budget. Overflow is refused loudly —
 * the caller keeps serving tracked conversations and reports the debt.
 */
export function serializeCheckpoint(state: V2Checkpoint): SerializeResult | SerializeOverflow {
  const sessions = Object.keys(state.groups).length
  if (sessions > MAX_SESSIONS) {
    return { ok: false, reason: 'session-capacity', sessions, bytes: 0 }
  }
  const normalized: V2Checkpoint = {
    ...state,
    groups: Object.fromEntries(
      Object.entries(state.groups).map(([id, group]) => [id, { ...group, label: group.label.slice(0, LABEL_CAP), seen: group.seen.slice(-SEEN_CAP) }]),
    ),
  }
  const json = JSON.stringify(normalized)
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > CHECKPOINT_MAX_BYTES) {
    return { ok: false, reason: 'byte-capacity', sessions, bytes }
  }
  return { ok: true, json, bytes }
}
