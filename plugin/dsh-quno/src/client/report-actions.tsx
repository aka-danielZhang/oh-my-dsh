/**
 * The turn-bound proactive report card (design §13.7).
 *
 * It reads the notification id the Host stamped into THIS turn's durable
 * message (published by `qunoNoticeDefinition`), so:
 * - two nearby reports never share a card;
 * - the card never disappears after an arbitrary one-hour window;
 * - reloading the conversation restores it from durable events;
 * - an expired notice degrades to a read-only "历史汇报" card instead of a
 *   stale action row.
 *
 * @module dsh-quno/client/report-actions
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationBinding } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { AttentionWire, EventWire, QunoWireState } from '../api-types.ts'
import { attentionStatusKey } from './panel-state.ts'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { QunoNoticeChatData } from './report-turn.ts'
import { clip, formatClock } from './format.ts'
import { QunoCard, QunoStat } from './ui.tsx'

/** Structural face of `ctx.uiConversation` this card consumes. */
export interface QunoConversationFace {
  binding(sessionId: string): ConversationBinding
}

/** Injected face of the report card. */
export interface QunoReportActionsInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey) => string
  readonly conversation?: QunoConversationFace
}

const EMPTY_NOTICES: readonly QunoNoticeChatData[] = []
const noopSubscribe = (): (() => void) => () => {}
// Stable fallbacks: an inline arrow would change identity every render and
// re-subscribe the external store unnecessarily.
const readNoChat = (): ChatSnapshot | undefined => undefined
const readNoNotices = (): readonly QunoNoticeChatData[] => EMPTY_NOTICES

