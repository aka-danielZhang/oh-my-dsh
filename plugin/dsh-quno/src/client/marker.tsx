/**
 * Quno main-conversation identification and chrome cleanup (design §13.3).
 *
 * Two session-scoped entries cooperate:
 *
 * 1. A `conversation.session.header.utilities` entry whose component renders a
 *    hidden sentinel and, when the session's `agentPreset` projection resolves
 *    to `quno`, stamps `data-quno-main` on the enclosing
 *    `[data-slot="main.conversation"]` anchor — the common ancestor of header,
 *    content and composer, so the seam CSS can hide chrome across all of them.
 *    A pending projection never marks, and unmount (session switch, disable)
 *    always clears the claim it owns.
 * 2. A same-id (`agent-preset`), lower-priority (-1) shadow of the stock
 *    header preset label (copy-session-id precedent): null on a Quno main
 *    conversation, a plain-text preset echo elsewhere. The stock entry stays
 *    on the ledger and resumes the moment this fiber is disposed.
 *
 * @module dsh-quno/client/marker
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `agentPreset` SessionProjectionMap merge into this program.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'

/** Standard session props these entries read. */
type SessionSlotProps = PropsRuntime<'conversation.session.header.utilities'>

/** The minimal face the marker needs from any session-scoped seat. */
export interface QunoMarkerProps {
  readonly sessionId: SessionSlotProps['sessionId']
  readonly useSessions: SessionSlotProps['useSessions']
}

/** Read the session's resolved preset id: 'quno' | other id | null (composed none) | undefined (projection pending). */
export function useSessionPreset(props: Pick<QunoMarkerProps, 'sessionId' | 'useSessions'>): string | null | undefined {
  return props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
}

/** Render the hidden sentinel that maintains the `data-quno-main` claim. */
export function QunoMainMarker(props: QunoMarkerProps): React.ReactElement {
  const sentinel = React.useRef<HTMLSpanElement | null>(null)
  const preset = useSessionPreset(props)
  const token = React.useRef(`quno-${Math.random().toString(36).slice(2)}`)
  const marked = React.useRef<HTMLElement | null>(null)

  React.useLayoutEffect(() => {
    const isQuno = preset === 'quno'
    const element = isQuno && sentinel.current !== null
      ? sentinel.current.closest<HTMLElement>('[data-slot="main.conversation"]')
      : null
    const inMainColumn = element !== null
      && element.closest('[data-sidebar-right-session]') === null
      && element.querySelector('[data-slot="conversation.session.header"]') !== null
    const target: HTMLElement | null = inMainColumn ? element : null
    if (marked.current !== null && marked.current !== target) {
      // Release only a claim we still own; another occurrence may have taken it.
      if (marked.current.dataset.qunoMainOwner === token.current) {
        delete marked.current.dataset.qunoMain
        delete marked.current.dataset.qunoMainOwner
      }
      marked.current = null
    }
    if (target !== null && marked.current !== target) {
      target.dataset.qunoMain = 'main'
      target.dataset.qunoMainOwner = token.current
      marked.current = target
    }
    return () => {
      const owner = marked.current
      marked.current = null
      if (owner !== null && owner.dataset.qunoMainOwner === token.current) {
        delete owner.dataset.qunoMain
        delete owner.dataset.qunoMainOwner
      }
    }
  }, [preset, props.sessionId])

  return <span ref={sentinel} hidden aria-hidden="true" data-quno-main-sentinel="" />
}

/** Shadow of the stock header preset label: null on Quno, plain echo elsewhere. */
export function QunoPresetLabelShadow(props: PropsRuntime<'conversation.session.header.actions'>): React.ReactElement | null {
  const preset = props.useSessions(state => state.byId[props.sessionId]?.projectionValues?.agentPreset)
  if (typeof preset !== 'string' || preset === 'quno') return null
  return <span style={styles.label} title={preset}>{preset}</span>
}

const styles = {
  label: {
    display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12,
    color: 'var(--dsw-alias-label-secondary)', maxWidth: 220, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
} as const
