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

/** One Sense instance in the settings view. */
export interface SenseWire {
  readonly id: string
  readonly type: string
  readonly label: string
  readonly config: Record<string, unknown>
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
  readonly lastSuccessAt: number | null
  readonly lastEventAt: number | null
  readonly nextRetryAt: number | null
  readonly checkpointRevision: number
  readonly configFields: readonly {
    readonly key: string
    readonly label: string
    readonly type: string
    readonly required?: boolean
    readonly help?: string
    readonly placeholder?: string
    readonly defaultValue?: string | number | boolean
  }[]
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
  readonly status: string
  readonly childSessionId: string | null
  readonly resultDigest: string | null
  readonly result: string | null
  /** The recorded execution plan, when the delegating turn produced one. */
  readonly plan: string | null
  /** The delegating prompt (bounded), so the panel detail can show the ask. */
  readonly prompt: string | null
  readonly artifacts: readonly { readonly kind: string; readonly label: string; readonly uri: string }[]
  readonly error: { readonly code: string; readonly message: string } | null
  readonly createdAt: number
  readonly settledAt: number | null
}

/** One ingested Sense event in the panel's recent-events summary. */
export interface EventWire {
  readonly id: string
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

/** One source health row. */
export interface SourceWire {
  readonly id: string
  readonly instanceId: string
  readonly type: string
  readonly lastEventAt: number | null
}

/** One registered Sense type (even before an instance exists). */
export interface SenseTypeWire {
  readonly type: string
  readonly displayName: string
  readonly description: string
  readonly implementationVersion: string
  readonly contractVersion: string
  readonly registered: boolean
  readonly configFields: readonly {
    readonly key: string
    readonly label: string
    readonly type: string
    readonly required?: boolean
    readonly help?: string
    readonly placeholder?: string
    readonly defaultValue?: string | number | boolean
  }[]
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
  readonly senses: readonly SenseWire[]
  readonly senseTypes: readonly SenseTypeWire[]
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

export const createSenseInput = z.object({
  type: z.string().min(1).max(200),
  label: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  desiredState: z.enum(['enabled', 'paused', 'disabled']).optional(),
})

export const senseCommandInput = z.object({
  instanceId: z.string().min(1).max(200),
  action: z.enum(['pause', 'resume', 'disable', 'remove', 'reconfigure']),
  label: z.string().max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const taskCommandInput = z.object({
  taskId: z.string().min(1).max(200),
  action: z.enum(['resume', 'abandon']),
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
