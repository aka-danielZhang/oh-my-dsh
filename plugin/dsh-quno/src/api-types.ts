/**
 * Wire vocabulary of the `quno` Remote namespace. Inputs are validated with
 * zod at the gateway boundary; results are host-produced, JSON-safe snapshots
 * (bounded lists), so their codecs assert JSON safety rather than re-deriving
 * every field.
 *
 * @module dsh-quno/api-types
 */

import { z } from 'zod'
import type { QunoConfig } from './types.ts'
import type { RecallResult } from './recall.ts'
import type { QunoStatusSummary } from './host-face.ts'

/** One declarative config field, as the browser renders it. */
export interface CollectorFieldWire {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly required?: boolean
  readonly secret?: boolean
  readonly help?: string
  readonly placeholder?: string
  readonly defaultValue?: string | number | boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly options?: readonly { readonly value: string; readonly label: string; readonly description?: string }[]
  readonly multiple?: boolean
  readonly discover?: boolean
  readonly advanced?: boolean
}

/** One Collector instance in the settings view. */
export interface CollectorWire {
  readonly id: string
  readonly type: string
  readonly label: string
  /** Secret fields are masked to `null`; `secretSet` names the ones that hold a value. */
  readonly config: Record<string, unknown>
  /** Keys whose declared secret field currently has a stored value. */
  readonly secretSet: readonly string[]
  readonly configRevision: number
  readonly desiredState: 'enabled' | 'paused' | 'disabled'
  readonly lifecycle: string
  readonly health: string
  readonly stale: boolean
  readonly healthDetail: {
    readonly detail?: string
    readonly consecutiveFailures?: number
    readonly errorCode?: string | null
    readonly sourceLagSec?: number | null
    readonly coveredThrough?: string | null
  } | null
  readonly lastAttemptAt: number | null
  readonly lastSuccessAt: number | null
  readonly lastEventAt: number | null
  readonly nextRetryAt: number | null
  readonly consecutiveFailures: number | null
  readonly errorCode: string | null
  readonly checkpointRevision: number
  readonly configFields: readonly CollectorFieldWire[]
}

/** One attention item in the settings view. */
export interface AttentionWire {
  readonly id: string
  readonly topicKey: string
  readonly title: string
  readonly summary: string
  readonly status: string
  readonly revision: number
  readonly materialRevision: number
  readonly nextReviewAt: number | null
  readonly snoozedUntil: number | null
  readonly updatedAt: number
  readonly evidence: readonly { readonly eventId?: string; readonly quote?: string }[]
}

/** One run diagnostic. */
export interface RunWire {
  readonly id: string
  readonly kind: string
  readonly trigger: string
  readonly status: string
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly committed: number
  readonly deferred: number
  readonly notices: number
  readonly error: { readonly code: string; readonly message: string } | null
  readonly provider: string | null
  readonly model: string | null
  readonly cost: { readonly promptChars: number; readonly outputChars: number; readonly durationMs: number; readonly toolCalls: number } | null
}

/** One delegated task in the card and list views. */
export interface TaskWire {
  readonly id: string
  readonly title: string
  /** Legacy coarse status (kept for old clients; mirrors the ended outcome). */
  readonly status: string
  /**
   * The unified user-facing status (design §4.2). Clients prefer this field;
   * it is absent on stale cached snapshots, which then fall back to `status`.
   */
  readonly presentationStatus?: string
  /** Display-only Worker label derived from the ticket id (v2 §9.1). */
  readonly workerLabel?: string
  /** Coarse activity bucket from the registered-tool display declarations. */
  readonly activityKind?: string | null
  /** Latest recorded activity time (no heartbeat fabrication). */
  readonly lastActivityAt?: number | null
  readonly canCancel?: boolean
  readonly canRetry?: boolean
  readonly canAnswer?: boolean
  /** The read-only execution record is reachable (running included). */
  readonly canViewActivity?: boolean
  /** Stable discriminator of the latest result (persistent dedupe). */
  readonly resultRevision?: string | null
  /** Where the mandate came from: a human turn or an accepted source. */
  readonly originLabel?: 'direct' | 'source'
  readonly childSessionId: string | null
  readonly resultDigest: string | null
  readonly result: string | null
  /** The recorded execution plan, when the delegating turn produced one. */
  readonly plan: string | null
  /** The delegating prompt (bounded), so the panel detail can show the ask. */
  readonly prompt: string | null
  readonly question: { readonly id: string; readonly question: string } | null
  readonly artifacts: readonly { readonly kind: string; readonly label: string; readonly uri: string }[]
  readonly error: { readonly code: string; readonly message: string } | null
  readonly createdAt: number
  readonly settledAt: number | null
}

