/**
 * The Quno domain vocabulary: what a Trigger, Thread, Eval, Decision, Mandate,
 * Ticket, Assignment, WorkerRun, Input, Report, Exchange and Effect are, and
 * the pure predicates that decide how they relate.
 *
 * This module is deliberately I/O free. The Engine owns every state
 * transition; this file owns the shape of the state and the rules that are
 * only a function of the values passed in, so the same rules are used by the
 * SQLite repository, the in-memory repository and the UI projections.
 *
 * @module dsh-quno/core/model
 */

/** One Quno instance. v1 provisions exactly one (`quno`). */
export type QunoId = string
/** One immutable source event. */
export type TriggerId = string
/** One time-ordered event stream. */
export type ThreadId = string
/** One authorized unit of continuing work. */
export type TicketId = string
/** Ticket ↔ executor-instance binding. */
export type AssignmentId = string
/** One bounded execution turn inside an Assignment. */
export type RunId = string
/** One asynchronous paired exchange. */
export type ExchangeId = string
/** A durable logical endpoint (`quno:<id>/router`, `ticket:<id>`, `collector:<id>`). */
export type EndpointId = string
/** Stable identity of one eval batch. */
export type EvalId = string
/** Stable identity of one decided outcome. */
export type DecisionId = string
/** Stable identity of one TicketInput. */
export type InputId = string
/** Stable identity of one Worker Report relay. */
export type ReportId = string
/** Stable identity of one notification candidate. */
export type NotificationId = string

/** How a piece of content can be re-read instead of copied into the prompt. */
export type ContentRef =
  | { readonly kind: 'session-message'; readonly sessionId: string; readonly messageId: string }
  | { readonly kind: 'session-seq'; readonly sessionId: string; readonly seq: number }
  | { readonly kind: 'quno-event'; readonly eventId: string }
  | { readonly kind: 'blob'; readonly ref: string; readonly sha256?: string }

/** Producer identity carried by every cross-component message. */
export interface MessageMeta {
  readonly id: string
  readonly qunoId: QunoId
  readonly producerEndpoint: EndpointId
  readonly occurredAt: number | null
  readonly receivedAt: number
  readonly summary: string | null
  readonly contentRef: ContentRef | null
  readonly causationId: string | null
  readonly correlationKeys: readonly string[]
  readonly configRevision: number
}

/** Who produced the source event. */
export interface ActorRef {
  readonly source: string
  readonly id: string
}

/** One source-owned thread identity. */
export interface ThreadRef {
  readonly source: string
  readonly id: string
}

/** A durable external write address owned by a Source. */
export interface ChannelRef {
  readonly source: string
  readonly thread: string
  readonly address: Record<string, string>
}

/** Source event operation. A retraction is a new Trigger, never a deletion. */
export type EventOperation = 'upsert' | 'delete' | 'retract'

/** Source-suggested priority. The effective priority is Quno policy. */
export type SuggestedPriority = 'p0' | 'p1' | 'p2' | 'p3'

/** Observed or derived provenance of a Trigger. */
export type Provenance =
  | { readonly kind: 'observed'; readonly collector?: string }
  | {
    readonly kind: 'derived'
    readonly inputs: readonly { readonly eventId?: TriggerId; readonly eventKey?: string }[]
    readonly processor: string
    readonly coverage: string
    readonly confidence?: number
    readonly window?: { readonly from: number | null; readonly to: number | null }
  }

/**
 * One immutable Trigger: the only domain event a Source/Organ produces.
 * Worker Reports, TicketInputs, Effects, Notifications, Exchange messages and
 * Channel messages are NOT Triggers; they have their own state machines.
 */
export interface TriggerRecord {
  readonly id: TriggerId
  readonly qunoId: QunoId
  readonly sourceId: string
  readonly eventKey: string
  readonly type: string
  readonly schema: string

  /** First entry is the primary Thread (it owns the Eval); the rest only add correlation context. */
  readonly threads: readonly ThreadRef[]
  readonly actor: ActorRef
  readonly human: boolean
  readonly addressed: 'mention' | 'direct' | null

  readonly occurredAt: number | null
  readonly observedAt: number
  readonly receivedAt: number
  readonly summary: string | null
  readonly data: unknown
  readonly contentRef: ContentRef | null
  readonly channel: ChannelRef | null

