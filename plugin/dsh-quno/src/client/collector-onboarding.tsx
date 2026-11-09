/**
 * The Collector onboarding wizard (design §13.10): one large in-app modal with
 * three columns — type, configuration, and "what will happen". Registered in
 * `shell.overlay`, so it is not squeezed into the 800px settings dialog, and
 * opened from both the settings Sources tab and the right panel.
 *
 * The draft belongs to the host component: switching columns, resizing, or
 * polling refreshes never clear it. Closing with unsaved edits asks first.
 * Creating never claims success: the wizard switches to an honest "created,
 * first sync running" panel fed by the real snapshot.
 *
 * @module dsh-quno/client/collector-onboarding
 */

import React from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoLocaleKey } from './locales.ts'
import type { CollectorTypeWire, CollectorWire } from '../api-types.ts'
import { CollectorForm, initialCollectorConfig, type CollectorFormInjected } from './collector-form.tsx'
import { firstSyncText } from './collector-detail.tsx'
import { creationPhase, type CreationPhase } from './panel-state.ts'
import { PanelIcon, StatusLabel } from './panel-primitives.tsx'
import { ErrorBanner } from './ui.tsx'

/** One wizard request. */
export type OnboardingRequest =
  | { readonly kind: 'create'; readonly type?: string }
  | { readonly kind: 'edit'; readonly instanceId: string; readonly type: string }

/** Minimal observable controller shared by settings, the panel and the overlay host. */
export class OnboardingController {
  private request: OnboardingRequest | null = null
  private readonly listeners = new Set<() => void>()

  readonly getSnapshot = (): OnboardingRequest | null => this.request

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  open(request: OnboardingRequest): void {
    this.request = request
    this.notify()
  }

