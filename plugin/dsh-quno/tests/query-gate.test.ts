/**
 * The query gate and discovery projection (plan note 2026-11-08 F2/F3): an
 * endpoint is answerable only when its instance is mounted AND its type
 * declares `handleRequest`; the discovery list only ever contains endpoints
 * the gate would let through. Since the query face is request-only, a
 * `command` exchange has no answerer anywhere.
 *
 * @module dsh-quno/tests/query-gate
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QunoCollectorsService, type CollectorFactory } from '../src/collectors.ts'
import { collectorEndpointsOf, queryAdvertises } from '../src/service.ts'
import { openFixture } from './helpers.ts'
import type { CollectorEndpointView, CollectorDefinition, CollectorInstanceRecord } from '../src/types.ts'

const logger = { info: () => {}, warn: () => {} }

function definition(type: string, query: CollectorDefinition['query']): CollectorDefinition {
  return {
    type,
    contractVersion: 'quno.collector/v2',
    implementationVersion: '0.1.0',
    displayName: type,
    description: 'test collectors',
    eventTypes: [{ type: 'test/changed' }],
    permissions: { reads: [] },
    schedule: { defaultIntervalSec: 60, minIntervalSec: 30, maxRunMs: 5000 },
    reliability: {
      checkpoint: 'cursor',
      replay: { kind: 'none' },
      changeCoverage: 'snapshot-diff',
      gapDetection: 'explicit',
      readOriginal: false,
    },
    query,
  }
}

function noopFactory(): CollectorFactory {
  return {
    run: async () => ({ ok: true }),
  }
}

/* ------------------------------------------------------- pure gate matrix */

test('the gate demands a declared handleRequest; command exchanges have no answerer', () => {
  const requestOnly = { handleRequest: async () => {} }
  assert.equal(queryAdvertises(requestOnly, 'request'), true)
  assert.equal(queryAdvertises(requestOnly, 'command'), false)
  assert.equal(queryAdvertises({}, 'request'), false)
  assert.equal(queryAdvertises(undefined, 'request'), false)
  assert.equal(queryAdvertises(undefined, 'command'), false)
})

/* -------------------------------------------------- pure discovery view */

test('the discovery projection lists only query-facing instances', () => {
  const requestOnly = { handleRequest: async () => {} }
  const instances = [
    { id: 'col_a', type: 't/with-request', label: '云之家（工作号）', health: 'healthy' },
    { id: 'col_b', type: 't/plain', label: '没有 query 面', health: 'healthy' },
    { id: 'col_c', type: 't/empty-query', label: '空 query', health: 'degraded' },
  ] as unknown as CollectorInstanceRecord[]
  const views: readonly CollectorEndpointView[] = collectorEndpointsOf(instances, id =>
    id === 'col_a' ? requestOnly : id === 'col_c' ? {} : undefined)
  assert.deepEqual(views, [
    {
      endpoint: 'collector:col_a',
      label: '云之家（工作号）',
      type: 't/with-request',
      capabilities: { request: true },
      health: 'healthy',
    },
  ])
})

test('an empty projection is the honest "no collectors" state', () => {
  assert.deepEqual(collectorEndpointsOf([], () => undefined), [])
  assert.deepEqual(collectorEndpointsOf([{ id: 'x', type: 't/x', label: 'x', health: 'healthy' } as unknown as CollectorInstanceRecord], () => undefined), [])
})

/* --------------------------------------------------- registry integration */

test('the registry resolves the declaration of a mounted instance and refuses unknown ids', () => {
  const fixture = openFixture()
  const service = new QunoCollectorsService({ store: fixture.store, qunoId: 'quno', logger, now: () => fixture.now })
  try {
    service.register(definition('test/query', { handleRequest: async () => {} }), noopFactory())
    const created = service.createInstance({ type: 'test/query', config: {}, desiredState: 'enabled' })
    assert.equal(created.ok, true)
    const instanceId = created.ok && created.instance !== undefined ? created.instance.id : ''
    assert.ok(instanceId !== '')
    const query = service.queryCapabilitiesForInstance(instanceId)
    assert.equal(typeof query?.handleRequest, 'function')
    assert.equal(queryAdvertises(query, 'request'), true)
    // An unknown or type-less id resolves to no declaration — the gate refuses.
    assert.equal(service.queryCapabilitiesForInstance('col_unknown'), undefined)
    assert.equal(queryAdvertises(service.queryCapabilitiesForInstance('col_unknown'), 'request'), false)
  } finally {
    void service.stopAll()
    fixture.store.close()
  }
})
