import assert from 'node:assert/strict'
import { test } from 'node:test'
import { name, apply } from '../src/index.ts'
import { name as collectorName, apply as collectorApply } from '../src/collector.ts'
import { UsageStatsGateway } from '../src/gateway.ts'
import { TYPERT_HOST } from '../src/typert.host.ts'

test('host loader entry exports a loadable plugin', () => {
  assert.equal(name, 'dsh-usage-stats')
  assert.equal(typeof apply, 'function')
})

test('collector row exports a loadable plugin', () => {
  assert.equal(collectorName, 'dsh-usage-stats/collector')
  assert.equal(typeof collectorApply, 'function')
})

test('typert host contribution mirrors the four Remote endpoints', () => {
  assert.equal(TYPERT_HOST.package, 'dsh-usage-stats')
  assert.deepEqual(
    TYPERT_HOST.invocations.map(invocation => invocation.id).sort(),
    [
      'dsh-usage-stats#usageStats/activity',
      'dsh-usage-stats#usageStats/breakdown',
      'dsh-usage-stats#usageStats/daily',
      'dsh-usage-stats#usageStats/summary',
    ],
  )
})

test('gateway is a Typert Remote service class', () => {
  assert.equal(typeof UsageStatsGateway, 'function')
})