  close(): void {
    if (this.request === null) return
    this.request = null
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

/** The one controller instance this plugin's browser half shares. */
export const onboarding = new OnboardingController()

/** Injected face of the overlay host. */
export interface OnboardingInjected extends CollectorFormInjected {
  readonly onOpenDetail?: (instanceId: string) => void
}

type OnboardingProps = PropsRuntime<'shell.overlay'> & OnboardingInjected

/** Render the wizard while it is open; nothing otherwise. */
export function QunoOnboardingHost(props: OnboardingProps): React.ReactElement | null {
  const request = React.useSyncExternalStore(onboarding.subscribe, onboarding.getSnapshot, onboarding.getSnapshot)
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const width = useViewportWidth()
  const state = snapshot.state
  const [draftType, setDraftType] = React.useState<string | null>(null)
  const [label, setLabel] = React.useState('')
  const [config, setConfig] = React.useState<Record<string, unknown>>({})
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [createdId, setCreatedId] = React.useState<string | null>(null)
  const [confirmClose, setConfirmClose] = React.useState(false)
  const initial = React.useRef<string>('')
  const initialized = React.useRef<string | null>(null)

  const requestKey = request === null
    ? ''
    : request.kind === 'create'
      ? `create:${request.type ?? ''}`
      : `edit:${request.instanceId}`

  // Initialize the draft once per request, never on a poll tick.
  React.useEffect(() => {
    if (request === null || state === null) {
      if (request === null) {
        initialized.current = null
        setDraftType(null)
        setLabel('')
        setConfig({})
        setError(null)
        setCreatedId(null)
        setConfirmClose(false)
        setSaving(false)
      }
      return
    }
    if (initialized.current === requestKey) return
    initialized.current = requestKey
    setError(null)
    setCreatedId(null)
    setConfirmClose(false)
    if (request.kind === 'create') {
      const type = request.type === undefined
        ? undefined
        : state.collectorTypes.find(candidate => candidate.type === request.type && candidate.registered)
      setDraftType(type?.type ?? null)
      setLabel('')
      const next = type === undefined ? {} : initialCollectorConfig(type.configFields)
      setConfig(next)
      initial.current = JSON.stringify({ label: '', config: next })
      return
    }
    const instance = state.collectors.find(candidate => candidate.id === request.instanceId)
    if (instance === undefined) {
      setDraftType(request.type)
      setConfig({})
      initial.current = ''
      return
    }
    setDraftType(instance.type)
    setLabel(instance.label)
    setConfig({ ...instance.config })
    initial.current = JSON.stringify({ label: instance.label, config: instance.config })
  }, [request, requestKey, state])

  if (request === null || state === null) return null

  const instance = request.kind === 'edit'
    ? state.collectors.find(candidate => candidate.id === request.instanceId)
    : undefined
  const type: CollectorTypeWire | undefined = draftType === null
    ? undefined
    : state.collectorTypes.find(candidate => candidate.type === draftType)
  const dirty = JSON.stringify({ label, config }) !== initial.current
  const createdInstance = createdId === null ? undefined : state.collectors.find(candidate => candidate.id === createdId)
  const editMissing = request.kind === 'edit' && instance === undefined

  const attemptClose = (): void => {
    if (saving) return
    if (dirty && createdId === null) {
      setConfirmClose(true)
      return
    }
    onboarding.close()
  }

  const pickType = (next: CollectorTypeWire): void => {
    setDraftType(next.type)
    setConfig(initialCollectorConfig(next.configFields))
    initial.current = JSON.stringify({ label, config: initialCollectorConfig(next.configFields) })
    setError(null)
  }

  const submit = async (): Promise<void> => {
    if (saving || draftType === null) return
    setSaving(true)
    setError(null)
    try {
      if (request.kind === 'edit' && instance !== undefined) {
        await props.store.collectorCommand({
          instanceId: instance.id,
          action: 'reconfigure',
          ...(label.trim() === '' ? { label: instance.label } : { label: label.trim() }),
          config,
        })
        onboarding.close()
        return
      }
      const before = new Set((props.store.getSnapshot().state?.collectors ?? []).map(candidate => candidate.id))
      await props.store.createCollector({
        type: draftType,
        ...(label.trim() === '' ? {} : { label: label.trim() }),
        config,
        desiredState: 'enabled',
      })
      const fresh = props.store.getSnapshot().state?.collectors.find(candidate => candidate.type === draftType && !before.has(candidate.id))
      setCreatedId(fresh?.id ?? '')
      initial.current = JSON.stringify({ label, config })
    } catch (reason) {
      setError(cleanError((reason as Error).message))
    } finally {
      setSaving(false)
    }
  }

  const columns = width >= 980
    ? { gridTemplateColumns: 'minmax(190px, 230px) minmax(280px, 1fr) minmax(210px, 270px)' }
    : width >= 720
      ? { gridTemplateColumns: 'minmax(190px, 230px) minmax(0, 1fr)' }
      : { gridTemplateColumns: 'minmax(0, 1fr)' }

  return (
    <Modal
      open
      headless
      onClose={attemptClose}
      title={request.kind === 'edit' ? props.t('onboardingEditTitle') : props.t('onboardingTitle')}
      className="dsh-quno-onboarding-dialog"
      backdropBlur={false}
    >
      <div style={styles.dialogBody}>
        <header style={styles.header}>
          <div style={styles.headerText}>
            <h2 style={styles.h2}>{request.kind === 'edit' ? props.t('onboardingEditTitle') : props.t('onboardingTitle')}</h2>
            <p style={styles.subtitle}>
              {type?.displayName ?? props.t('onboardingPickType')}
              {type?.registered === false ? ` · ${props.t('collectorNotDeclared')}` : ''}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={attemptClose}>{props.t('onboardingClose')}</Button>
        </header>

        {editMissing
          ? (
            <div style={styles.success}>
              <p style={styles.bodyText}>{props.t('collectorMissing')}</p>
              <div style={styles.footerButtons}>
                <Button size="sm" variant="primary" onClick={() => { onboarding.close() }}>{props.t('onboardingDone')}</Button>
              </div>
            </div>
          )
          : createdId !== null
          ? (
            <div style={styles.success}>
              <h3 style={styles.successTitle}>{props.t('onboardingCreated')}</h3>
              {createdInstance === undefined
                ? <p style={styles.bodyText}>{props.t('onboardingCreatedBody')}</p>
                : <CreationState instance={createdInstance} t={props.t} />}
              <div style={styles.footerButtons}>
                {createdInstance !== undefined && props.onOpenDetail !== undefined && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      props.onOpenDetail?.(createdInstance.id)
                      onboarding.close()
                    }}
                  >
                    {props.t('onboardingViewDetail')}
                  </Button>
                )}
                <Button size="sm" variant="primary" onClick={() => { onboarding.close() }}>{props.t('onboardingDone')}</Button>
              </div>
            </div>
          )
          : (
            <>
              <div style={{ ...styles.body, ...columns }}>
                {width >= 720 && (
                  <section style={styles.column}>
                    <div style={styles.columnTitle}>{props.t('onboardingType')}</div>
                    {state.collectorTypes.filter(candidate => candidate.registered).length === 0 && (
                      <p style={styles.bodyText}>{props.t('onboardingNoTypes')}</p>
                    )}
                    {state.collectorTypes.filter(candidate => candidate.registered).map(candidate => (
                      <button
                        key={candidate.type}
                        type="button"
                        style={{ ...styles.typeCard, ...(candidate.type === draftType ? styles.typeCardActive : {}) }}
                        disabled={request.kind === 'edit'}
                        onClick={() => { pickType(candidate) }}
                      >
                        <span style={styles.typeHead}>
                          <PanelIcon kind="collectors" size={15} />
                          <span style={styles.typeName}>{candidate.displayName}</span>
                        </span>
                        <span style={styles.typeDesc}>{candidate.description}</span>
                      </button>
                    ))}
                  </section>
                )}

                <section style={{ ...styles.column, ...styles.formColumn }}>
                  {width < 720 && (
                    <select
                      style={styles.mobileTypeSelect}
                      value={draftType ?? ''}
                      disabled={request.kind === 'edit'}
                      onChange={(event) => {
                        const next = state.collectorTypes.find(candidate => candidate.type === event.target.value)
                        if (next !== undefined) pickType(next)
                      }}
                    >
                      <option value="">{props.t('onboardingType')}</option>
                      {state.collectorTypes.filter(candidate => candidate.registered).map(candidate => (
                        <option key={candidate.type} value={candidate.type}>{candidate.displayName}</option>
                      ))}
                    </select>
                  )}
                  {draftType === null || type === undefined
                    ? <p style={styles.bodyText}>{props.t('onboardingPickType')}</p>
                    : (
                      <CollectorForm
                        store={props.store}
                        t={props.t}
                        type={draftType}
                        fields={type.configFields}
                        config={config}
                        onChange={setConfig}
                        label={label}
                        onLabelChange={setLabel}
                        disabled={saving}
                      />
                    )}
                  {type !== undefined && request.kind === 'edit' && (
                    <p style={styles.hint}>{props.t('onboardingRestartNote')}</p>
                  )}
                </section>

                {width >= 980 && (
                  <section style={{ ...styles.column, ...styles.outcome }}>
                    {type === undefined
                      ? <p style={styles.bodyText}>{props.t('onboardingPickType')}</p>
                      : <Outcome type={type} t={props.t} />}
                  </section>
                )}
              </div>

              {width < 980 && type !== undefined && (
                <div style={styles.outcomeNarrow}>
                  <Outcome type={type} t={props.t} />
                </div>
              )}

              <footer style={styles.footer}>
                {error !== null && <ErrorBanner>{error}</ErrorBanner>}
                {confirmClose && (
                  <div style={styles.confirmRow}>
                    <span style={styles.hint}>{props.t('onboardingDirty')}</span>
                    <Button size="sm" variant="ghost" onClick={() => { setConfirmClose(false) }}>{props.t('onboardingKeepEditing')}</Button>
                    <Button size="sm" variant="primary" onClick={() => { onboarding.close() }}>{props.t('onboardingDiscard')}</Button>
                  </div>
                )}
                <div style={styles.footerButtons}>
                  <Button size="sm" variant="ghost" onClick={attemptClose}>{props.t('onboardingClose')}</Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={saving || draftType === null}
                    onClick={() => { void submit() }}
                  >
                    {saving
                      ? props.t('onboardingCreating')
                      : request.kind === 'edit' ? props.t('reconfigure') : props.t('onboardingCreate')}
                  </Button>
                </div>
              </footer>
            </>
          )}
      </div>
    </Modal>
  )
}

