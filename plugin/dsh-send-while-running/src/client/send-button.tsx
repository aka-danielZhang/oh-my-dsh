/**
 * The extra Stop button, browser half: one additive `conversation.input.right`
 * list entry rendered exactly while an ordinary session's turn is running and
 * the draft has content — the state where the 0.1.2-alpha stock composer keeps
 * the primary as Send (`primaryStops` gained the `empty || blocked` term) and
 * offers NO stop affordance anywhere in the trailing row. Clicking goes
 * through the same session-scoped conversation `cancel()` the stock stop
 * prop wires, handed to the component by the registration's per-session
 * `inject`.
 */
import type { ReactElement } from 'react'
import type { InputFacts, SessionFacts } from './facts.ts'
import { stopButtonVisible } from './facts.ts'

/** The stock composer stop glyph (rounded rect), mirrored 1:1. */
const STOP_RECT_ATTRS = { x: 3, y: 3, width: 10, height: 10, rx: 3 } as const

/** Locale seat share (structural subset of the framework-injected t). */
type TranslateLabel = (key: 'stop.label') => string

/**
 * Component props: the InputZone owner share (`session`, `input`), the
 * registration-injected interrupt verb, and the locale seat — all optional
 * structural subsets so the composed contract stays assignable; absent
 * shares render nothing (fail-invisible, never a crash).
 */
export interface StopWhileRunningProps {
  /** Point-in-time ConversationSnapshot share the slot dispatches with. */
  readonly session?: SessionFacts
  /** Point-in-time InputState share the slot dispatches with. */
  readonly input?: InputFacts
  /** Cancel the running turn — the stock stop prop's exact RPC path. */
  readonly interrupt?: () => void
  /** Locale seat bound by the `locale:` registration option. */
  readonly t?: TranslateLabel
}

/** Fallback label when the locale seat is somehow absent. */
const FALLBACK_LABEL = 'Stop'

/**
 * The Stop beside the Send primary.
 * @param props - owner share + interrupt verb + locale seat.
 * @returns the button element, or null whenever the visibility terms fail.
 */
export function StopWhileRunningButton(props: StopWhileRunningProps): ReactElement | null {
  const { session, input, interrupt, t } = props
  if (session === undefined || input === undefined || interrupt === undefined) return null
  if (!stopButtonVisible(session, input)) return null
  const label = t === undefined ? FALLBACK_LABEL : t('stop.label')
  return (
    <button
      type="button"
      className="dsh-stop-while-running"
      aria-label={label}
      title={label}
      // The stock stop never disables on machine-busy phases (only on a
      // missing stop verb, which this seat models by rendering nothing).
      onMouseDown={(e) => { e.preventDefault() }}
      onClick={interrupt}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
        <rect {...STOP_RECT_ATTRS} fill="currentColor" />
      </svg>
    </button>
  )
}
