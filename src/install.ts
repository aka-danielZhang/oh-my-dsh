import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { PluginRef } from './plugins.ts'
import { mutateProfileExpected, type ProfileExpectation } from './profile-repair.ts'
import { runtimeEnv, type Runtime } from './runtime.ts'

/**
 * Packages the desktop stopped shipping. Deleting the shipped plugin is not
 * enough for an existing installation: the profile still lists the
 * dependency, links its `node_modules` entry, names it in
 * `dsh.profile.bundles`, and keeps the extracted copy under the shell root, so
 * the retired plugin keeps booting next to whatever replaced it.
 *
 * Only the copies the desktop itself installed are swept: a dependency pinned
 * to the shell-root extraction (or to a link that no longer resolves), a link
 * that resolves into it, or a bundle entry that resolves nowhere. A copy a
 * person installed from a registry or from their own directory is left alone,
 * and a release old enough to still ship the plugin may re-add the desktop
 * copy — that copy is plain desktop-owned state, so the next boot sweeps it
 * again. No marker, no race.
 */
export interface RetiredDesktopPackage {
  package: string
  destRel: string
}

export const RETIRED_DESKTOP_PACKAGES: readonly RetiredDesktopPackage[] = [
  // 0.4.0-rc.3: the stock Automation page replaced this plugin (see
  // docs/notes/2026-10-20-remove-scheduled-tasks.md).
  { package: 'dsh-scheduled-tasks', destRel: 'plugins/dsh-scheduled-tasks' },
]

interface ProfileManifest {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  dsh?: { profile?: { bundles?: unknown } }
}

function readProfileManifest(profile: string): ProfileManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8')) as ProfileManifest
  } catch {
    return undefined
  }
}

function declaredSpec(manifest: ProfileManifest | undefined, packageName: string): unknown {
  for (const field of [manifest?.dependencies, manifest?.devDependencies]) {
    if (field !== undefined && Object.hasOwn(field, packageName)) return field[packageName]
  }
  return undefined
}

/** Resolved link target of a profile's `node_modules/<name>`, when it resolves. */
function linkedTarget(profile: string, packageName: string): string | undefined {
  try {
    return fs.realpathSync.native(path.join(profile, 'node_modules', packageName))
  } catch {
    return undefined
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep)
}

/** Absolute path with symlinked ancestors resolved (macOS `/var` -> `/private/var`). */
function canonicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

interface PendingRetirement extends RetiredDesktopPackage {
  /** The profile pins the package to the desktop's own copy (or a link that no longer resolves). */
  desktopOwned: boolean
}

/**
 * Decide whether the named package is the desktop's own, now-retired copy.
 * The profile is the source of truth: the old shell writes `link:` specs into
 * the extraction directory, and this release's sweep only touches those.
 */
function retireCandidate(home: string, root: string, profileName: string, entry: RetiredDesktopPackage): PendingRetirement {
  const profile = path.join(home, 'profiles', profileName)
  const dest = canonicalPath(path.join(root, entry.destRel))
  const manifest = readProfileManifest(profile)
  const spec = declaredSpec(manifest, entry.package)
  const bundles = manifest?.dsh?.profile?.bundles
  const bundled = Array.isArray(bundles) && bundles.includes(entry.package)
  const linked = linkedTarget(profile, entry.package)
  let desktopOwned = false
  if (typeof spec === 'string' && spec.startsWith('link:')) {
    const target = spec.slice('link:'.length)
    // A dangling link is a broken leftover of a deleted copy, never a live user install.
    desktopOwned = canonicalPath(target) === dest || !fs.existsSync(target)
  }
  if (!desktopOwned && linked !== undefined && isInside(linked, dest)) desktopOwned = true
  // A bundle entry that resolves nowhere is a broken leftover, not an install.
  if (!desktopOwned && bundled && spec === undefined && linked === undefined) desktopOwned = true
  return { ...entry, desktopOwned }
}

/** Retired desktop copies this profile still carries. */
function pendingRetirements(home: string, root: string, profileName: string): PendingRetirement[] {
  return RETIRED_DESKTOP_PACKAGES
    .map((entry) => retireCandidate(home, root, profileName, entry))
    .filter((candidate) => candidate.desktopOwned)
}

/**
 * Drop retired names from the profile manifest: the dependency (or dev
 * dependency) and the `dsh.profile.bundles` entry. `dsh plugin remove` is bare
 * pnpm — it edits the dependency and the lockfile but leaves the bundle list,
 * and a listed bundle with no resolvable dependency is skipped at every boot.
 * Editing the manifest and resolving once with the existing install steps keeps
 * the removal in the same validated transaction.
 */
