/**
 * One delegated task's detail (design §6.2): overview, the current activity,
 * the "needs you" question with its answer entry, result & artifacts, the
 * read-only execution record (reachable in EVERY state), and a collapsed
 * diagnostics block. Sections render only when their status calls for them
 * AND the record actually has the content.
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
import { taskActivityKey, taskSections, taskTone, taskUserStatus, taskUserStatusKey } from './panel-state.ts'
import { Callout, DetailHeader, DetailSection, StatusLabel } from './panel-primitives.tsx'
import { Empty, ErrorBanner } from './ui.tsx'
import { TaskActivity } from './task-activity.tsx'

/** Injected face of the task detail. */
export interface TaskDetailInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  /** Diagnostics-only escape hatch into the raw executor session (§11). */
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
  const [busy, setBusy] = React.useState<'retry' | 'stop' | 'answer' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [answer, setAnswer] = React.useState('')
  const [copied, setCopied] = React.useState<string | null>(null)
  const [recordOpen, setRecordOpen] = React.useState(false)
  const status = taskUserStatus(task)
  const sections = taskSections(task)
  const open = status === 'accepted' || status === 'running' || status === 'waiting' || status === 'needs-you'
  // Running work is exactly when the user asks "what is it doing now" — the
  // record starts expanded there and stays opt-in everywhere else.
  React.useEffect(() => {
    if (status === 'running' || status === 'accepted') setRecordOpen(true)
  }, [status, task.id])

  const act = async (action: 'retry' | 'stop' | 'answer', text?: string): Promise<void> => {
    if (busy !== null) return
    setBusy(action)
    setError(null)
    try {
      const wire = action === 'retry' ? 'resume' : action === 'stop' ? 'cancel' : 'answer'
      await store.taskCommand(task.id, wire, text)
      if (action === 'answer') setAnswer('')
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

  const duration = task.settledAt === null ? null : Math.max(0, task.settledAt - task.createdAt)
  const statusLabel = t(taskUserStatusKey(status))
  const activityKey = taskActivityKey(task.activityKind)

  return (
    <div style={styles.stack}>
      <DetailHeader
        icon="task"
        title={task.title}
        subtitle={`${statusLabel} · ${formatClock(task.createdAt)}${duration === null ? '' : ` · ${t('taskDuration')} ${formatDuration(duration)}`}${task.originLabel === 'source' ? ` · ${t('taskOriginSource')}` : ''}`}
        status={<StatusLabel tone={taskTone(task)}>{statusLabel}</StatusLabel>}
        backLabel={t('panelBack')}
        {...(props.compact === true || props.onBack === undefined ? {} : { onBack: props.onBack })}
      />

      {sections.cancelledNote && (
        <Callout tone="info" title={t('taskStatusCancelled')}>{t('taskCancelledNote')}</Callout>
      )}

      {sections.activity && activityKey !== null && (
        <DetailSection title={t('taskActivityTitle')}>
          <p style={styles.body}>
            {t(activityKey)}
            {task.lastActivityAt !== null && task.lastActivityAt !== undefined && ` · ${t('taskLastActive')} ${formatClock(task.lastActivityAt)}`}
          </p>
        </DetailSection>
      )}

      {sections.question && task.question !== null && (
        <DetailSection title={t('taskQuestionTitle')}>
          <Callout tone="warn" title={task.question.question}>
            <div style={styles.answerRow}>
              <input
                style={styles.answerInput}
                value={answer}
                placeholder={t('taskAnswerPlaceholder')}
                onChange={event => { setAnswer(event.target.value) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && answer.trim() !== '' && busy === null) void act('answer', answer.trim())
                }}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== null || answer.trim() === ''}
                onClick={() => { void act('answer', answer.trim()) }}
              >
                {busy === 'answer' ? t('taskAnswerSending') : t('taskAnswerSend')}
              </Button>
            </div>
            <p style={styles.hint}>{t('taskAnswerHint')}</p>
          </Callout>
        </DetailSection>
      )}

      {sections.prompt && task.prompt !== null && (
        <DetailSection title={t('panelTaskPrompt')}>
          <p style={styles.body}>{clip(task.prompt, 1200)}</p>
        </DetailSection>
      )}

      {sections.error && task.error !== null && (
        <Callout tone="error" title={t('taskErrorTitle')}>
          {clip(task.error.message, 600)}
          {sections.retry && (
            <div style={styles.actions}>
              <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void act('retry') }}>
                {busy === 'retry' ? t('taskRetrying') : t('taskRetry')}
              </Button>
            </div>
          )}
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

      {sections.record && task.childSessionId !== null && (
        <DetailSection title={t('taskRecordTitle')}>
          {recordOpen
            ? (
              <div style={styles.recordBox}>
                <TaskActivity taskId={task.id} store={store} t={t} />
              </div>
            )
            : (
              <Button size="sm" variant="outline" onClick={() => { setRecordOpen(true) }}>
                {t('taskRecordOpen')}
              </Button>
            )}
          {recordOpen && (
            <button type="button" style={styles.collapseLink} onClick={() => { setRecordOpen(false) }}>
              {t('taskRecordClose')}
            </button>
          )}
        </DetailSection>
      )}

      {(sections.stop || (!sections.error && sections.retry)) && open && (
        <div style={styles.actions}>
          {sections.stop && (
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void act('stop') }}>
              {busy === 'stop' ? t('taskCancelling') : t('taskStop')}
            </Button>
          )}
          {!sections.error && sections.retry && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void act('retry') }}>
              {busy === 'retry' ? t('taskRetrying') : t('taskRetry')}
            </Button>
          )}
        </div>
      )}

      {!sections.prompt && !sections.question && !sections.activity && !sections.result && !sections.artifacts && !sections.error && !sections.record && (
        <Empty>{t('taskNoRecordedDetail')}</Empty>
      )}

      <details style={styles.diagnostics}>
        <summary style={styles.summary}>{t('taskDiagnosticsTitle')}</summary>
        <dl style={styles.diagList}>
          <div style={styles.diagRow}>
            <dt style={styles.diagKey}>{t('taskDiagSession')}</dt>
            <dd style={styles.diagValue}>
              <code style={styles.diagCode}>{task.childSessionId ?? '—'}</code>
              {task.childSessionId !== null && (
                <Button size="sm" variant="ghost" onClick={() => { if (task.childSessionId !== null) props.openSession(task.childSessionId) }}>
                  {t('taskDiagOpenSession')}
                </Button>
              )}
            </dd>
          </div>
          {task.resultRevision !== undefined && task.resultRevision !== null && (
            <div style={styles.diagRow}>
              <dt style={styles.diagKey}>{t('taskDiagRevision')}</dt>
              <dd style={styles.diagValue}><code style={styles.diagCode}>{task.resultRevision}</code></dd>
            </div>
          )}
          {task.originLabel !== undefined && (
            <div style={styles.diagRow}>
              <dt style={styles.diagKey}>{t('taskDiagOrigin')}</dt>
              <dd style={styles.diagValue}>{task.originLabel === 'source' ? t('taskOriginSource') : t('taskOriginDirect')}</dd>
            </div>
          )}
          {task.error !== null && (
            <div style={styles.diagRow}>
              <dt style={styles.diagKey}>{t('taskDiagError')}</dt>
              <dd style={styles.diagValue}><code style={styles.diagCode}>{task.error.code}</code></dd>
            </div>
          )}
        </dl>
      </details>

      {error !== null && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  )
}

/** Localized task status; kept as a named export for the card and the list. */
export function taskStatusLabel(status: string, t: (key: QunoLocaleKey) => string): string {
  return t(taskUserStatusKey(taskUserStatus({ status })))
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
  hint: { margin: '6px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' },
  answerRow: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 },
  answerInput: {
    flex: 1, minWidth: 0, fontSize: 12, padding: '6px 10px', borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)', outline: 'none',
  },
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
  recordBox: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '8px 10px', background: 'var(--dsw-alias-bg-layer-1)' },
  collapseLink: {
    alignSelf: 'flex-start', marginTop: 4, border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
    font: 'inherit', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)',
  },
  diagnostics: { marginTop: 8 },
  diagList: { margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 4 },
  diagRow: { display: 'flex', gap: 8, alignItems: 'baseline' },
  diagKey: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', minWidth: 84 },
  diagValue: { margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' },
  diagCode: { fontSize: 10.5, fontFamily: 'ui-monospace, monospace', color: 'var(--dsw-alias-label-tertiary)' },
} as const
