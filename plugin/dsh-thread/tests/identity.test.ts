import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceCreation, deriveThreadId, deriveThreadIdentity, resolveThreadId } from '../src/identity.ts'
import type { ThreadLink } from '../src/thread-types.ts'

function reservedLink(): ThreadLink {
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

  const first = reservedLink()
  assert.deepEqual(resolveThreadId('target-1', [first]), { ok: true, threadId: first.threadId })
  assert.deepEqual(resolveThreadId('source-1', [first]), { ok: true, threadId: first.threadId })

  const legacy = { ...first, threadId: null }
  assert.deepEqual(resolveThreadId('target-1', [legacy]), {
    ok: true,
    threadId: deriveThreadId('source-1'),
  })
})

test('rejects conflicting Thread ids in one connected component', () => {
  const first = reservedLink()
  const second: ThreadLink = {
    ...reservedLink(),
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
  const first = advanceCreation(reservedLink(), 'action-1', 2)
  assert.equal(first.ok, true)
  if (!first.ok) return
  assert.equal(first.changed, true)
  assert.equal(first.link.target.phase, 'creating')
  assert.equal(first.link.creationActionId, 'action-1')

  const transportRetry = advanceCreation(first.link, 'action-1', 3)
  assert.equal(transportRetry.ok, true)
  if (!transportRetry.ok) return
  assert.equal(transportRetry.changed, false)

  const secondClick = advanceCreation(first.link, 'action-2', 4)
  assert.deepEqual(secondClick, { ok: false, error: 'creation-in-flight', phase: 'creating' })
})

test('a recorded create failure re-arms the creation fence (no fake retry dead-end)', () => {
  const inFlight = advanceCreation(reservedLink(), 'action-1', 2)
  assert.equal(inFlight.ok, true)
  if (!inFlight.ok) return
  const failed: ThreadLink = {
    ...inFlight.link,
    failure: { phase: 'create', code: 'gateway/internal: boom', recovery: 'resume', detail: null },
  }
  const retry = advanceCreation(failed, 'action-2', 5)
  assert.equal(retry.ok, true)
  if (!retry.ok) return
  assert.equal(retry.changed, true)
  assert.equal(retry.link.creationActionId, 'action-2')
  assert.equal(retry.link.failure, null)
})

test('published, diverged, and active targets need no creation checkpoint', () => {
  for (const phase of ['published', 'diverged'] as const) {
    const decision = advanceCreation({ ...reservedLink(), target: { phase, fingerprint: null } }, 'action-9', 2)
    assert.equal(decision.ok, true)
    if (decision.ok) assert.equal(decision.changed, false)
  }
  const active: ThreadLink = {
    ...reservedLink(),
    target: { phase: 'published', fingerprint: { createdAt: 1, agentPreset: 'cordis', workspaceId: 'w', cwd: null } },
    delivery: { phase: 'flushed', attempt: 1, handoffId: 'h', instructionId: 'i' },
    relation: 'active',
    relationCommit: { reason: 'activation-flushed', at: 2 },
  }
  const decision = advanceCreation(active, 'action-9', 3)
  assert.equal(decision.ok, true)
  if (decision.ok) assert.equal(decision.changed, false)
})

test('abandoned authorizations reject creation outright', () => {
  const abandoned: ThreadLink = {
    ...reservedLink(),
    target: { phase: 'abandoned', fingerprint: null },
    relation: 'abandoned',
  }
  assert.deepEqual(advanceCreation(abandoned, 'action-1', 2), {
    ok: false,
    error: 'link-abandoned',
    phase: 'abandoned',
  })
})
