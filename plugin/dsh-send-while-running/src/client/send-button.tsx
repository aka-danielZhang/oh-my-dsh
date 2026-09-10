/**
 * The extra Stop button, browser half: one additive `conversation.input.right`
 * list entry rendered exactly while an ordinary session's turn is running and
 * the draft has content — the state where the 0.1.2-alpha stock composer keeps
 * the primary as Send (`primaryStops` gained the `empty || blocked` term) and
 * offers NO stop affordance anywhere in the trailing row. Session and input
 * state arrive through the framework's session-standard hooks (`useSession`,
 * `useInput`); clicking goes through the same session-scoped conversation
 * `cancel()` the stock stop prop wires, handed to the component by the
 * registration's per-session `inject`.
 */
import type { ReactElement } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-conversation's SlotMap declarations (the
// 'conversation.input.right' list seat) and the session standard kit merge
// (`useInput`); ui-session's merge supplies `useSession`.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InputFacts, SessionFacts } from './facts.ts'
import { stopButtonVisible } from './facts.ts'

/** The stock composer stop glyph (rounded rect), mirrored 1:1. */
const STOP_RECT_ATTRS = { x: 3, y: 3, width: 10, height: 10, rx: 3 } as const

/** Cancel the running turn — the stock stop prop's exact RPC path. */
export interface StopWhileRunningInjected {
  /** Cancel the running turn through the scoped conversation service. */
  interrupt(): void
}

/** Full composed props: the framework runtime share + inject face + locale seat. */
export type StopWhileRunningProps =
  & PropsRuntime<'conversation.input.right'>
  & PropsLocale<'send-while-running'>
  & InjectFace<StopWhileRunningInjected>

/**
 * The Stop beside the Send primary.
 * @param props - framework runtime share (session-standard hooks) + interrupt verb + locale seat.
 * @returns the button element, or null whenever the visibility terms fail.
 */
export function StopWhileRunningButton({ useSession, useInput, interrupt, t }: StopWhileRunningProps): ReactElement | null {
  const session = useSession(s => s)
  const input = useInput(s => s)
  if (!stopButtonVisible(session, input)) return null
  const label = t('stop.label')
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
