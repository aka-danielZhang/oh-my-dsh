/**
 * Attention lifecycle: applying a run's proposals and the user's explicit
 * commands under revision compare-and-swap.
 *
 * Two hard rules (design §9): a background run may never overwrite a newer
 * user state, and evidence supplementation is not a material change worth a
 * new notification.
 *
 * @module dsh-quno/attention
 */

import type { QunoStore } from './store.ts'
import type { AttentionAct } from './contracts.ts'
import type {
  AttentionChange,
  AttentionItemRecord,
  AttentionStatus,
  RunId,
} from './types.ts'
import { mergeAttentionChanges } from './selection.ts'

/** A commit refusal with a stable reason the runner can classify. */
export class AttentionCommitError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AttentionCommitError'
  }
}

/** Result of applying one run's proposals. */
export interface AttentionApplyResult {
  readonly items: readonly AttentionItemRecord[]
  /** Topics whose material revision increased (notification-eligible). */
  readonly materialTopics: ReadonlySet<string>
  /** Topics touched at all (diagnostics). */
  readonly touchedTopics: ReadonlySet<string>
}

/** Validate timestamps the model proposes before they reach durable state. */
function assertReviewTime(value: number | null | undefined, now: number, field: string): void {
  if (value === null || value === undefined) return
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new AttentionCommitError('invalid-change', `${field} must be an epoch millisecond integer`)
  }
  if (value < now - 24 * 60 * 60_000 || value > now + 366 * 24 * 60 * 60_000) {
    throw new AttentionCommitError('invalid-change', `${field} is outside the plausible window`)
  }
}

/**
 * Apply one run's attention proposals inside the caller's transaction.
 * @throws {AttentionCommitError} on a stale revision, unknown item, or invalid change.
 */
export function applyAttentionChanges(
  store: QunoStore,
  qunoId: string,
  changes: readonly AttentionChange[],
  runId: RunId,
  now: number,
): AttentionApplyResult {
  const merged = mergeAttentionChanges(changes)
  const materialTopics = new Set<string>()
  const touchedTopics = new Set<string>()
  const items: AttentionItemRecord[] = []

  for (const change of merged) {
    touchedTopics.add(change.topicKey)
    if (change.action === 'create') {
      if (change.title === undefined || change.title.trim() === '') {
        throw new AttentionCommitError('invalid-change', `create "${change.topicKey}" needs a title`)
      }
      if (change.summary === undefined || change.summary.trim() === '') {
        throw new AttentionCommitError('invalid-change', `create "${change.topicKey}" needs a summary`)
      }
      assertReviewTime(change.nextReviewAt, now, 'nextReviewAt')
      const existing = store.getAttentionByTopic(qunoId, change.topicKey)
      if (existing !== undefined) {
        const updated = store.updateAttentionCas({
          id: existing.id,
          expectedRevision: existing.revision,
          patch: {
            title: change.title,
            summary: change.summary,
            status: change.status ?? existing.status,
            material: change.material === true,
            subjectRefs: change.subjectRefs ?? existing.subjectRefs,
            evidence: change.evidence ?? existing.evidence,
            nextReviewAt: change.nextReviewAt === undefined ? existing.nextReviewAt : change.nextReviewAt,
            snoozedUntil: change.snoozedUntil === undefined ? existing.snoozedUntil : change.snoozedUntil,
          },
          cause: `run:${runId}`,
          runId,
          now,
        })
        if (updated === undefined) {
          throw new AttentionCommitError('revision-conflict', `item "${change.topicKey}" changed concurrently`)
        }
        items.push(updated)
        if (change.material === true) materialTopics.add(change.topicKey)
        continue
      }
      const created = store.insertAttention({
        qunoId,
        topicKey: change.topicKey,
        title: change.title,
        summary: change.summary,
        status: change.status ?? 'open',
        subjectRefs: change.subjectRefs ?? [],
        evidence: change.evidence ?? [],
        nextReviewAt: change.nextReviewAt ?? null,
        snoozedUntil: change.snoozedUntil ?? null,
        material: change.material ?? true,
        cause: `run:${runId}`,
        runId,
        now,
      })
      items.push(created)
      materialTopics.add(change.topicKey)
      continue
    }

    const target = resolveTarget(store, qunoId, change)
    const expected = change.expectedRevision
    if (expected === undefined) {
      throw new AttentionCommitError('invalid-change', `${change.action} "${change.topicKey}" needs expectedRevision`)
    }
    if (target.revision !== expected) {
      throw new AttentionCommitError('revision-conflict', `item "${change.topicKey}" is at revision ${String(target.revision)}, not ${String(expected)}`)
    }
    assertReviewTime(change.nextReviewAt, now, 'nextReviewAt')
    assertReviewTime(change.snoozedUntil, now, 'snoozedUntil')

    const status = statusFor(change, target.status, now)
    const nextReviewAt = change.nextReviewAt === undefined
      ? (status === 'snoozed' ? target.snoozedUntil : target.nextReviewAt)
      : change.nextReviewAt
    const snoozedUntil = change.snoozedUntil === undefined ? target.snoozedUntil : change.snoozedUntil
    const updated = store.updateAttentionCas({
      id: target.id,
      expectedRevision: target.revision,
      patch: {
        title: change.title,
        summary: change.summary,
        status,
        material: change.material === true,
        subjectRefs: change.subjectRefs,
        evidence: change.evidence,
        nextReviewAt,
        snoozedUntil,
      },
      cause: `run:${runId}:${change.action}`,
      runId,
      now,
    })
    if (updated === undefined) {
      throw new AttentionCommitError('revision-conflict', `item "${change.topicKey}" changed concurrently`)
    }
    items.push(updated)
    if (change.material === true) materialTopics.add(change.topicKey)
  }
  return { items, materialTopics, touchedTopics }
}

