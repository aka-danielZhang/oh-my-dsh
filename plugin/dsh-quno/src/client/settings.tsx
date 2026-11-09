/**
 * Quno settings: one quiet single-page form (2026-10-28 plan). Only
 * configuration lives here — enablement and cadence, notifications, role and
 * model, source configuration, and bounded budgets. Run state (health, gaps,
 * events, attention, tasks, runs, pause / resume / probe) stays in the
 * conversation's right panel.
 *
 * Every field auto-saves through one serialized queue: minimal patches, no
 * whole-config overwrite, drafts kept on failure, and polling never re-seeds a
 * field while the user is editing it.
 *
 * @module dsh-quno/client/settings
 */

import React from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { QunoBudget, QunoConfig } from '../types.ts'
import type { QunoWireState, CollectorTypeWire, CollectorWire } from '../api-types.ts'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'
import { Empty, ErrorBanner, Field, Select, TextArea, TextInput } from './ui.tsx'
import { onboarding } from './collector-onboarding.tsx'
import { sourceSummary, sourceSummaryText } from './collector-summary.ts'

/** One selectable provider/model route, as listed by the model settings. */
export interface ModelChoice {
  readonly provider: string
  readonly model: string
  readonly name: string
}

/** Injected face of the settings section. */
export interface QunoSettingsInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
  /** Live provider/model routes for the model selector. */
  readonly listModelChoices?: () => Promise<ModelChoice[]>
}

interface SaveStatus {
  readonly key: string
  readonly phase: 'idle' | 'saving' | 'saved' | 'error'
  readonly error?: string
}

interface ProfileDraft {
  name: string
  persona: string
  instructions: string
  modelProvider: string
  model: string
  reasoningEffort: string | null
}

/** Common IANA zones for the searchable time-zone input (free text stays valid). */
const TIME_ZONES = [
  'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Taipei', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul',
  'Asia/Bangkok', 'Asia/Dubai', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Amsterdam',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Vancouver',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
] as const

/** Render the Quno settings section. */
export function QunoSettingsSection(props: PropsRuntime<'settings.section'> & QunoSettingsInjected): React.ReactElement {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const state = snapshot.state
  if (state === null) {
    return (
      <div style={styles.page}>
        {snapshot.phase === 'error'
          ? (
            <div style={styles.stack}>
              <ErrorBanner>{format(props.t('error'), { error: snapshot.error ?? '' })}</ErrorBanner>
              <div><Button size="sm" variant="outline" onClick={() => { void props.store.refresh() }}>{props.t('saveRetry')}</Button></div>
            </div>
          )
          : <Empty>{props.t('loading')}</Empty>}
      </div>
    )
  }
  return <QunoSettingsForm {...props} state={state} snapshotError={snapshot.error} />
}

