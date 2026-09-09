import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** npm's published-tarball limit is 100MB; leave headroom for the pack wrapper. */
export const RUNTIME_NPM_CHUNK_BYTES = 80 * 1024 * 1024
export const RUNTIME_NPM_MAX_CHUNKS = 16
export const RUNTIME_NPM_SCOPE = '@crazx'
export const NPMJS_REGISTRY = 'https://registry.npmjs.org'
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com'

export function normalizeRegistry(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function runtimeNpmChunkName(
  triple: string,
  index: number,
  scope: string = RUNTIME_NPM_SCOPE,
): string {
  return `${scope}/dsh-desktop-runtime-${triple}-${index}`
}

export function runtimeRevisionAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string {
  return `runtime-revision-${platform}-${arch}.json`
}

/**
 * Registry tarball URL in the same shape `npm pack` / pnpm use.
 * Scoped: `{registry}/@scope/name/-/name-{version}.tgz`
 */
export function npmRegistryTarballUrl(registry: string, name: string, version: string): string {
  const base = normalizeRegistry(registry)
  const versioned = version.replace(/^v/, '')
  const unscoped = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
  return `${base}/${name}/-/${unscoped}-${versioned}.tgz`
}

export function readNpmrcRegistry(npmrc: string): string | undefined {
  for (const line of npmrc.split(/\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const match = /^registry\s*=\s*(.+)$/.exec(trimmed)
    const raw = match?.[1]?.trim().replace(/^['"]|['"]$/g, '')
    if (raw) return normalizeRegistry(raw)
  }
  return undefined
}

/**
 * npm/pnpm registries to try before GitHub. User config and npmmirror come
 * first (China / custom mirrors); npmjs is the publish origin; GitHub is
 * the caller's fallback, not listed here.
 */
export function resolveRuntimeRegistries(
  env: NodeJS.ProcessEnv = process.env,
  npmrcText?: string,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (raw: string | undefined): void => {
    if (typeof raw !== 'string') return
    const trimmed = raw.trim()
    if (trimmed === '') return
    const next = normalizeRegistry(trimmed)
    if (seen.has(next)) return
    seen.add(next)
    out.push(next)
  }
  add(env.DSH_RUNTIME_REGISTRY)
  add(env.npm_config_registry)
  add(env.NPM_CONFIG_REGISTRY)
  if (npmrcText !== undefined) add(readNpmrcRegistry(npmrcText))
  // Tests and air-gapped hosts pin one registry; do not leak to public npm.
  if (env.DSH_RUNTIME_REGISTRY_ONLY === '1') return out
  add(NPMMIRROR_REGISTRY)
  add(NPMJS_REGISTRY)
  return out
}

export function parseRuntimeRevision(value: unknown): { sha: string; runtimeTarball: string } | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const rec = value as Record<string, unknown>
  const sha = typeof rec.sha === 'string' ? rec.sha : ''
  const runtimeTarball = typeof rec.runtimeTarball === 'string' ? rec.runtimeTarball : ''
  if (sha === '' || runtimeTarball === '') return undefined
  return { sha, runtimeTarball }
}

export function fetchRuntimeRevisionFromUrls(
  urls: string[],
  read: (url: string) => string,
): { sha: string; runtimeTarball: string } | undefined {
  for (const url of urls) {
    try {
      const parsed = parseRuntimeRevision(JSON.parse(read(url)) as unknown)
      if (parsed !== undefined) return parsed
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

export function splitFileIntoChunks(
  file: string,
  destDir: string,
  chunkBytes: number = RUNTIME_NPM_CHUNK_BYTES,
): string[] {
  if (chunkBytes <= 0) throw new Error(`chunkBytes must be positive, got ${String(chunkBytes)}`)
  fs.mkdirSync(destDir, { recursive: true })
  const fd = fs.openSync(file, 'r')
  const buf = Buffer.alloc(chunkBytes)
  const out: string[] = []
  try {
    let index = 0
    while (true) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null)
      if (n === 0) break
      const dest = path.join(destDir, `chunk-${String(index)}`)
      fs.writeFileSync(dest, buf.subarray(0, n))
      out.push(dest)
      index += 1
    }
  } finally {
    fs.closeSync(fd)
  }
  return out
}

export function concatChunkFiles(parts: string[], dest: string): void {
  if (parts.length === 0) throw new Error('no chunks to concat')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.concat`
  fs.rmSync(tmp, { force: true })
  for (const part of parts) {
    fs.appendFileSync(tmp, fs.readFileSync(part))
  }
  fs.renameSync(tmp, dest)
}

/** `npm pack` always wraps files under `package/`. */
export function extractNpmPayload(tgz: string, dest: string): void {
  const tmp = `${dest}.pkg`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })
  const result = spawnSync('tar', ['-xzf', tgz, '-C', tmp, 'package/payload.bin'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const payload = path.join(tmp, 'package', 'payload.bin')
  if (result.status !== 0 || !fs.existsSync(payload)) {
    fs.rmSync(tmp, { recursive: true, force: true })
    throw new Error(`npm pack ${tgz} has no package/payload.bin`)
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(payload, dest)
  fs.rmSync(tmp, { recursive: true, force: true })
}

/**
 * The matching sha tree is extracted and launchable. A cached tarball is
 * not enough: ready/install must not restart onto a new shell that still
 * has to unpack, or that would fall back to an older sha.
 */
export function isRuntimePayloadReady(input: {
  okMatches: boolean
  shaDirReady: boolean
}): boolean {
  return input.okMatches || input.shaDirReady
}

/**
 * Atomic cutover: both the shell zip and the matching runtime must be local
 * before `ready` / install. An older extracted tree is not a substitute.
 */
export function planAtomicUpdateReady(input: {
  zipReady: boolean
  runtimeReady: boolean
}): 'ready' | 'wait-zip' | 'wait-runtime' {
  if (!input.zipReady) return 'wait-zip'
  if (!input.runtimeReady) return 'wait-runtime'
  return 'ready'
}

/** Slim-zip platforms must have both payloads; NSIS already bundles the tar. */
export function planDownloadUpdateReady(input: {
  platform: string
  zipPath: string | undefined
  runtimeReady: boolean
}): 'ready' | 'wait-zip' | 'wait-runtime' {
  return planAtomicUpdateReady({
    zipReady: input.platform !== 'darwin' || Boolean(input.zipPath),
    runtimeReady: input.platform !== 'darwin' || input.runtimeReady,
  })
}

export function planInstallUpdate(input: {
  platform: string
  runtimeReady: boolean
}): 'install' | 'refuse-runtime' {
  if (input.platform === 'darwin' && !input.runtimeReady) return 'refuse-runtime'
  return 'install'
}
