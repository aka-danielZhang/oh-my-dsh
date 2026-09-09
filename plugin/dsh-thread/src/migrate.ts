import type { ThreadLink } from './thread-types.ts'

/**
 * Migration of pre-0.3 Links whose single overloaded `state` mixed
 * authorization, publication, title handling, and delivery.
 *
 * The incident record (`failed` + `target-not-pristine` offending
 * `session/title` after an 80-byte truncating rename) migrates to a published
 * target with an unknown title: identity was fine, the title check was the only
 * thing that failed, and titles no longer gate activation. Re-activation
 * re-checks semantic purity, so genuinely diverged targets still surface.
 */

const TITLE_ONLY_OFFENDING = new Set(['session/title', 'session/title-unexpected'])

interface LegacyTraceEntry {
  step?: string
  ok?: boolean
  detail?: { offending?: unknown } & Record<string, unknown>
}

interface LegacyLinkShape {
  state?: unknown
  titleState?: unknown
  attempt?: { phase?: unknown; handoffId?: unknown; instructionId?: unknown } | null
  failure?: unknown
  trace?: unknown
  [key: string]: unknown
}

function titleOnlyFailure(raw: LegacyLinkShape): boolean {
  if (raw.failure !== 'target-not-pristine') return false
  const trace = Array.isArray(raw.trace) ? raw.trace as LegacyTraceEntry[] : []
  const last = [...trace].reverse().find(entry => entry?.ok === false)
  const offending = last?.detail?.offending
  return typeof offending === 'string' && TITLE_ONLY_OFFENDING.has(offending)
}

function legacyTitlePhase(state: unknown, requested: string | null): ThreadLink['title']['phase'] {
  switch (state) {
    case 'not-requested': return requested === null ? 'not-requested' : 'pending'
    case 'pending': return 'pending'
    // `applied` recorded only `ok: true`; the authoritative accepted title was
    // discarded, so reconciliation adopts the target's current title instead.
    case 'applied': return 'unknown'
    case 'failed': return 'failed'
    default: return requested === null ? 'not-requested' : 'unknown'
  }
}

function migratedFailure(raw: LegacyLinkShape): ThreadLink['failure'] {
  const code = typeof raw.failure === 'string' ? raw.failure : 'unknown'
  if (raw.state === 'uncertain') {
    return { phase: 'flush', code, recovery: 'resume', detail: null }
  }
  if (raw.state === 'failed') {
    // `creating`-side failures keep the reconcile path; re-activation re-checks
    // purity and marks genuinely diverged targets durably.
    return { phase: 'activate', code, recovery: 'reconcile', detail: null }
  }
  return null
}

/**
 * Rewrite one raw stored Link record into the orthogonal state model. Records
 * already written by this version pass through untouched; legacy records keep a
 * verbatim capture in `legacy` so boot can durably rewrite them exactly once.
 */
export function migrateLegacyLink(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw
  const record = raw as LegacyLinkShape
  const state = typeof record.state === 'string' ? record.state : undefined
  const titleState = typeof record.titleState === 'string' ? record.titleState : undefined
  if (state === undefined && titleState === undefined) return raw

  const requested = typeof record.title === 'string' ? record.title : null
  const legacyAttempt = record.attempt ?? {}
  const attemptPhase = typeof legacyAttempt.phase === 'string' ? legacyAttempt.phase : 'prepared'
  const handoffId = typeof legacyAttempt.handoffId === 'string' ? legacyAttempt.handoffId : null
  const instructionId = typeof legacyAttempt.instructionId === 'string' ? legacyAttempt.instructionId : null

  let targetPhase: ThreadLink['target']['phase']
  let deliveryPhase: ThreadLink['delivery']['phase']
  let relation: ThreadLink['relation']
  let relationCommit = record.relationCommit as ThreadLink['relationCommit']
  let failure = migratedFailure(record)

  switch (state) {
    case 'authorized':
      targetPhase = 'reserved'
      deliveryPhase = 'prepared'
      relation = 'pending'
      break
    case 'creating':
      targetPhase = 'creating'
      deliveryPhase = 'prepared'
      relation = 'pending'
      break
    case 'activating':
      targetPhase = 'published'
      deliveryPhase = attemptPhase === 'uncertain' ? 'uncertain' : 'submitting'
      relation = 'pending'
      relationCommit = null
      break
    case 'active':
      targetPhase = 'published'
      deliveryPhase = 'flushed'
      relation = 'active'
      failure = null
      break
    case 'uncertain':
      targetPhase = 'published'
      deliveryPhase = 'uncertain'
      relation = 'pending'
      relationCommit = null
      break
    case 'failed':
    default: {
      if (titleOnlyFailure(record)) {
        // The incident shape: the Session existed and was semantically
        // pristine; only the title equality check failed. Await re-activation.
        targetPhase = 'published'
        deliveryPhase = 'prepared'
        relation = 'pending'
        failure = null
      } else {
        // Creation side effects are unknown: reconcile by deterministic id.
        targetPhase = 'creating'
        deliveryPhase = 'prepared'
        relation = 'pending'
      }
      relationCommit = null
      break
    }
  }

  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    state: _state, titleState: _titleState, attempt: _attempt, title: _title,
    failure: _failure, relationCommit: _commit,
    ...rest
  } = record

  const titlePhase = legacyTitlePhase(titleState, requested)

  return {
    ...rest,
    target: { phase: targetPhase, fingerprint: null },
    title: {
      // A title-only pristine failure proves a session/title event exists;
      // the rename outcome was effectively lost, so defer to log adoption
      // instead of re-issuing a rename that would append a second event.
      phase: titlePhase === 'not-requested' ? titlePhase : titleOnlyFailure(record) ? 'unknown' : titlePhase,
      requested,
      accepted: null,
      eventSeq: null,
      failure: titleState === 'failed' && typeof record.failure === 'string'
        ? `title-rename: ${record.failure}`
        : null,
    },
    delivery: { phase: deliveryPhase, attempt: 0, handoffId, instructionId },
    relation,
    relationCommit,
    failure,
    legacy: {
      state: state ?? 'authorized',
      titleState: titleState ?? 'not-requested',
      attemptPhase: attemptPhase,
      failure: typeof record.failure === 'string' ? record.failure : null,
    },
  }
}

/** True while a migrated record still awaits its one durable rewrite. */
export function needsLegacyRewrite(link: ThreadLink): boolean {
  return link.legacy !== null
}

/** Clear the capture after the durable rewrite so boot work is once-only. */
export function clearLegacyCapture(link: ThreadLink, now: number): ThreadLink {
  return { ...link, legacy: null, updatedAt: now }
}
