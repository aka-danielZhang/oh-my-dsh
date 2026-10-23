/**
 * Deterministic report actions in the message stream: when the Quno main
 * conversation has a recent proactive notice awaiting a decision, the turn
 * tail offers 已处理 / 一小时后提醒 / 不再关注 with the item's current revision.
 *
 * @module dsh-quno/client/report-actions
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { AttentionWire } from '../api-types.ts'

/** Injected face of the report actions. */
export interface QunoReportActionsInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey) => string
}

/** How long a delivered notice keeps its inline action row. */
const ACTION_WINDOW_MS = 60 * 60_000

/** Render actions for the newest actionable notice in the Quno conversation. */
export function QunoReportActions(props: PropsRuntime<'conversation.chat.turnTail'> & QunoReportActionsInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const state = snapshot.state
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  if (state === null || state.main.sessionId !== props.sessionId) return null

  const now = Date.now()
  const notice = state.notices.find(candidate =>
    (candidate.status === 'inbox-durable' || candidate.status === 'presented' || candidate.status === 'retrying')
    && now - candidate.createdAt <= ACTION_WINDOW_MS
    && candidate.itemIds.length > 0)
  if (notice === undefined) return null
  const items = notice.itemIds
    .map(id => state.attention.find(item => item.id === id))
    .filter((item): item is AttentionWire => item !== undefined && (item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed'))
  if (items.length === 0) return null

  const act = async (item: AttentionWire, action: 'processed' | 'later' | 'dismiss'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await props.store.actAttention({
        itemId: item.id,
        action,
        expectedRevision: item.revision,
        ...(action === 'later' ? { snoozeMinutes: 60 } : {}),
      })
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.label}>Quno 主动汇报</span>
        <span style={styles.title}>{notice.title}</span>
      </div>
      {items.slice(0, 3).map(item => (
        <div key={item.id} style={styles.row}>
          <span style={styles.itemTitle}>{item.title}</span>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => { void act(item, 'processed') }}>{props.t('actProcessed')}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => { void act(item, 'later') }}>{props.t('actLater')}</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act(item, 'dismiss') }}>{props.t('actDismiss')}</Button>
        </div>
      ))}
      {error !== null && <p style={styles.error}>{error}</p>}
    </div>
  )
}

const styles = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', marginTop: 6,
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)',
  },
  header: { display: 'flex', alignItems: 'center', gap: 8 },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-brand-primary)' },
  title: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  row: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  itemTitle: { flex: 1, minWidth: 120, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
  error: { margin: 0, fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' },
} as const
