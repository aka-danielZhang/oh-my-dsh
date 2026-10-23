/**
 * The unified delivery channel: proactive reports and delegated-task results
 * share one outbox, one dedupe key, one quiet-hours policy and one
 * reconciliation path (design §5.1, §10.2).
 *
 * Delivery states: pending → prepared → inbox-durable → presented, with
 * suppressed / superseded / expired / uncertain / retryable-failure /
 * delivery-blocked as honest terminal or recoverable outcomes. The message
 * identity is persisted BEFORE `followup`, so every crash window is decidable
 * by id presence in the main conversation's durable log.
 *
 * @module dsh-quno/outbox
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { QunoStore } from './store.ts'
import type { NoticeRecord, QunoConfig, QunoRecord } from './types.ts'
import { backoffMs, nextQuietEnd } from './util.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A Host-composed proactive report or task result for the Quno main conversation. */
    'quno-notify': {
      readonly kind: 'quno-notify'
      readonly form: 'notice'
      readonly summary: string
      readonly notificationId: string
      readonly topicKey: string
    }
    /** A delegated background task's settled result flowing back into the main conversation. */
    'quno-task': {
      readonly kind: 'quno-task'
      readonly form: 'notice'
      readonly summary: string
      readonly notificationId: string
      readonly topicKey: string
      readonly taskId: string
    }
  }
}

/** The durable main conversation, as the delivery layer sees it. */
export interface MainConversationFace {
  sessionId(): string | null
  state(): QunoRecord['mainSessionState']
  /** Exact live Agent, if the conversation is currently resident. */
  live(): Agent | undefined
  /** Cold-resume the conversation through the session controller. */
  resolve(): Promise<Agent | undefined>
  /** Durability barrier for the conversation log. */
  flush(agent: Agent): Promise<boolean>
  /** Record a broken binding (UI shows it; nothing silently re-creates it). */
  markState(state: QunoRecord['mainSessionState']): void
}

/** Minimal readable session event shape used by reconciliation. */
export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** Read-only history access for reconciliation (sessionQuery). */
export interface HistoryReader {
  readSession(sessionId: string): Promise<{ readonly events: readonly SessionEventLike[] }>
}

/** Outbox dependencies. */
export interface OutboxDeps {
  readonly store: QunoStore
  readonly qunoId: string
  readonly main: MainConversationFace
  readonly history?: HistoryReader
  readonly logger: { warn: (message: string) => void; info?: (message: string) => void }
  readonly now?: () => number
  /** Notified after a notice reaches a durable-ish state (UI refresh). */
  readonly onChange?: () => void
}

/** A notice waiting for presentation evidence. */
interface AwaitingPresentation {
  readonly noticeId: string
  acceptedSeq: number | null
}

/** One delivery attempt summary, exposed for diagnostics/tests. */
export interface DeliveryAttemptResult {
  readonly noticeId: string
  readonly status: NoticeRecord['status']
  readonly messageId: string | null
  readonly reason: string | null
}

/** Single-flight outbox deliverer. */
export class Outbox {
  private kicking: Promise<void> | undefined
  private readonly awaiting = new Map<string, AwaitingPresentation>()
  private readonly now: () => number

