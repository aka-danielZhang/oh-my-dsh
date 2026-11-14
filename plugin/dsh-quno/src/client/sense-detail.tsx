/**
 * One Sense instance's detail view.
 *
 * Default surface: identity, one state, last successful sync, a declaration-
 * driven config summary, a live callout for the current problem and the four
 * primary operations. Everything an operator only needs when diagnosing —
 * three axes, checkpoint revision, retry timing, reliability declarations,
 * permissions, raw config — lives behind one "诊断信息" disclosure.
 *
 * Shared by the right panel and the settings page.
 *
 * @module dsh-quno/client/sense-detail
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { QunoWireState, SenseFieldWire, SenseTypeWire, SenseWire } from '../api-types.ts'
import { format } from './locales.ts'
import { clip, formatClock } from './format.ts'
import { QunoKV } from './ui.tsx'
import {
  senseRowKey,
  senseRowState,
  senseRowTone,
  sourceDisplayName,
} from './panel-state.ts'
import { sourceSummary, sourceSummaryText } from './sense-summary.ts'
import { Callout, DetailHeader, DetailSection, StatusLabel } from './panel-primitives.tsx'

/** Injected face of the detail view. */
export interface SenseDetailInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
}

/** Props of one instance detail. */
export interface SenseDetailProps extends SenseDetailInjected {
  readonly instance: SenseWire
  readonly type: SenseTypeWire | undefined
  readonly gaps: readonly { readonly sourceId: string; readonly at: number; readonly reason: string }[]
  readonly onBack?: () => void
  readonly onEdit?: () => void
  /** Settings embeds this view and hides the redundant back link. */
  readonly compact?: boolean
}

