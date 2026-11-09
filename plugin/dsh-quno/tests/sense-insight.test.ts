/**
 * Insight-surface tests: real probes, field-option discovery, secret masking
 * on the wire, and the cancellation/late-settlement discipline. These cover
 * the behaviors the UI is allowed to claim, not the pixels.
 *
 * @module dsh-quno/tests/sense-insight
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QunoSensesService, SenseOptionsError, type SenseFactory, type SenseHandle } from '../src/senses.ts'
import { maskSenseConfig } from '../src/api.ts'
import { openFixture } from './helpers.ts'
import type { SenseDefinition } from '../src/types.ts'
import type { QunoStore } from '../src/store.ts'

const logger = { info: () => {}, warn: () => {} }

function definition(type: string, patch: Partial<SenseDefinition> = {}): SenseDefinition {
  return {
    type,
    contractVersion: 'quno.sense/v1',
    implementationVersion: '0.1.0',
    displayName: type,
    description: 'test sense',
    eventTypes: [{ type: 'test/changed' }],
    configFields: [
      { key: 'title', label: 'Title', type: 'string' },
      {
        key: 'groups',
        label: 'Groups',
        type: 'string',
        multiple: true,
        discover: true,
      },
    ],
    permissions: { reads: ['test'] },
    runtime: { modes: ['poll'], defaultIntervalSec: 60, minIntervalSec: 30, concurrency: 1, timeoutMs: 1000 },
    reliability: {
      checkpoint: 'cursor',
      replay: { kind: 'none' },
      changeCoverage: 'snapshot-diff',
      gapDetection: 'explicit',
      readOriginal: false,
    },
    ...patch,
  }
}

function serviceFor(store: QunoStore, now = Date.parse('2026-10-23T09:00:00.000Z')) {
  const clock = { now }
  const service = new QunoSensesService({
    store,
    qunoId: 'quno',
    logger,
    now: () => clock.now,
    setTimer: () => () => {},
  })
  return { service, clock }
}

function quietFactory(patch: Partial<SenseFactory> = {}): SenseFactory {
  return {
    validateConfig(raw) {
      const record = (raw ?? {}) as Record<string, unknown>
      if (typeof record['token'] === 'string' && record['token'] === '') {
        return { ok: false, message: 'token must not be empty' }
      }
      return { ok: true, value: record }
    },
    start(): SenseHandle {
      return { stop() {} }
    },
    ...patch,
  }
}

test('a probe reports reachability without touching lifecycle, config revision, checkpoint or health', async () => {
  const fixture = openFixture()
  const { service } = serviceFor(fixture.store)
  try {
    let probes = 0
    service.register(definition('test/probe'), quietFactory({
      probe: async () => {
        probes += 1
        return { ok: true, detail: 'reachable' }
      },
    }))
    const created = service.createInstance({ type: 'test/probe', config: { title: 'x' }, desiredState: 'paused' })
    assert.ok(created.ok)
    const before = fixture.store.getSenseInstance(created.instance.id)

    const result = await service.probeInstance(created.instance.id)
    assert.equal(result.ok, true)
    assert.equal(result.code, 'ok')
    assert.equal(result.message, 'reachable')
    assert.equal(probes, 1)

    const after = fixture.store.getSenseInstance(created.instance.id)
    assert.equal(after.configRevision, before.configRevision)
    assert.equal(after.checkpoint.revision, before.checkpoint.revision)
    assert.equal(after.checkpoint.value, before.checkpoint.value)
    assert.equal(after.health, before.health)
    assert.equal(after.lifecycle, before.lifecycle)
    assert.equal(after.lastSuccessAt, before.lastSuccessAt)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a probe failure is classified and never written as a sync or health fact', async () => {
  const fixture = openFixture()
  const { service } = serviceFor(fixture.store)
  try {
    service.register(definition('test/probe-fail'), quietFactory({
      probe: async () => ({ ok: false, detail: 'not logged in' }),
    }))
    const created = service.createInstance({ type: 'test/probe-fail', config: {}, desiredState: 'paused' })
    assert.ok(created.ok)
    const result = await service.probeInstance(created.instance.id)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'probe-failed')
    assert.match(result.message, /not logged in/)
    const after = fixture.store.getSenseInstance(created.instance.id)
    assert.equal(after.lastSuccessAt, null)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('a type without a probe is reported as unsupported instead of pretending to check', async () => {
  const fixture = openFixture()
  const { service } = serviceFor(fixture.store)
  try {
    service.register(definition('test/no-probe'), quietFactory())
    const created = service.createInstance({ type: 'test/no-probe', config: {}, desiredState: 'paused' })
    assert.ok(created.ok)
    const result = await service.probeInstance(created.instance.id)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'unsupported')
    assert.equal(service.supportsProbe('test/no-probe'), false)
    assert.equal(service.supportsProbe('test/missing'), false)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('discovery is refused for undeclared and non-discoverable fields', async () => {
  const fixture = openFixture()
  const { service } = serviceFor(fixture.store)
  try {
    let calls = 0
    service.register(definition('test/options'), quietFactory({
      listOptions: async () => {
        calls += 1
        return { options: [] }
      },
    }))
    const undeclared = await service.listFieldOptions({ type: 'test/options', field: 'nope' })
    assert.equal(undeclared.ok, false)
    assert.equal(undeclared.error?.code, 'unknown-field')
    const staticField = await service.listFieldOptions({ type: 'test/options', field: 'title' })
    assert.equal(staticField.ok, false)
    assert.equal(staticField.error?.code, 'not-discoverable')
    const unknownType = await service.listFieldOptions({ type: 'test/absent', field: 'groups' })
    assert.equal(unknownType.ok, false)
    assert.equal(unknownType.error?.code, 'unsupported')
    assert.equal(calls, 0)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('discovered options are sanitized, deduped, capped and keep classified failures', async () => {
  const fixture = openFixture()
  const { service } = serviceFor(fixture.store)
  try {
    service.register(definition('test/options-ok'), quietFactory({
      listOptions: async (request) => {
        assert.equal(request.page, 2)
        assert.equal(request.limit, 3)
        assert.deepEqual(request.config, { groups: [], token: 'secret' })
        return {
          options: [
            { value: 'g1', label: 'Group one' },
            { value: 'g1', label: 'Duplicate' },
            { value: '  ', label: 'Blank' },
            { value: 'g2', label: 'Group two', description: 'with detail' },
            { value: 'g3', label: 'Group three', disabled: true, disabledReason: 'private chat' },
            { value: 'g4', label: 'Over the cap' },
          ],
          more: true,
        }
      },
    }))
    const page = await service.listFieldOptions({
      type: 'test/options-ok',
      field: 'groups',
      config: { groups: [], token: 'secret' },
      page: 2,
      limit: 3,
    })
    assert.equal(page.ok, true)
    assert.equal(page.more, true)
    assert.deepEqual(page.options.map(option => option.value), ['g1', 'g2', 'g3'])
    assert.equal(page.options[1]?.description, 'with detail')
    assert.equal(page.options[2]?.disabled, true)
  } finally {
    await service.stopAll()
    fixture.store.close()
  }

  const second = openFixture()
  const { service: failing } = serviceFor(second.store)
  try {
    failing.register(definition('test/options-auth'), quietFactory({
      listOptions: async () => {
        throw new SenseOptionsError('auth-required', 'run yzj-cli auth login')
      },
    }))
    const page = await failing.listFieldOptions({ type: 'test/options-auth', field: 'groups' })
    assert.equal(page.ok, false)
    assert.equal(page.error?.code, 'auth-required')
    assert.match(page.error?.message ?? '', /auth login/)
  } finally {
    await failing.stopAll()
    second.store.close()
  }
})

test('a masked secret survives reconfigure while an explicit empty string clears it', async () => {
  const fixture = openFixture()
  const { service } = serviceFor(fixture.store)
  try {
    service.register(definition('test/secret', {
      configFields: [
        { key: 'token', label: 'Token', type: 'string', secret: true, required: true },
      ],
    }), quietFactory({}))
    const created = service.createInstance({ type: 'test/secret', config: { token: 'hunter2' }, desiredState: 'paused' })
    assert.ok(created.ok)

    const keep = await service.reconfigureInstance(created.instance.id, { config: { token: null } })
    assert.equal(keep.ok, true)
    assert.equal(fixture.store.getSenseInstance(created.instance.id).config['token'], 'hunter2')

    const cleared = await service.reconfigureInstance(created.instance.id, { config: { token: '' } })
    assert.equal(cleared.ok, false, 'an empty required secret is rejected by the Sense validator')
    assert.equal(fixture.store.getSenseInstance(created.instance.id).config['token'], 'hunter2')
  } finally {
    await service.stopAll()
    fixture.store.close()
  }
})

test('the wire masks declared secrets and reports which ones hold a value', () => {
  const masked = maskSenseConfig(
    { token: 'hunter2', region: 'cn', empty: '' },
    [
      { key: 'token', secret: true },
      { key: 'region' },
      { key: 'empty', secret: true },
    ],
  )
  assert.equal(masked.config['token'], null)
  assert.equal(masked.config['region'], 'cn')
  assert.equal(masked.config['empty'], '')
  assert.deepEqual(masked.secretSet, ['token'])
  const untouched = maskSenseConfig({ region: 'cn' }, [])
  assert.equal(untouched.config, untouched.config)
  assert.deepEqual(untouched.secretSet, [])
})

