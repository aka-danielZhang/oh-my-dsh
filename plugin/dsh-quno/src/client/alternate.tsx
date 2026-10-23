/**
 * The Quno alternate browsing view (design §13.2, work/Quno arrangement):
 * registered into the fork's `sidebar.workspaces.alternate` seat, rendered as
 * the region's second tab beside the stock browser (the work tab). The
 * contact row is the message object: one row per Quno (v1 one instance) with
 * presence, attention badge and live task/attention sub-rows; clicking it
 * enters the one main conversation.
 *
 * The region mounts this view only while its tab is active, so the component
 * is a pure function of the shared polling store — and its mount/unmount IS
 * the Quno-tab-active state: while mounted it claims the sidebar column root
 * with `data-quno-side="on"`, under which the skin CSS retires the shell rows
 * (the standalone New Session button and the global panel list) so the Quno
 * tab reads as its own sidebar panel (design §13.2, two-panel arrangement).
 *
 * @module dsh-quno/client/alternate
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'
import { formatClock } from './format.ts'
import { mainPresence, panelCounts } from './view-model.ts'

/** Injected face of the alternate view. */
export interface QunoAlternateInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly openSession: (sessionId: string) => void
  /** Focus the right panel, optionally on one task (absent without the right sidebar service). */
  readonly openPanel: ((taskId?: string) => void) | undefined
}

type AlternateProps = PropsRuntime<'sidebar.workspaces.alternate'> & QunoAlternateInjected

/** Render the Quno contact view. */
export function QunoAlternateView(props: AlternateProps): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const { t } = props
  const state = snapshot.state
  const [busy, setBusy] = React.useState(false)

  // Region claim: while this view is on screen the Quno tab is its own
  // sidebar panel — the shell rows (standalone New Session button, global
  // panel list) belong to the work world and step aside via the
  // [data-quno-side] skin rules (QUNO_CSS block 7). Owner-token claim on the
  // sidebar column root (the first element inside the `sidebar` slot anchor);
  // unmount — tab switch, alternate dispose, plugin unload — always releases
  // the claim it owns, and a missing anchor simply claims nothing.
  const sideToken = React.useRef(`quno-side-${Math.random().toString(36).slice(2)}`)
  React.useLayoutEffect(() => {
    const anchor = document.querySelector<HTMLElement>('[data-slot="sidebar"]')
    const root = anchor?.firstElementChild
    if (!(root instanceof HTMLElement)) return
    root.dataset.qunoSide = 'on'
    root.dataset.qunoSideOwner = sideToken.current
    const claimed = root
    return () => {
      if (claimed.dataset.qunoSideOwner === sideToken.current) {
        delete claimed.dataset.qunoSide
        delete claimed.dataset.qunoSideOwner
      }
    }
  }, [])

  if (state === null) {
    const loading = snapshot.phase !== 'error'
    return <div style={styles.empty}>{loading ? t('loading') : format(t('error'), { error: snapshot.error ?? '' })}</div>
  }

  const counts = panelCounts(state)
  const presence = mainPresence(state, state.config.enabled, Date.now())
  const statusText = presence === 'online'
    ? t('contactOnline')
    : presence === 'paused'
      ? t('contactPaused')
      : presence === 'muted'
        ? format(t('contactMuted'), { time: formatClock(state.quno.mutedUntil) })
        : presence === 'unbound'
          ? t('mainUnbound')
          : t('mainMissing')
  const attention = state.attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed')
  const tasks = state.tasks.filter(task => task.status === 'running' || task.status === 'interrupted')

  const openMain = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const sessionId = state.main.sessionId ?? await props.store.ensureMain('')
      props.openSession(sessionId)
    } catch {
      // The settings page shows the actionable binding error.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.list}>
      <button type="button" style={{ ...styles.contactRow, ...(busy ? styles.rowBusy : {}) }} title={t('sidebarOpen')} onClick={() => { void openMain() }}>
        <span style={styles.avatar} aria-hidden="true">
          <span style={{ ...styles.avatarDot, ...(counts.senseAlarms > 0 ? styles.avatarDotAlarm : {}) }} />
          Q
        </span>
        <span style={styles.contactBody}>
          <span style={styles.contactName}>{state.quno.name}</span>
          <span style={styles.contactStatus}>{statusText}</span>
        </span>
        {counts.attentionOpen > 0 && <span style={styles.badge}>{format(t('contactAttention'), { count: counts.attentionOpen })}</span>}
        {counts.senseAlarms > 0 && <span style={styles.alarm} title={t('contactSenseAlarm')} />}
      </button>

      {tasks.map(task => (
        <button
          key={task.id}
          type="button"
          style={styles.subRow}
          title={task.title}
          onClick={() => {
            if (props.openPanel !== undefined) props.openPanel(task.id)
            else if (task.childSessionId !== null) props.openSession(task.childSessionId)
          }}
        >
          <span style={subDot(task.status)} aria-hidden="true" />
          <span style={styles.subTitle}>{task.title}</span>
          <span style={styles.subMeta}>{taskStatusLabel(task.status, t)}</span>
        </button>
      ))}

      {attention.slice(0, 4).map(item => (
        <button key={item.id} type="button" style={styles.subRow} title={item.summary} onClick={() => { void openMain() }}>
          <span style={subDot('attention')} aria-hidden="true" />
          <span style={styles.subTitle}>{item.title}</span>
          <span style={styles.subMeta}>{item.nextReviewAt === null ? item.status : formatClock(item.nextReviewAt)}</span>
        </button>
      ))}

      {tasks.length === 0 && attention.length === 0 && <div style={styles.empty}>{t('sidebarEmpty')}</div>}
    </div>
  )
}

/** Explicit task-status copy, mirroring the task card's vocabulary. */
function taskStatusLabel(status: string, t: (key: QunoLocaleKey) => string): string {
  switch (status) {
    case 'running': return t('taskStatusRunning')
    case 'done': return t('taskStatusDone')
    case 'failed': return t('taskStatusFailed')
    case 'interrupted': return t('taskStatusInterrupted')
    case 'cancelled': return t('taskStatusCancelled')
    default: return status
  }
}

function subDot(status: string): React.CSSProperties {
  return {
    flex: 'none', width: 7, height: 7, borderRadius: 999,
    background: status === 'running'
      ? 'var(--dsw-alias-brand-primary)'
      : status === 'attention' || status === 'interrupted' || status === 'failed'
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-border-l1)',
  }
}

const styles = {
  list: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0 8px', overflowY: 'auto', height: '100%' },
  contactRow: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 40, padding: '4px 8px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', textAlign: 'left', userSelect: 'none', boxSizing: 'border-box',
  },
  rowBusy: { opacity: 0.6 },
  avatar: {
    position: 'relative', flex: 'none', width: 26, height: 26, borderRadius: 8, display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
    background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  avatarDot: {
    position: 'absolute', right: -1, bottom: -1, width: 8, height: 8, borderRadius: 999,
    background: 'var(--dsw-alias-state-success-primary)', border: '1px solid var(--dsw-alias-bg-base)',
  },
  avatarDotAlarm: { background: 'var(--dsw-alias-state-warn-primary)' },
  contactBody: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  contactName: { fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  contactStatus: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  badge: {
    flex: 'none', fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
    background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  alarm: {
    flex: 'none', width: 8, height: 8, borderRadius: 999, background: 'var(--dsw-alias-state-warn-primary)',
  },
  subRow: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 30, padding: '2px 8px 2px 12px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', textAlign: 'left', userSelect: 'none', boxSizing: 'border-box',
  },
  subTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  subMeta: { flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
  empty: { padding: '12px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
} as const
