/**
 * Sidebar entry for Quno: one durable conversation plus the few things that
 * need the user's attention, rendered as a sidebar list view (design §13.1).
 *
 * @module dsh-quno/client/sidebar
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'
import { formatClock } from './format.ts'

/** Injected face of the sidebar view. */
export interface QunoSidebarInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly openSession: (sessionId: string) => void
}

/** Render the Quno sidebar list view. */
export function QunoSidebarView(props: PropsRuntime<'sidebar.workspaces.sessionListView'> & QunoSidebarInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const { t } = props
  const state = snapshot.state
  const [busy, setBusy] = React.useState(false)

  if (state === null) {
    return <div style={styles.empty}>{snapshot.phase === 'error' ? format(t('error'), { error: snapshot.error ?? '' }) : t('loading')}</div>
  }

  const active = state.attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed')
  const tasks = state.tasks.filter(task => task.status === 'running' || task.status === 'interrupted').slice(0, 4)
  const running = state.tasks.filter(task => task.status === 'running').length
  const interrupted = state.tasks.filter(task => task.status === 'interrupted').length

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
      <button
        type="button"
        className="dsh-quno-row"
        style={styles.qunoRow}
        title={t('sidebarOpen')}
        onClick={() => { void openMain() }}
      >
        <span style={styles.qunoMark}>Q</span>
        <span style={styles.qunoName}>{state.quno.name}</span>
        <span style={styles.qunoMeta}>
          {state.main.state === 'ok' ? t('mainBound') : state.main.state === 'unbound' ? t('mainUnbound') : t('mainMissing')}
        </span>
      </button>

      {active.slice(0, 4).map(item => (
        <button
          key={item.id}
          type="button"
          className="dsh-quno-row"
          style={styles.itemRow}
          onClick={() => { void openMain() }}
          title={item.summary}
        >
          <span style={styles.itemTitle}>{item.title}</span>
          <span style={styles.itemMeta}>{item.nextReviewAt === null ? item.status : formatClock(item.nextReviewAt)}</span>
        </button>
      ))}

      {active.length === 0 && tasks.length === 0 && <div style={styles.empty}>{t('sidebarEmpty')}</div>}

      {tasks.map(task => (
        <button
          key={task.id}
          type="button"
          className="dsh-quno-row"
          style={styles.itemRow}
          onClick={() => { if (task.childSessionId !== null) props.openSession(task.childSessionId) }}
        >
          <span style={styles.itemTitle}>{task.title}</span>
          <span style={styles.itemMeta}>{task.status}</span>
        </button>
      ))}

      {(running > 0 || interrupted > 0) && (
        <div style={styles.footer}>
          {running > 0 && <span>{format(t('sidebarRunning'), { count: running })}</span>}
          {interrupted > 0 && <span>{format(t('sidebarInterrupted'), { count: interrupted })}</span>}
        </div>
      )}
    </div>
  )
}

const styles = {
  list: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' },
  qunoRow: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 36, padding: '0 8px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', textAlign: 'left', userSelect: 'none', boxSizing: 'border-box',
  },
  qunoMark: {
    flex: 'none', width: 20, height: 20, borderRadius: 6, display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', fontSize: 11, fontWeight: 700,
    background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  qunoName: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, fontWeight: 600 },
  qunoMeta: { flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
  itemRow: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: 30, padding: '0 8px 0 28px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', textAlign: 'left', userSelect: 'none', boxSizing: 'border-box',
  },
  itemTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  itemMeta: { flex: 'none', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
  empty: { padding: '12px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
  footer: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px 0 28px', fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
} as const