/**
 * One worker's inspect-opening facts (design v2 §9.3): the Host resolves the
 * executor session from the ticket id — the client never passes a session id
 * of its own, and the response echoes `ticketId` so the caller can verify the
 * identity before opening anything.
 */
export interface WorkerDetailWire {
  readonly ticketId: string
  readonly title: string
  /** Display-only Worker label derived from the ticket id (v2 §9.1). */
  readonly workerLabel: string
  /** The unified user-facing status (same vocabulary as TaskWire). */
  readonly status: string
  /** `null` while the execution session has not been allocated yet. */
  readonly executorSessionId: string | null
  readonly canStop: boolean
  readonly canRetry: boolean
  /** Present when the worker cannot be resolved at all. */
  readonly note?: string
}

/** Input of the `workerDetail` Remote (v2 §9.3). */
export const workerDetailInput = z.object({
  ticketId: z.string().min(1).max(200),
})

/** One ingested Collector event in the panel's recent-events summary. */
export interface EventWire {
  readonly id: string
  /** Owning source, for readOriginal / gating decisions. */
  readonly sourceId: string
  readonly type: string
  readonly operation: string
  readonly subjectKey: string | null
  readonly summary: string | null
  readonly occurredAt: number | null
  readonly receivedAt: number
  readonly ingestSeq: number
  readonly pruned: boolean
}

/** One notification with its "why". */
export interface NoticeWire {
  readonly id: string
  readonly topicKey: string
  readonly kind: string
  readonly status: string
  readonly reason: string | null
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly why: string
  readonly itemIds: readonly string[]
  readonly eligibleAt: number
  readonly createdAt: number
  readonly messageId: string | null
  readonly attempts: number
}

/** One Thread row in the on-demand detail view. */
export interface ThreadWire {
  readonly id: string
  readonly sourceId: string
  readonly threadKey: string
  readonly label: string | null
  readonly lastAt: number | null
  readonly pendingTriggerIds: readonly string[]
  readonly activeEvalId: string | null
  readonly correlatedThreadIds: readonly string[]
  readonly closed: { readonly at: number; readonly outcome: string } | null
}

/** One Eval row. */
export interface EvalWire {
  readonly id: string
  readonly threadId: string
  readonly triggerIds: readonly string[]
  readonly primaryTriggerId: string
  readonly strength: string
  readonly policyVersion: string
  readonly status: string
  readonly candidateMessageId: string | null
  readonly startedAt: number
  readonly deliveredAt: number | null
  readonly deadline: number
  readonly pausedAt: number | null
  readonly expiryCount: number
}

/** One Trigger with a bounded payload. */
export interface TriggerDetailWire {
  readonly id: string
  readonly sourceId: string
  readonly type: string
  readonly operation: string
  readonly summary: string | null
  readonly occurredAt: number | null
  readonly receivedAt: number
  readonly pruned: boolean
  readonly human: boolean
  readonly addressed: 'mention' | 'direct' | null
  readonly actor: { readonly source: string; readonly id: string }
  readonly threads: readonly { readonly source: string; readonly id: string }[]
  readonly correlationKeys: readonly string[]
  readonly provenance: string
  readonly data: unknown
  readonly dataTruncated: boolean
  readonly filtered: string | null
}

