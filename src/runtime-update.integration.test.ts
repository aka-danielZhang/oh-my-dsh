import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'

import { extractBundleTar } from './extract.ts'
import {
  RUNTIME_BIN_MARKER,
  downloadRuntimeFromNpm,
  downloadRuntimeTarballAsync,
  readBundledRevisionFromZip,
  runtimeArtifactName,
  sha256File,
} from './runtime-artifact.ts'
import {
  concatChunkFiles,
  extractNpmPayload,
  isRuntimePayloadReady,
  npmRegistryTarballUrl,
  planDownloadUpdateReady,
  planInstallUpdate,
  runtimeNpmChunkName,
  splitFileIntoChunks,
} from './runtime-registry.ts'

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

function hasBin(name: string): boolean {
  return spawnSync(name, ['--version'], { stdio: 'ignore' }).status === 0
}

function writeRuntimeTree(root: string, body: string): void {
  const marker = path.join(root, RUNTIME_BIN_MARKER)
  fs.mkdirSync(path.dirname(marker), { recursive: true })
  fs.writeFileSync(marker, body)
}

function packRuntimeTar(dir: string, dest: string): void {
  const packed = spawnSync('tar', ['-czf', dest, 'dsh'], { cwd: dir, stdio: 'ignore' })
  assert.equal(packed.status, 0, 'failed to pack fake runtime tar')
}

function packNpmChunk(payload: string, destTgz: string): void {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-npm-chunk-'))
  try {
    const pkg = path.join(work, 'package')
    fs.mkdirSync(pkg)
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"chunk"}\n')
    fs.copyFileSync(payload, path.join(pkg, 'payload.bin'))
    const packed = spawnSync('tar', ['-czf', destTgz, 'package'], { cwd: work, stdio: 'ignore' })
    assert.equal(packed.status, 0, 'failed to pack npm chunk tgz')
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Out-of-process registry: downloadUrlToFile uses spawnSync, which freezes
 * this event loop. An in-process http.Server would accept SYN and never reply.
 */
function startRegistry(files: Map<string, string>): Promise<{ url: string; close: () => Promise<void> }> {
  const map = Object.fromEntries(files)
  const script = `
const http = require('node:http');
const fs = require('node:fs');
const files = ${JSON.stringify(map)};
const server = http.createServer((req, res) => {
  const file = files[new URL(req.url || '/', 'http://127.0.0.1').pathname];
  if (!file || !fs.existsSync(file)) { res.statusCode = 404; res.end('missing'); return; }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
});
`
  const child: ChildProcess = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('registry child did not bind'))
    }, 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout?.once('data', (chunk: Buffer) => {
      clearTimeout(timer)
      const port = String(chunk).trim()
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => {
          child.once('exit', () => done())
          if (!child.kill('SIGTERM')) done()
        }),
      })
    })
  })
}

