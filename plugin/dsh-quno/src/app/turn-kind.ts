/**
 * Which kind of turn a live Agent is currently serving.
 *
 * Quno has exactly one permanent conversation, but three kinds of turn enter
 * it: a human message, an automatic Eval/Report relay, and a Notification.
 * The turn kind is not a guess: it is the `source.kind` of the latest
 * `user/message` in the durable log. Tools and guards read it to keep automatic
 * turns from writing memory, executing, or creating unbudgeted work.
 *
 * @module dsh-quno/app/turn-kind
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** The three turn kinds of the permanent conversation. */
export type TurnKind = 'human' | 'eval' | 'notification' | 'unknown'

/** Message sources produced by Quno itself. */
const EVAL_SOURCES = new Set(['quno-eval', 'quno-report'])
const NOTIFICATION_SOURCES = new Set(['quno-notify', 'quno-task'])

/** The source kind carried by one user message. */
export function messageSourceKind(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const source = (message as { source?: unknown }).source
  if (typeof source !== 'object' || source === null) return null
  const kind = (source as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

/** The latest user message id and source kind in one session. */
export function latestUserMessage(session: { snapshotEvents(): readonly { type: string; data: unknown }[] }): {
  readonly id: string | null
  readonly sourceKind: string | null
} {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const data = event.data as { id?: unknown } | undefined
    return {
      id: typeof data?.id === 'string' ? data.id : null,
      sourceKind: messageSourceKind(data),
    }
  }
  return { id: null, sourceKind: null }
}

/** Classify the turn a live Agent is serving. */
export function turnKindOf(agent: Agent | undefined): TurnKind {
  if (agent === undefined) return 'unknown'
  try {
    const source = latestUserMessage(agent.session).sourceKind
    if (source === null) return 'human'
    if (EVAL_SOURCES.has(source)) return 'eval'
    if (NOTIFICATION_SOURCES.has(source)) return 'notification'
    return 'human'
  } catch {
    return 'unknown'
  }
}

/** The Eval id carried by the latest Quno-originated message, if any. */
export function currentEvalId(agent: Agent | undefined): string | null {
  if (agent === undefined) return null
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = (event.data as { source?: unknown } | undefined)?.source
    if (typeof source !== 'object' || source === null) return null
    const record = source as Record<string, unknown>
    if (record['kind'] !== 'quno-eval') return null
    return typeof record['evalId'] === 'string' ? record['evalId'] : null
  }
  return null
}

/** The Ticket id carried by the latest report relay, if any. */
export function currentReportTicketId(agent: Agent | undefined): string | null {
  if (agent === undefined) return null
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const source = (event.data as { source?: unknown } | undefined)?.source
    if (typeof source !== 'object' || source === null) return null
    const record = source as Record<string, unknown>
    if (record['kind'] !== 'quno-report') return null
    return typeof record['ticketId'] === 'string' ? record['ticketId'] : null
  }
  return null
}

/** The latest human message id (used as the direct-accept idempotency key). */
export function latestHumanMessageId(agent: Agent | undefined): string | null {
  if (agent === undefined) return null
  const events = agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const data = event.data as { id?: unknown; source?: unknown } | undefined
    const kind = typeof data?.source === 'object' && data.source !== null
      ? (data.source as { kind?: unknown }).kind
      : undefined
    if (typeof kind === 'string' && (EVAL_SOURCES.has(kind) || NOTIFICATION_SOURCES.has(kind))) continue
    return typeof data?.id === 'string' ? data.id : null
  }
  return null
}
