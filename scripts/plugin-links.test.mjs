import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { describeDrift, scanPluginLinks } from './plugin-links.mjs'

/** A repo with one plugin whose node_modules mixes lockfile, runtime and source links. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-links-'))
  const plugin = join(root, 'plugin', 'dsh-demo')
  const scope = join(plugin, 'node_modules', '@deepseek-ai')
  const store = join(plugin, 'node_modules', '.pnpm', '@deepseek-ai+a@0.2.1', 'node_modules', '@deepseek-ai', 'a')
  const runtime = join(root, 'runtime', 'build', 'pkg')
  for (const dir of [scope, store, runtime, join(root, 'harness')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({
    name: 'dsh-demo',
    devDependencies: {
      '@deepseek-ai/a': '0.2.1-rc.2',
      '@deepseek-ai/b': 'link:../../harness',
      '@deepseek-ai/d': '0.2.1-rc.2',
    },
  }))
  // lockfile-managed (relative into .pnpm) — clean
  symlinkSync(join('..', '.pnpm', '@deepseek-ai+a@0.2.1', 'node_modules', '@deepseek-ai', 'a'), join(scope, 'a'))
  // deliberate source posture — skipped
  symlinkSync(join(root, 'harness'), join(scope, 'b'))
  // runtime relink of an undeclared peer — drift
  symlinkSync(runtime, join(scope, 'c'))
  // runtime relink of a declared registry dep — drift
  symlinkSync(runtime, join(scope, 'd'))
  // broken — drift
  symlinkSync(join(root, 'nowhere'), join(scope, 'e'))
  // the harness anchor itself is a symlinked "plugin" — never scanned
  symlinkSync(join(root, 'harness'), join(root, 'plugin', 'deepseek-harness'))
  return root
}

test('scanPluginLinks: flags runtime relinks and broken links, skips lockfile and link: posture', () => {
  const drift = scanPluginLinks(fixture())
  assert.equal(drift.length, 1)
  assert.equal(drift[0]?.plugin, 'dsh-demo')
  assert.deepEqual(drift[0]?.links.map(link => link.name), ['@deepseek-ai/c', '@deepseek-ai/d', '@deepseek-ai/e'])
  assert.equal(drift[0]?.links[2]?.target, '(broken link)')
})

test('describeDrift: names the plugin and the restore command', () => {
  const text = describeDrift(scanPluginLinks(fixture()))
  assert.match(text, /plugin\/dsh-demo: 3 link\(s\)/)
  assert.match(text, /pnpm run plugins:restore-links/)
})

test('a plugin that resolves entirely from its lockfile is clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-links-clean-'))
  const plugin = join(root, 'plugin', 'dsh-clean')
  const store = join(plugin, 'node_modules', '.pnpm', '@deepseek-ai+a@0.2.1', 'node_modules', '@deepseek-ai', 'a')
  mkdirSync(join(plugin, 'node_modules', '@deepseek-ai'), { recursive: true })
  mkdirSync(store, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-clean', devDependencies: { '@deepseek-ai/a': '0.2.1-rc.2' } }))
  symlinkSync(join('..', '.pnpm', '@deepseek-ai+a@0.2.1', 'node_modules', '@deepseek-ai', 'a'), join(plugin, 'node_modules', '@deepseek-ai', 'a'))
  assert.deepEqual(scanPluginLinks(root), [])
})
