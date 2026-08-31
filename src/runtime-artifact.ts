import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { UPDATER_GITHUB_OWNER, UPDATER_GITHUB_REPO } from './constants.ts'
import { parseScutilProxy, resolveDownloadProxy, readUpdateMirror, withMirrorFallback } from './update-mirror.ts'

export const SLIM_ZIP_RUNTIME_FILES = ['runtime.tar.gz', 'runtime.tar.gz.sha'] as const

export type RuntimeSource = 'ok-cache' | 'bundled-tar' | 'download'

export function runtimeShaDirReady(root: string, marker = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'): boolean {
  return fs.existsSync(path.join(root, marker))
}

export function decideRuntimeSource(input: {
  okMatches: boolean
  shaDirReady?: boolean
  bundledTarExists: boolean
}): RuntimeSource {
  if (input.okMatches || input.shaDirReady) return 'ok-cache'
  if (input.bundledTarExists) return 'bundled-tar'
  return 'download'
}

export function runtimePlatformTriple(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`
}

export function runtimeArtifactName(sha: string, platform: string = process.platform, arch: string = process.arch): string {
  return `runtime-${sha}-${runtimePlatformTriple(platform, arch)}.tar.gz`
}

export function runtimeDownloadUrls(input: {
  sha: string
  version: string
  owner?: string
  repo?: string
  platform?: string
  arch?: string
}): string[] {
  const owner = input.owner ?? UPDATER_GITHUB_OWNER
  const repo = input.repo ?? UPDATER_GITHUB_REPO
  const name = runtimeArtifactName(input.sha, input.platform, input.arch)
  const version = input.version.replace(/^v/, '')
  return [
    `https://github.com/${owner}/${repo}/releases/download/v${version}/${name}`,
    `https://github.com/${owner}/${repo}/releases/latest/download/${name}`,
  ]
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function stripRuntimeResources(resourcesDir: string): string[] {
  const removed: string[] = []
  for (const name of SLIM_ZIP_RUNTIME_FILES) {
    const target = path.join(resourcesDir, name)
    if (!fs.existsSync(target)) continue
    fs.rmSync(target)
    removed.push(name)
  }
  return removed
}

export function patchUpdaterYml(yml: string, sha512: string, size: number): string {
  return yml
    .replace(/^(\s*sha512:\s*)\S+ *$/gm, `$1${sha512}`)
    .replace(/^(\s*size:\s*)\d+ *$/gm, `$1${String(size)}`)
}

export function latestMacYml(input: {
  version: string
  file: string
  sha512: string
  size: number
  releaseDate: string
  releaseNotes?: string
}): string {
  const lines = [
    `version: ${input.version}`,
    'files:',
    `  - url: ${input.file}`,
    `    sha512: ${input.sha512}`,
    `    size: ${input.size}`,
    `path: ${input.file}`,
    `sha512: ${input.sha512}`,
    `releaseDate: '${input.releaseDate}'`,
  ]
  const notes = input.releaseNotes?.replace(/\r\n/g, '\n').trim()
  if (notes) {
    lines.push('releaseNotes: |')
    for (const line of notes.split('\n')) lines.push(`  ${line}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function probeDarwinSystemProxy(): string | undefined {
  if (process.platform !== 'darwin') return undefined
  const result = spawnSync('scutil', ['--proxy'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || typeof result.stdout !== 'string') return undefined
  return parseScutilProxy(result.stdout)
}

export function curlDownloadArgs(url: string, tmp: string, proxy?: string): string[] {
  const args = ['-fL', '--retry', '5', '--retry-all-errors', '--connect-timeout', '30', '-C', '-', '-o', tmp]
  if (proxy !== undefined && proxy !== '') args.push('-x', proxy)
  args.push(url)
  return args
}

function downloadProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return resolveDownloadProxy(env, readProxyUrlFromProbe(env))
}

function readProxyUrlFromProbe(env: NodeJS.ProcessEnv): string | undefined {
  if (env !== process.env) return undefined
  return probeDarwinSystemProxy()
}

export function downloadUrlToFile(url: string, dest: string, env: NodeJS.ProcessEnv = process.env): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const proxy = downloadProxy(env)
  const result = spawnSync('curl', curlDownloadArgs(url, tmp, proxy), {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`download failed (${String(result.status)}): ${url}`)
  }
  fs.renameSync(tmp, dest)
}

export function downloadRuntimeTarball(input: {
  sha: string
  expectedSha256: string
  version: string
  dest: string
  env?: NodeJS.ProcessEnv
}): string {
  if (fs.existsSync(input.dest) && sha256File(input.dest) === input.expectedSha256) return input.dest
  const mirror = readUpdateMirror(input.env)
  const urls = runtimeDownloadUrls({ sha: input.sha, version: input.version }).flatMap((url) => withMirrorFallback(url, mirror))
  const seen = new Set<string>()
  const errors: string[] = []
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    try {
      console.log(`dsh-desktop: downloading runtime ${input.sha.slice(0, 12)} from ${url}`)
      downloadUrlToFile(url, input.dest, input.env)
      const got = sha256File(input.dest)
      if (got !== input.expectedSha256) {
        fs.rmSync(input.dest, { force: true })
        throw new Error(`sha256 mismatch: got ${got}, expected ${input.expectedSha256}`)
      }
      return input.dest
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${url}: ${message}`)
    }
  }
  throw new Error(`could not download runtime ${input.sha}: ${errors.join('; ')}`)
}