/** Render one instance's detail. */
export function SenseDetail(props: SenseDetailProps): React.ReactElement {
  const { instance, type, t, store } = props
  const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const probe = snapshot.probes[instance.id]
  const fields = type?.configFields ?? instance.configFields
  const typeName = type?.displayName ?? instance.type
  const label = instance.label === '' ? typeName : instance.label
  const rowState = senseRowState(instance)
  const isYzj = instance.type.includes('yzj')
  const probeAvailable = type?.probeAvailable === true
  const summary = sourceSummary(instance.config, fields)

  const command = async (action: 'pause' | 'resume' | 'disable' | 'remove'): Promise<void> => {
    if (busy !== null) return
    setBusy(action)
    setError(null)
    try {
      await store.senseCommand({ instanceId: instance.id, action })
      setConfirmRemove(false)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const probeNow = async (): Promise<void> => {
    if (busy !== null) return
    setBusy('probe')
    setError(null)
    try {
      await store.probeSense(instance.id)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const enabled = instance.desiredState === 'enabled'
  const primaryActions = (
    <>
      {enabled
        ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void command('pause') }}>{t('pause')}</Button>
        : <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void command('resume') }}>{t('resume')}</Button>}
      {props.onEdit !== undefined && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={props.onEdit}>{t('senseEdit')}</Button>
      )}
      {probeAvailable && (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void probeNow() }}>
          {busy === 'probe' ? t('senseProbing') : t('senseProbe')}
        </Button>
      )}
    </>
  )

  return (
    <div style={styles.stack}>
      <DetailHeader
        icon="sense"
        title={label}
        subtitle={`${typeName} · ${instance.type}`}
        status={<StatusLabel tone={senseRowTone(rowState)}>{t(senseRowKey(rowState))}</StatusLabel>}
        backLabel={t('panelBack')}
        {...(props.compact === true || props.onBack === undefined ? {} : { onBack: props.onBack })}
        actions={primaryActions}
      />

      {instance.health === 'auth-required' && (
        <Callout tone="warn" title={t('panelSenseAuthRequired')}>
          <code style={styles.code}>{isYzj ? 'yzj-cli auth login　# 无浏览器环境加 --device' : t('authCommand')}</code>
          <span style={styles.calloutNote}>{isYzj ? t('authYzjNote') : t('authGenericNote')}</span>
        </Callout>
      )}
      {instance.stale && <Callout tone="warn" title={t('stale')}>{t('healthStaleNote')}</Callout>}
      {instance.healthDetail?.detail !== undefined && instance.healthDetail.detail !== '' && (
        <Callout tone="warn" title={t('senseCurrentProblem')}>{clip(instance.healthDetail.detail, 400)}</Callout>
      )}
      {probe !== undefined && (
        <Callout
          tone={probe.ok ? 'success' : 'error'}
          title={probe.ok
            ? format(t('senseProbeOk'), { ms: probe.durationMs })
            : format(t('senseProbeFailed'), { message: clip(probe.message, 200) })}
        >
          {t('senseProbeHint')}
        </Callout>
      )}
      {error !== null && <Callout tone="error" title={t('actionFailed')}>{error}</Callout>}

      <DetailSection title={t('senseSummaryTitle')}>
        <QunoKV k={t('lastSuccess')} v={instance.lastSuccessAt === null ? t('never') : formatClock(instance.lastSuccessAt)} />
        <QunoKV k={t('lastEvent')} v={instance.lastEventAt === null ? t('never') : formatClock(instance.lastEventAt)} />
        <QunoKV k={t('senseConfigSummary')} v={sourceSummaryText(summary, typeName, t)} />
        <QunoKV
          k={t('panelGaps')}
          v={props.gaps.length === 0 ? t('gapsNoneShort') : format(t('gapsCount'), { count: props.gaps.length })}
        />
        {props.gaps.slice(0, 2).map((gap, index) => (
          <p key={`${gap.sourceId}-${String(index)}`} style={styles.gapLine}>
            {format(t('panelGapLine'), {
              source: sourceDisplayName(snapshot.state ?? { sources: [], senses: [], senseTypes: [] }, gap.sourceId) ?? t('sourceUnknown'),
              reason: clip(gap.reason, 160),
            })} · {formatClock(gap.at)}
          </p>
        ))}
      </DetailSection>

      <details style={styles.diagnostics}>
        <summary style={styles.summary}>{t('diagnosticsTitle')}</summary>
        <div style={styles.diagnosticsBody}>
          <DetailSection title={t('senseAxesTitle')}>
            <QunoKV k={t('senseAxisDesired')} v={desiredStateLabel(instance.desiredState, t)} />
            <QunoKV k={t('senseAxisLifecycle')} v={lifecycleLabel(instance.lifecycle, t)} />
            <QunoKV k={t('senseAxisHealth')} v={senseHealthLabel(instance.health, t)} />
            <QunoKV k={t('checkpoint')} v={`v${String(instance.checkpointRevision)}`} />
          </DetailSection>

          <DetailSection title={t('panelFreshness')}>
            <QunoKV k={t('lastAttempt')} v={formatClock(instance.lastAttemptAt)} />
            <QunoKV k={t('nextRetry')} v={instance.nextRetryAt === null ? t('nextRetryNone') : formatClock(instance.nextRetryAt)} />
            <QunoKV k={t('sourceLag')} v={instance.healthDetail?.sourceLagSec === null || instance.healthDetail?.sourceLagSec === undefined ? '—' : String(instance.healthDetail.sourceLagSec)} />
            <QunoKV k={t('coveredThrough')} v={instance.healthDetail?.coveredThrough ?? '—'} />
            <QunoKV k={t('consecutiveFailures')} v={String(instance.healthDetail?.consecutiveFailures ?? instance.consecutiveFailures ?? 0)} />
            <QunoKV k={t('errorCode')} v={instance.healthDetail?.errorCode ?? instance.errorCode ?? '—'} />
            <p style={styles.hint}>{t('freshnessNote')}</p>
          </DetailSection>

          <DetailSection title={t('capabilitiesTitle')}>
            {type === undefined || type.reliability === null
              ? <p style={styles.hint}>{t('declaredUnavailable')}</p>
              : (
                <div style={styles.chips}>
                  <span style={styles.chip}>{t('reliabilityCheckpoint')} · {type.reliability.checkpoint}</span>
                  <span style={styles.chip}>{t('reliabilityReplay')} · {type.reliability.replay.kind === 'none' ? 'none' : 'bounded'}</span>
                  <span style={styles.chip}>{t('reliabilityCoverage')} · {type.reliability.changeCoverage}</span>
                  <span style={styles.chip}>{t('reliabilityGap')} · {type.reliability.gapDetection}</span>
                  <span style={styles.chip}>{t('reliabilityOriginal')} · {type.reliability.readOriginal ? '✓' : '—'}</span>
                </div>
              )}
            {type === undefined || type.permissions === null
              ? <p style={styles.hint}>{t('declaredUnavailable')}</p>
              : (
                <>
                  <QunoKV k={t('permissionReads')} v={type.permissions.reads.join('；') || '—'} />
                  <QunoKV k={t('permissionNetwork')} v={type.permissions.network.join('；') || '—'} />
                  <QunoKV k={t('permissionCredentials')} v={type.permissions.credentialKinds.join('；') || '—'} />
                  <QunoKV k={t('permissionModel')} v={type.permissions.requiresModel ? '✓' : '—'} />
                </>
              )}
            <p style={styles.hint}>{probeAvailable ? t('senseProbeHint') : t('senseProbeUnsupported')}</p>
          </DetailSection>

          <DetailSection title={t('configTitle')}>
            {fields.length === 0
              ? <pre style={styles.pre}>{clip(JSON.stringify(instance.config, null, 2), 1200)}</pre>
              : fields.map(field => (
                <QunoKV key={field.key} k={field.advanced === true ? `${field.label} · ${t('advancedTitle')}` : field.label} v={renderConfigValue(instance.config[field.key], field)} />
              ))}
            {fields.some(field => field.secret === true) && <p style={styles.hint}>{t('configSecretNote')}</p>}
            {fields.length > 0 && (
              <details style={styles.rawConfig}>
                <summary style={styles.summary}>{t('onboardingRawJson')}</summary>
                <pre style={styles.pre}>{clip(JSON.stringify(instance.config, null, 2), 1200)}</pre>
              </details>
            )}
            <p style={styles.hint}>{t('checkpointNote')}</p>
          </DetailSection>
        </div>
      </details>

      <section style={styles.danger}>
        <h4 style={styles.dangerTitle}>{t('senseDangerZone')}</h4>
        <p style={styles.hint}>{t('senseDangerHint')}</p>
        <div style={styles.dangerActions}>
          {instance.desiredState !== 'disabled' && (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void command('disable') }}>{t('disable')}</Button>
          )}
          {confirmRemove
            ? (
              <>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { setConfirmRemove(false) }}>{t('cancel')}</Button>
                <button
                  type="button"
                  className="dsh-quno-danger"
                  data-confirm="true"
                  style={styles.dangerConfirm}
                  disabled={busy !== null}
                  onClick={() => { void command('remove') }}
                >
                  {busy === 'remove' ? t('removing') : t('confirmRemove')}
                </button>
              </>
            )
            : (
              <button
                type="button"
                className="dsh-quno-danger"
                style={styles.dangerButton}
                disabled={busy !== null}
                onClick={() => { setConfirmRemove(true) }}
              >
                {t('remove')}
              </button>
            )}
        </div>
        {confirmRemove && <p style={styles.warnText}>{t('senseRemoveConfirm')}</p>}
      </section>
    </div>
  )
}

