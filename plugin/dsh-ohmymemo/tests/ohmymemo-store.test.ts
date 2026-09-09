import assert from 'node:assert/strict'
import { test } from 'node:test'
import { name, apply } from '../src/index.ts'

test('host half exports a loadable plugin', () => {
  assert.equal(name, 'dsh-ohmymemo')
  assert.equal(typeof apply, 'function')
})
