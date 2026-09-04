/** Operational Memory settings page with dream scheduling and Markdown browse. */

import React from 'react'
import {
  Button,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconDatabaseOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconLoadingOutline16,
  IconRefreshOutline16,
  IconSparkle16,
  IconStopFill16,
  IconWarningOutline16,
  MarkdownText,
  Tooltip,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DreamRunStatus, MemoryDocument, MemoryOverview, MemoryTreeSnapshot } from '../manager-contract.ts'
import type { MemorySettingsController } from './controller.ts'
import { buildMemoryTree, type MemoryTreeNode } from './tree.ts'
import type { MemoryLocaleKey } from './locales.ts'

/** Dependencies injected by the Client registration. */
export interface MemorySettingsInjected {
  controller: MemorySettingsController
  hooks: {
    memory: MemorySettingsController['store']
  }
}

export type MemorySettingsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.ohMyMemo'>
  & InjectFace<MemorySettingsInjected>

/** Render the top-level Memory settings section. */
export function MemorySettingsSection(props: MemorySettingsSectionProps): React.ReactElement {
  const state = props.useMemory(snapshot => snapshot)
  const [tab, setTab] = React.useState<'overview' | 'space'>('overview')

  React.useEffect(() => {
    const unmount = props.controller.mount()
    void props.controller.load()
    return unmount
  }, [props.controller])

  return (
    <section className="omm-root">
      <header className="omm-header">
        <h2 className="omm-title">{props.t('title')}</h2>
        <div className="omm-header-actions">
          <Tooltip label={props.t('refresh')} side="bottom">
            <Button
              className="omm-icon-button"
              variant="toolbar"
              size="sm"
              aria-label={props.t('refresh')}
              disabled={state.operation !== null}
              onClick={() => { void props.controller.load() }}
            >
              <IconRefreshOutline16 className={state.operation === 'refresh' ? 'omm-spin' : undefined} />
            </Button>
          </Tooltip>
        </div>
      </header>
      <div className="omm-tabs" role="tablist">
        <button
          className="omm-tab"
          role="tab"
          aria-selected={tab === 'overview'}
          onClick={() => { setTab('overview') }}
        >
          {props.t('overviewTab')}
        </button>
        <button
          className="omm-tab"
          role="tab"
          aria-selected={tab === 'space'}
          onClick={() => { setTab('space') }}
        >
          {props.t('spaceTab')}
        </button>
      </div>
      {state.error !== null && (
        <div className="omm-error" role="alert">
          <IconWarningOutline16 />
          <span>{state.error}</span>
        </div>
      )}
      {state.notice !== null && <div className="omm-notice" role="status">{props.t(noticeKey(state.notice))}</div>}
      <div className="omm-body">
        {state.status === 'loading' && <LoadingState t={props.t} />}
        {state.status === 'error' && state.overview === null && (
          <div className="omm-empty">
            <IconWarningOutline16 />
            <span>{props.t('loadFailed')}</span>
            <Button variant="outline" size="sm" onClick={() => { void props.controller.load() }}>{props.t('retry')}</Button>
          </div>
        )}
        {state.overview !== null && tab === 'overview' && (
          <Overview
            overview={state.overview}
            operation={state.operation}
            t={props.t}
            onSettings={patch => { void props.controller.updateSettings(patch) }}
            onRun={() => { void props.controller.runNow() }}
            onCancel={() => { void props.controller.cancelRun() }}
          />
        )}
        {state.tree !== null && tab === 'space' && (
          <MemorySpace
            tree={state.tree}
            document={state.document}
            documentPath={state.documentPath}
            reading={state.operation === 'read'}
            t={props.t}
            onSelect={path => { void props.controller.read(path) }}
          />
        )}
      </div>
    </section>
  )
}

function LoadingState(props: { t: (key: MemoryLocaleKey) => string }): React.ReactElement {
  return (
    <div className="omm-loading">
      <IconLoadingOutline16 className="omm-spin" />
      <span>{props.t('loading')}</span>
    </div>
  )
}

