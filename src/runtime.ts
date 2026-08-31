import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  applyDockGuardEnv,
  dockGuardImports,
  ensureDarwinDockGuard,
  type DarwinDockGuard,
} from './darwin-dock-guard.ts'
import { ensureSidecarNodeApp } from './sidecar-node-app.ts'
import { extractBundleTar, readRevisionManifest } from './extract.ts'
import { repoRoot, resourceDir, shellRoot, userHome } from './paths.ts'
import {
  decideRuntimeSource,
  downloadRuntimeTarball,
  downloadRuntimeTarballAsync,
  findUsableRuntimeDir,
  planRuntimeRelease,
  RUNTIME_BIN_MARKER,
  runtimeArtifactName,
  runtimeShaDirReady,
} from './runtime-artifact.ts'

export interface Runtime {
  node: string
  argsPrefix: string[]
  cli: string
  cwd: string
  pathPrepend: string[]
  oneNode: boolean
  dockGuard?: DarwinDockGuard
}

export function composeProcessPath(preferred: string[], inherited: string | undefined): string {
  const parts: string[] = []
  const seen = new Set<string>()
  const incoming = inherited === undefined ? [] : inherited.split(path.delimiter)
  for (const item of [...preferred, ...incoming]) {
    if (!item || seen.has(item)) continue
    seen.add(item)
    parts.push(item)
  }
  return parts.join(path.delimiter)
}

export function hostCliPathDirs(): string[] {
  const candidates: string[] = []
  try {
    const home = userHome()
    candidates.push(path.join(home, '.local/bin'))
    candidates.push(path.join(home, '.bun/bin'))
    candidates.push(path.join(home, '.cargo/bin'))
    if (process.platform === 'darwin') {
      candidates.push(path.join(home, 'Library/pnpm'))
      candidates.push(path.join(home, '.npm-global/bin'))
    } else if (process.platform !== 'win32') {
      candidates.push(path.join(home, '.linuxbrew/bin'))
    } else {
      candidates.push(path.join(home, 'scoop', 'shims'))
    }
  } catch {
    // no home — skip user dirs
  }
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin')
  } else if (process.platform !== 'win32') {
    candidates.push('/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin')
  } else {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm'))
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'pnpm'))
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin'))
    }
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs'))
  }
  return candidates.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

/** Directory name under `node-shim/` so two Electron binaries do not clobber one script. */
export function nodeShimKey(electronPath: string): string {
  return createHash('sha256').update(electronPath).digest('hex').slice(0, 12)
}

/**
 * Write a PATH `node` that execs this process's Electron as Node.
 * The script lives under `root/node-shim/<key>/` so desktop:dev, a packaged
 * app, and tests cannot overwrite each other's target. A missing binary is
 * refused — a previous test used `/Applications/Electron.app` and poisoned
 * the shared shim, so host CLIs (`yzj-cli`) died with ENOENT.
 */
