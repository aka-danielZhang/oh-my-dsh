/**
 * The Quno public contract: event envelopes, batch submission, collector
 * declarations, configuration, attention commands and run output.
 *
 * Everything crossing a trust boundary is validated here, before a store
 * transaction starts. These schemas are also the single source the collector
 * plugins are written against (`dsh-quno/contracts`) — the Host rejects a
 * declaration or batch the schema does not accept instead of half-using it.
 *
 * @module dsh-quno/contracts
 */

import { z } from 'zod'
import type {
  AttentionStatus,
  CollectorDefinition,
  CollectorHealthDetail,
  CollectorHealthState,
  DayRange,
  EventEnvelope,
  IngestBatch,
  QunoConfig,
  RunOutput,
} from './types.ts'

/** Hard ingress limits for the first release (calibrated against real load later). */
export const LIMITS = {
  maxEventBytes: 64 * 1024,
  maxBatchEvents: 100,
  maxBatchBytes: 1024 * 1024,
  maxSummaryChars: 800,
  maxDataDepth: 16,
  maxBatchKeyChars: 200,
  maxEventKeyChars: 200,
  // Keyed checkpoint entries (`checkpoint-entries/v1`, redesign §5): per-patch
  // and per-entry budgets. Storage capacity itself lives on the store.
  maxPatchEntries: 200,
  // The v2→v3 migration snapshot entry carries the whole legacy blob; align
  // with the root checkpoint ceiling. Session entries stay well under this.
  maxPatchEntryBytes: 200_000,
  maxPatchEntryKeyChars: 200,
} as const

/** The only accepted collector contract version. */
export const COLLECTOR_CONTRACT_VERSION = 'quno.collector/v2' as const

export const eventOperationSchema = z.enum(['upsert', 'delete', 'retract'])
export const prioritySchema = z.enum(['p0', 'p1', 'p2', 'p3'])
export const attentionStatusSchema = z.enum(['open', 'waiting', 'snoozed', 'resolved', 'dismissed', 'expired'])
export const collectorHealthSchema = z.enum(['healthy', 'degraded', 'rate-limited', 'auth-required', 'unavailable', 'unknown'])

const isoDate = z.string().refine(value => !Number.isNaN(Date.parse(value)), 'expected an ISO-8601 timestamp')
const optionalIsoDate = z.union([isoDate, z.null()]).optional()

const provenanceInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('observed'),
    collector: z.string().max(200).optional(),
  }),
  z.object({
    kind: z.literal('derived'),
    inputs: z.array(z.object({
      eventId: z.string().max(200).optional(),
      eventKey: z.string().max(LIMITS.maxEventKeyChars).optional(),
    }).refine(value => value.eventId !== undefined || value.eventKey !== undefined, {
      message: 'a derived input needs eventId or eventKey',
    })).min(1).max(100),
    processor: z.string().min(1).max(200),
    coverage: z.string().min(1).max(400),
    confidence: z.number().min(0).max(1).optional(),
  }),
])

