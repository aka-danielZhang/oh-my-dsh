/**
 * 工作: the worker list (design v2 §5) — one pure row per worker, grouped by
 * what the user can do about it (需要你 / 进行中 / 已结束). A row opens the
 * worker's NATIVE session directly (v2 §5.2: no detail middle page, no nested
 * buttons); the task summary lives inside that session as collapsible info.
 *
 * States follow v2 §5.4: skeleton rows while loading (never a fake "no
 * tasks"), a non-blocking refresh-failure strip above the stale list, an
 * honest empty copy, and the missing/failed worker pages.
 *
 * @module dsh-quno/client/task-list
 */

import React from 'react'
import type { TaskWire } from '../api-types.ts'
import { workerLabelOf } from '../presentation.ts'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import { groupTasks, taskTone, taskUserStatus, taskUserStatusKey } from './panel-state.ts'
import { workerRowActivity, type TaskSectionTask } from './work-model.ts'
import {
  LoadingRows,
  MissingState,
  PanelEmpty,
  PanelSection,
} from './panel-primitives.tsx'

/** Props of the 工作 list. */
export interface TaskListPageProps {
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  /** Open a worker's native session (v2 §5.2) — never a detail page. */
  readonly onOpenWorker: (ticketId: string, keyboard: boolean) => void
}

/** One worker row (v2 §5.2): the whole row is the button; nothing nests. */
export function WorkerRow(props: {
  readonly task: TaskSectionTask
  readonly t: QunoTranslate
  readonly onOpenWorker: (ticketId: string, keyboard: boolean) => void
}): React.ReactElement {
  const { task, t } = props
  const status = taskUserStatus(task)
  const statusText = t(taskUserStatusKey(status))
  const activity = workerRowActivity(task, t)
  const workerLabel = workerLabelOf(task.id)
  return (
    <button
      type="button"
      className="quno-worker-row"
      data-tone={taskTone(task)}
      onClick={event => { props.onOpenWorker(task.id, event.detail === 0) }}
      aria-label={`${task.title}，${workerLabel}，${statusText}，${t('workerRowOpenAria')}`}
    >
      <span className="quno-worker-row__title">{task.title}</span>
      <span className="quno-worker-row__worker">{workerLabel}</span>
      {activity !== null && <span className="quno-worker-row__activity">{activity}</span>}
      <span className="quno-worker-row__status">{statusText}</span>
    </button>
  )
}

/** Render the 工作 tab: grouped worker rows, straight into native sessions. */
export function TaskListPage(props: TaskListPageProps): React.ReactElement {
  const { t, snapshot } = props
  const state = snapshot.state
  if (state === null) {
    if (snapshot.phase === 'error') {
      return (
        <PanelEmpty
          icon="task"
          title={t('loadFailedTitle')}
          description={snapshot.error ?? ''}
          action={{ label: t('retry'), onClick: () => { void props.store.refresh() } }}
        />
      )
    }
    return <LoadingRows rows={3} />
  }

  const groups = groupTasks(state.tasks)
  const total = groups.needsYou.length + groups.active.length + groups.settled.length
  if (total === 0) {
    return <PanelEmpty icon="task" title={t('tasksEmptyTitle')} description={t('tasksEmptyDesc')} />
  }

  const row = (task: TaskWire): React.ReactElement => (
    <WorkerRow key={task.id} task={task} t={t} onOpenWorker={props.onOpenWorker} />
  )

  return (
    <div style={styles.stack}>
      {groups.needsYou.length > 0 && (
        <PanelSection title={t('taskGroupNeedsYou')}>{groups.needsYou.map(row)}</PanelSection>
      )}
      {groups.active.length > 0 && (
        <PanelSection title={t('taskGroupActive')}>{groups.active.map(row)}</PanelSection>
      )}
      {groups.settled.length > 0 && (
        <PanelSection title={t('taskGroupSettled')}>{groups.settled.map(row)}</PanelSection>
      )}
    </div>
  )
}

/** Why the worker session could not open (v2 §5.4 missing states). */
export interface WorkerMissing {
  readonly ticketId: string
  readonly reason: 'unknown-ticket' | 'session-not-assigned' | 'detail-failed'
  /** The worker's RAW status; the page localizes it beside the reason copy. */
  readonly statusText: string | null
}

/** The honest missing page (v2 §5.4): never auto-create, never impersonate. */
export function WorkerMissingPage(props: {
  readonly missing: WorkerMissing
  readonly t: QunoTranslate
  readonly onBack: (keyboard: boolean) => void
}): React.ReactElement {
  const { missing, t } = props
  const title = missing.reason === 'session-not-assigned'
    ? t('workerSessionNotAssigned')
    : t('workerRecordUnavailable')
  const statusText = missing.statusText === null
    ? null
    : t(taskUserStatusKey(taskUserStatus({ status: missing.statusText })))
  const description = missing.reason === 'detail-failed'
    ? t('workerDetailFailedDesc')
    : statusText !== null
      ? `${t('taskStatusCurrent')}${statusText}`
      : t('workerMissingDesc')
  return (
    <MissingState
      icon="task"
      title={title}
      description={description}
      backLabel={t('workerBackToQuno')}
      onBack={() => { props.onBack(true) }}
    />
  )
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
} as const
