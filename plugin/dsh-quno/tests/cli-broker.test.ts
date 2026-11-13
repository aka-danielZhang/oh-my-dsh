/**
 * The structured CLI capability broker: authorization, schema enforcement,
 * target resolution and the execution guards, all without a real process.
 *
 * @module dsh-quno/tests/cli-broker
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CliCapabilityBroker,
  type CliCallOutcome,
  type CliCapabilityProvider,
  type CliOperationSpec,
} from '../src/cli-broker.ts'
import type { SenseInstanceRecord } from '../src/types.ts'

const OPERATIONS: Readonly<Record<string, CliOperationSpec>> = {
  'items.list': {
    access: 'read',
    summary: 'list items',
    params: [
      { name: 'limit', kind: 'integer', min: 1, max: 20, description: 'how many' },
      { name: 'keyword', kind: 'string', maxChars: 8, description: 'filter' },
    ],
  },
  'items.send': {
    access: 'command',
    summary: 'send an item',
    params: [],
  },
}

function instance(patch: Partial<SenseInstanceRecord> & { id: string }): SenseInstanceRecord {
  return {
    qunoId: 'quno',
    type: 'test/cli-im',
    label: patch.id,
    config: { profile: 'default' },
    configRevision: 1,
    desiredState: 'enabled',
    lifecycle: 'running',
    health: 'healthy',
    healthDetail: null,
    generation: 1,
    checkpoint: { value: null, revision: 0 },
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastEventAt: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
    errorCode: null,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

function provider(overrides: Partial<CliCapabilityProvider> = {}): CliCapabilityProvider & { calls: number } {
  const state = { calls: 0 }
  const built: CliCapabilityProvider & { calls: number } = {
    capability: 'demo',
    title: '演示',
    senseType: 'test/cli-im',
    operations: OPERATIONS,
    timeoutMs: 1_000,
    get calls() {
      return state.calls
    },
    async execute(request) {
      state.calls += 1
      return { ok: true, data: { op: request.operation, params: request.params, target: request.target.id } }
    },
    ...overrides,
  }
  return built
}

function broker(
  instances: readonly SenseInstanceRecord[],
  capability: CliCapabilityProvider,
): CliCapabilityBroker {
  const b = new CliCapabilityBroker({ listInstances: () => instances })
  b.register(capability)
  return b
}

const GRANT = { capabilities: ['demo'], operations: { demo: ['items.list'] } }

/* ------------------------------------------------------------ discovery */

test('discovery lists only capabilities with a configured, non-disabled target', () => {
  const single = instance({ id: 'sense_a', label: '工作号' })
  const paused = instance({ id: 'sense_b', label: '暂停号', desiredState: 'paused' })
  const disabled = instance({ id: 'sense_c', label: '停用号', desiredState: 'disabled' })
  const view = new CliCapabilityBroker({ listInstances: () => [single, paused, disabled] })
  view.register(provider())
  const described = view.describe()
  assert.equal(described.length, 1)
  assert.deepEqual(described[0]?.targets.map(target => target.id), ['sense_a', 'sense_b'])
  assert.deepEqual(described[0]?.operations.map(operation => operation.operation), ['items.list'])

  const none = new CliCapabilityBroker({ listInstances: () => [disabled] })
  none.register(provider())
  assert.equal(none.describe().length, 0)
})

test('the grant snapshot records read operations only, and only with a target', () => {
  const withTarget = broker([instance({ id: 'sense_a' })], provider())
  assert.deepEqual(withTarget.grantSnapshot(), { capabilities: ['demo'], operations: { demo: ['items.list'] } })
  const withoutTarget = broker([], provider())
  assert.deepEqual(withoutTarget.grantSnapshot(), { capabilities: [], operations: {} })
})

/* ------------------------------------------------------- authorization */

test('an unregistered capability refuses and names what does exist', async () => {
  const b = broker([instance({ id: 'sense_a' })], provider())
  await assert.rejects(
    b.call({ capability: 'nope', operation: 'items.list', params: {}, grant: GRANT }),
    /没有注册名为 nope 的 CLI 能力。当前可用：demo（演示）/,
  )
})

test('an operation outside the table refuses and lists the read surface', async () => {
  const b = broker([instance({ id: 'sense_a' })], provider())
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.delete', params: {}, grant: GRANT }),
    /没有 operation items.delete。可用：items\.list/,
  )
})

test('a declared write operation is never executable by a Worker', async () => {
  const capability = provider()
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({
      capability: 'demo',
      operation: 'items.send',
      params: {},
      grant: { capabilities: ['demo'], operations: { demo: ['items.send'] } },
    }),
    /属于写操作/,
  )
  assert.equal(capability.calls, 0)
})

test('a Mandate that did not grant the capability authorizes nothing', async () => {
  const capability = provider()
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {} }),
    /Mandate 未授权 demo\/items\.list/,
  )
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: { capabilities: ['demo'], operations: {} } }),
    /Mandate 未授权/,
  )
  assert.equal(capability.calls, 0)
})

