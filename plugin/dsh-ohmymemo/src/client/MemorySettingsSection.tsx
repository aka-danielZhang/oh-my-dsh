/** Operational Memory settings page with dream scheduling and Markdown browse. */

import React from 'react'
import {
  Button,
  IconCheckOutline16,
  IconChevronDownOutline14,
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
import type { DreamModelsSnapshot, DreamRunStatus, MemoryDocument, MemoryOverview, MemoryTreeSnapshot } from '../manager-contract.ts'
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
            models={state.models}
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

function ModelPicker(props: {
  value: string
  modelLabel: string
  effortLabel: string | null
  groups: Array<{ name: string; options: Array<{ key: string; name: string; label: string }> }>
  efforts: Array<{ key: string; label: string }>
  effortValue: string
  disabled: boolean
  onPickModel(key: string): void
  onPickEffort(key: string): void
  t: (key: MemoryLocaleKey) => string
}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [pane, setPane] = React.useState<'root' | 'model' | 'effort'>('root')
  const close = (): void => { setOpen(false); setPane('root') }
  const modelPane = (
    <div className="omm-ms-groups">
      {props.groups.length === 0
        ? <div className="omm-ms-empty">{props.t('noModels')}</div>
        : props.groups.map(group => (
          <section key={group.name} className="omm-ms-group">
            <div className="omm-ms-group-title">{group.name}</div>
            {group.options.map(option => (
              <button
                key={option.key}
                type="button"
                className="omm-ms-option"
                role="menuitemradio"
                aria-checked={option.key === props.value}
                title={option.label}
                onClick={() => { close(); props.onPickModel(option.key) }}
              >
                <span className="omm-ms-option-copy"><span className="omm-ms-option-name">{option.name}</span></span>
                {option.key === props.value ? <span className="omm-ms-check"><IconCheckOutline16 /></span> : null}
              </button>
            ))}
          </section>
        ))}
    </div>
  )
  const effortPane = (
    <div className="omm-ms-groups">
      {props.efforts.map(option => (
        <button
          key={option.key}
          type="button"
          className="omm-ms-option"
          role="menuitemradio"
          aria-checked={option.key === props.effortValue}
          onClick={() => { close(); props.onPickEffort(option.key) }}
        >
          <span className="omm-ms-option-copy">
            <span className="omm-ms-option-name">{option.key === 'default' ? props.t('followDefault') : option.label}</span>
          </span>
          {option.key === props.effortValue ? <span className="omm-ms-check"><IconCheckOutline16 /></span> : null}
        </button>
      ))}
      {props.efforts.length <= 1 ? <div className="omm-ms-empty">{props.t('noEffortLevels')}</div> : null}
    </div>
  )
  return (
    <div className="omm-ms">
      <button
        type="button"
        className="omm-ms-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={props.disabled}
        title={props.modelLabel + (props.effortLabel === null ? '' : ` · ${props.effortLabel}`)}
        onClick={() => { if (open) close(); else { setPane('root'); setOpen(true) } }}
      >
        <span className="omm-ms-label">{props.modelLabel}</span>
        {props.effortLabel === null ? null : <span className="omm-ms-effort">· {props.effortLabel}</span>}
        <IconChevronDownOutline14 className={open ? 'omm-ms-caret omm-ms-caret-open' : 'omm-ms-caret'} />
      </button>
      {open ? <div className="omm-ms-backdrop" onClick={close} /> : null}
      {open ? (
        <div className="omm-ms-menu" role="menu">
          {pane === 'root' ? (
            <>
              <button type="button" className="omm-ms-cell" role="menuitem" onClick={() => { setPane('model') }}>
                <span className="omm-ms-cell-label">{props.t('extractModel')}</span>
                <span className="omm-ms-cell-value">{props.modelLabel}</span>
                <IconChevronRightOutline14 className="omm-ms-cell-chevron" />
              </button>
              <button type="button" className="omm-ms-cell" role="menuitem" onClick={() => { setPane('effort') }}>
                <span className="omm-ms-cell-label">{props.t('extractEffort')}</span>
                <span className="omm-ms-cell-value">{props.effortLabel === null ? props.t('followDefault') : props.effortLabel}</span>
                <IconChevronRightOutline14 className="omm-ms-cell-chevron" />
              </button>
            </>
          ) : pane === 'model' ? modelPane : effortPane}
        </div>
      ) : null}
    </div>
  )
}

function Overview(props: {
  overview: MemoryOverview
  models: DreamModelsSnapshot | null
  operation: string | null
  t: (key: MemoryLocaleKey) => string
  onSettings(patch: { enabled?: boolean; scheduleLocalTime?: string; modelProvider?: string; model?: string; effort?: string }): void
  onRun(): void
  onCancel(): void
}): React.ReactElement {
  const { overview, t } = props
  const busy = props.operation !== null
  const running = overview.dream.status === 'running'
  const models = props.models
  const currentModelKey = models === null ? 'default' : models.currentModelKey
  const currentEffortKey = models === null ? 'default' : models.currentEffortKey
  const modelLabel = models === null
    ? t('followDefault')
    : (models.options.find(option => option.key === currentModelKey)?.label ?? t('followDefault'))
  const effortEntry = models === null ? undefined : models.efforts.find(option => option.key === currentEffortKey)
  const effortLabel = currentEffortKey === 'default' ? null : (effortEntry?.label ?? currentEffortKey)
  const groupsMap = new Map<string, Array<{ key: string; name: string; label: string }>>()
  for (const option of models?.options ?? []) {
    const at = option.key.indexOf('/')
    const groupName = at > 0 ? option.key.slice(0, at) : t('defaultGroup')
    if (!groupsMap.has(groupName)) groupsMap.set(groupName, [])
    groupsMap.get(groupName)!.push({
      key: option.key,
      name: at > 0 ? option.label.slice(groupName.length + 3) : option.label,
      label: option.label,
    })
  }
  const groups = [...groupsMap.entries()].map(([name, options]) => ({ name, options }))
  const lastResult = overview.dream.lastResult
  return (
    <div className="omm-cards">
      <section className="omm-card">
        <div className="omm-card-head">
          <div className="omm-card-text">
            <span className="omm-card-name"><IconSparkle16 />{t('dreamTitle')}</span>
            <span className="omm-card-desc">{overview.dream.enabled ? t('dreamCardOn') : t('dreamCardOff')}</span>
          </div>
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
        <div className="omm-card-body">
          <div className="omm-rows">
            <span className="omm-k">{t('scheduleTime')}</span>
            <div className="omm-v omm-time-row">
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
              <span className="omm-k">{overview.dream.timeZone}</span>
            </div>
            <span className="omm-k">{t('extractModel')}</span>
            <div className="omm-v">
              <ModelPicker
                value={currentModelKey}
                modelLabel={modelLabel}
                effortLabel={effortLabel}
                groups={groups}
                efforts={models?.efforts ?? []}
                effortValue={currentEffortKey}
                disabled={busy || models === null || models.options.length === 0}
                onPickModel={(key) => {
                  if (key === 'default') props.onSettings({ modelProvider: '', model: '' })
                  else {
                    const at = key.indexOf('/')
                    if (at > 0) props.onSettings({ modelProvider: key.slice(0, at), model: key.slice(at + 1) })
                  }
                }}
                onPickEffort={(key) => { props.onSettings({ effort: key === 'default' ? '' : key }) }}
                t={t}
              />
            </div>
          </div>
          <div className="omm-run-meta">
            {t('status')} {t(statusKey(overview.dream.status))}
            {' · '}{t('lastRun')} {formatDate(overview.dream.lastAttemptAt, t)}
            {' · '}{t('nextRun')} {formatDate(overview.dream.nextRunAt, t)}
            {' · '}{t('lastSuccess')} {formatDate(overview.dream.lastSuccessAt, t)}
          </div>
          <div className="omm-card-actions">
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
      </section>

      {lastResult !== null && (
        <section className="omm-card">
          <div className="omm-card-head">
            <div className="omm-card-text">
              <span className="omm-card-name"><IconDatabaseOutline16 />{t('lastRunTitle')}</span>
              <span className="omm-card-desc">
                {`${t('sourceMessages')} ${lastResult.sourceMessages} · ${t('memoriesCreated')} ${lastResult.memoriesCreated} · ${t('memoriesRejected')} ${lastResult.memoriesRejected}`}
              </span>
            </div>
          </div>
          {lastResult.items.length > 0 && (
            <div className="omm-card-body">
              <ul className="omm-result-list">
                {lastResult.items.map((item, index) => (
                  <li key={index} className="omm-result-item">
                    <span className="omm-result-content">{item.content}</span>
                    <span className="omm-result-key">{item.key} · {item.kind}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {lastResult.detail !== null && <div className="omm-diagnostic">{lastResult.detail}</div>}
        </section>
      )}

      <section className="omm-card">
        <div className="omm-card-head">
          <div className="omm-card-text">
            <span className="omm-card-name"><IconDatabaseOutline16 />{t('inventoryTitle')}</span>
          </div>
        </div>
        <div className="omm-card-body">
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
        </div>
      </section>
    </div>
  )
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
