import assert from 'node:assert/strict'
import test from 'node:test'
import { clearLegacyCapture, migrateLegacyLink, needsLegacyRewrite } from '../src/migrate.ts'
import { threadLinkSchema, type ThreadLink } from '../src/thread-types.ts'

const baseHandoff = { objective: 'continue', confirmedConclusions: [], constraints: [], openQuestions: [], artifacts: [] }

/** One pre-0.3 stored link with the single overloaded `state`. */
function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    title: '深'.repeat(27),
    handoff: baseHandoff,
    instruction: 'continue',
    state: 'authorized',
    titleState: 'pending',
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

function migrate(raw: Record<string, unknown>): ThreadLink {
  const parsed = threadLinkSchema.safeParse(migrateLegacyLink(raw))
  assert.equal(parsed.success, true, JSON.stringify(parsed))
  return parsed.data
}

test('every legacy state maps onto the orthogonal checkpoints and parses', () => {
  const cases: Array<{ state: string; overrides?: Record<string, unknown> }> = [
    { state: 'authorized' },
    { state: 'creating' },
    { state: 'activating', overrides: { attempt: { phase: 'submitting', handoffId: 'h', instructionId: 'i' } } },
    { state: 'active', overrides: { attempt: { phase: 'flushed', handoffId: 'h', instructionId: 'i' }, relationCommit: { reason: 'activation-flushed', at: 2 } } },
    { state: 'uncertain', overrides: { failure: 'durability-unavailable: x' } },
    { state: 'failed', overrides: { failure: 'target-not-live' } },
  ]
  for (const item of cases) {
    const link = migrate(legacyRecord({ state: item.state, ...item.overrides }))
    assert.equal(link.legacy !== null && link.legacy.state === item.state, true, item.state)
    assert.equal(needsLegacyRewrite(link), true)
  }
})

test('the incident record: title-only pristine failure migrates to published + unknown title', () => {
  // 82-byte requested title, rename succeeded (titleState applied) but the
  // equality check failed with offending session/title.
  const link = migrate(legacyRecord({
    state: 'failed',
    titleState: 'applied',
    failure: 'target-not-pristine',
    trace: [
      { step: 'target-pristine', ok: false, detail: { offending: 'session/title' } },
    ],
  }))
  assert.equal(link.target.phase, 'published')
  assert.equal(link.title.phase, 'unknown')
  assert.equal(link.title.requested, '深'.repeat(27))
  assert.equal(link.title.accepted, null)
  assert.equal(link.failure, null)
  assert.equal(link.relation, 'pending')
  assert.equal(link.delivery.phase, 'prepared')
})

test('an unexpected-title-only pristine failure migrates the same way', () => {
  const link = migrate(legacyRecord({
    state: 'failed',
    titleState: 'pending',
    failure: 'target-not-pristine',
    trace: [
      { step: 'target-pristine', ok: false, detail: { offending: 'session/title-unexpected' } },
    ],
  }))
  assert.equal(link.target.phase, 'published')
  assert.equal(link.title.phase, 'unknown')
  assert.equal(link.failure, null)
})

test('real semantic divergence migrates to the reconcile path, not published', () => {
  const link = migrate(legacyRecord({
    state: 'failed',
    titleState: 'applied',
    failure: 'target-not-pristine',
    trace: [
      { step: 'target-pristine', ok: false, detail: { offending: 'user/message' } },
    ],
  }))
  // The target may exist; reconciliation decides published vs diverged and
  // re-activation re-checks purity, so genuinely diverged targets still fail.
  assert.equal(link.target.phase, 'creating')
  assert.equal(link.failure?.phase, 'activate')
  assert.equal(link.failure?.recovery, 'reconcile')
})

test('active and uncertain map to their exact delivery/relation shapes', () => {
  const active = migrate(legacyRecord({
    state: 'active',
    attempt: { phase: 'flushed', handoffId: 'h', instructionId: 'i' },
    relationCommit: { reason: 'activation-flushed', at: 2 },
  }))
  assert.equal(active.target.phase, 'published')
  assert.equal(active.delivery.phase, 'flushed')
  assert.equal(active.relation, 'active')
  assert.ok(active.relationCommit)

  const uncertain = migrate(legacyRecord({
    state: 'uncertain',
    failure: 'durability-unavailable',
    attempt: { phase: 'uncertain', handoffId: 'h', instructionId: 'i' },
  }))
  assert.equal(uncertain.target.phase, 'published')
  assert.equal(uncertain.delivery.phase, 'uncertain')
  assert.equal(uncertain.relation, 'pending')
  assert.equal(uncertain.failure?.phase, 'flush')
  assert.equal(uncertain.failure?.recovery, 'resume')
})

test('title state mapping keeps requested intent everywhere', () => {
  assert.equal(migrate(legacyRecord({ state: 'authorized', titleState: 'not-requested', title: null })).title.phase, 'not-requested')
  assert.equal(migrate(legacyRecord({ state: 'creating' })).title.phase, 'pending')
  assert.equal(migrate(legacyRecord({ state: 'creating', titleState: 'failed' })).title.phase, 'failed')
  // `applied` recorded only ok:true — the accepted title was discarded, so the
  // migration refuses to fabricate one and defers to log adoption.
  assert.equal(migrate(legacyRecord({ state: 'creating', titleState: 'applied' })).title.phase, 'unknown')
})

test('records from this version pass through untouched', () => {
  const modern: Record<string, unknown> = {
    linkId: 'link-2',
    threadId: null,
    sourceSessionId: 'source-1',
    targetSessionId: 'target-1',
    draftId: 'draft-1',
    draftVersion: 1,
    authorizationActionId: 'authorize-1',
    creationActionId: null,
    targetWorkspaceId: null,
    targetCwd: null,
    agentPreset: 'cordis',
    model: null,
    target: { phase: 'reserved', fingerprint: null },
    title: { phase: 'pending', requested: 't', accepted: null, eventSeq: null, failure: null },
    handoff: baseHandoff,
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
  assert.equal(migrateLegacyLink(modern), modern)
  const parsed = threadLinkSchema.safeParse(modern)
  assert.equal(parsed.success, true)
  if (parsed.success) {
    assert.equal(needsLegacyRewrite(parsed.data), false)
    const cleared = clearLegacyCapture(parsed.data, 9)
    assert.equal(cleared.legacy, null)
    assert.equal(cleared.updatedAt, 9)
  }
})

test('cleared records round-trip through the schema without the legacy fields', () => {
  const migrated = migrate(legacyRecord({ state: 'authorized' }))
  const cleared = clearLegacyCapture(migrated, 9)
  const reparsed = threadLinkSchema.safeParse(cleared)
  assert.equal(reparsed.success, true)
  assert.equal(needsLegacyRewrite(reparsed.success ? reparsed.data : cleared), false)
})
