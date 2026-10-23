/**
 * The Quno settings section: configuration, sources, attention, runs and
 * tasks in one place (design §13.1 — configuration and state are one product).
 *
 * @module dsh-quno/client/settings
 */

import React from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { QunoConfig } from '../types.ts'
import type { QunoWireState, SenseWire } from '../api-types.ts'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'
import { Card, Empty, ErrorBanner, Field, SectionTitle, Select, TextArea, TextInput } from './ui.tsx'
import { formatClock, parseJsonObject, toneOf } from './format.ts'

/** Injected face of the settings section. */
export interface QunoSettingsInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  readonly openSession: (sessionId: string) => void
  readonly locale: () => 'zh' | 'en'
}

type Tab = 'config' | 'sources' | 'attention' | 'runs' | 'tasks'

/** Render the top-level Quno settings section. */
export function QunoSettingsSection(props: PropsRuntime<'settings.section'> & QunoSettingsInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const [tab, setTab] = React.useState<Tab>('config')
  const { t, store } = props
  const locale = props.locale()
  const state = snapshot.state

  if (state === null) {
    return (
      <div style={page}>
        {snapshot.phase === 'error'
          ? <ErrorBanner>{format(t('error'), { error: snapshot.error ?? '' })}</ErrorBanner>
          : <Empty>{t('loading')}</Empty>}
      </div>
    )
  }

  const tabs: { readonly id: Tab; readonly label: QunoLocaleKey }[] = [
    { id: 'config', label: 'tabConfig' },
    { id: 'sources', label: 'tabSources' },
    { id: 'attention', label: 'tabAttention' },
    { id: 'runs', label: 'tabRuns' },
    { id: 'tasks', label: 'tabTasks' },
  ]

  return (
    <div style={page}>
      <header style={header}>
        <div>
          <h2 style={h2}>{t('settingsTitle')}</h2>
          <p style={subtitle}>{t('settingsSubtitle')}</p>
        </div>
        <div style={headerActions}>
          <MainBinding state={state} t={t} store={store} openSession={props.openSession} />
          <Button size="sm" variant="outline" onClick={() => { void store.refresh() }}>{t('refresh')}</Button>
        </div>
      </header>

      {snapshot.error !== null && <ErrorBanner>{format(t('error'), { error: snapshot.error })}</ErrorBanner>}

      <nav style={tabBar}>
        {tabs.map(entry => (
          <button
            key={entry.id}
            type="button"
            className="dsh-quno-tab"
            data-active={tab === entry.id ? 'true' : undefined}
            style={tabButton}
            onClick={() => { setTab(entry.id) }}
          >
            {t(entry.label)}
          </button>
        ))}
      </nav>

      {tab === 'config' && <ConfigTab state={state} store={store} t={t} locale={locale} />}
      {tab === 'sources' && <SourcesTab state={state} store={store} t={t} />}
      {tab === 'attention' && <AttentionTab state={state} store={store} t={t} locale={locale} />}
      {tab === 'runs' && <RunsTab state={state} store={store} t={t} locale={locale} />}
      {tab === 'tasks' && <TasksTab state={state} store={store} t={t} locale={locale} openSession={props.openSession} />}
    </div>
  )
}

function MainBinding(props: {
  readonly state: QunoWireState
  readonly t: QunoSettingsInjected['t']
  readonly store: QunoClientStore
  readonly openSession: (sessionId: string) => void
}): React.ReactElement {
  const { state, t } = props
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const open = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const cwd = state.main.sessionId === null
        ? (state.config.timeZone === '' ? '/' : '/')
        : '/'
      void cwd
      const sessionId = state.main.sessionId ?? await props.store.ensureMain(defaultCwd())
      props.openSession(sessionId)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const tone = state.main.state === 'ok' ? 'ok' : state.main.state === 'unbound' ? 'idle' : 'error'
  const label = state.main.state === 'ok' ? t('mainBound') : state.main.state === 'unbound' ? t('mainUnbound') : state.main.state === 'missing' ? t('mainMissing') : t('mainBlocked')
  return (
    <div style={mainBinding}>
      <span style={{ ...dot, background: tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }} />
      <span style={mainLabel}>{label}</span>
      {state.main.state === 'ok'
        ? <Button size="sm" variant="primary" disabled={busy} onClick={() => { void open() }}>{t('openMain')}</Button>
        : <Button size="sm" variant="primary" disabled={busy} onClick={() => { void open() }}>{t('createMain')}</Button>}
      {error !== null && <span style={smallError}>{error}</span>}
    </div>
  )
}

