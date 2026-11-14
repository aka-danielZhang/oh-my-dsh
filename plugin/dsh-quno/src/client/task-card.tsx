/**
 * Inline task card for `quno_task` calls (design §5.2): a light, honest card —
 * title, user status, the settled result when there is one, and exactly one
 * primary action (查看详情). Running tasks may also offer 停止; failed tasks
 * offer 重试. No technical ids, no child-session jump, no raw error dumps:
 * those live in the read-only execution record.
 *
 * @module dsh-quno/client/task-card
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { formatClock, clip } from './format.ts'
import { taskUserStatus, taskUserStatusKey } from './panel-state.ts'
import { QunoCard } from './ui.tsx'

/** Injected face of the task card. */
export interface QunoTaskCardInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey) => string
  /** Focus the task in the right panel (§13.6); undefined degrades to no-op. */
  readonly openPanel: ((taskId?: string) => void) | undefined
}

interface TaskMeta {
  readonly taskId?: string
  readonly title?: string
  readonly status?: string
}

/** Render the quno_task tool card. */
export function QunoTaskCard(props: ToolCallViewProps & QunoTaskCardInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const { t } = props
  const block = props.block
  if (!('kind' in block) || block.kind !== 'tool-result') {
    // Same card shell and near-identical height while running: the landed
    // result must not push the conversation upwards.
    return (
      <div className="dsh-quno-card" style={{ marginTop: 6 }} aria-busy="true">
        <div className="dsh-quno-card__hd">
          <span className="dsh-quno-card__label">{t('taskCardLabel')}</span>
          <span className="dsh-quno-skeleton" style={styles.skeletonTitle} />
        </div>
        <div className="dsh-quno-skeleton" style={styles.skeletonBody} />
      </div>
    )
  }
  if (block.isError) {
    return <div style={styles.pending}>{t('taskStatusFailed')}</div>
  }
  const meta = (block.meta ?? {}) as TaskMeta
  const task = meta.taskId === undefined
    ? undefined
    : snapshot.state?.tasks.find(candidate => candidate.id === meta.taskId)
  const status = taskUserStatus({
    status: task?.status ?? meta.status ?? 'running',
    ...(task?.presentationStatus === undefined ? {} : { presentationStatus: task.presentationStatus }),
  })
  const title = task?.title ?? meta.title ?? ''
  const open = meta.taskId !== undefined && props.openPanel !== undefined
  return (
    <QunoCard accent={accentOf(status)} style={{ marginTop: 6 }}>
      <div className="dsh-quno-card__hd">
        <span className="dsh-quno-card__label">{t('taskCardLabel')}</span>
        <span className="dsh-quno-card__title" style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }}>{title}</span>
        <span className="dsh-quno-card__meta">
          <span style={{ width: 7, height: 7, borderRadius: 999, display: 'inline-block', background: dotColor(status) }} aria-hidden="true" />
          {t(taskUserStatusKey(status))}
        </span>
      </div>
      {/* The settled result, bounded: this is a card, not the record. */}
      {status === 'done' && task?.result !== null && task?.result !== undefined && (
        <p className="dsh-quno-card__body">{clip(task.result, 500)}</p>
      )}
      <div style={styles.actions}>
        {open && (
          <Button size="sm" variant="primary" onClick={() => { props.openPanel?.(meta.taskId ?? '') }}>
            {t('taskOpenDetail')}
          </Button>
        )}
        {open && (status === 'running' || status === 'accepted' || status === 'waiting') && task !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => { void props.store.taskCommand(task.id, 'cancel') }}>
            {t('taskStop')}
          </Button>
        )}
        {open && status === 'failed' && task !== undefined && (
          <Button size="sm" variant="outline" onClick={() => { void props.store.taskCommand(task.id, 'resume') }}>
            {t('taskRetry')}
          </Button>
        )}
        {task?.settledAt !== null && task?.settledAt !== undefined && (
          <span style={styles.when}>{formatClock(task.settledAt)}</span>
        )}
      </div>
    </QunoCard>
  )
}

function accentOf(status: ReturnType<typeof taskUserStatus>): string {
  switch (status) {
    case 'accepted':
    case 'running': return 'var(--dsw-alias-brand-primary)'
    case 'needs-you': return 'var(--dsw-alias-state-warn-primary)'
    case 'done': return 'var(--dsw-alias-state-success-primary)'
    case 'failed': return 'var(--dsw-alias-state-error-primary)'
    default: return 'var(--dsw-alias-label-tertiary)'
  }
}

function dotColor(status: ReturnType<typeof taskUserStatus>): string {
  switch (status) {
    case 'accepted': return 'var(--dsw-alias-state-warn-primary)'
    case 'running': return 'var(--dsw-alias-state-success-primary)'
    case 'needs-you': return 'var(--dsw-alias-state-warn-primary)'
    case 'done': return 'var(--dsw-alias-label-tertiary)'
    case 'failed': return 'var(--dsw-alias-state-error-primary)'
    default: return 'var(--dsw-alias-label-tertiary)'
  }
}

const styles = {
  pending: { padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  skeletonTitle: { flex: 1, height: 12, borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)' },
  skeletonBody: { marginTop: 8, height: 34, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 },
  when: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
} as const
