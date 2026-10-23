/**
 * Delegated-task lifecycle: normal completion, artifact convention, crash
 * reconciliation, resume and abandon.
 *
 * @module dsh-quno/tests/tasks
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  TaskError,
  TaskOrchestrator,
  buildChildPrompt,
  extractArtifacts,
  stripArtifactBlock,
} from '../src/tasks.ts'
import type { ActivationFace, TaskJobOutcome } from '../src/tasks.ts'
import { openFixture } from './helpers.ts'

const logger = { info: () => {}, warn: () => {} }

const parent = {
  id: 'quno-main',
  session: { id: 'quno-main' },
} as unknown as Agent

function completedTurn(text: string, startSeq = 0): { seq: number; type: string; data: unknown }[] {
  return [
    { seq: startSeq, type: 'turn/start', data: { turn: 1 } },
    { seq: startSeq + 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } },
    { seq: startSeq + 2, type: 'turn/end', data: { reason: 'completed' } },
  ]
}

test('a delegated task completes, produces an artifact list and enqueues one task notice', async () => {
  const fixture = openFixture()
  const noticeKicks: number[] = []
  let captured: { childId: string; prompt: string } | undefined
  const done = Promise.withResolvers<{ output: readonly unknown[]; stopReason: string; diagnostic?: string }>()
  const orchestrator = new TaskOrchestrator({
    store: fixture.store,
    qunoId: 'quno',
    history: { readSession: async () => ({ events: [] }) },
    subagents: {
      async startActivation(request) {
        captured = {
          childId: request.childId ?? 'missing',
          prompt: request.request.prompt[0]?.text ?? '',
        }
        const activation: ActivationFace = {
          childId: request.childId ?? 'child',
          messageId: 'msg-1',
          result: done.promise,
          dispose: async () => {},
        }
        return activation
      },
      async sendMessage() {
        return 'msg'
      },
    },
    jobs: {
      start: (spec: { run: () => { done: Promise<TaskJobOutcome> } }) => {
        void spec.run().done
        return 'job-1'
      },
    },
    logger,
    defaultCwd: '/tmp',
    now: () => fixture.now,
    onNotice: () => { noticeKicks.push(1) },
  })
  done.resolve({
    output: [{ type: 'text', text: `结论：可以\n{"artifacts":[{"kind":"file","label":"纪要","uri":"/tmp/notes.md"}]}` }],
    stopReason: 'completed',
  })
  const task = await orchestrator.start({ title: '整理评审纪要', prompt: '读一下评审记录并总结', parent })
  assert.match(captured?.prompt ?? '', /只读执行助手/)
  assert.equal(captured?.childId.startsWith('quno-task-'), true)
  await new Promise(resolve => setTimeout(resolve, 20))
  const settled = fixture.store.getTask(task.id)
  assert.equal(settled.status, 'done')
  assert.equal(settled.result, '结论：可以')
  assert.deepEqual(settled.artifacts, [{ kind: 'file', label: '纪要', uri: '/tmp/notes.md' }])
  const notices = fixture.store.listNotices('quno', 5)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.kind, 'task')
  assert.equal(notices[0]?.topicKey, `task:${task.id}`)
  assert.equal(noticeKicks.length, 1)
  fixture.store.close()
})

test('a task that fails to start is recorded as failed and grows no notice', async () => {
  const fixture = openFixture()
  const orchestrator = new TaskOrchestrator({
    store: fixture.store,
    qunoId: 'quno',
    history: { readSession: async () => ({ events: [] }) },
    subagents: {
      async startActivation() {
        throw new Error('capacity exhausted')
      },
      async sendMessage() {
        return 'msg'
      },
    },
    logger,
    defaultCwd: '/tmp',
    now: () => fixture.now,
  })
  await assert.rejects(
    () => orchestrator.start({ title: '会失败', prompt: '做点什么', parent }),
    (error: unknown) => error instanceof TaskError && error.code === 'start-failed',
  )
  const tasks = fixture.store.listTasks('quno')
  assert.equal(tasks[0]?.status, 'failed')
  assert.equal(fixture.store.listNotices('quno').length, 0)
  fixture.store.close()
})

test('crash reconciliation reflows a completed child and interrupts an unfinished one', async () => {
  const fixture = openFixture()
  const running = fixture.store.insertTask({
    id: 'task_done', qunoId: 'quno', childSessionId: 'child-done', parentSessionId: 'quno-main',
    jobId: null, title: '已完成', prompt: 'p', status: 'running', now: fixture.now,
  })
  const unfinished = fixture.store.insertTask({
    id: 'task_open', qunoId: 'quno', childSessionId: 'child-open', parentSessionId: 'quno-main',
    jobId: null, title: '没跑完', prompt: 'p', status: 'running', now: fixture.now,
  })
  const history = {
    async readSession(sessionId: string) {
      if (sessionId === 'child-done') return { events: completedTurn('历史结论') }
      return { events: [{ seq: 0, type: 'turn/start', data: {} }] }
    },
  }
  const orchestrator = new TaskOrchestrator({
    store: fixture.store,
    qunoId: 'quno',
    history,
    logger,
    defaultCwd: '/tmp',
    now: () => fixture.now,
  })
  const result = await orchestrator.reconcile()
  assert.deepEqual(result, { reflowed: 1, interrupted: 1, failed: 0 })
  assert.equal(fixture.store.getTask(running.id).status, 'done')
  assert.equal(fixture.store.getTask(running.id).result, '历史结论')
  assert.equal(fixture.store.getTask(unfinished.id).status, 'interrupted')
  assert.equal(fixture.store.listNotices('quno').length, 1)
  fixture.store.close()
})

test('resume re-prompts the same child and settles from the durable log', async () => {
  const fixture = openFixture()
  const task = fixture.store.insertTask({
    id: 'task_resume', qunoId: 'quno', childSessionId: 'child-resume', parentSessionId: 'quno-main',
    jobId: null, title: '中断的任务', prompt: '原任务说明', status: 'interrupted', now: fixture.now,
  })
  let sent = false
  const history = {
    async readSession() {
      return { events: sent ? completedTurn('续跑结果', 10) : [{ seq: 0, type: 'turn/start', data: {} }] }
    },
  }
  const orchestrator = new TaskOrchestrator({
    store: fixture.store,
    qunoId: 'quno',
    history,
    subagents: {
      async startActivation() { throw new Error('unused') },
      async sendMessage(_sender, targetId, content) {
        assert.equal(targetId, 'child-resume')
        assert.match(JSON.stringify(content), /原任务说明/)
        sent = true
        return 'msg'
      },
    },
    logger,
    defaultCwd: '/tmp',
    now: () => fixture.now,
  })
  const resumed = await orchestrator.resume(task.id, parent)
  assert.equal(resumed.status, 'running')
  await new Promise(resolve => setTimeout(resolve, 700))
  const settled = fixture.store.getTask(task.id)
  assert.equal(settled.status, 'done')
  assert.equal(settled.result, '续跑结果')
  fixture.store.close()
})

test('abandon cancels an interrupted task but refuses a completed one', async () => {
  const fixture = openFixture()
  const interrupted = fixture.store.insertTask({
    id: 'task_abandon', qunoId: 'quno', childSessionId: 'child', parentSessionId: 'quno-main',
    jobId: null, title: '放弃我', prompt: 'p', status: 'interrupted', now: fixture.now,
  })
  const done = fixture.store.insertTask({
    id: 'task_done', qunoId: 'quno', childSessionId: 'child2', parentSessionId: 'quno-main',
    jobId: null, title: '别放弃', prompt: 'p', status: 'done', now: fixture.now,
  })
  const orchestrator = new TaskOrchestrator({
    store: fixture.store, qunoId: 'quno', logger, defaultCwd: '/tmp', now: () => fixture.now,
  })
  assert.equal(orchestrator.abandon(interrupted.id).status, 'cancelled')
  assert.throws(() => orchestrator.abandon(done.id), TaskError)
  fixture.store.close()
})

test('artifact convention is explicit, bounded and stripped from the visible result', () => {
  const prompt = buildChildPrompt('整理资料')
  assert.match(prompt, /只读/)
  assert.match(prompt, /artifacts/)
  const text = '正文\n{"artifacts":[{"kind":"url","label":"来源","uri":"https://example.com"}]}'
  assert.deepEqual(extractArtifacts(text), [{ kind: 'url', label: '来源', uri: 'https://example.com' }])
  assert.equal(stripArtifactBlock(text), '正文')
  assert.deepEqual(extractArtifacts('正文，没有产物'), [])
  assert.deepEqual(extractArtifacts('bad {"artifacts": [oops]}'), [])
})