/** One Thread plus its subscriptions and recent Triggers. */
export interface ThreadDetailWire extends ThreadWire {
  readonly subscriptions: readonly {
    readonly id: string
    readonly ticketId: string
    readonly mode: string
    readonly origin: string
    readonly cancelledAt: number | null
  }[]
  readonly tickets: readonly { readonly id: string; readonly title: string; readonly mode: string; readonly ended: boolean }[]
  readonly recentTriggers: readonly {
    readonly id: string
    readonly type: string
    readonly summary: string | null
    readonly occurredAt: number | null
    readonly human: boolean
  }[]
}

/** One Ticket with its assignments, inputs and report. */
export interface TicketDetailWire {
  readonly ticket: {
    readonly id: string
    readonly title: string
    readonly goal: string
    readonly mode: string
    readonly ended: { readonly at: number; readonly by: string; readonly outcome: string; readonly reason: string | null } | null
    readonly question: { readonly id: string; readonly question: string; readonly triggerId: string | null } | null
    readonly mandate: unknown
    readonly channels: readonly unknown[]
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly assignments: readonly {
    readonly id: string
    readonly state: string
    readonly executorSessionId: string
    readonly directory: string
    readonly deliveredAt: number | null
    readonly idleAt: number | null
    readonly endedReason: string | null
    readonly report: unknown
    readonly runs: readonly {
      readonly id: string
      readonly status: string
      readonly startedAt: number
      readonly finishedAt: number | null
      readonly error: { readonly code: string; readonly message: string } | null
    }[]
  }[]
  readonly inputs: readonly {
    readonly id: string
    readonly kind: string
    readonly human: boolean
    readonly context: boolean
    readonly text: string | null
    readonly createdAt: number
    readonly deliveredAt: number | null
    readonly readAt: number | null
    readonly acknowledgedAt: number | null
    readonly handedBackAt: number | null
  }[]
  readonly subscriptions: readonly {
    readonly id: string
    readonly threadId: string
    readonly mode: string
    readonly origin: string
    readonly cancelledAt: number | null
  }[]
  readonly triggers: readonly {
    readonly id: string
    readonly type: string
    readonly summary: string | null
    readonly occurredAt: number | null
  }[]
}

/** One Eval with its decision audit and candidate Triggers. */
export interface EvalDetailWire {
  readonly eval: EvalWire
  readonly thread: { readonly id: string; readonly sourceId: string; readonly threadKey: string; readonly label: string | null } | null
  readonly decision: {
    readonly id: string
    readonly kind: string
    readonly strength: string
    readonly reason: string | null
    readonly ticketId: string | null
    readonly policyVersion: string
    readonly audit: unknown
    readonly createdAt: number
  } | null
  readonly triggers: readonly {
    readonly id: string
    readonly type: string
    readonly summary: string | null
    readonly occurredAt: number | null
    readonly human: boolean
    readonly addressed: 'mention' | 'direct' | null
    readonly actor: { readonly source: string; readonly id: string }
  }[]
}

/** One Exchange with its durable messages. */
export interface ExchangeDetailWire {
  readonly exchange: {
    readonly id: string
    readonly kind: string
    readonly requester: string
    readonly responder: string
    readonly status: string
    readonly deadline: number
    readonly requestMessageId: string
    readonly responseMessageId: string | null
    readonly attempts: number
    readonly createdAt: number
    readonly updatedAt: number
  }
  readonly messages: readonly {
    readonly id: string
    readonly kind: string
    readonly producerEndpoint: string
    readonly contentHash: string
    readonly responseTo: string | null
    readonly createdAt: number
    readonly payload: unknown
  }[]
}

/** One source health row. */
export interface SourceWire {
  readonly id: string
  readonly instanceId: string
  readonly type: string
  readonly lastEventAt: number | null
}

/** One historical notice with the current state of its linked attention items. */
export interface NoticeDetailWire {
  readonly id: string
  readonly topicKey: string
  readonly kind: string
  readonly status: string
  readonly reason: string | null
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly why: string
  readonly itemIds: readonly string[]
  readonly items: readonly AttentionWire[]
  readonly eligibleAt: number
  readonly createdAt: number
  readonly messageId: string | null
  readonly attempts: number
  /** True when the record itself is past retention or terminally expired. */
  readonly expired: boolean
}

/** One event, bounded for a detail view. */
export interface EventDetailWire {
  readonly id: string
  readonly sourceId: string
  readonly instanceId: string | null
  readonly type: string
  readonly operation: string
  readonly subjectKey: string | null
  readonly subjectRevision: string | null
  readonly summary: string | null
  readonly occurredAt: number | null
  readonly receivedAt: number
  readonly ingestSeq: number
  readonly pruned: boolean
  readonly provenance: string
  readonly data: unknown
  readonly dataTruncated: boolean
  readonly attachments: readonly { readonly name: string; readonly mediaType: string; readonly ref: string; readonly bytes?: number }[]
}

/** One discovered option. */
export interface CollectorOptionWire {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
  readonly disabledReason?: string
}

/** Result of one field-option discovery page. */
export interface CollectorOptionsPageWire {
  readonly ok: boolean
  readonly options: readonly CollectorOptionWire[]
  readonly more: boolean
  readonly detail?: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** Result of one explicit probe. */
export interface CollectorProbeWire {
  readonly ok: boolean
  readonly code: string
  readonly message: string
  readonly at: number
  readonly durationMs: number
}

/** One registered Collector type (even before an instance exists). */
export interface CollectorTypeWire {
  readonly type: string
  readonly displayName: string
  readonly description: string
  readonly implementationVersion: string
  readonly contractVersion: string
  readonly registered: boolean
  readonly configFields: readonly CollectorFieldWire[]
  /** `null` when the declaration is unavailable (historical type / plugin unloaded). */
  readonly schedule: {
    readonly defaultIntervalSec: number
    readonly minIntervalSec: number
    readonly maxRunMs: number
    readonly quotas: { readonly maxEventsPerRun: number | null; readonly maxBytesPerRun: number | null } | null
  } | null
  /** `null` when the declaration is unavailable. */
  readonly permissions: {
    readonly reads: readonly string[]
    readonly credentialKinds: readonly string[]
    readonly network: readonly string[]
    readonly mcp: readonly string[]
    readonly requiresModel: boolean
  } | null
  /** `null` when the declaration is unavailable. */
  readonly reliability: {
    readonly checkpoint: string
    readonly replay: { readonly kind: string; readonly windowSec: number | null }
    readonly changeCoverage: string
    readonly gapDetection: string
    readonly readOriginal: boolean
  } | null
  /** First-synchronization semantics; `unknown` when not declared. */
  readonly firstSync: string
  readonly eventTypes: readonly { readonly type: string; readonly summary: string | null }[]
  /** Whether the implementation offers a real probe. */
  readonly probeAvailable: boolean
}

/** The complete, bounded settings snapshot. */
export interface QunoWireState {
  readonly updatedAt: number
  readonly quno: {
    readonly id: string
    readonly name: string
    readonly persona: string
    readonly instructions: string
    readonly modelProvider: string
    readonly model: string
    readonly reasoningEffort: string | null
    readonly mainSessionId: string | null
    readonly mainSessionState: string
    readonly mutedUntil: number | null
    readonly configRevision: number
  }
  readonly config: QunoConfig
  readonly main: { readonly sessionId: string | null; readonly state: string; readonly live: boolean }
  readonly collectors: readonly CollectorWire[]
  readonly collectorTypes: readonly CollectorTypeWire[]
  readonly sources: readonly SourceWire[]
  readonly gaps: readonly { readonly sourceId: string; readonly at: number; readonly reason: string }[]
  readonly attention: readonly AttentionWire[]
  readonly runs: readonly RunWire[]
  readonly tasks: readonly TaskWire[]
  readonly notices: readonly NoticeWire[]
  readonly metrics: {
    readonly deliveries: Record<string, number>
    readonly attentionOpen: number
    readonly oldestPendingAt: number | null
    readonly runsToday: number
    readonly noticesToday: number
  }
  readonly status: QunoStatusSummary
  readonly presets: { readonly main: string; readonly task: string }
}

/** Result of binding or creating the main conversation. */
export interface EnsureMainResult {
  readonly sessionId: string
  readonly state: string
  readonly created: boolean
}

/** Result of a manual check. */
export interface CheckNowResult {
  readonly kind: string
  readonly at: number
}

/** Input schemas (the only untrusted direction). */
export const ensureMainInput = z.object({
  /** Requested working directory; empty falls back to the user's home. */
  cwd: z.string().max(4096),
  /** Default Workspace to join; absent keeps the legacy bare cwd session. */
  workspaceId: z.string().max(200).optional(),
})

export const updateConfigInput = z.object({
  patch: z.record(z.string(), z.unknown()),
})

export const updateProfileInput = z.object({
  name: z.string().min(1).max(100).optional(),
  persona: z.string().max(20_000).optional(),
  instructions: z.string().max(20_000).optional(),
  modelProvider: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  reasoningEffort: z.union([z.string().max(100), z.null()]).optional(),
})

export const actAttentionInput = z.object({
  itemId: z.string().min(1).max(200),
  action: z.enum(['processed', 'later', 'dismiss', 'resume', 'clarify']),
  expectedRevision: z.number().int().nonnegative().optional(),
  snoozeMinutes: z.number().int().min(1).max(100_000).optional(),
  note: z.string().max(2000).optional(),
})

export const createCollectorInput = z.object({
  type: z.string().min(1).max(200),
  label: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  desiredState: z.enum(['enabled', 'paused', 'disabled']).optional(),
})

export const collectorCommandInput = z.object({
  instanceId: z.string().min(1).max(200),
  action: z.enum(['pause', 'resume', 'disable', 'remove', 'reconfigure']),
  label: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const taskCommandInput = z.object({
  taskId: z.string().min(1).max(200),
  action: z.enum(['resume', 'abandon', 'cancel', 'answer']),
  /** The user's answer text; required for the `answer` action only. */
  text: z.string().min(1).max(8000).optional(),
})

export const probeCollectorInput = z.object({
  instanceId: z.string().min(1).max(200),
})

export const collectorOptionsInput = z.object({
  type: z.string().min(1).max(200),
  field: z.string().min(1).max(100),
  /** Draft configuration; discovery must not require a complete instance config. */
  config: z.record(z.string(), z.unknown()).optional(),
  page: z.number().int().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

export const noticeDetailInput = z.object({
  notificationId: z.string().min(1).max(200),
})

export const eventDetailInput = z.object({
  eventId: z.string().min(1).max(200),
})

export const triggerDetailInput = z.object({
  triggerId: z.string().min(1).max(200),
})

export const threadDetailInput = z.object({
  threadId: z.string().min(1).max(300),
})

export const ticketDetailInput = z.object({
  ticketId: z.string().min(1).max(300),
})

export const evalDetailInput = z.object({
  evalId: z.string().min(1).max(300),
})

export const exchangeDetailInput = z.object({
  exchangeId: z.string().min(1).max(300),
})

export const eventsRecentInput = z.object({
  limit: z.number().int().min(1).max(50).optional(),
})

export const muteInput = z.object({
  minutes: z.number().int().min(1).max(10_080).optional(),
  until: z.string().max(100).optional(),
  cancel: z.boolean().optional(),
})

/** A JSON-safe passthrough codec for host-produced snapshots. */
export function passthroughSchema(): { parse(value: unknown): unknown } {
  return {
    parse(value: unknown): unknown {
      return JSON.parse(JSON.stringify(value)) as unknown
    },
  }
}

/** Recall result re-exported for the client declaration merge. */
export type { RecallResult, QunoStatusSummary }