function ConfigTab(props: {
  readonly state: QunoWireState
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
  readonly locale: 'zh' | 'en'
}): React.ReactElement {
  const { state, store, t } = props
  const [draft, setDraft] = React.useState<QunoConfig>(state.config)
  const [profile, setProfile] = React.useState({
    name: state.quno.name,
    persona: state.quno.persona,
    instructions: state.quno.instructions,
    modelProvider: state.quno.modelProvider,
    model: state.quno.model,
  })
  const [message, setMessage] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    setDraft(state.config)
  }, [state.quno.configRevision])

  const save = async (): Promise<void> => {
    setSaving(true)
    setMessage(null)
    setError(null)
    try {
      await store.updateConfig(draft as unknown as Record<string, unknown>)
      await store.updateProfile(profile)
      setMessage(t('saved'))
    } catch (reason) {
      setError(format(t('saveFailed'), { error: (reason as Error).message }))
    } finally {
      setSaving(false)
    }
  }

  const quiet = draft.quietHours
  return (
    <div style={stack}>
      <Card title={t('enabled')} aside={
        <Switch
          checked={draft.enabled}
          label={t('enabled')}
          onChange={enabled => { setDraft({ ...draft, enabled }) }}
        />
      }>
        <div style={grid2}>
          <Field label={t('checkInterval')}>
            <TextInput type="number" min={60} value={draft.checkIntervalSec}
              onChange={(event) => { setDraft({ ...draft, checkIntervalSec: Number(event.target.value) }) }} />
          </Field>
          <Field label={t('timeZone')}>
            <TextInput value={draft.timeZone}
              onChange={(event) => { setDraft({ ...draft, timeZone: event.target.value }) }} />
          </Field>
          <Field label={t('quietStart')}>
            <TextInput type="time" value={quiet?.start ?? ''} disabled={quiet === null}
              onChange={(event) => { setDraft({ ...draft, quietHours: { start: event.target.value, end: quiet?.end ?? '08:00' } }) }} />
          </Field>
          <Field label={t('quietEnd')}>
            <TextInput type="time" value={quiet?.end ?? ''} disabled={quiet === null}
              onChange={(event) => { setDraft({ ...draft, quietHours: { start: quiet?.start ?? '22:00', end: event.target.value } }) }} />
          </Field>
        </div>
        <div style={inline}>
          <Switch
            checked={quiet !== null}
            label={t('quietStart')}
            onChange={(enabled) => { setDraft({ ...draft, quietHours: enabled ? { start: '22:00', end: '08:00' } : null }) }}
          />
          <span style={muted}>{props.locale === 'zh' ? '启用安静时段' : 'Enable quiet hours'}</span>
        </div>
        <div style={grid2}>
          <Field label={t('notifyMode')}>
            <Select value={draft.notificationPolicy.mode}
              onChange={(event) => {
                setDraft({
                  ...draft,
                  notificationPolicy: {
                    ...draft.notificationPolicy,
                    mode: event.target.value === 'every-run' ? 'every-run' : 'meaningful',
                  },
                })
              }}>
              <option value="meaningful">{t('modeMeaningful')}</option>
              <option value="every-run">{t('modeEveryRun')}</option>
            </Select>
          </Field>
          <Field label={t('minGap')}>
            <TextInput type="number" min={0} value={draft.notificationPolicy.minGapSec}
              onChange={(event) => {
                setDraft({ ...draft, notificationPolicy: { ...draft.notificationPolicy, minGapSec: Number(event.target.value) } })
              }} />
          </Field>
          <Field label={t('maxPerHour')}>
            <TextInput type="number" min={1} value={draft.notificationPolicy.maxPerHour}
              onChange={(event) => {
                setDraft({ ...draft, notificationPolicy: { ...draft.notificationPolicy, maxPerHour: Number(event.target.value) } })
              }} />
          </Field>
          <Field label={t('dryRun')}>
            <Switch checked={draft.dryRun} label={t('dryRun')} onChange={dryRun => { setDraft({ ...draft, dryRun }) }} />
          </Field>
        </div>
        <div style={inline}>
          <Switch checked={draft.notificationPolicy.allowUrgentWake} label={t('allowUrgent')}
            onChange={allowUrgentWake => {
              setDraft({ ...draft, notificationPolicy: { ...draft.notificationPolicy, allowUrgentWake } })
            }} />
          <span style={muted}>{t('allowUrgent')}</span>
        </div>
        <div style={inline}>
          <Switch checked={draft.notificationPolicy.urgentMayBreakQuietHours} label={t('urgentQuiet')}
            disabled={!draft.notificationPolicy.allowUrgentWake}
            onChange={urgentMayBreakQuietHours => {
              setDraft({ ...draft, notificationPolicy: { ...draft.notificationPolicy, urgentMayBreakQuietHours } })
            }} />
          <span style={muted}>{t('urgentQuiet')}</span>
        </div>
      </Card>

      <Card title={t('budgetEvents')}>
        <div style={grid2}>
          <Field label={t('budgetEvents')}>
            <TextInput type="number" min={1} value={draft.budget.maxEventsPerRun}
              onChange={(event) => { setDraft({ ...draft, budget: { ...draft.budget, maxEventsPerRun: Number(event.target.value) } }) }} />
          </Field>
          <Field label={t('budgetContext')}>
            <TextInput type="number" min={2000} value={draft.budget.maxContextChars}
              onChange={(event) => { setDraft({ ...draft, budget: { ...draft.budget, maxContextChars: Number(event.target.value) } }) }} />
          </Field>
          <Field label={t('budgetRuns')}>
            <TextInput type="number" min={1} value={draft.budget.dailyModelRuns}
              onChange={(event) => { setDraft({ ...draft, budget: { ...draft.budget, dailyModelRuns: Number(event.target.value) } }) }} />
          </Field>
        </div>
      </Card>

      <Card title={t('persona')}>
        <Field label={t('persona')}>
          <TextArea value={profile.persona} onChange={(event) => { setProfile({ ...profile, persona: event.target.value }) }} />
        </Field>
        <Field label={t('instructions')}>
          <TextArea value={profile.instructions} onChange={(event) => { setProfile({ ...profile, instructions: event.target.value }) }} />
        </Field>
        <div style={grid2}>
          <Field label={t('modelProvider')}>
            <TextInput value={profile.modelProvider} onChange={(event) => { setProfile({ ...profile, modelProvider: event.target.value }) }} />
          </Field>
          <Field label={t('model')}>
            <TextInput value={profile.model} onChange={(event) => { setProfile({ ...profile, model: event.target.value }) }} />
          </Field>
        </div>
      </Card>

      <div style={inline}>
        <Button variant="primary" size="sm" disabled={saving} onClick={() => { void save() }}>{t('save')}</Button>
        {message !== null && <span style={okText}>{message}</span>}
        {error !== null && <span style={smallError}>{error}</span>}
      </div>
    </div>
  )
}

