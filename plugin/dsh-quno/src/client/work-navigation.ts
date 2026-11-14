/**
 * Client-only navigation between the Quno main conversation and a worker's
 * native session (design v2 §3, §9.3, §6.3).
 *
 * Navigation owns nothing durable: it never calls launch/resume/stop and
 * never writes the domain store — it only changes which session the shell
 * shows and remembers how to come back. The return context rides window-level
 * sessionStorage (v2 §3): losing it degrades to a plain return without scroll
 * restore, never to a stranded user — the main session id always comes from
 * the polled snapshot as the fallback.
 *
 * Keyboard/mouse discipline (v2 §6.3): mouse activation never steals focus;
 * keyboard activation (click `detail === 0`) moves focus to the promised
 * target — the worker header's back button on entry, the work entry button on
 * return, and the back button of a missing page.
 *
 * @module dsh-quno/client/work-navigation
 */

/** How the user left the main conversation (drives focus and panel restore). */
export type WorkerEntry = 'work-button' | 'worker-list'

/** What `backToQuno` restores (v2 §3). `scrollY` is best-effort only. */
export interface ReturnContext {
  readonly mainSessionId: string
  readonly workPanelOpen: boolean
  readonly scrollY: number | null
  readonly entry: WorkerEntry
  /** True when the activation came from the keyboard (focus may move). */
  readonly keyboard: boolean
}

/** Why a worker session could not be opened (v2 §5.4). */
export type WorkerOpenFailure =
  | 'unknown-ticket'
  | 'session-not-assigned'
  | 'detail-failed'

/** Structural shell faces the navigation needs. All duck-checked upstream. */
export interface WorkNavigationFaces {
  /** Show one session in the shell's main region. */
  readonly openSession: (sessionId: string) => void
  /** Hand the main region back to the Conversation view. */
  readonly selectMainPanel: () => void
  /** Open the right column on the work list. */
  readonly openWorkPanel: () => void
  /** Whether the right column currently shows the Quno panel. */
  readonly workPanelVisible: () => boolean
  /** Best-effort vertical scroll of the active conversation content. */
  readonly readMainScroll: () => number | null
  readonly restoreMainScroll: (y: number) => void
  /** Focus the「工作」entry button (keyboard returns only). */
  readonly focusWorkEntry: () => void
  /** Fallback main session id when the stored context is gone. */
  readonly fallbackMainSessionId: () => string | null
}

const STORAGE_KEY = 'dsh-quno/worker-return'
/** One-shot flag: the worker session header may move focus to its back button. */
const FOCUS_KEY = 'dsh-quno/worker-focus'

/**
 * Consume the one-shot entry-focus flag (v2 §6.3: entering a worker via the
 * keyboard moves focus to「返回 Quno」; mouse entry never steals focus).
 * @param storage - window sessionStorage or a test stub.
 * @returns true when a keyboard entry was recorded and is now consumed.
 */
export function consumeEntryFocus(storage: ReturnStorage | null): boolean {
  let raw: string | null = null
  try { raw = storage?.getItem(FOCUS_KEY) ?? null } catch { return false }
  if (raw === null) return false
  try { storage?.removeItem(FOCUS_KEY) } catch { /* already read */ }
  return raw === '1'
}

/** True when a click event was keyboard-activated (no pointer detail). */
export function isKeyboardActivation(event: { readonly detail?: number }): boolean {
  return (event.detail ?? 0) === 0
}

/** Encode one return context for sessionStorage (v2 §3). */
export function encodeReturnContext(context: ReturnContext): string {
  return JSON.stringify(context)
}

/** Decode a stored return context; garbage returns `null` (plain-return path). */
export function decodeReturnContext(raw: string | null): ReturnContext | null {
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const candidate = value as Record<string, unknown>
    if (typeof candidate.mainSessionId !== 'string' || candidate.mainSessionId === '') return null
    return {
      mainSessionId: candidate.mainSessionId,
      workPanelOpen: candidate.workPanelOpen === true,
      scrollY: typeof candidate.scrollY === 'number' ? candidate.scrollY : null,
      entry: candidate.entry === 'worker-list' ? 'worker-list' : 'work-button',
      keyboard: candidate.keyboard === true,
    }
  } catch {
    return null
  }
}

/** Why a worker session could not open, from a workerDetail outcome. */
export function workerOpenFailure(
  detail: { readonly ok: boolean; readonly value?: { readonly ticketId: string; readonly executorSessionId: string | null; readonly note?: string } } | null,
  ticketId: string,
): WorkerOpenFailure | null {
  if (detail === null || !detail.ok || detail.value === undefined) return 'detail-failed'
  if (detail.value.ticketId !== ticketId) return 'unknown-ticket'
  if (detail.value.executorSessionId === null) return 'session-not-assigned'
  return null
}

/** Session storage of this window, structural so tests can stub it. */
export interface ReturnStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Create the two navigation operations. Every face is injected; nothing here
 * reaches the network or the domain store directly.
 */
export function createWorkNavigation(
  faces: WorkNavigationFaces,
  storage: ReturnStorage | null,
): {
  /** Store the return context just before the shell switches sessions. */
  enterWorker(context: ReturnContext): void
  /** Return to the main conversation, restoring panel and scroll (v2 §9.3). */
  backToQuno(): { restored: boolean; keyboard: boolean; mainSessionId: string | null }
  /** Leave a missing-worker page: plain return, panel closes, entry refocuses. */
  returnToMainFromPanel(keyboard: boolean): void
} {
  return {
    enterWorker(context: ReturnContext): void {
      try { storage?.setItem(STORAGE_KEY, encodeReturnContext(context)) } catch { /* private mode: plain return later */ }
      if (context.keyboard) {
        try { storage?.setItem(FOCUS_KEY, '1') } catch { /* focus hint is best-effort */ }
      }
    },
    backToQuno(): { restored: boolean; keyboard: boolean; mainSessionId: string | null } {
      let context: ReturnContext | null = null
      try { context = decodeReturnContext(storage?.getItem(STORAGE_KEY) ?? null) } catch { context = null }
      try { storage?.removeItem(STORAGE_KEY) } catch { /* nothing to clear */ }
      const fallback = context === null
      const effective = context ?? {
        mainSessionId: faces.fallbackMainSessionId() ?? '',
        workPanelOpen: true,
        scrollY: null,
        entry: 'work-button' as const,
        keyboard: false,
      }
      if (effective.mainSessionId === '') return { restored: false, keyboard: false, mainSessionId: null }
      faces.openSession(effective.mainSessionId)
      if (effective.workPanelOpen) faces.openWorkPanel()
      else faces.selectMainPanel()
      if (effective.scrollY !== null) faces.restoreMainScroll(effective.scrollY)
      if (effective.keyboard) faces.focusWorkEntry()
      return { restored: !fallback, keyboard: effective.keyboard, mainSessionId: effective.mainSessionId }
    },
    returnToMainFromPanel(keyboard: boolean): void {
      const mainSessionId = faces.fallbackMainSessionId()
      if (mainSessionId !== null) faces.openSession(mainSessionId)
      faces.selectMainPanel()
      if (keyboard) faces.focusWorkEntry()
    },
  }
}
