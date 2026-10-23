/**
 * Inline task card for `quno_task` calls: L1 status, L2 details, L3 jump to the
 * child session (design §5.3).
 *
 * @module dsh-quno/client/task-card
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { formatClock, clip } from './format.ts'

/** Injected face of the task card. */
export interface QunoTaskCardInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey) => string
  readonly openSession: (sessionId: string) => void
  /** Focus the task in the right panel (§13.6); undefined degrades to the child-session jump. */
  readonly openPanel: ((taskId?: string) => void) | undefined
}

interface TaskMeta {
  readonly taskId?: string
  readonly title?: string
  readonly status?: string
  readonly childSessionId?: string | null
  readonly message?: string
}

/** Render the quno_task tool card. */
export function QunoTaskCard(props: ToolCallViewProps & QunoTaskCardInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const { t } = props
  const block = props.block
  if (!('kind' in block) || block.kind !== 'tool-result') {
    return <div style={styles.root}>{t('taskStatusRunning')}…</div>
  }
  if (block.isError) {
    return <div style={styles.root}>{t('taskStatusFailed')}</div>
  }
  const meta = (block.meta ?? {}) as TaskMeta
  const task = meta.taskId === undefined
    ? undefined
    : snapshot.state?.tasks.find(candidate => candidate.id === meta.taskId)
  const status = task?.status ?? meta.status ?? 'running'
  const title = task?.title ?? meta.title ?? ''
  const childSessionId = task?.childSessionId ?? meta.childSessionId ?? null

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.label}>Quno 任务</span>
        <span style={styles.title}>{title}</span>
        <span style={styles.status}>{statusLabel(status, t)}</span>
      </div>
      {task?.result !== null && task?.result !== undefined && (
        <p style={styles.body}>{clip(task.result, 600)}</p>
      )}
      {task?.error !== null && task?.error !== undefined && (
        <p style={styles.error}>{task.error.message}</p>
      )}
      {task !== undefined && task.artifacts.length > 0 && (
        <div style={styles.meta}>
          {task.artifacts.map(artifact => <span key={artifact.uri}>{artifact.label}（{artifact.kind}）</span>)}
        </div>
      )}
      <div style={styles.actions}>
        {meta.taskId !== undefined && props.openPanel !== undefined && (
          <Button size="sm" variant="primary" onClick={() => { props.openPanel?.(meta.taskId ?? '') }}>
            {t('taskOpenPanel')}
          </Button>
        )}
        {childSessionId !== null && (
          <Button size="sm" variant={props.openPanel !== undefined ? 'outline' : 'primary'} onClick={() => { if (childSessionId !== null) props.openSession(childSessionId) }}>
            {props.openPanel !== undefined ? t('panelTaskChild') : t('taskOpen')}
          </Button>
        )}
        {(status === 'interrupted' || status === 'failed') && task !== undefined && (
          <>
            <Button size="sm" variant="primary" onClick={() => { void props.store.taskCommand(task.id, 'resume') }}>{t('taskResume')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { void props.store.taskCommand(task.id, 'abandon') }}>{t('taskAbandon')}</Button>
          </>
        )}
        {task?.settledAt !== null && task?.settledAt !== undefined && (
          <span style={styles.when}>{formatClock(task.settledAt)}</span>
        )}
      </div>
    </div>
  )
}

function statusLabel(status: string, t: QunoTaskCardInjected['t']): string {
  switch (status) {
    case 'running': return t('taskStatusRunning')
    case 'done': return t('taskStatusDone')
    case 'failed': return t('taskStatusFailed')
    case 'interrupted': return t('taskStatusInterrupted')
    case 'cancelled': return t('taskStatusCancelled')
    default: return status
  }
}

const styles = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: 12,
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, background: 'var(--dsw-alias-bg-layer-1)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  label: {
    flex: 'none', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)',
    padding: '1px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)',
  },
  title: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  status: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
  body: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' },
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  meta: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  when: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
} as const
