/**
 * Pure view-model derivations for the redesigned Quno surface (design §13).
 * No React, no services: every function takes plain snapshots so the unit
 * tests cover the decision logic the components only render.
 *
 * @module dsh-quno/client/view-model
 */

/** Minimal face of `QunoWireState` these derivations read. */
export interface StateSlice {
  readonly quno: { readonly mainSessionId: string | null; readonly mutedUntil: number | null }
  readonly main: { readonly sessionId: string | null; readonly state: string }
  readonly senses: readonly { readonly desiredState: string; readonly health: string; readonly stale: boolean }[]
  readonly attention: readonly { readonly status: string }[]
  readonly tasks: readonly { readonly status: string }[]
}

/** The contact row's presence line. */
export type MainPresence = 'online' | 'muted' | 'paused' | 'unbound' | 'missing'

/**
 * Derive the contact row's status.
 * @param slice - the wire snapshot slice.
 * @param enabled - the master switch.
 * @param now - current epoch ms (mute windows compare against it).
 * @returns the presence label discriminator.
 */
export function mainPresence(slice: StateSlice, enabled: boolean, now: number): MainPresence {
  if (!enabled) return 'paused'
  if (slice.quno.mutedUntil !== null && slice.quno.mutedUntil > now) return 'muted'
  if (slice.main.state === 'ok') return 'online'
  if (slice.main.state === 'unbound') return 'unbound'
  return 'missing'
}

/** Counts the pill and the contact badge render. */
export interface PanelCounts {
  readonly runningTasks: number
  readonly attentionOpen: number
  readonly senseAlarms: number
}

/** Enabled senses that are not cleanly healthy, plus the actionable counts. */
export function panelCounts(slice: StateSlice): PanelCounts {
  return {
    runningTasks: slice.tasks.filter(task => task.status === 'running').length,
    attentionOpen: slice.attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed').length,
    senseAlarms: slice.senses.filter(sense => sense.desiredState === 'enabled' && (sense.health !== 'healthy' || sense.stale)).length,
  }
}

/** Predicate inputs for the collapsed-pill visibility decision. */
export interface PillInput {
  /** The Quno main session id (null while unbound). */
  readonly mainSessionId: string | null
  /** The session the right sidebar currently hosts, if any. */
  readonly mountedSessionId: string | undefined
  /** The mounted session's `agentPreset` projection (undefined while pending). */
  readonly mountedPreset: string | null | undefined
  /** Whether the right panel column is expanded. */
  readonly panelExpanded: boolean
}

/**
 * The capsule shows only over a Quno main conversation with the panel collapsed.
 * The preset check deliberately requires the resolved `'quno'` value, so a
 * pending projection keeps the capsule off rather than flashing it.
 */
export function shouldShowPill(input: PillInput): boolean {
  if (input.mainSessionId === null) return false
  if (input.mountedSessionId !== input.mainSessionId) return false
  if (input.mountedPreset !== 'quno') return false
  return !input.panelExpanded
}

/** Minimal event slice for the summary line. */
export interface EventSlice {
  readonly type: string
  readonly operation: string
  readonly summary: string | null
}

/** One compact line for the recent-events list: summary when present, else type + operation. */
export function eventLine(event: EventSlice): string {
  const summary = event.summary ?? ''
  if (summary !== '') return summary
  return `${event.type} · ${event.operation}`
}

/** Whether a plugin-gated surface should be mounted (the master switch). */
export function surfaceEnabled(state: { readonly config?: { readonly enabled?: boolean } } | null): boolean {
  if (state === null) return false
  return state.config?.enabled !== false
}