function QunoSettingsForm(props: QunoSettingsInjected & {
  readonly state: QunoWireState
  readonly snapshotError: string | null
}): React.ReactElement {
  const { state, store, t } = props
  const [config, setConfig] = React.useState<QunoConfig>(state.config)
  const [profile, setProfile] = React.useState<ProfileDraft>({
    name: state.quno.name,
    persona: state.quno.persona,
    instructions: state.quno.instructions,
    modelProvider: state.quno.modelProvider,
    model: state.quno.model,
    reasoningEffort: state.quno.reasoningEffort,
  })
  const [status, setStatus] = React.useState<SaveStatus>({ key: '', phase: 'idle' })
  const [choices, setChoices] = React.useState<readonly ModelChoice[]>([])
  const queue = React.useRef<Promise<void>>(Promise.resolve())
  const lastFailed = React.useRef<{ readonly key: string; readonly retry: () => void } | null>(null)

  React.useEffect(() => {
    let live = true
    void (async () => {
      if (props.listModelChoices === undefined) return
      try {
        const list = await props.listModelChoices()
        if (live) setChoices(list)
      } catch { /* selector degrades to manual entry */ }
    })()
    return () => { live = false }
  }, [props.listModelChoices])

  // Success is a transient acknowledgement; a failure stays until it is fixed
  // or retried, and the draft is never dropped by either path.
  React.useEffect(() => {
    if (status.phase !== 'saved') return
    const savedKey = status.key
    const timer = setTimeout(() => {
      setStatus(current => current.phase === 'saved' && current.key === savedKey ? { key: '', phase: 'idle' } : current)
    }, 1600)
    return () => { clearTimeout(timer) }
  }, [status])

  const enqueue = (key: string, run: () => Promise<unknown>): void => {
    const retry = (): void => { enqueue(key, run) }
    setStatus({ key, phase: 'saving' })
    queue.current = queue.current.then(async () => {
      try {
        await run()
        lastFailed.current = null
        setStatus({ key, phase: 'saved' })
        void store.refresh()
      } catch (reason) {
        lastFailed.current = { key, retry }
        setStatus({ key, phase: 'error', error: reason instanceof Error ? reason.message : String(reason) })
      }
    })
  }

  const patchConfig = (key: string, patch: Partial<QunoConfig>, save: boolean): void => {
    setConfig(current => mergeDraft(current, patch))
    if (save) enqueue(key, () => store.updateConfig(patch as unknown as Record<string, unknown>))
  }
  const commitConfig = (key: string, patch: Partial<QunoConfig>): void => {
    enqueue(key, () => store.updateConfig(patch as unknown as Record<string, unknown>))
  }
  const patchProfile = (key: string, patch: Partial<ProfileDraft>, save: boolean): void => {
    setProfile(current => ({ ...current, ...patch }))
    if (save) enqueue(key, () => store.updateProfile(patch as unknown as Record<string, unknown>))
  }
  const commitProfile = (key: string, patch: Partial<ProfileDraft>): void => {
    enqueue(key, () => store.updateProfile(patch as unknown as Record<string, unknown>))
  }

  const policy = config.notificationPolicy
  const quiet = config.quietHours
  const budget = config.budget
  const hint = (prefix: string): React.ReactElement | null => (
    <SaveHint status={status} prefix={prefix} t={t} onRetry={() => {
      const failed = lastFailed.current
      if (failed !== null && failed.key === status.key) failed.retry()
    }} />
  )

  return (
    <div style={styles.page}>
      <header>
        <h1 style={styles.title}>{t('nav')}</h1>
        <p style={styles.intro}>{t('settingsIntro')}</p>
      </header>
      {props.snapshotError !== null && <ErrorBanner>{format(t('error'), { error: props.snapshotError })}</ErrorBanner>}

      <Group title={t('settingsBasic')} saveHint={hint('basic.')}>
        <SwitchRow
          label={t('enabled')}
          hint={t('settingsEnabledHint')}
          checked={config.enabled}
          onChange={enabled => { patchConfig('basic.enabled', { enabled }, true) }}
        />
        <div style={styles.pair}>
          <NumberField
            t={t}
            label={t('checkInterval')}
            value={config.checkIntervalSec}
            min={60}
            onCommit={value => { patchConfig('basic.interval', { checkIntervalSec: value }, false); commitConfig('basic.interval', { checkIntervalSec: value }) }}
          />
          <Field label={t('timeZone')} hint={t('timeZoneHint')}>
            <TextInput
              list="quno-time-zones"
              value={config.timeZone}
              onChange={event => { patchConfig('basic.zone', { timeZone: event.target.value }, false) }}
              onBlur={() => { commitConfig('basic.zone', { timeZone: config.timeZone.trim() === '' ? Intl.DateTimeFormat().resolvedOptions().timeZone : config.timeZone.trim() }) }}
            />
          </Field>
        </div>
        <datalist id="quno-time-zones">
          {TIME_ZONES.map(zone => <option key={zone} value={zone} />)}
        </datalist>
      </Group>

      <Group title={t('settingsNotifications')} saveHint={hint('notify.')}>
        <Field label={t('notifyMode')}>
          <Select
            value={policy.mode}
            onChange={(event) => {
              const mode = event.target.value === 'every-run' ? 'every-run' : 'meaningful'
              patchConfig('notify.mode', { notificationPolicy: { ...policy, mode } }, true)
            }}
          >
            <option value="meaningful">{t('modeMeaningful')}</option>
            <option value="every-run">{t('modeEveryRun')}</option>
          </Select>
        </Field>
        <SwitchRow
          label={t('quietEnable')}
          hint={quiet === null ? t('quietDisabledHint') : `${quiet.start} – ${quiet.end}`}
          checked={quiet !== null}
          onChange={(enabled) => {
            const next = enabled ? { start: quiet?.start ?? '22:00', end: quiet?.end ?? '08:00' } : null
            patchConfig('notify.quiet', { quietHours: next }, true)
          }}
        />
        <div style={styles.pair}>
          <Field label={t('quietStart')}>
            <TextInput
              type="time"
              disabled={quiet === null}
              value={quiet?.start ?? ''}
              onChange={event => { patchConfig('notify.quietStart', { quietHours: { start: event.target.value, end: quiet?.end ?? '08:00' } }, false) }}
              onBlur={() => { if (quiet !== null) commitConfig('notify.quietStart', { quietHours: quiet }) }}
            />
          </Field>
          <Field label={t('quietEnd')}>
            <TextInput
              type="time"
              disabled={quiet === null}
              value={quiet?.end ?? ''}
              onChange={event => { patchConfig('notify.quietEnd', { quietHours: { start: quiet?.start ?? '22:00', end: event.target.value } }, false) }}
              onBlur={() => { if (quiet !== null) commitConfig('notify.quietEnd', { quietHours: quiet }) }}
            />
          </Field>
        </div>
        <details style={styles.details}>
          <summary style={styles.summary}>{t('advancedNotify')}</summary>
          <div style={styles.detailsBody}>
            <div style={styles.pair}>
              <NumberField
            t={t}
                label={t('minGap')}
                value={policy.minGapSec}
                min={0}
                onCommit={value => { commitConfig('notify.minGap', { notificationPolicy: { ...policy, minGapSec: value } }) }}
              />
              <NumberField
            t={t}
                label={t('maxPerHour')}
                value={policy.maxPerHour}
                min={1}
                onCommit={value => { commitConfig('notify.maxPerHour', { notificationPolicy: { ...policy, maxPerHour: value } }) }}
              />
            </div>
            <SwitchRow
              label={t('allowUrgent')}
              checked={policy.allowUrgentWake}
              onChange={allowUrgentWake => { patchConfig('notify.urgent', { notificationPolicy: { ...policy, allowUrgentWake } }, true) }}
            />
            <SwitchRow
              label={t('urgentQuiet')}
              disabled={!policy.allowUrgentWake}
              checked={policy.urgentMayBreakQuietHours}
              onChange={urgentMayBreakQuietHours => { patchConfig('notify.urgentQuiet', { notificationPolicy: { ...policy, urgentMayBreakQuietHours } }, true) }}
            />
            <SwitchRow
              label={t('dryRun')}
              hint={t('dryRunHint')}
              checked={config.dryRun}
              onChange={dryRun => { patchConfig('notify.dryRun', { dryRun }, true) }}
            />
          </div>
        </details>
      </Group>

      <Group title={t('settingsProfile')} saveHint={hint('profile.')}>
        <Field label={t('name')}>
          <TextInput
            value={profile.name}
            onChange={event => { patchProfile('profile.name', { name: event.target.value }, false) }}
            onBlur={() => { commitProfile('profile.name', { name: profile.name }) }}
          />
        </Field>
        <div style={styles.pair}>
          <ModelField
            t={t}
            choices={choices}
            value={profile}
            onChange={(modelProvider, model) => { patchProfile('profile.model', { modelProvider, model }, true) }}
          />
          <Field label={t('reasoningEffort')}>
            <Select
              value={profile.reasoningEffort ?? ''}
              onChange={(event) => {
                const value = event.target.value === '' ? null : event.target.value
                patchProfile('profile.effort', { reasoningEffort: value }, true)
              }}
            >
              <option value="">{t('reasoningDefault')}</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              {profile.reasoningEffort !== null && !['low', 'medium', 'high'].includes(profile.reasoningEffort) && (
                <option value={profile.reasoningEffort}>{profile.reasoningEffort}</option>
              )}
            </Select>
          </Field>
        </div>
        <Field label={t('persona')}>
          <TextArea
            rows={3}
            value={profile.persona}
            onChange={event => { patchProfile('profile.persona', { persona: event.target.value }, false) }}
            onBlur={() => { commitProfile('profile.persona', { persona: profile.persona }) }}
          />
        </Field>
        <Field label={t('instructions')} hint={t('instructionsHint')}>
          <TextArea
            rows={5}
            value={profile.instructions}
            onChange={event => { patchProfile('profile.instructions', { instructions: event.target.value }, false) }}
            onBlur={() => { commitProfile('profile.instructions', { instructions: profile.instructions }) }}
          />
        </Field>
      </Group>

      <Group
        title={t('settingsSources')}
        action={<Button size="sm" variant="outline" onClick={() => { onboarding.open({ kind: 'create' }) }}>{t('connectSource')}</Button>}
      >
        {state.collectors.length === 0
          ? <p style={styles.hint}>{t('settingsSourcesHint')}</p>
          : state.collectors.map((collectors) => {
            const type = state.collectorTypes.find(candidate => candidate.type === collectors.type)
            const fields = type?.configFields ?? collectors.configFields
            const derived = sourceSummary(collectors.config, fields)
            const summary = derived.kind === 'none' ? '' : sourceSummaryText(derived, type?.displayName ?? collectors.type, t)
            return (
              <div key={collectors.id} style={styles.sourceRow}>
                <div style={styles.sourceText}>
                  <div style={styles.rowLabel}>{collectors.label === '' ? (type?.displayName ?? collectors.type) : collectors.label}</div>
                  <div style={styles.hint}>{typeLabel(state.collectorTypes, collectors)}{summary === '' ? '' : ` · ${summary}`}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => { onboarding.open({ kind: 'edit', instanceId: collectors.id, type: collectors.type }) }}>
                  {t('collectorEdit')}
                </Button>
              </div>
            )
          })}
      </Group>

      <Group title={t('settingsAdvanced')} saveHint={hint('advanced.')} collapsible>
        <div style={styles.pair}>
          <NumberField
            t={t}
            label={t('budgetEvents')}
            value={budget.maxEventsPerRun}
            min={1}
            onCommit={value => { commitConfig('advanced.events', { budget: { ...budget, maxEventsPerRun: value } }) }}
          />
          <NumberField
            t={t}
            label={t('budgetContext')}
            value={budget.maxContextChars}
            min={2000}
            onCommit={value => { commitConfig('advanced.context', { budget: { ...budget, maxContextChars: value } }) }}
          />
          <NumberField
            t={t}
            label={t('budgetRuns')}
            value={budget.dailyModelRuns}
            min={1}
            onCommit={value => { commitConfig('advanced.runs', { budget: { ...budget, dailyModelRuns: value } }) }}
          />
        </div>
      </Group>
    </div>
  )
}

