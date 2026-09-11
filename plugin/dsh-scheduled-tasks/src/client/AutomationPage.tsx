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
  Switch,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogSnapshot, ScheduleSpec, TaskRow, UserTaskRow } from '../types.ts'
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
function TaskCardMenu({ row, busy, labels, onRun, onToggle, onEdit, onRemove }: {
  row: UserTaskRow
  busy: boolean
  labels: TaskCardMenuLabels
  onRun: () => void
  onToggle: (next: boolean) => void
  onEdit: () => void
  onRemove: () => void
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
                onPick={() => { setOpen(false); onRemove() }}
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
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
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

  const remove = async (task: UserTaskRow): Promise<void> => {
    if (confirmId !== task.id) {
      setConfirmId(task.id)
      window.setTimeout(() => { setConfirmId(current => current === task.id ? null : current) }, 4_000)
      return
    }
    setConfirmId(null)
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
    return (
      <div className="dsh-stask-page">
        <header className="dsh-stask-form-header">
          <h2 className="dsh-stask-form-title">
            {editing.mode === 'create' ? t('form.createTitle') : t('form.editTitle')}
          </h2>
        </header>
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
              remove: confirmId === row.id ? t('action.confirmRemove') : t('action.remove'),
            }}
            onRun={() => { void runNow(row) }}
            onToggle={next => { void toggle(row, next) }}
            onEdit={openEdit}
            onRemove={() => { void remove(row) }}
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
