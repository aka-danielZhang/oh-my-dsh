/**
 * Versioned durable records and wire projections for scheduled tasks.
 *
 * Three audiences share one module so the shapes cannot drift:
 * - the Storage Domain tables (`tasks` / `runtime` / `runs`, see ./domain.ts),
 * - the Typert Remote schemas the browser half mounts (see
 *   ./typert.remote-client.ts),
 * - and the managed-task projection other plugins register against
 *   (`registerManaged`, see ./index.ts).
 *
 * Every persisted record is `.strict()` with an explicit `version` literal;
 * unknown versions or broken records are quarantined by the storage domain
 * and fail visible (design §10). Wire payloads are owned JSON: no live
 * objects, no internal paths beyond what the settings page already shows.
 * @module dsh-scheduled-tasks/contract
 */

import { z } from 'zod'
import { parseLocalTime, type ScheduleRule } from './schedule.ts'

/** Activity of one task beyond its enabled/paused schedule state. */
export const taskActivitySchema = z.enum([
  'idle',
  'running',
  'waiting-input',
  'success',
  'error',
  'cancelled',
  'skipped',
  'unavailable',
])
export type TaskActivity = z.infer<typeof taskActivitySchema>

/** What a previous attempt of one boundary ended as. */
export const taskOutcomeSchema = z.enum(['success', 'error', 'cancelled', 'skipped'])
export type TaskOutcome = z.infer<typeof taskOutcomeSchema>

/** Last settled attempt, projected for the UI (no instruction content). */
export const taskRunSummarySchema = z.object({
  runId: z.string(),
  trigger: z.enum(['scheduled', 'catch-up', 'manual']),
  finishedAt: z.number(),
  status: taskOutcomeSchema,
  detail: z.string().nullable(),
}).strict()
export type TaskRunSummary = z.infer<typeof taskRunSummarySchema>

/** Strict `HH:mm`, 24-hour. */
const localTimeField = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
/** Minute of hour for the `hourly` kind. */
const minuteField = z.number().int().min(0).max(59)
/** ISO weekday, 1 = Monday … 7 = Sunday. */
const dayOfWeekField = z.number().int().min(1).max(7)
/** Day of month; months without that date are skipped, never clamped. */
const dayOfMonthField = z.number().int().min(1).max(31)
/** IANA Area/Location the boundary math interprets wall times in. */
const timeZoneField = z.string().min(1)

/** How a schedule's zone relates to this host (managed tasks only). */
const timeZonePolicyField = z.enum(['fixed-iana', 'host-local'])

/**
 * Schedule pinned to an explicit IANA zone at creation time. The `daily`
 * member keeps the original v1 field set (`localTime` + `timeZone`), so
 * records persisted before the five-kind extension still parse unchanged.
 */
export const taskScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly'), minute: minuteField, timeZone: timeZoneField }).strict(),
  z.object({ kind: z.literal('daily'), localTime: localTimeField, timeZone: timeZoneField }).strict(),
  z.object({ kind: z.literal('weekdays'), localTime: localTimeField, timeZone: timeZoneField }).strict(),
  z.object({
    kind: z.literal('weekly'),
    dayOfWeek: dayOfWeekField,
    localTime: localTimeField,
    timeZone: timeZoneField,
  }).strict(),
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: dayOfMonthField,
    localTime: localTimeField,
    timeZone: timeZoneField,
  }).strict(),
])
export type TaskSchedule = z.infer<typeof taskScheduleSchema>

/** The kind-specific half a wire request carries (the zone travels beside it). */
export const scheduleSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly'), minute: minuteField }).strict(),
  z.object({ kind: z.literal('daily'), localTime: localTimeField }).strict(),
  z.object({ kind: z.literal('weekdays'), localTime: localTimeField }).strict(),
  z.object({ kind: z.literal('weekly'), dayOfWeek: dayOfWeekField, localTime: localTimeField }).strict(),
  z.object({ kind: z.literal('monthly'), dayOfMonth: dayOfMonthField, localTime: localTimeField }).strict(),
])
export type ScheduleSpec = z.infer<typeof scheduleSpecSchema>

