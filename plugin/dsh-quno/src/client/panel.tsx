/**
 * The right-sidebar Quno panel (design §13.4/§13.6): one tab type registered
 * through the two-stage mechanism (`sidebarRightTabs.register` + keyed
 * `sidebar.right.pane.tab`), with three component-level views — Sense activity,
 * attention items, tasks — over the shared polling store. A navigation
 * `params: { taskId, view }` focuses the task detail (the task-card linkage);
 * a `view` param alone opens on that view.
 *
 * @module dsh-quno/client/panel
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'
import { clip, formatClock, toneOf } from './format.ts'
import { eventLine, type StateSlice } from './view-model.ts'
import type { QunoPanelView } from './right-tab.ts'
import { narrowPanelParams } from './right-tab.ts'

/** Injected face of the panel body. */
export interface QunoPanelInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly openSession: (sessionId: string) => void
}

type PanelTabProps = PropsRuntime<'sidebar.right.pane.tab'> & QunoPanelInjected

/** The chip title: the Quno name, with the running-task count while any runs. */
export function QunoPanelTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & QunoPanelInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const running = snapshot.state?.tasks.filter(task => task.status === 'running').length ?? 0
  return <span style={styles.titleChip}>{running > 0 ? `${props.t('nav')} · ${running}` : props.t('nav')}</span>
}

