import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeRequestSchema,
  recordTitleRequestSchema,
  threadDraftRecordSchema,
  threadLinkSchema,
  titleOutcomeSchema,
  type ThreadLink,
} from '../src/thread-types.ts'

function link(overrides: Partial<ThreadLink> = {}): ThreadLink {
  return {
    linkId: 'link-1',
    threadId: 'thread-root-1',
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    draftId: 'draft-1',
    draftVersion: 1,
    authorizationActionId: 'action-authorize-1',
    creationActionId: null,
    targetWorkspaceId: 'workspace-1',
    targetCwd: null,
    agentPreset: 'cordis',
    model: null,
    target: { phase: 'reserved', fingerprint: null },
    title: { phase: 'not-requested', requested: null, accepted: null, eventSeq: null, failure: null },
    handoff: { objective: 'continue', confirmedConclusions: [], constraints: [], openQuestions: [], artifacts: [] },
    instruction: 'continue',
    delivery: { phase: 'prepared', attempt: 0, handoffId: null, instructionId: null },
    relation: 'pending',
    relationCommit: null,
    failure: null,
    legacy: null,
    trace: [],
    fold: { splices: [], entries: [], turns: [], titles: [], models: [] },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

test('stores a versioned inert Draft before its source boundary is sealed', () => {
  const result = threadDraftRecordSchema.safeParse({
    draftId: 'draft-call-1',
    version: 1,
    sourceSessionId: 'source-1',
    sourceAnchor: { kind: 'tool-call', callId: 'call-1' },
    sourceBoundarySeq: null,
    sourceTurn: null,
    status: 'waiting-boundary',
    handoff: { objective: 'continue', confirmedConclusions: [], constraints: [], openQuestions: [], artifacts: [] },
    instruction: 'continue',
    suggestedPreset: null,
    targetTitle: null,
    createdAt: 1,
    updatedAt: 1,
  })
  assert.equal(result.success, true)
})

test('authorization carries no preset: the target inherits the source Session preset', () => {
  const request = {
    sourceSessionId: 'source',
    draftId: 'draft',
    draftVersion: 1,
    actionId: 'action-1',
    handoff: { objective: 'objective', confirmedConclusions: [], constraints: [], openQuestions: [], artifacts: [] },
    instruction: 'continue',
  }
  assert.equal(authorizeRequestSchema.safeParse(request).success, true)
  // A client-supplied preset is no longer part of the contract (stripped, not rejected).
  assert.equal(authorizeRequestSchema.safeParse({ ...request, agentPreset: 'cordis' }).success, true)
})

test('bounds the Remote authorization payload before persistence', () => {
  const result = authorizeRequestSchema.safeParse({
    sourceSessionId: 'source',
    draftId: 'draft',
    draftVersion: 1,
    actionId: 'action-1',
    handoff: {
      objective: 'objective',
      confirmedConclusions: Array.from({ length: 25 }, () => 'fact'),
      constraints: [],
      openQuestions: [],
      artifacts: [],
    },
    instruction: 'continue',
  })
  assert.equal(result.success, false)
})

test('an 82-byte title passes the wire untouched: normalization belongs upstream', () => {
  // The incident: a title longer than the deployment's maxTitleBytes used to
  // be assumed identical after rename. The wire deliberately carries the raw
  // requested title (bounded by characters, never bytes) — the authoritative
  // accepted form comes only from the rename outcome.
  const eightyTwoBytes = `${'深'.repeat(27)}x` // 27 × 3 + 1 = 82 UTF-8 bytes
  assert.equal(Buffer.byteLength(eightyTwoBytes), 82)
  const request = authorizeRequestSchema.safeParse({
    sourceSessionId: 'source',
    draftId: 'draft',
    draftVersion: 1,
    actionId: 'action-1',
    title: eightyTwoBytes,
    handoff: { objective: 'objective', confirmedConclusions: [], constraints: [], openQuestions: [], artifacts: [] },
    instruction: 'continue',
  })
  assert.equal(request.success, true)
  if (request.success) assert.equal(request.data.title, eightyTwoBytes)
})

test('recordTitle binds a discriminated outcome to the issuing attempt', () => {
  const accepted = recordTitleRequestSchema.safeParse({
    linkId: 'link-1',
    attempt: 'create-1',
    outcome: { kind: 'accepted', title: 'normalized title', eventSeq: 3 },
  })
  assert.equal(accepted.success, true)

  const unknown = recordTitleRequestSchema.safeParse({
    linkId: 'link-1',
    attempt: 'create-1',
    outcome: { kind: 'unknown', error: 'network dropped' },
  })
  assert.equal(unknown.success, true)

  // A boolean is no longer a valid outcome — the old contract is gone.
  assert.equal(recordTitleRequestSchema.safeParse({
    linkId: 'link-1',
    attempt: 'create-1',
    outcome: { ok: true },
  }).success, false)
  // accepted without eventSeq cannot represent an authoritative result.
  assert.equal(titleOutcomeSchema.safeParse({ kind: 'accepted', title: 't' }).success, false)
})

test('requires the active relation exactly for flushed, committed deliveries', () => {
  assert.equal(threadLinkSchema.safeParse(link()).success, true)
  assert.equal(threadLinkSchema.safeParse(link({
    target: { phase: 'published', fingerprint: null },
    delivery: { phase: 'flushed', attempt: 1, handoffId: 'handoff-1', instructionId: 'instruction-1' },
    relation: 'active',
    relationCommit: { reason: 'activation-flushed', at: 2 },
  })).success, true)
  assert.equal(threadLinkSchema.safeParse(link({
    target: { phase: 'published', fingerprint: null },
    delivery: { phase: 'flushed', attempt: 1, handoffId: 'handoff-1', instructionId: 'instruction-1' },
    relation: 'active',
  })).success, false)
  assert.equal(threadLinkSchema.safeParse(link({
    relationCommit: { reason: 'activation-flushed', at: 2 },
  })).success, false)
  // active on an unpublished target is a contradiction
  assert.equal(threadLinkSchema.safeParse(link({
    delivery: { phase: 'flushed', attempt: 1, handoffId: 'handoff-1', instructionId: 'instruction-1' },
    relation: 'active',
    relationCommit: { reason: 'activation-flushed', at: 2 },
  })).success, false)
})

test('fold records remain owned lossless JSON', () => {
  const value = link({
    fold: {
      splices: [{
        seq: 1,
        target: 'next-step',
        start: 0,
        removedCount: null,
        insertedIds: ['message-1'],
        outcome: null,
      }],
      entries: [{ seq: 2, id: 'message-1' }],
      turns: [{ seq: 3, type: 'turn/start' }],
      titles: [{ seq: 4, title: '深圳周末旅行' }],
      models: [{ seq: 5, provider: 'pi-ai', model: 'glm-5.3-flash' }],
    },
  })
  assert.equal(threadLinkSchema.safeParse(value).success, true)
  assert.doesNotThrow(() => JSON.stringify(value))
})

test('structured failures carry their saga phase and recovery action', () => {
  const value = link({
    failure: {
      phase: 'flush',
      code: 'durability-unavailable',
      recovery: 'resume',
      detail: { attempt: 2 },
    },
  })
  const parsed = threadLinkSchema.safeParse(value)
  assert.equal(parsed.success, true)
})
