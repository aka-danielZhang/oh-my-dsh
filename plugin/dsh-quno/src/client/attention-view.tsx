/**
 * 关注: the attention cards and their settled tail.
 *
 * A card keeps its identity when one action fails: the failure is reported on
 * the card and the list is left alone, so a conflict never looks like a
 * disappearing item.
 *
 * @module dsh-quno/client/attention-view
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AttentionWire } from '../api-types.ts'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import { formatClock } from './format.ts'
import { clip } from './format.ts'
import { attentionStatusKey, isActiveAttention, type Tone } from './panel-state.ts'
import {
  Callout,
  InlineEmpty,
  LoadingRows,
  PanelEmpty,
  StatusLabel,
} from './panel-primitives.tsx'
import { EventDetailPage } from './event-detail.tsx'

/** Props of the 关注 page. */
export interface AttentionPageProps {
  readonly snapshot: QunoSnapshot
  readonly store: QunoClientStore
  readonly t: QunoTranslate
}

const ACTIONS = [
  ['processed', 'actProcessed', 'primary'],
  ['later', 'actLater', 'outline'],
  ['dismiss', 'actDismiss', 'ghost'],
] as const

/** Render the 关注 tab. */
export function AttentionPage(props: AttentionPageProps): React.ReactElement {
  const { t, snapshot } = props
  const [eventId, setEventId] = React.useState<string | null>(null)
  const [showSettled, setShowSettled] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [failures, setFailures] = React.useState<Readonly<Record<string, string>>>({})

  if (eventId !== null) {
    return <EventDetailPage eventId={eventId} store={props.store} t={t} onBack={() => { setEventId(null) }} />
  }

  const state = snapshot.state
  if (state === null) {
    if (snapshot.phase === 'error') {
      return (
        <PanelEmpty
          icon="attention"
          title={t('loadFailedTitle')}
          description={snapshot.error ?? ''}
          action={{ label: t('retry'), onClick: () => { void props.store.refresh() } }}
        />
      )
    }
    return <LoadingRows rows={3} />
  }

  const active = state.attention.filter(isActiveAttention)
  const settled = state.attention.filter(item => !isActiveAttention(item))

  const act = async (item: AttentionWire, action: 'processed' | 'later' | 'dismiss' | 'resume'): Promise<void> => {
    if (busyId !== null) return
    setBusyId(item.id)
    setFailures((current) => {
      const next = { ...current }
      delete next[item.id]
      return next
    })
    try {
      await props.store.actAttention(action === 'later'
        ? { itemId: item.id, action, expectedRevision: item.revision, snoozeMinutes: 60 }
        : { itemId: item.id, action, expectedRevision: item.revision })
    } catch (reason) {
      setFailures(current => ({ ...current, [item.id]: reason instanceof Error ? reason.message : String(reason) }))
    } finally {
      setBusyId(null)
    }
  }

  const renderCard = (item: AttentionWire, actionable: boolean): React.ReactElement => {
    const failure = failures[item.id]
    // Evidence is shown only as the recorded quote or as an openable original:
    // a bare event id is an internal identifier, never copy.
    const evidencePoints = item.evidence
      .slice(0, 3)
      .map((point, index) => ({
        point,
        index,
        quote: point.quote !== undefined && point.quote !== '' ? clip(point.quote, 64) : null,
        readable: point.eventId !== undefined && evidenceReadable(point.eventId, snapshot),
      }))
      .filter(entry => entry.quote !== null || entry.readable)
    return (
      <article key={item.id} style={styles.card}>
        <header style={styles.head}>
          <StatusLabel tone={statusTone(item.status)}>{t(attentionStatusKey(item.status))}</StatusLabel>
          <span style={styles.title} title={item.title}>{item.title}</span>
          {reviewLine(item, t) !== null && <span style={styles.meta}>{reviewLine(item, t)}</span>}
        </header>

        {item.summary !== '' && <p style={styles.summary}>{clip(item.summary, 320)}</p>}

        {evidencePoints.length > 0 && (
          <div style={styles.evidence}>
            {evidencePoints.map(({ point, index, quote, readable }) => {
              if (readable && point.eventId !== undefined) {
                return (
                  <button
                    key={point.eventId}
                    type="button"
                    style={styles.evidenceButton}
                    title={t('attentionViewOriginal')}
                    onClick={() => { setEventId(point.eventId ?? null) }}
                  >
                    {quote ?? t('attentionViewOriginal')}
                  </button>
                )
              }
              return (
                <span
                  key={`quote-${String(index)}`}
                  style={styles.evidenceQuiet}
                  title={t('attentionOriginalUnavailable')}
                >
                  {quote ?? ''}
                </span>
              )
            })}
          </div>
        )}

        {failure !== undefined && (
          <Callout tone="error" title={t('conflict')}>
            <span style={styles.failure}>{failure}</span>
          </Callout>
        )}

        <footer style={styles.footer}>
          {actionable
            ? ACTIONS.map(([action, key, variant]) => (
              <Button
                key={action}
                size="sm"
                variant={variant}
                disabled={busyId !== null}
                onClick={() => { void act(item, action) }}
              >
                {t(key)}
              </Button>
            ))
            : (item.status === 'resolved' || item.status === 'dismissed') && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busyId !== null}
                onClick={() => { void act(item, 'resume') }}
              >
                {t('actResume')}
              </Button>
            )}
        </footer>
      </article>
    )
  }

  return (
    <div style={styles.stack}>
      {active.length === 0 && settled.length === 0 && (
        <PanelEmpty
          icon="attention"
          title={t('attentionEmptyTitle')}
          description={t('attentionEmptyDesc')}
        />
      )}
      {active.length === 0 && settled.length > 0 && <InlineEmpty>{t('attentionNoActive')}</InlineEmpty>}
      {active.map(item => renderCard(item, true))}

      {settled.length > 0 && (
        <>
          <button type="button" style={styles.disclosure} onClick={() => { setShowSettled(!showSettled) }}>
            <span aria-hidden="true">{showSettled ? '▾' : '▸'}</span> {t('attentionSettled')} · {settled.length}
          </button>
          {showSettled && settled.map(item => renderCard(item, false))}
        </>
      )}
    </div>
  )
}