  constructor(private readonly deps: OutboxDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Deliver every currently eligible notice, in FIFO order, one at a time. */
  async kick(): Promise<void> {
    if (this.kicking !== undefined) return this.kicking
    this.kicking = this.drain().finally(() => {
      this.kicking = undefined
    })
    return this.kicking
  }

  private async drain(): Promise<void> {
    const now = this.now()
    this.deps.store.expireNotices(now)
    const quno = this.deps.store.getQuno(this.deps.qunoId)
    if (quno === undefined) return
    if (!quno.config.enabled) return
    const ready = this.deps.store.listReadyNotices(now, 10)
    for (const notice of ready) {
      try {
        await this.deliverOne(notice, quno.config, now)
      } catch (error) {
        this.deps.logger.warn(`dsh-quno: notice delivery crashed: ${(error as Error).message}`)
      }
    }
  }

  /**
   * Attempt one notice. Exposed for tests and the UI's explicit retry.
   * @param noticeId - durable notice identity.
   */
  async deliver(noticeId: string): Promise<DeliveryAttemptResult> {
    const notice = this.deps.store.getNotice(noticeId)
    const quno = this.deps.store.getQuno(this.deps.qunoId)
    if (quno === undefined) throw new Error('quno row vanished')
    return await this.deliverOne(notice, quno.config, this.now())
  }

  private async deliverOne(notice: NoticeRecord, config: QunoConfig, now: number): Promise<DeliveryAttemptResult> {
    const store = this.deps.store
    if (notice.status !== 'pending' && notice.status !== 'retryable-failure') {
      return { noticeId: notice.id, status: notice.status, messageId: notice.messageId, reason: notice.reason }
    }
    if (notice.expiresAt !== null && notice.expiresAt < now) {
      store.transitionNotice(notice.id, ['pending', 'retryable-failure'], { status: 'expired', reason: 'notice expired', now })
      this.changed()
      return { noticeId: notice.id, status: 'expired', messageId: notice.messageId, reason: 'notice expired' }
    }

    const quno = store.getQuno(this.deps.qunoId)
    const mutedUntil = quno?.mutedUntil ?? null
    if (mutedUntil !== null && mutedUntil > now) {
      store.transitionNotice(notice.id, ['pending', 'retryable-failure'], {
        status: 'pending',
        reason: 'muted',
        eligibleAt: mutedUntil,
        now,
      })
      this.changed()
      return { noticeId: notice.id, status: 'pending', messageId: notice.messageId, reason: 'muted' }
    }

    const quiet = this.quietWindow(config, notice, now)
    if (quiet !== null) {
      store.transitionNotice(notice.id, ['pending', 'retryable-failure'], {
        status: 'pending',
        reason: 'quiet-hours hold',
        eligibleAt: quiet,
        now,
      })
      if (notice.topicKey !== '' && quiet > now) {
        store.mergePendingNotices(notice.qunoId, notice.topicKey, notice.id, now)
      }
      this.changed()
      return { noticeId: notice.id, status: 'pending', messageId: notice.messageId, reason: 'quiet-hours hold' }
    }

    const rate = this.rateLimit(config, now)
    if (rate !== null) {
      store.transitionNotice(notice.id, ['pending', 'retryable-failure'], {
        status: 'pending',
        reason: 'notification budget',
        eligibleAt: rate,
        now,
      })
      this.changed()
      return { noticeId: notice.id, status: 'pending', messageId: notice.messageId, reason: 'notification budget' }
    }

    const freshness = this.freshness(notice, now)
    if (freshness !== null) {
      store.transitionNotice(notice.id, ['pending', 'retryable-failure'], {
        status: 'suppressed',
        reason: freshness,
        now,
      })
      this.attempt(notice, 'suppressed', freshness, notice.messageId, now)
      this.changed()
      return { noticeId: notice.id, status: 'suppressed', messageId: notice.messageId, reason: freshness }
    }

    if (notice.status === 'retryable-failure' && notice.attempts >= 3) {
      store.transitionNotice(notice.id, ['retryable-failure'], {
        status: 'delivery-blocked',
        reason: 'notice delivery failed three times',
        now,
      })
      this.changed()
      return { noticeId: notice.id, status: 'delivery-blocked', messageId: notice.messageId, reason: 'attempts exhausted' }
    }

    const state = this.deps.main.state()
    const sessionId = this.deps.main.sessionId()
    if (sessionId === null || state === 'unbound' || state === 'missing') {
      store.transitionNotice(notice.id, ['pending', 'retryable-failure'], {
        status: 'delivery-blocked',
        reason: state === 'missing' ? 'main conversation is missing' : 'main conversation is not bound',
        now,
      })
      this.changed()
      return {
        noticeId: notice.id,
        status: 'delivery-blocked',
        messageId: notice.messageId,
        reason: 'main conversation is not bound',
      }
    }

    // Durability checkpoint: the concrete message identity is persisted BEFORE
    // the inbox mutation, so a crash is decidable by presence in the log.
    const baseSource = {
      form: 'notice' as const,
      summary: notice.payload.summary,
      notificationId: notice.id,
      topicKey: notice.topicKey,
    }
    const source = notice.kind === 'task' && notice.payload.taskId !== undefined
      ? { kind: 'quno-task' as const, ...baseSource, taskId: notice.payload.taskId }
      : { kind: 'quno-notify' as const, ...baseSource }
    const message = createUserMessage({
      content: [{ type: 'text', text: renderNoticeMessage(notice) }],
      source,
    })
    const attempt = notice.attempts + 1
    const prepared = store.transitionNotice(notice.id, ['pending', 'retryable-failure'], {
      status: 'prepared',
      reason: null,
      messageId: message.id,
      attempts: attempt,
      now,
    })
    if (!prepared) {
      return { noticeId: notice.id, status: store.getNotice(notice.id).status, messageId: message.id, reason: 'state changed' }
    }
    this.attempt(notice, 'prepared', null, message.id, now)
    this.changed()

    let agent = this.deps.main.live()
    if (agent === undefined) {
      agent = await this.deps.main.resolve().catch((error: unknown) => {
        this.deps.logger.warn(`dsh-quno: main conversation resume failed: ${(error as Error).message}`)
        return undefined
      })
    }
    if (agent === undefined) {
      store.transitionNotice(notice.id, ['prepared'], {
        status: 'delivery-blocked',
        reason: 'main conversation could not be resumed',
        now,
      })
      this.deps.main.markState('delivery-blocked')
      this.changed()
      return { noticeId: notice.id, status: 'delivery-blocked', messageId: message.id, reason: 'resume failed' }
    }

    try {
      agent.followup(message as unknown as UserMessage)
    } catch (error) {
      const reason = `followup failed: ${(error as Error).message}`
      store.transitionNotice(notice.id, ['prepared'], {
        status: 'retryable-failure',
        reason,
        eligibleAt: now + backoffMs(attempt),
        now,
      })
      this.attempt(notice, 'retryable-failure', reason, message.id, now)
      this.changed()
      return { noticeId: notice.id, status: 'retryable-failure', messageId: message.id, reason }
    }

    let flushed = false
    try {
      flushed = await this.deps.main.flush(agent)
    } catch (error) {
      store.transitionNotice(notice.id, ['prepared'], {
        status: 'uncertain',
        reason: `flush failed: ${(error as Error).message}`,
        now,
      })
      this.attempt(notice, 'uncertain', 'flush failed', message.id, now)
      this.changed()
      return { noticeId: notice.id, status: 'uncertain', messageId: message.id, reason: 'flush failed' }
    }
    if (!flushed) {
      // The message is in the in-memory inbox but not durable yet. It may still
      // land; reconciliation decides, never a timeout.
      store.transitionNotice(notice.id, ['prepared'], { status: 'uncertain', reason: 'flush not confirmed', now })
      this.attempt(notice, 'uncertain', 'flush not confirmed', message.id, now)
      this.changed()
      return { noticeId: notice.id, status: 'uncertain', messageId: message.id, reason: 'flush not confirmed' }
    }

    store.transitionNotice(notice.id, ['prepared'], { status: 'inbox-durable', reason: null, now })
    this.attempt(notice, 'inbox-durable', null, message.id, now)
    this.awaiting.set(message.id, { noticeId: notice.id, acceptedSeq: null })
    this.changed()
    return { noticeId: notice.id, status: 'inbox-durable', messageId: message.id, reason: null }
  }

  /**
   * Watch one live session event for presentation evidence. The Host forwards
   * every main-session event here; unknown sessions are ignored.
   */
  observe(sessionId: string, event: SessionEventLike): void {
    if (this.deps.main.sessionId() !== sessionId) return
    if (event.type === 'user/message') {
      const message = event.data as { id?: unknown } | undefined
      const id = typeof message?.id === 'string' ? message.id : undefined
      if (id === undefined) return
      const awaiting = this.awaiting.get(id)
      if (awaiting === undefined) return
      awaiting.acceptedSeq = event.seq
      return
    }
    if (event.type !== 'assistant/message') return
    const now = this.now()
    for (const [messageId, awaiting] of this.awaiting) {
      if (awaiting.acceptedSeq === null || event.seq <= awaiting.acceptedSeq) continue
      const notice = this.deps.store.getNotice(awaiting.noticeId)
      if (notice.status === 'inbox-durable') {
        this.deps.store.transitionNotice(notice.id, ['inbox-durable'], { status: 'presented', reason: null, now })
        this.attempt(notice, 'presented', null, messageId, now)
        this.changed()
      }
      this.awaiting.delete(messageId)
    }
  }

  /**
   * Reconcile unsettled notices against the durable log. Runs at boot and on
   * demand (UI "重新检查"). A reliably absent message id means the inbox
   * mutation never happened, so re-delivery is safe; a present id is never
   * re-sent.
   */
  async reconcile(): Promise<{ presented: number; redelivered: number; blocked: number }> {
    const store = this.deps.store
    const now = this.now()
    const sessionId = this.deps.main.sessionId()
    if (sessionId === null || this.deps.history === undefined) return { presented: 0, redelivered: 0, blocked: 0 }
    let events: readonly SessionEventLike[]
    try {
      events = (await this.deps.history.readSession(sessionId)).events
    } catch (error) {
      this.deps.logger.warn(`dsh-quno: outbox reconciliation read failed: ${(error as Error).message}`)
      return { presented: 0, redelivered: 0, blocked: 0 }
    }
    const messageSeq = new Map<string, number>()
    const assistantSeqs: number[] = []
    for (const event of events) {
      if (event.type === 'user/message') {
        const data = event.data as { id?: unknown } | undefined
        if (typeof data?.id === 'string') messageSeq.set(data.id, event.seq)
      } else if (event.type === 'assistant/message') {
        assistantSeqs.push(event.seq)
      }
    }
    let presented = 0
    let redelivered = 0
    let blocked = 0
    for (const notice of store.listUnsettledNotices(this.deps.qunoId)) {
      if (notice.messageId === null) {
        if (notice.status === 'prepared') {
          // Prepared without a message id cannot happen; fail honest.
          store.transitionNotice(notice.id, ['prepared'], { status: 'delivery-blocked', reason: 'missing message id', now })
          blocked += 1
        }
        continue
      }
      const acceptedAt = messageSeq.get(notice.messageId)
      if (acceptedAt !== undefined) {
        const answered = assistantSeqs.some(seq => seq > acceptedAt)
        if (answered) {
          store.transitionNotice(notice.id, ['inbox-durable', 'uncertain', 'retryable-failure', 'prepared'], {
            status: 'presented',
            reason: null,
            now,
          })
          this.attempt(notice, 'presented', null, notice.messageId, now)
          presented += 1
        } else if (notice.status === 'uncertain') {
          store.transitionNotice(notice.id, ['uncertain'], { status: 'inbox-durable', reason: 'reconciled present', now })
        }
        this.awaiting.delete(notice.messageId)
        continue
      }
      // Reliably absent from a complete log.
      if (notice.status === 'uncertain' || notice.status === 'prepared') {
        store.transitionNotice(notice.id, [notice.status], {
          status: 'pending',
          reason: 'reconciled absent; safe to redeliver',
          messageId: null,
          eligibleAt: now,
          now,
        })
        store.bumpNoticeMessageVersion(notice.id, now)
        redelivered += 1
      } else if (notice.status === 'inbox-durable' || notice.status === 'retryable-failure') {
        // The log says it never arrived but the record says it did: do not
        // silently send a second copy.
        store.transitionNotice(notice.id, [notice.status], {
          status: 'delivery-blocked',
          reason: 'durable record exists but the message is absent from the conversation log',
          now,
        })
        blocked += 1
      }
    }
    this.changed()
    return { presented, redelivered, blocked }
  }

  private quietWindow(config: QunoConfig, notice: NoticeRecord, now: number): number | null {
    if (config.quietHours === null) return null
    const policy = config.notificationPolicy
    if (notice.payload.urgent === true && policy.allowUrgentWake && policy.urgentMayBreakQuietHours) return null
    const end = nextQuietEnd(config, now)
    return end > now ? end : null
  }

  private rateLimit(config: QunoConfig, now: number): number | null {
    const policy = config.notificationPolicy
    const store = this.deps.store
    const hourAgo = now - 60 * 60_000
    if (store.countDeliveredNoticesSince(this.deps.qunoId, hourAgo) >= policy.maxPerHour) return now + 10 * 60_000
    const last = store.lastNoticeAt(this.deps.qunoId)
    if (last !== null && last + policy.minGapSec * 1000 > now) return last + policy.minGapSec * 1000
    return null
  }

  private freshness(notice: NoticeRecord, now: number): string | null {
    const store = this.deps.store
    if (store.hasRecentFeedback(this.deps.qunoId, notice.topicKey, now - 5 * 60_000)) return 'user-just-acted'
    for (const itemId of notice.payload.itemIds ?? []) {
      const item = store.getAttentionItem(itemId)
      if (item === undefined) continue
      if (item.status === 'resolved' || item.status === 'dismissed' || item.status === 'expired') {
        return 'attention-item-settled'
      }
    }
    return null
  }

  private attempt(notice: NoticeRecord, status: NoticeRecord['status'], reason: string | null, messageId: string | null, now: number): void {
    this.deps.store.appendNoticeAttempt({
      notificationId: notice.id,
      attempt: notice.attempts + 1,
      status,
      reason,
      messageId,
      now,
    })
  }

  private changed(): void {
    this.deps.onChange?.()
  }
}

/** The exact user-visible text of one notice (deterministic; not model-rendered). */
export function renderNoticeMessage(notice: NoticeRecord): string {
  const headline = notice.kind === 'task' ? 'Quno 任务完成' : 'Quno 主动汇报'
  return `【${headline}】${notice.payload.title}\n\n${notice.payload.body}`
}

/** Build the message source metadata for tests that inspect injected messages. */
export function noticeMessageFor(notice: NoticeRecord): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: renderNoticeMessage(notice) }],
    source: {
      kind: 'quno-notify',
      form: 'notice',
      summary: notice.payload.summary,
      notificationId: notice.id,
      topicKey: notice.topicKey,
    },
  }) as unknown as UserMessage
}

/** Branded message id helper for tests. */
export function asMessageId(value: string): MessageId {
  return value as MessageId
}
