/**
 * Pure judgement helpers: effective priority, bounded batch selection with
 * anti-starvation and source fairness, and deterministic collapsing of a
 * model's attention/notification proposals.
 *
 * No I/O, no clock: every input carries its own timestamps, so the behaviour
 * is fully testable and a scheduler tick's choice is reproducible.
 *
 * @module dsh-quno/selection
 */

import type {
  AttentionChange,
  AttentionEvidence,
  EffectivePriority,
  EventRecord,
  NotificationCandidate,
  SuggestedPriority,
} from './types.ts'

const RANK: Record<EffectivePriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

/** Map a source suggestion to an effective priority (source `p0` needs Quno's own trust to start at p0). */
export function effectivePriority(event: Pick<EventRecord, 'priority' | 'deadline'>, now: number): EffectivePriority {
  const suggested: SuggestedPriority = event.priority
  if (event.deadline !== null && event.deadline >= now) {
    const distance = event.deadline - now
    if (distance <= 60 * 60_000) return 'p0'
    if (distance <= 24 * 60 * 60_000) return 'p1'
  }
  // A source may suggest urgency but can never mint the top tier by itself.
  if (suggested === 'p0') return 'p1'
  return suggested
}

/** One selectable delivery-ish row. */
export interface SelectableDelivery {
  readonly priority: EffectivePriority
  readonly createdAt: number
  readonly sourceId: string
  readonly eventId: string
}

/** Selection bounds. */
export interface SelectionOptions {
  /** Fraction of the batch reserved for the oldest pending rows regardless of priority. */
  readonly oldestReserveRatio: number
  /** Fraction one source may occupy before others get a turn. */
  readonly sourceCapRatio: number
}

/** Product defaults: 20% oldest reserve, 60% per-source cap. */
export const DEFAULT_SELECTION: SelectionOptions = {
  oldestReserveRatio: 0.2,
  sourceCapRatio: 0.6,
}

/**
 * Choose at most `max` deliveries: priority-first, with a reserved oldest
 * slice (低优不能饿死) and a per-source cap (单一来源不能刷屏). A second pass
 * relaxes the cap when the batch would otherwise run under capacity.
 */
export function selectDeliveries<T extends SelectableDelivery>(
  items: readonly T[],
  max: number,
  options: SelectionOptions = DEFAULT_SELECTION,
): T[] {
  if (max <= 0 || items.length === 0) return []
  if (items.length <= max) return [...items]
  const byPriority = [...items].sort((left, right) =>
    RANK[left.priority] - RANK[right.priority]
    || left.createdAt - right.createdAt
    || left.eventId.localeCompare(right.eventId))
  const oldest = [...items]
    .sort((left, right) => left.createdAt - right.createdAt || left.eventId.localeCompare(right.eventId))
    .slice(0, Math.max(1, Math.floor(max * options.oldestReserveRatio)))

  const chosen = new Map<string, T>()
  for (const item of oldest) chosen.set(item.eventId, item)

  const cap = Math.max(1, Math.ceil(max * options.sourceCapRatio))
  const perSource = new Map<string, number>()
  for (const item of chosen.values()) {
    perSource.set(item.sourceId, (perSource.get(item.sourceId) ?? 0) + 1)
  }
  for (const item of byPriority) {
    if (chosen.size >= max) break
    if (chosen.has(item.eventId)) continue
    const used = perSource.get(item.sourceId) ?? 0
    if (used >= cap) continue
    chosen.set(item.eventId, item)
    perSource.set(item.sourceId, used + 1)
  }
  if (chosen.size < max) {
    for (const item of byPriority) {
      if (chosen.size >= max) break
      if (!chosen.has(item.eventId)) chosen.set(item.eventId, item)
    }
  }
  return [...chosen.values()].sort((left, right) =>
    RANK[left.priority] - RANK[right.priority]
    || left.createdAt - right.createdAt
    || left.eventId.localeCompare(right.eventId))
}

/**
 * Collapse a run's attention proposals so one topic mutates once.
 *
 * A `create` followed by updates keeps the create as the action (the item
 * does not exist yet) while the later payload and status win; evidence is
 * unioned. Updates after a non-create keep the first expected revision —
 * later changes in the same run are applied sequentially by the Host.
 */
export function mergeAttentionChanges(changes: readonly AttentionChange[]): AttentionChange[] {
  const order: string[] = []
  const merged = new Map<string, AttentionChange>()
  for (const change of changes) {
    const existing = merged.get(change.topicKey)
    if (existing === undefined) {
      order.push(change.topicKey)
      merged.set(change.topicKey, { ...change })
      continue
    }
    const action = existing.action === 'create' ? 'create' : change.action
    const evidence = dedupeEvidence([...(existing.evidence ?? []), ...(change.evidence ?? [])])
    merged.set(change.topicKey, {
      ...change,
      action,
      expectedRevision: existing.expectedRevision,
      material: existing.material === true || change.material === true,
      evidence,
      title: change.title ?? existing.title,
      summary: change.summary ?? existing.summary,
      status: change.status ?? existing.status,
      itemId: existing.itemId ?? change.itemId,
    })
  }
  return order.flatMap((topic) => {
    const item = merged.get(topic)
    return item === undefined ? [] : [item]
  })
}

function dedupeEvidence(evidence: readonly AttentionEvidence[]): readonly AttentionEvidence[] {
  const seen = new Set<string>()
  const out: AttentionEvidence[] = []
  for (const item of evidence) {
    const key = `${item.eventId ?? ''}\u0000${item.itemId ?? ''}\u0000${item.quote ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= 50) break
  }
  return out
}

/** Collapse duplicate notification candidates per topic, keeping the loudest stage. */
export function mergeNotificationCandidates(
  candidates: readonly NotificationCandidate[],
): NotificationCandidate[] {
  const order: string[] = []
  const merged = new Map<string, NotificationCandidate>()
  for (const candidate of candidates) {
    const existing = merged.get(candidate.topicKey)
    if (existing === undefined) {
      order.push(candidate.topicKey)
      merged.set(candidate.topicKey, { ...candidate })
      continue
    }
    const existingStage = existing.reminderStage ?? 0
    const nextStage = candidate.reminderStage ?? 0
    merged.set(candidate.topicKey, {
      ...existing,
      reason: existing.reason === candidate.reason ? existing.reason : `${existing.reason}；${candidate.reason}`,
      itemIds: [...new Set([...(existing.itemIds ?? []), ...(candidate.itemIds ?? [])])],
      reminderStage: Math.max(existingStage, nextStage),
      kind: candidate.kind === 'reminder' || existing.kind === 'reminder' ? 'reminder' : 'update',
      body: existing.body ?? candidate.body,
      title: existing.title ?? candidate.title,
    })
  }
  return order.flatMap((topic) => {
    const item = merged.get(topic)
    return item === undefined ? [] : [item]
  })
}

/** Sort runs by urgency for the daily-budget check (higher first). */
export function priorityRank(priority: EffectivePriority): number {
  return RANK[priority]
}