export function ensureNodeShim(electronPath: string, root: string, guard?: DarwinDockGuard): string {
  if (!fs.existsSync(electronPath)) {
    throw new Error(`dsh-desktop: refusing to write node shim for missing binary: ${electronPath}`)
  }
  const dir = path.join(root, 'node-shim', nodeShimKey(electronPath))
  fs.mkdirSync(dir, { recursive: true })
  const legacy = path.join(root, 'node-shim', process.platform === 'win32' ? 'node.cmd' : 'node')
  try {
    if (fs.existsSync(legacy) && fs.statSync(legacy).isFile()) fs.unlinkSync(legacy)
  } catch (error) {
    console.warn(`dsh-desktop: could not remove stale shared node shim ${legacy}: ${String(error)}`)
  }
  const hideImport = guard === undefined ? '' : ` --import ${JSON.stringify(guard.hideDockJs)}`
  if (process.platform === 'win32') {
    const dest = path.join(dir, 'node.cmd')
    fs.writeFileSync(dest, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronPath}"${hideImport} %*\r\n`)
  } else {
    const dest = path.join(dir, 'node')
    const hideEnv = guard === undefined ? '' : `export DSH_DARWIN_HIDE_DOCK=${JSON.stringify(guard.hideDockLib)}\n`
    fs.writeFileSync(
      dest,
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\n${hideEnv}exec ${JSON.stringify(electronPath)}${hideImport} "$@"\n`,
    )
    fs.chmodSync(dest, 0o755)
  }
  return dir
}

/**
 * Runtime tarballs omit `tools/node`, but pnpm's `.bin/pnpm` still prefers a
 * sibling `.bin/node` (relative to the missing binary). Remove those stubs so
 * `exec node` falls through to PATH — where our Electron one-node shim lives.
 */
export function neutralizeToolsNodeShims(runtimeDir: string): void {
  const bin = path.join(runtimeDir, 'tools/node_modules/.bin')
  for (const name of ['node', 'node.cmd', 'node.ps1']) {
    const file = path.join(bin, name)
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (error) {
      console.warn(`dsh-desktop: could not remove stale tools node shim ${file}: ${String(error)}`)
    }
  }
}

export function bundledNode(dir: string): string | undefined {
  const tools = path.join(dir, 'tools/node_modules/node')
  for (const rel of ['bin/node.exe', 'bin/node', 'node.exe']) {
    const candidate = path.join(tools, rel)
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

export function bundledRuntime(
  dir: string,
  oneNode: boolean,
  electronPath: string,
  packaged = false,
  shimRoot = shellRoot(),
): Runtime {
  const cli = path.join(dir, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!fs.existsSync(cli)) {
    throw new Error(`bundled runtime missing CLI entry: ${cli}`)
  }
  const nodeBinary = bundledNode(dir)
  if (oneNode) {
    if (packaged && nodeBinary !== undefined) {
      throw new Error(`sidecar still resolved a second node at ${nodeBinary}`)
    }
    const dockGuard = ensureDarwinDockGuard(shimRoot)
    const node = ensureSidecarNodeApp(electronPath, shimRoot)
    const shim = ensureNodeShim(node, shimRoot, dockGuard)
    neutralizeToolsNodeShims(dir)
    return {
      node,
      argsPrefix: [...dockGuardImports(dockGuard), '--import', 'tsx/esm'],
      cli,
      cwd: path.join(dir, 'dsh'),
      // Shim first on PATH; also delete tools/.bin/node* so pnpm's wrapper
      // does not hard-exec the omitted tools/node binary.
      pathPrepend: [shim, path.join(dir, 'tools/node_modules/.bin')],
      oneNode: true,
      ...(dockGuard === undefined ? {} : { dockGuard }),
    }
  }
  if (nodeBinary === undefined) {
    throw new Error(`bundled runtime missing node binary under ${dir}/tools/node_modules/node`)
  }
  return {
    node: nodeBinary,
    argsPrefix: ['--import', 'tsx/esm'],
    cli,
    cwd: path.join(dir, 'dsh'),
    pathPrepend: [
      path.join(dir, 'tools/node_modules/.bin'),
      path.join(dir, 'tools/node_modules/node/bin'),
    ],
    oneNode: false,
  }
}

function findCheckout(): string {
  const candidates: string[] = []
  if (process.env.DSH_CHECKOUT) candidates.push(process.env.DSH_CHECKOUT)
  candidates.push(path.join(repoRoot(), '../deepseek-harness'))
  try {
    candidates.push(path.join(userHome(), 'workspace/deepseek-harness'))
  } catch {
    // ignore
  }
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, 'docs/architecture.md'))
      && fs.existsSync(path.join(candidate, 'apps/cli/src/bin.ts'))
    ) {
      return candidate
    }
  }
  throw new Error(
    `no DeepSeek Harness checkout found (need docs/architecture.md and apps/cli/src/bin.ts); tried: ${candidates.join(', ')}`,
  )
}

function hasBundledCli(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'))
}

/** Prefer the revision.json SHA; if that tree is missing, use the only assembled runtime. */
export function selectAssembledRuntimeDir(buildRoot: string, pinnedSha: string): string | undefined {
  const pinned = path.join(buildRoot, pinnedSha)
  if (hasBundledCli(pinned)) return pinned
  if (!fs.existsSync(buildRoot)) return undefined
  const found: string[] = []
  for (const name of fs.readdirSync(buildRoot)) {
    const dir = path.join(buildRoot, name)
    try {
      if (!fs.statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (hasBundledCli(dir)) found.push(dir)
  }
  if (found.length === 1) return found[0]
  return undefined
}

function sourceRuntime(electronPath: string): Runtime {
  const checkout = findCheckout()
  const inElectron = typeof process.versions.electron === 'string' && process.versions.electron.length > 0
  if (inElectron) {
    const dockGuard = ensureDarwinDockGuard(shellRoot())
    const node = ensureSidecarNodeApp(electronPath, shellRoot())
    const shim = ensureNodeShim(node, shellRoot(), dockGuard)
    return {
      node,
      argsPrefix: [...dockGuardImports(dockGuard), '--import', 'tsx/esm'],
      cli: path.join(checkout, 'apps/cli/src/bin.ts'),
      cwd: checkout,
      pathPrepend: [shim],
      oneNode: true,
      ...(dockGuard === undefined ? {} : { dockGuard }),
    }
  }
  return {
    node: process.env.DSH_NODE ?? 'node',
    argsPrefix: ['--import', 'tsx/esm'],
    cli: path.join(checkout, 'apps/cli/src/bin.ts'),
    cwd: checkout,
    pathPrepend: [],
    oneNode: false,
  }
}

function appVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { version?: string }
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version
  } catch {
    // packaged builds still have package.json next to the asar via electron
  }
  return process.env.npm_package_version ?? '0.0.0'
}

export interface BackgroundRuntimeFetchJob {
  sha: string
  expectedSha256: string
  version: string
  dest: string
  extractDir: string
}

const backgroundFetchDests = new Set<string>()

function defaultStartBackgroundRuntimeFetch(job: BackgroundRuntimeFetchJob): void {
  if (backgroundFetchDests.has(job.dest)) return
  backgroundFetchDests.add(job.dest)
  void (async () => {
    try {
      const tar = await downloadRuntimeTarballAsync({
        sha: job.sha,
        expectedSha256: job.expectedSha256,
        version: job.version,
        dest: job.dest,
      })
      extractBundleTar(tar, job.extractDir, RUNTIME_BIN_MARKER, job.expectedSha256)
      console.log(
        `dsh-desktop: background runtime ${job.sha.slice(0, 12)} extracted to ${job.extractDir} (applies on next launch)`,
      )
    } catch (error) {
      backgroundFetchDests.delete(job.dest)
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`dsh-desktop: background runtime download failed: ${message}`)
    }
  })()
}

let startBackgroundRuntimeFetch = defaultStartBackgroundRuntimeFetch

/** Test hook: capture the deferred job without curling. */
export function setStartBackgroundRuntimeFetchForTests(
  fn: ((job: BackgroundRuntimeFetchJob) => void) | undefined,
): void {
  startBackgroundRuntimeFetch = fn ?? defaultStartBackgroundRuntimeFetch
}

export function releaseRuntimeDir(packaged: boolean): string | undefined {
  if (!packaged) return undefined
  const resources = resourceDir(true)
  if (resources === undefined) return undefined
  const value = readRevisionManifest(resources)
  if (value === undefined) return undefined
  const sha = typeof value.sha === 'string' ? value.sha : ''
  if (!sha) throw new Error(`bundled runtime-revision.json has no sha: ${path.join(resources, 'runtime-revision.json')}`)
  const tarball = typeof value.runtimeTarball === 'string' ? value.runtimeTarball : ''
  const root = path.join(shellRoot(), 'runtime', sha)
  const bundledTar = path.join(resources, 'runtime.tar.gz')
  const okMatches = Boolean(
    tarball
    && fs.existsSync(path.join(root, '.ok'))
    && fs.readFileSync(path.join(root, '.ok'), 'utf8').trim() === tarball,
  )
  const shaDirReady = runtimeShaDirReady(root)
  const bundledTarExists = fs.existsSync(bundledTar)
  const source = decideRuntimeSource({ okMatches, shaDirReady, bundledTarExists })
  if (source === 'download' && !tarball) {
    throw new Error(`slim app has no bundled runtime.tar.gz and runtime-revision.json has no runtimeTarball hash`)
  }
  const fallbackDir = source === 'download' ? findUsableRuntimeDir(path.join(shellRoot(), 'runtime')) : undefined
  const plan = planRuntimeRelease({ source, ...(fallbackDir === undefined ? {} : { fallbackDir }) })
  if (plan.launch === 'target') return root
  if (plan.fetch === 'defer' && fallbackDir !== undefined) {
    startBackgroundRuntimeFetch({
      sha,
      expectedSha256: tarball,
      version: appVersion(),
      dest: path.join(shellRoot(), 'runtime-tarballs', runtimeArtifactName(sha)),
      extractDir: root,
    })
    console.log(
      `dsh-desktop: launching with existing runtime ${fallbackDir}; fetching ${sha.slice(0, 12)} in background (applies on next launch)`,
    )
    return fallbackDir
  }
  let tar = bundledTar
  if (plan.fetch === 'sync') {
    tar = downloadRuntimeTarball({
      sha,
      expectedSha256: tarball,
      version: appVersion(),
      dest: path.join(shellRoot(), 'runtime-tarballs', runtimeArtifactName(sha)),
    })
  }
  extractBundleTar(tar, root, RUNTIME_BIN_MARKER, tarball)
  console.log(`dsh-desktop: extracted ${source === 'download' ? 'downloaded' : 'bundled'} runtime ${sha} to ${root}`)
  return root
}

export function electronAbiMarker(runtimeDir: string): string {
  return path.join(runtimeDir, '.electron-abi')
}

/** Packaged always shares Electron's Node. Unpackaged needs a rebuild marker on *this* tree. */
export function oneNodeForRuntimeDir(packaged: boolean, runtimeDir: string | undefined): boolean {
  if (process.env.DSH_ELECTRON_ONE_NODE === '1') return true
  if (process.env.DSH_ELECTRON_ONE_NODE === '0') return false
  if (packaged) return true
  if (runtimeDir === undefined) return false
  return fs.existsSync(electronAbiMarker(runtimeDir))
}

export function findRuntime(packaged: boolean, electronPath: string): Runtime {
  if (process.env.DSH_DESKTOP_RUNTIME) {
    const dir = process.env.DSH_DESKTOP_RUNTIME
    return bundledRuntime(dir, oneNodeForRuntimeDir(packaged, dir), electronPath, packaged)
  }
  const revisionPath = path.join(repoRoot(), 'runtime/revision.json')
  if (fs.existsSync(revisionPath) && !packaged) {
    const value = JSON.parse(fs.readFileSync(revisionPath, 'utf8')) as { sha?: string }
    const sha = value.sha ?? ''
    const dir = selectAssembledRuntimeDir(path.join(repoRoot(), 'runtime/build'), sha)
    if (dir !== undefined) {
      if (path.basename(dir) !== sha) {
        console.warn(
          `dsh-desktop: runtime/revision.json sha ${sha.slice(0, 12)} is not assembled; using ${path.basename(dir)}`,
        )
      }
      return bundledRuntime(dir, oneNodeForRuntimeDir(packaged, dir), electronPath, packaged)
    }
  }
  const extracted = releaseRuntimeDir(packaged)
  if (extracted !== undefined) {
    return bundledRuntime(extracted, oneNodeForRuntimeDir(packaged, extracted), electronPath, packaged)
  }
  return sourceRuntime(electronPath)
}

export function applyOneNodeEnv(env: NodeJS.ProcessEnv, oneNode: boolean): NodeJS.ProcessEnv {
  if (oneNode) env.ELECTRON_RUN_AS_NODE = '1'
  else delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function runtimeEnv(runtime: Runtime, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  applyOneNodeEnv(env, runtime.oneNode)
  applyDockGuardEnv(env, runtime.dockGuard)
  env.PATH = composeProcessPath(runtime.pathPrepend, process.env.PATH)
  return env
}

export function sidecarEnv(runtime: Runtime, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const preferred = [...runtime.pathPrepend, ...hostCliPathDirs()]
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  applyOneNodeEnv(env, runtime.oneNode)
  applyDockGuardEnv(env, runtime.dockGuard)
  env.PATH = composeProcessPath(preferred, process.env.PATH)
  return env
}
