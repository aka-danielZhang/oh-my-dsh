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
import { QunoMark } from './quno-mark.tsx'

/** Injected face of the entry panel (bound in client/index.tsx). */
export interface QunoEntryInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly openSession: (sessionId: string) => void
  /** Return the layout from this hand-off panel to the Conversation view. */
  readonly backToConversation: () => void
  /** First sidebar workspace, so the chat opens ready to type. */
  readonly defaultWorkspaceId?: () => string | undefined
}

type EntryPanelProps = PropsRuntime<'main'> & QunoEntryInjected

/**
 * The slot framework contains entry render crashes silently (keyed entries
 * abdicate one-shot), which turns a broken hand-off into a dead sidebar row.
 * Surface the crash on screen so it can be diagnosed at all.
 */
class EntryCrashBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }
  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[dsh-quno] entry panel crashed:', error, info.componentStack)
  }
  override render(): React.ReactNode {
    if (this.state.error !== null) {
      return <div style={{ ...styles.holder, color: 'var(--dsw-alias-label-danger, #f66)', textAlign: 'left' }}>
        {'Quno 入口崩溃：'}
        {this.state.error.message}
        <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{this.state.error.stack}</pre>
      </div>
    }
    return this.props.children
  }
}

/** Open the one main conversation, then hand the layout back. */
export function QunoEntryPanel(props: EntryPanelProps): React.ReactElement {
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const state = props.store.getSnapshot().state
        const sessionId = state?.main.sessionId ?? await props.store.ensureMain('', props.defaultWorkspaceId?.())
        if (!alive) return
        ;(window as unknown as { __qunoDebug?: unknown[] }).__qunoDebug ??= []
        ;(window as unknown as { __qunoDebug: unknown[] }).__qunoDebug.push({ step: 'before-back' })
        // Hand the layout back FIRST: uiWorkspace.openSession only lands while
        // the Conversation view is the active main panel — called while this
        // hand-off panel owns the region it silently does nothing (2026-10-30
        // entry regression; breadcrumbs proved the chain ran, the view just
        // never switched).
        props.backToConversation()
        ;(window as unknown as { __qunoDebug: unknown[] }).__qunoDebug.push({ step: 'after-back' })
        props.openSession(sessionId)
        ;(window as unknown as { __qunoDebug: unknown[] }).__qunoDebug.push({ step: 'after-open', sessionId })
      } catch (cause) {
        ;(window as unknown as { __qunoDebug?: unknown[] }).__qunoDebug ??= []
        ;(window as unknown as { __qunoDebug: unknown[] }).__qunoDebug.push({ step: 'threw', error: cause instanceof Error ? cause.stack : String(cause) })
        if (alive) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => { alive = false }
    // Mount-only hand-off: the panel exists to run this once per activation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (error !== '') {
    return <div style={styles.holder}>{`Quno 打开失败：${error}`}</div>
  }
  return <EntryCrashBoundary><div style={styles.holder}>{'正在读取 Quno…'}</div></EntryCrashBoundary>
}

/** The row glyph: the Quno brand mark at the edge the sidebar asks for. */
export function QunoEntryGlyph({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <QunoMark size={size} />
}

const styles = {
  holder: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    height: '100%', padding: 24,
    fontSize: 13, color: 'var(--dsw-alias-label-secondary)',
  },
} as const
