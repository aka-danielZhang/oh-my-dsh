/**
 * Healing decision tests: every arm of the veto chain, plus the single-session
 * lineage contract — ancestor healing is gone until evidence can be bound to
 * the fork cut.
 * @module dsh-fs-observation-log/tests/heal
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { healDecision, sessionLineage } from '../src/heal.ts'

test('a live observation needs no healing', () => {
  const decision = healDecision({ version: 'v1' }, { version: 'v1', sessionId: 's1' }, { version: 'v1' })
  assert.deepEqual(decision, { kind: 'skip', reason: 'live-observed' })
})

test('no stored evidence means no restore', () => {
  const decision = healDecision(undefined, undefined, { version: 'v1' })
  assert.deepEqual(decision, { kind: 'skip', reason: 'no-evidence' })
})

test('a target that no longer exists is not restored', () => {
  const decision = healDecision(undefined, { version: 'v1', sessionId: 's1' }, {})
  assert.deepEqual(decision, { kind: 'skip', reason: 'target-absent' })
})

test('a changed file (version drift) is not restored', () => {
  const decision = healDecision(undefined, { version: 'v1', sessionId: 's1' }, { version: 'v2' })
  assert.deepEqual(decision, { kind: 'skip', reason: 'version-changed' })
})

test('an unchanged file restores at the live token', () => {
  const decision = healDecision(undefined, { version: 'v1', sessionId: 's1' }, { version: 'v1' })
  assert.deepEqual(decision, { kind: 'restore', version: 'v1', fromSession: 's1' })
})

test('lineage: the acting session only — parent evidence is out of scope', () => {
  assert.deepEqual(sessionLineage({ id: 'child', parentSession: 'parent' }), ['child'])
  assert.deepEqual(sessionLineage({ id: 'child' }), ['child'])
})

test('lineage: a header without a usable id yields an empty lineage', () => {
  assert.deepEqual(sessionLineage({}), [])
  assert.deepEqual(sessionLineage({ id: '' }), [])
  assert.deepEqual(sessionLineage({ id: 42 }), [])
})
