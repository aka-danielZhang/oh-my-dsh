import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityKindForTool, presentTask, resultRevisionOf } from '../src/presentation.ts'
import type { AssignmentRecord, TicketRecord, WorkerRunRecord } from '../src/core/model.ts'

// Minimal durable slices; only the fields the projection reads are present.
const ticket = (overrides: Partial<TicketRecord> = {}): TicketRecord => ({
  id: 't1',
  qunoId: 'quno',
  title: '整理消息',
  goal: 'g',
  decisionId: null,
  mandate: {} as TicketRecord['mandate'],
  origin: { triggerId: null, triggerIds: [] },
  channels: [],
  mode: 'once',
  ended: null,
  question: null,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
}) as TicketRecord

const assignment = (overrides: Partial<AssignmentRecord> = {}): AssignmentRecord => ({
  id: 'a1',
  ticketId: 't1',
  state: 'pending',
  executorSessionId: 'quno-exec-t1',
  directory: '/tmp',
  report: null,
  deliveredAt: null,
  idleAt: null,
  endedReason: null,
  createdAt: 1000,
  ...overrides,
}) as AssignmentRecord

const run = (overrides: Partial<WorkerRunRecord> = {}): WorkerRunRecord => ({
  id: 'r1',
  qunoId: 'quno',
  ticketId: 't1',
  assignmentId: 'a1',
  status: 'running',
  inputIds: [],
  fence: 1,
  leaseUntil: null,
  turnId: null,
  result: null,
  error: null,
  cost: null,
  startedAt: 2000,
  finishedAt: null,
  ...overrides,
}) as WorkerRunRecord

const report = (state: 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped', extra: Record<string, unknown> = {}) => ({
  state,
  summary: 's',
  at: 3000,
  artifacts: [],
  ...extra,
}) as AssignmentRecord['report']

test('an accepted task is visibly distinct from a running one', () => {
  // Assignment persisted, no run yet: accepted (waiting for execution resources).
  const accepted = presentTask({ ticket: ticket(), assignment: assignment(), latestRun: null })
  assert.equal(accepted.status, 'accepted')
  assert.equal(accepted.activityKind, null)
  assert.equal(accepted.canCancel, true)
  assert.equal(accepted.canViewActivity, true)

  // The run started: running, generic activity.
  const running = presentTask({ ticket: ticket(), assignment: assignment({ state: 'running' }), latestRun: run() })
  assert.equal(running.status, 'running')
  assert.equal(running.activityKind, 'working')
  assert.equal(running.lastActivityAt, 2000)
})

test('a question outranks everything; a silent wait never bothers the user', () => {
  const withQuestion = presentTask({
    ticket: ticket({ question: { id: 'q1', question: '要哪个群？', triggerId: null, createdAt: 4000 } }),
    assignment: assignment({ state: 'running', report: report('waiting', { question: { question: '要哪个群？' } }) }),
    latestRun: run({ status: 'ended', finishedAt: 3100 }),
  })
  assert.equal(withQuestion.status, 'needs-you')
  assert.equal(withQuestion.activityKind, 'waiting-user')
  assert.equal(withQuestion.canAnswer, true)
  assert.equal(withQuestion.lastActivityAt, 4000)

  // A failed report without a question still needs a human decision.
  const failedReport = presentTask({
    ticket: ticket(),
    assignment: assignment({ state: 'running', report: report('failed') }),
    latestRun: run({ status: 'failed', finishedAt: 3100, error: { code: 'worker-failed', message: 'x' } }),
  })
  assert.equal(failedReport.status, 'needs-you')
  assert.equal(failedReport.canRetry, true)

  // A waiting report WITHOUT a question is a wait for events, not the user.
  const silentWait = presentTask({
    ticket: ticket(),
    assignment: assignment({ report: report('waiting') }),
    latestRun: run({ status: 'ended', finishedAt: 3100 }),
  })
  assert.equal(silentWait.status, 'waiting')
  assert.equal(silentWait.canAnswer, false)
  assert.equal(silentWait.canCancel, true)
})

test('ended outcomes map onto the user states', () => {
  const ended = (outcome: TicketRecord['ended'] extends null ? never : NonNullable<TicketRecord['ended']>['outcome']): ReturnType<typeof presentTask>['status'] =>
    presentTask({ ticket: ticket({ ended: { at: 9000, by: 'executor', outcome, reason: null } }), assignment: assignment({ state: 'ended' }), latestRun: null }).status
  assert.equal(ended('completed'), 'done')
  assert.equal(ended('failed'), 'failed')
  assert.equal(ended('stopped'), 'cancelled')
  assert.equal(ended('dropped'), 'dropped')
  assert.equal(ended('closed'), 'dropped')
})

test('a persistent ready stays running; origin and revision are projected', () => {
  const persistent = presentTask({
    ticket: ticket({ mode: 'persistent', origin: { triggerId: 'trg_1', triggerIds: ['trg_1'] } }),
    assignment: assignment({ state: 'running', report: report('ready', { nonce: 7 }) }),
    latestRun: run({ status: 'ended', finishedAt: 3100 }),
  })
  assert.equal(persistent.status, 'running')
  assert.equal(persistent.activityKind, 'summarize')
  assert.equal(persistent.origin, 'source')
  assert.equal(persistent.resultRevision, '3000:7')

  const direct = presentTask({ ticket: ticket(), assignment: assignment(), latestRun: null })
  assert.equal(direct.origin, 'direct')
  assert.equal(resultRevisionOf(null), null)
})

test('activity labels come from the tool declarations, never from prose', () => {
  assert.equal(activityKindForTool('quno_cli_call', { capability: 'yzj', operation: 'im.group.recent' }), 'recent-groups')
  assert.equal(activityKindForTool('quno_cli_call', { capability: 'yzj', operation: 'im.message.list' }), 'read-messages')
  assert.equal(activityKindForTool('quno_cli_call', { capability: 'yzj', operation: 'im.group.search' }), 'read-messages')
  assert.equal(activityKindForTool('quno_cli_call', { capability: 'other', operation: 'x' }), 'working')
  assert.equal(activityKindForTool('quno_worker_report', null), 'summarize')
  assert.equal(activityKindForTool('read', null), 'read-file')
  assert.equal(activityKindForTool('web_fetch', null), 'read-web')
  assert.equal(activityKindForTool('mystery_tool', null), 'working')
})
