/**
 * Terminal Exchange outcomes: every failure and expiry leaves durable evidence
 * and wakes the requester, and the Router-facing rendering is deterministic so
 * a replayed Effect deduplicates instead of double-reporting.
 *
 * @module dsh-quno/tests/exchange-outcome
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryRepository } from '../src/core/memory-store.ts'
import { buildPolicy } from '../src/core/policy.ts'
import { Engine } from '../src/core/engine.ts'
import { exchangeRelayOutcome } from '../src/app/assessor.ts'
import { routerEndpoint } from '../src/core/model.ts'
import type { EngineDeps } from '../src/core/engine.ts'
import type { PolicyRule } from '../src/core/policy.ts'
import type { TicketRecord } from '../src/core/model.ts'

interface Fixture {
  readonly repo: MemoryRepository
  readonly engine: Engine
}

let clock = 2_000_000

function now(): number {
  clock += 1000
  return clock
}

function fixture(): Fixture {
  const repo = new MemoryRepository()
  const state = { configRevision: 1, paused: false, acceptMode: 'auto' as const, evalTimeoutMs: 60_000, rules: [] as PolicyRule[] }
  let counter = 0
  const deps: EngineDeps = {
    repo,
    qunoId: 'quno',
    policy: () => state,
    policySnapshot: snapshot => buildPolicy({
      version: `v${String(snapshot.configRevision)}`,
      paused: snapshot.paused,
      acceptMode: snapshot.acceptMode,
      evalTimeoutMs: snapshot.evalTimeoutMs,
      rules: snapshot.rules,
    }),
    nextId: (prefix) => {
      counter += 1
      return `${prefix}_${String(counter)}`
    },
    defaultCwd: '/tmp/quno-test',
    cliGrant: () => ({ capabilities: ['yzj'], operations: { yzj: ['im.group.recent'] } }),
  }
  return { repo, engine: new Engine(deps) }
}

/** One open Ticket, written directly so the test needs no Eval negotiation. */
function ticket(repo: MemoryRepository, id: string): TicketRecord {
  const at = now()
  const record: TicketRecord = {
    id,
    qunoId: 'quno',
    title: '查消息',
    goal: '读一条消息',
    decisionId: null,
    mandate: {
      strength: 'explicit',
      policyVersion: 'v1',
      scope: 'ticket',
      actor: { source: 'desktop', id: 'sess' },
      basis: { via: 'direct', sourceId: null, scope: {}, matchedRuleIds: [] },
      permissionPreset: 'quno-task',
      cli: { capabilities: ['yzj'], operations: { yzj: ['im.group.recent'] } },
    },
    origin: { triggerId: null, triggerIds: [] },
    channels: [],
    mode: 'once',
    ended: null,
    question: null,
    createdAt: at,
    updatedAt: at,
  }
  repo.insertTicket(record)
  return record
}

test('a retryable failure reschedules without claiming a terminal outcome', () => {
  const f = fixture()
  const t = ticket(f.repo, 'ticket_r')
  const exchange = f.engine.requestExchange({
    kind: 'request',
    requester: `ticket:${t.id}`,
    responder: 'organ:yzj',
    payload: {},
    deadlineMs: 10_000,
    now: now(),
  })
  f.engine.exchangeDelivered(exchange.id, now())
  f.engine.failExchange({ exchangeId: exchange.id, responder: 'organ:yzj', reason: 'rate-limited', retryable: true, now: now() })
  const after = f.repo.getExchange(exchange.id)
  assert.equal(after?.status, 'pending')
  // Delivery counted attempt 1; the retryable failure bumped it to 2.
  assert.equal(after?.attempts, 2)
  assert.equal(f.repo.getExchangeMessages(exchange.id).filter(message => message.kind === 'error').length, 0)
  assert.equal(f.repo.listInputsByTicket(t.id).length, 0)
})