/** Locate one instance's type declaration and its gaps from the snapshot. */
export function senseContext(state: QunoWireState | null, instanceId: string): {
  readonly instance: SenseWire | undefined
  readonly type: SenseTypeWire | undefined
  readonly gaps: readonly { readonly sourceId: string; readonly at: number; readonly reason: string }[]
} {
  const instance = state?.senses.find(candidate => candidate.id === instanceId)
  const type = instance === undefined ? undefined : state?.senseTypes.find(candidate => candidate.type === instance.type)
  const sourceIds = new Set((state?.sources ?? []).filter(source => source.instanceId === instanceId).map(source => source.id))
  const gaps = (state?.gaps ?? []).filter(gap => sourceIds.has(gap.sourceId))
  return { instance, type, gaps }
}

/** Localized health label. */
export function senseHealthLabel(health: string, t: (key: Parameters<QunoTranslate>[0]) => string): string {
  switch (health) {
    case 'healthy': return t('panelSenseHealthy')
    case 'degraded': return t('panelSenseDegraded')
    case 'rate-limited': return t('panelSenseRateLimited')
    case 'auth-required': return t('panelSenseAuthRequired')
    case 'unavailable': return t('panelSenseUnavailable')
    default: return t('healthUnknown')
  }
}

/** Localized desired-state label. */
export function desiredStateLabel(state: string, t: (key: Parameters<QunoTranslate>[0]) => string): string {
  switch (state) {
    case 'enabled': return t('stateEnabled')
    case 'paused': return t('statePaused')
    case 'disabled': return t('stateDisabled')
    default: return state
  }
}

