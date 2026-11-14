/**
 * The focused filter (v2 §4): a pure decision over one normalized message —
 * does it deserve an event, is it a verified non-hit, or is its relevance
 * unknown (a durable coverage gap)?
 *
 * Decisions never look at message text patterns ("@姓名" in the body is NOT
 * evidence) and never treat extFields reactions as mentions.
 *
 * @module dsh-quno-sense-yzj/filter
 */

import type { YzjMessage } from './messages.ts'

/** What the focused mode does with one incoming message. */
export type FocusedVerdict =
  | { readonly kind: 'event'; readonly evidence: 'yzj-param-desc-at' | 'direct-incoming' }
  | { readonly kind: 'skip'; readonly reason: FocusedSkipReason }
  | { readonly kind: 'unknown'; readonly code: FocusedUnknownCode }

/**
 * Verified non-hits: the cursor moves past them without any coverage claim.
 * `self` covers outgoing and self-chat in every conversation type.
 */
export type FocusedSkipReason = 'self' | 'at-all-only' | 'no-direct-at-evidence'

/**
 * Relevance unknown: the message is ACK-able together with a durable gap, so
 * one weird payload can never wedge a conversation — but a gap stays visible
 * until explicitly handled; later clean rounds do not erase it.
 */
export type FocusedUnknownCode =
  | 'sender-missing'
  | 'mention-structure-malformed'
  | 'at-target-not-a-string'
  | 'unsupported-message-type-with-at'

/** Message types whose top-level @ evidence is verified (2026-10-29 sampling). */
const VERIFIED_TYPES = new Set(['text', 'richText'])

/** Classify one message in a conversation of the given type. */
export function classifyFocused(
  message: YzjMessage,
  selfOpenId: string,
  chatType: 1 | 2,
): FocusedVerdict {
  if (message.fromOpenId === null) return { kind: 'unknown', code: 'sender-missing' }
  if (message.fromOpenId === selfOpenId) return { kind: 'skip', reason: 'self' }
  if (chatType === 1) return { kind: 'event', evidence: 'direct-incoming' }

  // Group chat: only structured top-level at evidence decides.
  if (message.atMentions === null) {
    return message.msgType !== null && VERIFIED_TYPES.has(message.msgType)
      ? { kind: 'unknown', code: 'mention-structure-malformed' }
      : { kind: 'unknown', code: 'unsupported-message-type-with-at' }
  }
  const mentionsSelf = message.atMentions.includes(selfOpenId)
  if (mentionsSelf) {
    // A direct self-mention decides, even when the same message also @all.
    // Forward-looking message types may carry nested @ in their payload; the
    // top-level evidence alone is not enough to submit them.
    return message.msgType !== null && VERIFIED_TYPES.has(message.msgType)
      ? { kind: 'event', evidence: 'yzj-param-desc-at' }
      : { kind: 'unknown', code: 'unsupported-message-type-with-at' }
  }
  const atAllOnly = message.atMentions.every(target => target === 'all')
  return {
    kind: 'skip',
    reason: atAllOnly && message.atMentions.length > 0 ? 'at-all-only' : 'no-direct-at-evidence',
  }
}
