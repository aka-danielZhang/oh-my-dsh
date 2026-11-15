/**
 * The worker session surface (design v2 §6): a native executor session
 * presented read-only. Three seats carry it:
 *
 * - `conversation.header.leading` (single/root): ONE combined identity —
 *   Quno main identity OR worker identity (「‹ 返回 Quno」+ task title +
 *   Worker label + status). One registration because a single slot has one
 *   cell: a second registration would shadow the first outright.
 * - `conversation.session.header.actions` (list): the per-status task
 *   commands (停止任务 / 重试) — never nested inside a row button (v2 §5.2).
 * - `conversation.composer` (chain elect): replaces the whole composer for
 *   executor sessions with the read-only notice and the collapsible task
 *   summary (v2 §6.2 + §10). This is the client half of v2 §9.4 inspect —
 *   the Host-side submit gate stays the recorded fork follow-up; program
 *   inputs bypass the composer entirely and are never touched.
 *
 * A worker session is recognized by the durable id convention
 * `quno-exec-<ticketId>` (presentation.ts) and the `quno-task` preset
 * projection — never by UI-side session lists.
 *
 * @module dsh-quno/client/worker-session
 */

import React from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { EXECUTOR_PRESET, executorTicketIdOf, workerLabelOf } from '../presentation.ts'
import { selectWorkerComposer, type WorkerComposerMatch } from './work-model.ts'
import type { TaskWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { consumeEntryFocus } from './work-navigation.ts'
import { clip, formatClock, formatDuration } from './format.ts'
import { taskTone, taskUserStatus, taskUserStatusKey } from './panel-state.ts'
import { StatusLabel } from './panel-primitives.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { QunoHeaderIdentity } from './header-identity.tsx'
import { QunoMark } from './quno-mark.tsx'

/** Shared injected face of the worker seats. */
export interface QunoWorkerInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  /** Return to the Quno main conversation (v2 §9.3 backToQuno). */
  readonly onBack: (keyboard: boolean) => void
}

export { selectWorkerComposer, type WorkerComposerMatch } from './work-model.ts'

/** Full props of the read-only composer takeover. */
export type WorkerComposerProps =
  PropsRuntime<'conversation.composer'> & PropsLocale<'quno'> & QunoWorkerInjected & { matched: WorkerComposerMatch }

/**
 * The read-only composer replacement (v2 §6.2): a status line explaining why
 * there is nothing to type, plus the task summary as collapsible info
 * (v2 §10 — the detail page retired).
 */
export function WorkerComposerTakeover(props: WorkerComposerProps): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const task = snapshot.state?.tasks.find(candidate => candidate.id === props.matched.ticketId) ?? null
  return (
    <div className="quno-worker-readonly" role="status">
      <p className="quno-worker-readonly__note">
        <strong>{props.t('workerReadonlyTitle')}</strong>
        <span>{props.t('workerReadonlyBody')}</span>
      </p>
      {task !== null && <WorkerTaskSummary task={task} store={props.store} t={props.t} />}
    </div>
  )
}

