import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The npm runtime publish script only executes inside the Release workflow
 * (npm-token gated); v0.3.0-rc.41 shipped it importing `mkdtempSync` from
 * node:os — a link-time ESM error no main-branch CI step ever ran into, so
 * the release pipeline was its first execution and it failed after the
 * builds. These tests import the module on every push: a bad builtin named
 * export now fails CI, not the release.
 */
test('publish-runtime-npm links and exports its helpers', async () => {
  const mod = await import('./publish-runtime-npm.mjs')
  assert.equal(typeof mod.publishRuntimeNpm, 'function')
  assert.equal(typeof mod.runtimeNpmChunkName, 'function')
  assert.equal(typeof mod.splitFileIntoChunks, 'function')
})

test('runtimeNpmChunkName formats the scoped package id', async () => {
  const mod = await import('./publish-runtime-npm.mjs')
  assert.equal(mod.runtimeNpmChunkName('darwin-arm64', 0), '@crazx/dsh-desktop-runtime-darwin-arm64-0')
})

test('splitFileIntoChunks splits by the byte budget', async () => {
  const mod = await import('./publish-runtime-npm.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-rt-split-test-'))
  try {
    const payload = join(dir, 'payload.bin')
    writeFileSync(payload, Buffer.alloc(2500, 7))
    const chunks = mod.splitFileIntoChunks(payload, join(dir, 'out'), 1024)
    assert.deepEqual(chunks.map(path => statSync(path).size), [1024, 1024, 452])
    assert.deepEqual(chunks.map(path => readFileSync(path)[0]), [7, 7, 7], 'chunk bytes come from the source payload')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('npmPublishTag keeps prereleases off latest', async () => {
  const mod = await import('./publish-runtime-npm.mjs')
  assert.equal(mod.npmPublishTag('0.3.0-rc.42'), 'rc')
  assert.equal(mod.npmPublishTag('0.3.0'), 'latest')
  assert.equal(mod.npmPublishTag('0.3.0-rc.42+zw.1'), 'rc', 'build metadata is not a prerelease marker')
})