describe('atomic update integration', () => {
  const skip = !hasBin('tar') || !hasBin('curl') || !hasBin('zip')
  let home = ''
  let registry: { url: string; close: () => Promise<void> } | undefined
  let runtimeTar = ''
  let runtimeHash = ''
  const sha = 'cafebabeface0001'
  const version = '0.3.0-rc.41'
  const triple = `${process.platform}-${process.arch}`
  const files = new Map<string, string>()

  before(async () => {
    if (skip) return
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-upd-int-'))
    const tree = path.join(home, 'tree')
    writeRuntimeTree(tree, `runtime-body-${sha}`)
    runtimeTar = path.join(home, 'runtime.tar.gz')
    packRuntimeTar(tree, runtimeTar)
    runtimeHash = sha256File(runtimeTar)
    const parts = splitFileIntoChunks(runtimeTar, path.join(home, 'parts'), 64)
    assert.ok(parts.length >= 2, 'fixture must span multiple npm chunks')
    for (const [index, part] of parts.entries()) {
      const name = runtimeNpmChunkName(triple, index)
      const tgz = path.join(home, `chunk-${String(index)}.tgz`)
      packNpmChunk(part, tgz)
      const url = new URL(npmRegistryTarballUrl('http://registry.test', name, version))
      files.set(url.pathname, tgz)
    }
    registry = await startRegistry(files)
  })

  after(async () => {
    await registry?.close()
    if (home !== '') fs.rmSync(home, { recursive: true, force: true })
  })

  function isolatedEnv(): NodeJS.ProcessEnv {
    return {
      DSH_RUNTIME_REGISTRY: registry?.url ?? '',
      DSH_RUNTIME_REGISTRY_ONLY: '1',
      HOME: path.join(home, 'empty-home'),
      PATH: process.env.PATH ?? '',
      // Dead proxy: loopback downloads must ignore these or curl hangs.
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      all_proxy: 'http://127.0.0.1:9',
    }
  }

  it('downloads npm chunks, concatenates, verifies sha256, then extracts before ready', () => {
    if (skip) return
    const dest = path.join(home, 'cache', runtimeArtifactName(sha))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const got = downloadRuntimeFromNpm({
      expectedSha256: runtimeHash,
      version,
      dest,
      env: isolatedEnv(),
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(got, dest)
    assert.equal(sha256File(dest), runtimeHash)
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(runtimeTar))

    const extractDir = path.join(home, 'runtime', sha)
    assert.equal(
      isRuntimePayloadReady({
        okMatches: false,
        shaDirReady: fs.existsSync(path.join(extractDir, RUNTIME_BIN_MARKER)),
      }),
      false,
      'tarball on disk must not count as ready',
    )
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath: '/tmp/update.zip', runtimeReady: false }),
      'wait-runtime',
    )

    extractBundleTar(dest, extractDir, RUNTIME_BIN_MARKER, runtimeHash)
    const okMatches = fs.readFileSync(path.join(extractDir, '.ok'), 'utf8').trim() === runtimeHash
    const shaDirReady = fs.existsSync(path.join(extractDir, RUNTIME_BIN_MARKER))
    assert.equal(okMatches, true)
    assert.equal(shaDirReady, true)
    assert.equal(isRuntimePayloadReady({ okMatches, shaDirReady }), true)
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath: '/tmp/update.zip', runtimeReady: true }),
      'ready',
    )
    assert.equal(planInstallUpdate({ platform: 'darwin', runtimeReady: true }), 'install')
  })

  it('rejects a hash mismatch and does not leave a dest file', () => {
    if (skip) return
    const dest = path.join(home, 'cache-bad', 'runtime.tar.gz')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const got = downloadRuntimeFromNpm({
      expectedSha256: sha256('not-the-bytes'),
      version,
      dest,
      env: isolatedEnv(),
      platform: process.platform,
      arch: process.arch,
    })
    assert.equal(got, undefined)
    assert.equal(fs.existsSync(dest), false)
  })

  it('incomplete chunk set does not assemble a usable runtime', () => {
    if (skip) return
    const dest = path.join(home, 'cache-partial', 'runtime.tar.gz')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const firstKey = [...files.keys()][0]
    const firstPath = [...files.values()][0]
    assert.ok(firstKey)
    assert.ok(firstPath)
    const one = new Map<string, string>([[firstKey, firstPath]])
    return startRegistry(one).then(async (partial) => {
      try {
        const got = downloadRuntimeFromNpm({
          expectedSha256: runtimeHash,
          version,
          dest,
          env: {
            ...isolatedEnv(),
            DSH_RUNTIME_REGISTRY: partial.url,
          },
          platform: process.platform,
          arch: process.arch,
        })
        assert.equal(got, undefined)
        assert.equal(fs.existsSync(dest), false)
      } finally {
        await partial.close()
      }
    })
  })

  it('async prestage hits the same npm bytes and can be cancelled', async () => {
    if (skip) return
    const dest = path.join(home, 'cache-async', runtimeArtifactName(sha))
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const got = await downloadRuntimeTarballAsync({
      sha,
      expectedSha256: runtimeHash,
      version,
      dest,
      env: isolatedEnv(),
    })
    assert.equal(got, dest)
    assert.equal(sha256File(dest), runtimeHash)

    const cancelled = path.join(home, 'cache-cancel', runtimeArtifactName(sha))
    fs.mkdirSync(path.dirname(cancelled), { recursive: true })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      downloadRuntimeTarballAsync({
        sha,
        expectedSha256: runtimeHash,
        version,
        dest: cancelled,
        env: isolatedEnv(),
        signal: controller.signal,
      }),
      /cancelled/,
    )
  })

  it('zip revision + extracted matching sha is the only mac ready path', (t) => {
    if (skip) {
      t.skip('zip binary unavailable')
      return
    }
    const app = path.join(home, 'Oh My DSH.app', 'Contents', 'Resources')
    fs.mkdirSync(app, { recursive: true })
    const revision = { sha, runtimeTarball: runtimeHash }
    fs.writeFileSync(path.join(app, 'runtime-revision.json'), JSON.stringify(revision))
    const zipPath = path.join(home, 'update.zip')
    const packed = spawnSync('zip', ['-q', '-r', zipPath, 'Oh My DSH.app'], { cwd: home, stdio: 'ignore' })
    assert.equal(packed.status, 0)
    assert.deepEqual(readBundledRevisionFromZip(zipPath), revision)

    const oldDir = path.join(home, 'runtime-old', 'oldsha111111')
    writeRuntimeTree(oldDir, 'old-runtime')
    const newDir = path.join(home, 'runtime-from-zip', sha)
    extractBundleTar(runtimeTar, newDir, RUNTIME_BIN_MARKER, runtimeHash)
    const okMatches = fs.readFileSync(path.join(newDir, '.ok'), 'utf8').trim() === runtimeHash
    const newReady = isRuntimePayloadReady({
      okMatches,
      shaDirReady: fs.existsSync(path.join(newDir, RUNTIME_BIN_MARKER)),
    })
    assert.equal(newReady, true)
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath, runtimeReady: newReady }),
      'ready',
    )
    assert.equal(
      planDownloadUpdateReady({ platform: 'darwin', zipPath, runtimeReady: false }),
      'wait-runtime',
      'an older extracted tree must not substitute for the matching sha',
    )
    assert.equal(fs.existsSync(path.join(oldDir, RUNTIME_BIN_MARKER)), true)
    assert.equal(planInstallUpdate({ platform: 'darwin', runtimeReady: false }), 'refuse-runtime')
    assert.equal(planInstallUpdate({ platform: 'darwin', runtimeReady: newReady }), 'install')
  })

  it('npm pack payload extract still yields the original chunk bytes', () => {
    if (skip) return
    const firstTgz = [...files.values()][0]
    assert.ok(firstTgz)
    const dest = path.join(home, 'payload-roundtrip.bin')
    extractNpmPayload(firstTgz, dest)
    const firstPart = path.join(home, 'parts', 'chunk-0')
    assert.deepEqual(fs.readFileSync(dest), fs.readFileSync(firstPart))
    const assembled = path.join(home, 'rejoined.tar.gz')
    concatChunkFiles(
      fs.readdirSync(path.join(home, 'parts'))
        .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }))
        .map((name) => path.join(home, 'parts', name)),
      assembled,
    )
    assert.deepEqual(fs.readFileSync(assembled), fs.readFileSync(runtimeTar))
  })
})
