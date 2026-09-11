/**
 * The scheduled-tasks panel: one unified task grid (system tasks first, then
 * user tasks by creation time), the four templates, and the full-page editor.
 *
 * Data flow follows the usage-stats posture: concurrent initial `list` +
 * `catalog`, a single-flight poll of `list()` while mounted, per-mutation
 * error mapping, and non-blocking banners that never blank a rendered list.
 * Row toggles are optimistic and roll back on failure; CAS conflicts re-read
 * and say so. Managed (system) rows render no controls at all — the Host
 * enforces their immutability, the UI merely reflects it (design §2.4, §9).
 *
 * The editor's instruction block and toolbar are the composer's own chrome
 * (see ./chips.tsx and ./styles.ts); the agent preset is pinned to `standard`
 * and deliberately not offered.
 * @module dsh-scheduled-tasks/client/AutomationPage
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconClockOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPauseOutline16,
  IconPlayOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
  Modal,
  Switch,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogSnapshot, ScheduleSpec, TaskRunRow, TaskRow, UserTaskRow } from '../types.ts'
import { LIMITS } from '../types.ts'
import { Chip, InstructionText, MenuCard, MenuItem, ModelChip, PermissionGlyph, useDismiss, WorkspaceChip } from './chips.tsx'
import { ScheduleRow, scheduleText, specOf, type ScheduleShape, type Translate } from './ScheduleRow.tsx'
import type { ScheduledTasksLocaleKey } from './locales.ts'

/** Agent preset every scheduled task runs under (not user-selectable). */
const AGENT_PRESET = 'standard'

/** Wire face bound by the client plugin body (./index.ts). */
export interface ScheduledTasksFace {
  list(): Promise<{ observedAt: number, tasks: TaskRow[] }>
  catalog(): Promise<CatalogSnapshot>
  create(request: {
    title: string
    instruction: string
    schedule: ScheduleSpec
    timeZone?: string
    workspacePath: string
    agentPreset: string
    permissionPreset: string
    model: { provider: string, model: string, reasoningEffort?: string } | null
    enabled: boolean
  }): Promise<UserTaskRow>
  update(request: {
    id: string
    ifRevision: number
    title: string
    instruction: string
    schedule: ScheduleSpec
    timeZone?: string
    workspacePath: string
    agentPreset: string
    permissionPreset: string
    model: { provider: string, model: string, reasoningEffort?: string } | null
    enabled: boolean
  }): Promise<UserTaskRow>
  setEnabled(request: { id: string, ifRevision: number, enabled: boolean }): Promise<UserTaskRow>
  deleteTask(request: { id: string, ifRevision: number }): Promise<{ removed: true }>
  runNow(request: { id: string }): Promise<UserTaskRow>
  listRuns(request: { id: string }): Promise<{ runs: TaskRunRow[] }>
  deleteRun(request: { id: string, runId: string }): Promise<{ removed: true }>
  /** Leave the panel and open the session in the conversation view. */
  openSession(sessionId: string): void
}

/** Editor form state: the wire spec plus the picker keys the UI carries. */
interface FormState {
  title: string
  instruction: string
  schedule: ScheduleShape
  enabled: boolean
  workspacePath: string
  permissionPreset: string
  modelKey: string
  effortKey: string
}

/** One template card. */
const TEMPLATES: readonly { key: string, icon: string, schedule: ScheduleShape }[] = [
  { key: 'morning', icon: '◎', schedule: { kind: 'weekdays', localTime: '09:00' } },
  { key: 'risk', icon: '∿', schedule: { kind: 'daily', localTime: '10:00' } },
  { key: 'release', icon: '▤', schedule: { kind: 'weekly', dayOfWeek: 5, localTime: '16:00' } },
  { key: 'docs', icon: '≣', schedule: { kind: 'weekly', dayOfWeek: 3, localTime: '15:00' } },
]

/** Permission presets whose composer label differs from the machine name. */
const PERMISSION_KEYS: Record<string, ScheduledTasksLocaleKey> = {
  'read-only': 'permission.readOnly',
  'workspace-write': 'permission.workspaceWrite',
  'danger-full-access': 'permission.fullAccess',
}

