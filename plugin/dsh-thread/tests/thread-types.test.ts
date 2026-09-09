import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizeRequestSchema,
  threadDraftRecordSchema,
  threadLinkSchema,
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
    agentPreset: 'standard-thread',
    model: null,
    title: null,
    handoff: { objective: 'continue', confirmedConclusions: [], constraints: [], openQuestions: [], artifacts: [] },
    instruction: 'continue',
    state: 'authorized',
    titleState: 'not-requested',
    attempt: { phase: 'prepared', handoffId: null, instructionId: null },
    relationCommit: null,
    failure: null,
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

test('loads legacy Links without Thread or workspace placement metadata', () => {
  const {
    threadId: _thread,
    targetWorkspaceId: _workspace,
    targetCwd: _cwd,
    ...legacy
  } = link()
  const { artifacts: _artifacts, ...legacyHandoff } = legacy.handoff
  const parsed = threadLinkSchema.parse({ ...legacy, handoff: legacyHandoff })
  assert.equal(parsed.threadId, null)
  assert.equal(parsed.targetWorkspaceId, null)
  assert.equal(parsed.targetCwd, null)
  assert.deepEqual(parsed.handoff.artifacts, [])
})

test('loads legacy Links without model inheritance and folds it to null', () => {
  const { model: _model, ...legacy } = link()
  const { models: _models, ...legacyFold } = legacy.fold
  const parsed = threadLinkSchema.parse({ ...legacy, fold: legacyFold })
  assert.equal(parsed.model, null)
  assert.deepEqual(parsed.fold.models, [])
  // A stamped selection survives the round trip untouched.
  const inherited = link({ model: { provider: 'pi-ai', model: 'glm-5.3-flash', reasoningEffort: 'high' } })
  const stamped = threadLinkSchema.parse(inherited)
  assert.deepEqual(stamped.model, { provider: 'pi-ai', model: 'glm-5.3-flash', reasoningEffort: 'high' })
})

test('requires activation-flushed commit exactly for active flushed links', () => {
  assert.equal(threadLinkSchema.safeParse(link()).success, true)
  assert.equal(threadLinkSchema.safeParse(link({
    state: 'active',
    attempt: { phase: 'flushed', handoffId: 'handoff-1', instructionId: 'instruction-1' },
    relationCommit: { reason: 'activation-flushed', at: 2 },
  })).success, true)
  assert.equal(threadLinkSchema.safeParse(link({
    state: 'active',
    attempt: { phase: 'flushed', handoffId: 'handoff-1', instructionId: 'instruction-1' },
  })).success, false)
  assert.equal(threadLinkSchema.safeParse(link({
    relationCommit: { reason: 'activation-flushed', at: 2 },
  })).success, false)
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
