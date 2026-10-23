/**
 * The in-conversation capsule (design §13.5, header utilities seat): a
 * compact pill in the header's top-right utilities row — the top-right corner
 * the product wants (2026-10-23 用户裁定：胶囊在右上角，不放 composer 上方) —
 * showing live counts (running tasks, attention, sense alarms). It yields
 * while the right panel is expanded and collapses entirely when there is
 * nothing to report. A click opens the panel.
 *
 * Panel expansion is read from the `data-sidebar-right-open` DOM seam — the
 * same source the shell styles read — via a MutationObserver that watches
 * attributes AND childList: the panel node may be inserted with the attribute
 * already on it, which a pure attribute observer never sees.
 *
 * @module dsh-quno/client/capsule
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { panelCounts, shouldShowCapsule } from './view-model.ts'
import { QUNO_PANEL_KIND } from './right-tab.ts'

/** Structural face of `ctx.sidebarRight` this capsule consumes (duck-checked upstream). */
export interface SidebarRightFace {
  /** Open a page type by kind; the column expands in the same step. */
  openTab(kind: string, options?: { params?: unknown }): void
}

/** Injected face of the capsule. */
export interface QunoCapsuleInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly face: SidebarRightFace | undefined
}

/** Render the capsule pill in the header utilities row, or nothing when it does not apply. */
export function QunoCapsule(props: PropsRuntime<'conversation.session.header.utilities'> & QunoCapsuleInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const face = props.face
  const [expanded, setExpanded] = React.useState(() => readExpanded())
  React.useEffect(() => {
    if (face === undefined) return
    setExpanded(readExpanded())
    const observer = new MutationObserver(() => { setExpanded(readExpanded()) })
    observer.observe(document.body, {
      attributes: true, childList: true, subtree: true,
      attributeFilter: ['data-sidebar-right-open'],
    })
    return () => { observer.disconnect() }
  }, [face])
  // The dock is session-scoped: its own session decides, no main-view tricks.
  const preset = props.useSessions(sessions => sessions.byId[props.sessionId]?.projectionValues?.agentPreset)

  if (face === undefined) return null
  const state = snapshot.state
  if (state === null) return null
  const counts = panelCounts(state)
  const show = shouldShowCapsule({
    preset,
    panelExpanded: expanded,
    hasContent: counts.runningTasks > 0 || counts.attentionOpen > 0 || counts.senseAlarms > 0,
  })
  if (!show) return null

  const open = (): void => { face.openTab(QUNO_PANEL_KIND) }
  return (
    <button type="button" style={styles.pill} title={props.t('sidebarOpen')} onClick={open}>
      <span style={styles.mark} aria-hidden="true">Q</span>
      <span style={styles.count}>{counts.runningTasks}</span>
      <span style={styles.divider} aria-hidden="true" />
      <span style={styles.count}>{counts.attentionOpen}</span>
      {counts.senseAlarms > 0 && <span style={styles.alarm} aria-hidden="true" />}
    </button>
  )
}

/** Whether any right sidebar panel is expanded right now. */
function readExpanded(): boolean {
  if (typeof document === 'undefined') return true
  return document.querySelector('[data-sidebar-right-session][data-sidebar-right-open]') !== null
}

const styles = {
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999, cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12,
    boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
  },
  mark: {
    width: 15, height: 15, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 9, fontWeight: 700, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  count: { fontWeight: 600, fontSize: 12 },
  divider: { width: 1, height: 12, background: 'var(--dsw-alias-border-l1)' },
  alarm: {
    width: 7, height: 7, borderRadius: 999, background: 'var(--dsw-alias-state-warn-primary)',
  },
} as const
