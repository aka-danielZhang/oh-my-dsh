/**
 * Pure visibility predicate for the stop-while-running button, over the
 * minimal structural facts the InputZone owner share exposes. Kept DOM-free
 * so it unit-tests directly.
 *
 * 0.2.0 pivot: the 0.1.2-alpha composer keeps the primary as SEND while a
 * running ordinary session has draft content (`primaryStops` gained the
 * `empty || blocked` term), so the composer offers NO stop affordance in
 * exactly that state. This plugin now fills that gap: one extra Stop button
 * beside the Send primary, hidden whenever the stock primary already IS a
 * Stop.
 */

/**
 * The session facts this feature reads off the ConversationSnapshot owner
 * share (structural subset; the real snapshot satisfies it).
 */
export interface SessionFacts {
  /** Whether the session's turn is currently running. */
  readonly running: boolean
  /** Catalog-discovered continuation address; null for ordinary sessions. */
  readonly subagent: unknown
  /** Set after host/session-removed; input controls refuse interaction. */
  readonly removed: boolean
}

/**
 * The input facts this feature reads off the InputState owner share
 * (structural subset; the real machine state satisfies it).
 */
export interface InputFacts {
  /** Current draft text. */
  readonly draft: string
  /** Ordered runtime-only draft image ids; bytes stay in the controller. */
  readonly imageIds: readonly unknown[]
}

/**
 * When the extra Stop button must be visible: an ordinary session
 * (running, no subagent continuation address, not removed) whose draft has
 * content — the one state where the stock composer primary stays SEND and
 * the trailing row offers no Stop at all (the draft's content keeps
 * `primaryStops` false, and a continuable child's independent Stop only
 * exists for subagent sessions, which are excluded here). When the draft
 * empties, the stock primary flips back to Stop and this button stands
 * down, so the two never duplicate.
 *
 * Known edge (accepted): while the composer is blocked (`routable ===
 * false`) the stock primary is also a Stop regardless of the draft, and
 * this seat cannot see the block — a running + blocked + non-empty-draft
 * session would briefly show two Stops. A running turn implies the route
 * was servable, so the overlap is transient at worst.
 * @param session - structural session facts.
 * @param input - structural input facts.
 * @returns true when the button should render.
 */
export function stopButtonVisible(session: SessionFacts, input: InputFacts): boolean {
  if (!session.running) return false
  if (session.subagent !== null && session.subagent !== undefined) return false
  if (session.removed) return false
  return input.draft.trim() !== '' || input.imageIds.length > 0
}
