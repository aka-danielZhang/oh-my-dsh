/**
 * SessionTransport: the one way Quno puts a message into a live Agent.
 *
 * The transport owns three things the domain must not care about:
 *
 * - the delivery mode (`queue` = followup, `steer` = nearest step,
 *   `inject` = passive context that must not wake an idle driver);
 * - a stable message identity `quno:<requestId>`, so a crash between "inbox
 *   accepted" and "durable" is retried without a second copy;
 * - the durability barrier: a message is confirmed only after the session log
 *   flush succeeded.
 *
 * Message content and identity are separate proofs: the same request id with
 * the same text is an idempotent replay, the same request id with different
 * text is an identity conflict, never an overwrite.
 *
 * @module dsh-quno/app/transport
 */

import { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { QunoConflictError } from '../core/model.ts'
import type { DeliveryMode, SessionEventLike } from '../core/model.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** One Eval candidate (relay) delivered to the permanent conversation. */
    'quno-eval': {
      readonly kind: 'quno-eval'
      readonly form: 'relay'
      readonly summary: string
      readonly evalId: string
      readonly threadId: string
    }
    /** One Worker Report relayed to the permanent conversation. */
    'quno-report': {
      readonly kind: 'quno-report'
      readonly form: 'relay'
      readonly summary: string
      readonly ticketId: string
      readonly assignmentId: string
    }
    /** One TicketInput delivered to an executor session. */
    'quno-input': {
      readonly kind: 'quno-input'
      readonly form: 'relay' | 'notice'
      readonly summary: string
      readonly ticketId: string
      readonly runId?: string
    }
    /** The bounded assignment prompt that starts one WorkerRun. */
    'quno-worker-prompt': {
      readonly kind: 'quno-worker-prompt'
      readonly form: 'relay'
      readonly summary: string
      readonly ticketId: string
      readonly runId?: string
    }
  }
}

/** What the caller asks the transport to deliver. */
export interface TransportSendInput {
  readonly requestId: string
  readonly text: string
  readonly mode: DeliveryMode
  readonly source: {
    readonly kind: string
    readonly form: 'relay' | 'notice'
    readonly summary: string
    readonly runId?: string
    readonly evalId?: string
    readonly threadId?: string
    readonly ticketId?: string
    readonly assignmentId?: string
  }
}

/** Structural face of the session durability barrier. */
interface SessionsFace {
  flush(session: Agent['session']): Promise<boolean>
}

/** Structural face of the read-only session query. */
interface SessionQueryFace {
  readSession(id: SessionId): Promise<{ readonly events: readonly SessionEventLike[] }>
}

/** Dependencies of the transport. */
export interface SessionTransportDeps {
  readonly ctx: Context
  readonly logger: { warn(message: string): void; info?(message: string): void }
}

/** The stable wire id of one Quno-originated message. */
export function qunoMessageId(requestId: string): string {
  return `quno:${requestId}`
}

/** Extract the visible text of one user message (used for identity comparison). */
export function userMessageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    return record['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
  }).join('\n')
}

/** Build the identified user message for one request. */
export function buildTransportMessage(input: TransportSendInput): UserMessage {
  const base = createUserMessage({
    content: [{ type: 'text', text: input.text }],
    source: { ...input.source } as never,
  })
  return { ...base, id: MessageId(qunoMessageId(input.requestId)) } as UserMessage
}

/** One delivered message's location. */
type Location = 'durable' | 'inbox' | 'absent'

/** The transport implementation used by the assessor and the executor. */
export class SessionTransport {
  constructor(private readonly deps: SessionTransportDeps) {}

  /** Send one identified message, deduplicating against live inbox and durable log. */
  async send(agent: Agent, input: TransportSendInput, authorize: () => void): Promise<void> {
    const id = qunoMessageId(input.requestId)
    const text = input.text
    const location = await this.locate(agent, id, text)
    if (location === 'durable') return
    if (location === 'inbox') {
      // Accepted into the live inbox but not yet durable: re-attempt the
      // barrier instead of sending a second copy.
      const flushed = await this.flush(agent)
      if (!flushed) throw new Error(`message ${id} is in the live inbox but its flush was not confirmed`)
      return
    }
    const message = buildTransportMessage(input)
    authorize()
    switch (input.mode) {
      case 'queue':
        agent.followup(message)
        break
      case 'steer':
        agent.steer(message)
        break
      case 'inject':
        agent.inject(message)
        break
    }
    const flushed = await this.flush(agent)
    if (!flushed) throw new Error(`message ${id} was accepted into the inbox but its flush was not confirmed`)
  }

  /** Barrier: force the session log to disk. */
  async flush(agent: Agent): Promise<boolean> {
    const sessions = this.deps.ctx.get('sessions') as unknown as SessionsFace | undefined
    if (sessions === undefined) return false
    try {
      return await sessions.flush(agent.session)
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: session flush failed: ${(error as Error).message}`)
      return false
    }
  }

  /** Read the durable event log for one live agent. */
  async readSession(agent: Agent): Promise<readonly SessionEventLike[]> {
    const sessionQuery = this.deps.ctx.get('sessionQuery') as unknown as SessionQueryFace | undefined
    if (sessionQuery === undefined) return agent.session.snapshotEvents()
    const snapshot = await sessionQuery.readSession(agent.session.id as SessionId)
    return snapshot.events
  }

  /**
   * Locate one identity: durable log first (authoritative), then the live
   * inbox (accepted but not yet durable). Same id with different content is an
   * identity conflict in both places.
   */
  async locate(agent: Agent, id: string, text: string): Promise<Location> {
    const events = await this.readSession(agent).catch(() => [] as readonly SessionEventLike[])
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined || event.type !== 'user/message') continue
      const data = event.data as { id?: unknown } | undefined
      if (data?.id !== id) continue
      const existing = userMessageText(data)
      if (existing !== text) {
        throw new QunoConflictError('message-identity-conflict', `message ${id} already exists with different content`)
      }
      return 'durable'
    }
    for (const pending of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
      if (pending.id !== id) continue
      if (userMessageText(pending) !== text) {
        throw new QunoConflictError('message-identity-conflict', `message ${id} already exists with different content`)
      }
      return 'inbox'
    }
    return 'absent'
  }
}
