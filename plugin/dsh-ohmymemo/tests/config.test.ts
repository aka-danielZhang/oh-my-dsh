import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validatePluginConfig } from '../src/config.ts'
import { defaultStoreRoot } from '../src/paths.ts'

test('defaults apply when no config is given', () => {
  const config = validatePluginConfig(undefined)
  assert.equal(config.watch, true)
  assert.equal(config.lockTimeoutMs, 5_000)
  assert.equal(config.watchDebounceMs, 120)
  assert.equal(config.root, undefined)
})

test('root override must be absolute; unknown fields fail loud', () => {
  assert.equal(validatePluginConfig({ root: '/tmp/ohmymemo' }).root, '/tmp/ohmymemo')
  assert.throws(() => validatePluginConfig({ root: 'relative/path' }), /absolute/)
  assert.throws(() => validatePluginConfig({ surprise: true }), /unknown config field/)
})

test('numeric bounds are enforced', () => {
  assert.throws(() => validatePluginConfig({ lockTimeoutMs: 1 }), /between/)
  assert.throws(() => validatePluginConfig({ lockTimeoutMs: 'slow' as unknown as number }), /integer/)
  assert.throws(() => validatePluginConfig({ watch: 'yes' as unknown as boolean }), /boolean/)
  const config = validatePluginConfig({ lockTimeoutMs: 1_000, watch: false })
  assert.equal(config.lockTimeoutMs, 1_000)
  assert.equal(config.watch, false)
})

test('defaultStoreRoot keeps index.ts honest about DSH_HOME resolution', () => {
  assert.equal(defaultStoreRoot('/scratch', '/Users/u'), '/scratch/ohmymemo')
})
