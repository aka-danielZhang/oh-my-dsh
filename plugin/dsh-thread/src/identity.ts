import { createHash } from 'node:crypto'
import type { ThreadLink } from './thread-types.ts'

export interface ThreadIdentity {
  linkId: string
  targetSessionId: string
}

/** Derive the stable relation identity owned by one root Session. */
export function deriveThreadId(rootSessionId: string): string {
  const digest = createHash('sha256').update(`dsh-thread-root\0${rootSessionId}`, 'utf8').digest('hex')
  return `thread-root-${digest.slice(0, 32)}`
}

/** Derive one stable Link and target pair from an immutable Draft identity. */
export function deriveThreadIdentity(draftId: string): ThreadIdentity {
  const digest = createHash('sha256').update(`dsh-thread\0${draftId}`, 'utf8').digest('hex')
  return {
    linkId: `thread-${digest.slice(0, 32)}`,
    targetSessionId: `session-thread-${digest.slice(32)}`,
  }
}

export type ThreadIdDecision =
  | { ok: true; threadId: string }
  | { ok: false; error: 'thread-id-conflict'; threadIds: string[] }

/** Inherit one Thread identity across the Link component touching the source. */
export function resolveThreadId(sourceSessionId: string, links: readonly ThreadLink[]): ThreadIdDecision {
  const sessions = new Set([sourceSessionId])
  const component: ThreadLink[] = []
  let changed = true
  while (changed) {
    changed = false
    for (const link of links) {
      if (component.includes(link)) continue
      if (!sessions.has(link.sourceSessionId) && !sessions.has(link.targetSessionId)) continue
      component.push(link)
      if (!sessions.has(link.sourceSessionId)) {
        sessions.add(link.sourceSessionId)
        changed = true
      }
      if (!sessions.has(link.targetSessionId)) {
        sessions.add(link.targetSessionId)
        changed = true
      }
    }
  }

  const inherited = [...new Set(component.flatMap(link => link.threadId === null ? [] : [link.threadId]))].sort()
  if (inherited.length > 1) return { ok: false, error: 'thread-id-conflict', threadIds: inherited }
  if (inherited.length === 1) return { ok: true, threadId: inherited[0]! }

  const targets = new Set(component.map(link => link.targetSessionId))
  const roots = [...sessions].filter(sessionId => !targets.has(sessionId)).sort()
  return { ok: true, threadId: deriveThreadId(roots[0] ?? sourceSessionId) }
}

export type BeginCreationDecision =
  | { ok: true; link: ThreadLink; changed: boolean }
  | { ok: false; error: string; phase: ThreadLink['target']['phase'] }

/**
 * Apply the creation checkpoint without side effects.
 *
 * - relation already active, or target already published/diverged: no-op (ok).
 * - reserved → creating, stamping the single-flight action id.
 * - creating + same action id: transport replay, no-op.
 * - creating + new action id: allowed only after a recorded create failure
 *   whose recovery is `resume` (the stale in-flight fence must never deadlock
 *   recovery — the deterministic id makes re-issuing create safe); otherwise
 *   another window owns the attempt (`creation-in-flight`).
 */
export function advanceCreation(link: ThreadLink, actionId: string, now: number): BeginCreationDecision {
  if (link.relation === 'active') return { ok: true, link, changed: false }
  if (link.target.phase === 'published' || link.target.phase === 'diverged') {
    return { ok: true, link, changed: false }
  }
  if (link.target.phase === 'abandoned') {
    return { ok: false, error: 'link-abandoned', phase: link.target.phase }
  }
  if (link.target.phase === 'creating') {
    if (link.creationActionId === actionId) return { ok: true, link, changed: false }
    if (link.failure === null || link.failure.recovery !== 'resume') {
      return { ok: false, error: 'creation-in-flight', phase: link.target.phase }
    }
    return {
      ok: true,
      changed: true,
      link: {
        ...link,
        creationActionId: actionId,
        failure: null,
        updatedAt: now,
      },
    }
  }
  return {
    ok: true,
    changed: true,
    link: { ...link, target: { ...link.target, phase: 'creating' }, creationActionId: actionId, updatedAt: now },
  }
}
