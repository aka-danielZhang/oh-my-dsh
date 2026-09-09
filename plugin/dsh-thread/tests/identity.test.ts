import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceCreation, deriveThreadId, deriveThreadIdentity, resolveThreadId } from '../src/identity.ts'
import type { ThreadLink } from '../src/thread-types.ts'

function authorizedLink(): ThreadLink {
  return {
    linkId: 'link-1',
    threadId: 'thread-root-1',
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    draftId: 'draft-1',
    draftVersion: 1,
    authorizationActionId: 'authorize-1',
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
  }
}

test('derives one stable Link and target from a Draft', () => {
  const first = deriveThreadIdentity('draft-call-1')
  const retry = deriveThreadIdentity('draft-call-1')
  const other = deriveThreadIdentity('draft-call-2')

  assert.deepEqual(retry, first)
  assert.notDeepEqual(other, first)
  assert.match(first.linkId, /^thread-[a-f0-9]{32}$/)
  assert.match(first.targetSessionId, /^session-thread-[a-f0-9]{32}$/)
})

test('derives and inherits one Thread id across connected Sessions', () => {
  const root = resolveThreadId('source-1', [])
  assert.deepEqual(root, { ok: true, threadId: deriveThreadId('source-1') })

  const first = authorizedLink()
  assert.deepEqual(resolveThreadId('target-1', [first]), { ok: true, threadId: first.threadId })
  assert.deepEqual(resolveThreadId('source-1', [first]), { ok: true, threadId: first.threadId })

  const legacy = { ...first, threadId: null }
  assert.deepEqual(resolveThreadId('target-1', [legacy]), {
    ok: true,
    threadId: deriveThreadId('source-1'),
  })
})

test('rejects conflicting Thread ids in one connected component', () => {
  const first = authorizedLink()
  const second: ThreadLink = {
    ...authorizedLink(),
    linkId: 'link-2',
    threadId: 'thread-root-2',
    sourceSessionId: 'target-1',
    targetSessionId: 'target-2',
  }
  const decision = resolveThreadId('target-1', [first, second])
  assert.deepEqual(decision, {
    ok: false,
    error: 'thread-id-conflict',
    threadIds: ['thread-root-1', 'thread-root-2'],
  })
})

test('single-flights creation by direct-click actionId', () => {
  const first = advanceCreation(authorizedLink(), 'action-1', 2)
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.changed, true)
  assert.equal(first.link.state, 'creating')
  assert.equal(first.link.creationActionId, 'action-1')

  const transportRetry = advanceCreation(first.link, 'action-1', 3)
  assert.equal(transportRetry.ok, true)
  if (!transportRetry.ok) return
  assert.equal(transportRetry.changed, false)

  const secondClick = advanceCreation(first.link, 'action-2', 4)
  assert.deepEqual(secondClick, { ok: false, error: 'creation-in-flight', state: 'creating' })
})
