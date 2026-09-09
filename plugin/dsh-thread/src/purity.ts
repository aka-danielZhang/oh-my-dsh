/**
 * Semantic purity of one target Session log.
 *
 * Purity is about model-visible semantics, never about presentation: every
 * `session/title` event is allowed regardless of count or content — the title
 * is log-only display metadata that never enters model context and must never
 * authenticate a target. The identity job belongs to the target fingerprint;
 * this check only decides whether the Session still carries ONLY what Session
 * creation, this Link's own delivery, and log-only metadata put there.
 */

/** Minimal structural view of a session event; keeps this module test-pure. */
export interface PurityEvent {
  seq: number
  type: string
  data?: unknown
}

interface MessageLike { id?: unknown }
interface SpliceLike { inserted?: readonly MessageLike[] }

/** Event types that change model execution semantics when they appear first. */
const FORBIDDEN_PRISTINE_TYPES = new Set([
  'turn/start',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'agent/inbox/spliced',
  'command/run',
])

export type PurityDecision =
  | { ok: true }
  | { ok: false; offending: string }

function messageId(event: PurityEvent): string | null {
  const data = event.data as MessageLike | undefined
  const id = data?.id
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null
}

function spliceInsertIds(event: PurityEvent): readonly string[] {
  const data = event.data as SpliceLike | undefined
  const inserted = data?.inserted
  if (!Array.isArray(inserted)) return []
  return inserted.map(message => String(message?.id)).filter(id => id !== 'undefined')
}

/**
 * Check that no model-visible semantic event predates this Link's delivery.
 *
 * `knownIds` are message ids owned by the current delivery attempt (recorded
 * durably before the first inbox mutation). Events carrying them — and splice
 * events whose inserted ids are all ours — are this Link's own work, not
 * divergence. Events after our first known id are downstream of the delivery
 * (the agent turn our instruction spawned) and are likewise allowed; purity is
 * only ever consulted BEFORE a fresh delivery, so this rule never masks
 * foreign input: foreign input without our ids present fails outright.
 */
export function checkSemanticPurity(
  events: readonly PurityEvent[],
  knownIds: ReadonlySet<string>,
): PurityDecision {
  let firstKnownSeq: number | null = null
  if (knownIds.size > 0) {
    for (const event of events) {
      if (event.type === 'user/message' && knownIds.has(messageId(event) ?? '')) {
        firstKnownSeq = event.seq
        break
      }
    }
  }
  for (const event of events) {
    if (!FORBIDDEN_PRISTINE_TYPES.has(event.type)) continue
    if (firstKnownSeq !== null && event.seq > firstKnownSeq) continue
    if (event.type === 'user/message' && knownIds.has(messageId(event) ?? '')) continue
    if (event.type === 'agent/inbox/spliced') {
      const inserted = spliceInsertIds(event)
      if (inserted.length > 0 && inserted.every(id => knownIds.has(id))) continue
    }
    return { ok: false, offending: event.type }
  }
  return { ok: true }
}

/** Presence of one delivery attempt's two messages in the target log. */
export interface DeliveryPresence {
  handoffPresent: boolean
  instructionPresent: boolean
  /** `delivered` when both messages are in the log — commit without injecting. */
  delivered: boolean
}

/**
 * Decide, by message-id presence, whether a `submitting`/`uncertain` delivery
 * already reached the durable log. The two appends are adjacent and
 * synchronous, so a flushed (durable) outcome contains both; a crash before
 * flush contains neither — but a partially persisted flush is still handled
 * per-message by redelivering only what is missing.
 */
export function checkDeliveryPresence(
  events: readonly PurityEvent[],
  handoffId: string | null,
  instructionId: string | null,
): DeliveryPresence {
  let handoffPresent = false
  let instructionPresent = false
  const wanted = new Set([handoffId, instructionId].filter((id): id is string => id !== null))
  if (wanted.size === 0) return { handoffPresent: false, instructionPresent: false, delivered: false }
  for (const event of events) {
    if (event.type === 'user/message') {
      const id = messageId(event) ?? ''
      if (wanted.has(id)) {
        if (id === handoffId) handoffPresent = true
        if (id === instructionId) instructionPresent = true
      }
    } else if (event.type === 'agent/inbox/spliced') {
      for (const id of spliceInsertIds(event)) {
        if (id === handoffId) handoffPresent = true
        if (id === instructionId) instructionPresent = true
      }
    }
  }
  const optionalHandoff = handoffId === null || handoffPresent
  const optionalInstruction = instructionId === null || instructionPresent
  return {
    handoffPresent,
    instructionPresent,
    delivered: optionalHandoff && optionalInstruction,
  }
}