function Overview(props: {
  overview: MemoryOverview
  operation: string | null
  t: (key: MemoryLocaleKey) => string
  onSettings(patch: { enabled?: boolean; scheduleLocalTime?: string }): void
  onRun(): void
  onCancel(): void
}): React.ReactElement {
  const { overview, t } = props
  const busy = props.operation !== null
  const running = overview.dream.status === 'running'
  return (
    <div>
      <section className="omm-band">
        <div className="omm-band-head">
          <h3 className="omm-band-title">
            <IconSparkle16 />
            <strong>{t('dreamTitle')}</strong>
          </h3>
          <div className="omm-header-actions">
            <span className="omm-state-label">{overview.dream.enabled ? t('dreamEnabled') : t('dreamDisabled')}</span>
            <button
              className="omm-switch"
              type="button"
              role="switch"
              aria-label={t('toggleDream')}
              aria-checked={overview.dream.enabled}
              disabled={busy}
              onClick={() => { props.onSettings({ enabled: !overview.dream.enabled }) }}
            />
          </div>
        </div>
        <div className="omm-controls">
          <label className="omm-field">
            <span>{t('scheduleTime')}</span>
            <input
              className="omm-time"
              type="time"
              value={overview.dream.scheduleLocalTime}
              disabled={busy}
              onChange={(event) => {
                if (/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(event.currentTarget.value)) {
                  props.onSettings({ scheduleLocalTime: event.currentTarget.value })
                }
              }}
            />
          </label>
          <div className="omm-actions">
            {running ? (
              <Button
                variant="outline"
                size="sm"
                icon={<IconStopFill16 />}
                disabled={props.operation === 'cancel'}
                onClick={props.onCancel}
              >
                {t('cancelRun')}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                icon={props.operation === 'run' ? <IconLoadingOutline16 className="omm-spin" /> : <IconSparkle16 />}
                disabled={!overview.dream.enabled || busy}
                onClick={props.onRun}
              >
                {t('runNow')}
              </Button>
            )}
          </div>
        </div>
        <div className="omm-grid">
          <Fact label={t('status')} value={t(statusKey(overview.dream.status))} />
          <Fact label={t('lastRun')} value={formatDate(overview.dream.lastAttemptAt, t)} />
          <Fact label={t('nextRun')} value={formatDate(overview.dream.nextRunAt, t)} />
          <Fact label={t('lastSuccess')} value={formatDate(overview.dream.lastSuccessAt, t)} />
          <Fact label={t('scheduleTime')} value={overview.dream.scheduleLocalTime} />
          <Fact label={t('hostTimeZone')} value={overview.dream.timeZone} />
        </div>
        {overview.dream.lastResult !== null && (
          <div>
            <div className="omm-last-result">
              <ResultMetric label={t('sourceMessages')} value={overview.dream.lastResult.sourceMessages} />
              <ResultMetric label={t('candidatesCreated')} value={overview.dream.lastResult.candidatesCreated} />
              <ResultMetric label={t('candidatesRejected')} value={overview.dream.lastResult.candidatesRejected} />
            </div>
            {overview.dream.lastResult.detail !== null && <div className="omm-diagnostic">{overview.dream.lastResult.detail}</div>}
          </div>
        )}
      </section>
      <section className="omm-band">
        <div className="omm-band-head">
          <h3 className="omm-band-title">
            <IconDatabaseOutline16 />
            <strong>{t('inventoryTitle')}</strong>
          </h3>
        </div>
        <div className="omm-counts">
          <Count label={t('active')} value={overview.counts.active} />
          <Count label={t('candidates')} value={overview.counts.candidate} />
          <Count label={t('disputed')} value={overview.counts.disputed} />
          <Count label={t('archived')} value={overview.counts.superseded} />
        </div>
        <div className="omm-health">
          <span className="omm-health-state">
            <span className="omm-dot" data-state={overview.watch.active ? 'active' : 'warning'} />
            {overview.watch.active ? t('watcherActive') : t('watcherInactive')}
          </span>
          <span>{overview.files.count} {t('files')}</span>
        </div>
        {overview.watch.degradedReason !== null && <div className="omm-diagnostic">{overview.watch.degradedReason}</div>}
        {overview.files.truncated && <div className="omm-diagnostic">{t('fileLimit')}</div>}
      </section>
    </div>
  )
}