/**
 * What the new instance is actually doing. "Created" is never reported as
 * "synced": the wizard shows the real lifecycle, the real first-sync state and
 * the real failure reason.
 */
function CreationState(props: { readonly instance: CollectorWire; readonly t: (key: QunoLocaleKey) => string }): React.ReactElement {
  const { instance, t } = props
  const phase = creationPhase(instance)
  const tone = phase === 'ready' ? 'ok' : phase === 'failed' || phase === 'auth-required' ? 'error' : 'warn'
  const detail = phase === 'failed'
    ? instance.healthDetail?.detail ?? instance.errorCode ?? t('creationFailedBody')
    : t(creationBodyKey(phase))
  return (
    <div style={styles.stack}>
      <div style={styles.instanceAxes}>
        <StatusLabel tone={tone}>{t(creationTitleKey(phase))}</StatusLabel>
        <span style={styles.axisChip}>{t('collectorAxisLifecycle')}：{instance.lifecycle}</span>
        <span style={styles.axisChip}>{t('collectorAxisHealth')}：{instance.health}</span>
      </div>
      <p style={styles.bodyText}>{detail}</p>
    </div>
  )
}

function creationTitleKey(phase: CreationPhase): QunoLocaleKey {
  switch (phase) {
    case 'starting': return 'creationStarting'
    case 'auth-required': return 'creationAuthRequired'
    case 'syncing': return 'creationSyncing'
    case 'ready': return 'creationReady'
    case 'failed': return 'creationFailed'
  }
}

