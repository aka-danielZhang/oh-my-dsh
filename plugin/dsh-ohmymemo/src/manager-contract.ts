/**
 * JSON and durable-record schemas shared by the OhMyMemo Host manager,
 * Typert descriptors, and browser UI.
 * @module dsh-ohmymemo/manager-contract
 */

import { z } from 'zod'

export const dreamRunStatusSchema = z.enum(['idle', 'running', 'success', 'error', 'cancelled'])
export type DreamRunStatus = z.infer<typeof dreamRunStatusSchema>

export const dreamRunSummarySchema = z.object({
  runId: z.string(),
  trigger: z.enum(['manual', 'scheduled', 'catch-up']),
  startedAt: z.number(),
  finishedAt: z.number(),
  status: z.enum(['success', 'error', 'cancelled']),
  sourceSessions: z.number().int().nonnegative(),
  sourceMessages: z.number().int().nonnegative(),
  candidatesCreated: z.number().int().nonnegative(),
  candidatesRejected: z.number().int().nonnegative(),
  detail: z.string().nullable(),
}).strict()
export type DreamRunSummary = z.infer<typeof dreamRunSummarySchema>

export const dreamRuntimeStateSchema = z.object({
  version: z.literal(1),
  status: dreamRunStatusSchema,
  activeRunId: z.string().nullable(),
  activeJobId: z.string().nullable(),
  activeTrigger: z.enum(['manual', 'scheduled', 'catch-up']).nullable().default(null),
  lastAttemptAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastScheduledFor: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastResult: dreamRunSummarySchema.nullable(),
  cursors: z.record(z.string(), z.number().int().nonnegative()),
}).strict()
export type DreamRuntimeState = z.infer<typeof dreamRuntimeStateSchema>

export const dreamRunAuditSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  trigger: z.enum(['manual', 'scheduled', 'catch-up']),
  scheduledFor: z.number().nullable(),
  startedAt: z.number(),
  finishedAt: z.number(),
  status: z.enum(['success', 'error', 'cancelled']),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  promptHash: z.string().nullable(),
  sourceSessions: z.array(z.object({
    sessionId: z.string(),
    /** Longest contiguous fitted seq prefix; null when nothing advanced. */
    capturedThroughSeq: z.number().int().nonnegative().nullable(),
    messageCount: z.number().int().nonnegative(),
  }).strict()),
  candidatesCreated: z.array(z.string()),
  candidatesRejected: z.number().int().nonnegative(),
  detail: z.string().nullable(),
}).strict()
export type DreamRunAudit = z.infer<typeof dreamRunAuditSchema>

export const memoryFileSchema = z.object({
  path: z.string(),
  name: z.string(),
  label: z.string(),
  kind: z.enum(['memory', 'view']),
  bytes: z.number().int().nonnegative(),
  mtimeMs: z.number(),
  hash: z.string(),
  record: z.object({
    id: z.string(),
    scope: z.string(),
    kind: z.enum(['semantic', 'episodic', 'procedural']),
    status: z.enum(['candidate', 'active', 'disputed', 'superseded']),
    privacy: z.enum(['normal', 'sensitive', 'secret-ref']),
    quarantined: z.boolean(),
  }).strict().optional(),
}).strict()

export const memoryTreeSchema = z.object({
  generation: z.string(),
  files: z.array(memoryFileSchema),
  truncated: z.boolean(),
}).strict()
export type MemoryTreeSnapshot = z.infer<typeof memoryTreeSchema>

export const memoryDocumentSchema = z.object({
  path: z.string(),
  title: z.string(),
  markdown: z.string(),
  redacted: z.boolean(),
  hash: z.string(),
  mtimeMs: z.number(),
  meta: z.object({
    id: z.string().optional(),
    revision: z.number().int().positive().optional(),
    scope: z.string().optional(),
    kind: z.enum(['semantic', 'episodic', 'procedural']).optional(),
    status: z.enum(['candidate', 'active', 'disputed', 'superseded']).optional(),
    tags: z.array(z.string()).optional(),
  }).strict(),
}).strict()
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>

export const memoryOverviewSchema = z.object({
  configRevision: z.string(),
  dream: z.object({
    enabled: z.boolean(),
    scheduleLocalTime: z.string(),
    timeZone: z.string(),
    status: dreamRunStatusSchema,
    activeJobId: z.string().nullable(),
    lastAttemptAt: z.number().nullable(),
    lastSuccessAt: z.number().nullable(),
    nextRunAt: z.number().nullable(),
    lastResult: dreamRunSummarySchema.nullable(),
  }).strict(),
  watch: z.object({
    active: z.boolean(),
    degradedReason: z.string().nullable(),
  }).strict(),
  counts: z.object({
    active: z.number().int().nonnegative(),
    candidate: z.number().int().nonnegative(),
    disputed: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(),
    quarantined: z.number().int().nonnegative(),
    tombstones: z.number().int().nonnegative(),
    scopes: z.number().int().nonnegative(),
  }).strict(),
  files: z.object({
    count: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
}).strict()
export type MemoryOverview = z.infer<typeof memoryOverviewSchema>

export const updateDreamSettingsRequestSchema = z.object({
  ifRevision: z.string(),
  enabled: z.boolean().optional(),
  scheduleLocalTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u).optional(),
}).strict().refine(value => value.enabled !== undefined || value.scheduleLocalTime !== undefined, {
  message: 'at least one dream setting is required',
})
export type UpdateDreamSettingsRequest = z.infer<typeof updateDreamSettingsRequestSchema>

export const readMemoryFileRequestSchema = z.object({
  path: z.string().min(1),
  generation: z.string().min(1),
}).strict()
export type ReadMemoryFileRequest = z.infer<typeof readMemoryFileRequestSchema>

export const runNowResultSchema = z.object({
  started: z.boolean(),
  jobId: z.string().optional(),
  reason: z.enum(['disabled', 'already-running']).optional(),
}).strict()
export type RunNowResult = z.infer<typeof runNowResultSchema>

export const cancelRunResultSchema = z.object({ cancelled: z.boolean() }).strict()
export type CancelRunResult = z.infer<typeof cancelRunResultSchema>
