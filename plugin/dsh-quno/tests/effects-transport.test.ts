/**
 * The Effect outbox and the SessionTransport are the two seams where a crash
 * is most likely. These tests pin their observable contract: retry, stale
 * generation, deduplicated message identity, and the three delivery modes.
 *
 * @module dsh-quno/tests/effects-transport
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryRepository } from '../src/core/memory-store.ts'
import { EffectsRuntime, EffectRetryError } from '../src/app/effects.ts'
import { SessionTransport, qunoMessageId } from '../src/app/transport.ts'
import type { SessionEventLike } from '../src/core/model.ts'

const logger = { warn: () => {}, info: () => {} }

test('effects: success removes the row, failure reschedules with backoff', async () => {
  const repo = new MemoryRepository()
  const seen: string[] = []
  let fail = true
  const runtime = new EffectsRuntime({
    repo,
    logger,
    now: () => 1000,
    backoff: () => 500,
    handlers: {
      'input-delivery': async (effect) => {
        seen.push(effect.key)
        if (fail) throw new Error('transient')
      },
    },
  })
  repo.enqueueEffect({ kind: 'input-delivery', key: 't1', payload: {}, now: 1000 })
  assert.equal(await runtime.kick(), 1)
  const afterFailure = repo.getEffect('input-delivery', 't1')
  assert.ok(afterFailure)
  assert.equal(afterFailure.attempts, 1)
  assert.equal(afterFailure.dueAt, 1500)
  assert.equal(afterFailure.lastError, 'transient')
  assert.deepEqual(seen, ['t1'])
  // Not due yet.
  assert.equal(await runtime.kick(), 0)
  fail = false
  const later = new EffectsRuntime({
    repo,
    logger,
    now: () => 2000,
    handlers: { 'input-delivery': async (effect) => { seen.push(effect.key) } },
  })
  assert.equal(await later.kick(), 1)
  assert.equal(repo.getEffect('input-delivery', 't1'), undefined)
  assert.deepEqual(seen, ['t1', 't1'])
})

test('effects: a newer generation supersedes an old payload before execution', async () => {
  const repo = new MemoryRepository()
  const payloads: unknown[] = []
  const runtime = new EffectsRuntime({
    repo,
    logger,
    now: () => 1000,
    handlers: {
      'router-relay': async (effect) => { payloads.push(effect.payload) },
    },
  })
  const first = repo.enqueueEffect({ kind: 'router-relay', key: 'ticket_1', payload: { revision: 1 }, now: 1000 })
  const second = repo.enqueueEffect({ kind: 'router-relay', key: 'ticket_1', payload: { revision: 2 }, now: 1000 })
  assert.equal(first.generation, 1)
  assert.equal(second.generation, 2)
  // The runtime lists the current row (revision 2), executes once and completes it.
  await runtime.kick()
  assert.deepEqual(payloads, [{ revision: 2 }])
  assert.equal(repo.getEffect('router-relay', 'ticket_1'), undefined)
})

test('effects: a retry hint sets an exact retry instant', async () => {
  const repo = new MemoryRepository()
  const runtime = new EffectsRuntime({
    repo,
    logger,
    now: () => 1000,
    handlers: {
      'assignment-launch': async () => { throw new EffectRetryError('router offline', 30_000) },
    },
  })
  repo.enqueueEffect({ kind: 'assignment-launch', key: 'a1', payload: {}, now: 1000 })
  await runtime.kick()
  assert.equal(repo.getEffect('assignment-launch', 'a1')?.dueAt, 31_000)
})

class FakeAgent {
  readonly session: { id: string; snapshotEvents: () => readonly SessionEventLike[] }
  readonly inbox: { nextTurn: unknown[]; nextStep: unknown[] }
  status: 'idle' | 'running' = 'idle'
  readonly sent: { mode: string; id: string; text: string }[] = []
  readonly events: SessionEventLike[] = []

  constructor() {
    this.session = { id: 'session-1', snapshotEvents: () => this.events }
    this.inbox = { nextTurn: [], nextStep: [] }
  }

  private push(mode: string, message: { id: string; content: readonly unknown[] }): void {
    const text = message.content.flatMap((block) => {
      const record = block as { type?: string; text?: string }
      return record.type === 'text' && typeof record.text === 'string' ? [record.text] : []
    }).join('\n')
    this.sent.push({ mode, id: message.id, text })
    this.events.push({ seq: this.events.length + 1, type: 'user/message', data: message })
  }

  followup(message: { id: string; content: readonly unknown[] }): void { this.push('queue', message) }
  steer(message: { id: string; content: readonly unknown[] }): void { this.push('steer', message) }
  inject(message: { id: string; content: readonly unknown[] }): void { this.push('inject', message) }
}

function fakeContext(agent: FakeAgent, flushResult = true): Context {
  return {
    get: (name: string) => {
      if (name === 'sessions') return { flush: async () => flushResult }
      if (name === 'sessionQuery') return { readSession: async () => ({ events: agent.events }) }
      return undefined
    },
  } as unknown as Context
}

test('transport: queue/steer/inject map to followup/steer/inject', async () => {
  const agent = new FakeAgent()
  const transport = new SessionTransport({ ctx: fakeContext(agent), logger })
  await transport.send(agent as never, {
    requestId: 'eval:1', text: 'candidate', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
  }, () => {})
  await transport.send(agent as never, {
    requestId: 'input:2', text: 'steer', mode: 'steer', source: { kind: 'quno-input', form: 'relay', summary: 's' },
  }, () => {})
  await transport.send(agent as never, {
    requestId: 'input:3', text: 'context', mode: 'inject', source: { kind: 'quno-input', form: 'notice', summary: 's' },
  }, () => {})
  assert.deepEqual(agent.sent.map(item => item.mode), ['queue', 'steer', 'inject'])
  assert.deepEqual(agent.sent.map(item => item.id), [
    qunoMessageId('eval:1'),
    qunoMessageId('input:2'),
    qunoMessageId('input:3'),
  ])
})

test('transport: the same request id is delivered once', async () => {
  const agent = new FakeAgent()
  const transport = new SessionTransport({ ctx: fakeContext(agent), logger })
  const input = {
    requestId: 'eval:1',
    text: 'candidate',
    mode: 'queue' as const,
    source: { kind: 'quno-eval', form: 'relay' as const, summary: 's' },
  }
  await transport.send(agent as never, input, () => {})
  await transport.send(agent as never, input, () => {})
  assert.equal(agent.sent.length, 1)
})

test('transport: the same request id with different content is a conflict', async () => {
  const agent = new FakeAgent()
  const transport = new SessionTransport({ ctx: fakeContext(agent), logger })
  await transport.send(agent as never, {
    requestId: 'eval:1', text: 'first', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
  }, () => {})
  await assert.rejects(
    transport.send(agent as never, {
      requestId: 'eval:1', text: 'second', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
    }, () => {}),
    /already exists with different content/,
  )
})

test('transport: an unconfirmed flush fails loudly so the Effect retries', async () => {
  const agent = new FakeAgent()
  const transport = new SessionTransport({ ctx: fakeContext(agent, false), logger })
  await assert.rejects(
    transport.send(agent as never, {
      requestId: 'eval:1', text: 'candidate', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
    }, () => {}),
    /flush was not confirmed/,
  )
  // The in-memory inbox now holds the message; the retry flushes it instead of
  // sending a second copy.
  const retry = new SessionTransport({ ctx: fakeContext(agent, true), logger })
  await retry.send(agent as never, {
    requestId: 'eval:1', text: 'candidate', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
  }, () => {})
  assert.equal(agent.sent.length, 1)
})

test('transport: authorize runs only when the message is actually sent', async () => {
  const agent = new FakeAgent()
  const transport = new SessionTransport({ ctx: fakeContext(agent), logger })
  let allowed = 0
  await transport.send(agent as never, {
    requestId: 'eval:1', text: 'candidate', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
  }, () => { allowed += 1 })
  await transport.send(agent as never, {
    requestId: 'eval:1', text: 'candidate', mode: 'queue', source: { kind: 'quno-eval', form: 'relay', summary: 's' },
  }, () => { allowed += 1 })
  assert.equal(allowed, 1)
})
