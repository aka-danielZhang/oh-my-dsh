/**
 * The right-sidebar Quno panel: one tab type registered through the two-stage
 * mechanism (`sidebarRightTabs.register` + keyed `sidebar.right.pane.tab`).
 *
 * This module owns only chrome — the view switch, navigation parameters and
 * the loading/missing boundary between a list and its detail. Each body lives
 * in its own module so the four views stay independently reviewable and
 * testable.
 *
 * @module dsh-quno/client/panel
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import type { QunoPanelView } from './right-tab.ts'
import { narrowPanelParams } from './right-tab.ts'
import { taskUserStatus } from './panel-state.ts'
import { SenseDetail, senseContext } from './sense-detail.tsx'
import { SenseListPage } from './sense-list.tsx'
import { AttentionPage } from './attention-view.tsx'
import { TaskDetailPage, TaskListPage } from './task-list.tsx'
import { RunsPage } from './runs-view.tsx'
import {
  Callout,
  LoadingRows,
  MissingState,
  PanelEmpty,
  SegmentedTabs,
} from './panel-primitives.tsx'
import { QunoMark } from './quno-mark.tsx'

/** Injected face of the panel body. */
export interface QunoPanelInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly openSession: (sessionId: string) => void
  /** Open the onboarding wizard in edit mode (shared with settings). */
  readonly onEditSense?: (instanceId: string, type: string) => void
  /** Open the onboarding wizard in create mode. */
  readonly onAddSense?: () => void
}

type PanelTabProps = PropsRuntime<'sidebar.right.pane.tab'> & QunoPanelInjected

/** The chip title: the Quno name, with the running-task count while any runs. */
export function QunoPanelTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & QunoPanelInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const running = snapshot.state?.tasks.filter(task => {
    const status = taskUserStatus(task)
    return status === 'running' || status === 'accepted' || status === 'waiting'
  }).length ?? 0
  return (
    <span style={styles.titleChip}>
      <QunoMark size={14} />
      {running > 0 ? `${props.t('nav')} · ${running}` : props.t('nav')}
    </span>
  )
}

/** Render the panel body (docked, floating, or fullscreen — dockkit's call). */
export function QunoPanelTab(props: PanelTabProps): React.ReactElement {
  const { tab } = props.useTabInfo()
  const params = narrowPanelParams(tab.navigation.params)
  const [view, setView] = React.useState<QunoPanelView>(params?.view ?? (params?.taskId !== undefined ? 'task' : 'sense'))
  const [taskId, setTaskId] = React.useState<string | null>(params?.taskId ?? null)
  const [senseId, setSenseId] = React.useState<string | null>(params?.senseId ?? null)
  const [runId, setRunId] = React.useState<string | null>(params?.runId ?? null)

  // Re-navigation (the capsule or a card opens with new params) re-applies the focus.
  React.useEffect(() => {
    if (params?.taskId !== undefined) {
      setTaskId(params.taskId)
      setSenseId(null)
      setRunId(null)
      setView('task')
    } else if (params?.senseId !== undefined) {
      setSenseId(params.senseId)
      setTaskId(null)
      setRunId(null)
      setView('sense')
    } else if (params?.view !== undefined) {
      setTaskId(null)
      setSenseId(null)
      setRunId(params.runId ?? null)
      setView(params.view)
    }
    // `revision` bumps on every navigation, whether or not params changed.
  }, [params?.taskId, params?.senseId, params?.runId, params?.view, tab.navigation.revision])

  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)

  const switchView = (next: QunoPanelView): void => {
    setView(next)
    setTaskId(null)
    setSenseId(null)
    setRunId(null)
  }

  return (
    <div style={styles.root} data-quno-panel="">
      <div style={styles.tabRow}>
        <SegmentedTabs
          active={view}
          onChange={switchView}
          tabs={[
            { key: 'sense', label: props.t('panelTabSense') },
            { key: 'attention', label: props.t('panelTabAttentionShort') },
            { key: 'task', label: props.t('tabTasks') },
            { key: 'runs', label: props.t('tabRuns') },
          ]}
        />
      </div>
      <div style={styles.body}>
        {snapshot.phase === 'ready' && snapshot.error !== null && (
          <div style={styles.staleRow}>
            <Callout
              tone="warn"
              title={props.t('panelRefreshFailed')}
              action={{ label: props.t('retry'), onClick: () => { void props.store.refresh() } }}
            >
              {snapshot.error}
            </Callout>
          </div>
        )}
        {view === 'sense' && (senseId === null
          ? (
            <SenseListPage
              snapshot={snapshot}
              store={props.store}
              t={props.t}
              onOpen={setSenseId}
              {...(props.onAddSense === undefined ? {} : { onAdd: props.onAddSense })}
            />
          )
          : (
            <SenseDetailPage
              senseId={senseId}
              snapshot={snapshot}
              store={props.store}
              t={props.t}
              onBack={() => { setSenseId(null) }}
              {...(props.onEditSense === undefined ? {} : { onEditSense: props.onEditSense })}
            />
          ))}
        {view === 'attention' && <AttentionPage snapshot={snapshot} store={props.store} t={props.t} />}
        {view === 'task' && (taskId === null
          ? <TaskListPage snapshot={snapshot} store={props.store} t={props.t} onOpen={setTaskId} />
          : (
            <TaskDetailPage
              taskId={taskId}
              snapshot={snapshot}
              store={props.store}
              t={props.t}
              openSession={props.openSession}
              onBack={() => { setTaskId(null) }}
            />
          ))}
        {view === 'runs' && (
          <RunsPage
            snapshot={snapshot}
            store={props.store}
            t={props.t}
            runId={runId}
            onOpen={setRunId}
            onBack={() => { setRunId(null) }}
          />
        )}
      </div>
    </div>
  )
}

/** One Sense's full detail, with the honest missing state after a removal. */
function SenseDetailPage(props: {
  readonly senseId: string
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly onBack: () => void
  readonly onEditSense?: (instanceId: string, type: string) => void
}): React.ReactElement {
  const { t, snapshot } = props
  const state = snapshot.state
  if (state === null) {
    if (snapshot.phase === 'error') {
      return (
        <PanelEmpty
          icon="sense"
          title={t('loadFailedTitle')}
          description={snapshot.error ?? ''}
          action={{ label: t('retry'), onClick: () => { void props.store.refresh() } }}
        />
      )
    }
    return <LoadingRows rows={4} />
  }
  const context = senseContext(state, props.senseId)
  if (context.instance === undefined) {
    return (
      <MissingState
        icon="sense"
        title={t('senseMissing')}
        description={t('senseMissingDesc')}
        backLabel={t('panelBack')}
        onBack={props.onBack}
      />
    )
  }
  const instance = context.instance
  return (
    <SenseDetail
      store={props.store}
      t={t}
      instance={instance}
      type={context.type}
      gaps={context.gaps}
      onBack={props.onBack}
      {...(props.onEditSense === undefined
        ? {}
        : { onEdit: () => { props.onEditSense?.(instance.id, instance.type) } })}
    />
  )
}

const styles = {
  titleChip: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 },
  root: { display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 },
  tabRow: { padding: '8px 10px 4px' },
  body: { flex: 1, minWidth: 0, overflowY: 'auto', padding: '4px 10px 12px' },
  staleRow: { paddingBottom: 6 },
} as const
