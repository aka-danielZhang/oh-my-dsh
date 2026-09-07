import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shippedPluginRefs } from './plugins.ts'

test('unpackaged roster follows dsh.desktop.ship and includes thread', () => {
  const names = shippedPluginRefs(false).map((spec) => spec.package)
  assert.ok(names.includes('dsh-thread'))
  assert.ok(names.includes('dsh-desktop-bridge'))
  assert.ok(names.includes('dsh-branding'))
  assert.ok(names.includes('dsh-provider-balance'))
  // mcp-settings 暂缓随包（旧基线解析债），见 docs/notes/2026-09-07-desktop-ships-all-plugins.md
  assert.ok(!names.includes('dsh-mcp-settings'))
  assert.equal(new Set(names).size, names.length)
})