/** One event envelope (`quno.event/v1`). */
export const eventEnvelopeSchema = z.object({
  eventKey: z.string().min(1).max(LIMITS.maxEventKeyChars),
  type: z.string().min(1).max(200),
  schema: z.string().min(1).max(200).optional(),
  subject: z.object({
    key: z.string().min(1).max(400),
    revision: z.string().max(200).optional(),
    label: z.string().max(300).optional(),
  }).optional(),
  operation: eventOperationSchema.optional(),
  occurredAt: optionalIsoDate,
  observedAt: isoDate.optional(),
  summary: z.string().max(LIMITS.maxSummaryChars).optional(),
  data: z.unknown().optional(),
  priority: prioritySchema.optional(),
  deadline: optionalIsoDate,
  provenance: provenanceInputSchema.optional(),
  correlationKeys: z.array(z.string().min(1).max(200)).max(50).optional(),
  supersedesEventIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  parentEventIds: z.array(z.string().min(1).max(200)).max(50).optional(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(300),
    mediaType: z.string().min(1).max(200),
    ref: z.string().min(1).max(2000),
    sha256: z.string().max(128).optional(),
    bytes: z.number().int().nonnegative().optional(),
  })).max(20).optional(),
  expiresAt: optionalIsoDate,
  // Source-bound authorship and admission hints. Without these the engine
  // sees every trigger as anonymous bot traffic — @mentions and direct
  // messages lose their explicit strength (found by the link evaluator).
  actor: z.object({
    source: z.string().min(1).max(200),
    id: z.string().max(200),
  }).optional(),
  human: z.boolean().optional(),
  addressed: z.enum(['mention', 'direct']).nullable().optional(),
  channel: z.object({
    source: z.string().min(1).max(200),
    thread: z.string().min(1).max(400),
    address: z.record(z.string(), z.string().max(400)),
  }).nullable().optional(),
  contentRef: z.union([
    z.object({ kind: z.literal('session-message'), sessionId: z.string().min(1).max(200), messageId: z.string().min(1).max(200) }),
    z.object({ kind: z.literal('session-seq'), sessionId: z.string().min(1).max(200), seq: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('quno-event'), eventId: z.string().min(1).max(200) }),
    z.object({ kind: z.literal('blob'), ref: z.string().min(1).max(2000), sha256: z.string().max(128).optional() }),
  ]).nullable().optional(),
})

/** One batch submission. */
export const ingestBatchSchema = z.object({
  batchKey: z.string().min(1).max(LIMITS.maxBatchKeyChars),
  events: z.array(eventEnvelopeSchema).max(LIMITS.maxBatchEvents),
  checkpointAfter: z.union([
    z.object({
      value: z.union([z.string().max(200_000), z.null()]),
      revision: z.number().int().nonnegative(),
    }),
    z.null(),
  ]).optional(),
  gap: z.union([
    z.object({
      from: z.string().max(400).optional(),
      to: z.string().max(400).optional(),
      reason: z.string().min(1).max(1000),
    }),
    z.null(),
  ]).optional(),
  // `checkpoint-entries/v1`: keyed state entries committed in the SAME
  // transaction as the events, the root checkpoint and the batch receipt.
  checkpointPatch: z.object({
    upserts: z.array(z.object({
      key: z.string().min(1).max(LIMITS.maxPatchEntryKeyChars),
      value: z.string().min(1).max(LIMITS.maxPatchEntryBytes),
    })).max(LIMITS.maxPatchEntries).optional(),
    deletes: z.array(z.string().min(1).max(LIMITS.maxPatchEntryKeyChars)).max(LIMITS.maxPatchEntries).optional(),
  }).optional(),
})

const configFieldSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  type: z.enum(['string', 'path', 'url', 'number', 'boolean']),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  placeholder: z.string().max(300).optional(),
  help: z.string().max(1000).optional(),
  defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().positive().optional(),
  options: z.array(z.object({
    value: z.string().min(1).max(400),
    label: z.string().min(1).max(300),
    description: z.string().max(400).optional(),
  })).max(200).optional(),
  multiple: z.boolean().optional(),
  discover: z.boolean().optional(),
  advanced: z.boolean().optional(),
}).superRefine((field, ctx) => {
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    ctx.addIssue({ code: 'custom', path: ['min'], message: 'min must not exceed max' })
  }
  if (field.options !== undefined && field.discover === true) {
    ctx.addIssue({ code: 'custom', path: ['discover'], message: 'a field chooses static options or discovery, not both' })
  }
  if (field.discover === true && field.type !== 'string') {
    ctx.addIssue({ code: 'custom', path: ['discover'], message: 'only string fields can discover their options' })
  }
})

const relativeSeconds = z.number().int().nonnegative()

