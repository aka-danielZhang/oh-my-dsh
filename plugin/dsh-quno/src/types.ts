/**
 * Shared Quno domain identities and the small value vocabulary every layer
 * (store, contracts, scheduler, delivery, UI wire) speaks.
 *
 * Ids are plain strings with a stable prefix. They are user-invisible but
 * durable: an event id, attention item id, run id, task id, or notice id must
 * never be regenerated for the same fact.
 *
 * @module dsh-quno/types
 */

/** One Quno instance. v1 provisions exactly one (`quno`), the schema keeps the column. */
export type QunoId = string

/** One immutable observation in the event log. */
export type EventId = string

/** One Quno-owned source identity (stable across Sense restarts and token refreshes). */
export type SourceId = string

/** One Sense install configuration. */
export type SenseInstanceId = string

/** One durable attention item. */
export type AttentionItemId = string

/** One bounded analysis run. */
export type RunId = string

/** One delegated background task. */
export type TaskId = string

/** One notification outbox entry. */
export type NotificationId = string

/** One batch receipt (stable within a source batch key). */
export type BatchId = string

/** Delivery lifecycle — one event consumed by one Quno. */
export type DeliveryStatus = 'pending' | 'claimed' | 'processed' | 'ignored' | 'deferred' | 'dead-letter'

/** Attention lifecycle. `resolved` can reopen only on new material evidence. */
export type AttentionStatus = 'open' | 'waiting' | 'snoozed' | 'resolved' | 'dismissed' | 'expired'

/** One run's lifecycle. A fenced run can never write after its lease expired. */
export type RunStatus = 'claimed' | 'running' | 'committed' | 'failed' | 'interrupted'

/** One delegated task's lifecycle. `interrupted` is a human-resolvable state. */
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'

/** Notification delivery lifecycle. */
export type NoticeStatus =
  | 'pending'
  | 'prepared'
  | 'inbox-durable'
  | 'presented'
  | 'suppressed'
  | 'superseded'
  | 'expired'
  | 'uncertain'
  | 'retryable-failure'
  | 'delivery-blocked'

/** Sense lifecycle axes kept separate: desired state, runtime lifecycle, health. */
export type SenseDesiredState = 'enabled' | 'paused' | 'disabled'
export type SenseLifecycle = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'
export type SenseHealthState =
  | 'healthy'
  | 'degraded'
  | 'rate-limited'
  | 'auth-required'
  | 'unavailable'
  | 'unknown'

/** Source-suggested priority. The effective priority is always Quno policy. */
export type SuggestedPriority = 'p0' | 'p1' | 'p2' | 'p3'

/** Effective priority assigned by Quno when routing. */
export type EffectivePriority = SuggestedPriority

/** Event operation. A retraction is a new event, never a deletion of history. */
export type EventOperation = 'upsert' | 'delete' | 'retract'

/** Provenance kinds. Derived observations must cite their inputs. */
export type ProvenanceKind = 'observed' | 'derived'

