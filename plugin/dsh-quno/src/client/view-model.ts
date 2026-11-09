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

/** One capsule row: a kind that has a non-zero count. */
export type CapsuleKind = 'tasks' | 'attention' | 'activity'

/** A capsule row; rows with a zero count do not exist. */
export interface CapsuleItem {
  readonly kind: CapsuleKind
  readonly count: number
}

/**
 * Capsule rows, tasks first (an in-flight job is the most concrete thing to
 * report), then attention, then source alarms. Zero counts produce no row, so
 * the pill never renders `0 0 ●`.
 */
export function capsuleItems(counts: PanelCounts): readonly CapsuleItem[] {
  const items: CapsuleItem[] = []
  if (counts.runningTasks > 0) items.push({ kind: 'tasks', count: counts.runningTasks })
  if (counts.attentionOpen > 0) items.push({ kind: 'attention', count: counts.attentionOpen })
  if (counts.senseAlarms > 0) items.push({ kind: 'activity', count: counts.senseAlarms })
  return items
}

/** Whether anything at all belongs in the capsule. */
export function hasCapsuleContent(counts: PanelCounts): boolean {
  return capsuleItems(counts).length > 0
}

/** Why the capsule is (not) on screen. One state, one reason. */
export type CapsuleVisibility =
  | 'hidden-not-quno'
  | 'hidden-no-face'
  | 'hidden-no-content'
  | 'hidden-no-anchor'
  | 'hidden-right-panel'
  | 'hidden-navigation'
  | 'visible-collapsed'
  | 'visible-flyout'

/** Everything the capsule's visibility depends on, as plain facts. */
export interface CapsuleVisibilityInput {
  /** The host session's resolved `agentPreset` (undefined while pending). */
  readonly preset: string | null | undefined
  /** Whether the right-panel face is available at all. */
  readonly hasFace: boolean
  /** Running tasks, open attention or source alarms exist. */
  readonly hasContent: boolean
  /** The session's own conversation content container was found. */
  readonly hasAnchor: boolean
  /** The Quno panel is open (docked, fullscreen or floating) for THIS session. */
  readonly panelVisible: boolean
  /** A row click just navigated to the panel; hide before the panel animates in. */
  readonly navigationHidden: boolean
  readonly open: boolean
}

/**
 * Decide the capsule's visibility. The order is the contract: a hovered pill
 * must never survive a session switch, a panel takeover, or a lost anchor.
 * @param input - plain visibility facts.
 * @returns the visibility state.
 */
export function capsuleVisibility(input: CapsuleVisibilityInput): CapsuleVisibility {
  if (input.preset !== 'quno') return 'hidden-not-quno'
  if (!input.hasFace) return 'hidden-no-face'
  if (!input.hasContent) return 'hidden-no-content'
  if (!input.hasAnchor) return 'hidden-no-anchor'
  if (input.panelVisible) return 'hidden-right-panel'
  if (input.navigationHidden) return 'hidden-navigation'
  return input.open ? 'visible-flyout' : 'visible-collapsed'
}

/** Whether a visibility state paints the pill. */
export function isCapsuleVisible(state: CapsuleVisibility): boolean {
  return state === 'visible-collapsed' || state === 'visible-flyout'
}

/** Minimal slices the flyout summaries read. */
export interface CapsuleSlice {
  readonly tasks: readonly { readonly status: string; readonly title: string }[]
  readonly attention: readonly { readonly status: string; readonly title: string }[]
  readonly senses: readonly {
    readonly desiredState: string
    readonly health: string
    readonly stale: boolean
    readonly label: string
    readonly type: string
  }[]
  readonly senseTypes: readonly { readonly type: string; readonly displayName: string }[]
}

/** One flyout row: a non-zero category plus one representative record. */
export interface CapsuleSummary {
  readonly kind: CapsuleKind
  readonly count: number
  /** The representative title/source name, absent only for a zero count. */
  readonly subject: string | undefined
}

/**
 * Build the flyout rows. Zero categories produce no row, and each row names
 * one real record so the list is useful before opening the panel.
 * @param slice - tasks, attention items and sources.
 * @returns rows in the fixed tasks → attention → activity order.
 */
export function capsuleSummaries(slice: CapsuleSlice): readonly CapsuleSummary[] {
  const running = slice.tasks.filter(task => task.status === 'running')
  const attention = slice.attention.filter(item => item.status === 'open' || item.status === 'waiting' || item.status === 'snoozed')
  const alarms = slice.senses.filter(sense => sense.desiredState === 'enabled' && (sense.health !== 'healthy' || sense.stale))
  const rows: CapsuleSummary[] = []
  if (running.length > 0) rows.push({ kind: 'tasks', count: running.length, subject: running[0]?.title })
  if (attention.length > 0) rows.push({ kind: 'attention', count: attention.length, subject: attention[0]?.title })
  if (alarms.length > 0) {
    const first = alarms[0]
    const type = first === undefined ? undefined : slice.senseTypes.find(candidate => candidate.type === first.type)
    const subject = first === undefined
      ? undefined
      : first.label !== '' ? first.label : type?.displayName ?? first.type
    rows.push({ kind: 'activity', count: alarms.length, subject })
  }
  return rows
}

/** Total items the compact pill reports when the column is narrow. */
export function capsuleTotal(counts: PanelCounts): number {
  return counts.runningTasks + counts.attentionOpen + counts.senseAlarms
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

/** Keep Quno's permanent main conversation out of ordinary Workspace browsing views. */
export function qunoWorkspaceSessionVisible(session: {
  readonly projectionValues?: { readonly agentPreset?: string | null }
}): boolean {
  return session.projectionValues?.agentPreset !== 'quno'
}