/** Localized lifecycle label. */
export function lifecycleLabel(lifecycle: string, t: (key: Parameters<QunoTranslate>[0]) => string): string {
  switch (lifecycle) {
    case 'starting': return t('lifecycleStarting')
    case 'running': return t('lifecycleRunning')
    case 'stopping': return t('lifecycleStopping')
    case 'stopped': return t('lifecycleStopped')
    case 'failed': return t('lifecycleFailed')
    default: return lifecycle
  }
}

/** Localized first-sync semantics, never a guess. */
export function firstSyncText(kind: string, t: (key: Parameters<QunoTranslate>[0]) => string): string {
  switch (kind) {
    case 'baseline-only': return t('firstSyncBaselineOnly')
    case 'snapshot-events': return t('firstSyncSnapshotEvents')
    case 'current-window-events': return t('firstSyncCurrentWindow')
    default: return t('firstSyncUnknown')
  }
}

/** Render one config value honestly: secrets stay masked, arrays are joined. */
export function renderConfigValue(value: unknown, field: SenseFieldWire): string {
  // `null` on a secret field means "a value is stored, but never sent here".
  if (field.secret === true) return value === undefined || value === '' ? '—' : '••••••'
  if (value === undefined || value === null) return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.map(item => String(item)).join(', ')
  if (typeof value === 'object') return clip(JSON.stringify(value), 400)
  if (typeof value === 'boolean') return value ? '✓' : '—'
  return String(value)
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
  code: {
    display: 'block', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
    color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '6px 9px',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  calloutNote: { fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  gapLine: { margin: '2px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  diagnostics: {
    borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8, marginTop: 2,
  },
  diagnosticsBody: { display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 2 },
  summary: { cursor: 'pointer', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)' },
  rawConfig: { marginTop: 6 },
  hint: { margin: '4px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' },
  chips: { display: 'flex', gap: 5, flexWrap: 'wrap', margin: '4px 0' },
  chip: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6, padding: '2px 7px' },
  pre: {
    margin: '4px 0 0', padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', maxHeight: 220,
    overflow: 'auto', fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  danger: {
    borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 10, marginTop: 4,
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  dangerTitle: { margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' },
  dangerActions: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 },
  dangerButton: {
    height: 28, padding: '0 10px', borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 12,
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  dangerConfirm: {
    height: 28, padding: '0 10px', borderRadius: 8, cursor: 'pointer', font: 'inherit', fontSize: 12,
    border: '1px solid var(--dsw-alias-state-error-primary)',
    background: 'var(--dsw-alias-state-error-primary)',
    color: 'var(--dsw-alias-label-primary-foreground)',
  },
  warnText: { margin: '4px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)' },
} as const
