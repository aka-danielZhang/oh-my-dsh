/**
 * The healing decision core. Everything here is a pure function over
 * plain data so the restore policy is exhaustively testable; the event
 * wiring lives in src/index.ts.
 *
 * The invariant the decision enforces: evidence alone never authorizes.
 * A restore happens only when the live provider's stat reports the very
 * same freshness token the record holds — i.e. the file provably did not
 * change since the remembered observation. Anything else falls through to
 * the stock policy (which keeps demanding a read).
 * @module dsh-fs-observation-log/heal
 */

/**
 * Minimal structural view of a session header: all the identity this plugin
 * needs. The real `SessionHeader` (dsh-session) contains these fields; the
 * narrowing stays structural so no harness value import exists at runtime.
 */
export interface SessionHeaderView {
  readonly id?: unknown
  /** The fork parent, persisted in sidecar headers; healing ignores it. */
  readonly parentSession?: unknown
}

/** The acting session ids considered for healing: the session itself. */
export type Lineage = readonly string[]

/**
 * Resolve the evidence a session may heal from: its own sidecar only.
 *
 * Ancestor healing is deliberately gone. A sidecar records WHEN a read
 * happened, not WHERE in the transcript it sits, so a parent's evidence
 * recorded after the fork cut is indistinguishable from inherited reads —
 * a child could heal an edit its transcript never observed. Until evidence
 * records carry the fork-cut bound, cross-session healing is out of scope;
 * the sidecar header still persists the fork parent (reserved) so a future
 * cut-bound scheme can resolve lineages without a format change.
 * @param header - the acting session's header view.
 * @returns the session's own id, or empty when the header carries no usable
 *   id (a non-agent caller).
 */
export function sessionLineage(header: SessionHeaderView): Lineage {
  const self = header.id
  if (typeof self !== 'string' || self.length === 0) return []
  return [self]
}

/** What the live provider reported about the target right now. */
export interface LiveStat {
  /** The target's current freshness token; undefined when the target is absent. */
  version?: string
}

/** Why a restore was skipped — surfaced in debug logging only. */
export type HealDecision =
  | { kind: 'restore'; version: string; fromSession: string }
  | { kind: 'skip'; reason: 'live-observed' | 'no-evidence' | 'target-absent' | 'version-changed' }

/**
 * Decide whether the stock policy's missing observation may be restored.
 *
 * Order of checks (each can veto):
 * 1. `liveRecord` — this process already observed the target for the acting
 *    session; the stock policy has it too and there is nothing to heal.
 * 2. `evidence` — no record ever observed the target; nothing to restore,
 *    the stock policy's demand for a read stands.
 * 3. `stat.version` undefined — the target does not exist right now; let the
 *    stock policy answer `FS_NOT_FOUND` semantics for itself.
 * 4. `stat.version !== evidence.version` — the file changed since the
 *    remembered observation; the evidence is stale, the guard must demand a
 *    fresh read.
 * 5. Otherwise restore: re-emit `present` at the live token.
 *
 * @param liveRecord - this process's mirror entry for the acting session.
 * @param evidence - the session's stored hit, when any.
 * @param stat - the provider stat performed moments ago.
 */
export function healDecision(liveRecord: unknown, evidence: { version: string; sessionId: string } | undefined, stat: LiveStat): HealDecision {
  if (liveRecord !== undefined) return { kind: 'skip', reason: 'live-observed' }
  if (evidence === undefined) return { kind: 'skip', reason: 'no-evidence' }
  if (stat.version === undefined) return { kind: 'skip', reason: 'target-absent' }
  if (stat.version !== evidence.version) return { kind: 'skip', reason: 'version-changed' }
  return { kind: 'restore', version: stat.version, fromSession: evidence.sessionId }
}
