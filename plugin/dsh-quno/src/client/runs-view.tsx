/**
 * 运行: the analysis-run list and its detail routing.
 *
 * This page owns thinking runs only. Notice bodies used to be stacked here as
 * a second, unmanaged feed; they now belong to the conversation card and the
 * 关注 view, while a run reports just what it committed.
 *
 * @module dsh-quno/client/runs-view
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RunWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import { format } from './locales.ts'
import { formatClock, formatDuration } from './format.ts'
import { deliveryAnomaly, runDurationOf, runStatusKey, runTone, runTriggerKey } from './panel-state.ts'
import {
  Callout,
  InlineEmpty,
  LoadingRows,
  MissingState,
  PanelEmpty,
  PanelListRow,
} from './panel-primitives.tsx'
import { RunDetailPage } from './run-detail.tsx'

/** Props of the 运行 page. */
export interface RunsPageProps {
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly runId: string | null
  readonly onOpen: (runId: string) => void
  readonly onBack: () => void
}

/** How one manual check ended, in the user's words. */
type CheckOutcome = 'empty' | 'paused' | 'busy' | 'budget' | 'ran' | 'error' | 'unknown'

function checkOutcome(kind: string): CheckOutcome {
  switch (kind) {
    case 'empty': return 'empty'
    case 'paused': return 'paused'
    case 'busy': return 'busy'
    case 'budget': return 'budget'
    case 'ran': return 'ran'
    case 'error': return 'error'
    default: return 'unknown'
  }
}

/** Render the 运行 tab (list or one run). */
export function RunsPage(props: RunsPageProps): React.ReactElement {
  const { t, snapshot } = props
  const [busy, setBusy] = React.useState(false)
  const [outcome, setOutcome] = React.useState<CheckOutcome | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const state = snapshot.state
  if (state === null) {
    if (snapshot.phase === 'error') {
      return (
        <PanelEmpty
          icon="run"
          title={t('loadFailedTitle')}
          description={snapshot.error ?? ''}
          action={{ label: t('retry'), onClick: () => { void props.store.refresh() } }}
        />
      )
    }
    return <LoadingRows rows={3} />
  }

  if (props.runId !== null) {
    const run = state.runs.find(candidate => candidate.id === props.runId)
    if (run === undefined) {
      return (
        <MissingState
          icon="run"
          title={t('runMissing')}
          description={t('runMissingDesc')}
          backLabel={t('panelBack')}
          onBack={props.onBack}
        />
      )
    }
    return <RunDetailPage run={run} t={t} onBack={props.onBack} />
  }

  const check = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    setOutcome(null)
    try {
      const result = await props.store.checkNow()
      setOutcome(checkOutcome(result.kind))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const anomaly = deliveryAnomaly(state.metrics.deliveries)

  return (
    <div style={styles.stack}>
      <div style={styles.intro}>
        <p style={styles.introText}>{t('runsIntro')}</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { void check() }}>
          {busy ? t('runNowBusy') : t('runNow')}
        </Button>
      </div>

      {outcome !== null && (
        <Callout
          tone={outcome === 'ran' ? 'success' : outcome === 'error' ? 'error' : 'info'}
          title={t(outcomeTitleKey(outcome))}
        >
          {outcome === 'empty'
            ? t('checkNowEmptyBody')
            : outcome === 'ran'
              ? t('checkNowRanBody')
              : outcome === 'budget'
                ? t('checkNowBudgetBody')
                : outcome === 'paused'
                  ? t('checkNowPausedBody')
                  : outcome === 'busy'
                    ? t('checkNowBusyBody')
                    : t('checkNowErrorBody')}
        </Callout>
      )}
      {error !== null && (
        <Callout tone="error" title={t('loadFailedTitle')} action={{ label: t('retry'), onClick: () => { void check() } }}>
          {error}
        </Callout>
      )}

      {anomaly.deadLetter > 0 && (
        <Callout tone="error" title={format(t('deliveryDeadLetter'), { count: anomaly.deadLetter })}>
          {t('deliveryDeadLetterBody')}
        </Callout>
      )}
      {anomaly.deadLetter === 0 && anomaly.deferred > 0 && (
        <Callout tone="warn" title={format(t('deliveryDeferred'), { count: anomaly.deferred })}>
          {t('deliveryDeferredBody')}
        </Callout>
      )}

      {state.runs.length === 0
        ? <PanelEmpty icon="run" title={t('runsEmptyTitle')} description={t('runsEmptyDesc')} />
        : (
          <div style={styles.list}>
            {state.runs.map(run => <RunRow key={run.id} run={run} t={t} onOpen={props.onOpen} />)}
          </div>
        )}

      {state.runs.length > 0 && <InlineEmpty>{format(t('runsFootnote'), { count: state.metrics.runsToday })}</InlineEmpty>}
    </div>
  )
}

/** One run row: trigger, status, duration, committed events, notices. */
function RunRow(props: {
  readonly run: RunWire
  readonly t: QunoTranslate
  readonly onOpen: (runId: string) => void
}): React.ReactElement {
  const { run, t } = props
  const trigger = runTriggerKey(run.trigger)
  const triggerText = trigger === undefined ? run.trigger : t(trigger)
  const statusText = t(runStatusKey(run.status))
  const duration = runDurationOf(run, Date.now())
  const subtitle = [
    statusText,
    duration === null ? undefined : formatDuration(duration),
    format(t('runCounts'), { committed: run.committed, notices: run.notices }),
  ].filter((part): part is string => part !== undefined).join(' · ')
  return (
    <PanelListRow
      tone={runTone(run.status)}
      title={`${t('runKindThink')} · ${triggerText}`}
      subtitle={subtitle}
      meta={formatClock(run.startedAt)}
      onClick={() => { props.onOpen(run.id) }}
      titleAttr={`${t('runKindThink')} · ${triggerText}`}
    />
  )
}

function outcomeTitleKey(outcome: CheckOutcome): Parameters<QunoTranslate>[0] {
  switch (outcome) {
    case 'empty': return 'checkNowEmpty'
    case 'ran': return 'checkNowRan'
    case 'budget': return 'checkNowBudget'
    case 'paused': return 'checkNowPaused'
    case 'busy': return 'checkNowBusy'
    case 'error': return 'checkNowError'
    default: return 'checkNowDone'
  }
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  intro: { display: 'flex', alignItems: 'flex-start', gap: 8 },
  introText: { flex: 1, margin: 0, fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  list: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
} as const