/** Effort ids the catalog may return, with their composer vocabulary. */
const EFFORT_KEYS: Record<string, ScheduledTasksLocaleKey> = {
  off: 'effort.off',
  low: 'effort.low',
  high: 'effort.high',
  max: 'effort.max',
}

/** `provider/model` key of a route. */
function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Outcome-or-error thrown by ./index.ts's unwrap, carrying the Remote code. */
function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined
}

/** Menu labels of the task card's ⋯ disclosure. */
interface TaskCardMenuLabels {
  more: string
  runNow: string
  pause: string
  resume: string
  edit: string
  remove: string
}

/** The task card's ⋯ disclosure: run now / pause-resume / edit, delete pinned below a divider. */
function TaskCardMenu({ row, busy, labels, onRun, onToggle, onEdit, onRequestDelete }: {
  row: UserTaskRow
  busy: boolean
  labels: TaskCardMenuLabels
  onRun: () => void
  onToggle: (next: boolean) => void
  onEdit: () => void
  onRequestDelete: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => { setOpen(false) })
  return (
    <div className="dsh-stask-more-wrap">
      <button
        type="button"
        className="dsh-stask-more"
        aria-label={labels.more}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={event => { event.stopPropagation() }}
        onClick={() => { setOpen(!open) }}
      >
        <IconEllipsisOutline16 size={16} />
      </button>
      {open
        ? (
          <MenuCard
            align="right"
            footer={(
              <MenuItem
                label={labels.remove}
                danger
                icon={<IconTrashOutline16 size={16} />}
                disabled={busy}
                onPick={() => { setOpen(false); onRequestDelete() }}
              />
            )}
          >
            <MenuItem
              label={labels.runNow}
              icon={<IconPlayOutline16 size={16} />}
              disabled={busy}
              onPick={() => { setOpen(false); onRun() }}
            />
            <MenuItem
              label={row.enabled ? labels.pause : labels.resume}
              icon={row.enabled ? <IconPauseOutline16 size={16} /> : <IconPlayOutline16 size={16} />}
              disabled={busy}
              onPick={() => { setOpen(false); onToggle(!row.enabled) }}
            />
            <MenuItem
              label={labels.edit}
              icon={<IconEditOutline16 size={16} />}
              disabled={busy}
              onPick={() => { setOpen(false); onEdit() }}
            />
          </MenuCard>
        )
        : null}
    </div>
  )
}

/** External-link glyph for the run history's 跳到会话 action. */
function JumpGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7 3.4H3.4v9.2h9.2V9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M9.4 2.6h4v4M13.2 2.8L7.6 8.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/** Per-run ⋯ menu: jump to the bound session, or remove the history row. */
function RunRowMenu({ labels, jumpDisabled, onJump, onDelete }: {
  labels: { more: string, jump: string, deleteRecord: string }
  jumpDisabled: boolean
  onJump: () => void
  onDelete: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => { setOpen(false) })
  return (
    <div className="dsh-stask-more-wrap">
      <button
        type="button"
        className="dsh-stask-more"
        aria-label={labels.more}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={event => { event.stopPropagation(); setOpen(!open) }}
      >
        <IconEllipsisOutline16 size={16} />
      </button>
      {open && (
        <MenuCard align="right">
          <MenuItem
            label={labels.jump}
            icon={<JumpGlyph />}
            disabled={jumpDisabled}
            onPick={() => { setOpen(false); onJump() }}
          />
          <MenuItem
            label={labels.deleteRecord}
            danger
            icon={<IconTrashOutline16 size={16} />}
            onPick={() => { setOpen(false); onDelete() }}
          />
        </MenuCard>
      )}
    </div>
  )
}

export interface AutomationPageProps {
  face: ScheduledTasksFace
  t: Translate
}

/**
 * Render the scheduled-tasks panel.
 * @param props - bound Remote face plus the locale seat.
 * @returns the panel element tree.
 */
