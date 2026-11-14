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
import { QunoMark } from './quno-mark.tsx'

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
      <QunoMark size={46} />
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
  root: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '4px 8px 12px' },
  line: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', textAlign: 'center' },
  chipRow: { display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2 },
  chip: {
    height: 30, padding: '0 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer', font: 'inherit', fontSize: 12.5,
    color: 'var(--dsw-alias-label-primary)',
  },
} as const