function SourcesTab(props: {
  readonly state: QunoWireState
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
}): React.ReactElement {
  const { state, store, t } = props
  if (state.senseTypes.length === 0) return <Empty>{t('noSenses')}</Empty>
  return (
    <div style={stack}>
      {state.senseTypes.map(type => (
        <Card key={type.type} title={type.displayName} aside={<span style={muted}>{type.type}</span>}>
          <p style={bodyText}>{type.description}</p>
          {state.senses.filter(instance => instance.type === type.type).map(instance => (
            <SenseInstanceCard key={instance.id} instance={instance} store={store} t={t} fields={type.configFields} />
          ))}
          {state.senses.every(instance => instance.type !== type.type) && <Empty>{t('noInstances')}</Empty>}
          <CreateSenseForm type={type.type} fields={type.configFields} store={store} t={t} />
        </Card>
      ))}
      {state.gaps.map(gap => (
        <ErrorBanner key={`${gap.sourceId}-${String(gap.at)}`}>{format(t('gap'), { reason: gap.reason })}</ErrorBanner>
      ))}
    </div>
  )
}

function SenseInstanceCard(props: {
  readonly instance: SenseWire
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
  readonly fields: QunoWireState['senseTypes'][number]['configFields']
}): React.ReactElement {
  const { instance, store, t } = props
  const [configText, setConfigText] = React.useState(JSON.stringify(instance.config, null, 2))
  const [label, setLabel] = React.useState(instance.label)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    setConfigText(JSON.stringify(instance.config, null, 2))
    setLabel(instance.label)
  }, [instance.configRevision, instance.id])
  const tone = toneOf(instance.health, instance.stale)
  const command = async (action: 'pause' | 'resume' | 'disable' | 'remove' | 'reconfigure'): Promise<void> => {
    setError(null)
    try {
      if (action === 'reconfigure') {
        const parsed = parseJsonObject(configText)
        if (!parsed.ok) throw new Error(parsed.error)
        await store.senseCommand({ instanceId: instance.id, action, label, config: parsed.value })
      } else {
        await store.senseCommand({ instanceId: instance.id, action })
      }
    } catch (reason) {
      setError((reason as Error).message)
    }
  }
  return (
    <div style={instanceCard}>
      <div style={instanceHeader}>
        <StatusLine tone={tone} text={`${instance.label} · ${instance.health}${instance.stale ? ` · ${t('stale')}` : ''}`} />
        <span style={muted}>{instance.desiredState} / {instance.lifecycle}</span>
      </div>
      <div style={metaRow}>
        <span>{t('lastSuccess')}：{instance.lastSuccessAt === null ? t('never') : formatClock(instance.lastSuccessAt)}</span>
        <span>{t('lastEvent')}：{instance.lastEventAt === null ? t('never') : formatClock(instance.lastEventAt)}</span>
        <span>{t('checkpoint')}：{instance.checkpointRevision}</span>
      </div>
      {instance.healthDetail?.detail !== undefined && <p style={bodyText}>{instance.healthDetail.detail}</p>}
      <Field label={t('senseLabel')}>
        <TextInput value={label} onChange={(event) => { setLabel(event.target.value) }} />
      </Field>
      <Field label={t('senseConfig')}>
        <TextArea value={configText} onChange={(event) => { setConfigText(event.target.value) }} />
      </Field>
      <div style={inline}>
        <Button size="sm" variant="outline" onClick={() => { void command('reconfigure') }}>{t('reconfigure')}</Button>
        {instance.desiredState === 'enabled'
          ? <Button size="sm" variant="ghost" onClick={() => { void command('pause') }}>{t('pause')}</Button>
          : <Button size="sm" variant="ghost" onClick={() => { void command('resume') }}>{t('resume')}</Button>}
        <Button size="sm" variant="ghost" onClick={() => { void command('disable') }}>{t('disable')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { void command('remove') }}>{t('remove')}</Button>
      </div>
      {error !== null && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  )
}

