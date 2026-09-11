/**
 * Structural face of the stock session-log-export download controller
 * (`ctx.provide('sessionLogDownload', …)` in @deepseek-ai/dsh-session-log-export).
 *
 * Cross-plugin collaboration goes through the cordis service, never an
 * import of the other plugin's implementation — so the face here is a
 * duck-checked structural mirror of the stock controller: a runtime whose
 * controller shape drifts resolves to `undefined` and this plugin degrades
 * to a copy-only menu instead of crashing the header.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Download phases presented by the shared status dialog (stock contract). */
export type SessionLogStatus = 'downloading' | 'success' | 'error'

/** One Session's current download-dialog state (stock contract). */
export interface SessionLogEntry {
  readonly open: boolean
  readonly status: SessionLogStatus
  readonly error: string | null
}

/** The controller's published state shape (stock contract). */
export interface SessionLogStateSlice {
  readonly bySession: Readonly<Record<string, SessionLogEntry | undefined>>
}

/** Structural mirror of the stock controller's face this plugin consumes. */
export interface SessionLogControllerLike {
  readonly store: {
    getSnapshot(): SessionLogStateSlice
    subscribe(listener: () => void): () => void
  }
  download(sessionId: SessionId): Promise<void>
  dismiss(sessionId: SessionId): void
}

/**
 * Duck-check a candidate against the stock controller's face: every consumed
 * member must be present and callable, so a shape drift reads as "absent"
 * (copy-only menu) instead of a TypeError mid-render.
 * @param value - whatever `ctx.get('sessionLogDownload')` returned.
 * @returns the controller face, or undefined when absent/malformed.
 */
export function isSessionLogController(value: unknown): value is SessionLogControllerLike {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionLogControllerLike>
  const store = candidate.store as Partial<SessionLogControllerLike['store']> | undefined
  if (typeof store !== 'object' || store === null) return false
  if (typeof store.getSnapshot !== 'function' || typeof store.subscribe !== 'function') return false
  return typeof candidate.download === 'function' && typeof candidate.dismiss === 'function'
}

/**
 * Soft-resolve the stock download controller off the client context.
 * @param ctx - the client root context.
 * @returns the controller face, or undefined when the stock plugin is not
 * mounted (or its shape drifted) — the menu then offers copy only.
 */
export function sessionLogControllerOf(ctx: ClientContext): SessionLogControllerLike | undefined {
  const candidate: unknown = ctx.get('sessionLogDownload')
  return isSessionLogController(candidate) ? candidate : undefined
}

/**
 * The per-session action face injected into the header menu component: lazy
 * accessors over the stock controller (resolved at call time, never at
 * register time — mount order must not matter) plus a Cordis-timer-backed
 * `defer` for the copied flash and the success auto-close.
 */
export interface SessionLogActions {
  /**
   * The Session this face was built for (the slot's inject factory receives
   * the framework-resolved id as a plain string; the controller call below
   * re-brands it). The composed component props do not carry the id — so the
   * header component reads it from here.
   */
  readonly sessionId: string
  /** Whether the stock controller was reachable when the face was built. */
  readonly downloadAvailable: boolean
  /** Start one stock download (deduplicated by the controller per session). */
  download(): void
  /** Close the stock status dialog (does not cancel an in-flight download). */
  dismiss(): void
  /** Current dialog entry for this session, or null when none. */
  readDownload(): SessionLogEntry | null
  /** Subscribe to the controller's state; returns the unsubscribe disposer. */
  subscribeDownload(listener: () => void): () => void
  /** Cordis timer one-shot; returns the cancel disposer. */
  defer(fn: () => void, ms: number): () => void
}

/**
 * Build the injected face for one Session (called by the slot registration's
 * per-session `inject`).
 * @param ctx - the client root context (controllers resolve lazily inside).
 * @param sessionId - the session the header is rendering.
 * @param defer - the Cordis timer one-shot bound to this fiber.
 * @returns the action face.
 */
export function buildSessionLogActions(ctx: ClientContext, sessionId: string, defer: (fn: () => void, ms: number) => () => void): SessionLogActions {
  // The inject factory hands the session id over as a plain string; the
  // controller's contract takes the branded SessionId — one boundary cast.
  const id = sessionId as SessionId
  const readDownload = (): SessionLogEntry | null => {
    const entry = sessionLogControllerOf(ctx)?.store.getSnapshot().bySession[sessionId]
    return entry ?? null
  }
  return {
    sessionId,
    downloadAvailable: sessionLogControllerOf(ctx) !== undefined,
    download: () => {
      void sessionLogControllerOf(ctx)?.download(id)
    },
    dismiss: () => {
      sessionLogControllerOf(ctx)?.dismiss(id)
    },
    readDownload,
    subscribeDownload: (listener: () => void) => sessionLogControllerOf(ctx)?.store.subscribe(listener) ?? (() => {}),
    defer,
  }
}