export function AutomationPage({ face, t }: AutomationPageProps): ReactNode {
  const [tasks, setTasks] = useState<readonly TaskRow[] | null>(null)
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null)
  const [announce, setAnnounce] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [editing, setEditing] = useState<{ mode: 'create' } | { mode: 'edit', task: UserTaskRow } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<UserTaskRow | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editorTab, setEditorTab] = useState<'settings' | 'history'>('settings')
  const [runs, setRuns] = useState<readonly TaskRunRow[] | null>(null)
  const [runsError, setRunsError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Single-flight guard for the poll: a slow Host must not stack requests.
  const inFlight = useRef(false)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    setRefreshing(true)
    try {
      const snapshot = await face.list()
      setTasks(snapshot.tasks)
      setError(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      inFlight.current = false
      setRefreshing(false)
    }
  }, [face])

  useEffect(() => {
    void refresh()
    void face.catalog().then(setCatalog).catch(() => { setCatalog(null) })
    const poll = window.setInterval(() => { void refresh() }, 5_000)
    const clock = window.setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(clock)
    }
  }, [face, refresh])

  // The window document marks the panel as mounted so the sidebar entry can
  // toggle (and style itself) without reading another plugin's state.
  useEffect(() => {
    document.documentElement.dataset.dshStaskPanel = 'on'
    return () => { delete document.documentElement.dataset.dshStaskPanel }
  }, [])

  /** Relative "in N minutes/hours/days" wording for the next run. */
  const untilText = (instant: number): string => {
    const minutes = Math.round(Math.max(0, instant - now) / 60_000)
    if (minutes < 60) return t('relative.minutes', { count: minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 24) return t('relative.hours', { count: hours })
    return t('relative.days', { count: Math.round(hours / 24) })
  }

  const permissionLabel = (name: string): string => {
    const key = PERMISSION_KEYS[name]
    if (key !== undefined) return t(key)
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)
      ? name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
      : name
  }
  const effortLabel = (id: string): string => {
    const key = EFFORT_KEYS[id]
    return key === undefined ? id : t(key)
  }

  const blankForm = (schedule: ScheduleShape, title: string, instruction: string, enabled: boolean): FormState => ({
    title,
    instruction,
    schedule,
    enabled,
    workspacePath: catalog?.workspaces[0]?.path ?? '',
    permissionPreset: catalog?.defaultPermissionPreset ?? 'workspace-write',
    modelKey: 'default',
    effortKey: 'default',
  })

  const beginCreate = (schedule?: ScheduleShape, title = '', instruction = ''): void => {
    setForm(blankForm(schedule ?? { kind: 'daily', localTime: '09:00' }, title, instruction, true))
    setEditorTab('settings')
    setEditing({ mode: 'create' })
  }

  const beginEdit = (task: UserTaskRow): void => {
    const model = task.execution.model
    setForm({
      title: task.title,
      instruction: task.instruction,
      schedule: specOf(task.schedule),
      enabled: task.enabled,
      workspacePath: task.execution.workspacePath,
      permissionPreset: task.execution.permissionPreset,
      modelKey: model === null ? 'default' : routeKey(model.provider, model.model),
      effortKey: model?.reasoningEffort ?? 'default',
    })
    setEditorTab('settings')
    setEditing({ mode: 'edit', task })
  }

  const exitEdit = (): void => {
    if (form !== null && (form.title !== '' || form.instruction !== '')) {
      if (!window.confirm(t('form.unsaved'))) return
    }
    setEditing(null)
    setForm(null)
  }

  const save = async (): Promise<void> => {
    if (form === null || editing === null) return
    setSaving(true)
    try {
      const [provider, model] = form.modelKey.split('/')
      const payload = {
        title: form.title,
        instruction: form.instruction,
        schedule: form.schedule as ScheduleSpec,
        workspacePath: form.workspacePath,
        agentPreset: AGENT_PRESET,
        permissionPreset: form.permissionPreset,
        model: form.modelKey === 'default' || provider === undefined || model === undefined
          ? null
          : { provider, model, ...form.effortKey === 'default' ? {} : { reasoningEffort: form.effortKey } },
        enabled: form.enabled,
      }
      if (editing.mode === 'create') await face.create(payload)
      else await face.update({ id: editing.task.id, ifRevision: editing.task.revision, ...payload })
      setEditing(null)
      setForm(null)
      setAnnounce(t('state.saved'))
      await refresh()
    } catch (reason) {
      setAnnounce(errorCode(reason) === 'TASK_REVISION_CONFLICT' ? t('state.conflict') : t('state.failed'))
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (task: UserTaskRow, next: boolean): Promise<void> => {
    setBusyId(task.id)
    try {
      await face.setEnabled({ id: task.id, ifRevision: task.revision, enabled: next })
      setAnnounce(next ? t('state.enabled', { title: task.title }) : t('state.paused', { title: task.title }))
      await refresh()
    } catch (reason) {
      const code = errorCode(reason)
      setAnnounce(code === 'TASK_MANAGED_READ_ONLY'
        ? t('state.managed')
        : code === 'TASK_BUSY' ? t('state.busy') : code === 'TASK_REVISION_CONFLICT' ? t('state.conflict') : t('state.failed'))
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  /** The ⋯ menu only OPENS the dialog; the deletion itself happens here. */
  const confirmDelete = async (): Promise<void> => {
    const task = pendingDelete
    if (task === null) return
    setPendingDelete(null)
    setBusyId(task.id)
    try {
      await face.deleteTask({ id: task.id, ifRevision: task.revision })
      setAnnounce(t('state.removed'))
      await refresh()
    } catch (reason) {
      setAnnounce(errorCode(reason) === 'TASK_BUSY' ? t('state.busy') : t('state.failed'))
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  const loadRuns = async (task: UserTaskRow): Promise<void> => {
    setRuns(null)
    setRunsError(null)
    try {
      const result = await face.listRuns({ id: task.id })
      setRuns(result.runs)
    } catch (reason) {
      setRunsError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const removeRun = async (task: UserTaskRow, runId: string): Promise<void> => {
    try {
      await face.deleteRun({ id: task.id, runId })
      await loadRuns(task)
    } catch (reason) {
      setRunsError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const openHistory = (task: UserTaskRow): void => {
    setEditorTab('history')
    void loadRuns(task)
  }

  const runNow = async (task: UserTaskRow): Promise<void> => {
    setBusyId(task.id)
    try {
      await face.runNow({ id: task.id })
      setAnnounce(t('state.runStarted', { title: task.title }))
      await refresh()
    } catch (reason) {
      setAnnounce(errorCode(reason) === 'TASK_BUSY' ? t('state.busy') : t('state.failed'))
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (editing !== null && form !== null) {
    const models = catalog?.models ?? []
    const defaultSelection = catalog?.defaultSelection ?? null
    const defaultModel = defaultSelection === null
      ? null
      : { provider: defaultSelection.provider, model: defaultSelection.model }
    const workspaces = catalog?.workspaces ?? []
    const workspaceOptions = workspaces.map(workspace => ({ value: workspace.path, label: workspace.title }))
    if (form.workspacePath !== '' && !workspaceOptions.some(option => option.value === form.workspacePath)) {
      const segments = form.workspacePath.replace(/\/+$/, '').split('/')
      workspaceOptions.push({ value: form.workspacePath, label: segments[segments.length - 1] ?? form.workspacePath })
    }
    const permissionOptions = (catalog?.permissionPresets ?? []).map(preset => ({
      value: preset.name,
      label: permissionLabel(preset.name),
    }))
    const incomplete = form.title.trim() === '' || form.instruction.trim() === ''
    const sourceLabel = (trigger: TaskRunRow['trigger']): string => t(`source.${trigger}`)
    const runStatusLabel = (status: TaskRunRow['status']): string => t(`runState.${status}`)
    const formatDateTime = (ms: number): string => {
      const date = new Date(ms)
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }
    const formatDuration = (ms: number | null): string => {
      if (ms === null) return '—'
      const seconds = Math.max(1, Math.round(ms / 1000))
      if (seconds < 60) return `${seconds}s`
      return `${Math.floor(seconds / 60)}m${seconds % 60}s`
    }
    const runDotTone = (run: TaskRunRow): string => {
      if (run.status === 'claiming' || run.status === 'running') return 'busy'
      if (run.status === 'success') return 'ok'
      if (run.status === 'error') return 'bad'
      return 'off'
    }
    const historyPanel = editing.mode === 'edit' && pendingDelete === null
      ? (
        <div className="dsh-stask-runs-wrap">
          {runsError === null ? null : <div className="dsh-stask-banner" role="alert">{t('state.error', { message: runsError })}</div>}
          <div className="dsh-stask-runs">
            <div className="dsh-stask-runs-head">
              <span>{t('runs.time')}</span>
              <span>{t('runs.source')}</span>
              <span>{t('runs.status')}</span>
              <span>{t('runs.duration')}</span>
              <span />
            </div>
            {runs === null
              ? <div className="dsh-stask-runs-empty">{t('state.loading')}</div>
              : runs.length === 0
                ? <div className="dsh-stask-runs-empty">{t('runs.empty')}</div>
                : runs.map(run => (
                  <div className="dsh-stask-run" key={run.runId}>
                    <span>{formatDateTime(run.scheduledFor)}</span>
                    <span>{sourceLabel(run.trigger)}</span>
                    <span className="dsh-stask-run-status">
                      <span className="dsh-stask-run-dot" data-tone={runDotTone(run)} />
                      {runStatusLabel(run.status)}
                    </span>
                    <span>{formatDuration(run.durationMs)}</span>
                    <RunRowMenu
                      labels={{ more: t('action.more'), jump: t('run.jump'), deleteRecord: t('run.deleteRecord') }}
                      jumpDisabled={editing.task.sessionId === null}
                      onJump={() => { if (editing.task.sessionId !== null) face.openSession(editing.task.sessionId) }}
                      onDelete={() => { void removeRun(editing.task, run.runId) }}
                    />
                  </div>
                ))}
          </div>
        </div>
      )
      : null
    return (
      <div className="dsh-stask-page">
        <header className="dsh-stask-form-header">
          <h2 className="dsh-stask-form-title">
            {editing.mode === 'create' ? t('form.createTitle') : t('form.editTitle')}
          </h2>
        </header>
        {editing.mode === 'edit' && (
          <div className="dsh-stask-tabs-row">
            <div className="dsh-stask-tabs" role="tablist">
              <button
                type="button"
                className="dsh-stask-tab"
                aria-pressed={editorTab === 'settings'}
                onClick={() => { setEditorTab('settings') }}
              >
                {t('tab.settings')}
              </button>
              <button
                type="button"
                className="dsh-stask-tab"
                aria-pressed={editorTab === 'history'}
                onClick={() => { openHistory(editing.task) }}
              >
                {t('tab.history')}
              </button>
            </div>
          </div>
        )}
        {editing.mode === 'edit' && editorTab === 'history' ? historyPanel : (
        <div className="dsh-stask-card dsh-stask-panel">
          <div className="dsh-stask-field">
            <span className="dsh-stask-field-label">{t('form.status')}</span>
            <div className="dsh-stask-switch-line">
              <Switch
                checked={form.enabled}
                label={t('form.statusSwitch')}
                onChange={enabled => { setForm({ ...form, enabled }) }}
              />
              <span className="dsh-stask-state-strong">{form.enabled ? t('form.statusOn') : t('form.statusOff')}</span>
            </div>
          </div>
          <div className="dsh-stask-field">
            <label className="dsh-stask-field-label" htmlFor="dsh-stask-title">{t('form.title')}</label>
            <input
              id="dsh-stask-title"
              className="dsh-stask-input"
              type="text"
              value={form.title}
              maxLength={LIMITS.maxTitleChars}
              placeholder={t('form.titlePlaceholder')}
              onChange={event => { setForm({ ...form, title: event.target.value }) }}
            />
          </div>
          <div className="dsh-stask-field">
            <span className="dsh-stask-field-label">{t('form.schedule')}</span>
            <ScheduleRow
              spec={form.schedule}
              timeZone={catalog?.timeZone ?? 'UTC'}
              t={t}
              onChange={schedule => { setForm({ ...form, schedule }) }}
            />
          </div>
          <div className="dsh-stask-field">
            <label className="dsh-stask-field-label" htmlFor="dsh-stask-instruction">{t('form.instruction')}</label>
            <div className="dsh-stask-instr">
              <InstructionText
                id="dsh-stask-instruction"
                value={form.instruction}
                placeholder={t('form.instructionPlaceholder')}
                onChange={instruction => { setForm({ ...form, instruction }) }}
              />
              <div className="dsh-stask-instr-toolbar">
                <div className="dsh-stask-tools">
                  <WorkspaceChip
                    value={form.workspacePath}
                    options={workspaceOptions}
                    chooseLabel={t('workspace.choose')}
                    emptyLabel={t('workspace.empty')}
                    addLabel={t('action.addWorkspace')}
                    disabled={editing.mode === 'edit'}
                    disabledTitle={t('workspace.locked')}
                    onAdd={() => { setAnnounce(t('state.workspacePicker')) }}
                    onChange={workspacePath => { setForm({ ...form, workspacePath }) }}
                  />
                  <Chip
                    value={form.permissionPreset}
                    options={permissionOptions}
                    icon={<PermissionGlyph name={form.permissionPreset} />}
                    onChange={permissionPreset => { setForm({ ...form, permissionPreset }) }}
                  />
                </div>
                <div className="dsh-stask-trailing">
                  <ModelChip
                    value={form.modelKey}
                    effort={form.effortKey}
                    models={models}
                    defaultModel={defaultModel}
                    labels={{
                      model: t('menu.model'),
                      effort: t('menu.effort'),
                      follow: t('model.followDefault'),
                      followWith: t('model.followDefaultWith'),
                      defaultEffort: t('model.effortDefault'),
                    }}
                    effortLabel={effortLabel}
                    onChange={(modelKey, effortKey) => { setForm({ ...form, modelKey, effortKey }) }}
                  />
                </div>
              </div>
            </div>
          </div>
          <div className="dsh-stask-actions">
            <button type="button" className="dsh-stask-btn" onClick={exitEdit}>{t('action.cancel')}</button>
            <button
              type="button"
              className="dsh-stask-btn dsh-stask-btn-primary"
              disabled={saving || incomplete}
              title={incomplete ? t('form.incomplete') : undefined}
              onClick={() => { void save() }}
            >
              {saving ? t('action.saving') : t('action.save')}
            </button>
          </div>
        </div>
        )}
      </div>
    )
  }

  const rows = tasks ?? []
  const managed = rows.filter((row): row is Extract<TaskRow, { kind: 'managed' }> => row.kind === 'managed')
  const mine = rows.filter((row): row is UserTaskRow => row.kind === 'user')

  const taskCard = (row: TaskRow): ReactNode => {
    if (row.kind === 'managed') {
      const unavailable = row.activity === 'unavailable'
      const on = row.scheduleState === 'enabled'
      return (
        <div className="dsh-stask-card dsh-stask-task" key={row.id}>
          <div className="dsh-stask-task-head">
            <strong className="dsh-stask-task-title">{row.title}</strong>
            <span className="dsh-stask-tag">{t('card.system')}</span>
          </div>
          <p className="dsh-stask-task-desc">{row.instructionSummary}</p>
          <div className="dsh-stask-task-foot">
            <span className={`dsh-stask-when${on && !unavailable ? '' : ' dsh-stask-when-off'}`}>
              {unavailable ? t('card.unavailable') : `${scheduleText(row.schedule, t)}${row.nextRunAt === null ? '' : ` · ${t('card.nextRun', { when: untilText(row.nextRunAt) })}`}`}
            </span>
          </div>
          <p className="dsh-stask-muted">{t('card.managed')}</p>
        </div>
      )
    }
    const busy = busyId === row.id || row.activity === 'running' || row.activity === 'waiting-input'
    const openEdit = (): void => { beginEdit(row) }
    return (
      <div
        className="dsh-stask-card dsh-stask-task dsh-stask-task-click"
        key={row.id}
        role="button"
        tabIndex={0}
        aria-label={t('action.edit')}
        onClick={openEdit}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEdit() } }}
      >
        <div className="dsh-stask-task-head">
          <strong className="dsh-stask-task-title">{row.title}</strong>
          <TaskCardMenu
            row={row}
            busy={busy}
            labels={{
              more: t('action.more'),
              runNow: t('action.runNow'),
              pause: t('action.pause'),
              resume: t('action.resume'),
              edit: t('action.edit'),
              remove: t('action.remove'),
            }}
            onRun={() => { void runNow(row) }}
            onToggle={next => { void toggle(row, next) }}
            onEdit={openEdit}
            onRequestDelete={() => { setPendingDelete(row) }}
          />
        </div>
        <p className="dsh-stask-task-desc">{row.instruction}</p>
        <div className="dsh-stask-task-foot">
          <span className={`dsh-stask-when${row.enabled ? '' : ' dsh-stask-when-off'}`}>
            <IconClockOutline16 size={12} />
            {`${scheduleText(row.schedule, t)}${row.enabled && row.nextRunAt !== null ? ` · ${t('card.nextRun', { when: untilText(row.nextRunAt) })}` : ''}`}
          </span>
          <span className="dsh-stask-pill">{t('card.runs', { count: row.runCount })}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="dsh-stask-page">
      <p className="dsh-stask-announce" role="status" aria-live="polite">{announce}</p>
      <Modal
        open={pendingDelete !== null}
        onClose={() => { setPendingDelete(null) }}
        title={t('delete.title')}
        closeLabel={t('action.cancel')}
        description={t('delete.confirm', { title: pendingDelete?.title ?? '' })}
        footer={(
          <>
            <Button variant="outline" onClick={() => { setPendingDelete(null) }}>{t('action.cancel')}</Button>
            <Button variant="primary" className="dsh-stask-danger-btn" onClick={() => { void confirmDelete() }}>{t('action.remove')}</Button>
          </>
        )}
      />
      <header className="dsh-stask-hero">
        <h1 className="dsh-stask-hero-title">{t('page.title')}</h1>
        <p className="dsh-stask-hero-sub">{t('page.intro')}</p>
      </header>
      <div className="dsh-stask-toolbar">
        <div className="dsh-stask-section" style={{ margin: 0 }}>{t('section.created')}</div>
        <div className="dsh-stask-header-actions">
          <Tooltip label={t('action.refresh')} side="bottom">
            <Button
              variant="toolbar"
              size="md"
              disabled={refreshing}
              aria-label={t('action.refresh')}
              onClick={() => { void refresh() }}
            >
              <IconRefreshOutline16 className={refreshing ? 'dsh-stask-spin' : undefined} />
            </Button>
          </Tooltip>
          <Button variant="primary" size="md" onClick={() => { beginCreate() }}>
            {t('action.create')}
          </Button>
        </div>
      </div>
      <div className="dsh-stask-info">
        <span className="dsh-stask-info-icon" aria-hidden="true">ⓘ</span>
        <span>{t('info.scheduler')}</span>
      </div>
      {error === null ? null : <div className="dsh-stask-banner" role="alert">{t('state.error', { message: error })}</div>}
      {tasks === null
        ? <div className="dsh-stask-empty">{t('state.loading')}</div>
        : rows.length === 0
          ? <div className="dsh-stask-empty">{t('state.empty')}</div>
          : <div className="dsh-stask-grid">{managed.map(taskCard)}{mine.map(taskCard)}</div>}
      <div className="dsh-stask-section dsh-stask-section-gap">{t('section.templates')}</div>
      <div className="dsh-stask-grid">
        {TEMPLATES.map(template => (
          <button
            type="button"
            className="dsh-stask-card dsh-stask-tpl"
            key={template.key}
            onClick={() => {
              const key = template.key as 'morning' | 'risk' | 'release' | 'docs'
              beginCreate(template.schedule, t(`template.${key}.title`), t(`template.${key}.instruction`))
            }}
          >
            <div className="dsh-stask-tpl-head">
              <span className="dsh-stask-tpl-icon" aria-hidden="true">{template.icon}</span>
              <strong>{t(`template.${template.key as 'morning'}.title`)}</strong>
            </div>
            <p className="dsh-stask-task-desc">{t(`template.${template.key as 'morning'}.instruction`)}</p>
            <div className="dsh-stask-tpl-time">{t(`template.${template.key as 'morning'}.time`)}</div>
          </button>
        ))}
      </div>
    </div>
  )
}
