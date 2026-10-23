/**
 * The model-facing surface of the Quno Host service, shared by the preset
 * tools and implemented by the Host entry. Kept structural so the preset row
 * only needs the `quno` service key.
 *
 * @module dsh-quno/host-face
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttentionAct } from './contracts.ts'
import type { RecallRequest, RecallResult } from './recall.ts'
import type { AttentionItemRecord, TaskRecord } from './types.ts'

/** Compact self-status shown to the model (not the full UI snapshot). */
export interface QunoStatusSummary {
  readonly enabled: boolean
  readonly mainSession: string
  readonly mutedUntil: number | null
  readonly nextCheckAt: number | null
  readonly attention: { readonly open: number; readonly waiting: number; readonly snoozed: number }
  readonly deliveries: { readonly pending: number; readonly deferred: number; readonly deadLetter: number }
  readonly tasks: { readonly running: number; readonly interrupted: number }
  readonly senses: readonly { readonly label: string; readonly type: string; readonly health: string; readonly stale: boolean }[]
  readonly notices: { readonly pending: number; readonly inboxDurable: number; readonly blocked: number }
}

/** What the preset tools rely on. */
export interface QunoServiceFace {
  startTask(
    input: { readonly title: string; readonly prompt: string; readonly cwd?: string },
    parent: Agent,
  ): Promise<TaskRecord>
  recall(request: RecallRequest): Promise<RecallResult>
  listAttention(statuses?: readonly string[]): readonly AttentionItemRecord[]
  actAttention(act: AttentionAct, channel: 'button' | 'natural'): Promise<AttentionItemRecord>
  mute(input: { readonly minutes?: number; readonly until?: string; readonly cancel?: boolean }): Promise<{ readonly mutedUntil: number | null }>
  statusSummary(): QunoStatusSummary
}