/** Managed-task schedule: the same rule plus its zone provenance. */
export const managedScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly'), minute: minuteField, timeZone: timeZoneField, timeZonePolicy: timeZonePolicyField }).strict(),
  z.object({ kind: z.literal('daily'), localTime: localTimeField, timeZone: timeZoneField, timeZonePolicy: timeZonePolicyField }).strict(),
  z.object({ kind: z.literal('weekdays'), localTime: localTimeField, timeZone: timeZoneField, timeZonePolicy: timeZonePolicyField }).strict(),
  z.object({
    kind: z.literal('weekly'),
    dayOfWeek: dayOfWeekField,
    localTime: localTimeField,
    timeZone: timeZoneField,
    timeZonePolicy: timeZonePolicyField,
  }).strict(),
  z.object({
    kind: z.literal('monthly'),
    dayOfMonth: dayOfMonthField,
    localTime: localTimeField,
    timeZone: timeZoneField,
    timeZonePolicy: timeZonePolicyField,
  }).strict(),
])
export type ManagedSchedule = z.infer<typeof managedScheduleSchema>

/**
 * Numeric rule for the boundary walker (./schedule.ts).
 * @param schedule - a persisted or managed schedule.
 * @returns the same rule as plain numbers.
 */
export function scheduleRule(schedule: TaskSchedule | ManagedSchedule): ScheduleRule {
  if (schedule.kind === 'hourly') return { kind: 'hourly', minute: schedule.minute }
  const time = parseLocalTime(schedule.localTime)
  if (schedule.kind === 'weekly') return { kind: 'weekly', dayOfWeek: schedule.dayOfWeek, ...time }
  if (schedule.kind === 'monthly') return { kind: 'monthly', dayOfMonth: schedule.dayOfMonth, ...time }
  return { kind: schedule.kind, ...time }
}

/**
 * Pin a wire spec to a zone (the creation/update path).
 * @param spec - kind-specific half from the request.
 * @param timeZone - resolved IANA zone.
 * @returns the durable schedule shape.
 */
export function scheduleFromSpec(spec: ScheduleSpec, timeZone: string): TaskSchedule {
  if (spec.kind === 'hourly') return { kind: 'hourly', minute: spec.minute, timeZone }
  if (spec.kind === 'daily') return { kind: 'daily', localTime: spec.localTime, timeZone }
  if (spec.kind === 'weekdays') return { kind: 'weekdays', localTime: spec.localTime, timeZone }
  if (spec.kind === 'weekly') {
    return { kind: 'weekly', dayOfWeek: spec.dayOfWeek, localTime: spec.localTime, timeZone }
  }
  return { kind: 'monthly', dayOfMonth: spec.dayOfMonth, localTime: spec.localTime, timeZone }
}

/** Pinned execution context resolved afresh before every run. */
export const taskExecutionSchema = z.object({
  workspacePath: z.string().min(1),
  agentPreset: z.string().min(1),
  permissionPreset: z.string().min(1),
  /** `null` = follow the harness default selection at run time. */
  model: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().optional(),
  }).strict().nullable(),
}).strict()
export type TaskExecution = z.infer<typeof taskExecutionSchema>

/** Durable task definition (design §6). */
export const taskRecordSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  revision: z.number().int().positive(),
  owner: z.literal('user'),
  title: z.string(),
  instruction: z.string(),
  schedule: taskScheduleSchema,
  enabled: z.boolean(),
  execution: taskExecutionSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict()
export type TaskRecord = z.infer<typeof taskRecordSchema>

/** Durable per-task runtime state (single row per task, keyed by task id). */
export const taskRuntimeRecordSchema = z.object({
  version: z.literal(1),
  taskId: z.string(),
  /** The session this task is bound to; created on the first run and reused
   *  for every later run (null until then). `.default(null)` keeps
   *  pre-binding rows parsing — the domain version stays at 1. */
  sessionId: z.string().nullable().default(null),
  activeRunId: z.string().nullable(),
  activeJobId: z.string().nullable(),
  /** Live session of the active run; drives waiting-input observation and
   *  crash recovery attribution. */
  activeSessionId: z.string().nullable(),
  /** Last consumed schedule boundary (epoch ms). Catch-up and overlap
   *  policies both branch on this cursor. */
  lastScheduledFor: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastAttemptAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  /** Monotone per-task claim fence; every durable intent carries the value
   *  it was written under so stale writers lose (design §8.3). */
  fence: z.number().int().nonnegative(),
  /** Total claims (scheduled + catch-up + manual). Default keeps pre-counter
   *  rows parsing — the domain version stays at 1. */
  runCount: z.number().int().nonnegative().default(0),
  lastResult: taskRunSummarySchema.nullable(),
}).strict()
export type TaskRuntimeRecord = z.infer<typeof taskRuntimeRecordSchema>

/** Durable run audit: written forward through fenced commit intents so any
 *  crash point recovers to exactly one visible outcome (design §6, §8.3). */
