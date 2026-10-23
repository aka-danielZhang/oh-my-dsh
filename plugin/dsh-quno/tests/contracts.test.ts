import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_QUNO_CONFIG,
  mergeQunoConfig,
  parseIngestBatch,
  parseQunoConfig,
  parseRunOutput,
  parseSenseDefinition,
} from '../src/contracts.ts'
import { envelope } from './helpers.ts'

const validSense = {
  type: 'quno/calendar',
  contractVersion: 'quno.sense/v1',
  implementationVersion: '0.1.0',
  displayName: '日历',
  description: '读取本地日历文件',
  eventTypes: [{ type: 'calendar/event-updated' }],
  permissions: { reads: ['calendar files'] },
  runtime: { modes: ['poll'], defaultIntervalSec: 60, minIntervalSec: 30, concurrency: 1, timeoutMs: 10_000 },
  reliability: {
    checkpoint: 'cursor',
    replay: { kind: 'bounded', windowSec: 3600 },
    changeCoverage: 'all-changes',
    gapDetection: 'explicit',
    readOriginal: false,
  },
}

test('batch validation: a valid non-empty batch parses', () => {
  const result = parseIngestBatch({
    batchKey: 'b1',
    events: [envelope({ eventKey: 'e1', type: 'calendar/event-updated' })],
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.value.events.length, 1)
})

test('batch validation: an empty batch must advance a checkpoint', () => {
  const noCheckpoint = parseIngestBatch({ batchKey: 'b1', events: [] })
  assert.equal(noCheckpoint.ok, false)
  if (!noCheckpoint.ok) assert.match(noCheckpoint.error.message, /checkpoint/)
  const withCheckpoint = parseIngestBatch({
    batchKey: 'b1',
    events: [],
    checkpointAfter: { value: 'cursor-1', revision: 0 },
  })
  assert.equal(withCheckpoint.ok, true)
})

test('batch validation: an upsert without summary or data is rejected', () => {
  const result = parseIngestBatch({
    batchKey: 'b1',
    events: [{ eventKey: 'e1', type: 'x/y', observedAt: '2026-10-23T09:00:00Z' }],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'validation')
    assert.match(result.error.message, /summary or data/)
  }
})

test('batch validation: an oversized event reports its index', () => {
  const result = parseIngestBatch({
    batchKey: 'b1',
    events: [
      envelope({ eventKey: 'e1', type: 'x/y' }),
      envelope({ eventKey: 'e2', type: 'x/y', summary: 'x'.repeat(70_000) }),
    ],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.index, 1)
})

test('sense declaration: unknown contract major version is refused', () => {
  const result = parseSenseDefinition({ ...validSense, contractVersion: 'quno.sense/v2' })
  assert.equal(result.ok, false)
})

test('sense declaration: minIntervalSec above defaultIntervalSec is refused', () => {
  const result = parseSenseDefinition({
    ...validSense,
    runtime: { ...validSense.runtime, minIntervalSec: 120, defaultIntervalSec: 60 },
  })
  assert.equal(result.ok, false)
})

test('sense declaration: checkpoint none cannot promise replay', () => {
  const result = parseSenseDefinition({
    ...validSense,
    reliability: { ...validSense.reliability, checkpoint: 'none' },
  })
  assert.equal(result.ok, false)
})

test('sense declaration: a well-formed declaration parses', () => {
  const result = parseSenseDefinition(validSense)
  assert.equal(result.ok, true)
})

test('config: defaults validate and fast ticks need the test override', () => {
  assert.equal(parseQunoConfig(DEFAULT_QUNO_CONFIG).ok, true)
  const fast = { ...DEFAULT_QUNO_CONFIG, checkIntervalSec: 5 }
  const refused = parseQunoConfig(fast)
  assert.equal(refused.ok, false)
  process.env.QUNO_ALLOW_FAST_TICKS = '1'
  try {
    assert.equal(parseQunoConfig(fast).ok, true)
  } finally {
    delete process.env.QUNO_ALLOW_FAST_TICKS
  }
})

test('config: partial patches merge nested groups instead of replacing them', () => {
  const merged = mergeQunoConfig(DEFAULT_QUNO_CONFIG, {
    notificationPolicy: { maxPerHour: 1 },
    budget: { maxEventsPerRun: 10 },
  })
  assert.equal(merged.ok, true)
  if (merged.ok) {
    assert.equal(merged.value.notificationPolicy.maxPerHour, 1)
    assert.equal(merged.value.notificationPolicy.minGapSec, DEFAULT_QUNO_CONFIG.notificationPolicy.minGapSec)
    assert.equal(merged.value.budget.maxEventsPerRun, 10)
    assert.equal(merged.value.budget.maxContextChars, DEFAULT_QUNO_CONFIG.budget.maxContextChars)
  }
})

test('config: an unknown time zone is refused', () => {
  const result = parseQunoConfig({ ...DEFAULT_QUNO_CONFIG, timeZone: 'Mars/Olympus' })
  assert.equal(result.ok, false)
})

test('run output: invalid shapes are refused, valid ones parse', () => {
  const invalid = parseRunOutput({ eventDecisions: [{ eventId: 'e', decision: 'maybe' }] }, DEFAULT_QUNO_CONFIG.budget)
  assert.equal(invalid.ok, false)
  const valid = parseRunOutput({
    eventDecisions: [{ eventId: 'e1', decision: 'processed' }],
    attentionChanges: [{
      action: 'create',
      topicKey: 'calendar/review',
      title: '评审改期',
      summary: '评审改到 10:00',
      material: true,
      evidence: [{ eventId: 'e1' }],
    }],
    notificationCandidates: [{ topicKey: 'calendar/review', reason: '时间冲突' }],
    uncertainties: [],
  }, DEFAULT_QUNO_CONFIG.budget)
  assert.equal(valid.ok, true)
})