function CreateSenseForm(props: {
  readonly type: string
  readonly fields: QunoWireState['senseTypes'][number]['configFields']
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
}): React.ReactElement {
  const initial = React.useMemo(() => {
    const config: Record<string, unknown> = {}
    for (const field of props.fields) {
      if (field.defaultValue !== undefined) config[field.key] = field.defaultValue
      else if (field.type === 'boolean') config[field.key] = false
    }
    return JSON.stringify(config, null, 2)
  }, [props.type])
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState('')
  const [configText, setConfigText] = React.useState(initial)
  const [error, setError] = React.useState<string | null>(null)
  if (!open) {
    return <Button size="sm" variant="outline" onClick={() => { setOpen(true); setConfigText(initial) }}>{props.t('addSense')}</Button>
  }
  return (
    <div style={instanceCard}>
      <Field label={props.t('senseLabel')}>
        <TextInput value={label} onChange={(event) => { setLabel(event.target.value) }} />
      </Field>
      <Field label={props.t('senseConfig')} hint={props.fields.map(field => `${field.key}: ${field.label}`).join(' · ')}>
        <TextArea value={configText} onChange={(event) => { setConfigText(event.target.value) }} />
      </Field>
      <div style={inline}>
        <Button size="sm" variant="primary" onClick={() => {
          const parsed = parseJsonObject(configText)
          if (!parsed.ok) {
            setError(parsed.error)
            return
          }
          void props.store.createSense({
            type: props.type,
            ...(label.trim() === '' ? {} : { label: label.trim() }),
            config: parsed.value,
            desiredState: 'enabled',
          }).then(() => { setOpen(false); setLabel('') }, (reason: unknown) => { setError((reason as Error).message) })
        }}>{props.t('create')}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setOpen(false) }}>{props.t('disable')}</Button>
      </div>
      {error !== null && <ErrorBanner>{error}</ErrorBanner>}
    </div>
  )
}

