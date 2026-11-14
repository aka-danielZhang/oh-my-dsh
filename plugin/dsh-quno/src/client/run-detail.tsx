/**
 * One analysis run's recorded detail: when it ran, why, on which model, what it
 * cost and what it committed. No notice bodies are copied here — those belong
 * to the conversation and the 关注 view.
 *
 * @module dsh-quno/client/run-detail
 */

import React from 'react'
import type { RunWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import { formatClock, formatDuration } from './format.ts'
import { runDurationOf, runStatusKey, runTone, runTriggerKey } from './panel-state.ts'
import { Callout, DetailHeader, DetailSection, StatusLabel } from './panel-primitives.tsx'
import { Empty } from './ui.tsx'

/** Props of one run detail page. */
export interface RunDetailPageProps {
  readonly run: RunWire
  readonly t: QunoTranslate
  readonly onBack: () => void
  /** Injectable clock so an in-flight duration stays testable. */
  readonly now?: number
}

/** Render one run's detail. */
export function RunDetailPage(props: RunDetailPageProps): React.ReactElement {
  const { run, t } = props
  const now = props.now ?? Date.now()
  const duration = runDurationOf(run, now)
  const trigger = runTriggerKey(run.trigger)
  const triggerText = trigger === undefined ? run.trigger : t(trigger)
  const statusText = t(runStatusKey(run.status))

  return (
    <div style={styles.stack}>
      <DetailHeader
        icon="run"
        title={`${t('runKindThink')} · ${triggerText}`}
        subtitle={formatClock(run.startedAt)}
        status={<StatusLabel tone={runTone(run.status)}>{statusText}</StatusLabel>}
        backLabel={t('panelBack')}
        onBack={props.onBack}
      />

      {run.error !== null && (
        <Callout tone="error" title={t('runDetailError')}>
          {run.error.code}：{run.error.message}
        </Callout>
      )}

      <DetailSection title={t('runDetailOverview')}>
        <Row k={t('runStatus')} v={statusText} />
        <Row k={t('runTrigger')} v={triggerText} />
        <Row k={t('runStartedAt')} v={formatClock(run.startedAt)} />
        <Row k={t('runFinishedAt')} v={run.finishedAt === null ? t('runInFlight') : formatClock(run.finishedAt)} />
        <Row k={t('taskDuration')} v={formatDuration(duration)} />
        <Row k={t('runId')} v={run.id} />
      </DetailSection>

      <DetailSection title={t('runDetailModel')}>
        <Row k={t('runProviderModel')} v={`${run.provider ?? '—'} / ${run.model ?? '—'}`} />
        {run.cost === null
          ? <Empty>{t('runNoCost')}</Empty>
          : (
            <>
              <Row k={t('runModelTime')} v={formatDuration(run.cost.durationMs)} />
              <Row k={t('runPromptChars')} v={String(run.cost.promptChars)} />
              <Row k={t('runOutputChars')} v={String(run.cost.outputChars)} />
              <Row k={t('runToolCalls')} v={String(run.cost.toolCalls)} />
            </>
          )}
      </DetailSection>

      <DetailSection title={t('runDetailOutcome')} hint={t('runDetailOutcomeHint')}>
        <Row k={t('runCommitted')} v={String(run.committed)} />
        <Row k={t('runDeferred')} v={String(run.deferred)} />
        <Row k={t('runNotices')} v={String(run.notices)} />
      </DetailSection>
    </div>
  )
}

function Row(props: { readonly k: string; readonly v: string }): React.ReactElement {
  return (
    <div style={styles.row}>
      <span style={styles.k}>{props.k}</span>
      <span style={styles.v}>{props.v}</span>
    </div>
  )
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  row: { display: 'flex', gap: 10, minHeight: 22, fontSize: 12 },
  k: { flex: 'none', width: 86, color: 'var(--dsw-alias-label-tertiary)' },
  v: { flex: 1, minWidth: 0, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
} as const
