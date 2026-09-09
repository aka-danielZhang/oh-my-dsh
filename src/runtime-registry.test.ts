import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  NPMJS_REGISTRY,
  NPMMIRROR_REGISTRY,
  concatChunkFiles,
  extractNpmPayload,
  fetchRuntimeRevisionFromUrls,
  npmRegistryTarballUrl,
  parseRuntimeRevision,
  readNpmrcRegistry,
  resolveRuntimeRegistries,
  runtimeNpmChunkName,
  runtimeRevisionAssetName,
  isRuntimePayloadReady,
  planAtomicUpdateReady,
  planDownloadUpdateReady,
  planInstallUpdate,
  splitFileIntoChunks,
} from './runtime-registry.ts'

describe('runtime npm names', () => {
  it('is scoped, platform-keyed, and chunk-indexed', () => {
    assert.equal(
      runtimeNpmChunkName('darwin-arm64', 0),
      '@crazx/dsh-desktop-runtime-darwin-arm64-0',
    )
    assert.equal(
      runtimeNpmChunkName('win32-x64', 3),
      '@crazx/dsh-desktop-runtime-win32-x64-3',
    )
  })

  it('names the per-platform revision asset so mac and win do not clobber', () => {
    assert.equal(runtimeRevisionAssetName('darwin', 'arm64'), 'runtime-revision-darwin-arm64.json')
    assert.equal(runtimeRevisionAssetName('win32', 'x64'), 'runtime-revision-win32-x64.json')
  })
})

describe('npmRegistryTarballUrl', () => {
  it('matches the npm pack / pnpm registry path', () => {
    assert.equal(
      npmRegistryTarballUrl(NPMJS_REGISTRY, '@crazx/dsh-desktop-runtime-darwin-arm64-0', 'v0.3.0-rc.40'),
      'https://registry.npmjs.org/@crazx/dsh-desktop-runtime-darwin-arm64-0/-/dsh-desktop-runtime-darwin-arm64-0-0.3.0-rc.40.tgz',
    )
    assert.equal(
      npmRegistryTarballUrl(`${NPMMIRROR_REGISTRY}/`, '@crazx/foo', '1.2.3'),
      'https://registry.npmmirror.com/@crazx/foo/-/foo-1.2.3.tgz',
    )
  })
})

describe('resolveRuntimeRegistries', () => {
  it('reads .npmrc and puts user / npmmirror ahead of npmjs', () => {
    const urls = resolveRuntimeRegistries(
      { DSH_RUNTIME_REGISTRY: 'https://registry.example.test/' },
      'registry=https://registry.npmmirror.com/\n',
    )
    assert.deepEqual(urls, [
      'https://registry.example.test',
      'https://registry.npmmirror.com',
      'https://registry.npmjs.org',
    ])
  })

  it('dedupes the default npmmirror when the user already set it', () => {
    const urls = resolveRuntimeRegistries({ npm_config_registry: 'https://registry.npmmirror.com' })
    assert.equal(urls[0], 'https://registry.npmmirror.com')
    assert.equal(urls.includes(NPMJS_REGISTRY), true)
    assert.equal(urls.filter((url) => url === NPMMIRROR_REGISTRY).length, 1)
  })

  it('parses a comment-tolerant npmrc', () => {
    assert.equal(readNpmrcRegistry('# hi\n; no\nregistry = "https://r.example/"\n'), 'https://r.example')
    assert.equal(readNpmrcRegistry('legacy-peer-deps=true\n'), undefined)
  })

  it('DSH_RUNTIME_REGISTRY_ONLY skips public npm mirrors', () => {
    const urls = resolveRuntimeRegistries({
      DSH_RUNTIME_REGISTRY: 'http://127.0.0.1:9',
      DSH_RUNTIME_REGISTRY_ONLY: '1',
    })
    assert.deepEqual(urls, ['http://127.0.0.1:9'])
  })
})

