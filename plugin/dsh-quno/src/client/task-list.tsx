/**
 * 任务: the delegated-task list, grouped by what the user can do about it
 * (需要你 / 进行中 / 已结束 — design §6.1), plus the detail routing (including
 * the honest "this task is gone" page). Every row drills into the detail; the
 * execution record is reached from there, never directly.
 *
 * @module dsh-quno/client/task-list
 */

import React from 'react'
import type { TaskWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import { formatClock } from './format.ts'
import { groupTasks, taskTone, taskUserStatus, taskUserStatusKey } from './panel-state.ts'
import {
  LoadingRows,
  MissingState,
  PanelEmpty,
  PanelListRow,
  PanelSection,
  StatusLabel,
} from './panel-primitives.tsx'
import { TaskDetail } from './task-detail.tsx'

/** Props of the 任务 list. */
export interface TaskListPageProps {
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly onOpen: (taskId: string) => void
}

/** Render the 任务 tab. */
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

  const row = (task: TaskWire): React.ReactElement => {
    const status = taskUserStatus(task)
    const when = task.lastActivityAt ?? task.settledAt ?? task.createdAt
    return (
      <PanelListRow
        key={task.id}
        tone={taskTone(task)}
        title={task.title}
        subtitle={formatClock(when)}
        meta={<StatusLabel tone={taskTone(task)}>{t(taskUserStatusKey(status))}</StatusLabel>}
        onClick={() => { props.onOpen(task.id) }}
        titleAttr={task.title}
      />
    )
  }

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

/** Props of one task detail page. */
export interface TaskDetailPageProps {
  readonly taskId: string
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly openSession: (sessionId: string) => void
  readonly onBack: () => void
}

/** Resolve one task id, then render its detail or the honest missing page. */
export function TaskDetailPage(props: TaskDetailPageProps): React.ReactElement {
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
  const task = state.tasks.find(candidate => candidate.id === props.taskId)
  if (task === undefined) {
    return (
      <MissingState
        icon="task"
        title={t('taskMissing')}
        description={t('taskMissingDesc')}
        backLabel={t('panelBack')}
        onBack={props.onBack}
      />
    )
  }
  return (
    <TaskDetail
      store={props.store}
      t={t}
      task={task}
      openSession={props.openSession}
      onBack={props.onBack}
    />
  )
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
} as const
