import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MEM_ID_RE, newMemoryId, newScopeId, newTombstoneId, ulid, WS_ID_RE } from '../src/ids.ts'

test('ulid is 26 Crockford base32 chars and monotonic within a millisecond', () => {
  const a = ulid(1_700_000_000_000)
  const b = ulid(1_700_000_000_000)
  assert.equal(a.length, 26)
  assert.equal(b.length, 26)
  assert.notEqual(a, b)
  assert.ok(a < b, 'same-millisecond ulids sort monotonically')
  for (const char of a) {
    assert.match(char, /[0-9A-HJKMNP-TV-Z]/)
  }
})

test('prefixed id generators match their validators', () => {
  assert.ok(MEM_ID_RE.test(newMemoryId()))
  assert.ok(WS_ID_RE.test(newScopeId()))
  assert.ok(newTombstoneId().startsWith('tomb_'))
  assert.ok(!MEM_ID_RE.test('mem_lowercase'))
  assert.ok(!MEM_ID_RE.test('mem_short'))
})