/* --------------------------------------------------------- parameters */

test('unknown parameter keys are refused, so a payload cannot smuggle argv or a profile', async () => {
  const capability = provider()
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: { profile: 'other' }, grant: GRANT }),
    /不接受参数 profile；可用参数：limit、keyword/,
  )
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: { argv: ['rm', '-rf'] }, grant: GRANT }),
    /不接受参数 argv/,
  )
  assert.equal(capability.calls, 0)
})

test('out-of-bound values are refused rather than clipped', async () => {
  const b = broker([instance({ id: 'sense_a' })], provider())
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: { limit: 21 }, grant: GRANT }),
    /limit 必须在 1-20 之间/,
  )
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: { limit: 1.5 }, grant: GRANT }),
    /必须是整数/,
  )
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: { keyword: 'abcdefghi' }, grant: GRANT }),
    /超出 8 字符上限/,
  )
})

test('accepted parameters reach the provider normalized', async () => {
  const seen: unknown[] = []
  const capability = provider({
    async execute(request): Promise<CliCallOutcome> {
      seen.push(request.params)
      return { ok: true, data: request.params }
    },
  })
  const b = broker([instance({ id: 'sense_a' })], capability)
  const result = await b.call({
    capability: 'demo',
    operation: 'items.list',
    params: { limit: 3, keyword: '  hi  ' },
    grant: GRANT,
  })
  assert.deepEqual(seen[0], { limit: 3, keyword: 'hi' })
  assert.deepEqual(result.data, { limit: 3, keyword: 'hi' })
  assert.deepEqual(result.target, { id: 'sense_a', label: 'sense_a', health: 'healthy' })
})

/* ------------------------------------------------------------ targets */

test('several configured accounts demand an explicit target', async () => {
  const b = broker([instance({ id: 'sense_a', label: '工作号' }), instance({ id: 'sense_b', label: '生活号' })], provider())
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /配置了 2 个账号，请在 target 里指定：sense_a（工作号）、sense_b（生活号）/,
  )
  const reached = await b.call({ capability: 'demo', operation: 'items.list', params: {}, target: 'sense_b', grant: GRANT })
  assert.equal(reached.target.id, 'sense_b')
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, target: 'sense_z', grant: GRANT }),
    /没有 target sense_z/,
  )
})

test('no configured account refuses with the setup instruction', async () => {
  const b = broker([], provider())
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /还没有配置任何账号：先在感知器里添加 test\/cli-im 实例并完成登录/,
  )
})

/* ----------------------------------------------------------- execution */

test('a provider failure surfaces its own code and retryability', async () => {
  const capability = provider({
    async execute() {
      return { ok: false, code: 'auth-required', message: '未登录' }
    },
  })
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /失败：未登录$/,
  )
  const retryable = provider({
    async execute() {
      return { ok: false, code: 'rate-limited', message: '稍后再来', retryable: true }
    },
  })
  const b2 = broker([instance({ id: 'sense_a' })], retryable)
  await assert.rejects(
    b2.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /可稍后重试/,
  )
})

test('a hanging provider hits the broker deadline', async () => {
  const capability = provider({
    timeoutMs: 20,
    async execute(request) {
      await new Promise(resolve => setTimeout(resolve, 5_000))
      return { ok: true, data: request.params } satisfies CliCallOutcome
    },
  })
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /超过 20ms 未返回/,
  )
})

test('concurrency is bounded per capability and releases after completion', async () => {
  let open: (() => void) | undefined
  const capability = provider({
    maxConcurrent: 1,
    async execute() {
      await new Promise<void>((resolve) => { open = resolve })
      return { ok: true, data: {} }
    },
  })
  const b = broker([instance({ id: 'sense_a' })], capability)
  const first = b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT })
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /并发调用（上限 1）/,
  )
  open?.()
  await first
  const third = b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT })
  open?.()
  await third
})

test('an oversized result is refused instead of flooding the turn', async () => {
  const capability = provider({
    maxOutputChars: 500,
    async execute() {
      return { ok: true, data: { text: 'x'.repeat(2_000) } }
    },
  })
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /超过上限 500；请缩小 limit\/范围后重试/,
  )
})

test('a provider that throws is reported as a failed call, not a crash', async () => {
  const capability = provider({
    async execute() {
      throw new Error('boom')
    },
  })
  const b = broker([instance({ id: 'sense_a' })], capability)
  await assert.rejects(
    b.call({ capability: 'demo', operation: 'items.list', params: {}, grant: GRANT }),
    /执行失败：boom/,
  )
})

/* --------------------------------------------------------- registration */

test('registration is an effect and a second claim of one id is a bug', () => {
  const b = new CliCapabilityBroker({ listInstances: () => [instance({ id: 'sense_a' })] })
  const dispose = b.register(provider())
  assert.throws(() => b.register(provider()), /already registered/)
  dispose()
  assert.equal(b.describe().length, 0)
})
