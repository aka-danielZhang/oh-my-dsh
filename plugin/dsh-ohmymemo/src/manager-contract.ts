/**
 * JSON and durable-record schemas shared by the OhMyMemo Host manager,
 * Typert descriptors, and browser UI.
 * @module dsh-ohmymemo/manager-contract
 */

import { z } from 'zod'

export const dreamRunStatusSchema = z.enum(['idle', 'running', 'success', 'error', 'cancelled'])
export type DreamRunStatus = z.infer<typeof dreamRunStatusSchema>

/**
 * How one legacy extractor response was read. Orthogonal to the turn end
 * reason and to {@link dreamRunSummarySchema}'s `truncated`: a format fallback
 * is never evidence of a capacity truncation (2026-09-13 note §4.1).
 */
export const dreamOutputFormatSchema = z.enum(['bare-json', 'json-fence', 'prefix-salvage', 'invalid'])
export type DreamOutputFormat = z.infer<typeof dreamOutputFormatSchema>

export const dreamRunSummarySchema = z.object({
  runId: z.string(),
  trigger: z.enum(['manual', 'scheduled', 'catch-up']),
  startedAt: z.number(),
  finishedAt: z.number(),
  status: z.enum(['success', 'error', 'cancelled']),
  sourceSessions: z.number().int().nonnegative(),
  sourceMessages: z.number().int().nonnegative(),
  memoriesCreated: z.number().int().nonnegative(),
  memoriesRejected: z.number().int().nonnegative(),
  /** Bounded copy of what this run created, for the UI result card. Older
   *  persisted runs predate the field; they default to an empty list so a
   *  stored record never blocks boot after an upgrade. */
  items: z.array(z.object({
    key: z.string(),
    kind: z.enum(['semantic', 'episodic', 'procedural']),
    content: z.string(),
  }).strict()).default([]),
  /** Why the extraction turn stopped, verbatim from `turn/end.reason.kind`.
   *  Null on records persisted before structured classification existed: null
   *  means "unknown", never "completed". */
  turnEndReason: z.string().nullable().default(null),
  /** How the final assistant text was read. Null on older records — see
   *  {@link isLegacyAmbiguousOutput} before trusting their `truncated` flag. */
  outputFormat: dreamOutputFormatSchema.nullable().default(null),
  /** The body needed format normalization (Markdown fence) before it parsed. */
  formatRecovered: z.boolean().default(false),
  /** The body was one complete JSON document; false for prefix salvage. */
  outputComplete: z.boolean().default(false),
  /** Complete item objects recovered by prefix salvage (0 when not used). */
  salvagedItems: z.number().int().nonnegative().default(0),
  /** True only when the turn itself ended at the model's max-token ceiling.
   *  Never derived from a parser fallback path. Older persisted runs predate
   *  the field; they default to false so a stored record never blocks boot. */
  truncated: z.boolean().default(false),
  /** Deterministic lifecycle maintenance counts (nightly no-LLM segment).
   *  Older persisted runs predate the fields; they default to 0 so a stored
   *  record never blocks boot after an upgrade. */
  expiredMemories: z.number().int().nonnegative().default(0),
  expiredCandidates: z.number().int().nonnegative().default(0),
  /** Curator (auto_consolidation) counts; older runs default to 0. */
  curatorRefreshed: z.number().int().nonnegative().default(0),
  curatorMerged: z.number().int().nonnegative().default(0),
  curatorRejected: z.number().int().nonnegative().default(0),
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
  /** Deterministic output-failure streak on the current evidence window,
   *  feeding the dead-letter cursor advance. Older persisted state predates
   *  the field; it defaults to null so a stored record never blocks boot. */
  failureStreak: z.object({
    promptHash: z.string(),
    count: z.number().int().positive(),
  }).strict().nullable().default(null),
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
  memoriesCreated: z.array(z.string()),
  memoriesRejected: z.number().int().nonnegative(),
  /** Structured output classification; mirrors the run summary fields and is
   *  null-able for audits persisted before it existed. */
  turnEndReason: z.string().nullable().default(null),
  outputFormat: dreamOutputFormatSchema.nullable().default(null),
  formatRecovered: z.boolean().default(false),
  outputComplete: z.boolean().default(false),
  salvagedItems: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
  /** Lifecycle maintenance counts; older persisted audits default to 0. */
  expiredMemories: z.number().int().nonnegative().default(0),
  expiredCandidates: z.number().int().nonnegative().default(0),
  /** Curator (auto_consolidation) counts; older persisted audits default to 0. */
  curatorRefreshed: z.number().int().nonnegative().default(0),
  curatorMerged: z.number().int().nonnegative().default(0),
  curatorRejected: z.number().int().nonnegative().default(0),
  detail: z.string().nullable(),
}).strict()
export type DreamRunAudit = z.infer<typeof dreamRunAuditSchema>

/**
 * A persisted record predating structured classification: its `truncated`
 * flag came from the legacy parser fallback, which also fired on fenced JSON,
 * so it must never be counted as a real capacity truncation. Trustworthy
 * truncation rates start with runs that carry `turnEndReason` (note §5.1).
 */
export function isLegacyAmbiguousOutput(record: {
  turnEndReason: string | null
  truncated: boolean
}): boolean {
  return record.turnEndReason === null && record.truncated
}

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
    status: z.enum(['candidate', 'active', 'disputed', 'superseded', 'expired']),
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
    status: z.enum(['candidate', 'active', 'disputed', 'superseded', 'expired']).optional(),
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
    /** Effective extraction route: config override, else the harness default. */
    modelProvider: z.string(),
    model: z.string(),
    effort: z.string(),
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
    /** Lifecycle-expired records (valid_until passed or silence past the
     *  decay horizon). Older persisted overviews predate the field; default
     *  0 keeps stored records bootable after an upgrade. */
    expired: z.number().int().nonnegative().default(0),
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
  // `''` clears the override (back to the harness default), so no min(1):
  // a min-length rule made "follow default" unpickable once set.
  modelProvider: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  effort: z.string().max(200).optional(),
}).strict().refine(value =>
  value.enabled !== undefined
  || value.scheduleLocalTime !== undefined
  || value.modelProvider !== undefined
  || value.model !== undefined
  || value.effort !== undefined, {
  message: 'at least one dream setting is required',
})
export type UpdateDreamSettingsRequest = z.infer<typeof updateDreamSettingsRequestSchema>

/** Model/effort picker catalog for the dream-extraction route. */
export const dreamModelsSchema = z.object({
  /** Harness default route used when no override is configured. */
  defaultRoute: z.object({ provider: z.string(), model: z.string() }).strict(),
  /** Selectable routes; `default` follows {@link defaultRoute}, others are `provider/model`. */
  options: z.array(z.object({ key: z.string(), label: z.string() }).strict()),
  /** Efforts the effective route exposes; `default` follows the route default. */
  efforts: z.array(z.object({ key: z.string(), label: z.string() }).strict()),
  /** Current picker keys: `default` or an exact option/effort key. */
  currentModelKey: z.string(),
  currentEffortKey: z.string(),
}).strict()
export type DreamModelsSnapshot = z.infer<typeof dreamModelsSchema>

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