/**
 * Read the new bundle's runtime-revision.json out of a downloaded update zip
 * (one small entry, so a synchronous unzip is fine). Slim zips carry no
 * runtime.tar.gz but always carry this manifest.
 */
export function readBundledRevisionFromZip(zipPath: string): { sha?: string; runtimeTarball?: string } | undefined {
  const result = spawnSync('unzip', ['-p', zipPath, '*/Contents/Resources/runtime-revision.json'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.trim() === '') return undefined
  try {
    return JSON.parse(result.stdout) as { sha?: string; runtimeTarball?: string }
  } catch {
    return undefined
  }
}

/**
 * Async variant of downloadUrlToFile for the windowed pre-stage phase: the
 * sync spawnSync would freeze the whole app while a 371MB runtime downloads.
 * `onBytes` reports the growing .part size; `signal` kills the child (cancel).
 */
export function downloadUrlToFileAsync(
  url: string,
  dest: string,
  onBytes?: (bytes: number) => void,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const proxy = downloadProxy(env)
  return new Promise((resolve, reject) => {
    const child = spawn('curl', curlDownloadArgs(url, tmp, proxy), {
      stdio: 'ignore',
      windowsHide: true,
    })
    const reporter = onBytes === undefined
      ? undefined
      : setInterval(() => {
          try {
            onBytes(fs.statSync(tmp).size)
          } catch {
            // tmp is not created until curl opens it
          }
        }, 200)
    const onAbort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (error?: Error): void => {
      if (reporter !== undefined) clearInterval(reporter)
      signal?.removeEventListener('abort', onAbort)
      if (error !== undefined) {
        reject(error)
        return
      }
      try {
        fs.renameSync(tmp, dest)
        resolve()
      } catch (renameError) {
        reject(renameError instanceof Error ? renameError : new Error(String(renameError)))
      }
    }
    child.on('error', (error) => { finish(error) })
    child.on('close', (code, killSignal) => {
      if (code === 0) {
        finish()
        return
      }
      const reason = killSignal !== null ? `killed by ${killSignal}` : `exit ${String(code)}`
      finish(new Error(`download failed (${reason}): ${url}`))
    })
  })
}

/** Async sibling of downloadRuntimeTarball; same candidates, cache, and verification. */
export async function downloadRuntimeTarballAsync(input: {
  sha: string
  expectedSha256: string
  version: string
  dest: string
  env?: NodeJS.ProcessEnv
  onBytes?: (bytes: number) => void
  signal?: AbortSignal
}): Promise<string> {
  if (fs.existsSync(input.dest) && sha256File(input.dest) === input.expectedSha256) return input.dest
  const mirror = readUpdateMirror(input.env)
  const urls = runtimeDownloadUrls({ sha: input.sha, version: input.version }).flatMap((url) => withMirrorFallback(url, mirror))
  const seen = new Set<string>()
  const errors: string[] = []
  // Read through a function: abort flips between the loop check and the catch.
  const isAborted = (): boolean => input.signal?.aborted === true
  for (const url of urls) {
    if (seen.has(url)) continue
    seen.add(url)
    if (isAborted()) throw new Error('runtime pre-stage cancelled')
    try {
      console.log(`dsh-desktop: pre-staging runtime ${input.sha.slice(0, 12)} from ${url}`)
      await downloadUrlToFileAsync(url, input.dest, input.onBytes, input.signal, input.env)
      const got = sha256File(input.dest)
      if (got !== input.expectedSha256) {
        fs.rmSync(input.dest, { force: true })
        throw new Error(`sha256 mismatch: got ${got}, expected ${input.expectedSha256}`)
      }
      return input.dest
    } catch (error) {
      if (isAborted()) throw new Error('runtime pre-stage cancelled')
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${url}: ${message}`)
    }
  }
  throw new Error(`could not download runtime ${input.sha}: ${errors.join('; ')}`)
}