function AttentionTab(props: {
  readonly state: QunoWireState
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
  readonly locale: 'zh' | 'en'
}): React.ReactElement {
  const { state, store, t } = props
  const [filter, setFilter] = React.useState<'active' | 'all'>('active')
  const items = filter === 'active'
    ? state.attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed')
    : state.attention
  if (items.length === 0) return <Empty>{t('attentionEmpty')}</Empty>
  return (
    <div style={stack}>
      <div style={inline}>
        <Select value={filter} onChange={(event) => { setFilter(event.target.value === 'all' ? 'all' : 'active') }}>
          <option value="active">{t('filterAll')}</option>
          <option value="all">{t('filterAll')}</option>
        </Select>
      </div>
      {items.map(item => (
        <Card key={item.id} title={item.title} aside={<span style={muted}>{statusLabel(item.status, t)} · {t('revision')} {item.revision}</span>}>
          <p style={bodyText}>{item.summary}</p>
          <div style={metaRow}>
            <span>{item.topicKey}</span>
            {item.nextReviewAt !== null && <span>{t('nextReview')}：{formatClock(item.nextReviewAt)}</span>}
            {item.evidence.slice(0, 2).map(point => <span key={point.eventId ?? point.quote}>{point.quote ?? point.eventId}</span>)}
          </div>
          <div style={inline}>
            <Button size="sm" variant="primary" onClick={() => {
              void store.actAttention({ itemId: item.id, action: 'processed', expectedRevision: item.revision })
            }}>{t('actProcessed')}</Button>
            <Button size="sm" variant="outline" onClick={() => {
              void store.actAttention({ itemId: item.id, action: 'later', expectedRevision: item.revision, snoozeMinutes: 60 })
            }}>{t('actLater')}</Button>
            <Button size="sm" variant="ghost" onClick={() => {
              void store.actAttention({ itemId: item.id, action: 'dismiss', expectedRevision: item.revision })
            }}>{t('actDismiss')}</Button>
            {(item.status === 'resolved' || item.status === 'dismissed') && (
              <Button size="sm" variant="ghost" onClick={() => {
                void store.actAttention({ itemId: item.id, action: 'resume', expectedRevision: item.revision })
              }}>{t('actResume')}</Button>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}

function RunsTab(props: {
  readonly state: QunoWireState
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
  readonly locale: 'zh' | 'en'
}): React.ReactElement {
  const { state, store, t } = props
  return (
    <div style={stack}>
      <div style={inline}>
        <Button size="sm" variant="primary" onClick={() => { void store.checkNow() }}>{t('runNow')}</Button>
        <span style={muted}>{format(t('metrics'), {
          pending: state.metrics.deliveries['pending'] ?? 0,
          attention: state.metrics.attentionOpen,
          runs: state.metrics.runsToday,
        })}</span>
      </div>
      {state.runs.length === 0
        ? <Empty>{t('runsEmpty')}</Empty>
        : state.runs.map(run => (
          <Card key={run.id} title={`${t('runKindThink')} · ${run.trigger}`} aside={<span style={muted}>{formatClock(run.startedAt)}</span>}>
            <div style={metaRow}>
              <span>{run.status}</span>
              <span>{run.provider ?? '—'} / {run.model ?? '—'}</span>
              <span>{run.committed} events · {run.notices} notices</span>
              {run.cost !== null && <span>{Math.round(run.cost.durationMs / 1000)}s · {run.cost.promptChars} chars</span>}
            </div>
            {run.error !== null && <ErrorBanner>{run.error.code}: {run.error.message}</ErrorBanner>}
          </Card>
        ))}
      <SectionTitle>{t('noticesTitle')}</SectionTitle>
      {state.notices.length === 0
        ? <Empty>{t('noticesEmpty')}</Empty>
        : state.notices.map(notice => (
          <Card key={notice.id} title={notice.title} aside={<span style={muted}>{notice.status}</span>}>
            <p style={bodyText}>{notice.body}</p>
            <div style={metaRow}>
              <span>{t('whyNotified')}：{notice.why}</span>
              <span>{formatClock(notice.createdAt)}</span>
              {notice.reason !== null && <span>{notice.reason}</span>}
            </div>
          </Card>
        ))}
    </div>
  )
}

function TasksTab(props: {
  readonly state: QunoWireState
  readonly store: QunoClientStore
  readonly t: QunoSettingsInjected['t']
  readonly locale: 'zh' | 'en'
  readonly openSession: (sessionId: string) => void
}): React.ReactElement {
  const { state, store, t } = props
  if (state.tasks.length === 0) return <Empty>{t('tasksEmpty')}</Empty>
  return (
    <div style={stack}>
      {state.tasks.map(task => (
        <Card
          key={task.id}
          title={task.title}
          aside={<span style={muted}>{taskStatusLabel(task.status, t)}</span>}
        >
          {task.result !== null && <p style={bodyText}>{task.result.slice(0, 1200)}</p>}
          {task.error !== null && <ErrorBanner>{task.error.message}</ErrorBanner>}
          {task.artifacts.length > 0 && (
            <div style={metaRow}>
              {task.artifacts.map(artifact => <span key={artifact.uri}>{artifact.label}（{artifact.kind}）</span>)}
            </div>
          )}
          <div style={inline}>
            {task.childSessionId !== null && (
              <Button size="sm" variant="outline" onClick={() => { if (task.childSessionId !== null) props.openSession(task.childSessionId) }}>{t('taskOpen')}</Button>
            )}
            {(task.status === 'interrupted' || task.status === 'failed') && (
              <>
                <Button size="sm" variant="primary" onClick={() => { void store.taskCommand(task.id, 'resume') }}>{t('taskResume')}</Button>
                <Button size="sm" variant="ghost" onClick={() => { void store.taskCommand(task.id, 'abandon') }}>{t('taskAbandon')}</Button>
              </>
            )}
          </div>
        </Card>
      ))}
    </div>
  )
}

function StatusLine(props: { readonly tone: 'ok' | 'warn' | 'error' | 'idle'; readonly text: string }): React.ReactElement {
  return (
    <span style={metaRow}>
      <span style={{ ...dot, background: props.tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : props.tone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : props.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)' }} />
      <span>{props.text}</span>
    </span>
  )
}

function statusLabel(status: string, t: QunoSettingsInjected['t']): string {
  switch (status) {
    case 'open': return t('statusOpen')
    case 'waiting': return t('statusWaiting')
    case 'snoozed': return t('statusSnoozed')
    case 'resolved': return t('statusResolved')
    case 'dismissed': return t('statusDismissed')
    case 'expired': return t('statusExpired')
    default: return status
  }
}

function taskStatusLabel(status: string, t: QunoSettingsInjected['t']): string {
  switch (status) {
    case 'running': return t('taskStatusRunning')
    case 'done': return t('taskStatusDone')
    case 'failed': return t('taskStatusFailed')
    case 'interrupted': return t('taskStatusInterrupted')
    case 'cancelled': return t('taskStatusCancelled')
    default: return status
  }
}

function defaultCwd(): string {
  return '/'
}

const page = { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 24px' } as const
const header = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 } as const
const headerActions = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' } as const
const mainBinding = { display: 'inline-flex', alignItems: 'center', gap: 6 } as const
const mainLabel = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } as const
const h2 = { margin: 0, fontSize: 18, fontWeight: 650, color: 'var(--dsw-alias-label-primary)' } as const
const subtitle = { margin: '4px 0 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } as const
const tabBar = { display: 'flex', gap: 4, borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: 4 } as const
const tabButton = {
  border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit',
  fontSize: 12, padding: '6px 10px', borderRadius: 8, cursor: 'pointer',
} as const
const stack = { display: 'flex', flexDirection: 'column', gap: 12 } as const
const grid2 = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 } as const
const inline = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const
const metaRow = { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } as const
const bodyText = { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' } as const
const muted = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } as const
const smallError = { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } as const
const okText = { fontSize: 11, color: 'var(--dsw-alias-state-success-primary)' } as const
const dot = { width: 7, height: 7, borderRadius: 4, display: 'inline-block' } as const
const instanceCard = {
  display: 'flex', flexDirection: 'column', gap: 8, padding: 10,
  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-2)',
} as const
const instanceHeader = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } as const
