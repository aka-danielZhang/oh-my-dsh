import assert from 'node:assert/strict'
import test from 'node:test'
import { projectThreadPanel } from '../src/panel.ts'
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
    agentPreset: 'standard-thread',
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

test('projects only the connected Thread in stage order', () => {
  const links = [
    link('ab', 'a', 'b', [fileArtifact], 1),
    link('ac', 'a', 'c', [fileArtifact], 2),
    link('bd', 'b', 'd', [{ kind: 'url', label: 'Preview', uri: 'https://example.test', summary: null }], 3),
    link('xy', 'x', 'y', [], 4, 'thread-root-other'),
  ]
  const result = projectThreadPanel('d', links)
  assert.ok(result)
  assert.equal(result.threadId, 'thread-root-abc')
  assert.equal(result.rootSessionId, 'a')
  assert.deepEqual(result.sessions.map(item => item.sessionId), ['a', 'b', 'c', 'd'])
})

test('shows produced artifacts before carried artifacts and deduplicates branches', () => {
  const result = projectThreadPanel('b', [
    link('ab', 'a', 'b', [fileArtifact], 1),
    link('ac', 'a', 'c', [fileArtifact], 2),
    link('bd', 'b', 'd', [{ kind: 'url', label: 'Preview', uri: 'https://example.test', summary: null }], 3),
  ])
  assert.ok(result)
  const root = result.sessions.find(item => item.sessionId === 'a')!
  const middle = result.sessions.find(item => item.sessionId === 'b')!
  const sibling = result.sessions.find(item => item.sessionId === 'c')!
  const leaf = result.sessions.find(item => item.sessionId === 'd')!
  assert.equal(root.artifactOrigin, 'produced')
  assert.deepEqual(root.artifacts, [fileArtifact])
  assert.equal(middle.artifactOrigin, 'produced')
  assert.equal(middle.artifacts[0]?.label, 'Preview')
  assert.equal(sibling.artifactOrigin, 'carried')
  assert.deepEqual(sibling.artifacts, [fileArtifact])
  assert.equal(leaf.artifactOrigin, 'carried')
  assert.equal(leaf.artifacts[0]?.label, 'Preview')
})

test('supports legacy links without manufacturing a durable Thread id', () => {
  const result = projectThreadPanel('b', [link('legacy', 'a', 'b', [], 1, null)])
  assert.ok(result)
  assert.equal(result.threadId, null)
  assert.deepEqual(result.sessions.map(item => item.sessionId), ['a', 'b'])
})

test('excludes uncommitted creation attempts from the relation view', () => {
  const pending: ThreadLink = {
    ...link('ab', 'a', 'b'),
    target: { phase: 'reserved', fingerprint: null },
    delivery: { phase: 'prepared', attempt: 0, handoffId: null, instructionId: null },
    relation: 'pending',
    relationCommit: null,
  }
  assert.equal(projectThreadPanel('a', [pending]), null)
})

test('returns no panel relation for a standalone Session', () => {
  assert.equal(projectThreadPanel('standalone', [link('ab', 'a', 'b')]), null)
})