/** One titled group; `collapsible` renders a details element for advanced fields. */
function Group(props: {
  readonly title: string
  readonly children: React.ReactNode
  readonly saveHint?: React.ReactNode
  readonly action?: React.ReactNode
  readonly collapsible?: boolean
}): React.ReactElement {
  const head = (
    <div style={styles.groupHead}>
      <span style={styles.groupTitle}>{props.title}</span>
      {props.action}
    </div>
  )
  if (props.collapsible === true) {
    return (
      <details style={styles.group}>
        <summary style={styles.groupSummary}>{head}</summary>
        <div style={styles.groupBody}>{props.children}</div>
        {props.saveHint}
      </details>
    )
  }
  return (
    <section style={styles.group}>
      {head}
      <div style={styles.groupBody}>{props.children}</div>
      {props.saveHint}
    </section>
  )
}

/** Label + hint on the left, switch on the right. */
function SwitchRow(props: {
  readonly label: string
  readonly hint?: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (checked: boolean) => void
}): React.ReactElement {
  return (
    <div style={styles.switchRow}>
      <div style={styles.switchText}>
        <div style={styles.rowLabel}>{props.label}</div>
        {props.hint !== undefined && <div style={styles.hint}>{props.hint}</div>}
      </div>
      <Switch checked={props.checked} disabled={props.disabled} label={props.label} onChange={props.onChange} />
    </div>
  )
}