function Fact(props: { label: string; value: string }): React.ReactElement {
  return <div className="omm-fact"><span className="omm-fact-label">{props.label}</span><span className="omm-fact-value">{props.value}</span></div>
}

function ResultMetric(props: { label: string; value: number }): React.ReactElement {
  return <span className="omm-result-metric"><b>{props.value}</b><span>{props.label}</span></span>
}

function Count(props: { label: string; value: number }): React.ReactElement {
  return <span className="omm-count"><b>{props.value}</b><span>{props.label}</span></span>
}

function MemorySpace(props: {
  tree: MemoryTreeSnapshot
  document: MemoryDocument | null
  documentPath: string | null
  reading: boolean
  t: (key: MemoryLocaleKey) => string
  onSelect(path: string): void
}): React.ReactElement {
  const nodes = React.useMemo(() => buildMemoryTree(props.tree.files), [props.tree.files])
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [mobileView, setMobileView] = React.useState<'tree' | 'viewer'>('tree')

  React.useEffect(() => {
    setExpanded(current => {
      if (current.size > 0) return current
      return new Set(nodes.filter(node => node.type === 'folder').map(node => node.path))
    })
  }, [nodes])

  const select = (path: string): void => {
    props.onSelect(path)
    setMobileView('viewer')
  }
  return (
    <div className="omm-space" data-mobile-view={mobileView}>
      <aside className="omm-tree-pane">
        <div className="omm-tree-head">{props.t('folders')}</div>
        {nodes.length === 0 ? <div className="omm-empty">{props.t('noFiles')}</div> : nodes.map(node => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selected={props.documentPath}
            expanded={expanded}
            t={props.t}
            onToggle={(path) => {
              setExpanded(current => {
                const next = new Set(current)
                if (next.has(path)) next.delete(path)
                else next.add(path)
                return next
              })
            }}
            onSelect={select}
          />
        ))}
      </aside>
      <main className="omm-viewer">
        <header className="omm-viewer-head">
          <Button
            className="omm-mobile-back"
            variant="toolbar"
            size="sm"
            icon={<IconChevronLeftOutline14 />}
            onClick={() => { setMobileView('tree') }}
          >
            {props.t('backToFiles')}
          </Button>
          <span className="omm-viewer-title">{props.document?.title ?? props.t('selectFile')}</span>
        </header>
        <DocumentViewer document={props.document} reading={props.reading} t={props.t} />
      </main>
    </div>
  )
}

function TreeRow(props: {
  node: MemoryTreeNode
  depth: number
  selected: string | null
  expanded: Set<string>
  t: (key: MemoryLocaleKey) => string
  onToggle(path: string): void
  onSelect(path: string): void
}): React.ReactElement {
  const indentation = Array.from({ length: props.depth }, (_, index) => <span key={index} className="omm-tree-indent" />)
  if (props.node.type === 'folder') {
    const open = props.expanded.has(props.node.path)
    return (
      <>
        <button className="omm-tree-row" type="button" aria-expanded={open} onClick={() => { props.onToggle(props.node.path) }}>
          {indentation}
          <span className="omm-disclosure" data-open={open}><IconChevronRightOutline14 /></span>
          {open ? <IconFolderOpen16 /> : <IconFolderClose16 />}
          <span className="omm-tree-label">{folderLabel(props.node.path, props.node.name, props.t)}</span>
        </button>
        {open && props.node.children.map(child => (
          <TreeRow
            key={child.path}
            {...props}
            node={child}
            depth={props.depth + 1}
          />
        ))}
      </>
    )
  }
  const status = props.node.file.record?.quarantined === true
    ? 'quarantined'
    : props.node.file.record?.status ?? 'view'
  return (
    <button
      className="omm-tree-row"
      type="button"
      title={props.node.path}
      data-selected={props.selected === props.node.path}
      onClick={() => { props.onSelect(props.node.path) }}
    >
      {indentation}
      <span className="omm-disclosure-spacer" />
      <span className="omm-file-icon"><span className="omm-file-dot" data-status={status} /></span>
      <span className="omm-tree-label">{props.node.name}</span>
    </button>
  )
}

