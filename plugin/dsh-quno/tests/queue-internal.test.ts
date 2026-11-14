import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isInternalQueueSource, registerInternalQueueKinds } from '../src/client/queue-internal.ts'

test('human rows are never internal, whatever they carry', () => {
  assert.equal(isInternalQueueSource({ kind: 'user' }), false)
  assert.equal(isInternalQueueSource({ kind: 'user', presentation: 'internal' }), false)
  assert.equal(isInternalQueueSource({}), false)
})

test('the forward presentation flag decides without any registration', () => {
  assert.equal(isInternalQueueSource({ kind: 'future-plugin-source', presentation: 'internal' }), true)
})

test('registered legacy kinds filter durable rows; the disposer restores them', () => {
  const dispose = registerInternalQueueKinds(['quno-report', 'quno-notify'])
  assert.equal(isInternalQueueSource({ kind: 'quno-report' }), true)
  assert.equal(isInternalQueueSource({ kind: 'quno-notify' }), true)
  assert.equal(isInternalQueueSource({ kind: 'quno-unknown-future' }), false)
  dispose()
  assert.equal(isInternalQueueSource({ kind: 'quno-report' }), false)
  // Re-dispose is harmless (deleting absent keys is a no-op).
  dispose()
})
