import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  camelCaseStem,
  defaultDestRel,
  defaultEnvName,
  defaultTarballName,
  hashKeyForTarball,
  listShippedPluginSpecs,
  packEntriesFor,
  runtimeLinkPlan,
  shippedPluginsManifest,
} from './shipped-plugins.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('derives the historical tarball and hash keys', () => {
  assert.equal(defaultTarballName('dsh-desktop-bridge'), 'bridge.tar.gz')
  assert.equal(defaultTarballName('dsh-thread'), 'thread.tar.gz')
  assert.equal(defaultDestRel('dsh-desktop-bridge'), 'bridge')
  assert.equal(defaultDestRel('dsh-thread'), 'plugins/dsh-thread')
  assert.equal(hashKeyForTarball('compaction-hierarchical.tar.gz'), 'compactionHierarchicalTarball')
  assert.equal(hashKeyForTarball('web-search-toggle.tar.gz'), 'webSearchToggleTarball')
  assert.equal(camelCaseStem('model-efforts-editor'), 'modelEffortsEditor')
})

test('pack entries carry lib even when specs are listed before the build', () => {
  // Cold CI checkouts have no lib yet (gitignored); a conditional entry
  // packed boot-dead tarballs. lib must ride unconditionally.
  const dir = mkdtempSync(join(tmpdir(), 'shipped-plugins-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{}\n')
    assert.deepEqual(packEntriesFor(dir), ['package.json', 'lib'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lists every ship:true plugin once, including thread', () => {
  const specs = listShippedPluginSpecs(repoRoot)
  const names = specs.map((spec) => spec.package)
  assert.deepEqual(names, [
    'dsh-compaction-hierarchical',
    'dsh-desktop-bridge',
    'dsh-model-efforts-editor',
    'dsh-model-image-input',
    'dsh-send-while-running',
    'dsh-thread',
    'dsh-web-search-toggle',
  ])
  const thread = specs.find((spec) => spec.package === 'dsh-thread')
  assert.equal(thread?.tarball, 'thread.tar.gz')
  assert.equal(thread?.env, 'DSH_DESKTOP_THREAD_PLUGIN')
  assert.equal(thread?.hashKey, 'threadTarball')
  const compaction = specs.find((spec) => spec.package === 'dsh-compaction-hierarchical')
  assert.equal(compaction?.env, 'DSH_DESKTOP_COMPACTION_PLUGIN')
  assert.ok(!names.includes('dsh-branding'))
  assert.ok(!names.includes('dsh-mcp-settings'))
  assert.ok(!names.includes('dsh-question-rail'))
})

test('manifest slice is what a packaged shell can extract', () => {
  const specs = listShippedPluginSpecs(repoRoot)
  const manifest = shippedPluginsManifest(specs)
  assert.equal(manifest.length, specs.length)
  assert.deepEqual(Object.keys(manifest[0] ?? {}).sort(), ['destRel', 'env', 'hashKey', 'package', 'tarball'])
})

test('runtime link plan treats dependencies as required', () => {
  const plan = runtimeLinkPlan(join(repoRoot, 'plugin/dsh-compaction-hierarchical'))
  assert.ok(plan.optional.includes('@deepseek-ai/cordis'))
  assert.ok(!plan.required.includes('react'))
})

test('default env for a new ship:true plugin does not need a constants.ts edit', () => {
  assert.equal(defaultEnvName('dsh-brand-new-thing'), 'DSH_DESKTOP_BRAND_NEW_THING_PLUGIN')
})

test('shipped host sources do not value-import the deleted settingsNamespace export', () => {
  const hits = []
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === 'node_modules' || name === 'lib' || name === 'client') continue
        walk(full)
        continue
      }
      if (!name.endsWith('.ts')) continue
      const text = readFileSync(full, 'utf8')
      if (/import\s*\{[^}]*\bsettingsNamespace\b/.test(text)) hits.push(full)
    }
  }
  for (const spec of listShippedPluginSpecs(repoRoot)) walk(join(spec.dir, 'src'))
  assert.deepEqual(hits, [])
})
