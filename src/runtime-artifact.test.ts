import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'

import { releaseRuntimeDir } from './runtime.ts'
import {
  curlDownloadArgs,
  decideRuntimeSource,
  latestMacYml,
  patchUpdaterYml,
  runtimeArtifactName,
  readBundledRevisionFromZip,
  runtimeDownloadUrls,
  stripRuntimeResources,
} from './runtime-artifact.ts'

describe('decideRuntimeSource', () => {
  it('uses the hashed cache when .ok matches', () => {
    assert.equal(decideRuntimeSource({ okMatches: true, bundledTarExists: false }), 'ok-cache')
    assert.equal(decideRuntimeSource({ okMatches: true, bundledTarExists: true }), 'ok-cache')
  })

  it('extracts the bundled tar when present', () => {
    assert.equal(decideRuntimeSource({ okMatches: false, bundledTarExists: true }), 'bundled-tar')
  })

  it('downloads when the slim zip omitted the tar', () => {
    assert.equal(decideRuntimeSource({ okMatches: false, bundledTarExists: false }), 'download')
  })

  it('reuses the sha-keyed extract when the shell bumps tarball hash', () => {
    assert.equal(
      decideRuntimeSource({ okMatches: false, shaDirReady: true, bundledTarExists: false }),
      'ok-cache',
    )
  })
})

describe('runtime artifact names', () => {
  it('is content-addressed by sha and build platform', () => {
    assert.equal(
      runtimeArtifactName('222343c801cf39f817709c373dbfc3b3a7ba84b4', 'darwin', 'arm64'),
      'runtime-222343c801cf39f817709c373dbfc3b3a7ba84b4-darwin-arm64.tar.gz',
    )
  })

  it('lists the versioned Release URL before latest/download', () => {
    const urls = runtimeDownloadUrls({
      sha: 'abc',
      version: '0.3.0-rc.4',
      platform: 'darwin',
      arch: 'arm64',
    })
    assert.equal(urls[0], 'https://github.com/aka-danielZhang/oh-my-dsh/releases/download/v0.3.0-rc.4/runtime-abc-darwin-arm64.tar.gz')
    assert.ok(urls[1]?.includes('/releases/latest/download/runtime-abc-darwin-arm64.tar.gz'))
  })
})

