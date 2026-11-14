/**
 * Where the in-conversation capsule is allowed to live.
 *
 * The slot registration provides the session context, but the visible pill
 * must not sit in the header's button row. It is portaled into the session's
 * own `[data-conversation-content]` container, which is `position: relative`,
 * scroll-independent and outside the header — so no fixed positioning, no
 * header-height measurements and no drift when the sidebars resize.
 *
 * The lookups below are deliberately strict: a conversation embedded in the
 * right sidebar, or a retained session that is not the one this slot belongs
 * to, must never receive a portal.
 *
 * @module dsh-quno/client/capsule-anchor
 */

/** The native content container that hosts the transcript and the composer. */
export const CONVERSATION_CONTENT_SELECTOR = '[data-conversation-content]'

/** Session id stamped onto that container by the native shell. */
export const CONVERSATION_SESSION_ATTR = 'data-conversation-session'

/** Any right-sidebar session subtree; an embedded conversation lives inside it. */
export const RIGHT_PANEL_SESSION_SELECTOR = '[data-sidebar-right-session]'

/** A dockkit floating pane. */
export const DOCK_FLOAT_SELECTOR = '[data-dockkit-float]'

/** Marker the Quno panel puts on its own root, used to detect a floating tab. */
export const QUNO_PANEL_MARKER = '[data-quno-panel]'

/** Structural sliver of an element, so the predicate stays testable. */
export interface AnchorCandidate {
  getAttribute(name: string): string | null
  closest(selector: string): unknown
}

/**
 * Whether a candidate content container belongs to this session's main pane.
 * Rejects anything nested in a right-sidebar session (the embedded copy).
 * @param candidate - an element or a structural stand-in.
 * @param sessionId - the slot's session id.
 * @returns true only for the main-pane container of this session.
 */
export function isSessionContent(candidate: AnchorCandidate | null, sessionId: string): boolean {
  if (candidate === null) return false
  if (candidate.getAttribute(CONVERSATION_SESSION_ATTR) !== sessionId) return false
  return candidate.closest(RIGHT_PANEL_SESSION_SELECTOR) === null
}

/**
 * Find the content container the capsule should portal into.
 *
 * Resolution order:
 * 1. the sentinel itself is already inside a valid container;
 * 2. the nearest `main.conversation` ancestor owns one;
 * 3. walk up until an ancestor contains one (never crossing into a right panel).
 * @param sentinel - the hidden element rendered by the slot component.
 * @param sessionId - the slot's session id.
 * @returns the content element, or null when no safe anchor exists.
 */
export function findConversationContent(sentinel: Element | null, sessionId: string): HTMLElement | null {
  if (sentinel === null || typeof document === 'undefined') return null

  const own = sentinel.closest(CONVERSATION_CONTENT_SELECTOR)
  if (isSessionContent(own, sessionId)) return own as HTMLElement

  const main = sentinel.closest('[data-slot="main.conversation"]')
  if (main !== null) {
    for (const candidate of main.querySelectorAll(CONVERSATION_CONTENT_SELECTOR)) {
      if (isSessionContent(candidate, sessionId)) return candidate as HTMLElement
    }
  }

  for (let node = sentinel.parentElement; node !== null; node = node.parentElement) {
    if (node.closest(RIGHT_PANEL_SESSION_SELECTOR) !== null) return null
    for (const candidate of node.querySelectorAll(CONVERSATION_CONTENT_SELECTOR)) {
      if (isSessionContent(candidate, sessionId)) return candidate as HTMLElement
    }
  }
  return null
}

/** Escape a session id for use inside an attribute selector. */
export function escapeSelector(value: string): string {
  const escape = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS?.escape
  if (typeof escape === 'function') return escape(value)
  return value.replace(/["\\\]]/g, match => `\\${match}`)
}

/** The right-sidebar session root for this session, if mounted. */
function rightPanelRoot(sessionId: string): Element | null {
  if (typeof document === 'undefined') return null
  return document.querySelector(`[data-sidebar-right-session="${escapeSelector(sessionId)}"]`)
}

/** Whether this session's right panel is expanded (docked or fullscreen). */
export function isRightPanelOpen(sessionId: string): boolean {
  const root = rightPanelRoot(sessionId)
  return root !== null && root.hasAttribute('data-sidebar-right-open')
}

/**
 * Whether the Quno panel is visible for this session. A floating pane stays
 * visible while the docked column is collapsed, so `keepMounted` DOM alone is
 * not enough: the float must actually contain our panel marker.
 * @param sessionId - the session to inspect.
 * @returns true when the panel occupies screen space for this session.
 */
export function isQunoPanelVisible(sessionId: string): boolean {
  const root = rightPanelRoot(sessionId)
  if (root === null) return false
  if (root.hasAttribute('data-sidebar-right-open')) return true
  return root.querySelector(`${DOCK_FLOAT_SELECTOR} ${QUNO_PANEL_MARKER}`) !== null
}

/** Size of the content container, used for the flyout's width/height caps. */
export interface CapsuleGeometry {
  readonly width: number
  readonly height: number
}

/** Read the anchor's current box; zero before layout settles. */
export function readGeometry(content: HTMLElement): CapsuleGeometry {
  return { width: content.clientWidth, height: content.clientHeight }
}

/**
 * Whether the column is too narrow for the full pill (icon + three counts).
 * @param width - the content container's width in px.
 * @returns true for the compact one-number pill.
 */
export function isCompactCapsule(width: number): boolean {
  return width > 0 && width < 480
}
