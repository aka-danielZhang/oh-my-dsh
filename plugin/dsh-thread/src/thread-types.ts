import { z } from 'zod'

/** Settings namespace carrying the Thread feature toggle. */
export const THREAD_SETTINGS_NAMESPACE = 'dsh-thread'

/** Durable Thread settings section: the master switch for tool injection and UI. */
export interface ThreadSettings {
  enabled: boolean
}

/** Default when the user-settings document has no Thread section: feature on. */
export const DEFAULT_THREAD_SETTINGS: ThreadSettings = { enabled: true }

export const threadArtifactSchema = z.object({
  kind: z.enum(['file', 'directory', 'url', 'note', 'other']),
  label: z.string().min(1).max(200),
  uri: z.string().max(2000).nullable().default(null),
  summary: z.string().max(1000).nullable().default(null),
})
export type ThreadArtifact = z.infer<typeof threadArtifactSchema>

export const handoffSnapshotSchema = z.object({
  objective: z.string().max(2000),
  confirmedConclusions: z.array(z.string().max(1000)).max(24),
  constraints: z.array(z.string().max(1000)).max(24),
  openQuestions: z.array(z.string().max(1000)).max(24),
  artifacts: z.array(threadArtifactSchema).max(24).default([]),
})

export const threadDraftRecordSchema = z.object({
  draftId: z.string(),
  version: z.number().int().positive(),
  sourceSessionId: z.string(),
  sourceAnchor: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tool-call'), callId: z.string() }),
    z.object({ kind: z.literal('latest-complete-turn') }),
  ]),
  sourceBoundarySeq: z.number().int().nonnegative().nullable(),
  sourceTurn: z.number().int().nonnegative().nullable(),
  status: z.enum(['waiting-boundary', 'editable', 'source-invalid', 'discarded']),
  handoff: handoffSnapshotSchema,
  instruction: z.string().max(4000),
  suggestedPreset: z.string().max(200).nullable(),
  targetTitle: z.string().max(200).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ThreadDraftRecord = z.infer<typeof threadDraftRecordSchema>

export const threadTraceSchema = z.object({
  step: z.string(),
  ok: z.boolean(),
  detail: z.record(z.string(), z.unknown()).optional(),
})

/** Model selection inherited from the source Session (provider-validated). */
export const threadModelSelectionSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})
export type ThreadModelSelection = z.infer<typeof threadModelSelectionSchema>

export const threadFoldSchema = z.object({
  splices: z.array(z.object({
    seq: z.number(),
    target: z.string(),
    start: z.number(),
    removedCount: z.number().nullable(),
    insertedIds: z.array(z.string()),
    outcome: z.string().nullable(),
  })),
  entries: z.array(z.object({ seq: z.number(), id: z.string() })),
  turns: z.array(z.object({ seq: z.number(), type: z.string() })),
  titles: z.array(z.object({ seq: z.number(), title: z.string() })),
  models: z.array(z.object({
    seq: z.number(),
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
  })).default([]),
})
export type ThreadFold = z.infer<typeof threadFoldSchema>

export const threadLinkSchema = z.object({
  linkId: z.string(),
  threadId: z.string().nullable().default(null),
  sourceSessionId: z.string(),
  targetSessionId: z.string(),
  draftId: z.string(),
  draftVersion: z.number().int().positive().default(1),
  authorizationActionId: z.string().nullable().default(null),
  creationActionId: z.string().nullable().default(null),
  targetWorkspaceId: z.string().nullable().default(null),
  targetCwd: z.string().nullable().default(null),
  agentPreset: z.string(),
  model: threadModelSelectionSchema.nullable().default(null),
  title: z.string().nullable(),
  handoff: handoffSnapshotSchema,
  instruction: z.string().max(4000),
  state: z.enum(['authorized', 'creating', 'activating', 'active', 'failed', 'uncertain']),
  titleState: z.enum(['not-requested', 'pending', 'applied', 'failed']),
  attempt: z.object({
    phase: z.enum(['prepared', 'submitting', 'flushed', 'uncertain']),
    handoffId: z.string().nullable(),
    instructionId: z.string().nullable(),
  }),
  relationCommit: z.object({
    reason: z.literal('activation-flushed'),
    at: z.number(),
  }).nullable(),
  failure: z.string().nullable(),
  trace: z.array(threadTraceSchema),
  fold: threadFoldSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}).superRefine((link, context) => {
  const committed = link.relationCommit !== null
  const flushed = link.attempt.phase === 'flushed'
  if (committed !== (link.state === 'active' && flushed)) {
    context.addIssue({
      code: 'custom',
      path: ['relationCommit'],
      message: 'activation-flushed commit requires and is required by active+flushed',
    })
  }
})

export type ThreadLink = z.infer<typeof threadLinkSchema>

export const authorizeRequestSchema = z.object({
  sourceSessionId: z.string().min(1).max(300),
  draftId: z.string().min(1).max(300),
  draftVersion: z.number().int().positive(),
  actionId: z.string().min(1).max(300),
  title: z.string().min(1).max(200).optional(),
  handoff: handoffSnapshotSchema,
  instruction: z.string().min(1).max(4000),
})
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>

export const linkRequestSchema = z.object({ linkId: z.string().min(1).max(300) })
export type LinkRequest = z.infer<typeof linkRequestSchema>

export const beginCreationRequestSchema = z.object({
  linkId: z.string().min(1).max(300),
  actionId: z.string().min(1).max(300),
})
export type BeginCreationRequest = z.infer<typeof beginCreationRequestSchema>

export const recordTitleRequestSchema = z.object({
  linkId: z.string().min(1).max(300),
  ok: z.boolean(),
})
export type RecordTitleRequest = z.infer<typeof recordTitleRequestSchema>

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  state: z.string().optional(),
})

export const presetListResultSchema = z.object({
  presets: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    broken: z.string().nullable(),
    isDefault: z.boolean(),
  })),
})
export type PresetListResult = z.infer<typeof presetListResultSchema>

export const authorizeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    linkId: z.string(),
    targetSessionId: z.string(),
    createPlan: z.object({
      sessionId: z.string(),
      agentPreset: z.string(),
      workspaceId: z.string().optional(),
      cwd: z.string().optional(),
    }),
    titlePlan: z.object({ sessionId: z.string(), title: z.string() }).optional(),
  }),
  failureSchema,
])
export type AuthorizeResult = z.infer<typeof authorizeResultSchema>

export const mutationResultSchema = z.union([
  z.object({ ok: z.literal(true), link: threadLinkSchema }),
  failureSchema,
])
export type MutationResult = z.infer<typeof mutationResultSchema>

export const activateResultSchema = z.union([
  z.object({ ok: z.literal(true), link: threadLinkSchema }),
  z.object({ ok: z.literal(false), error: z.string(), link: threadLinkSchema.optional() }),
])
export type ActivateResult = z.infer<typeof activateResultSchema>

export const stateResultSchema = z.object({
  drafts: z.array(threadDraftRecordSchema),
  links: z.array(threadLinkSchema),
})
export type StateResult = z.infer<typeof stateResultSchema>
