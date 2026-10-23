/**
 * The collapsed-state capsule (design §13.5): a `shell.overlay` entry that
 * floats over the conversation body only while a Quno main conversation is on
 * screen and the right panel is collapsed. Shows live counts (running tasks,
 * open attention, sense alarms); a click opens the panel. Placement follows
 * the dsh-thread capsule precedent (anchor over `[data-conversation-scroll]`).
 *
 * @module dsh-quno/client/pill
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { panelCounts, shouldShowPill, type StateSlice } from './view-model.ts'
import { QUNO_PANEL_KIND } from './right-tab.ts'

/** Structural face of `ctx.sidebarRight` this pill consumes (duck-checked upstream). */
export interface SidebarRightFace {
  /** The session the right sidebar currently hosts. */
  readonly mounted: { getSnapshot(): string | undefined; subscribe(fn: () => void): () => void }
  /** Open a page type by kind; the column expands in the same step. */
  openTab(kind: string, options?: { params?: unknown }): void
  /** Whether the column is expanded. */
  isExpanded(): boolean
}

/** Injected face of the capsule. */
export interface QunoPillInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly face: SidebarRightFace | undefined
}

/** Render the capsule, or nothing when it does not apply. */
export function QunoPanelPill(props: PropsRuntime<'shell.overlay'> & QunoPillInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const face = props.face
  const [expanded, setExpanded] = React.useState(() => readExpanded())
  // Expansion lives in the right sidebar's layout store, which is not exposed
  // as a service observable; the DOM seam (`data-sidebar-right-open`) is the
  // same source the shell styles read, so mirror it.
  React.useEffect(() => {
    if (face === undefined) return
    setExpanded(readExpanded())
    // The expansion attribute may arrive on a freshly inserted panel node (a
    // commit that mounts the open panel), so childList mutations re-read too.
    const observer = new MutationObserver(() => { setExpanded(readExpanded()) })
    observer.observe(document.body, {
      attributes: true, childList: true, subtree: true,
      attributeFilter: ['data-sidebar-right-open'],
    })
    return () => { observer.disconnect() }
  }, [face])
  // The on-screen conversation: the row the main view retains (dsh-thread
  // capsule precedent), read through the framework's live list store.
  const currentSessionId = props.useSessions((state) => {
    const row = Object.values(state.byId).find(candidate => (candidate.retainedBy.mainView ?? 0) > 0)
    return row?.id
  })
  const mountedSessionId = useObservableValue(face?.mounted)
  // Every hook runs on every render: an early return before a hook call is a
  // render-count crash (React #310) the moment visibility flips.
  const seenSessionId = mountedSessionId ?? currentSessionId ?? undefined
  const seenPreset = props.useSessions(sessions => seenSessionId === undefined
    ? undefined
    : sessions.byId[seenSessionId as SessionId]?.projectionValues?.agentPreset)

  if (face === undefined) return null
  const state = snapshot.state
  if (state === null || state.main.sessionId === null) return null
  const show = shouldShowPill({
    mainSessionId: state.main.sessionId,
    mountedSessionId: seenSessionId,
    mountedPreset: seenPreset,
    panelExpanded: expanded,
  })
  if (!show) return null

  const counts = panelCounts(state as unknown as StateSlice)
  const open = (): void => { face.openTab(QUNO_PANEL_KIND) }
  return (
    <div style={styles.anchor}>
      <button type="button" style={styles.pill} title={props.t('sidebarOpen')} onClick={open}>
        <span style={styles.mark} aria-hidden="true">Q</span>
        <span style={styles.count}>{counts.runningTasks}</span>
        <span style={styles.divider} aria-hidden="true" />
        <span style={styles.count}>{counts.attentionOpen}</span>
        {counts.senseAlarms > 0 && <span style={styles.alarm} aria-hidden="true" />}
      </button>
    </div>
  )
}

/** Subscribe to an optional observable snapshot through the framework store. */
function useObservableValue<T>(source: { getSnapshot(): T; subscribe(fn: () => void): () => void } | undefined): T | undefined {
  return React.useSyncExternalStore(
    source === undefined ? () => () => {} : source.subscribe,
    source === undefined ? () => undefined : source.getSnapshot,
    source === undefined ? () => undefined : source.getSnapshot,
  )
}

/** Whether any right sidebar panel is expanded right now. */
function readExpanded(): boolean {
  if (typeof document === 'undefined') return true
  return document.querySelector('[data-sidebar-right-session][data-sidebar-right-open]') !== null
}

const styles = {
  anchor: {
    position: 'fixed', top: 60, right: 14, zIndex: 30, pointerEvents: 'none',
  },
  pill: {
    pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 10px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12,
    boxShadow: '0 4px 16px rgba(0,0,0,0.16)',
  },
  mark: {
    width: 16, height: 16, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10, fontWeight: 700, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  count: { fontWeight: 600, fontSize: 12 },
  divider: { width: 1, height: 12, background: 'var(--dsw-alias-border-l1)' },
  alarm: {
    width: 7, height: 7, borderRadius: 999, background: 'var(--dsw-alias-state-warn-primary)',
  },
} as const