/** Whether the evidence behind one attention point can be opened honestly. */
function evidenceReadable(eventId: string, snapshot: QunoSnapshot): boolean {
  const event = snapshot.events.find(candidate => candidate.id === eventId)
  // An event outside the recent window cannot be classified here; the detail
  // page reports the truth instead of the list guessing.
  if (event === undefined) return true
  if (event.pruned) return false
  const state = snapshot.state
  if (state === null) return false
  const source = state.sources.find(candidate => candidate.id === event.sourceId)
  if (source === undefined) return false
  const type = state.collectorTypes.find(candidate => candidate.type === source.type)
  return type?.reliability?.readOriginal === true
}

/** The card's trailing time: review time while active, settle time afterwards. */
function reviewLine(item: AttentionWire, t: QunoTranslate): string | null {
  if (isActiveAttention(item)) {
    if (item.snoozedUntil !== null && item.snoozedUntil > Date.now()) {
      return `${t('statusSnoozed')} · ${formatClock(item.snoozedUntil)}`
    }
    return item.nextReviewAt === null ? null : `${t('attentionNextReview')} · ${formatClock(item.nextReviewAt)}`
  }
  return `${t('attentionSettledAt')} · ${formatClock(item.updatedAt)}`
}

function statusTone(status: string): Tone {
  switch (status) {
    case 'open': return 'warn'
    case 'expired': return 'error'
    case 'resolved': return 'ok'
    case 'snoozed': return 'idle'
    default: return 'idle'
  }
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  card: {
    display: 'flex', flexDirection: 'column', gap: 6,
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-2)', padding: 10, minWidth: 0,
  },
  head: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  title: {
    flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  meta: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
  summary: { margin: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  evidence: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' },
  evidenceButton: {
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', borderRadius: 6, padding: '1px 7px',
    cursor: 'pointer', font: 'inherit', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', maxWidth: '100%',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  evidenceQuiet: {
    border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', borderRadius: 6, padding: '1px 7px', fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  failure: { fontSize: 11, overflowWrap: 'anywhere' },
  footer: {
    display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center',
    borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8, marginTop: 2,
  },
  disclosure: {
    border: 0, background: 'transparent', cursor: 'pointer', padding: '6px 6px 2px', textAlign: 'left',
    font: 'inherit', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)',
  },
} as const
