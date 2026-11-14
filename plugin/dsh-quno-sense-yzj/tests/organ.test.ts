import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OrganExchangeRequest } from '../../dsh-quno/src/types.ts'
import {
  CALL_TIMEOUT_MS,
  ORGAN_BOUNDS,
  REQUESTS_PER_MINUTE,
  boundOrganList,
  handleOrganRequest,
  parseOrganPayload,
  registerOrganInstance,
  resetTokens,
  takeToken,
} from '../src/index.ts'
import type { CliExec, CliRun } from '../src/index.ts'

/* ------------------------------------------------------------------ helpers */

/** A successful CLI run carrying `data.list` + `data.more`. */
function ok(list: readonly unknown[], more = false): CliRun {
  return {
    code: 0,
    stdout: JSON.stringify({ success: true, data: { list, more } }),
    stderr: '',
    failure: null,
  }
}

/** An exec spy recording argv; answers every call with the given run. */
function spyExec(answer: CliRun | ((args: readonly string[]) => CliRun)): { exec: CliExec; calls: readonly (readonly string[])[] } {
  const calls: (readonly string[])[] = []
  const exec: CliExec = async (args) => {
    calls.push(args)
    return typeof answer === 'function' ? answer(args) : answer
  }
  return { exec, calls }
}

interface RecordedOutcome {
  complete?: unknown
  fail?: { readonly reason: string; readonly retryable: boolean }
}

function fakeRequest(payload: unknown, endpoint = 'organ:instance-under-test'): { request: OrganExchangeRequest; outcome: RecordedOutcome } {
  const outcome: RecordedOutcome = {}
  const request: OrganExchangeRequest = {
    exchangeId: 'exch-test',
    endpoint,
    payload,
    signal: new AbortController().signal,
    completeExchange: async (result) => {
      outcome.complete = result
    },
    failExchange: async (reason, retryable) => {
      outcome.fail = { reason, retryable }
    },
  }
  return { request, outcome }
}

/** One running instance with a unique profile; returns the disposer. */
function withInstance(instanceId: string, profile: string): () => void {
  resetTokens(profile)
  return registerOrganInstance(instanceId, profile)
}

/* ------------------------------------------------- payload whitelist (pure) */

test('payloads outside the whitelist are refused with the right reason', () => {
  // Non-object payloads are malformed, not an unknown op.
  for (const payload of [undefined, null, 'im.group.recent', 42]) {
    const parsed = parseOrganPayload(payload)
    assert.deepEqual({ ...parsed, detail: parsed.ok ? '' : '…' }, { ok: false, reason: 'invalid-args', detail: '…' })
  }
  // Objects whose op is missing or outside the enum are unsupported-op — this
  // is also the fate of every write intent (send/create/recall are not in it).
  for (const payload of [
    {},
    { op: 'im.message.send', params: { groupId: 'g1', text: 'hi' } },
    { op: 'im.group.create' },
    { op: 'im.message.recall' },
  ]) {
    const parsed = parseOrganPayload(payload)
    assert.equal(parsed.ok, false)
    if (parsed.ok) return
    assert.equal(parsed.reason, 'unsupported-op')
    assert.ok(parsed.detail.includes('im.group.recent'))
  }
})

test('bounds are refused, not clipped; unknown keys (including profile) are refused', () => {
  const refusals: readonly unknown[] = [
    { op: 'im.group.recent', params: { limit: 21 } },
    { op: 'im.group.recent', params: { page: 11 } },
    { op: 'im.group.recent', params: { limit: 1.5 } },
    { op: 'im.group.recent', params: { limit: true } },
    { op: 'im.group.recent', params: { profile: 'other' } },
    { op: 'im.group.search', params: { keyword: 'x'.repeat(65) } },
    { op: 'im.group.search', params: { keyword: '' } },
    { op: 'im.group.search', params: {} },
    { op: 'im.message.list', params: {} },
    { op: 'im.message.list', params: { groupId: 'g1', limit: 51 } },
    { op: 'im.message.list', params: { groupId: 'g1', page: 2 } },
    { op: 'im.message.list', params: { groupId: 'g'.repeat(65) } },
  ]
  for (const payload of refusals) {
    const parsed = parseOrganPayload(payload)
    assert.deepEqual({ ...parsed, detail: parsed.ok ? '' : '…' }, { ok: false, reason: 'invalid-args', detail: '…' })
  }
})