/** A persisted Quno identity and policy row. */
export interface QunoRecord {
  readonly id: QunoId
  readonly name: string
  readonly persona: string
  readonly instructions: string
  readonly modelProvider: string
  readonly model: string
  readonly reasoningEffort: string | null
  readonly mainSessionId: string | null
  /** `unbound` until the owner creates the conversation; never silently created on boot. */
  readonly mainSessionState: 'unbound' | 'ok' | 'missing' | 'delivery-blocked'
  /** A short-term "don't bother me until" instruction; never promoted to long-term memory. */
  readonly mutedUntil: number | null
  readonly config: QunoConfig
  readonly configRevision: number
  readonly nextCheckAt: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** User-owned behaviour knobs (persisted as JSON on the quno row). */
export interface QunoConfig {
  /** Master switch: paused still ingests (Sense keeps observing), but no model run and no proactive notice. */
  readonly enabled: boolean
  /** Thinking cadence in seconds. Product floor is 60 (tests may use less through an explicit override). */
  readonly checkIntervalSec: number
  /** IANA zone used for working/quiet hours and display. */
  readonly timeZone: string
  /** Optional working window; outside it automatic runs are still allowed but deprioritised. */
  readonly activeHours: DayRange | null
  /** Local wall-clock window in which proactive notices are held, never dropped. */
  readonly quietHours: DayRange | null
  readonly notificationPolicy: NotificationPolicy
  readonly budget: QunoBudget
  readonly retention: QunoRetention
  /** Notifications are computed and recorded but never delivered (dry-run onboarding). */
  readonly dryRun: boolean
}

/** One local wall-clock window, inclusive start, exclusive end; start > end crosses midnight. */
export interface DayRange {
  readonly start: string
  readonly end: string
}

/** Which changes are worth a proactive message. */
export interface NotificationPolicy {
  /** `meaningful`: only material changes; `every-run`: one digest per productive run. */
  readonly mode: 'meaningful' | 'every-run'
  /** Minimum gap between two proactive notices, seconds. */
  readonly minGapSec: number
  /** Hard ceiling of proactive notices per rolling hour. */
  readonly maxPerHour: number
  /** Urgent early wake is off by default; it also needs a user opt-in to break quiet hours. */
  readonly allowUrgentWake: boolean
  /** `quiet` still respects quiet hours when urgent wake is allowed. */
  readonly urgentMayBreakQuietHours: boolean
}

/** Per-run and per-day model cost bounds. */
export interface QunoBudget {
  readonly dailyModelRuns: number
  readonly maxEventsPerRun: number
  readonly maxContextChars: number
  readonly maxOutputTokens: number
  readonly runTimeoutSec: number
  readonly maxToolCalls: number
}

/** Retention windows in days. Unsettled evidence and open notices never expire by age alone. */
export interface QunoRetention {
  readonly eventBodyDays: number
  readonly runDiagnosticsDays: number
  readonly noticeDays: number
}

/** One source identity and the instance that owns it. */
export interface SourceRecord {
  readonly id: SourceId
  readonly qunoId: QunoId
  readonly instanceId: SenseInstanceId
  readonly type: string
  readonly scope: string | null
  readonly createdAt: number
}

/** One immutable event row (data kept as parsed JSON). */
export interface EventRecord {
  readonly id: EventId
  readonly sourceId: SourceId
  readonly eventKey: string
  readonly subjectKey: string | null
  readonly subjectRevision: string | null
  readonly type: string
  readonly schema: string
  readonly operation: EventOperation
  readonly occurredAt: number | null
  readonly observedAt: number
  readonly receivedAt: number
  readonly ingestSeq: number
  readonly summary: string | null
  readonly data: unknown
  readonly priority: SuggestedPriority
  readonly deadline: number | null
  readonly provenance: Provenance
  readonly correlationKeys: readonly string[]
  readonly supersedesEventIds: readonly string[]
  readonly parentEventIds: readonly string[]
  readonly contentHash: string
  readonly senseConfigRevision: number
  readonly expiresAt: number | null
  readonly prunedAt: number | null
}

/** Where an event came from. Perceived and derived facts are never conflated. */
export type Provenance =
  | { readonly kind: 'observed'; readonly collector?: string }
  | {
    readonly kind: 'derived'
    readonly inputs: readonly { readonly eventId?: EventId; readonly eventKey?: string }[]
    readonly processor: string
    readonly coverage: string
    readonly confidence?: number
    readonly window?: { readonly from: number | null; readonly to: number | null }
  }

/** One event as consumed by one Quno. */
export interface DeliveryRecord {
  readonly id: string
  readonly qunoId: QunoId
  readonly eventId: EventId
  readonly status: DeliveryStatus
  readonly priority: EffectivePriority
  readonly eligibleAt: number
  readonly attempts: number
  readonly runId: RunId | null
  readonly reason: string | null
  readonly claimedAt: number | null
  readonly settledAt: number | null
  readonly createdAt: number
}

/** Subscription filter — deterministic rules only, never a hidden model. */
export interface SubscriptionFilter {
  readonly sourceIds?: readonly SourceId[]
  readonly types?: readonly string[]
  readonly operations?: readonly EventOperation[]
  readonly subjectKeys?: readonly string[]
  readonly correlationKeys?: readonly string[]
  /** Case-insensitive substring match over summary. */
  readonly summaryIncludes?: readonly string[]
  /** Only events suggesting at least this priority. */
  readonly priorityAtLeast?: SuggestedPriority
}

/** One persisted subscription revision. */
export interface SubscriptionRecord {
  readonly id: string
  readonly qunoId: QunoId
  readonly sourceId: SourceId
  readonly filter: SubscriptionFilter
  readonly startIngestSeq: number
  readonly revision: number
  readonly createdAt: number
}

/** One attention item: "something still unfinished" rather than a to-do list entry. */
export interface AttentionItemRecord {
  readonly id: AttentionItemId
  readonly qunoId: QunoId
  readonly topicKey: string
  readonly title: string
  readonly summary: string
  readonly status: AttentionStatus
  readonly revision: number
  /** Bumped only for material change (deadline, owner, required action, blocker). */
  readonly materialRevision: number
  readonly subjectRefs: readonly string[]
  readonly evidence: readonly AttentionEvidence[]
  readonly nextReviewAt: number | null
  readonly snoozedUntil: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** A cited fact backing an item or a notice. */
export interface AttentionEvidence {
  readonly eventId?: EventId
  readonly itemId?: AttentionItemId
  readonly quote?: string
  readonly capturedAt?: number
  readonly contentHash?: string
}

/** One material change recorded on the history rail. */
export interface AttentionHistoryRecord {
  readonly seq: number
  readonly qunoId: QunoId
  readonly itemId: AttentionItemId
  readonly revision: number
  readonly fromStatus: AttentionStatus | null
  readonly toStatus: AttentionStatus
  readonly material: boolean
  readonly cause: string
  readonly runId: RunId | null
  readonly at: number
}

/** One bounded analysis run. */
export interface RunRecord {
  readonly id: RunId
  readonly qunoId: QunoId
  readonly kind: 'think' | 'task'
  readonly trigger: string
  readonly configRevision: number
  readonly sessionId: string | null
  readonly status: RunStatus
  readonly fence: number
  readonly claimExpiresAt: number | null
  readonly inputEventIds: readonly EventId[]
  readonly inputAttentionIds: readonly AttentionItemId[]
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly result: RunOutput | null
  readonly error: { readonly code: string; readonly message: string; readonly retryable?: boolean } | null
  readonly provider: string | null
  readonly model: string | null
  readonly cost: RunCost | null
}

/** Observed cost of one run. */
export interface RunCost {
  readonly promptChars: number
  readonly outputChars: number
  readonly modelCalls: number
  readonly toolCalls: number
  readonly durationMs: number
}

/** One delegated background task. */
export interface TaskRecord {
  readonly id: TaskId
  readonly qunoId: QunoId
  readonly childSessionId: string | null
  readonly parentSessionId: string | null
  readonly jobId: string | null
  readonly title: string
  readonly prompt: string
  readonly plan: string | null
  readonly status: TaskStatus
  readonly resultDigest: string | null
  readonly result: string | null
  readonly artifacts: readonly TaskArtifact[]
  readonly error: { readonly code: string; readonly message: string } | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly settledAt: number | null
}

/** An inspectable task product. The host never infers artifacts from arbitrary activity. */
export interface TaskArtifact {
  readonly kind: 'file' | 'directory' | 'url' | 'note'
  readonly label: string
  readonly uri: string
}

/** One notification outbox entry. */
export interface NoticeRecord {
  readonly id: NotificationId
  readonly qunoId: QunoId
  readonly topicKey: string
  readonly materialRevision: number
  readonly reminderStage: number
  readonly kind: 'report' | 'task'
  readonly payload: NoticePayload
  readonly messageId: string | null
  readonly messageVersion: number
  readonly status: NoticeStatus
  readonly reason: string | null
  readonly eligibleAt: number
  readonly expiresAt: number | null
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Deterministic notice content: rendered by the Host, never re-invented by the expression model. */
export interface NoticePayload {
  readonly title: string
  readonly body: string
  /** Attention item ids the user may act on (buttons submit expectedRevision commands). */
  readonly itemIds?: readonly AttentionItemId[]
  /** Task id for `kind: 'task'`. */
  readonly taskId?: string
  /** One-line account shown in the message row. */
  readonly summary: string
  /** Why this notice exists, kept for "why did you tell me". */
  readonly why: string
  /** Near-deadline material change; may bypass quiet hours only when the user allowed it. */
  readonly urgent?: boolean
}

/** One delivery attempt (retries get their own row). */
export interface NoticeAttemptRecord {
  readonly id: string
  readonly notificationId: NotificationId
  readonly attempt: number
  readonly status: NoticeStatus
  readonly reason: string | null
  readonly messageId: string | null
  readonly at: number
}

/** One Sense instance row. */
export interface SenseInstanceRecord {
  readonly id: SenseInstanceId
  readonly qunoId: QunoId
  readonly type: string
  readonly label: string
  readonly config: Record<string, unknown>
  readonly configRevision: number
  readonly desiredState: SenseDesiredState
  readonly lifecycle: SenseLifecycle
  readonly health: SenseHealthState
  readonly healthDetail: SenseHealthDetail | null
  readonly generation: number
  readonly checkpoint: SenseCheckpoint
  readonly lastAttemptAt: number | null
  readonly lastSuccessAt: number | null
  readonly lastEventAt: number | null
  readonly nextRetryAt: number | null
  readonly consecutiveFailures: number
  readonly errorCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

/** Opaque upstream position and its compare-and-swap revision. */
export interface SenseCheckpoint {
  readonly value: string | null
  readonly revision: number
}

/** Health fields a Sense reports; `lastSuccessAt !== everything` is the point. */
export interface SenseHealthDetail {
  readonly state: SenseHealthState
  readonly detail?: string
  readonly lastAttemptAt?: number | null
  readonly lastSuccessfulSyncAt?: number | null
  readonly lastEventAt?: number | null
  readonly consecutiveFailures?: number
  readonly errorCode?: string | null
  readonly nextRetryAt?: number | null
  readonly coveredThrough?: string | null
  readonly sourceLagSec?: number | null
}

/** Registered Sense type metadata (the declaration is stored as JSON). */
export interface SenseTypeRecord {
  readonly type: string
  readonly contractVersion: number
  readonly implementationVersion: string
  readonly definition: unknown
  readonly registeredAt: number
}

/** One in-memory tool-facing notice prepared for the conversation. */
export interface NoticeDeliveryPlan {
  readonly notice: NoticeRecord
  readonly messageId: string
  readonly text: string
}

/** Run output validated against the run's input. */
export interface RunOutput {
  readonly eventDecisions: readonly EventDecision[]
  readonly attentionChanges: readonly AttentionChange[]
  readonly notificationCandidates: readonly NotificationCandidate[]
  readonly uncertainties: readonly string[]
}

/** One event's disposition in a run. Omitted events stay pending. */
export interface EventDecision {
  readonly eventId: EventId
  readonly decision: 'processed' | 'irrelevant' | 'superseded' | 'deferred'
  readonly reason?: string
  readonly deferredUntil?: number
}

/** One attention mutation proposed by a run. */
export interface AttentionChange {
  readonly action: 'create' | 'update' | 'resolve' | 'dismiss' | 'expire' | 'wait' | 'snooze'
  readonly itemId?: AttentionItemId
  readonly topicKey: string
  readonly expectedRevision?: number
  readonly title?: string
  readonly summary?: string
  readonly status?: AttentionStatus
  readonly material?: boolean
  readonly evidence?: readonly AttentionEvidence[]
  readonly nextReviewAt?: number | null
  readonly snoozedUntil?: number | null
  readonly subjectRefs?: readonly string[]
}

/** One reason the Host should consider telling the user. */
export interface NotificationCandidate {
  readonly topicKey: string
  readonly itemIds?: readonly AttentionItemId[]
  readonly reason: string
  readonly kind?: 'update' | 'reminder'
  readonly reminderStage?: number
  readonly body?: string
  readonly title?: string
}

/** A Sense's machine-checkable declaration. */
export interface SenseDefinition {
  readonly type: string
  readonly contractVersion: string
  readonly implementationVersion: string
  readonly displayName: string
  readonly description: string
  readonly eventTypes: readonly { readonly type: string; readonly summary?: string }[]
  readonly configFields?: readonly SenseConfigField[]
  readonly permissions: {
    readonly reads: readonly string[]
    readonly credentialKinds?: readonly string[]
    readonly network?: readonly string[]
    readonly mcp?: readonly string[]
    readonly requiresModel?: boolean
  }
  readonly runtime: {
    readonly modes: readonly ('poll' | 'watch' | 'push' | 'hybrid')[]
    readonly defaultIntervalSec: number
    readonly minIntervalSec: number
    readonly concurrency: number
    readonly timeoutMs: number
    readonly quotas?: { readonly maxEventsPerCheck?: number; readonly maxBytesPerCheck?: number }
  }
  readonly reliability: {
    readonly checkpoint: 'cursor' | 'snapshot' | 'none'
    readonly replay: { readonly kind: 'bounded' | 'none'; readonly windowSec?: number }
    readonly changeCoverage: 'all-changes' | 'snapshot-diff' | 'sampled'
    readonly gapDetection: 'explicit' | 'partial' | 'none'
    readonly readOriginal: boolean
  }
  readonly defaults?: Record<string, unknown>
}

/** Declarative UI hint for one Sense config key (the generic JSON fallback stays available). */
export interface SenseConfigField {
  readonly key: string
  readonly label: string
  readonly type: 'string' | 'path' | 'url' | 'number' | 'boolean'
  readonly required?: boolean
  readonly secret?: boolean
  readonly placeholder?: string
  readonly help?: string
  readonly defaultValue?: string | number | boolean
}

/** One event envelope submitted by a Sense. */
export interface EventEnvelope {
  readonly eventKey: string
  readonly type: string
  readonly schema?: string
  readonly subject?: { readonly key: string; readonly revision?: string; readonly label?: string }
  readonly operation?: EventOperation
  readonly occurredAt?: string | null
  readonly observedAt?: string
  readonly summary?: string
  readonly data?: unknown
  readonly priority?: SuggestedPriority
  readonly deadline?: string | null
  readonly provenance?: ProvenanceInput
  readonly correlationKeys?: readonly string[]
  readonly supersedesEventIds?: readonly EventId[]
  readonly parentEventIds?: readonly EventId[]
  readonly attachments?: readonly {
    readonly name: string
    readonly mediaType: string
    readonly ref: string
    readonly sha256?: string
    readonly bytes?: number
  }[]
  readonly expiresAt?: string | null
}

/** Wire shape of provenance: derived inputs may cite event keys instead of host ids. */
export type ProvenanceInput =
  | { readonly kind: 'observed'; readonly collector?: string }
  | {
    readonly kind: 'derived'
    readonly inputs: readonly { readonly eventId?: string; readonly eventKey?: string }[]
    readonly processor: string
    readonly coverage: string
    readonly confidence?: number
  }

/** One submission batch. */
export interface IngestBatch {
  /** Stable per source batch identity; retried batches return the same receipt. */
  readonly batchKey: string
  readonly events: readonly EventEnvelope[]
  readonly checkpointAfter?: { readonly value: string | null; readonly revision: number } | null
  /** False when the Sense knows it read a partial page. */
  readonly complete?: boolean
  /** Explicit coverage gap the Sense detected (pagination overflow, upstream hole). */
  readonly gap?: {
    readonly from?: string
    readonly to?: string
    readonly reason: string
  } | null
}

/** One accepted/duplicate event in an ACK. */
export interface IngestAckItem {
  readonly index: number
  readonly eventId: EventId
  readonly eventKey: string
  readonly status: 'accepted' | 'duplicate'
}

/** Durable ACK for one batch. */
export interface IngestAck {
  readonly batchId: BatchId
  readonly batchKey: string
  readonly accepted: readonly IngestAckItem[]
  readonly eventCount: number
  readonly acceptedCount: number
  readonly duplicateCount: number
  readonly checkpointRevision: number
  readonly gapReported: boolean
}

/** Machine-classifiable ingress/report failure. */
export interface QunoErrorShape {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly index?: number
}

/** Health facade over one registered Sense type as the UI sees it. */
export interface SenseTypeView {
  readonly type: string
  readonly displayName: string
  readonly description: string
  readonly contractVersion: string
  readonly implementationVersion: string
  readonly definition: SenseDefinition
  readonly instances: readonly SenseInstanceRecord[]
}
