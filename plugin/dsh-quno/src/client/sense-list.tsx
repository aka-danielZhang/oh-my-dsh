/**
 * 动态: the source list plus the recent-event summary.
 *
 * The page state is decided by `sensePageState` before anything renders, so an
 * install guide, a first connect, a first sync, an empty feed and a failed load
 * are five visibly different pages instead of five shades of "no data".
 *
 * @module dsh-quno/client/sense-list
 */

import React from 'react'
import type { EventWire, QunoWireState, SenseWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import { format } from './locales.ts'
import { clip, formatClock } from './format.ts'
import { eventLine } from './view-model.ts'
import {
  sensePageState,
  senseRowKey,
  senseRowState,
  senseRowTone,
  sourceDisplayName,
  sourceReadsOriginal,
} from './panel-state.ts'
import {
  Callout,
  InlineEmpty,
  LoadingRows,
  PanelEmpty,
  PanelListRow,
  PanelSection,
} from './panel-primitives.tsx'
import { EventDetailPage } from './event-detail.tsx'

/** Props of the 动态 page. */
export interface SenseListPageProps {
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly onOpen: (senseId: string) => void
  readonly onAdd?: () => void
}

/** Render the 动态 tab. */
export function SenseListPage(props: SenseListPageProps): React.ReactElement {
  const { t, snapshot } = props
  const [eventId, setEventId] = React.useState<string | null>(null)
  if (eventId !== null) {
    return <EventDetailPage eventId={eventId} store={props.store} t={t} onBack={() => { setEventId(null) }} />
  }

  const state = snapshot.state
  if (state === null) {
    if (snapshot.phase === 'error') {
      return (
        <PanelEmpty
          icon="sense"
          title={t('loadFailedTitle')}
          description={format(t('error'), { error: snapshot.error ?? '' })}
          action={{ label: t('retry'), onClick: () => { void props.store.refresh() } }}
        />
      )
    }
    return <LoadingRows rows={4} />
  }

  const enabled = state.senses.filter(sense => sense.desiredState === 'enabled')
  const awaitingFirstSync = enabled.filter(sense => sense.lastSuccessAt === null).length
  const page = sensePageState({
    phase: snapshot.phase,
    hasState: true,
    instanceCount: state.senses.length,
    typeCount: state.senseTypes.length,
    enabledCount: enabled.length,
    awaitingFirstSync,
    eventCount: snapshot.events.length,
    eventsStatus: snapshot.eventsStatus,
  })

  if (page === 'install-guide' || page === 'first-connect') {
    return (
      <PanelEmpty
        icon="sense"
        title={page === 'install-guide' ? t('emptyNoTypesTitle') : t('emptyNoInstancesTitle')}
        description={page === 'install-guide' ? t('emptyNoTypesDesc') : t('emptyNoInstancesDesc')}
        {...(page === 'first-connect' && props.onAdd !== undefined
          ? { action: { label: t('connectSource'), onClick: props.onAdd } }
          : {})}
      />
    )
  }

  return (
    <div style={styles.stack}>
      <div style={styles.list}>
        {state.senses.map(sense => (
          <SenseRow key={sense.id} sense={sense} state={state} t={t} onOpen={props.onOpen} />
        ))}
      </div>

      {page === 'all-paused' && <InlineEmpty>{t('allSensesPaused')}</InlineEmpty>}
      {page === 'syncing' && <InlineEmpty>{t('firstSyncInFlight')}</InlineEmpty>}
      {page === 'empty' && <InlineEmpty>{t('eventsEmpty')}</InlineEmpty>}

      {state.gaps.length > 0 && (
        <PanelSection title={t('panelGaps')}>
          {state.gaps.slice(0, 5).map((gap, index) => (
            <p key={`${gap.sourceId}-${String(index)}`} style={styles.gapLine}>
              {format(t('panelGapLine'), {
                source: sourceDisplayName(state, gap.sourceId) ?? t('sourceUnknown'),
                reason: clip(gap.reason, 160),
              })}
            </p>
          ))}
        </PanelSection>
      )}

      {state.senses.length > 0 && (
        <PanelSection title={t('panelRecentEvents')}>
          {snapshot.eventsStatus === 'loading' && <LoadingRows rows={2} />}
          {snapshot.eventsStatus === 'error' && (
            <Callout
              tone="error"
              title={t('eventsLoadFailedTitle')}
              action={{ label: t('retry'), onClick: () => { void props.store.refresh() } }}
            >
              {format(t('eventsLoadFailed'), { error: snapshot.eventsError ?? '' })}
            </Callout>
          )}
          {snapshot.eventsStatus === 'ready' && snapshot.events.slice(0, 8).map(event => (
            <EventRow
              key={event.id}
              event={event}
              sourceName={sourceDisplayName(state, event.sourceId) ?? ''}
              readable={!event.pruned && sourceReadsOriginal(state, event.sourceId)}
              t={t}
              onOpen={setEventId}
            />
          ))}
        </PanelSection>
      )}
    </div>
  )
}

/** One source row: a single state, a drill-down, no repeated health copy. */
function SenseRow(props: {
  readonly sense: SenseWire
  readonly state: QunoWireState
  readonly t: QunoTranslate
  readonly onOpen: (senseId: string) => void
}): React.ReactElement {
  const { sense, t } = props
  const rowState = senseRowState(sense)
  const typeName = props.state.senseTypes.find(candidate => candidate.type === sense.type)?.displayName ?? sense.type
  const label = sense.label === '' ? typeName : sense.label
  const meta = rowState === 'ok'
    ? <span>{sense.lastSuccessAt === null ? t('never') : formatClock(sense.lastSuccessAt)}</span>
    : <span style={styles.stateLabel(senseRowTone(rowState))}>{t(senseRowKey(rowState))}</span>
  return (
    <PanelListRow
      tone={senseRowTone(rowState)}
      title={label}
      subtitle={typeName}
      meta={meta}
      onClick={() => { props.onOpen(sense.id) }}
      titleAttr={label}
    />
  )
}

/** One recent event: the summary is always readable, the original is not always. */
function EventRow(props: {
  readonly event: EventWire
  /** The owning instance/type name, resolved from the real source record. */
  readonly sourceName: string
  readonly readable: boolean
  readonly t: QunoTranslate
  readonly onOpen: (eventId: string) => void
}): React.ReactElement {
  const { event, t } = props
  const line = clip(eventLine(event), 90)
  const time = formatClock(event.occurredAt ?? event.receivedAt)
  const subtitle = props.sourceName === '' ? undefined : props.sourceName
  if (!props.readable) {
    return (
      <PanelListRow
        icon="event"
        title={line}
        {...(subtitle === undefined ? {} : { subtitle })}
        meta={time}
        titleAttr={event.pruned ? t('eventPruned') : t('originalUnavailable')}
      />
    )
  }
  return (
    <PanelListRow
      icon="event"
      title={line}
      {...(subtitle === undefined ? {} : { subtitle })}
      meta={time}
      onClick={() => { props.onOpen(event.id) }}
      titleAttr={line}
    />
  )
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  list: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 },
  gapLine: { margin: 0, padding: '1px 6px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  stateLabel: (tone: 'ok' | 'warn' | 'error' | 'idle'): React.CSSProperties => {
    const token = tone === 'ok'
      ? 'var(--dsw-alias-state-success-primary)'
      : tone === 'warn'
        ? 'var(--dsw-alias-state-warn-primary)'
        : tone === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : 'var(--dsw-alias-label-tertiary)'
    return { color: token, fontSize: 11 }
  },
} as const