describe('stripRuntimeResources', () => {
  it('removes runtime.tar.gz and the cache marker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-slim-'))
    fs.writeFileSync(path.join(dir, 'runtime.tar.gz'), 'tar')
    fs.writeFileSync(path.join(dir, 'runtime.tar.gz.sha'), 'key')
    fs.writeFileSync(path.join(dir, 'runtime-revision.json'), '{}')
    assert.deepEqual(stripRuntimeResources(dir).sort(), ['runtime.tar.gz', 'runtime.tar.gz.sha'])
    assert.equal(fs.existsSync(path.join(dir, 'runtime.tar.gz')), false)
    assert.equal(fs.existsSync(path.join(dir, 'runtime-revision.json')), true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('latestMacYml', () => {
  it('writes a zip-pointing updater yml without borrowing a dmg path', () => {
    const yml = latestMacYml({
      version: '0.3.0-rc.5',
      file: 'Oh-My-DSH-0.3.0-rc.5-arm64.zip',
      sha512: 'abc',
      size: 360000000,
      releaseDate: '2026-08-28T06:00:00.000Z',
      releaseNotes: '### Faster\n- zip is slim',
    })
    assert.match(yml, /^version: 0\.3\.0-rc\.5$/m)
    assert.match(yml, /url: Oh-My-DSH-0\.3\.0-rc\.5-arm64\.zip/)
    assert.match(yml, /^path: Oh-My-DSH-0\.3\.0-rc\.5-arm64\.zip$/m)
    assert.match(yml, /sha512: abc/)
    assert.match(yml, /size: 360000000/)
    assert.match(yml, /releaseDate: '2026-08-28T06:00:00\.000Z'/)
    assert.match(yml, /^releaseNotes: \|$/m)
    assert.match(yml, /^  - zip is slim$/m)
    assert.equal(yml.includes('.dmg'), false)
  })

  it('omits releaseNotes when empty', () => {
    const yml = latestMacYml({
      version: '1.0.0',
      file: 'app.zip',
      sha512: 'x',
      size: 1,
      releaseDate: '2026-01-01T00:00:00.000Z',
    })
    assert.equal(yml.includes('releaseNotes'), false)
  })
})

describe('patchUpdaterYml', () => {
  it('rewrites sha512 and size after the slim zip is rebuilt', () => {
    const yml = [
      'version: 0.3.0-rc.4',
      'files:',
      '  - url: Oh-My-DSH-0.3.0-rc.4-arm64.zip',
      '    sha512: oldhash',
      '    size: 476000000',
      'path: Oh-My-DSH-0.3.0-rc.4-arm64.zip',
      'sha512: oldhash',
      '',
    ].join('\n')
    const next = patchUpdaterYml(yml, 'newhash', 360000000)
    assert.match(next, /sha512: newhash/)
    assert.match(next, /size: 360000000/)
    assert.equal(next.includes('oldhash'), false)
  })
})

describe('releaseRuntimeDir cache hit', () => {
  it('returns the hashed cache without needing a bundled tar', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'))
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-app-'))
    const resources = path.join(appRoot, 'resources')
    const sha = 'deadbeefcafebabe'
    const hash = 'abc123'
    const previousHome = process.env.HOME
    const previousResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    fs.mkdirSync(resources, { recursive: true })
    fs.mkdirSync(path.join(home, '.dsh-desktop', 'runtime', sha), { recursive: true })
    fs.writeFileSync(path.join(home, '.dsh-desktop', 'runtime', sha, '.ok'), `${hash}\n`)
    fs.writeFileSync(path.join(resources, 'runtime-revision.json'), JSON.stringify({ sha, runtimeTarball: hash }))
    process.env.HOME = home
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: appRoot })
    try {
      assert.equal(releaseRuntimeDir(true), path.join(home, '.dsh-desktop', 'runtime', sha))
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousResources === undefined) delete (process as { resourcesPath?: string }).resourcesPath
      else Object.defineProperty(process, 'resourcesPath', previousResources)
      fs.rmSync(home, { recursive: true, force: true })
      fs.rmSync(appRoot, { recursive: true, force: true })
    }
  })
})

describe('readBundledRevisionFromZip', () => {
  it('returns undefined for a missing zip or a non-zip file', () => {
    assert.equal(readBundledRevisionFromZip('/nonexistent/update.zip'), undefined)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rev-'))
    try {
      const notZip = path.join(dir, 'update.zip')
      fs.writeFileSync(notZip, 'definitely not a zip')
      assert.equal(readBundledRevisionFromZip(notZip), undefined)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads runtime-revision.json out of an app zip', (t) => {
    const zip = spawnSync('zip', ['--version'], { stdio: 'ignore' })
    if (zip.status !== 0) {
      t.skip('zip binary unavailable')
      return
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rev-'))
    try {
      const entry = path.join(dir, 'Oh My DSH.app', 'Contents', 'Resources')
      fs.mkdirSync(entry, { recursive: true })
      const revision = { sha: 'abc123', runtimeTarball: 'def456' }
      fs.writeFileSync(path.join(entry, 'runtime-revision.json'), JSON.stringify(revision))
      const zipPath = path.join(dir, 'update.zip')
      const packed = spawnSync('zip', ['-q', '-r', zipPath, 'Oh My DSH.app'], { cwd: dir, stdio: 'ignore' })
      assert.equal(packed.status, 0)
      assert.deepEqual(readBundledRevisionFromZip(zipPath), revision)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('curlDownloadArgs', () => {
  it('resumes into .part and passes -x when a proxy is set', () => {
    assert.deepEqual(
      curlDownloadArgs('https://example.com/a.tar.gz', '/tmp/a.tar.gz.part', 'http://127.0.0.1:7890'),
      ['-fL', '--retry', '5', '--retry-all-errors', '--connect-timeout', '30', '-C', '-', '-o', '/tmp/a.tar.gz.part', '-x', 'http://127.0.0.1:7890', 'https://example.com/a.tar.gz'],
    )
  })

  it('omits -x when no proxy', () => {
    const args = curlDownloadArgs('https://example.com/a.tar.gz', '/tmp/a.part')
    assert.equal(args.includes('-x'), false)
    assert.ok(args.includes('-C'))
  })
})