/** A collector's declaration, validated before it may register. */
export const collectorDefinitionSchema = z.object({
  type: z.string().min(3).max(200),
  contractVersion: z.literal(COLLECTOR_CONTRACT_VERSION),
  implementationVersion: z.string().min(1).max(50),
  displayName: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  eventTypes: z.array(z.object({
    type: z.string().min(1).max(200),
    summary: z.string().max(500).optional(),
  })).max(200),
  configFields: z.array(configFieldSchema).max(100).optional(),
  permissions: z.object({
    reads: z.array(z.string().min(1).max(400)).max(100),
    credentialKinds: z.array(z.string().max(100)).max(20).optional(),
    network: z.array(z.string().max(400)).max(50).optional(),
    mcp: z.array(z.string().max(400)).max(50).optional(),
    requiresModel: z.boolean().optional(),
  }),
  schedule: z.object({
    defaultIntervalSec: z.number().int().min(1).max(86_400),
    minIntervalSec: z.number().int().min(1).max(86_400),
    maxRunMs: z.number().int().min(1000).max(600_000),
    quotas: z.object({
      maxEventsPerRun: z.number().int().min(1).max(10_000).optional(),
      maxBytesPerRun: z.number().int().min(1024).max(100 * 1024 * 1024).optional(),
    }).optional(),
  }),
  reliability: z.object({
    checkpoint: z.enum(['cursor', 'snapshot', 'none']),
    replay: z.object({
      kind: z.enum(['bounded', 'none']),
      windowSec: relativeSeconds.optional(),
    }),
    changeCoverage: z.enum(['all-changes', 'snapshot-diff', 'sampled']),
    gapDetection: z.enum(['explicit', 'partial', 'none']),
    readOriginal: z.boolean(),
  }),
  firstSync: z.enum(['baseline-only', 'snapshot-events', 'current-window-events', 'unknown']).optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
  // Query capabilities carry functions (handleRequest); they pass through
  // unvalidated. Without this field zod stripped the whole query surface at
  // registration, silently disabling exchanges for every query-capable
  // collector (found by the link evaluator).
  query: z.unknown().optional(),
}).superRefine((definition, ctx) => {
  if (definition.schedule.minIntervalSec > definition.schedule.defaultIntervalSec) {
    ctx.addIssue({
      code: 'custom',
      path: ['schedule', 'minIntervalSec'],
      message: 'minIntervalSec must not exceed defaultIntervalSec',
    })
  }
  if (definition.reliability.checkpoint === 'none' && definition.reliability.replay.kind !== 'none') {
    ctx.addIssue({
      code: 'custom',
      path: ['reliability', 'replay'],
      message: 'a collector without a checkpoint cannot promise replay',
    })
  }
})

/** One structured issue inside a run's health extras. */
export const collectorHealthIssueSchema = z.object({
  code: z.string().min(1).max(100),
  detail: z.string().min(1).max(400),
  count: z.number().int().nonnegative().optional(),
})

/** Structured queue progress carried through to the UI unchanged. */
export const collectorHealthProgressSchema = z.object({
  trackedConversations: z.number().int().nonnegative().optional(),
  pendingConversations: z.number().int().nonnegative().optional(),
  blockedConversations: z.number().int().nonnegative().optional(),
  oldestPendingAt: z.number().int().nullable().optional(),
  lastDirectoryProgressAt: z.number().int().nullable().optional(),
  lastSweepCompletedAt: z.number().int().nullable().optional(),
  nextDiscoveryPage: z.number().int().nonnegative().optional(),
  requestBudgetPerMinute: z.number().int().nonnegative().optional(),
  checkpointEntries: z.number().int().nonnegative().optional(),
}).passthrough()

/** Classified failure states of one run; the Host owns the backoff. */
export const collectorFailureStateSchema = z.enum(['auth-required', 'rate-limited', 'unavailable', 'degraded'])