/** The collapsible task summary (v2 §10): the retired detail page, in-session. */
export function WorkerTaskSummary(props: {
  readonly task: TaskWire
  readonly store: QunoClientStore
  readonly t: QunoTranslate
}): React.ReactElement {
  const { task, t } = props
  const [busy, setBusy] = React.useState<'answer' | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [answer, setAnswer] = React.useState('')
  const [copied, setCopied] = React.useState<string | null>(null)
  const status = taskUserStatus(task)
  const statusLabel = t(taskUserStatusKey(status))
  const duration = task.settledAt === null ? null : Math.max(0, task.settledAt - task.createdAt)
  const hasBody = task.prompt !== null || task.question !== null || task.result !== null
    || task.resultDigest !== null || task.artifacts.length > 0 || task.error !== null

  const act = async (text: string): Promise<void> => {
    if (busy !== null) return
    setBusy('answer')
    setError(null)
    try {
      await props.store.taskCommand(task.id, 'answer', text)
      setAnswer('')
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

  return (
    <details className="quno-worker-summary">
      <summary className="quno-worker-summary__head">
        <span className="quno-worker-summary__title">{task.title}</span>
        <StatusLabel tone={taskTone(task)}>{statusLabel}</StatusLabel>
      </summary>
      <div className="quno-worker-summary__body">
        {task.prompt !== null && task.prompt !== '' && (
          <section>
            <h3>{t('panelTaskPrompt')}</h3>
            <p>{clip(task.prompt, 1200)}</p>
          </section>
        )}
        {task.question !== null && status === 'needs-you' && (
          <section>
            <h3>{t('taskQuestionTitle')}</h3>
            <p className="quno-worker-summary__question">{task.question.question}</p>
            <div className="quno-worker-summary__answer">
              <input
                value={answer}
                placeholder={t('taskAnswerPlaceholder')}
                aria-label={t('taskAnswerPlaceholder')}
                onChange={event => { setAnswer(event.target.value) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && answer.trim() !== '' && busy === null) void act(answer.trim())
                }}
              />
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== null || answer.trim() === ''}
                onClick={() => { void act(answer.trim()) }}
              >
                {busy === 'answer' ? t('taskAnswerSending') : t('taskAnswerSend')}
              </Button>
            </div>
            <p className="quno-worker-summary__hint">{t('taskAnswerHint')}</p>
          </section>
        )}
        {task.error !== null && (
          <section>
            <h3>{t('taskErrorTitle')}</h3>
            <p className="quno-worker-summary__error">{clip(task.error.message, 600)}</p>
          </section>
        )}
        {(task.result !== null || task.resultDigest !== null) && (
          <section>
            <h3>{t('panelTaskResult')}</h3>
            <p>{task.result !== null && task.result !== '' ? clip(task.result, 2400) : task.resultDigest ?? ''}</p>
          </section>
        )}
        {task.artifacts.length > 0 && (
          <section>
            <h3>{t('taskArtifacts')}</h3>
            {task.artifacts.map(artifact => (
              <div key={`${artifact.kind}:${artifact.uri}`} className="quno-worker-summary__artifact">
                <span className="quno-worker-summary__artifact-kind">{artifact.kind}</span>
                {artifact.kind === 'url'
                  ? <a href={artifact.uri} target="_blank" rel="noreferrer">{artifact.label}</a>
                  : <span>{artifact.label}</span>}
                {(artifact.kind === 'file' || artifact.kind === 'directory') && (
                  <Button size="sm" variant="ghost" onClick={() => { void copy(artifact.uri) }}>
                    {copied === artifact.uri ? t('taskCopied') : t('taskCopyPath')}
                  </Button>
                )}
              </div>
            ))}
          </section>
        )}
        {duration !== null && (
          <p className="quno-worker-summary__meta">
            {t('taskDuration')} {formatDuration(duration)} · {t('taskLastActive')} {formatClock(task.lastActivityAt ?? task.settledAt)}
          </p>
        )}
        {!hasBody && <p className="quno-worker-summary__meta">{t('taskNoRecordedDetail')}</p>}
        {error !== null && <p className="quno-worker-summary__error">{error}</p>}
        <p className="quno-worker-summary__meta quno-worker-summary__diag">
          {t('taskDiagSession')} <code>{task.childSessionId ?? '—'}</code>
          {task.resultRevision !== undefined && task.resultRevision !== null && (
            <>{' · '}{t('taskDiagRevision')} <code>{task.resultRevision}</code></>
          )}
        </p>
      </div>
    </details>
  )
}

/** Props of the combined leading identity (one cell — both claims live here). */
export type QunoLeadingIdentityProps =
  PropsRuntime<'conversation.header.leading'> & QunoWorkerInjected

/**
 * Combined `conversation.header.leading` identity (v2 §6.1): the Quno main
 * identity on a main, the worker identity (back + title + label + status) on
 * an executor session, nothing otherwise. Hooks stay unconditional — the
 * preset only decides what RENDERS, never which hooks run.
 */