/** Render the panel body (docked, floating, or fullscreen — dockkit's call). */
export function QunoPanelTab(props: PanelTabProps): React.ReactElement {
  const { tab } = props.useTabInfo()
  const params = narrowPanelParams(tab.navigation.params)
  const [view, setView] = React.useState<QunoPanelView>(params?.view ?? (params?.taskId !== undefined ? 'task' : 'sense'))
  const [taskId, setTaskId] = React.useState<string | null>(params?.taskId ?? null)

  // Re-navigation (the task card opens with new params) re-applies the focus.
  React.useEffect(() => {
    if (params?.taskId !== undefined) {
      setTaskId(params.taskId)
      setView('task')
    } else if (params?.view !== undefined) {
      setTaskId(null)
      setView(params.view)
    }
    // `revision` bumps on every navigation, whether or not params changed.
  }, [params?.taskId, params?.view, tab.navigation.revision])

  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)

  return (
    <div style={styles.root}>
      <div style={styles.tabRow} role="tablist">
        {([
          ['sense', props.t('panelTabSense')],
          ['attention', props.t('panelTabAttentionShort')],
          ['task', props.t('tabTasks')],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            style={{ ...styles.tab, ...(view === key ? styles.tabActive : {}) }}
            onClick={() => { setView(key); if (key !== 'task') setTaskId(null) }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={styles.body}>
        {view === 'sense' && <SenseView snapshot={snapshot} {...props} />}
        {view === 'attention' && <AttentionView snapshot={snapshot} {...props} />}
        {view === 'task' && (taskId === null
          ? <TaskListView snapshot={snapshot} {...props} onOpen={setTaskId} />
          : <TaskDetailView taskId={taskId} snapshot={snapshot} {...props} onBack={() => { setTaskId(null) }} />)}
      </div>
    </div>
  )
}

type ViewProps = QunoPanelInjected & { readonly snapshot: ReturnType<QunoClientStore['getSnapshot']> }

/** 动态: sense health, coverage gaps, and the recent event summary. */
function SenseView(props: ViewProps): React.ReactElement {
  const { t } = props
  const state = props.snapshot.state
  if (state === null) return <EmptyView text={props.snapshot.phase === 'error' ? props.snapshot.error ?? '' : t('loading')} />
  return (
    <div style={styles.stack}>
      {state.senses.map(sense => (
        <div key={sense.id} style={styles.lineRow}>
          <span style={healthDot(toneOf(sense.health, sense.stale))} aria-hidden="true" />
          <span style={styles.lineTitle}>{sense.label === '' ? sense.type : sense.label}</span>
          <span style={styles.lineMeta}>{healthLabel(sense.health, t)}{sense.stale ? ` · ${t('panelSenseDegraded')}` : ''}</span>
        </div>
      ))}
      {state.senses.length === 0 && <div style={styles.note}>{t('sidebarEmpty')}</div>}

      {state.gaps.length > 0 && (
        <>
          <div style={styles.section}>{t('panelGaps')}</div>
          {state.gaps.slice(0, 5).map((gap, index) => (
            <div key={`${gap.sourceId}-${index}`} style={styles.note}>{format(t('panelGapLine'), { source: gap.sourceId, reason: gap.reason })}</div>
          ))}
        </>
      )}

      <div style={styles.section}>{t('panelRecentEvents')}</div>
      {props.snapshot.events.slice(0, 8).map(event => (
        <div key={event.id} style={styles.lineRow}>
          <span style={styles.lineTitle}>{clip(eventLine(event), 80)}</span>
          <span style={styles.lineMeta}>{formatClock(event.occurredAt ?? event.receivedAt)}</span>
        </div>
      ))}
      {props.snapshot.events.length === 0 && <div style={styles.note}>{t('noticesEmpty')}</div>}
    </div>
  )
}

/** 关注: open/waiting/snoozed items with the three decisions. */
function AttentionView(props: ViewProps): React.ReactElement {
  const { t } = props
  const state = props.snapshot.state
  const [busyId, setBusyId] = React.useState<string | null>(null)
  if (state === null) return <EmptyView text={props.snapshot.phase === 'error' ? props.snapshot.error ?? '' : t('loading')} />
  const items = state.attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed')
  const act = async (itemId: string, action: 'processed' | 'later' | 'dismiss', expectedRevision: number): Promise<void> => {
    if (busyId !== null) return
    setBusyId(itemId)
    try {
      await props.store.actAttention(action === 'later' ? { itemId, action, expectedRevision, snoozeMinutes: 60 } : { itemId, action, expectedRevision })
    } catch {
      // Conflict copy surfaces through the store's error on the next render.
    } finally {
      setBusyId(null)
    }
  }
  if (items.length === 0) return <EmptyView text={t('attentionEmpty')} />
  return (
    <div style={styles.stack}>
      {items.map(item => (
        <div key={item.id} style={styles.card}>
          <div style={styles.lineRow}>
            <span style={styles.lineTitle}>{item.title}</span>
            <span style={styles.lineMeta}>{item.nextReviewAt === null ? item.status : formatClock(item.nextReviewAt)}</span>
          </div>
          {item.summary !== '' && <p style={styles.bodyText}>{clip(item.summary, 200)}</p>}
          <div style={styles.buttonRow}>
            <button type="button" style={styles.button} disabled={busyId === item.id} onClick={() => { void act(item.id, 'processed', item.revision) }}>{t('actProcessed')}</button>
            <button type="button" style={styles.button} disabled={busyId === item.id} onClick={() => { void act(item.id, 'later', item.revision) }}>{t('actLater')}</button>
            <button type="button" style={styles.buttonGhost} disabled={busyId === item.id} onClick={() => { void act(item.id, 'dismiss', item.revision) }}>{t('actDismiss')}</button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 任务: running/interrupted first, then settled. */
function TaskListView(props: ViewProps & { readonly onOpen: (taskId: string) => void }): React.ReactElement {
  const { t } = props
  const state = props.snapshot.state
  if (state === null) return <EmptyView text={props.snapshot.phase === 'error' ? props.snapshot.error ?? '' : t('loading')} />
  const active = state.tasks.filter(task => task.status === 'running' || task.status === 'interrupted' || task.status === 'failed')
  const settled = state.tasks.filter(task => task.settledAt !== null).slice(0, 10)
  if (active.length === 0 && settled.length === 0) return <EmptyView text={t('tasksEmpty')} />
  const row = (task: typeof state.tasks[number]): React.ReactElement => (
    <button key={task.id} type="button" style={styles.lineRowButton} onClick={() => { props.onOpen(task.id) }}>
      <span style={healthDot(task.status === 'running' ? 'ok' : task.status === 'failed' || task.status === 'interrupted' ? 'warn' : 'idle')} aria-hidden="true" />
      <span style={styles.lineTitle}>{task.title}</span>
      <span style={styles.lineMeta}>{taskStatusLabel(task.status, t)}</span>
    </button>
  )
  return (
    <div style={styles.stack}>
      {active.map(row)}
      {active.length > 0 && settled.length > 0 && <div style={styles.section}>{t('taskStatusDone')}</div>}
      {settled.map(row)}
    </div>
  )
}

/** One task's live record: status, plan, prompt, result/error, artifacts, ops. */
function TaskDetailView(props: ViewProps & { readonly taskId: string; readonly onBack: () => void }): React.ReactElement {
  const { t } = props
  const state = props.snapshot.state
  const task = state?.tasks.find(candidate => candidate.id === props.taskId)
  if (state === null) return <EmptyView text={props.snapshot.phase === 'error' ? props.snapshot.error ?? '' : t('loading')} />
  if (task === undefined) {
    return (
      <div style={styles.stack}>
        <button type="button" style={styles.buttonGhost} onClick={props.onBack}>{t('panelBack')}</button>
        <div style={styles.note}>{t('mainMissing')}</div>
      </div>
    )
  }
  const resumable = task.status === 'interrupted' || task.status === 'failed'
  return (
    <div style={styles.stack}>
      <button type="button" style={styles.buttonGhost} onClick={props.onBack}>{t('panelBack')}</button>
      <div style={styles.lineRow}>
        <span style={healthDot(task.status === 'running' ? 'ok' : resumable ? 'warn' : 'idle')} aria-hidden="true" />
        <span style={styles.lineTitle}>{task.title}</span>
        <span style={styles.lineMeta}>{taskStatusLabel(task.status, t)}</span>
      </div>
      {task.plan !== null && task.plan !== '' && (
        <>
          <div style={styles.section}>{t('panelTaskPlan')}</div>
          <p style={styles.bodyText}>{clip(task.plan, 1200)}</p>
        </>
      )}
      {task.prompt !== null && (
        <>
          <div style={styles.section}>{t('panelTaskPrompt')}</div>
          <p style={styles.bodyText}>{clip(task.prompt, 600)}</p>
        </>
      )}
      {task.error !== null && <p style={{ ...styles.bodyText, color: 'var(--dsw-alias-state-error-primary)' }}>{task.error.message}</p>}
      {task.result !== null && task.result !== '' && (
        <>
          <div style={styles.section}>{t('panelTaskResult')}</div>
          <p style={styles.bodyText}>{clip(task.result, 2000)}</p>
        </>
      )}
      {task.artifacts.length > 0 && (
        <div style={styles.metaRow}>
          {task.artifacts.map(artifact => <span key={artifact.uri} style={styles.artifact}>{artifact.label}（{artifact.kind}）</span>)}
        </div>
      )}
      <div style={styles.buttonRow}>
        {resumable && <button type="button" style={styles.button} onClick={() => { void props.store.taskCommand(task.id, 'resume') }}>{t('taskResume')}</button>}
        {resumable && <button type="button" style={styles.buttonGhost} onClick={() => { void props.store.taskCommand(task.id, 'abandon') }}>{t('taskAbandon')}</button>}
        {task.childSessionId !== null && (
          <button type="button" style={styles.button} onClick={() => { if (task.childSessionId !== null) props.openSession(task.childSessionId) }}>
            {t('panelTaskChild')}
          </button>
        )}
      </div>
    </div>
  )
}

function EmptyView(props: { readonly text: string }): React.ReactElement {
  return <div style={styles.note}>{props.text}</div>
}

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

function healthLabel(health: string, t: (key: QunoLocaleKey) => string): string {
  switch (health) {
    case 'healthy': return t('panelSenseHealthy')
    case 'degraded': return t('panelSenseDegraded')
    case 'rate-limited': return t('panelSenseRateLimited')
    case 'auth-required': return t('panelSenseAuthRequired')
    case 'unavailable': return t('panelSenseUnavailable')
    default: return health
  }
}

function healthDot(tone: 'ok' | 'warn' | 'error' | 'idle'): React.CSSProperties {
  return {
    flex: 'none', width: 8, height: 8, borderRadius: 999,
    background: tone === 'ok'
      ? 'var(--dsw-alias-state-success-primary)'
      : tone === 'warn'
        ? 'var(--dsw-alias-state-warn-primary)'
        : tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-border-l1)',
  }
}

const styles = {
  titleChip: { fontSize: 12, fontWeight: 600 },
  root: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 },
  tabRow: { display: 'flex', gap: 4, padding: '8px 10px 4px' },
  tab: {
    flex: 1, height: 26, border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: 12,
  },
  tabActive: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
  body: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '4px 10px 12px' },
  stack: { display: 'flex', flexDirection: 'column', gap: 8 },
  section: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 },
  lineRow: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28 },
  lineRowButton: {
    display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, width: '100%', padding: '2px 6px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer', font: 'inherit', textAlign: 'left',
    color: 'var(--dsw-alias-label-primary)', boxSizing: 'border-box',
  },
  lineTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  lineMeta: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  note: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
  card: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: 10,
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)',
  },
  bodyText: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  buttonRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  button: {
    height: 26, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', font: 'inherit', fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
  },
  buttonGhost: {
    height: 26, padding: '0 10px', border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  },
  metaRow: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
  artifact: { padding: '1px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)' },
} as const