  readonly operation: EventOperation
  readonly priority: SuggestedPriority
  readonly deadline: number | null
  readonly correlationKeys: readonly string[]
  readonly supersedesTriggerIds: readonly TriggerId[]
  readonly parentTriggerIds: readonly TriggerId[]
  readonly provenance: Provenance
  readonly contentHash: string
  readonly configRevision: number
  readonly expiresAt: number | null
  readonly prunedAt: number | null
}

/** What an Organ declares it can do beyond producing Triggers. */
export type ThreadResolution =
  | { readonly status: 'resolved'; readonly threads: readonly ThreadRef[] }
  | { readonly status: 'unresolved'; readonly reason: string }

/** The optional context/read capabilities of one Organ implementation. */
export interface QueryCapabilities {
  resolveThreads?(event: ParsedEventEnvelope): ThreadResolution
  readOriginal?(request: {
    readonly triggerId: TriggerId
    readonly part: 'self' | 'thread' | 'root' | 'parent'
    readonly cursor: string | null
    readonly signal: AbortSignal
  }): Promise<{
    readonly items: readonly unknown[]
    readonly nextCursor: string | null
    readonly truncated: boolean
  }>
  handleRequest?(request: {
    readonly exchangeId: ExchangeId
    readonly endpoint: EndpointId
    readonly payload: unknown
    readonly signal: AbortSignal
    completeExchange(result: unknown): Promise<void>
    failExchange(reason: string, retryable: boolean): Promise<void>
  }): Promise<void> | void
  handleCommand?(request: {
    readonly exchangeId: ExchangeId
    readonly endpoint: EndpointId
    readonly payload: unknown
    readonly signal: AbortSignal
    completeExchange(result: unknown): Promise<void>
    failExchange(reason: string, retryable: boolean): Promise<void>
  }): Promise<void> | void
}

/** The envelope a Source adapter hands the Engine before it becomes a Trigger. */
export interface ParsedEventEnvelope {
  readonly eventKey: string
  readonly type: string
  readonly schema?: string
  readonly operation?: EventOperation
  readonly occurredAt?: string | null
  readonly observedAt?: string
  readonly summary?: string
  readonly data?: unknown
  readonly priority?: SuggestedPriority
  readonly deadline?: string | null
  readonly provenance?: Provenance
  readonly correlationKeys?: readonly string[]
  readonly supersedesEventIds?: readonly TriggerId[]
  readonly parentEventIds?: readonly TriggerId[]
  readonly expiresAt?: string | null
}

/** One time-ordered stream of source events. */
export interface ThreadRecord {
  readonly id: ThreadId
  readonly qunoId: QunoId
  readonly sourceId: string
  readonly threadKey: string
  readonly label: string | null
  readonly lastAt: number | null
  readonly correlatedThreadIds: readonly ThreadId[]
  readonly pendingTriggerIds: readonly TriggerId[]
  readonly activeEvalId: EvalId | null
  readonly expiredCount: number
  readonly meta: Record<string, unknown>
  readonly closed: { readonly at: number; readonly outcome: string } | null
}

/** How a ticket relates to a thread. */
export type SubscriptionMode = 'owned' | 'context'
/** Why a subscription exists. */
export type SubscriptionOrigin = 'eval' | 'source' | 'executor'

/** One Ticket ↔ Thread subscription. */
export interface SubscriptionRecord {
  readonly id: string
  readonly qunoId: QunoId
  readonly ticketId: TicketId
  readonly threadId: ThreadId
  readonly mode: SubscriptionMode
  readonly origin: SubscriptionOrigin
  readonly startIngestSeq: number
  readonly revision: number
  readonly cancelledAt: number | null
  readonly createdAt: number
}

/** Automatic work admission mode. */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** How strong the authorization evidence is. */
export type Strength = 'explicit' | 'inferred'

/** The immutable authorization attached to one accepted Ticket. */
export interface Mandate {
  readonly strength: Strength
  readonly policyVersion: string
  readonly scope: string
  readonly actor: ActorRef
  readonly basis: {
    readonly via: 'direct' | 'addressed' | 'followup' | 'admission' | 'rule' | 'bot'
    readonly sourceId: string | null
    readonly scope: Record<string, unknown>
    readonly matchedRuleIds: readonly string[]
  }
  readonly permissionPreset: 'quno-task'
}

/** One gate judgement for one Trigger on one Thread. */
export interface GateResult {
  readonly admissible: boolean
  readonly strength: Strength
  readonly basis: Mandate['basis'] | null
  readonly reason: string | null
}

