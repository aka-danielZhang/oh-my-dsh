import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shippedPluginRefs } from './plugins.ts'

test('unpackaged roster follows dsh.desktop.ship', () => {
  const names = shippedPluginRefs(false).map((spec) => spec.package)
  assert.ok(names.includes('dsh-desktop-bridge'))
  assert.ok(names.includes('dsh-branding'))
  assert.ok(names.includes('dsh-provider-balance'))
  assert.ok(names.includes('dsh-mcp-settings'))
  assert.ok(!names.includes('dsh-thread'))
  assert.equal(new Set(names).size, names.length)
})
