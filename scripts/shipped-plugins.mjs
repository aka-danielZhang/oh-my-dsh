/**
 * Desktop-owned plugin roster: every package that the .app extracts and
 * `plugin add`s into the active profile.
 *
 * A plugin ships when its package.json has `dsh.desktop.ship: true`.
 * prepare, the shell's findDesktopPlugins, CI checks, and the packaged
 * dump-config smoke all read this module — adding a plugin to the .app is
 * that one field (plus optional tarball/dest/env/pin overrides).
 *
 * @module shipped-plugins
 */
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @typedef {{
 *   package: string
 *   dir: string
 *   tarball: string
 *   destRel: string
 *   env: string
 *   hashKey: string
 *   versionKey: string
 *   version: string
 *   pin: string | undefined
 *   packEntries: string[]
 * }} ShippedPluginSpec */
/**
 * `dsh.desktop.pack` overrides `packEntriesFor` for plugins whose shipped
 * layout is not `package.json + lib/` — e.g. the npm bare-source convention
 * (`main: ./src/index.ts`, runtime tsx loads TS directly), where a forced
 * `lib` entry would either ship a stale tree or fail the tar outright.
 */

/**
 * @param {string} stem
 * @returns {string}
 */
export function camelCaseStem(stem) {
  return stem.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * @param {string} name
 * @returns {string}
 */
export function defaultTarballName(name) {
  return name === 'dsh-desktop-bridge' ? 'bridge.tar.gz' : `${name.slice('dsh-'.length)}.tar.gz`
}

/**
 * @param {string} name
 * @returns {string}
 */
export function defaultDestRel(name) {
  return name === 'dsh-desktop-bridge' ? 'bridge' : `plugins/${name}`
}

/**
 * @param {string} name
 * @returns {string}
 */
export function defaultEnvName(name) {
  if (name === 'dsh-desktop-bridge') return 'DSH_DESKTOP_BRIDGE'
  return `DSH_DESKTOP_${name.slice('dsh-'.length).replaceAll('-', '_').toUpperCase()}_PLUGIN`
}

/**
 * Files the desktop tarball must carry. Matches the historical prepare
 * include list: manifest + lib + patch + optional README / preset snippet.
 * `lib` is unconditional: specs are listed before builds run (a cold CI
 * checkout has no lib yet — gitignored), and a tar packed without lib is
 * exactly the artifact that cannot boot on the desktop extraction path.
 * @param {string} pluginDir
 * @returns {string[]}
 */
export function packEntriesFor(pluginDir) {
  const entries = ['package.json', 'lib']
  for (const name of ['cordis.patch.yml', 'preset-snippet.yml', 'README.md']) {
    if (existsSync(join(pluginDir, name))) entries.push(name)
  }
  return entries
}

/**
 * @param {string} tarball
 * @returns {string}
 */
export function hashKeyForTarball(tarball) {
  const stem = tarball.replace(/\.tar\.gz$/, '')
  return `${camelCaseStem(stem)}Tarball`
}

/**
 * @param {string} tarball
 * @returns {string}
 */
export function versionKeyForTarball(tarball) {
  const stem = tarball.replace(/\.tar\.gz$/, '')
  return `${camelCaseStem(stem)}Version`
}

/**
 * @param {unknown} value
 * @param {string} where
 * @returns {Record<string, unknown> | undefined}
 */
function desktopDecl(value, where) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where}: dsh.desktop must be an object`)
  }
  return /** @type {Record<string, unknown>} */ (value)
}

/**
 * @param {string} repoRoot
 * @returns {ShippedPluginSpec[]}
 */
export function listShippedPluginSpecs(repoRoot) {
  const pluginRoot = join(repoRoot, 'plugin')
  if (!existsSync(pluginRoot)) {
    throw new Error(`shipped-plugins: no plugin/ under ${repoRoot}`)
  }
  /** @type {ShippedPluginSpec[]} */
  const specs = []
  for (const name of readdirSync(pluginRoot).sort()) {
    const dir = join(pluginRoot, name)
    // The plugin:setup harness anchor (plugin/deepseek-harness -> checkout)
    // is a symlink whose package name never matches its directory; it is
    // dev tooling, not a plugin package (same skip as plugins:check).
    if (lstatSync(dir).isSymbolicLink()) continue
    const manifest = join(dir, 'package.json')
    if (!existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof pkg.name !== 'string' || pkg.name !== name) {
      throw new Error(`shipped-plugins: ${manifest} name must equal the directory name`)
    }
    const desktop = desktopDecl(pkg.dsh?.desktop, `${name} package.json`)
    if (desktop === undefined || desktop.ship !== true) continue
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
      throw new Error(`shipped-plugins: ${name} is missing package.json version`)
    }
    const tarball = typeof desktop.tarball === 'string' ? desktop.tarball : defaultTarballName(name)
    if (!tarball.endsWith('.tar.gz')) {
      throw new Error(`shipped-plugins: ${name} dsh.desktop.tarball must end in .tar.gz`)
    }
    const destRel = typeof desktop.dest === 'string' ? desktop.dest : defaultDestRel(name)
    const env = typeof desktop.env === 'string' ? desktop.env : defaultEnvName(name)
    const pin = typeof desktop.pin === 'string' ? desktop.pin : undefined
    if (pin !== undefined && pin !== pkg.version) {
      throw new Error(`shipped-plugins: ${name} dsh.desktop.pin ${pin} != package.json version ${pkg.version}`)
    }
    let pack
    if (desktop.pack !== undefined) {
      if (!Array.isArray(desktop.pack) || desktop.pack.length === 0 || !desktop.pack.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        throw new Error(`shipped-plugins: ${name} dsh.desktop.pack must be a non-empty array of non-empty strings`)
      }
      pack = desktop.pack
    }
    specs.push({
      package: name,
      dir,
      tarball,
      destRel,
      env,
      hashKey: hashKeyForTarball(tarball),
      versionKey: versionKeyForTarball(tarball),
      version: pkg.version,
      pin,
      packEntries: pack ?? packEntriesFor(dir),
    })
  }
  if (specs.length === 0) {
    throw new Error('shipped-plugins: no plugin/*/package.json declared dsh.desktop.ship')
  }
  return specs
}

/**
 * Runtime-facing slice written into runtime-revision.json so a packaged
 * shell can extract without scanning plugin/.
 * @param {ShippedPluginSpec[]} specs
 * @returns {Array<{ package: string, tarball: string, destRel: string, env: string, hashKey: string }>}
 */
export function shippedPluginsManifest(specs) {
  return specs.map((spec) => ({
    package: spec.package,
    tarball: spec.tarball,
    destRel: spec.destRel,
    env: spec.env,
    hashKey: spec.hashKey,
  }))
}

/**
 * Host-load runtime packages: regular dependencies must resolve; peers
 * that the assembled runtime omitted (deleted client-runtime) are skipped.
 * @param {string} pluginDir
 * @returns {{ required: string[], optional: string[] }}
 */
export function runtimeLinkPlan(pluginDir) {
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))
  const required = Object.keys(pkg.dependencies ?? {}).sort()
  const optional = Object.keys(pkg.peerDependencies ?? {})
    .filter((name) => name !== 'react' && name !== 'react-dom')
    .sort()
  return { required, optional }
}

const sourcePackageMaps = new Map()

/** Discover package owners when runtimeCwd is a Harness source checkout. */
function sourcePackageMap(runtimeCwd) {
  const cached = sourcePackageMaps.get(runtimeCwd)
  if (cached !== undefined) return cached

  const packages = new Map()
  const visit = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (entry.name !== 'package.json') continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof manifest.name !== 'string') continue
      const previous = packages.get(manifest.name)
      if (previous !== undefined && previous !== dir) {
        throw new Error(`dsh-desktop: duplicate runtime package ${manifest.name}: ${previous}, ${dir}`)
      }
      packages.set(manifest.name, dir)
    }
  }
  visit(join(runtimeCwd, 'packages'))
  visit(join(runtimeCwd, 'vendor'))
  sourcePackageMaps.set(runtimeCwd, packages)
  return packages
}

/**
 * @param {string} runtimeCwd
 * @param {string} packageName
 * @returns {string | undefined}
 */
export function resolveRuntimePackage(runtimeCwd, packageName) {
  const hoisted = join(runtimeCwd, 'node_modules', packageName)
  if (existsSync(hoisted) && statSync(hoisted).isDirectory()) return hoisted
  const encoded = packageName.replaceAll('/', '+')
  const prefix = `${encoded}@`
  const pnpmDir = join(runtimeCwd, 'node_modules/.pnpm')
  if (existsSync(pnpmDir)) {
    const matches = readdirSync(pnpmDir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(pnpmDir, name, 'node_modules', packageName))
      .filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory())
      .sort()
    if (matches[0] !== undefined) return matches[0]
  }
  return sourcePackageMap(runtimeCwd).get(packageName)
}

/**
 * @param {string} target
 * @param {string} link
 */
function linkDir(target, link) {
  mkdirSync(dirname(link), { recursive: true })
  if (process.platform === 'win32') {
    try {
      symlinkSync(target, link, 'dir')
      return
    } catch {
      const status = spawnSync('cmd', ['/C', 'mklink', '/J', link, target], { windowsHide: true })
      if (status.status !== 0) {
        throw new Error(`mklink /J ${link} -> ${target} exited ${String(status.status)}`)
      }
    }
    return
  }
  symlinkSync(target, link)
}

/**
 * @param {string} link
 */
function removeDirLink(link) {
  try {
    rmSync(link, { force: true })
  } catch {
    rmdirSync(link)
  }
}

/**
 * @param {string} pluginDir
 * @param {string} runtimeCwd
 * @param {string} packageName
 * @param {boolean} required
 */
export function ensureRuntimePackageLink(pluginDir, runtimeCwd, packageName, required) {
  const targetRel = resolveRuntimePackage(runtimeCwd, packageName)
  if (targetRel === undefined) {
    if (required) {
      throw new Error(`dsh-desktop: ${pluginDir} requires ${packageName} in ${runtimeCwd}`)
    }
    console.warn(`dsh-desktop: skip runtime peer ${packageName} (absent from ${runtimeCwd})`)
    return
  }
  const target = realpathSync.native(targetRel)
  const link = join(pluginDir, 'node_modules', packageName)
  try {
    const existing = readlinkSync(link)
    const existingAbs = isAbsolute(existing) ? existing : join(dirname(link), existing)
    try {
      if (realpathSync.native(existingAbs) === target) return
    } catch {
      // replace
    }
    removeDirLink(link)
  } catch {
    if (existsSync(link)) return
  }
  linkDir(target, link)
}

/**
 * @param {string} pluginDir
 * @param {string} runtimeCwd
 */
export function linkPluginRuntimeDeps(pluginDir, runtimeCwd) {
  const plan = runtimeLinkPlan(pluginDir)
  for (const packageName of plan.required) {
    ensureRuntimePackageLink(pluginDir, runtimeCwd, packageName, true)
  }
  for (const packageName of plan.optional) {
    ensureRuntimePackageLink(pluginDir, runtimeCwd, packageName, false)
  }
}

const invokedAsCli = typeof import.meta.url === 'string'
  && import.meta.url.startsWith('file:')
  && process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedAsCli && process.argv[2] === '--print') {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const field = process.argv[3]
  for (const spec of listShippedPluginSpecs(repoRoot)) {
    if (field === undefined) console.log(spec.package)
    else console.log(spec[field] ?? '')
  }
}