export const taskRunAuditSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  taskId: z.string(),
  /** Task revision the run was launched under. */
  definitionRevision: z.number().int().positive(),
  trigger: z.enum(['scheduled', 'catch-up', 'manual']),
  scheduledFor: z.number(),
  sessionId: z.string().nullable(),
  fence: z.number().int().nonnegative(),
  /** Crash-recovery cursor: `claimed` (nothing launched yet), `session-created`
   *  (a session exists — never re-execute), `terminal` (settling, idempotent). */
  commitIntent: z.enum(['claimed', 'session-created', 'terminal']),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  status: z.enum(['claiming', 'running', 'success', 'error', 'cancelled', 'skipped']),
  /** Bounded classified detail; never carries task instruction. */
  detail: z.string().nullable(),
}).strict()
export type TaskRunAudit = z.infer<typeof taskRunAuditSchema>

/** Managed (system) task state other plugins project — read-only here. */
export const managedTaskStateSchema = z.object({
  /** Honest provenance of the zone: dream follows the host's ambient zone. */
  schedule: managedScheduleSchema,
  scheduleState: z.enum(['enabled', 'paused']),
  activity: taskActivitySchema,
  lastAttemptAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  detail: z.string().nullable(),
}).strict()
export type ManagedTaskState = z.infer<typeof managedTaskStateSchema>

/** One row of the unified list (discriminated on `kind`). */
export const userTaskRowSchema = z.object({
  kind: z.literal('user'),
  id: z.string(),
  revision: z.number().int().positive(),
  title: z.string(),
  instruction: z.string(),
  schedule: taskScheduleSchema,
  enabled: z.boolean(),
  execution: taskExecutionSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  activity: taskActivitySchema,
  nextRunAt: z.number().nullable(),
  lastAttemptAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastResult: taskRunSummarySchema.nullable(),
  /** Total settled-and-claimed runs, surfaced as 「已运行 N 次」. */
  runCount: z.number().int().nonnegative(),
  /** The task's bound session (the 跳到会话 target). */
  sessionId: z.string().nullable(),
}).strict()

export const managedTaskRowSchema = z.object({
  kind: z.literal('managed'),
  id: z.string(),
  order: z.number(),
  title: z.string(),
  instructionSummary: z.string(),
  sourceLabel: z.string(),
  schedule: managedTaskStateSchema.shape.schedule,
  scheduleState: managedTaskStateSchema.shape.scheduleState,
  activity: taskActivitySchema,
  lastAttemptAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  detail: z.string().nullable(),
  /** When the provider answered; a stale value may show "possibly stale". */
  observedAt: z.number(),
}).strict()

export const taskRowSchema = z.discriminatedUnion('kind', [userTaskRowSchema, managedTaskRowSchema])
export type UserTaskRow = z.infer<typeof userTaskRowSchema>
export type ManagedTaskRow = z.infer<typeof managedTaskRowSchema>
export type TaskRow = z.infer<typeof taskRowSchema>

/** Model route option offered by the catalog. */
export const modelRouteOptionSchema = z.object({
  provider: z.string(),
  providerName: z.string(),
  model: z.string(),
  efforts: z.array(z.string()),
}).strict()
export type ModelRouteOption = z.infer<typeof modelRouteOptionSchema>

/** Workspace/agent-preset/permission/model options the edit form picks from. */
export const catalogSnapshotSchema = z.object({
  workspaces: z.array(z.object({
    path: z.string(),
    title: z.string(),
  }).strict()),
  agentPresets: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    isDefault: z.boolean(),
  }).strict()),
  permissionPresets: z.array(z.object({
    name: z.string(),
    isDefault: z.boolean(),
  }).strict()),
  models: z.array(modelRouteOptionSchema),
  defaultSelection: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().nullable(),
  }).strict(),
  defaultAgentPreset: z.string(),
  defaultPermissionPreset: z.string(),
  /** Host ambient zone, offered as the creation-time pin. */
  timeZone: z.string(),
  suggestedTimeZones: z.array(z.string()),
}).strict()
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>

/** Full `list()` answer: unified rows plus the moment they were read. */
export const listSnapshotSchema = z.object({
  observedAt: z.number(),
  tasks: z.array(taskRowSchema),
}).strict()
export type ListSnapshot = z.infer<typeof listSnapshotSchema>

/** Wire request for `create` (full snapshot, design §7). */
export const createTaskRequestSchema = z.object({
  title: z.string(),
  instruction: z.string(),
  /** Kind + wall time; `hourly` carries only `minute`. */
  schedule: scheduleSpecSchema,
  /** Optional pin; defaults to the host's current IANA zone when omitted. */
  timeZone: z.string().optional(),
  workspacePath: z.string(),
  agentPreset: z.string(),
  permissionPreset: z.string(),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
  }).strict().nullable(),
  enabled: z.boolean(),
}).strict()
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>

