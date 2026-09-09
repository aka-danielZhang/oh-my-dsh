/**
 * Split src/resources/runtime.tar.gz into <100MB npm packages so the
 * packaged app can fetch via the npm/pnpm registry (npmmirror first)
 * instead of GitHub Releases. Same bytes, same sha256 as the GitHub asset.
 *
 * Packages: @crazx/dsh-desktop-runtime-<platform>-<arch>-<index>@<desktop version>
 * Idempotent: a version already on the registry is skipped.
 *
 * Not an installable library — payload.bin only. Clients concat + verify.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execNpm } from './cli-bins.mjs'

const CHUNK_BYTES = 80 * 1024 * 1024
const SCOPE = '@crazx'
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function runtimeNpmChunkName(triple, index, scope = SCOPE) {
  return `${scope}/dsh-desktop-runtime-${triple}-${index}`
}

export function splitFileIntoChunks(file, destDir, chunkBytes = CHUNK_BYTES) {
  mkdirSync(destDir, { recursive: true })
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(chunkBytes)
  const out = []
  try {
    let index = 0
    while (true) {
      const n = readSync(fd, buf, 0, chunkBytes, null)
      if (n === 0) break
      const dest = join(destDir, `chunk-${String(index)}`)
      writeFileSync(dest, buf.subarray(0, n))
      out.push(dest)
      index += 1
    }
  } finally {
    closeSync(fd)
  }
  return out
}

function npmViewExists(name, version) {
  try {
    execNpm(['view', `${name}@${version}`, 'version'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function publishChunk(chunkPath, name, version, meta) {
  if (npmViewExists(name, version)) {
    console.log(`publish-runtime-npm: ${name}@${version} already on the registry, skipping`)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-npm-rt-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version,
      description: 'Oh My DSH assembled runtime tarball chunk (download artifact, not a library)',
      license: 'MIT',
      publishConfig: { access: 'public' },
      files: ['payload.bin'],
      dshDesktopRuntime: meta,
    }, null, 2) + '\n')
    copyFileSync(chunkPath, join(dir, 'payload.bin'))
    execNpm(['publish', '--access', 'public'], { cwd: dir, stdio: 'inherit' })
    console.log(`publish-runtime-npm: published ${name}@${version}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function publishRuntimeNpm(options = {}) {
  const resources = join(repoRoot, 'src/resources')
  const tar = options.tar ?? join(resources, 'runtime.tar.gz')
  const revisionPath = options.revision ?? join(resources, 'runtime-revision.json')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const version = typeof pkg.version === 'string' ? pkg.version : ''
  if (!version) throw new Error('publish-runtime-npm: root package.json has no version')
  if (!existsSync(tar) || !existsSync(revisionPath)) {
    console.log('publish-runtime-npm: skip (runtime.tar.gz not packed)')
    return { published: 0, skipped: true }
  }
  const revision = JSON.parse(readFileSync(revisionPath, 'utf8'))
  const sha = typeof revision.sha === 'string' ? revision.sha : ''
  const runtimeTarball = typeof revision.runtimeTarball === 'string' ? revision.runtimeTarball : ''
  if (!sha || !runtimeTarball) {
    throw new Error('publish-runtime-npm: runtime-revision.json missing sha or runtimeTarball')
  }
  const triple = options.triple ?? `${process.platform}-${process.arch}`
  const chunkDir = mkdtempSync(join(tmpdir(), 'dsh-npm-chunks-'))
  try {
    const chunks = splitFileIntoChunks(tar, chunkDir)
    if (chunks.length === 0) throw new Error('publish-runtime-npm: runtime.tar.gz is empty')
    let published = 0
    for (const [index, chunkPath] of chunks.entries()) {
      const name = runtimeNpmChunkName(triple, index)
      publishChunk(chunkPath, name, version, {
        kind: 'chunk',
        index,
        triple,
        sha,
        runtimeTarball,
        chunks: chunks.length,
      })
      published += 1
    }
    console.log(`publish-runtime-npm: ${String(published)} chunk(s) for ${triple} @ ${version}`)
    return { published, skipped: false, triple, version }
  } finally {
    rmSync(chunkDir, { recursive: true, force: true })
  }
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
  const token = process.env.NODE_AUTH_TOKEN ?? process.env.NPM_TOKEN
  if (!token) {
    if (process.env.DSH_PUBLISH_RUNTIME_NPM === '1') {
      throw new Error('publish-runtime-npm: DSH_PUBLISH_RUNTIME_NPM=1 but NPM_TOKEN / NODE_AUTH_TOKEN is missing')
    }
    console.log('publish-runtime-npm: skip (no npm token; set DSH_PUBLISH_RUNTIME_NPM=1 to require one)')
    process.exit(0)
  }
  publishRuntimeNpm()
}
