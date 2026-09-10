/**
 * Config validation tests: defaults, acceptance, and fail-loud rejections.
 * @module dsh-fs-observation-log/tests/config
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateConfig } from '../src/config.ts'

test('undefined and null configs yield the defaults', () => {
  const defaults = { maxEntriesPerSession: 200, maxWriteFailures: 5 }
  assert.deepEqual(validateConfig(undefined), defaults)
  assert.deepEqual(validateConfig(null), defaults)
  assert.deepEqual(validateConfig({}), defaults)
})

test('explicit values are accepted and preserved', () => {
  const config = validateConfig({ maxEntriesPerSession: 50, maxWriteFailures: 1 })
  assert.deepEqual(config, { maxEntriesPerSession: 50, maxWriteFailures: 1 })
})

test('non-object configs are rejected', () => {
  assert.throws(() => validateConfig(42), /config must be an object/)
  assert.throws(() => validateConfig('x'), /config must be an object/)
  assert.throws(() => validateConfig([1]), /config must be an object/)
})

test('unknown fields are rejected — including the retired fork-inheritance fields', () => {
  assert.throws(() => validateConfig({ nope: 1 }), /unknown config field/)
  assert.throws(() => validateConfig({ inheritFork: false }), /unknown config field "inheritFork"/)
  assert.throws(() => validateConfig({ maxLineageDepth: 4 }), /unknown config field "maxLineageDepth"/)
})

test('out-of-range and mistyped numerics are rejected', () => {
  assert.throws(() => validateConfig({ maxEntriesPerSession: 1 }), /maxEntriesPerSession/)
  assert.throws(() => validateConfig({ maxEntriesPerSession: 100001 }), /maxEntriesPerSession/)
  assert.throws(() => validateConfig({ maxEntriesPerSession: 1.5 }), /maxEntriesPerSession/)
  assert.throws(() => validateConfig({ maxWriteFailures: 0 }), /maxWriteFailures/)
  assert.throws(() => validateConfig({ maxWriteFailures: 1001 }), /maxWriteFailures/)
})