function resolveTarget(
  store: QunoStore,
  qunoId: string,
  change: AttentionChange,
): AttentionItemRecord {
  const byId = change.itemId === undefined ? undefined : store.getAttentionItem(change.itemId)
  if (byId !== undefined && byId.qunoId === qunoId) return byId
  const byTopic = store.getAttentionByTopic(qunoId, change.topicKey)
  if (byTopic !== undefined) return byTopic
  throw new AttentionCommitError('not-found', `attention item "${change.itemId ?? change.topicKey}" does not exist`)
}

function statusFor(change: AttentionChange, current: AttentionStatus, now: number): AttentionStatus {
  switch (change.action) {
    case 'resolve': return 'resolved'
    case 'dismiss': return 'dismissed'
    case 'expire': return 'expired'
    case 'wait': return 'waiting'
    case 'snooze': return 'snoozed'
    case 'update': {
      if (change.status !== undefined) {
        if (change.status === 'snoozed' && change.snoozedUntil === undefined && change.nextReviewAt == null) {
          throw new AttentionCommitError('invalid-change', 'snoozing needs snoozedUntil or nextReviewAt')
        }
        return change.status
      }
      return current
    }
    default:
      void now
      return current
  }
}

/** Result of one user action. */
export interface UserActionResult {
  readonly item: AttentionItemRecord
  readonly statusChanged: boolean
}

/**
 * Apply one explicit user decision (button or management tool).
 * @throws {AttentionCommitError} on a stale revision or unknown item.
 */
export function applyUserAction(
  store: QunoStore,
  qunoId: string,
  act: AttentionAct,
  channel: 'button' | 'natural',
  now: number,
): UserActionResult {
  const item = store.getAttentionItem(act.itemId)
  if (item === undefined || item.qunoId !== qunoId) {
    throw new AttentionCommitError('not-found', `attention item "${act.itemId}" does not exist`)
  }
  if (act.expectedRevision !== undefined && item.revision !== act.expectedRevision) {
    throw new AttentionCommitError('revision-conflict', `item is at revision ${String(item.revision)}, not ${String(act.expectedRevision)}`)
  }
  const snoozeUntil = act.snoozeMinutes === undefined ? null : now + act.snoozeMinutes * 60_000
  const next = ((): { status: AttentionStatus; snoozedUntil: number | null; nextReviewAt: number | null } => {
    switch (act.action) {
      case 'processed': return { status: 'resolved', snoozedUntil: null, nextReviewAt: null }
      case 'dismiss': return { status: 'dismissed', snoozedUntil: null, nextReviewAt: null }
      case 'later': {
        const until = snoozeUntil ?? now + 60 * 60_000
        return { status: 'snoozed', snoozedUntil: until, nextReviewAt: until }
      }
      case 'resume': return { status: 'open', snoozedUntil: null, nextReviewAt: item.nextReviewAt }
      case 'clarify': return { status: item.status, snoozedUntil: item.snoozedUntil, nextReviewAt: item.nextReviewAt }
    }
  })()
  const statusChanged = next.status !== item.status
  const updated = statusChanged
    ? store.updateAttentionCas({
      id: item.id,
      expectedRevision: item.revision,
      patch: { status: next.status, snoozedUntil: next.snoozedUntil, nextReviewAt: next.nextReviewAt },
      cause: `user:${act.action}`,
      runId: null,
      now,
    })
    : item
  const result = updated ?? (() => {
    throw new AttentionCommitError('revision-conflict', 'the item changed while the action was applied')
  })()
  store.insertFeedback({
    qunoId,
    itemId: item.id,
    topicKey: item.topicKey,
    action: act.action,
    note: act.note ?? null,
    revision: result.revision,
    channel,
    now,
  })
  if (result.status === 'resolved' || result.status === 'dismissed') {
    store.suppressPendingNoticesForTopic(qunoId, item.topicKey, `user-${act.action}`, now)
  }
  return { item: result, statusChanged }
}

/** The active attention statuses a Superseding user action should clear. */
export const ACTIONABLE_STATUSES: readonly AttentionStatus[] = ['open', 'waiting', 'snoozed']
