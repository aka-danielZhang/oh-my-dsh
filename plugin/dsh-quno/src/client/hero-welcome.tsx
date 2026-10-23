/**
 * The Quno first-open welcome (design §13.8): a big avatar, one welcome line
 * and three suggested-opener chips rendered into `conversation.hero.options`
 * while the hero session is a Quno main. A chip fills the draft and submits —
 * with a degrade to draft-only when the input machine refuses (hero phase).
 *
 * @module dsh-quno/client/hero-welcome
 */

import React from 'react'
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import { format } from './locales.ts'

/** Injected face of the welcome block. */
export interface QunoHeroWelcomeInjected {
  readonly store: QunoClientStore
  readonly t: (key: QunoLocaleKey, params?: Record<string, string | number>) => string
}

/** The suggested openers, in display order. */
const OPENERS: readonly { readonly key: QunoLocaleKey }[] = [
  { key: 'openerToday' },
  { key: 'openerDigest' },
  { key: 'openerRemind' },
]

/** Render the welcome block, or null outside a Quno main conversation. */
export function QunoHeroWelcome(props: PropsRuntime<'conversation.hero.options'> & QunoHeroWelcomeInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const preset = props.useSessions(sessions => sessions.byId[props.sessionId]?.projectionValues?.agentPreset)
  const state = snapshot.state
  if (preset !== 'quno' || state === null) return null

  const chipClick = (text: string): void => {
    const actions = props.inputActions as Pick<InputActions, 'setDraft' | 'submit'> | undefined
    if (actions === undefined) return
    try {
      actions.setDraft(text)
      actions.submit()
    } catch {
      // The hero-phase input machine can refuse submission; the draft stays.
    }
  }

  return (
    <div style={styles.root}>
      <span style={styles.avatar} aria-hidden="true">Q</span>
      <p style={styles.line}>{format(props.t('welcomeLine'), { name: state.quno.name })}</p>
      <div style={styles.chipRow}>
        {OPENERS.map(({ key }) => (
          <button key={key} type="button" style={styles.chip} onClick={() => { chipClick(props.t(key)) }}>
            {props.t(key)}
          </button>
        ))}
      </div>
    </div>
  )
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '4px 8px 10px' },
  avatar: {
    width: 40, height: 40, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 18, fontWeight: 700, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  line: { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary)', textAlign: 'center' },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  chip: {
    height: 28, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', font: 'inherit', fontSize: 12,
    color: 'var(--dsw-alias-label-primary)',
  },
} as const