/** A deterministic filter over a Source's own scope. */
export interface ScopeFilterResult {
  readonly filtered: boolean
  readonly reason: string | null
}

/** The current admission rules, snapshotted so an Eval cannot change mid-flight. */
export interface PolicySnapshot {
  readonly version: string
  readonly paused: boolean
  readonly acceptMode: AcceptMode
  readonly evalTimeoutMs: number
  gate(trigger: TriggerRecord, thread: ThreadRecord, tickets: readonly TicketRecord[]): GateResult
  revalidate(mandate: Mandate): { readonly valid: boolean; readonly reason: string | null }
  admitsInferred(ruleIds: readonly string[]): boolean
}

/** Lifecycle of one eval batch. */
export type EvalStatus = 'delivering' | 'waiting-decision' | 'decided' | 'unavailable'

/** What the Router decided. */
export type DecisionKind = 'accept' | 'stop' | 'ignore' | 'unavailable'

/** One Eval: a batch of Triggers on one primary Thread, judged once. */
export interface EvalRecord {
  readonly id: EvalId
  readonly qunoId: QunoId
  readonly threadId: ThreadId
  readonly triggerIds: readonly TriggerId[]
  readonly primaryTriggerId: TriggerId
  readonly strength: Strength
  readonly basis: Mandate['basis']
  readonly policyVersion: string
  readonly status: EvalStatus
  readonly candidateMessageId: string | null
  readonly startedAt: number
  readonly deliveredAt: number | null
  readonly deadline: number
  readonly pausedAt: number | null
  readonly expiryCount: number
}

/** One audited decision. */
export interface DecisionRecord {
  readonly id: DecisionId
  readonly qunoId: QunoId
  readonly evalId: EvalId | null
  readonly threadId: ThreadId | null
  readonly triggerIds: readonly TriggerId[]
  readonly kind: DecisionKind
  readonly strength: Strength
  readonly reason: string | null
  readonly policyVersion: string
  readonly ticketId: TicketId | null
  readonly mandate: Mandate | null
  readonly audit: Record<string, unknown>
  readonly createdAt: number
}

/** One question a Ticket is waiting for a human to answer. */
export interface TicketQuestion {
  readonly id: string
  readonly question: string
  readonly triggerId: TriggerId | null
  readonly createdAt: number
}

/** Ticket end reasons. */
export type TicketEndedBy = 'human' | 'executor' | 'source' | 'host'
export type TicketOutcome = 'completed' | 'failed' | 'dropped' | 'stopped' | 'closed'

