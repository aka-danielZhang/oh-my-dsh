/**
 * The「工作」entry button (design v2 §4.2): the ONE emphasis of the whole work
 * surface — a real activity count in the Quno main session's header, with no
 * Worker detail leaking into the message flow.
 *
 * Registration sits on `conversation.session.header.utilities` (the seat that
 * provides the session id, the preset projection and the lifetime). The
 * button renders only while the active session is a Quno main (`agentPreset`
 * projection `quno`), shows the count of in-flight work (needs-you included,
 * never two badges), and toggling it only changes the right column — never
 * the message flow, never a scroll jump.
 *
 * @module dsh-quno/client/work-entry
 */

import React from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore, QunoSnapshot } from './store.ts'
import type { SidebarRightFace } from './capsule.tsx'
import { QUNO_PANEL_KIND } from './right-tab.ts'

/** Injected face of the work entry. */
export interface WorkEntryInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  /** Right-column face; without it the button degrades to a no-op. */
  readonly face: SidebarRightFace | undefined
}

export { workEntryCounts, workEntryAriaLabel } from './work-model.ts'
import { workEntryCounts, workEntryAriaLabel } from './work-model.ts'
import type { WorkEntryCounts } from './work-model.ts'
type WorkEntryProps = PropsRuntime<'conversation.session.header.utilities'> & WorkEntryInjected

/** Render the「工作」entry, or nothing outside a Quno main session. */
export function QunoWorkEntry(props: WorkEntryProps): React.ReactElement | null {
  const snapshot: QunoSnapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const preset = props.useSessions(sessions => sessions.byId[props.sessionId]?.projectionValues?.agentPreset)
  if (preset !== 'quno') return null
  const counts = workEntryCounts(snapshot.state?.tasks ?? null)
  return (
    <button
      type="button"
      className="quno-work-entry"
      data-tone={counts.needsYou > 0 ? 'warn' : 'accent'}
      data-quno-work-entry=""
      aria-label={workEntryAriaLabel(counts, props.t)}
      onClick={() => { props.face?.openTab(QUNO_PANEL_KIND, { params: { view: 'task' } }) }}
    >
      <span aria-hidden="true">{props.t('workEntry')}</span>
      {counts.active > 0 && <span className="quno-work-entry__count" aria-hidden="true">{counts.active}</span>}
    </button>
  )
}