test('accepted payloads normalize defaults within the bounds', () => {
  const recent = parseOrganPayload({ op: 'im.group.recent' })
  assert.deepEqual(recent, { ok: true, op: 'im.group.recent', limit: ORGAN_BOUNDS.groupRecentLimit, page: 1 })
  const search = parseOrganPayload({ op: 'im.group.search', params: { keyword: ' 预算 ' } })
  assert.deepEqual(search, { ok: true, op: 'im.group.search', keyword: '预算', limit: ORGAN_BOUNDS.groupSearchLimit, page: 1 })
  const messages = parseOrganPayload({ op: 'im.message.list', params: { groupId: 'g1', limit: 50 } })
  assert.deepEqual(messages, { ok: true, op: 'im.message.list', groupId: 'g1', limit: ORGAN_BOUNDS.messageListLimit })
})

/* ------------------------------------------------------ output bounding */

test('boundOrganList slices to the limit and clips long string fields, reporting truncation', () => {
  const long = 'x'.repeat(ORGAN_BOUNDS.itemTextMaxChars + 10)
  const bounded = boundOrganList(
    [{ msgId: 'm1', text: long }, { msgId: 'm2', text: '短' }, { msgId: 'm3' }],
    2,
  )
  assert.equal(bounded.truncated, true)
  assert.equal(bounded.items.length, 2)
  const first = bounded.items[0] as { text: string }
  assert.equal(first.text.length, ORGAN_BOUNDS.itemTextMaxChars)
  const untouched = boundOrganList([{ msgId: 'm1', text: '短' }], 20)
  assert.equal(untouched.truncated, false)
  assert.equal(untouched.items.length, 1)
})

/* --------------------------------------------------------------- handler */

test('a stopped instance refuses without spawning the CLI', async () => {
  const { exec, calls } = spyExec(ok([]))
  const { request, outcome } = fakeRequest({ op: 'im.group.recent' }, 'organ:gone-instance')
  await handleOrganRequest(request, exec)
  assert.equal(calls.length, 0)
  assert.ok(outcome.fail?.reason.startsWith('instance-not-running'))
  assert.equal(outcome.fail?.retryable, false)
})

test('whitelist refusals never reach the CLI and carry a self-describing reason', async () => {
  const { exec, calls } = spyExec(ok([]))
  const dispose = withInstance('instance-whitelist', 'profile-whitelist')
  try {
    for (const payload of [{ op: 'im.message.send', params: { groupId: 'g1' } }, { op: 'im.group.recent', params: { limit: 99 } }]) {
      const { request, outcome } = fakeRequest(payload, 'organ:instance-whitelist')
      await handleOrganRequest(request, exec)
      assert.equal(calls.length, 0)
      assert.ok(outcome.fail !== undefined)
      assert.equal(outcome.fail?.retryable, false)
      assert.match(outcome.fail?.reason ?? '', /^(unsupported-op|invalid-args)：/)
    }
  } finally {
    dispose()
  }
})

test('an accepted recent-conversations read relays the bounded envelope', async () => {
  const { exec, calls } = spyExec(ok([{ name: '群A', lastMessage: 'hello' }], true))
  const dispose = withInstance('instance-recent', 'profile-recent')
  try {
    const { request, outcome } = fakeRequest({ op: 'im.group.recent', params: { limit: 1 } }, 'organ:instance-recent')
    await handleOrganRequest(request, exec)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], ['--profile', 'profile-recent', 'im', 'group', 'recent', '--limit', '1', '--page', '1'])
    assert.equal(outcome.fail, undefined)
    assert.deepEqual(outcome.complete, { op: 'im.group.recent', count: 1, more: true, truncated: false, list: [{ name: '群A', lastMessage: 'hello' }] })
  } finally {
    dispose()
  }
})