/** One authorized unit of continuing work. */
export interface TicketRecord {
  readonly id: TicketId
  readonly qunoId: QunoId
  readonly title: string
  readonly goal: string
  readonly decisionId: DecisionId | null
  readonly mandate: Mandate
  readonly origin: { readonly triggerId: TriggerId | null; readonly triggerIds: readonly TriggerId[] }
  readonly channels: readonly ChannelRef[]
  readonly mode: 'once' | 'persistent'
  readonly ended: {
    readonly at: number
    readonly by: TicketEndedBy
    readonly outcome: TicketOutcome
    readonly reason: string | null
  } | null
  readonly question: TicketQuestion | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Assignment lifecycle inside one Ticket. */
export type AssignmentState = 'pending' | 'running' | 'ended'

/** What a Worker reports about its current work. */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

/** One artifact a Worker produced. */
export interface TaskArtifact {
  readonly kind: 'file' | 'directory' | 'url' | 'note'
  readonly label: string
  readonly uri: string
}

/** Worker → Router structured report. */
export interface WorkerReport {
  readonly state: ReportState
  readonly summary: string
  readonly at: number
  readonly artifacts: readonly TaskArtifact[]
  readonly question?: { readonly question: string; readonly triggerId?: TriggerId }
  /**
   * Monotonic per-process discriminator. Timestamps alone collide when two
   * reports land in the same millisecond (guaranteed under a coarse or
   * virtual clock), which would fuse two distinct relays into one stable
   * message identity (found by the link evaluator).
   */
  readonly nonce?: number
}

/** Ticket ↔ one executor session instance. */
export interface AssignmentRecord {
  readonly id: AssignmentId
  readonly ticketId: TicketId
  readonly state: AssignmentState
  readonly executorSessionId: string
  readonly directory: string
  readonly report: WorkerReport | null
  readonly deliveredAt: number | null
  readonly idleAt: number | null
  readonly endedReason: string | null
  readonly createdAt: number
}

/** WorkerRun lifecycle. One bounded execution turn inside an Assignment. */
export type WorkerRunStatus = 'prepared' | 'running' | 'ended' | 'failed'

/** One bounded execution turn. */
export interface WorkerRunRecord {
  readonly id: RunId
  readonly qunoId: QunoId
  readonly ticketId: TicketId
  readonly assignmentId: AssignmentId
  readonly status: WorkerRunStatus
  readonly inputIds: readonly InputId[]
  readonly fence: number
  readonly leaseUntil: number | null
  readonly turnId: string | null
  readonly result: Record<string, unknown> | null
  readonly error: { readonly code: string; readonly message: string } | null
  readonly cost: Record<string, unknown> | null
  readonly startedAt: number
  readonly finishedAt: number | null
}

/** What a TicketInput is. */
export type InputKind = 'trigger' | 'policy' | 'note' | 'resume' | 'response' | 'result' | 'text'

/** One unit of work shipped into a Ticket. */
export interface TicketInputRecord {
  readonly id: InputId
  readonly qunoId: QunoId
  readonly ticketId: TicketId
  readonly kind: InputKind
  readonly triggerId: TriggerId | null
  readonly exchangeId: ExchangeId | null
  readonly human: boolean
  readonly context: boolean
  readonly text: string | null
  readonly createdAt: number
  readonly deliveredTo: AssignmentId | null
  readonly deliveredAt: number | null
  readonly readAt: number | null
  /** Set when the Worker acknowledged the input through a Report or a handback. */
  readonly acknowledgedAt: number | null
  /** One Ticket may hand a Trigger back at most once. */
  readonly handedBackAt: number | null
}

/** How a message reaches an executor session. */
export type DeliveryMode = 'queue' | 'steer' | 'inject'

/** One delivery attempt of one input. */
export interface InputAttemptRecord {
  readonly id: string
  readonly inputId: InputId
  readonly attempt: number
  readonly messageId: string | null
  readonly mode: DeliveryMode
  readonly status: 'prepared' | 'delivered' | 'read' | 'failed'
  readonly reason: string | null
  readonly createdAt: number
  readonly finishedAt: number | null
}

/** Exchange lifecycle. */
export type ExchangeStatus = 'pending' | 'delivered' | 'responded' | 'consumed' | 'failed' | 'expired' | 'cancelled'
/** Exchange kinds. */
export type ExchangeKind = 'request' | 'command'

/** One asynchronous paired request. */
export interface ExchangeRecord {
  readonly id: ExchangeId
  readonly qunoId: QunoId
  readonly kind: ExchangeKind
  readonly requester: EndpointId
  readonly responder: EndpointId
  readonly status: ExchangeStatus
  readonly deadline: number
  readonly requestMessageId: string
  readonly responseMessageId: string | null
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** One durable message inside an Exchange. */
export interface ExchangeMessageRecord {
  readonly id: string
  readonly exchangeId: ExchangeId
  readonly kind: 'request' | 'response' | 'result' | 'error'
  readonly producerEndpoint: EndpointId
  readonly payload: unknown
  readonly contentRef: ContentRef | null
  readonly contentHash: string
  readonly responseTo: string | null
  readonly createdAt: number
}

/** Kinds of post-commit work. */
export type EffectKind =
  | 'eval-delivery'
  | 'assignment-launch'
  | 'input-delivery'
  | 'router-relay'
  | 'notice'
  | 'exchange-delivery'
  | 'channel-reply'

/** One durable outbox row (Action Outbox). */
export interface EffectRecord {
  readonly kind: EffectKind
  readonly key: string
  readonly payload: unknown
  readonly seq: number
  readonly generation: number
  readonly attempts: number
  readonly dueAt: number
  readonly since: number
  readonly lastError: string | null
}

/** The transport seam an executor/router needs. */
export interface SessionTransport {
  resolve(endpoint: EndpointId): Promise<unknown | undefined>
  send(agent: unknown, input: {
    readonly requestId: string
    readonly text: string
    readonly mode: DeliveryMode
    readonly source: {
      readonly kind: string
      readonly form: 'relay' | 'notice'
      readonly summary: string
      readonly runId?: RunId
    }
  }, authorize: () => void): Promise<void>
  flush(agent: unknown): Promise<boolean>
  readSession(agent: unknown): Promise<readonly SessionEventLike[]>
}

/** Minimal durable session event shape. */
export interface SessionEventLike {
  readonly seq: number
  readonly type: string
  readonly data: unknown
}

/** One reference from an AttentionItem to any domain object. */
export interface AttentionLink {
  readonly itemId: string
  readonly targetType: 'trigger' | 'thread' | 'ticket' | 'exchange'
  readonly targetId: string
}

/** The source-side facts the Engine needs to turn an envelope into a Trigger. */
export interface TriggerDraft {
  /** Caller-reserved identity (the ingress already minted it); omitted = Engine allocates. */
  readonly id?: TriggerId
  readonly qunoId: QunoId
  readonly sourceId: string
  readonly eventKey: string
  readonly type: string
  readonly schema: string
  readonly threads: readonly ThreadRef[]
  readonly actor: ActorRef
  readonly human: boolean
  readonly addressed: 'mention' | 'direct' | null
  readonly occurredAt: number | null
  readonly observedAt: number
  readonly receivedAt: number
  readonly summary: string | null
  readonly data: unknown
  readonly contentRef: ContentRef | null
  readonly channel: ChannelRef | null
  readonly operation: EventOperation
  readonly priority: SuggestedPriority
  readonly deadline: number | null
  readonly correlationKeys: readonly string[]
  readonly supersedesTriggerIds: readonly TriggerId[]
  readonly parentTriggerIds: readonly TriggerId[]
  readonly provenance: Provenance
  readonly contentHash: string
  readonly configRevision: number
  readonly expiresAt: number | null
}

// --------------------------------------------------------------- predicates

/** The primary Thread of a Trigger; every Trigger has exactly one. */
export function primaryThreadOf(trigger: Pick<TriggerRecord, 'threads'>): ThreadRef | null {
  return trigger.threads[0] ?? null
}

/** Correlation-only threads, in declared order (never the primary). */
export function correlationThreadsOf(trigger: Pick<TriggerRecord, 'threads'>): readonly ThreadRef[] {
  return trigger.threads.slice(1)
}

/** Whether a Trigger came from a human author. */
export function isHumanTrigger(trigger: Pick<TriggerRecord, 'human'>): boolean {
  return trigger.human
}

/** Whether the human explicitly addressed Quno. */
export function isAddressedTrigger(trigger: Pick<TriggerRecord, 'human' | 'addressed'>): boolean {
  return trigger.human && trigger.addressed !== null
}

/** Canonical endpoint name for the router of one Quno. */
export function routerEndpoint(qunoId: QunoId): EndpointId {
  return `quno:${qunoId}/router`
}

/** Canonical endpoint name for one Ticket. */
export function ticketEndpoint(ticketId: TicketId): EndpointId {
  return `ticket:${ticketId}`
}

/** Canonical endpoint name for one Organ instance. */
export function collectorEndpoint(instanceId: string): EndpointId {
  return `collector:${instanceId}`
}

/** Stable Ticket id derived from an accepted Eval (repeated accepts return the same Ticket). */
export function ticketIdForEval(evalId: EvalId): TicketId {
  return `ticket_${evalId}`
}

/** Stable Assignment id for a Ticket's first executor binding. */
export function assignmentIdForTicket(ticketId: TicketId, ordinal = 1): AssignmentId {
  return `assign_${ticketId}_${String(ordinal)}`
}

/** Stable router candidate message id for one Eval. */
export function evalMessageRequestId(evalId: EvalId): string {
  return `eval:${evalId}`
}

/** Stable TicketInput id for one Trigger into one Ticket. */
export function ticketInputIdForTrigger(ticketId: TicketId, triggerId: TriggerId): string {
  return `input_${ticketId}_trigger_${triggerId}`
}

/** Stable TicketInput id (identity is the fact, never a retry counter). */
export function inputIdFor(parts: {
  readonly ticketId: TicketId
  readonly kind: InputKind
  readonly triggerId?: TriggerId | null
  readonly exchangeId?: ExchangeId | null
  readonly revision?: string | number | null
}): InputId {
  const subject = parts.triggerId ?? parts.exchangeId ?? String(parts.revision ?? 'none')
  return `input_${parts.ticketId}_${parts.kind}_${subject}`
}

/** Stable WorkerRun id for one Assignment turn. */
export function runIdFor(assignmentId: AssignmentId, ordinal: number): RunId {
  return `run_${assignmentId}_${String(ordinal)}`
}

/** Stable Effect key for one domain object. */
export function effectKey(...parts: readonly string[]): string {
  return parts.join(':')
}

/** Ticket is closed for new automatic work. */
export function ticketEnded(ticket: Pick<TicketRecord, 'ended'>): boolean {
  return ticket.ended !== null
}

/** A report state that ends the current bounded run but may keep waiting for input. */
export function reportKeepsTicketWaiting(state: ReportState): boolean {
  return state === 'waiting' || state === 'blocked' || state === 'failed'
}

/** A report state meaning the result is ready for acceptance. */
export function reportIsTerminalResult(state: ReportState): boolean {
  return state === 'ready' || state === 'dropped'
}

/** Whether an eval is still the active one for its Thread. */
export function evalIsActive(evalRecord: Pick<EvalRecord, 'status'>): boolean {
  return evalRecord.status === 'delivering' || evalRecord.status === 'waiting-decision'
}

/** A paused eval must not time out. */
export function evalDeadline(evalRecord: Pick<EvalRecord, 'deadline'>): number {
  return evalRecord.deadline
}

/** A human-stop ticket may never accept new input without a new accept. */
export function ticketBlocksInput(ticket: Pick<TicketRecord, 'ended'>): boolean {
  return ticket.ended !== null
}

/** Whether a source can resume a ticket with its next human follow-up. */
export function ticketCanResume(ticket: Pick<TicketRecord, 'ended'>): boolean {
  return ticket.ended !== null
    && ticket.ended.by !== 'human'
    && (ticket.ended.outcome === 'closed' || ticket.ended.outcome === 'dropped' || ticket.ended.outcome === 'completed')
}


/** FNV-1a 64-bit token: stable across processes and platforms (ids only, not security). */
export function hashToken(value: string): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index))
    hash = (hash * prime) & mask
  }
  return hash.toString(16).padStart(16, '0')
}