describe('runtime revision parsing', () => {
  it('requires sha and tarball hash', () => {
    assert.equal(parseRuntimeRevision({ sha: 'abc' }), undefined)
    assert.deepEqual(
      parseRuntimeRevision({ sha: 'abc', runtimeTarball: 'def', extra: true }),
      { sha: 'abc', runtimeTarball: 'def' },
    )
  })

  it('returns the first URL that yields a valid revision', () => {
    const got = fetchRuntimeRevisionFromUrls(
      ['https://bad.example/a', 'https://ok.example/b'],
      (url) => {
        if (url.endsWith('/a')) throw new Error('404')
        return JSON.stringify({ sha: 's', runtimeTarball: 'h' })
      },
    )
    assert.deepEqual(got, { sha: 's', runtimeTarball: 'h' })
  })
})

describe('atomic update ready', () => {
  it('waits for the matching runtime even when an older tree exists', () => {
    assert.equal(planAtomicUpdateReady({ zipReady: false, runtimeReady: false }), 'wait-zip')
    assert.equal(planAtomicUpdateReady({ zipReady: true, runtimeReady: false }), 'wait-runtime')
    assert.equal(planAtomicUpdateReady({ zipReady: true, runtimeReady: true }), 'ready')
    assert.equal(isRuntimePayloadReady({ okMatches: false, shaDirReady: false }), false)
    assert.equal(isRuntimePayloadReady({ okMatches: false, shaDirReady: true }), true)
    assert.equal(isRuntimePayloadReady({ okMatches: true, shaDirReady: false }), true)
  })

  it('mac download/install wait for both payloads; Windows does not prestage', () => {
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath: undefined, runtimeReady: true }),
      'wait-zip',
    )
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath: '/tmp/update.zip', runtimeReady: false }),
      'wait-runtime',
    )
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath: '/tmp/update.zip', runtimeReady: true }),
      'ready',
    )
    assert.equal(
      planDownloadUpdateReady({ platform: 'win32', zipPath: undefined, runtimeReady: false }),
      'ready',
    )
    assert.equal(planInstallUpdate({ platform: 'darwin', runtimeReady: false }), 'refuse-runtime')
    assert.equal(planInstallUpdate({ platform: 'darwin', runtimeReady: true }), 'install')
    assert.equal(planInstallUpdate({ platform: 'win32', runtimeReady: false }), 'install')
  })
})

describe('chunk split and join', () => {
  it('round-trips bytes across 80MB-style splits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rt-chunk-'))
    try {
      const src = path.join(dir, 'src.bin')
      const payload = Buffer.concat([
        Buffer.from('head-'),
        Buffer.alloc(40, 0x61),
        Buffer.from('-tail'),
      ])
      fs.writeFileSync(src, payload)
      const parts = splitFileIntoChunks(src, path.join(dir, 'parts'), 16)
      assert.ok(parts.length >= 3)
      const dest = path.join(dir, 'out.bin')
      concatChunkFiles(parts, dest)
      assert.deepEqual(fs.readFileSync(dest), payload)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty concat', () => {
    assert.throws(() => concatChunkFiles([], '/tmp/nope'), /no chunks/)
  })
})

describe('extractNpmPayload', () => {
  it('pulls package/payload.bin out of an npm pack tarball', (t) => {
    const tar = spawnSync('tar', ['--version'], { stdio: 'ignore' })
    if (tar.status !== 0) {
      t.skip('tar binary unavailable')
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npm-pack-'))
    try {
      const pkg = path.join(dir, 'package')
      fs.mkdirSync(pkg)
      fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"x"}\n')
      fs.writeFileSync(path.join(pkg, 'payload.bin'), 'runtime-bytes')
      const tgz = path.join(dir, 'pack.tgz')
      const packed = spawnSync('tar', ['-czf', tgz, 'package'], { cwd: dir, stdio: 'ignore' })
      assert.equal(packed.status, 0)
      const dest = path.join(dir, 'payload.bin')
      extractNpmPayload(tgz, dest)
      assert.equal(fs.readFileSync(dest, 'utf8'), 'runtime-bytes')
      assert.equal(createHash('sha256').update('runtime-bytes').digest('hex').length, 64)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