test('message reads map to `im message list --group-id` with no page flag', async () => {
  const { exec, calls } = spyExec(ok([]))
  const dispose = withInstance('instance-messages', 'profile-messages')
  try {
    const { request, outcome } = fakeRequest({ op: 'im.message.list', params: { groupId: 'g-42' } }, 'organ:instance-messages')
    await handleOrganRequest(request, exec)
    assert.deepEqual(calls[0], ['--profile', 'profile-messages', 'im', 'message', 'list', '--group-id', 'g-42', '--limit', String(ORGAN_BOUNDS.messageListLimit)])
    assert.deepEqual(outcome.complete, { op: 'im.message.list', count: 0, more: false, truncated: false, list: [] })
  } finally {
    dispose()
  }
})

test('classified CLI failures map to exchange failures with honest retryability', async () => {
  const cases: readonly { readonly run: CliRun; readonly reasonPrefix: string; readonly retryable: boolean }[] = [
    { run: { code: 3, stdout: '', stderr: JSON.stringify({ success: false, error: { message: '登录失效' } }), failure: null }, reasonPrefix: 'auth-required：', retryable: false },
    { run: { code: null, stdout: '', stderr: '', failure: 'ENOENT' }, reasonPrefix: 'unavailable：', retryable: false },
    { run: { code: 4, stdout: '', stderr: JSON.stringify({ success: false, error: { message: '网络失败' } }), failure: null }, reasonPrefix: 'unavailable：', retryable: true },
    { run: { code: 0, stdout: 'not json', stderr: '', failure: null }, reasonPrefix: 'bad-envelope：', retryable: false },
  ]
  for (const [index, entry] of cases.entries()) {
    const instanceId = `instance-classify-${String(index)}`
    const profile = `profile-classify-${String(index)}`
    const dispose = withInstance(instanceId, profile)
    try {
      const { exec, calls } = spyExec(entry.run)
      const { request, outcome } = fakeRequest({ op: 'im.group.recent' }, `organ:${instanceId}`)
      await handleOrganRequest(request, exec)
      assert.equal(calls.length, 1)
      assert.ok(outcome.fail?.reason.startsWith(entry.reasonPrefix), outcome.fail?.reason)
      assert.equal(outcome.fail?.retryable, entry.retryable)
      assert.equal(outcome.complete, undefined)
    } finally {
      dispose()
    }
  }
})

test('the on-demand read shares the per-profile polling budget', async () => {
  const dispose = withInstance('instance-budget', 'profile-budget')
  try {
    for (let consumed = 0; consumed < REQUESTS_PER_MINUTE; consumed += 1) {
      assert.equal(takeToken('profile-budget', Date.now()).ok, true)
    }
    const { exec, calls } = spyExec(ok([]))
    const { request, outcome } = fakeRequest({ op: 'im.group.recent' }, 'organ:instance-budget')
    await handleOrganRequest(request, exec)
    assert.equal(calls.length, 0, 'a budget-exhausted read must not spawn the CLI')
    assert.ok(outcome.fail?.reason.startsWith('rate-limited：'))
    assert.equal(outcome.fail?.retryable, true)
  } finally {
    dispose()
  }
})

test('the handler inherits the shared CALL_TIMEOUT_MS ceiling', async () => {
  let seenTimeout = 0
  const exec: CliExec = async (_args, _signal, timeoutMs) => {
    seenTimeout = timeoutMs
    return ok([])
  }
  const dispose = withInstance('instance-timeout', 'profile-timeout')
  try {
    const { request } = fakeRequest({ op: 'im.group.recent' }, 'organ:instance-timeout')
    await handleOrganRequest(request, exec)
    assert.equal(seenTimeout, CALL_TIMEOUT_MS)
  } finally {
    dispose()
  }
})
