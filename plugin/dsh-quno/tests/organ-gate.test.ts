/**
 * The organ gate and discovery projection (plan note 2026-11-08 F2/F3): an
 * endpoint is answerable only when its instance is mounted AND its type
 * declares the handler this exchange kind needs; the discovery list only
 * ever contains endpoints the gate would let through.
 *
 * @module dsh-quno/tests/organ-gate
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QunoSensesService, type SenseFactory, type SenseHandle } from '../src/senses.ts'
import { organEndpointsOf, organGateAdvertises } from '../src/service.ts'
import { openFixture } from './helpers.ts'
import type { OrganEndpointView, SenseDefinition, SenseInstanceRecord } from '../src/types.ts'

const logger = { info: () => {}, warn: () => {} }

function definition(type: string, organ: SenseDefinition['organ']): SenseDefinition {
  return {
    type,
    contractVersion: 'quno.sense/v1',
    implementationVersion: '0.1.0',
    displayName: type,
    description: 'test sense',
    eventTypes: [{ type: 'test/changed' }],
    permissions: { reads: [] },
    runtime: { modes: ['poll'], defaultIntervalSec: 60, minIntervalSec: 30, concurrency: 1, timeoutMs: 5000 },
    reliability: {
      checkpoint: 'cursor',
      replay: { kind: 'none' },
      changeCoverage: 'snapshot-diff',
      gapDetection: 'explicit',
      readOriginal: false,
    },
    organ,
  }
}

function noopFactory(): SenseFactory {
  return {
    start(): SenseHandle {
      return { stop() {} }
    },
  }
}

/* ------------------------------------------------------- pure gate matrix */

test('the gate demands the kind-matching handler, not just a mounted type', () => {
  const requestOnly = { handleRequest: async () => {} }
  const commandOnly = { handleCommand: async () => {} }
  assert.equal(organGateAdvertises(requestOnly, 'request'), true)
  assert.equal(organGateAdvertises(requestOnly, 'command'), false)
  assert.equal(organGateAdvertises(commandOnly, 'request'), false)
  assert.equal(organGateAdvertises(commandOnly, 'command'), true)
  assert.equal(organGateAdvertises({ handleRequest: async () => {}, handleCommand: async () => {} }, 'command'), true)
  assert.equal(organGateAdvertises(undefined, 'request'), false)
})

/* -------------------------------------------------- pure discovery view */

test('the discovery projection lists only exchange-facing instances', () => {
  const requestOnly = { handleRequest: async () => {} }
  const threadsOnly = { resolveThreads: () => ({ status: 'unresolved' as const, reason: 'no threads' }) }
  const instances = [
    { id: 'sense_a', type: 't/with-request', label: '云之家（工作号）', health: 'healthy' },
    { id: 'sense_b', type: 't/threads-only', label: '只有 resolveThreads', health: 'healthy' },
    { id: 'sense_c', type: 't/empty-organ', label: '空 organ', health: 'degraded' },
  ] as unknown as SenseInstanceRecord[]
  const views: readonly OrganEndpointView[] = organEndpointsOf(instances, id =>
    id === 'sense_a' ? requestOnly : id === 'sense_c' ? {} : threadsOnly)
  assert.deepEqual(views, [
    {
      endpoint: 'organ:sense_a',
      label: '云之家（工作号）',
      type: 't/with-request',
      capabilities: { request: true, command: false },
      health: 'healthy',
    },
  ])
})

test('an empty projection is the honest "no organs" state', () => {
  assert.deepEqual(organEndpointsOf([], () => undefined), [])
  assert.deepEqual(organEndpointsOf([{ id: 'x', type: 't/x', label: 'x', health: 'healthy' } as unknown as SenseInstanceRecord], () => undefined), [])
})

/* --------------------------------------------------- registry integration */

test('the registry resolves the declaration of a mounted instance and refuses unknown ids', () => {
  const fixture = openFixture()
  const service = new QunoSensesService({ store: fixture.store, qunoId: 'quno', logger, now: () => fixture.now })
  try {
    service.register(definition('test/organ', { handleRequest: async () => {} }), noopFactory())
    const created = service.createInstance({ type: 'test/organ', config: {}, desiredState: 'enabled' })
    assert.equal(created.ok, true)
    const instanceId = created.ok && created.instance !== undefined ? created.instance.id : ''
    assert.ok(instanceId !== '')
    const organ = service.organCapabilitiesForInstance(instanceId)
    assert.equal(typeof organ?.handleRequest, 'function')
    assert.equal(organGateAdvertises(organ, 'request'), true)
    // An unknown or type-less id resolves to no declaration — the gate refuses.
    assert.equal(service.organCapabilitiesForInstance('sense_unknown'), undefined)
    assert.equal(organGateAdvertises(service.organCapabilitiesForInstance('sense_unknown'), 'request'), false)
  } finally {
    void service.stopAll()
    fixture.store.close()
  }
})