function DocumentViewer(props: {
  document: MemoryDocument | null
  reading: boolean
  t: (key: MemoryLocaleKey) => string
}): React.ReactElement {
  const labels = React.useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: props.t('copyCode'), copiedLabel: props.t('copiedCode') },
    footnotes: props.t('footnotes'),
  }), [props.t])
  if (props.reading) return <LoadingState t={props.t} />
  if (props.document === null) return <div className="omm-empty"><IconDatabaseOutline16 /><span>{props.t('selectFile')}</span></div>
  if (props.document.redacted) {
    return (
      <div className="omm-redacted">
        <IconWarningOutline16 />
        <strong>{props.t('sensitiveTitle')}</strong>
        <span>{props.t('sensitiveBody')}</span>
      </div>
    )
  }
  return (
    <div className="omm-document">
      <div className="omm-meta">
        <code>{props.document.path}</code>
        {props.document.meta.status !== undefined && <span>{props.t(memoryStatusKey(props.document.meta.status))}</span>}
        {props.document.meta.kind !== undefined && <span>{props.t(memoryKindKey(props.document.meta.kind))}</span>}
        {props.document.meta.scope !== undefined && <span>{props.document.meta.scope}</span>}
      </div>
      <MarkdownText text={props.document.markdown} labels={labels} />
    </div>
  )
}

function formatDate(value: number | null, t: (key: MemoryLocaleKey) => string): string {
  if (value === null) return t('never')
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(value)
}

function statusKey(status: DreamRunStatus): MemoryLocaleKey {
  switch (status) {
    case 'idle': return 'statusIdle'
    case 'running': return 'statusRunning'
    case 'success': return 'statusSuccess'
    case 'error': return 'statusError'
    case 'cancelled': return 'statusCancelled'
  }
}

function noticeKey(notice: 'disabled' | 'already-running' | 'cancelled'): MemoryLocaleKey {
  switch (notice) {
    case 'disabled': return 'disabledNotice'
    case 'already-running': return 'alreadyRunningNotice'
    case 'cancelled': return 'cancelledNotice'
  }
}

function memoryStatusKey(status: NonNullable<MemoryDocument['meta']['status']>): MemoryLocaleKey {
  switch (status) {
    case 'candidate': return 'candidateStatus'
    case 'active': return 'activeStatus'
    case 'disputed': return 'disputedStatus'
    case 'superseded': return 'supersededStatus'
  }
}

function memoryKindKey(kind: NonNullable<MemoryDocument['meta']['kind']>): MemoryLocaleKey {
  switch (kind) {
    case 'semantic': return 'semanticKind'
    case 'episodic': return 'episodicKind'
    case 'procedural': return 'proceduralKind'
  }
}

function folderLabel(path: string, fallback: string, t: (key: MemoryLocaleKey) => string): string {
  switch (path) {
    case 'scopes': return t('folderScopes')
    case 'inbox': return t('folderInbox')
    case 'inbox/candidates': return t('folderCandidates')
    case 'archive': return t('folderArchive')
    case 'views': return t('folderViews')
    default: return fallback
  }
}