/** Wire request for `update`: full snapshot plus a revision fence. */
export const updateTaskRequestSchema = createTaskRequestSchema.extend({
  id: z.string(),
  ifRevision: z.number().int().positive(),
}).strict()
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>

/** Wire request for the row-level run/pause toggle. */
export const setEnabledRequestSchema = z.object({
  id: z.string(),
  ifRevision: z.number().int().positive(),
  enabled: z.boolean(),
}).strict()
export type SetEnabledRequest = z.infer<typeof setEnabledRequestSchema>

/** Wire request for `remove` (rejected while a run is active). */
export const removeTaskRequestSchema = z.object({
  id: z.string(),
  ifRevision: z.number().int().positive(),
}).strict()
export type RemoveTaskRequest = z.infer<typeof removeTaskRequestSchema>

/** Wire request by task id. */
export const taskIdRequestSchema = z.object({ id: z.string() }).strict()
export type TaskIdRequest = z.infer<typeof taskIdRequestSchema>

/** One row of a task's run history (latest first, bounded). */
export const taskRunRowSchema = z.object({
  runId: z.string(),
  trigger: z.enum(['scheduled', 'catch-up', 'manual']),
  scheduledFor: z.number(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  status: z.enum(['claiming', 'running', 'success', 'error', 'cancelled', 'skipped']),
  durationMs: z.number().nullable(),
}).strict()
export type TaskRunRow = z.infer<typeof taskRunRowSchema>

/** Answer of `listRuns`. */
export const runListSchema = z.object({ runs: z.array(taskRunRowSchema) }).strict()
export type RunList = z.infer<typeof runListSchema>

/** Wire request for `deleteRun` (history row removal; active runs refuse). */
export const deleteRunRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
}).strict()
export type DeleteRunRequest = z.infer<typeof deleteRunRequestSchema>

/** Validation bounds shared by the service and the tests. */
export const LIMITS = {
  maxTitleChars: 100,
  maxInstructionChars: 8_000,
  maxTasks: 100,
  maxRunHistory: 100,
} as const

/** Stable Remote error codes the browser half branches on. */
export const TASK_ERRORS = {
  managedReadOnly: 'TASK_MANAGED_READ_ONLY',
  notFound: 'TASK_NOT_FOUND',
  revisionConflict: 'TASK_REVISION_CONFLICT',
  busy: 'TASK_BUSY',
  limitReached: 'TASK_LIMIT_REACHED',
  runNotFound: 'TASK_RUN_NOT_FOUND',
  validation: 'TASK_VALIDATION',
  workspaceUnavailable: 'TASK_WORKSPACE_UNAVAILABLE',
} as const

/** Local `HH:mm` validity used by both CRUD validation and the scheduler. */
export function isValidLocalTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/**
 * Service-level re-check of a schedule spec. The Remote descriptor already
 * parses the request through {@link scheduleSpecSchema}, so this guards direct
 * service calls and yields the stable `TASK_VALIDATION` vocabulary.
 * @param spec - kind-specific half of a create/update request.
 * @returns a bounded message, or null when the spec is valid.
 */
export function scheduleSpecError(spec: ScheduleSpec): string | null {
  if (spec.kind === 'hourly') {
    return Number.isInteger(spec.minute) && spec.minute >= 0 && spec.minute <= 59
      ? null
      : 'hourly minute must be an integer 0..59'
  }
  if (!isValidLocalTime(spec.localTime)) return 'local time must be a strict HH:mm value'
  if (spec.kind === 'weekly') {
    return Number.isInteger(spec.dayOfWeek) && spec.dayOfWeek >= 1 && spec.dayOfWeek <= 7
      ? null
      : 'weekly dayOfWeek must be an integer 1..7 (Monday..Sunday)'
  }
  if (spec.kind === 'monthly') {
    return Number.isInteger(spec.dayOfMonth) && spec.dayOfMonth >= 1 && spec.dayOfMonth <= 31
      ? null
      : 'monthly dayOfMonth must be an integer 1..31'
  }
  return null
}

/**
 * IANA zone validity: `Intl` throws on unknown zones. Accepts the pragmatic
 * `'local'` sentinel the same way the harness does (resolved eagerly).
 */
export function resolveTimeZone(candidate: string): string {
  const zone = candidate === 'local'
    ? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
    : candidate
  // Throws RangeError for a non-IANA identifier.
  new Intl.DateTimeFormat('en-US', { timeZone: zone })
  return zone
}