/** Render one card per notice bound to this Turn (bounded to three). */
export function QunoReportActions(props: PropsRuntime<'conversation.chat.turnTail'> & QunoReportActionsInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const chatSource = React.useMemo(() => {
    if (props.conversation === undefined) return undefined
    try {
      return props.conversation.binding(props.sessionId).target('chat')
    } catch {
      return undefined
    }
  }, [props.conversation, props.sessionId])
  const chat = React.useSyncExternalStore<ChatSnapshot | undefined>(
    chatSource?.subscribe ?? noopSubscribe,
    chatSource?.getSnapshot ?? readNoChat,
    chatSource?.getSnapshot ?? readNoChat,
  )
  const turn = props.turn.turn
  const nodeSource = React.useMemo(
    () => chat?.nodes.turnDataSource(turn, 'quno-notice'),
    [chat, turn],
  )
  const notices = React.useSyncExternalStore<readonly QunoNoticeChatData[]>(
    nodeSource?.subscribe ?? noopSubscribe,
    nodeSource?.getSnapshot ?? readNoNotices,
    nodeSource?.getSnapshot ?? readNoNotices,
  )

  const missingKey = notices
    .map(notice => notice.notificationId)
    .filter(id => snapshot.state?.notices.every(notice => notice.id !== id) === true
      && snapshot.noticeDetails[id] === undefined)
    .join(',')
  React.useEffect(() => {
    if (missingKey === '') return
    for (const id of missingKey.split(',')) void props.store.loadNoticeDetail(id)
  }, [missingKey, props.store])

  const state = snapshot.state
  const t = props.t
  if (state === null || notices.length === 0) return null

  const act = async (item: AttentionWire, action: 'processed' | 'later' | 'dismiss'): Promise<void> => {
    setBusyId(item.id)
    setError(null)
    try {
      await props.store.actAttention({
        itemId: item.id,
        action,
        expectedRevision: item.revision,
        ...(action === 'later' ? { snoozeMinutes: 60 } : {}),
      })
    } catch {
      setError(props.t('conflict'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div style={styles.root}>
      {notices.slice(0, 3).map((notice) => {
        const wire = state.notices.find(candidate => candidate.id === notice.notificationId)
        const entry = snapshot.noticeDetails[notice.notificationId]
        // Only a `ready` answer may stand in for the polled summary; `missing`
        // and `error` fall back to the live wire record without pretending the
        // detail read succeeded.
        const detail = entry !== undefined && entry.status === 'ready' ? entry.data : undefined
        // A notice whose detail is still in flight gets the same-sized
        // skeleton instead of a card that jumps when the answer lands.
        if (wire === undefined && (entry === undefined || entry.status === 'loading')) {
          return <div key={notice.notificationId} className="dsh-quno-skeleton" style={styles.skeleton} />
        }
        const title = detail?.title ?? wire?.title
        const summary = detail?.summary ?? wire?.summary
        const body = detail?.body ?? wire?.body
        const why = detail?.why ?? wire?.why
        const expired = detail?.expired === true || wire?.status === 'expired'
        const itemIds = detail?.itemIds ?? wire?.itemIds ?? []
        const items = itemIds
          .map(id => state.attention.find(item => item.id === id) ?? detail?.items.find(item => item.id === id))
          .filter((item): item is AttentionWire => item !== undefined)
        const actionable = expired ? [] : items.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed')
        const chips = sourceChips(state, snapshot.events, notice.kind, items, t)
        const createdAt = detail?.createdAt ?? wire?.createdAt
        if (title === undefined && (body ?? summary) === undefined) {
          return (
            <QunoCard key={notice.notificationId} accent="var(--dsw-alias-state-warn-primary)" style={{ marginTop: 6 }}>
              <div className="dsh-quno-card__hd">
                <span className="dsh-quno-card__label">
                  {notice.kind === 'task' ? t('reportTaskLabel') : t('reportNoticeLabel')}
                </span>
                <span className="dsh-quno-card__title">{t('reportUnavailable')}</span>
              </div>
            </QunoCard>
          )
        }
        return (
          <QunoCard
            key={notice.notificationId}
            accent={expired
              ? 'var(--dsw-alias-state-warn-primary)'
              : notice.kind === 'task' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-brand-primary)'}
            style={{ marginTop: 6 }}
          >
            <div className="dsh-quno-card__hd">
              <span className="dsh-quno-card__label">
                {notice.kind === 'task' ? t('reportTaskLabel') : t('reportNoticeLabel')}
              </span>
              {title !== undefined && <span className="dsh-quno-card__title">{title}</span>}
              <span className="dsh-quno-card__meta">
                {expired && <QunoStat tone="wait">{t('statusExpired')}</QunoStat>}
                {createdAt !== undefined && <span>{formatClock(createdAt)}</span>}
              </span>
            </div>
            {(body ?? summary) !== undefined && (
              <p className="dsh-quno-card__body">{clip(body ?? summary ?? '', 800)}</p>
            )}
            {chips.length > 0 && (
              <div className="dsh-quno-card__src">
                {t('reportSources')}：
                {chips.map(chip => <span key={chip} className="dsh-quno-chip">{chip}</span>)}
              </div>
            )}
            {why !== undefined && why !== '' && (
              <details style={styles.whyBox}>
                <summary style={styles.whySummary}>{t('whyNotified')}</summary>
                <p style={styles.why}>{clip(why, 300)}</p>
              </details>
            )}
            {actionable.map(item => (
              <div key={item.id} style={styles.row}>
                <span style={styles.itemTitle}>{item.title}</span>
                <Button size="sm" variant="primary" disabled={busyId !== null} onClick={() => { void act(item, 'processed') }}>{t('actProcessed')}</Button>
                <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => { void act(item, 'later') }}>{t('actLater')}</Button>
                <Button size="sm" variant="ghost" disabled={busyId !== null} onClick={() => { void act(item, 'dismiss') }}>{t('actDismiss')}</Button>
              </div>
            ))}
            {!expired && actionable.length === 0 && items.length > 0 && (
              <div style={styles.settled}>
                {items.map(item => <span key={item.id}>{item.title} · {t(attentionStatusKey(item.status))}</span>)}
              </div>
            )}
            {!expired && items.length === 0 && itemIds.length > 0 && (
              <div style={styles.settled}>{t('attentionEvidenceMissing')}</div>
            )}
          </QunoCard>
        )
      })}
      {error !== null && <p style={styles.error}>{error}</p>}
    </div>
  )
}

/**
 * Source labels for the card's chip row, resolved from real evidence:
 * attention point → recent event → source → Collector type display name. Nothing
 * is guessed from `topicKey`; an unresolvable source simply produces no chip.
 * @param state - the polled snapshot (sources and type declarations).
 * @param events - the recent-events cache (the only place event ids resolve).
 * @param kind - the notice kind from the durable card data.
 * @param items - the attention items linked to this notice.
 * @param t - the translator (the task label has no source record).
 * @returns up to four deduped labels.
 */
function sourceChips(
  state: QunoWireState,
  events: readonly EventWire[],
  kind: QunoNoticeChatData['kind'],
  items: readonly AttentionWire[],
  t: (key: QunoLocaleKey) => string,
): string[] {
  const chips = new Set<string>()
  if (kind === 'task') chips.add(t('sourceTask'))
  for (const item of items) {
    for (const point of item.evidence) {
      if (point.eventId === undefined) continue
      const event = events.find(candidate => candidate.id === point.eventId)
      if (event === undefined) continue
      const source = state.sources.find(candidate => candidate.id === event.sourceId)
      if (source === undefined) continue
      const type = state.collectorTypes.find(candidate => candidate.type === source.type)
      chips.add(type?.displayName ?? source.type)
    }
  }
  return [...chips].slice(0, 4)
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 },
  whyBox: { marginTop: 6 },
  whySummary: { cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  why: { margin: '4px 0 0', fontSize: 11, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
  skeleton: { marginTop: 6, height: 78, borderRadius: 16, background: 'var(--dsw-alias-bg-layer-2)' },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 10 },
  itemTitle: { flex: 1, minWidth: 120, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
  settled: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
  error: { margin: 0, fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' },
} as const