function dropProfileEntries(profile: string, packages: readonly string[]): void {
  const manifestPath = path.join(profile, 'package.json')
  const manifest = readProfileManifest(profile)
  if (manifest === undefined) return
  let changed = false
  for (const field of [manifest.dependencies, manifest.devDependencies]) {
    if (field === undefined) continue
    for (const name of packages) {
      if (!Object.hasOwn(field, name)) continue
      delete field[name]
      changed = true
    }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) {
    const kept = bundles.filter((bundle) => !packages.includes(bundle as string))
    if (kept.length !== bundles.length) {
      manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: kept } }
      changed = true
    }
  }
  if (changed) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function openInstallLog(root: string): number {
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
  return fs.openSync(path.join(root, 'logs/install.log'), 'a')
}

function runCli(runtime: Runtime, args: string[], home: string, root: string): void {
  const log = openInstallLog(root)
  const result = spawnSync(runtime.node, [...runtime.argsPrefix, runtime.cli, ...args], {
    cwd: runtime.cwd,
    env: runtimeEnv(runtime, { DSH_HOME: home, CI: 'true' }),
    stdio: ['ignore', log, log],
    windowsHide: true,
  })
  fs.closeSync(log)
  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} failed with ${String(result.status)}`)
  }
}

function pluginAlreadyInProfile(plugin: string, packageName: string, home: string, profileName: string): boolean {
  const linked = path.join(home, 'profiles', profileName, 'node_modules', packageName)
  try {
    return fs.realpathSync.native(linked) === fs.realpathSync.native(plugin)
  } catch {
    return false
  }
}

function resolvedProfileDependencies(home: string, profileName: string, excluded: string[]): Array<[string, string]> {
  const manifest = path.join(home, 'profiles', profileName, 'package.json')
  if (!fs.existsSync(manifest)) return []
  const value = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> }
  const resolved: Array<[string, string]> = []
  for (const packageName of Object.keys(value.dependencies ?? {})) {
    if (excluded.includes(packageName)) continue
    const linked = path.join(home, 'profiles', profileName, 'node_modules', packageName)
    try {
      resolved.push([packageName, fs.realpathSync.native(linked)])
    } catch {
      // unresolved — skip, the later add/install will fail loud
    }
  }
  return resolved
}

function validatePreservedDependencies(home: string, profileName: string, expected: Array<[string, string]>): void {
  const profile = path.join(home, 'profiles', profileName, 'node_modules')
  for (const [packageName, target] of expected) {
    let actual: string
    try {
      actual = fs.realpathSync.native(path.join(profile, packageName))
    } catch (error) {
      throw new Error(`staged dependency ${packageName} became unresolvable: ${String(error)}`)
    }
    if (actual !== target) {
      throw new Error(`staged dependency ${packageName} changed target from ${target} to ${actual}`)
    }
  }
}

function captureProtectedProfileFiles(profile: string): Array<[string, Buffer]> {
  const names = ['cordis.patch.yml', 'pnpm-workspace.yaml']
  const captured: Array<[string, Buffer]> = []
  for (const name of names) {
    const file = path.join(profile, name)
    if (fs.existsSync(file)) captured.push([name, fs.readFileSync(file)])
  }
  return captured
}

function validateProtectedProfileFiles(profile: string, expected: Array<[string, Buffer]>): void {
  for (const [name, bytes] of expected) {
    const actual = fs.readFileSync(path.join(profile, name))
    if (!actual.equals(bytes)) {
      throw new Error(`staged profile unexpectedly changed ${name}`)
    }
  }
}

/**
 * Templates mirrored from the harness `initProfile`. A hand-made profile
 * (manifest only) never triggers the CLI's init-on-first-use, which keys on
 * a MISSING package.json — without these two files the staged install gets
 * pnpm's default isolated linker instead of the hoisted layout the module
 * fallback expects. Healing happens inside the shadow, so the real profile
 * only ever gains them as part of a committed transaction.
 */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

function ensureProfileScaffold(profile: string): void {
  fs.mkdirSync(profile, { recursive: true })
  const patch = path.join(profile, 'cordis.patch.yml')
  if (!fs.existsSync(patch)) fs.writeFileSync(patch, PROFILE_PATCH_TEMPLATE)
  const workspace = path.join(profile, 'pnpm-workspace.yaml')
  if (!fs.existsSync(workspace)) fs.writeFileSync(workspace, PROFILE_PNPM_WORKSPACE)
}

/**
 * True when every desktop-owned package already resolves to this release in
 * the named profile — the skip condition for both boot and surface prepare.
 */
export function desktopPackagesInstalled(
  plugins: PluginRef[],
  home: string,
  profileName: string,
): boolean {
  return plugins.every((plugin) => pluginAlreadyInProfile(plugin.dir, plugin.package, home, profileName))
}

export function runDesktopPluginInstall(
  runtime: Runtime,
  plugins: PluginRef[],
  home: string,
  root: string,
  profileName: string,
  expectation: ProfileExpectation,
): void {
  const missing = plugins
    .filter((plugin) => !pluginAlreadyInProfile(plugin.dir, plugin.package, home, profileName))
    .map((plugin) => plugin.package)
  const retired = pendingRetirements(home, root, profileName)
  if (missing.length === 0 && retired.length === 0) {
    console.log(`dsh-desktop: desktop-owned packages already target this release in ${profileName}, skip plugin add`)
    return
  }
  if (retired.length > 0) {
    console.log(`dsh-desktop: retire ${retired.map((entry) => entry.package).join(', ')} from ${profileName}`)
  }
  if (missing.length > 0) {
    console.log(`dsh-desktop: stage ${profileName} profile update for ${missing.join(', ')}`)
  }
  const retiredNames = retired.map((entry) => entry.package)
  const targets = plugins.map((plugin) => [plugin.package, plugin.dir] as const)
  const managed = [...plugins.map((plugin) => plugin.package), ...retiredNames]
  const preserved = resolvedProfileDependencies(home, profileName, managed)
  mutateProfileExpected(home, profileName, targets, expectation, (shadowHome, hadOriginal) => {
    const shadowProfile = path.join(shadowHome, 'profiles', profileName)
    const protectedFiles = hadOriginal ? captureProtectedProfileFiles(shadowProfile) : []
    ensureProfileScaffold(shadowProfile)
    if (hadOriginal && fs.existsSync(path.join(shadowProfile, 'pnpm-lock.yaml'))) {
      runCli(runtime, ['plugin', '--profile', profileName, 'install'], shadowHome, root)
    }
    if (retiredNames.length > 0) {
      dropProfileEntries(shadowProfile, retiredNames)
      for (const name of retiredNames) {
        fs.rmSync(path.join(shadowProfile, 'node_modules', name), { recursive: true, force: true })
      }
    }
    for (const plugin of plugins) {
      if (!pluginAlreadyInProfile(plugin.dir, plugin.package, shadowHome, profileName)) {
        runCli(runtime, ['plugin', '--profile', profileName, 'add', plugin.dir], shadowHome, root)
      }
    }
    // pnpm's Windows directory-add path can leave new link specs out of the
    // lockfile. Resolve the deliberate mutation before validating it frozen.
    runCli(runtime, ['plugin', '--profile', profileName, 'install', '--no-frozen-lockfile'], shadowHome, root)
    runCli(runtime, ['plugin', '--profile', profileName, 'install', '--frozen-lockfile'], shadowHome, root)
    for (const plugin of plugins) {
      if (!pluginAlreadyInProfile(plugin.dir, plugin.package, shadowHome, profileName)) {
        throw new Error(`staged ${plugin.package} does not resolve to ${plugin.dir}`)
      }
    }
    validatePreservedDependencies(shadowHome, profileName, preserved)
    validateProtectedProfileFiles(shadowProfile, protectedFiles)
    runCli(runtime, ['--profile', profileName, '--dump-config'], shadowHome, root)
  })
  // The profile no longer references these copies; drop them so nobody reads
  // a retired plugin's files as if the desktop still owned them. Best effort:
  // a locked file must not block a startup that already committed.
  for (const entry of retired) {
    try {
      fs.rmSync(path.join(root, entry.destRel), { recursive: true, force: true })
    } catch (error) {
      console.error(`dsh-desktop: remove retired ${entry.package} copy failed: ${String(error)}`)
    }
  }
}

export function frozenProfileInstallOnce(runtime: Runtime, home: string, root: string, profileName: string): void {
  runCli(runtime, ['plugin', '--profile', profileName, 'install'], home, root)
}

export function validateProfileConfig(runtime: Runtime, home: string, root: string, profileName: string): void {
  runCli(runtime, ['--profile', profileName, '--dump-config'], home, root)
}
