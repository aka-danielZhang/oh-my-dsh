import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveThreadGroups } from '../src/grouping.ts'
import type { ThreadArtifact, ThreadLink } from '../src/thread-types.ts'

const fileArtifact: ThreadArtifact = {
  kind: 'file',
  label: 'Architecture note',
  uri: '/workspace/docs/thread.md',
  summary: 'Accepted Thread design',
}

function link(
  linkId: string,
  sourceSessionId: string,
  targetSessionId: string,
  artifacts: ThreadArtifact[] = [],
  createdAt = 1,
  threadId: string | null = 'thread-root-abc',
): ThreadLink {
  return {
    linkId,
    threadId,
    sourceSessionId,
    targetSessionId,
    draftId: `draft-${linkId}`,
    draftVersion: 1,
    authorizationActionId: `authorize-${linkId}`,
    creationActionId: `create-${linkId}`,
    targetWorkspaceId: 'workspace-1',
    targetCwd: null,
    agentPreset: 'standard',
    model: null,
    target: { phase: 'published', fingerprint: null },
    title: { phase: 'not-requested', requested: null, accepted: null, eventSeq: null, failure: null },
    handoff: {
      objective: 'continue',
      confirmedConclusions: [],
      constraints: [],
      openQuestions: [],
      artifacts,
    },
    instruction: 'continue',
    delivery: { phase: 'flushed', attempt: 1, handoffId: 'handoff-1', instructionId: 'instruction-1' },
    relation: 'active',
    relationCommit: { at: createdAt + 1, reason: 'activation-flushed' },
    failure: null,
    legacy: null,
    trace: [],
    fold: { splices: [], entries: [], turns: [], titles: [], models: [] },
    createdAt,
    updatedAt: createdAt + 1,
  }
}

test('groups connected links into stage-ordered Thread components', () => {
  const groups = deriveThreadGroups([
    link('ac', 'a', 'c', [], 2),
    link('ab', 'a', 'b', [fileArtifact], 1),
    link('xy', 'x', 'y', [], 4, 'thread-root-other'),
  ])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0]!.sessionIds, ['a', 'b', 'c'])
  assert.equal(groups[0]!.rootSessionId, 'a')
  assert.equal(groups[0]!.threadId, 'thread-root-abc')
  assert.deepEqual(groups[1]!.sessionIds, ['x', 'y'])
  assert.equal(groups[1]!.threadId, 'thread-root-other')
})

test('excludes uncommitted links and empty components never appear', () => {
  const pending: ThreadLink = {
    ...link('ab', 'a', 'b'),
    target: { phase: 'reserved', fingerprint: null },
    delivery: { phase: 'prepared', attempt: 0, handoffId: null, instructionId: null },
    relation: 'pending',
    relationCommit: null,
  }
  assert.deepEqual(deriveThreadGroups([pending]), [])
  assert.deepEqual(deriveThreadGroups([]), [])
})

test('a single durable Thread id wins; only conflicting or absent ids read as legacy', () => {
  const mixed = deriveThreadGroups([
    link('ab', 'a', 'b', [], 1, null),
    link('bc', 'b', 'c', [], 2, 'thread-root-abc'),
  ])
  assert.equal(mixed.length, 1)
  assert.equal(mixed[0]!.threadId, 'thread-root-abc')

  const conflicting = deriveThreadGroups([
    link('ab', 'a', 'b', [], 1, 'thread-root-one'),
    link('bc', 'b', 'c', [], 2, 'thread-root-two'),
  ])
  assert.equal(conflicting[0]!.threadId, null)

  const legacy = deriveThreadGroups([link('ab', 'a', 'b', [], 1, null)])
  assert.equal(legacy[0]!.threadId, null)
})

test('branched Threads order roots first and siblings by link age', () => {
  const groups = deriveThreadGroups([
    link('bd', 'b', 'd', [], 3),
    link('ac', 'a', 'c', [], 2),
    link('ab', 'a', 'b', [], 1),
  ])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]!.sessionIds, ['a', 'b', 'c', 'd'])
})

test('group links stay available for per-Session artifact projection', () => {
  const groups = deriveThreadGroups([
    link('ab', 'a', 'b', [fileArtifact], 1),
    link('bc', 'b', 'c', [], 2),
  ])
  assert.equal(groups[0]!.links.length, 2)
  assert.deepEqual(groups[0]!.links.map(item => item.linkId), ['ab', 'bc'])
})