/**
 * Health extras a run returns on top of what the Host derives itself
 * (state, code, consecutiveFailures, nextRetryAt, lastAttemptAt/Success/Event).
 * The Host cannot know these — coverage markers, source lag, queue progress.
 */
export const collectorHealthExtrasSchema = z.object({
  detail: z.string().max(2000).optional(),
  coveredThrough: z.string().max(400).nullable().optional(),
  sourceLagSec: z.number().int().nonnegative().nullable().optional(),
  progress: collectorHealthProgressSchema.optional(),
  issues: z.array(collectorHealthIssueSchema).max(50).optional(),
})

const dayRangeSchema = z.object({
  /** `HH:MM` in the Quno zone. */
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
})

/** Default policy: meaningful changes only, quiet 22:00–08:00, conservative budgets. */
export const DEFAULT_QUNO_CONFIG: QunoConfig = {
  enabled: true,
  checkIntervalSec: 300,
  timeZone: 'Asia/Shanghai',
  activeHours: null,
  quietHours: { start: '22:00', end: '08:00' },
  notificationPolicy: {
    mode: 'meaningful',
    minGapSec: 600,
    maxPerHour: 3,
    allowUrgentWake: false,
    urgentMayBreakQuietHours: false,
  },
  budget: {
    dailyModelRuns: 100,
    maxEventsPerRun: 100,
    maxContextChars: 48_000,
    maxOutputTokens: 3000,
    runTimeoutSec: 120,
    maxToolCalls: 8,
  },
  retention: {
    eventBodyDays: 30,
    runDiagnosticsDays: 14,
    noticeDays: 30,
  },
  dryRun: false,
  acceptMode: 'observe',
  autoSourceIds: [],
}

export const qunoConfigSchema = z.object({
  enabled: z.boolean(),
  checkIntervalSec: z.number().int().min(1).max(86_400),
  timeZone: z.string().min(1).max(100).refine((value) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: value }).format(new Date())
      return true
    } catch {
      return false
    }
  }, 'unknown IANA time zone'),
  activeHours: z.union([dayRangeSchema, z.null()]),
  quietHours: z.union([dayRangeSchema, z.null()]),
  notificationPolicy: z.object({
    mode: z.enum(['meaningful', 'every-run']),
    minGapSec: z.number().int().nonnegative().max(86_400),
    maxPerHour: z.number().int().min(1).max(100),
    allowUrgentWake: z.boolean(),
    urgentMayBreakQuietHours: z.boolean(),
  }),
  budget: z.object({
    dailyModelRuns: z.number().int().min(1).max(10_000),
    maxEventsPerRun: z.number().int().min(1).max(1000),
    maxContextChars: z.number().int().min(2000).max(500_000),
    maxOutputTokens: z.number().int().min(256).max(32_000),
    runTimeoutSec: z.number().int().min(10).max(1800),
    maxToolCalls: z.number().int().min(0).max(64),
  }),
  retention: z.object({
    eventBodyDays: z.number().int().min(1).max(3650),
    runDiagnosticsDays: z.number().int().min(1).max(3650),
    noticeDays: z.number().int().min(1).max(3650),
  }),
  dryRun: z.boolean(),
  acceptMode: z.enum(['off', 'observe', 'auto']),
  autoSourceIds: z.array(z.string().min(1).max(200)).max(50),
})