/** A number input that keeps invalid text in place and only commits valid integers. */
function NumberField(props: {
  readonly label: string
  readonly value: number
  readonly min: number
  readonly t: QunoSettingsInjected['t']
  readonly onCommit: (value: number) => void
}): React.ReactElement {
  const [text, setText] = React.useState(String(props.value))
  const [bad, setBad] = React.useState(false)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (!focused.current) setText(String(props.value))
  }, [props.value])
  const commit = (): void => {
    const parsed = Number(text)
    if (!Number.isInteger(parsed) || parsed < props.min) {
      setBad(true)
      return
    }
    setBad(false)
    props.onCommit(parsed)
  }
  return (
    <Field label={props.label} hint={bad ? props.t('integerInvalid') : undefined}>
      <TextInput
        type="number"
        min={props.min}
        value={text}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit() }}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
        onChange={(event) => { setText(event.target.value); setBad(false) }}
      />
    </Field>
  )
}

/** Provider/model selector from the live route list, with a manual fallback. */
function ModelField(props: {
  readonly t: QunoSettingsInjected['t']
  readonly choices: readonly ModelChoice[]
  readonly value: ProfileDraft
  readonly onChange: (provider: string, model: string) => void
}): React.ReactElement {
  const current = `${props.value.modelProvider}::${props.value.model}`
  const [text, setText] = React.useState(props.value.modelProvider === '' ? props.value.model : `${props.value.modelProvider}/${props.value.model}`)
  const focused = React.useRef(false)
  React.useEffect(() => {
    if (!focused.current) setText(props.value.modelProvider === '' ? props.value.model : `${props.value.modelProvider}/${props.value.model}`)
  }, [props.value.model, props.value.modelProvider])
  if (props.choices.length === 0) {
    return (
      <Field label={props.t('model')} hint={props.t('modelFallbackHint')}>
        <TextInput
          value={text}
          onFocus={() => { focused.current = true }}
          onBlur={() => {
            focused.current = false
            const [provider = '', model = ''] = text.includes('/') ? text.split('/', 2) : ['', text]
            props.onChange(provider.trim(), model.trim())
          }}
          onChange={(event) => { setText(event.target.value) }}
        />
      </Field>
    )
  }
  const known = props.choices.some(choice => `${choice.provider}::${choice.model}` === current)
  return (
    <Field label={props.t('model')}>
      <Select
        value={current}
        onChange={(event) => {
          const [provider = '', model = ''] = event.target.value.split('::')
          props.onChange(provider, model)
        }}
      >
        {!known && <option value={current}>{current === '::' ? props.t('modelFallback') : `${props.value.modelProvider}/${props.value.model}`}</option>}
        {props.choices.map(choice => (
          <option key={`${choice.provider}::${choice.model}`} value={`${choice.provider}::${choice.model}`}>
            {choice.name} · {choice.provider}
          </option>
        ))}
      </Select>
    </Field>
  )
}

