/**
 * The yzj structured read capability: the Worker-facing synchronous surface
 * must declare exactly the three read operations, take the profile from the
 * configured instance (never the payload), and report every CLI failure class
 * instead of pretending a query succeeded.
 *
 * @module dsh-quno-sense-yzj/tests/capability
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createYzjCapability, YZJ_CAPABILITY, YZJ_COLLECTOR_TYPE, YZJ_OPERATIONS } from '../src/capability.ts'
import { apply } from '../src/index.ts'
import { REQUESTS_PER_MINUTE, resetTokens, takeToken } from '../src/index.ts'
import type { CliCallRequest } from '../../dsh-quno/src/cli-broker.ts'
import type { CliExec, CliRun } from '../src/index.ts'

function ok(list: readonly unknown[], more = false): CliRun {
  return { code: 0, stdout: JSON.stringify({ success: true, data: { list, more } }), stderr: '', failure: null }
}

function spyExec(answer: CliRun | ((args: readonly string[]) => CliRun)): { exec: CliExec; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  const exec: CliExec = async (args) => {
    calls.push(args)
    return typeof answer === 'function' ? answer(args) : answer
  }
  return { exec, calls }
}

function request(patch: Partial<CliCallRequest> = {}): CliCallRequest {
  return {
    capability: YZJ_CAPABILITY,
    target: { id: 'sense_a', label: '工作号', health: 'healthy', config: { yzjProfile: 'work' } },
    operation: 'im.group.recent',
    params: {},
    signal: new AbortController().signal,
    timeoutMs: 20_000,
    maxOutputChars: 24_000,
    ...patch,
  }
}

test('the declared surface is three read operations, no commands', () => {
  const provider = createYzjCapability(async () => ok([]))
  assert.equal(provider.capability, 'yzj')
  assert.equal(provider.collectorType, YZJ_COLLECTOR_TYPE)
  assert.deepEqual(Object.keys(provider.operations).sort(), ['im.group.recent', 'im.group.search', 'im.message.list'])
  assert.ok(Object.values(provider.operations).every(spec => spec.access === 'read'))
  assert.deepEqual(Object.keys(YZJ_OPERATIONS).sort(), Object.keys(provider.operations).sort())
})

test('the profile comes from the configured instance and never from the payload', async () => {
  resetTokens('work')
  const { exec, calls } = spyExec(ok([{ id: 'g1' }]))
  const provider = createYzjCapability(exec)
  const outcome = await provider.execute(request({ operation: 'im.message.list', params: { groupId: 'g1', limit: 2 } }))
  assert.equal(outcome.ok, true)
  assert.deepEqual(calls[0], ['--profile', 'work', 'im', 'message', 'list', '--group-id', 'g1', '--limit', '2'])
  const smuggled = await provider.execute(request({ params: { profile: 'other' } }))
  assert.equal(smuggled.ok, false)
  assert.equal(smuggled.ok === false ? smuggled.code : '', 'invalid-args')
  assert.equal(calls.length, 1, 'a refused payload must not spawn the CLI')
})

test('the declared bounds refuse out-of-range values before any process starts', async () => {
  resetTokens('work')
  const { exec, calls } = spyExec(ok([]))
  const provider = createYzjCapability(exec)
  const outcome = await provider.execute(request({ params: { limit: 21 } }))
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /1-20/)
  assert.equal(calls.length, 0)
})

test('CLI failure classes are reported, never a fake result', async () => {
  resetTokens('work')
  const authFailure = createYzjCapability(async () => ({
    code: 3,
    stdout: '',
    stderr: JSON.stringify({ success: false, error: { subtype: 'authentication', message: '未登录' } }),
    failure: null,
  }))
  const auth = await authFailure.execute(request())
  assert.equal(auth.ok, false)
  assert.equal(auth.ok === false ? auth.code : '', 'auth-required')
  assert.equal(auth.ok === false ? auth.retryable : true, false)

  resetTokens('work')
  const missing = createYzjCapability(async () => ({ code: null, stdout: '', stderr: '', failure: 'ENOENT' }))
  const gone = await missing.execute(request())
  assert.equal(gone.ok, false)
  assert.equal(gone.ok === false ? gone.code : '', 'unavailable')

  resetTokens('work')
  const badEnvelope = createYzjCapability(async () => ({ code: 0, stdout: 'not json', stderr: '', failure: null }))
  const broken = await badEnvelope.execute(request())
  assert.equal(broken.ok, false)
  assert.equal(broken.ok === false ? broken.code : '', 'bad-envelope')
})

test('the capability shares the polling rate budget instead of a second quota', async () => {
  resetTokens('work')
  const { exec, calls } = spyExec(ok([]))
  const provider = createYzjCapability(exec)
  for (let consumed = 0; consumed < REQUESTS_PER_MINUTE; consumed += 1) takeToken('work', Date.now())
  const outcome = await provider.execute(request())
  assert.equal(outcome.ok, false)
  assert.equal(outcome.ok === false ? outcome.code : '', 'rate-limited')
  assert.equal(outcome.ok === false ? outcome.retryable : false, true)
  assert.equal(calls.length, 0, 'a budget-exhausted read must not spawn the CLI')
})

test('the result is bounded to the broker output ceiling', async () => {
  resetTokens('work')
  const wide = Array.from({ length: 20 }, (_unused, index) => ({ id: `m${String(index)}`, text: 'x'.repeat(300) }))
  const provider = createYzjCapability(async () => ok(wide))
  const outcome = await provider.execute(request({ params: { limit: 20 }, maxOutputChars: 2_000 }))
  assert.equal(outcome.ok, true)
  const data = outcome.ok ? outcome.data as { count: number; truncated: boolean } : { count: 0, truncated: false }
  assert.equal(data.truncated, true, 'a clipped result must say it was clipped')
  assert.ok(data.count > 0 && data.count < 20)
})

test('the plugin registers the capability as an effect while it is mounted', () => {
  let registered: unknown
  let disposed = 0
  const effects: (() => void)[] = []
  const ctx = {
    get: (name: string) => {
      if (name === 'qunoCollectors') return { register: () => async () => {} }
      if (name === 'qunoCli') {
        return {
          register: (provider: unknown) => {
            registered = provider
            return () => {
              disposed += 1
            }
          },
        }
      }
      return undefined
    },
    effect: (factory: () => () => void) => {
      effects.push(factory())
    },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx as never)
  assert.equal((registered as { capability?: string } | undefined)?.capability, YZJ_CAPABILITY)
  effects.forEach(dispose => dispose())
  assert.equal(disposed, 1)
})
