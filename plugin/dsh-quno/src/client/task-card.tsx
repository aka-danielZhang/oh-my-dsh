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
import { taskStatusKey } from './panel-state.ts'
import { QunoCard } from './ui.tsx'

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
  const status = task?.status ?? meta.status ?? 'running'
  const title = task?.title ?? meta.title ?? ''
  const childSessionId = task?.childSessionId ?? meta.childSessionId ?? null
  const accent = status === 'running'
    ? 'var(--dsw-alias-brand-primary)'
    : status === 'done'
      ? 'var(--dsw-alias-state-success-primary)'
      : status === 'failed'
        ? 'var(--dsw-alias-state-error-primary)'
        : 'var(--dsw-alias-state-warn-primary)'

  return (
    <QunoCard accent={accent} style={{ marginTop: 6 }}>
      <div className="dsh-quno-card__hd">
        <span className="dsh-quno-card__label">{t('taskCardLabel')}</span>
        <span className="dsh-quno-card__title" style={{ color: 'var(--dsw-alias-label-primary)', fontWeight: 600 }}>{title}</span>
        <span className="dsh-quno-card__meta">
          <span style={{
            width: 7, height: 7, borderRadius: 999, display: 'inline-block',
            background: status === 'running'
              ? 'var(--dsw-alias-state-success-primary)'
              : status === 'done'
                ? 'var(--dsw-alias-label-tertiary)'
                : 'var(--dsw-alias-state-warn-primary)',
          }} aria-hidden="true" />
          {statusLabel(status, t)}
        </span>
      </div>
      {task?.result !== null && task?.result !== undefined && (
        <p className="dsh-quno-card__body">{clip(task.result, 700)}</p>
      )}
      {task?.error !== null && task?.error !== undefined && (
        <p style={styles.error}>{task.error.message}</p>
      )}
      {task !== undefined && task.artifacts.length > 0 && (
        <div className="dsh-quno-card__src">
          {task.artifacts.map(artifact => (
            <span key={artifact.uri} className="dsh-quno-chip">{artifact.label}（{artifact.kind}）</span>
          ))}
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
            {t('taskChildReadonly')}
          </Button>
        )}
        {(status === 'interrupted' || status === 'failed') && task !== undefined && (
          <Button size="sm" variant="primary" onClick={() => { void props.store.taskCommand(task.id, 'resume') }}>{t('taskResume')}</Button>
        )}
        {(status === 'running' || status === 'interrupted' || status === 'failed') && task !== undefined && (
          <Button size="sm" variant="ghost" onClick={() => { void props.store.taskCommand(task.id, 'cancel') }}>{t('taskCancel')}</Button>
        )}
        {task?.settledAt !== null && task?.settledAt !== undefined && (
          <span style={styles.when}>{formatClock(task.settledAt)}</span>
        )}
      </div>
    </QunoCard>
  )
}

function statusLabel(status: string, t: QunoTaskCardInjected['t']): string {
  return t(taskStatusKey(status))
}

/** Localized artifact kind; the raw enum never reaches the card. */
function artifactKindLabel(kind: string, t: QunoTaskCardInjected['t']): string {
  switch (kind) {
    case 'file': return t('taskArtifactFile')
    case 'directory': return t('taskArtifactDirectory')
    case 'url': return t('taskArtifactUrl')
    case 'note': return t('taskArtifactNote')
    default: return kind
  }
}

const styles = {
  pending: { padding: 10, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  skeletonTitle: { flex: 1, height: 12, borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)' },
  skeletonBody: { marginTop: 8, height: 34, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' },
  error: { margin: '6px 0 0', fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' },
  actions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 },
  when: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
} as const
