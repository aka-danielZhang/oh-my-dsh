import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveRecoveryView } from '../src/recovery.ts'
import type { ThreadLink } from '../src/thread-types.ts'

function link(overrides: Partial<ThreadLink> = {}): ThreadLink {
  return {
    linkId: 'link-1',
    threadId: 'thread-root-1',
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    draftId: 'draft-1',
    draftVersion: 1,
    authorizationActionId: 'authorize-1',
    creationActionId: 'create-1',
    targetWorkspaceId: 'workspace-1',
    targetCwd: null,
    agentPreset: 'cordis',
    model: null,
    target: { phase: 'published', fingerprint: null },
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

test('reserved: continue creation, with cancel beside it', () => {
  const view = deriveRecoveryView(link({
    target: { phase: 'reserved', fingerprint: null },
    creationActionId: null,
  }))
  assert.equal(view.primary, 'continue-creation')
  assert.deepEqual(view.secondary, ['cancel'])
  assert.equal(view.titleWarning, null)
})

test('creating: recheck by deterministic id, resume after a recorded create failure', () => {
  const fresh = deriveRecoveryView(link({ target: { phase: 'creating', fingerprint: null } }))
  assert.equal(fresh.primary, 'recheck')
  assert.deepEqual(fresh.secondary, [])

  const failed = deriveRecoveryView(link({
    target: { phase: 'creating', fingerprint: null },
    failure: { phase: 'create', code: 'gateway/internal: boom', recovery: 'resume', detail: null },
  }))
  assert.equal(failed.primary, 'recheck')
  assert.deepEqual(failed.secondary, ['cancel'])
  assert.match(failed.summary ?? '', /上次创建未完成/)
})

test('published pristine: start the handoff; a failed title never blocks it', () => {
  const view = deriveRecoveryView(link({
    title: { phase: 'failed', requested: 't', accepted: null, eventSeq: null, failure: 'session/title: invalid' },
  }))
  assert.equal(view.primary, 'start-handoff')
  assert.deepEqual(view.secondary, ['open-target'])
  assert.match(view.titleWarning ?? '', /不影响交接/)
})

test('published diverged: open or clone — never inject', () => {
  const view = deriveRecoveryView(link({
    target: { phase: 'diverged', fingerprint: null },
    failure: { phase: 'activate', code: 'target-diverged', recovery: 'open-target', detail: { offending: 'user/message' } },
  }))
  assert.equal(view.primary, 'open-target')
  assert.deepEqual(view.secondary, ['clone'])
})

test('terminal create conflict: clone is the only way forward', () => {
  const view = deriveRecoveryView(link({
    target: { phase: 'creating', fingerprint: null },
    failure: { phase: 'create', code: 'session/conflict: cwd mismatch', recovery: 'clone', detail: null },
  }))
  assert.equal(view.primary, 'clone')
})

test('uncertain delivery: redeliver behind an explicit risk note', () => {
  const view = deriveRecoveryView(link({
    delivery: { phase: 'uncertain', attempt: 1, handoffId: 'h', instructionId: 'i' },
    failure: { phase: 'flush', code: 'durability-unavailable', recovery: 'resume', detail: null },
  }))
  assert.equal(view.primary, 'redeliver')
  assert.deepEqual(view.secondary, ['open-target'])
  assert.match(view.deliveryWarning ?? '', /重新投递/)
})

test('relation active: only opening the Thread session remains', () => {
  const view = deriveRecoveryView(link({
    delivery: { phase: 'flushed', attempt: 1, handoffId: 'h', instructionId: 'i' },
    relation: 'active',
    relationCommit: { reason: 'activation-flushed', at: 2 },
  }))
  assert.equal(view.primary, 'open-thread')
  assert.deepEqual(view.secondary, [])
})

test('abandoned: nothing drivable, honest summary', () => {
  const view = deriveRecoveryView(link({
    target: { phase: 'abandoned', fingerprint: null },
    relation: 'abandoned',
  }))
  assert.equal(view.primary, null)
  assert.match(view.summary ?? '', /已取消/)
})

test('a submitting delivery self-heals through the same start-handoff action', () => {
  const view = deriveRecoveryView(link({
    delivery: { phase: 'submitting', attempt: 1, handoffId: 'h', instructionId: 'i' },
  }))
  assert.equal(view.primary, 'start-handoff')
  assert.match(view.summary ?? '', /将继续核对/)
})