export function QunoLeadingIdentity(props: QunoLeadingIdentityProps): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const mainViewId = props.useSessions((state) => {
    for (const row of Object.values(state.byId)) {
      if ((row.retainedBy.mainView ?? 0) > 0) return row.id
    }
    return undefined
  })
  const preset = props.useSessions(sessions => mainViewId === undefined
    ? undefined
    : sessions.byId[mainViewId]?.projectionValues?.agentPreset)
  const backRef = React.useRef<HTMLButtonElement | null>(null)
  const isWorker = preset === EXECUTOR_PRESET && mainViewId !== undefined
    && executorTicketIdOf(mainViewId) !== null

  // v2 §6.3: a keyboard entry moves focus to「返回 Quno」once; mouse entry
  // never steals focus. Consuming the one-shot flag keeps later remounts
  // (scroll restoration, panel reopen) from grabbing focus back.
  React.useEffect(() => {
    if (!isWorker) return
    if (!consumeEntryFocus(typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined' ? window.sessionStorage : null)) return
    backRef.current?.focus()
  }, [isWorker, mainViewId])

  // Quno main: delegate to the shipped identity (it re-checks the preset).
  if (preset === 'quno') return <QunoHeaderIdentity {...props} />
  if (!isWorker || mainViewId === undefined) return null

  const ticketId = executorTicketIdOf(mainViewId)
  if (ticketId === null) return null
  const task = snapshot.state?.tasks.find(candidate => candidate.id === ticketId) ?? null
  const status = task === null ? null : taskUserStatus(task)
  const statusLabel = status === null ? null : props.t(taskUserStatusKey(status))
  return (
    <span className="quno-worker-identity" data-quno-worker="">
      <button
        type="button"
        ref={backRef}
        className="quno-worker-identity__back"
        onClick={event => { props.onBack(event.detail === 0) }}
      >
        ‹ {props.t('workerBackToQuno')}
      </button>
      <span className="quno-worker-identity__divider" aria-hidden="true" />
      <span className="quno-worker-identity__title">{task === null ? props.t('workerRecordUnavailable') : task.title}</span>
      <span className="quno-worker-identity__meta">
        <QunoMark size={12} />
        <span>{workerLabelOf(ticketId)}</span>
        {statusLabel !== null && <StatusLabel tone={taskTone(task ?? { status: 'dropped' })}>{statusLabel}</StatusLabel>}
      </span>
    </span>
  )
}

/** Props of the per-status worker commands. */
export type QunoWorkerCommandsProps =
  PropsRuntime<'conversation.session.header.actions'> & Pick<QunoWorkerInjected, 'store' | 't'>

/**
 * Worker commands in the session header actions (v2 §6.1): 停止任务 / 重试 by
 * status. Never nested in a row button; the answer entry lives in the summary.
 */
export function QunoWorkerCommands(props: QunoWorkerCommandsProps): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const [busy, setBusy] = React.useState<'stop' | 'retry' | null>(null)
  const ticketId = typeof props.sessionId === 'string' ? executorTicketIdOf(props.sessionId) : null
  if (ticketId === null) return null
  const task = snapshot.state?.tasks.find(candidate => candidate.id === ticketId) ?? null
  if (task === null) return null
  const status = taskUserStatus(task)
  const open = status === 'accepted' || status === 'running' || status === 'waiting' || status === 'needs-you'

  const act = async (action: 'stop' | 'retry'): Promise<void> => {
    if (busy !== null) return
    setBusy(action)
    try {
      await props.store.taskCommand(task.id, action === 'retry' ? 'resume' : 'cancel')
    } finally {
      setBusy(null)
    }
  }

  return (
    <span className="quno-worker-commands">
      {open && (task.canCancel ?? true) && (
        <button
          type="button"
          className="quno-worker-commands__stop"
          disabled={busy !== null}
          onClick={() => { void act('stop') }}
        >
          {busy === 'stop' ? props.t('taskCancelling') : props.t('taskStop')}
        </button>
      )}
      {!open && (task.canRetry ?? false) && (
        <button
          type="button"
          className="quno-worker-commands__retry"
          disabled={busy !== null}
          onClick={() => { void act('retry') }}
        >
          {busy === 'retry' ? props.t('taskRetrying') : props.t('taskRetry')}
        </button>
      )}
    </span>
  )
}
