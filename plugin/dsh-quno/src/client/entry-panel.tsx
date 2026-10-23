/**
 * The sidebar's Quno entry (design §13.2): a native main-panel row — the
 * shell owns the button, the label and the selected state, so it reads as one
 * of its own beside Plugins and Automations. The registered page is a
 * hand-off, not a destination: on mount it opens the one main conversation
 * and returns the layout to the Conversation view, which makes the row a
 * plain "open Quno" button (2026-10-23 reversal of the tab arrangement).
 *
 * @module dsh-quno/client/entry-panel
 */

import React from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'

/** Injected face of the entry panel (bound in client/index.tsx). */
export interface QunoEntryInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly openSession: (sessionId: string) => void
  /** Return the layout from this hand-off panel to the Conversation view. */
  readonly backToConversation: () => void
}

type EntryPanelProps = PropsRuntime<'main'> & QunoEntryInjected

/** Open the one main conversation, then hand the layout back. */
export function QunoEntryPanel(props: EntryPanelProps): React.ReactElement {
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const state = props.store.getSnapshot().state
        const sessionId = state?.main.sessionId ?? await props.store.ensureMain('')
        if (!alive) return
        props.openSession(sessionId)
        props.backToConversation()
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
    // Mount-only hand-off: the panel exists to run this once per activation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (error !== '') {
    return <div style={styles.holder}>{props.t('error', { error })}</div>
  }
  return <div style={styles.holder}>{props.t('loading')}</div>
}

/** The row glyph: the round Q mark, at the edge the sidebar asks for. */
export function QunoEntryGlyph({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: 999,
        background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
        fontSize: Math.round(size * 0.55), fontWeight: 700, lineHeight: 1,
        userSelect: 'none',
      }}
    >
      Q
    </span>
  )
}

const styles = {
  holder: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', padding: 24,
    fontSize: 13, color: 'var(--dsw-alias-label-secondary)',
  },
} as const