/** Small per-group save feedback. */
function SaveHint(props: {
  readonly status: SaveStatus
  readonly prefix: string
  readonly t: QunoSettingsInjected['t']
  readonly onRetry: () => void
}): React.ReactElement | null {
  if (!props.status.key.startsWith(props.prefix)) return null
  if (props.status.phase === 'idle') return null
  if (props.status.phase === 'saving') return <div style={styles.saveLine}>{props.t('saveSaving')}</div>
  if (props.status.phase === 'saved') return <div style={styles.saveLine}>{props.t('saveSaved')}</div>
  return (
    <div style={styles.saveError}>
      <span>{format(props.t('saveFailed'), { error: props.status.error ?? '' })}</span>
      <Button size="sm" variant="ghost" onClick={props.onRetry}>{props.t('saveRetry')}</Button>
    </div>
  )
}

/** Deep-merge the three nested config objects the patch path also merges. */
function mergeDraft(current: QunoConfig, patch: Partial<QunoConfig>): QunoConfig {
  return {
    ...current,
    ...patch,
    notificationPolicy: patch.notificationPolicy === undefined ? current.notificationPolicy : { ...current.notificationPolicy, ...patch.notificationPolicy },
    budget: patch.budget === undefined ? current.budget : { ...current.budget, ...patch.budget } as QunoBudget,
    retention: patch.retention === undefined ? current.retention : { ...current.retention, ...patch.retention },
  }
}

/** Declared display name for one instance's type, falling back to the raw type. */
function typeLabel(types: readonly CollectorTypeWire[], collectors: CollectorWire): string {
  return types.find(candidate => candidate.type === collectors.type)?.displayName ?? collectors.type
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: 16, padding: '2px 2px 24px', minWidth: 0 },
  stack: { display: 'flex', flexDirection: 'column', gap: 10 },
  title: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  intro: { margin: '4px 0 0', fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' },
  group: {
    display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 14,
    borderTop: '1px solid var(--dsw-alias-border-l1)',
  },
  groupHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  groupSummary: { cursor: 'pointer', listStyle: 'none' },
  groupTitle: { fontSize: 13, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  groupBody: { display: 'flex', flexDirection: 'column', gap: 12 },
  pair: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 },
  switchRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  switchText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  rowLabel: { fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' },
  hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  details: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10 },
  summary: { cursor: 'pointer', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
  detailsBody: { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 },
  sourceRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '9px 11px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  sourceText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  saveLine: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  saveError: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' },
} as const

export {}