test('a terminal failure persists the reason as an error message and wakes the Ticket', () => {
  const f = fixture()
  const t = ticket(f.repo, 'ticket_t')
  const exchange = f.engine.requestExchange({
    kind: 'request',
    requester: `ticket:${t.id}`,
    responder: 'organ:yzj',
    payload: {},
    deadlineMs: 10_000,
    now: now(),
  })
  // Delivery already counted attempt 1; two retryable failures stay under
  // the three-attempt budget, so the next non-retryable one is terminal.
  f.engine.exchangeDelivered(exchange.id, now())
  for (let attempt = 0; attempt < 2; attempt += 1) {
    f.engine.failExchange({ exchangeId: exchange.id, responder: 'organ:yzj', reason: 'network', retryable: true, now: now() })
  }
  f.engine.failExchange({ exchangeId: exchange.id, responder: 'organ:yzj', reason: 'auth-required：未登录', retryable: false, now: now() })
  assert.equal(f.repo.getExchange(exchange.id)?.status, 'failed')
  const error = f.repo.getExchangeMessages(exchange.id).find(message => message.kind === 'error')
  assert.ok(error !== undefined)
  assert.deepEqual(error.payload, { outcome: 'failed', reason: 'auth-required：未登录', responder: 'organ:yzj' })
  const inputs = f.repo.listInputsByTicket(t.id)
  assert.equal(inputs.length, 1)
  assert.match(inputs[0]?.text ?? '', /异步读取失败：auth-required：未登录/)
})

test('a Router-requested failure queues one relay carrying the exchange id', () => {
  const f = fixture()
  const exchange = f.engine.requestExchange({
    kind: 'request',
    requester: routerEndpoint('quno'),
    responder: 'organ:yzj',
    payload: {},
    deadlineMs: 10_000,
    now: now(),
  })
  f.engine.exchangeDelivered(exchange.id, now())
  f.engine.failExchange({ exchangeId: exchange.id, responder: 'organ:yzj', reason: 'bad-envelope', retryable: false, now: now() })
  const effect = f.repo.getEffect('router-relay', `exchange:${exchange.id}`)
  assert.ok(effect !== undefined)
  assert.deepEqual((effect.payload as { exchangeId?: string }).exchangeId, exchange.id)
})

test('expiry is terminal, idempotent, and wakes the requester exactly once', () => {
  const f = fixture()
  const t = ticket(f.repo, 'ticket_e')
  const exchange = f.engine.requestExchange({
    kind: 'request',
    requester: `ticket:${t.id}`,
    responder: 'organ:yzj',
    payload: {},
    deadlineMs: 1_000,
    now: now(),
  })
  assert.equal(f.engine.expireExchanges(now() + 5_000), 1)
  assert.equal(f.engine.expireExchanges(now() + 9_000), 0)
  assert.equal(f.repo.getExchange(exchange.id)?.status, 'expired')
  const error = f.repo.getExchangeMessages(exchange.id).find(message => message.kind === 'error')
  assert.equal((error?.payload as { outcome?: string }).outcome, 'expired')
  assert.match((error?.payload as { reason?: string }).reason ?? '', /没有返回结果/)
  assert.equal(f.repo.listInputsByTicket(t.id).length, 1)
})

/* -------------------------------------------------- Router-facing rendering */

test('terminal outcomes render deterministically from durable evidence', () => {
  assert.equal(exchangeRelayOutcome('pending', []), null)
  assert.equal(exchangeRelayOutcome('delivered', []), null)
  assert.equal(exchangeRelayOutcome('responded', []), null)
  const responded = exchangeRelayOutcome('responded', [{ kind: 'response', payload: { list: [1] } }])
  assert.match(responded?.text ?? '', /^【Quno 异步读取结果】\n\{"list":\[1\]\}/)
  const failed = exchangeRelayOutcome('failed', [{ kind: 'error', payload: { reason: 'auth-required：未登录' } }])
  assert.match(failed?.text ?? '', /^【Quno 异步读取失败】\nauth-required：未登录/)
  assert.match(failed?.text ?? '', /可以修正参数后重试/)
  const expired = exchangeRelayOutcome('expired', [{ kind: 'error', payload: { reason: '超时' } }])
  assert.match(expired?.text ?? '', /^【Quno 异步读取超时】/)
  assert.match(exchangeRelayOutcome('failed', [])?.text ?? '', /没有记录失败原因/)
})

test('a Ticket Mandate snapshots the read grant it was accepted with', () => {
  const f = fixture()
  const accepted = f.engine.directAccept({
    sessionId: 'sess',
    messageId: 'm1',
    toolCallId: 't1',
    title: '查消息',
    goal: '读一条消息',
    now: now(),
  })
  assert.deepEqual(accepted.mandate.cli, { capabilities: ['yzj'], operations: { yzj: ['im.group.recent'] } })
})
