import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { recall } from '../src/recall.ts'
import { openFixture } from './helpers.ts'

function queryFace(hits: Record<string, { seq: number; snippet: string }[]>) {
  return {
    async searchEvents({ sessionId }: { sessionId: string }) {
      return { items: hits[sessionId] ?? [], hasMore: false }
    },
    async traceEvent({ seq }: { seq: number }) {
      return { replacementChain: seq === 3 ? [9, 11] : [] }
    },
    async readEvent() {
      return { target: { type: 'user/message', data: { content: [{ type: 'text', text: '原始记录：评审改期到十点' }] } } }
    },
  }
}

test('recall resolves a compacted hit to its original text with a pointer chain', async () => {
  const fixture = openFixture()
  const ctx = new Context()
  ctx.provide('sessionQuery', queryFace({ 'main-1': [{ seq: 3, snippet: '改期…' }] }) as never)
  try {
    const result = await recall({
      ctx,
      store: fixture.store,
      qunoId: 'quno',
      mainSessionId: () => 'main-1',
    }, { query: '改期', limit: 5 })
    assert.equal(result.matches.length, 1)
    const match = result.matches[0]!
    assert.equal(match.kind, 'main')
    assert.equal(match.seq, 3)
    assert.deepEqual(match.replacedBy, [9, 11])
    assert.match(match.excerpt, /原始记录/)
    assert.equal(result.truncated, false)
  } finally {
    fixture.store.close()
  }
})

test('recall scopes to task children and degrades honestly with no sessionQuery', async () => {
  const fixture = openFixture()
  fixture.store.insertTask({
    id: 'task_1', qunoId: 'quno', childSessionId: 'child-1', parentSessionId: 'main-1',
    jobId: null, title: '调研', prompt: 'p', status: 'done', now: fixture.now,
  })
  const ctx = new Context()
  try {
    const missing = await recall({ ctx, store: fixture.store, qunoId: 'quno', mainSessionId: () => 'main-1' }, { query: 'x' })
    assert.equal(missing.matches.length, 0)
    assert.match(missing.note ?? '', /sessionQuery/)

    ctx.provide('sessionQuery', queryFace({ 'child-1': [{ seq: 7, snippet: '任务里的结论' }] }) as never)
    const result = await recall({ ctx, store: fixture.store, qunoId: 'quno', mainSessionId: () => 'main-1' }, { query: '结论', scope: 'tasks' })
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0]?.kind, 'task')
    assert.equal(result.matches[0]?.sessionId, 'child-1')
  } finally {
    fixture.store.close()
  }
})
