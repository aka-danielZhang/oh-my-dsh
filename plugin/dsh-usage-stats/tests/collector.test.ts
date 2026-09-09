import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, name } from '../src/collector.ts'
import type { SessionEventView } from '../src/fold.ts'

const UTC = 0

interface RecordedListener {
  event: string
  listener: (...args: unknown[]) => void
}

/** Minimal Context double: collects ctx.on registrations and logging calls. */
function fakeCtx(): {
  ctx: Parameters<typeof apply>[0]
  listeners: RecordedListener[]
  warns: string[]
} {
  const listeners: RecordedListener[] = []
  const warns: string[] = []
  const ctx = {
    on: (event: string, listener: (...args: unknown[]) => void): (() => void) => {
      listeners.push({ event, listener })
      return () => {
        const index = listeners.findIndex(entry => entry.listener === listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    logger: {
      warn: (text: string): void => { warns.push(text) },
      info: (_text: string): void => { /* captured nowhere */ },
    },
  } as unknown as Parameters<typeof apply>[0]
  return { ctx, listeners, warns }
}

function messageEvent(seq: number, mid: string, t: number, tokens: { in: number, out: number }, interrupted = false): SessionEventView {
  return {
    type: 'assistant/message',
    seq,
    time: t,
    data: {
      message: { id: mid, source: { provider: 'deepseek', model: 'deepseek-chat' } },
      usage: { inputTokens: tokens.in, outputTokens: tokens.out },
      ...interrupted ? { interrupted: true as const } : {},
    },
  } as SessionEventView & { data: { interrupted?: true } }
}

/** Fake query engine over in-memory session logs. */
function fakeQuery(logs: Record<string, { seq: number, time: number, mid: string, tokens: { in: number, out: number } }[]>): {
  query: {
    listSessions: () => Promise<Array<{ header: { id: string } }>>
    readSession: (id: string) => Promise<{ events: SessionEventView[] }>
  }
  reads: string[]
} {
  const reads: string[] = []
  return {
    reads,
    query: {
      listSessions: async () => Object.keys(logs).map(id => ({ header: { id } })),
      readSession: async (id: string) => {
        reads.push(id)
        const events = logs[id]!.map(entry => messageEvent(entry.seq, entry.mid, entry.time, entry.tokens))
        return { events }
      },
    },
  }
}

function envHomeDir(): string {
  return mkdtempSync(join(tmpdir(), 'usage-stats-collector-'))
}

test('collector row metadata', () => {
  assert.equal(name, 'dsh-usage-stats/collector')
})

/** Poll until the predicate holds (the collector's open is async). */
async function until(predicate: () => boolean, rounds = 100): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.fail('condition not reached within the polling budget')
}

test('live events fold through session/event with watermark tracking', async () => {
  const home = envHomeDir()
  process.env.DSH_HOME = home
  const { ctx, listeners } = fakeCtx()
  const { query } = fakeQuery({})
  ;(ctx as unknown as { sessionQuery: unknown }).sessionQuery = query
  const dispose = apply(ctx, undefined)
  try {
    const sessionListener = () => listeners.find(entry => entry.event === 'session/event')
    await until(() => sessionListener() !== undefined)
    sessionListener()!.listener({ id: 'live-1' }, messageEvent(3, 'msg-live', Date.parse('2026-09-09T10:00:00.000Z'), { in: 100, out: 50 }))
    // A duplicate replay of the same message id must not double-count.
    sessionListener()!.listener({ id: 'live-1' }, messageEvent(3, 'msg-live', Date.parse('2026-09-09T10:00:00.000Z'), { in: 100, out: 50 }))
    const lines = readFileSync(join(home, 'usage-stats', 'records', '2026-09-09.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 1)
  } finally {
    dispose()
    delete process.env.DSH_HOME
  }
})

test('backfill walks history and fork-seed message ids dedup across sessions', async () => {
  const home = envHomeDir()
  process.env.DSH_HOME = home
  const { ctx } = fakeCtx()
  const logs = {
    'parent-1': [
      { seq: 1, time: Date.parse('2026-09-08T10:00:00.000Z'), mid: 'seed-1', tokens: { in: 100, out: 50 } },
      { seq: 2, time: Date.parse('2026-09-08T10:01:00.000Z'), mid: 'seed-2', tokens: { in: 10, out: 5 } },
    ],
    // A fork replaying the parent's seed messages (same message ids).
    'child-1': [
      { seq: 1, time: Date.parse('2026-09-08T10:00:00.000Z'), mid: 'seed-1', tokens: { in: 100, out: 50 } },
      { seq: 2, time: Date.parse('2026-09-08T11:00:00.000Z'), mid: 'child-own', tokens: { in: 20, out: 10 } },
    ],
  }
  const { query, reads } = fakeQuery(logs)
  ;(ctx as unknown as { sessionQuery: unknown }).sessionQuery = query
  const dispose = apply(ctx, undefined)
  try {
    await until(() => reads.length >= 2)
    assert.deepEqual([...reads].sort(), ['child-1', 'parent-1'])
    const lines = readFileSync(join(home, 'usage-stats', 'records', '2026-09-08.jsonl'), 'utf8').trim().split('\n')
    // seed-1 once, seed-2, child-own — the fork's replay of seed-1 skipped.
    assert.equal(lines.length, 3)
    const total = lines.map(line => JSON.parse(line) as { in: number, out: number }).reduce((sum, r) => sum + r.in + r.out, 0)
    assert.equal(total, 195)
    // State bookkeeping settled: both sessions walked.
    const state = JSON.parse(readFileSync(join(home, 'usage-stats', 'state.json'), 'utf8')) as {
      sessions: Record<string, number>
      backfilled: string[]
    }
    assert.equal(state.sessions['parent-1'], 2)
    assert.equal(state.sessions['child-1'], 2)
    assert.deepEqual([...state.backfilled].sort(), ['child-1', 'parent-1'])
  } finally {
    dispose()
    delete process.env.DSH_HOME
  }
})

test('dispose unwires the session/event listener and flushes state', async () => {
  const home = envHomeDir()
  process.env.DSH_HOME = home
  const { ctx, listeners } = fakeCtx()
  const { query } = fakeQuery({})
  ;(ctx as unknown as { sessionQuery: unknown }).sessionQuery = query
  const dispose = apply(ctx, undefined)
  await until(() => listeners.some(entry => entry.event === 'session/event'))
  dispose()
  assert.equal(listeners.find(entry => entry.event === 'session/event'), undefined)
  delete process.env.DSH_HOME
})

void UTC
