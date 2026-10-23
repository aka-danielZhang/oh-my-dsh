/**
 * The Quno header identity (design §13.8): 「头像 + Quno + 状态点」 rendered in
 * `conversation.header.leading` (single/root, explicit `priority: -1`) while
 * the on-screen conversation is a Quno main; every other session renders null
 * so the seat stays clean for its owner.
 *
 * Root scope has no sessionId prop: the on-screen conversation is the row the
 * main view retains (the dsh-thread capsule precedent), and the preset check
 * requires the resolved `'quno'` projection — a pending one renders nothing.
 *
 * @module dsh-quno/client/header-identity
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { mainPresence } from './view-model.ts'

/** Injected face of the header identity. */
export interface QunoHeaderIdentityInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
}

/** Render the identity, or null outside a Quno main conversation. */
export function QunoHeaderIdentity(props: PropsRuntime<'conversation.header.leading'> & QunoHeaderIdentityInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const mainViewId = props.useSessions((state) => {
    for (const row of Object.values(state.byId)) {
      if ((row.retainedBy.mainView ?? 0) > 0) return row.id
    }
    return undefined
  })
  const preset = props.useSessions(sessions => mainViewId === undefined
    ? undefined
    : sessions.byId[mainViewId]?.projectionValues?.agentPreset)

  const state = snapshot.state
  if (state === null || mainViewId === undefined || preset !== 'quno') return null

  const presence = mainPresence(state, state.config.enabled, Date.now())
  const dotColor = presence === 'online'
    ? 'var(--dsw-alias-state-success-primary)'
    : presence === 'muted' || presence === 'paused'
      ? 'var(--dsw-alias-state-warn-primary)'
      : 'var(--dsw-alias-state-error-primary)'
  return (
    <span style={styles.root}>
      <span style={styles.avatar} aria-hidden="true">Q</span>
      <span style={styles.name}>{state.quno.name}</span>
      <span style={{ ...styles.dot, background: dotColor }} aria-hidden="true" />
    </span>
  )
}

const styles = {
  root: {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 4px',
    color: 'var(--dsw-alias-label-primary)',
  },
  avatar: {
    width: 20, height: 20, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, fontWeight: 700, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  name: { fontSize: 13, fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dot: { width: 7, height: 7, borderRadius: 999 },
} as const