/** Deterministic JSON with sorted object keys (bounded depth). */
export function stableStringify(value: unknown): string {
  try {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
    if (Array.isArray(value)) return `[${value.map(entry => stableStringify(entry)).join(',')}]`
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  } catch {
    return '"[unserializable]"'
  }
}

/** Deterministic Thread row id (same formula everywhere, independent of insertion order). */
export function threadRowId(sourceId: string, threadKey: string): string {
  return `thr_${sourceId}_${hashToken(threadKey)}`
}

/** Thread key for a source without a stronger identity (never shared across sources). */
export function fallbackThreadKey(eventKey: string): string {
  return `object:${eventKey}`
}

/** Correlation keys of one Trigger, deduplicated and bounded. */
export function boundedCorrelationKeys(keys: readonly string[], limit = 32): readonly string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= limit) break
  }
  return out
}

/** Merge correlation edges (bounded, stable order). */
export function mergeCorrelation(
  current: readonly ThreadId[],
  next: readonly ThreadId[],
  limit = 50,
): readonly ThreadId[] {
  const out = [...current]
  const seen = new Set(out)
  for (const id of next) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= limit) break
  }
  return out
}

/** The trigger ids an eval must settle. */
export function evalBatchTriggerIds(evalRecord: Pick<EvalRecord, 'triggerIds'>): readonly TriggerId[] {
  return evalRecord.triggerIds
}

/** Effect identity used by the runtime to detect stale executions. */
export function effectMatches(effect: Pick<EffectRecord, 'kind' | 'key' | 'seq' | 'generation'>, kind: EffectKind, key: string, seq: number, generation: number): boolean {
  return effect.kind === kind && effect.key === key && effect.seq === seq && effect.generation === generation
}

/** Whether an exchange still accepts a response. */
export function exchangeOpen(exchange: Pick<ExchangeRecord, 'status'>): boolean {
  return exchange.status === 'pending' || exchange.status === 'delivered'
}

/** Whether a late exchange response must stay evidence-only. */
export function exchangeClosedByTime(exchange: Pick<ExchangeRecord, 'status'>): boolean {
  return exchange.status === 'expired' || exchange.status === 'cancelled' || exchange.status === 'failed' || exchange.status === 'consumed'
}

/** Identity conflict marker shared by every idempotent write. */
export class QunoConflictError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'QunoConflictError'
  }
}

/** A command refused because its premise no longer holds. */
export class QunoStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'QunoStateError'
  }
}