function creationBodyKey(phase: CreationPhase): QunoLocaleKey {
  switch (phase) {
    case 'starting': return 'creationStartingBody'
    case 'auth-required': return 'creationAuthRequiredBody'
    case 'syncing': return 'creationSyncingBody'
    case 'ready': return 'creationReadyBody'
    case 'failed': return 'creationFailedBody'
  }
}

/** The right column: what connecting this type actually does. */
function Outcome(props: { readonly type: CollectorTypeWire; readonly t: (key: QunoLocaleKey) => string }): React.ReactElement {
  const { type, t } = props
  return (
    <div style={styles.stack}>
      <div style={styles.columnTitle}>{t('onboardingOutcome')}</div>
      <p style={styles.bodyText}>{firstSyncText(type.firstSync, t)}</p>
      {type.schedule !== null && (
        <div style={styles.stack}>
          <span style={styles.metaLine}>{t('capabilityInterval')}: {type.schedule.defaultIntervalSec}s</span>
          <span style={styles.metaLine}>{t('capabilityTimeout')}: {type.schedule.maxRunMs}ms</span>
        </div>
      )}
      {type.permissions === null
        ? <p style={styles.hint}>{t('declaredUnavailable')}</p>
        : (
          <div style={styles.stack}>
            <span style={styles.metaLine}>{t('permissionReads')}: {type.permissions.reads.join('；') || '—'}</span>
            {type.permissions.network.length > 0 && (
              <span style={styles.metaLine}>{t('permissionNetwork')}: {type.permissions.network.join('；')}</span>
            )}
            <span style={styles.metaLine}>{t('permissionCredentials')}: {type.permissions.credentialKinds.join('；') || '—'}</span>
            {type.permissions.requiresModel && <span style={styles.metaLine}>{t('permissionModel')}: ✓</span>}
          </div>
        )}
      {type.reliability !== null && (
        <div style={styles.stack}>
          <span style={styles.metaLine}>{t('reliabilityCheckpoint')}: {type.reliability.checkpoint}</span>
          <span style={styles.metaLine}>{t('reliabilityCoverage')}: {type.reliability.changeCoverage}</span>
          <span style={styles.metaLine}>{t('reliabilityGap')}: {type.reliability.gapDetection}</span>
        </div>
      )}
      <p style={styles.hint}>{t('firstSyncAfter21')}</p>
    </div>
  )
}

/** Strip transport noise from a remote error before showing it. */
function cleanError(message: string): string {
  return message.replace(/^[a-z-]+:\s*/i, '')
}

function useViewportWidth(): number {
  const [width, setWidth] = React.useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  React.useEffect(() => {
    const onResize = (): void => { setWidth(window.innerWidth) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])
  return width
}

const styles = {
  dialogBody: {
    display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0,
    overflow: 'hidden', boxSizing: 'border-box',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
    padding: '14px 16px 10px', borderBottom: '1px solid var(--dsw-alias-border-l1)',
  },
  headerText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  h2: { margin: 0, fontSize: 16, fontWeight: 650, color: 'var(--dsw-alias-label-primary)' },
  subtitle: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  body: { display: 'grid', gap: 0, flex: 1, minHeight: 0 },
  column: {
    display: 'flex', flexDirection: 'column', gap: 10, padding: 14, overflowY: 'auto',
    borderRight: '1px solid var(--dsw-alias-border-l1)', minWidth: 0,
  },
  formColumn: { borderRight: 'none' },
  outcome: { borderRight: 'none', background: 'var(--dsw-alias-bg-layer-1)' },
  columnTitle: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)' },
  typeCard: {
    display: 'flex', flexDirection: 'column', gap: 3, padding: 10, textAlign: 'left',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)',
    cursor: 'pointer', font: 'inherit',
  },
  typeCardActive: { borderColor: 'var(--dsw-alias-brand-primary)' },
  typeHead: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--dsw-alias-label-tertiary)' },
  typeName: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  typeDesc: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },

  mobileTypeSelect: {
    height: 30, borderRadius: 8, border: '0.5px solid var(--dsw-alias-border-l4)',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 12,
  },
  outcomeNarrow: {
    padding: 14, borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
    maxHeight: 240, overflowY: 'auto',
  },
  stack: { display: 'flex', flexDirection: 'column', gap: 6 },
  bodyText: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
  hint: { margin: 0, fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  metaLine: { fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  footer: {
    display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 16px 14px',
    borderTop: '1px solid var(--dsw-alias-border-l1)',
  },
  footerButtons: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
  confirmRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  success: { display: 'flex', flexDirection: 'column', gap: 12, padding: 20, overflowY: 'auto' },
  successTitle: { margin: 0, fontSize: 15, fontWeight: 650, color: 'var(--dsw-alias-label-primary)' },
  instanceAxes: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  axisChip: {
    fontSize: 11, padding: '3px 8px', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
  },
} as const
