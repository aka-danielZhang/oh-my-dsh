/**
 * Shared case helpers: session-event readers over the journal, structural
 * check builders, and the synthetic trigger envelopes used by ingest steps.
 *
 * @module dsh-quno/evals/cases/support
 */

import type { SessionEventLike } from '../../src/core/model.ts'
import type { EvalRuntime } from '../runtime.ts'
import type { ChainCheck, SemanticItem } from '../case.ts'
import type { StageName } from '../trace.ts'

export const MAIN_SESSION = 'quno-main'

/** Durable session events for one session (executor sessions: `quno-exec-<ticketId>`). */
export function sessionEvents(rt: EvalRuntime, sessionId: string): readonly SessionEventLike[] {
  return rt.options.persistence.readAll(sessionId)
}

/** Assistant reply texts in one session, in order. */
export function assistantTexts(rt: EvalRuntime, sessionId: string): readonly string[] {
  return sessionEvents(rt, sessionId)
    .filter(event => event.type === 'assistant/message')
    .map(event => event.data as { message?: { content?: readonly { type?: string; text?: string }[] } })
    .map(message => (message.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
    .filter(text => text !== '')
}

/** Tool calls (name + parsed arguments) observed in one session. */
export function toolCalls(rt: EvalRuntime, sessionId: string): readonly { readonly name: string; readonly args: unknown }[] {
  return sessionEvents(rt, sessionId)
    .filter(event => event.type === 'tool/call')
    .map(event => {
      const data = event.data as { name?: string; arguments?: unknown }
      // The session log stores tool arguments as a JSON string.
      let args: unknown = data.arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args) as unknown
        } catch {
          args = {}
        }
      }
      return { name: data.name ?? '', args }
    })
}

/** Tool result texts observed in one session. */
export function toolResults(rt: EvalRuntime, sessionId: string): readonly string[] {
  return sessionEvents(rt, sessionId)
    .filter(event => event.type === 'tool/result')
    .map(event => event.data as { message?: { content?: readonly { type?: string; text?: string }[] } })
    .map(message => (message.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join(''))
}

/** Executor session id for a ticket (stable, per Executor contract). */
export function executorSessionFor(ticketId: string): string {
  return `quno-exec-${ticketId}`
}

/** Build one structural check. */
export function check(
  stage: StageName,
  name: string,
  pass: boolean,
  expected?: unknown,
  actual?: unknown,
  evidence?: readonly string[],
): ChainCheck {
  return {
    stage,
    name,
    pass,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }),
    ...(evidence === undefined ? {} : { evidence }),
  }
}

/** Build one semantic must-item. */
export function semantic(
  id: string,
  kind: SemanticItem['kind'],
  description: string,
  pass: boolean,
  evidence?: string,
): SemanticItem {
  return { id, kind, description, pass, ...(evidence === undefined ? {} : { evidence }) }
}

/** A must-fact over the union of the main conversation's assistant replies. */
export function replyContainsFact(id: string, needle: string, rt: EvalRuntime): SemanticItem {
  const texts = assistantTexts(rt, MAIN_SESSION).join('\n')
  return semantic(id, 'fact', `回复必须包含事实「${needle}」`, texts.includes(needle), texts.slice(0, 600))
}

/** A must-not-claim over the assistant replies. */
export function replyMustNotClaim(id: string, needle: string, rt: EvalRuntime): SemanticItem {
  const texts = assistantTexts(rt, MAIN_SESSION).join('\n')
  return semantic(id, 'no-claim', `回复不得声称「${needle}」`, !texts.includes(needle), texts.slice(0, 300))
}

/** One synthetic IM mention envelope (human, addressed). */
export function imMention(eventKey: string, text: string, at: number): Partial<import('../../src/types.ts').EventEnvelope> & { eventKey: string; type: string } {
  return {
    eventKey,
    type: 'im.message.created',
    schema: 'quno.eval/v1',
    subject: { key: 'eval-conv-1', label: '评测会话' },
    occurredAt: new Date(at).toISOString(),
    summary: text,
    data: { text },
    actor: { source: 'im', id: 'user-42' },
    human: true,
    addressed: 'mention',
    priority: 'p1',
  }
}

/** One synthetic bot (non-human) event. */
export function botEvent(eventKey: string, summary: string, at: number): Partial<import('../../src/types.ts').EventEnvelope> & { eventKey: string; type: string } {
  return {
    eventKey,
    type: 'ci.pipeline.finished',
    schema: 'quno.eval/v1',
    subject: { key: `ci-${eventKey}`, label: 'CI' },
    occurredAt: new Date(at).toISOString(),
    summary,
    data: { summary },
    actor: { source: 'ci', id: 'bot-7' },
    human: false,
    addressed: null,
    priority: 'p2',
  }
}
