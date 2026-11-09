/**
 * One Collector event's bounded payload. The page distinguishes the three async
 * facts it can observe: still loading, failed to load (retryable), and the
 * Host explicitly answering `null` (the record is gone).
 *
 * @module dsh-quno/client/event-detail
 */

import React from 'react'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'
import { clip, formatClock } from './format.ts'
import { instanceDisplayName, sourceDisplayName } from './panel-state.ts'
import { Callout, DetailHeader, DetailSection, LoadingRows, MissingState } from './panel-primitives.tsx'
import { Empty } from './ui.tsx'

/** Props of one event detail page. */
export interface EventDetailPageProps {
  readonly eventId: string
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly onBack: () => void
}

/** Render one event payload, loading it on first visit. */
export function EventDetailPage(props: EventDetailPageProps): React.ReactElement {
  const { t } = props
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const entry = snapshot.eventDetails[props.eventId]

  React.useEffect(() => {
    if (entry !== undefined) return
    void props.store.loadEventDetail(props.eventId)
  }, [props.store, props.eventId, entry])

  const back = <DetailHeader title={t('eventDetail')} backLabel={t('panelBack')} onBack={props.onBack} icon="event" />

  if (entry === undefined || entry.status === 'loading') {
    return (
      <div style={styles.stack}>
        {back}
        <LoadingRows rows={3} />
      </div>
    )
  }
  if (entry.status === 'missing') {
    return (
      <div style={styles.stack}>
        {back}
        <MissingState
          icon="event"
          title={t('eventMissing')}
          description={t('eventMissingDesc')}
          backLabel={t('panelBack')}
          onBack={props.onBack}
        />
      </div>
    )
  }
  if (entry.status === 'error') {
    return (
      <div style={styles.stack}>
        {back}
        <Callout
          tone="error"
          title={t('loadFailedTitle')}
          action={{ label: t('retry'), onClick: () => { void props.store.loadEventDetail(props.eventId) } }}
        >
          {format(t('detailLoadFailed'), { error: entry.message })}
        </Callout>
      </div>
    )
  }

  const detail = entry.data
  const state = snapshot.state
  // Resolve the owning instance/type; a deleted source falls back to an honest
  // label instead of printing a wire id.
  const sourceLabel = state === null
    ? undefined
    : instanceDisplayName(state, detail.instanceId ?? undefined) ?? sourceDisplayName(state, detail.sourceId)
  return (
    <div style={styles.stack}>
      {back}
      <DetailSection title={t('eventData')}>
        <div style={styles.meta}>
          <span>{formatClock(detail.occurredAt ?? detail.receivedAt)}</span>
          <span>{detail.operation}</span>
          <span>{t('eventSource')}：{sourceLabel ?? t('eventMissingSource')}</span>
        </div>
        {detail.summary !== null && <p style={styles.body}>{clip(detail.summary, 600)}</p>}
      </DetailSection>

      {detail.pruned
        ? <Callout tone="info" title={t('eventPrunedTitle')}>{t('eventPruned')}</Callout>
        : detail.data !== null && (
          <DetailSection title={t('eventData')}>
            <pre style={styles.pre}>{clip(typeof detail.data === 'string' ? detail.data : JSON.stringify(detail.data, null, 2), 2400)}</pre>
            {detail.dataTruncated && <p style={styles.hint}>{t('eventDataTruncated')}</p>}
          </DetailSection>
        )}

      {detail.attachments.length > 0 && (
        <DetailSection title={t('eventAttachments')}>
          {detail.attachments.map(attachment => (
            <div key={attachment.ref} style={styles.attachment}>
              <span>{attachment.name}</span>
              <span style={styles.hint}>{attachment.mediaType}{attachment.bytes === undefined ? '' : ` · ${String(attachment.bytes)} B`}</span>
            </div>
          ))}
        </DetailSection>
      )}

      <Empty>{detail.provenance}</Empty>
    </div>
  )
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 },
  meta: { display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  body: { margin: '4px 0 0', fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  pre: {
    margin: 0, padding: 8, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', maxHeight: 320,
    overflow: 'auto', fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-primary)',
    whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
  },
  hint: { margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  attachment: { display: 'flex', flexDirection: 'column', gap: 1, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
} as const
