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

/**
 * Target Session lifecycle, orthogonal to titles, delivery, and the relation.
 *
 * - `reserved`: authorization pinned the deterministic target id; nothing exists.
 * - `creating`: a creation attempt left the durable checkpoint, outcome unknown
 *   until reconciliation (idempotent create by deterministic id).
 * - `published`: the target Session provably exists (reconciled fingerprint).
 * - `diverged`: the target exists but is not usable by this Link anymore
 *   (foreign model-visible input, identity conflict). NEVER inject into it.
 * - `abandoned`: the authorization was cancelled before creation.
 */
export const targetPhaseSchema = z.enum(['reserved', 'creating', 'published', 'diverged', 'abandoned'])
export type TargetPhase = z.infer<typeof targetPhaseSchema>

/**
 * Facts that identify the published target Session beyond its id. Pinned by
 * the first reconciliation and exact-matched afterwards.
 */
export const targetFingerprintSchema = z.object({
  createdAt: z.number(),
  agentPreset: z.string().nullable(),
  workspaceId: z.string().nullable(),
  cwd: z.string().nullable(),
})
export type TargetFingerprint = z.infer<typeof targetFingerprintSchema>

/**
 * Title saga state. `requested` is user intent (audit/display only); `accepted`
 * and `eventSeq` come exclusively from the successful `session.rename` response
 * or from adopting the target log's authoritative title — never from copying
 * the deployment's normalization rules.
 */
export const titlePhaseSchema = z.enum(['not-requested', 'pending', 'accepted', 'failed', 'unknown'])
export type TitlePhase = z.infer<typeof titlePhaseSchema>

export const threadTitleSchema = z.object({
  phase: titlePhaseSchema,
  requested: z.string().nullable(),
  accepted: z.string().nullable(),
  eventSeq: z.number().nullable(),
  failure: z.string().nullable(),
})
export type ThreadTitleState = z.infer<typeof threadTitleSchema>

/**
 * Message-delivery saga state. `attempt` counts deliveries (crash retries and
 * user-confirmed redeliveries each bump it); the message ids belong to exactly
 * one attempt and are persisted BEFORE the first inbox mutation so every crash
 * window is decidable by id presence in the target log.
 */
export const deliveryPhaseSchema = z.enum(['prepared', 'submitting', 'flushed', 'uncertain'])
export type DeliveryPhase = z.infer<typeof deliveryPhaseSchema>

export const threadDeliverySchema = z.object({
  phase: deliveryPhaseSchema,
  attempt: z.number().int().nonnegative().default(0),
  handoffId: z.string().nullable(),
  instructionId: z.string().nullable(),
})
export type ThreadDeliveryState = z.infer<typeof threadDeliverySchema>

export const threadRelationSchema = z.enum(['pending', 'active', 'abandoned'])
export type ThreadRelation = z.infer<typeof threadRelationSchema>

/**
 * Structured, recovery-oriented failure record. `phase` names the saga leg that
 * failed; `recovery` names the concrete user action that can make progress —
 * the UI never invents a generic "retry" again.
 */
export const threadFailureSchema = z.object({
  phase: z.enum(['authorize', 'create', 'title', 'activate', 'flush']),
  code: z.string().max(300),
  recovery: z.enum(['resume', 'reconcile', 'clone', 'open-target', 'none']),
  detail: z.record(z.string(), z.unknown()).nullable().default(null),
})
export type ThreadFailure = z.infer<typeof threadFailureSchema>

/**
 * Verbatim capture of the pre-0.3 overloaded state fields, kept only so the
 * durable migration can rewrite legacy records and then clear this marker.
 * Always `null` on records written by this version.
 */
export const threadLegacyCaptureSchema = z.object({
  state: z.string(),
  titleState: z.string(),
  attemptPhase: z.string().nullable(),
  failure: z.string().nullable(),
}).nullable().default(null)
export type ThreadLegacyCapture = z.infer<typeof threadLegacyCaptureSchema>

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
  handoff: handoffSnapshotSchema,
  instruction: z.string().max(4000),
  target: z.object({
    phase: targetPhaseSchema,
    fingerprint: targetFingerprintSchema.nullable().default(null),
  }),
  title: threadTitleSchema,
  delivery: threadDeliverySchema,
  relation: threadRelationSchema,
  relationCommit: z.object({
    reason: z.literal('activation-flushed'),
    at: z.number(),
  }).nullable(),
  failure: threadFailureSchema.nullable().default(null),
  legacy: threadLegacyCaptureSchema,
  trace: z.array(threadTraceSchema),
  fold: threadFoldSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
}).superRefine((link, context) => {
  // relation 'active' commits exactly when both messages are flushed durable.
  const active = link.relation === 'active'
  const flushed = link.delivery.phase === 'flushed'
  const committed = link.relationCommit !== null
  if (active !== flushed || active !== committed) {
    context.addIssue({
      code: 'custom',
      path: ['relation'],
      message: 'active relation requires and is required by flushed delivery and a relation commit',
    })
  }
  if (active && link.target.phase !== 'published') {
    context.addIssue({
      code: 'custom',
      path: ['target'],
      message: 'active relation requires a published target',
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

/**
 * `recordTitle` outcome: the discriminated result of one `session.rename`
 * attempt, bound to the creation attempt that issued it. `accepted` carries the
 * authoritative normalized title plus the durable event sequence from the
 * rename response — Thread never derives either itself.
 */
export const titleOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accepted'),
    title: z.string().min(1).max(500),
    eventSeq: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('failed'),
    error: z.string().max(500),
  }),
  z.object({
    kind: z.literal('unknown'),
    error: z.string().max(500),
  }),
])
export type TitleOutcome = z.infer<typeof titleOutcomeSchema>

export const recordTitleRequestSchema = z.object({
  linkId: z.string().min(1).max(300),
  /** The creation attempt whose saga issued the rename; stale outcomes are rejected. */
  attempt: z.string().min(1).max(300),
  outcome: titleOutcomeSchema,
})
export type RecordTitleRequest = z.infer<typeof recordTitleRequestSchema>

export const reconcileRequestSchema = z.object({
  linkId: z.string().min(1).max(300),
  /** Structured create-side error code to persist when the probe finds no target. */
  createError: z.string().max(500).optional(),
})
export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>

export const activateRequestSchema = z.object({
  linkId: z.string().min(1).max(300),
  /** User-confirmed redelivery of an `uncertain` delivery with fresh message ids. */
  redeliver: z.boolean().optional(),
})
export type ActivateRequest = z.infer<typeof activateRequestSchema>

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

/** Reconciliation outcome plus the single next step the client should drive. */
export const reconcileResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    link: threadLinkSchema,
    /** `create`: the target is not provably live — re-issue the idempotent create. */
    next: z.enum(['create', 'none']),
  }),
  failureSchema,
])
export type ReconcileResult = z.infer<typeof reconcileResultSchema>

export const activateResultSchema = z.union([
  z.object({ ok: z.literal(true), link: threadLinkSchema }),
  z.object({ ok: z.literal(false), error: z.string(), link: threadLinkSchema.optional() }),
])
export type ActivateResult = z.infer<typeof activateResultSchema>

/** Clone outcome: a fresh sealed Draft (new identity) ready for a new Link. */
export const cloneResultSchema = z.union([
  z.object({ ok: z.literal(true), draft: threadDraftRecordSchema }),
  failureSchema,
])
export type CloneResult = z.infer<typeof cloneResultSchema>

export const stateResultSchema = z.object({
  drafts: z.array(threadDraftRecordSchema),
  links: z.array(threadLinkSchema),
})
export type StateResult = z.infer<typeof stateResultSchema>
