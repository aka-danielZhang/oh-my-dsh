/**
 * One delegated task's detail. It renders only the sections its status calls
 * for, and only when the record actually has the content: a running task with
 * no plan has no plan heading, a finished task with no artifacts has no
 * artifacts heading.
 *
 * Shared by the right panel and the settings page.
 *
 * @module dsh-quno/client/task-detail
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QunoLocaleKey, QunoTranslate } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { TaskWire } from '../api-types.ts'
import { clip, formatClock, formatDuration } from './format.ts'
import { taskSections, taskStatusKey, taskTone } from './panel-state.ts'
import { Callout, DetailHeader, DetailSection, StatusLabel } from './panel-primitives.tsx'
import { Empty, ErrorBanner } from './ui.tsx'

/** Injected face of the task detail. */
export interface TaskDetailInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly openSession: (sessionId: string) => void
}

/** Props of one task detail. */
export interface TaskDetailProps extends TaskDetailInjected {
  readonly task: TaskWire
  readonly onBack?: () => void
  /** Settings embeds the detail inside its own surface and hides the back link. */
  readonly compact?: boolean
}

/** Render one task's recorded detail. */
export function TaskDetail(props: TaskDetailProps): React.ReactElement {
  const { task, t, store } = props
  const [busy, setBusy] = React.useState<'resume' | 'cancel' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)

  const act = async (action: 'resume' | 'cancel'): Promise<void> => {
    if (busy !== null) return
    setBusy(action)
    setError(null)
    try {
      await store.taskCommand(task.id, action)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => { setCopied(current => current === text ? null : current) }, 1500)
    } catch {
      setCopied(null)
    }
  }

  const sections = taskSections(task)
  const duration = task.settledAt === null ? null : Math.max(0, task.settledAt - task.createdAt)
  const statusLabel = t(taskStatusKey(task.status))

  return (
    <div style={styles.stack}>
      <DetailHeader
        icon="task"
        title={task.title}
        subtitle={`${statusLabel} · ${formatClock(task.createdAt)}${duration === null ? '' : ` · ${t('taskDuration')} ${formatDuration(duration)}`}`}
        status={<StatusLabel tone={taskTone(task.status)}>{statusLabel}</StatusLabel>}
        backLabel={t('panelBack')}
        {...(props.compact === true || props.onBack === undefined ? {} : { onBack: props.onBack })}
      />

      {sections.cancelledNote && (
        <Callout tone="info" title={t('taskStatusCancelled')}>{t('taskCancelledNote')}</Callout>
      )}

      {sections.plan && task.plan !== null && (
        <DetailSection title={t('panelTaskPlan')}>
          <p style={styles.body}>{clip(task.plan, 1600)}</p>
        </DetailSection>
      )}

      {sections.prompt && task.prompt !== null && (
        <DetailSection title={t('panelTaskPrompt')}>
          <p style={styles.body}>{clip(task.prompt, 1200)}</p>
        </DetailSection>
      )}

      {sections.error && task.error !== null && (
        <Callout tone="error" title={t('taskErrorTitle')}>
          {task.error.code}：{clip(task.error.message, 600)}
        </Callout>
      )}

      {sections.result && (
        <DetailSection title={t('panelTaskResult')}>
          <p style={styles.body}>
            {task.result !== null && task.result !== ''
              ? clip(task.result, 2400)
              : task.resultDigest ?? ''}
          </p>
        </DetailSection>
      )}

      {sections.artifacts && (
        <DetailSection title={t('taskArtifacts')}>
          {task.artifacts.map(artifact => (
            <div key={`${artifact.kind}:${artifact.uri}`} style={styles.artifactRow}>
              <span style={styles.artifactKind}>{artifactKindLabel(artifact.kind, t)}</span>
              {artifact.kind === 'url'
                ? (
                  <a href={artifact.uri} target="_blank" rel="noreferrer" style={styles.link}>
                    {artifact.label}
                  </a>
                )
                : <span style={styles.artifactLabel}>{artifact.label}</span>}
              {(artifact.kind === 'file' || artifact.kind === 'directory') && (
                <Button size="sm" variant="ghost" onClick={() => { void copy(artifact.uri) }}>
                  {copied === artifact.uri ? t('taskCopied') : t('taskCopyPath')}
                </Button>
              )}
              {artifact.kind === 'note' && (
                <details style={styles.artifactDetails}>
                  <summary style={styles.summary}>{t('taskArtifactNote')}</summary>
                  <p style={styles.body}>{artifact.uri}</p>
                </details>
              )}
            </div>
          ))}
        </DetailSection>
      )}

      {(sections.resume || sections.cancel || sections.child) && (
        <div style={styles.actions}>
          {sections.resume && (
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void act('resume') }}>
              {t('taskResume')}
            </Button>
          )}
          {sections.cancel && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void act('cancel') }}>
              {busy === 'cancel' ? t('taskCancelling') : t('taskCancel')}
            </Button>
          )}
          {sections.child && task.childSessionId !== null && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => { if (task.childSessionId !== null) props.openSession(task.childSessionId) }}
            >
              {t('taskChildReadonly')}
            </Button>
          )}
        </div>
      )}

      {!sections.plan && !sections.prompt && !sections.result && !sections.artifacts && !sections.error && (
        <Empty>{t('taskNoRecordedDetail')}</Empty>
      )}

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  )
}

/** Localized task status; kept as a named export for the card and the list. */
export function taskStatusLabel(status: string, t: (key: QunoLocaleKey) => string): string {
  return t(taskStatusKey(status))
}

function artifactKindLabel(kind: string, t: QunoTranslate): string {
  switch (kind) {
    case 'file': return t('taskArtifactFile')
    case 'directory': return t('taskArtifactDirectory')
    case 'url': return t('taskArtifactUrl')
    case 'note': return t('taskArtifactNote')
    default: return kind
  }
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  body: { margin: 0, fontSize: 12, lineHeight: 1.65, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  artifactRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12, marginTop: 2 },
  artifactKind: {
    flex: 'none', fontSize: 10.5, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)',
    background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6, padding: '1px 7px',
  },
  artifactLabel: { color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
  artifactDetails: { flexBasis: '100%' },
  summary: { cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
  link: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none', overflowWrap: 'anywhere' },
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 },
} as const
