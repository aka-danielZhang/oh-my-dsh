import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, apply, inject, name } from '../src/index.ts'
import { qunoPresetRows, qunoTaskPresetRows, READ_ONLY_TOOLS } from '../src/presets.ts'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'

test('host entry declares the real dependency seam and a loadable apply', () => {
  assert.equal(name, 'dsh-quno')
  assert.equal(typeof apply, 'function')
  for (const service of ['agents', 'sessions', 'tools', 'systemPrompt', 'sessionPersistence', 'sessionQuery', 'jobs', 'timer']) {
    assert.equal(inject.includes(service), true, `missing ${service}`)
  }
  assert.equal(typeof Config, 'function')
})

test('the quno preset carries the Quno tool row and aggressive compaction', () => {
  const rows = qunoPresetRows()
  assert.equal(rows.some(row => row.name === 'dsh-quno/preset'), true)
  const compaction = rows.find(row => row.id === 'compaction')
  assert.ok(compaction !== undefined)
  assert.deepEqual(compaction.isolate, { compaction: true, toolResultPruner: true })
  const basic = (compaction.config as { id: string; config?: Record<string, unknown> }[]).find(row => row.id === 'compaction-basic')
  assert.equal(basic?.config?.['thresholdRatio'], 0.5)
  assert.equal(basic?.config?.['retainRatio'], 0.08)
  assert.equal(rows.some(row => row.name === 'dsh-quno/preset' && row.id === 'quno-tools'), true)
})

test('the task preset enforces the read-only boundary and keeps no shell', () => {
  const rows = qunoTaskPresetRows()
  assert.equal(rows.some(row => row.name === 'dsh-quno/task-guard'), true)
  assert.equal(rows.some(row => row.name === '@deepseek-ai/dsh-tool-bash'), false)
  assert.equal(rows.some(row => row.name === '@deepseek-ai/dsh-tool-fs'), true)
  assert.equal(READ_ONLY_TOOLS.includes('write'), false)
  assert.equal(READ_ONLY_TOOLS.includes('edit'), false)
  assert.equal(READ_ONLY_TOOLS.includes('read'), true)
})

test('default policy is meaningful-only notification with quiet hours', () => {
  assert.equal(DEFAULT_QUNO_CONFIG.notificationPolicy.mode, 'meaningful')
  assert.equal(DEFAULT_QUNO_CONFIG.notificationPolicy.allowUrgentWake, false)
  assert.deepEqual(DEFAULT_QUNO_CONFIG.quietHours, { start: '22:00', end: '08:00' })
  assert.equal(DEFAULT_QUNO_CONFIG.checkIntervalSec, 300)
})