/** Run output — the only shape the runner accepts as a commit candidate. */
export const runOutputSchema = z.object({
  eventDecisions: z.array(z.object({
    eventId: z.string().min(1).max(200),
    decision: z.enum(['processed', 'irrelevant', 'superseded', 'deferred']),
    reason: z.string().max(1000).optional(),
    deferredUntil: z.number().int().optional(),
  })).max(500),
  attentionChanges: z.array(z.object({
    action: z.enum(['create', 'update', 'resolve', 'dismiss', 'expire', 'wait', 'snooze']),
    itemId: z.string().max(200).optional(),
    topicKey: z.string().min(1).max(300),
    expectedRevision: z.number().int().nonnegative().optional(),
    title: z.string().max(200).optional(),
    summary: z.string().max(4000).optional(),
    status: attentionStatusSchema.optional(),
    material: z.boolean().optional(),
    evidence: z.array(z.object({
      eventId: z.string().max(200).optional(),
      itemId: z.string().max(200).optional(),
      quote: z.string().max(2000).optional(),
      capturedAt: z.number().int().optional(),
      contentHash: z.string().max(128).optional(),
    })).max(50).optional(),
    nextReviewAt: z.number().int().nullable().optional(),
    snoozedUntil: z.number().int().nullable().optional(),
    subjectRefs: z.array(z.string().max(400)).max(50).optional(),
  })).max(200),
  notificationCandidates: z.array(z.object({
    topicKey: z.string().min(1).max(300),
    itemIds: z.array(z.string().max(200)).max(50).optional(),
    reason: z.string().min(1).max(1000),
    kind: z.enum(['update', 'reminder']).optional(),
    reminderStage: z.number().int().nonnegative().max(100).optional(),
    body: z.string().max(6000).optional(),
    title: z.string().max(200).optional(),
  })).max(50),
  uncertainties: z.array(z.string().max(500)).max(50),
})

/** Feedback command submitted by a button or a management tool. */
export const attentionActSchema = z.object({
  itemId: z.string().min(1).max(200),
  action: z.enum(['processed', 'later', 'dismiss', 'resume', 'clarify']),
  expectedRevision: z.number().int().nonnegative().optional(),
  snoozeMinutes: z.number().int().min(1).max(100_000).optional(),
  note: z.string().max(2000).optional(),
})

export type ParsedEventEnvelope = EventEnvelope
export type ParsedIngestBatch = IngestBatch
export type ParsedCollectorDefinition = CollectorDefinition
export type ParsedRunOutput = RunOutput
export type AttentionAct = z.infer<typeof attentionActSchema>
export type CollectorHealthExtras = z.infer<typeof collectorHealthExtrasSchema>
export type CollectorFailureState = z.infer<typeof collectorFailureStateSchema>

/** A validation failure that is safe to hand back to a collector or a model. */
export interface ContractFailure {
  readonly code: string
  readonly message: string
  readonly index?: number
}

/** Validation result used at every ingress/registration boundary. */
export type ContractResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractFailure }

function flatten(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

/** Parse a batch, reporting the first offending event index. */
export function parseIngestBatch(input: unknown): ContractResult<IngestBatch> {
  const parsed = ingestBatchSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const index = issue?.path[0] === 'events' && typeof issue.path[1] === 'number' ? issue.path[1] : undefined
    return {
      ok: false,
      error: {
        code: 'validation',
        message: flatten(parsed.error),
        ...(index === undefined ? {} : { index }),
      },
    }
  }
  const batch = parsed.data as IngestBatch
  if (batch.events.length === 0 && batch.checkpointAfter == null) {
    return { ok: false, error: { code: 'validation', message: 'an empty batch must advance a checkpoint' } }
  }
  const bytes = Buffer.byteLength(JSON.stringify(batch))
  if (bytes > LIMITS.maxBatchBytes) {
    return {
      ok: false,
      error: { code: 'validation', message: `batch is ${String(bytes)} bytes; limit is ${String(LIMITS.maxBatchBytes)}` },
    }
  }
  for (const [index, event] of batch.events.entries()) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event))
    if (eventBytes > LIMITS.maxEventBytes) {
      return {
        ok: false,
        error: {
          code: 'validation',
          message: `event is ${String(eventBytes)} bytes; limit is ${String(LIMITS.maxEventBytes)}`,
          index,
        },
      }
    }
    if ((event.summary === undefined || event.summary.trim() === '')
      && event.data === undefined
      && event.operation !== 'retract'
      && event.operation !== 'delete') {
      return {
        ok: false,
        error: { code: 'validation', message: 'an upsert needs summary or data', index },
      }
    }
  }
  return { ok: true, value: batch }
}

/** Parse one collector declaration. */
export function parseCollectorDefinition(input: unknown): ContractResult<CollectorDefinition> {
  const parsed = collectorDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'validation', message: flatten(parsed.error) } }
  }
  return { ok: true, value: parsed.data as CollectorDefinition }
}

/** Parse one run's health extras (never a lifecycle transition). */
export function parseHealthExtras(input: unknown): ContractResult<CollectorHealthExtras> {
  const parsed = collectorHealthExtrasSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'validation', message: flatten(parsed.error) } }
  }
  return { ok: true, value: parsed.data }
}

/** Parse one run output with the configured caps applied. */
export function parseRunOutput(input: unknown, budget: { readonly maxEventsPerRun: number }): ContractResult<RunOutput> {
  const parsed = runOutputSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'validation', message: flatten(parsed.error) } }
  }
  if (parsed.data.attentionChanges.length > budget.maxEventsPerRun * 2 + 20) {
    return { ok: false, error: { code: 'validation', message: 'too many attention changes for one run' } }
  }
  return { ok: true, value: parsed.data as RunOutput }
}

/** Parse a user-facing config update. Unknown keys are rejected (zod strips by default, so guard by key set). */
export function parseQunoConfig(input: unknown): ContractResult<QunoConfig> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: { code: 'validation', message: 'config must be an object' } }
  }
  const parsed = qunoConfigSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'validation', message: flatten(parsed.error) } }
  }
  const config = parsed.data as QunoConfig
  if (config.checkIntervalSec < 60 && process.env.QUNO_ALLOW_FAST_TICKS !== '1') {
    return { ok: false, error: { code: 'validation', message: 'checkIntervalSec must be at least 60' } }
  }
  return { ok: true, value: config }
}

/** Merge a partial config update over the current value, then validate. */
export function mergeQunoConfig(current: QunoConfig, patch: unknown): ContractResult<QunoConfig> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: { code: 'validation', message: 'config patch must be an object' } }
  }
  const currentRecord = current as unknown as Record<string, unknown>
  const patchRecord = patch as Record<string, unknown>
  const next = { ...currentRecord, ...patchRecord } as Record<string, unknown>
  if (isRecord(currentRecord['notificationPolicy']) && isRecord(patchRecord['notificationPolicy'])) {
    next['notificationPolicy'] = { ...currentRecord['notificationPolicy'], ...patchRecord['notificationPolicy'] }
  }
  if (isRecord(currentRecord['budget']) && isRecord(patchRecord['budget'])) {
    next['budget'] = { ...currentRecord['budget'], ...patchRecord['budget'] }
  }
  if (isRecord(currentRecord['retention']) && isRecord(patchRecord['retention'])) {
    next['retention'] = { ...currentRecord['retention'], ...patchRecord['retention'] }
  }
  return parseQunoConfig(next)
}

/** Narrow an unknown value to a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse a day range out of an unknown value (used by settings UI patch paths). */
export function parseDayRange(input: unknown): ContractResult<DayRange | null> {
  const parsed = z.union([dayRangeSchema, z.null()]).safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: { code: 'validation', message: flatten(parsed.error) } }
  }
  return { ok: true, value: parsed.data as DayRange | null }
}

/** Health states ordered by severity for the UI's worst-first summary. */
export const HEALTH_SEVERITY: readonly CollectorHealthState[] = [
  'unknown',
  'healthy',
  'degraded',
  'rate-limited',
  'auth-required',
  'unavailable',
]

/** Attention statuses that still need the user's eventual decision. */
export const ACTIVE_ATTENTION: readonly AttentionStatus[] = ['open', 'waiting', 'snoozed']
