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

/**
 * Profile-keyed record of completed retirements. It keeps the sweep one-time:
 * a person who installs the package by hand afterwards keeps it running.
 */
const RETIRED_MARKER = 'retired-plugins.json'

function readRetiredMarker(root: string): Record<string, string[]> {
  const record: Record<string, string[]> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(root, RETIRED_MARKER), 'utf8'))
  } catch {
    return record
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return record
  for (const [profile, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) record[profile] = value.filter((entry): entry is string => typeof entry === 'string')
  }
  return record
}

function writeRetiredMarker(root: string, profileName: string, packages: readonly string[]): void {
  const record = readRetiredMarker(root)
  record[profileName] = [...new Set([...(record[profileName] ?? []), ...packages])]
  fs.writeFileSync(path.join(root, RETIRED_MARKER), `${JSON.stringify(record, undefined, 2)}\n`)
}

/** The three places the loader can keep a package alive. */
interface PackagePresence {
  declared: boolean
  linked: boolean
  bundled: boolean
}

function packagePresence(home: string, profileName: string, packageName: string): PackagePresence {
  const profile = path.join(home, 'profiles', profileName)
  const presence: PackagePresence = { declared: false, linked: false, bundled: false }
  const manifestPath = path.join(profile, 'package.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, unknown>
        devDependencies?: Record<string, unknown>
        dsh?: { profile?: { bundles?: unknown } }
      }
      for (const field of [manifest.dependencies, manifest.devDependencies]) {
        if (field !== undefined && Object.hasOwn(field, packageName)) presence.declared = true
      }
      const bundles = manifest.dsh?.profile?.bundles
      if (Array.isArray(bundles) && bundles.includes(packageName)) presence.bundled = true
    } catch {
      // Unreadable manifest: the node_modules probe below still answers.
    }
  }
  presence.linked = fs.existsSync(path.join(profile, 'node_modules', packageName))
  return presence
}

/**
 * Drop retired names from `dsh.profile.bundles`. `dsh plugin remove` is pnpm:
 * it drops the dependency and the node_modules link but leaves the bundle
 * list, and a listed bundle with no resolvable dependency is skipped — and
 * reported — at every boot.
 */
function dropProfileBundles(profile: string, packages: readonly string[]): void {
  const manifestPath = path.join(profile, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return
  const kept = bundles.filter((bundle) => !packages.includes(bundle as string))
  if (kept.length === bundles.length) return
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: kept } }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

type PendingRetirement = RetiredDesktopPackage & PackagePresence

/** Retired packages this profile still carries and has not retired yet. */
function pendingRetirements(home: string, root: string, profileName: string): PendingRetirement[] {
  const done = readRetiredMarker(root)[profileName] ?? []
  const pending: PendingRetirement[] = []
  for (const entry of RETIRED_DESKTOP_PACKAGES) {
    if (done.includes(entry.package)) continue
    const presence = packagePresence(home, profileName, entry.package)
    if (!presence.declared && !presence.linked && !presence.bundled) continue
    pending.push({ ...entry, ...presence })
  }
  return pending
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
    for (const entry of retired) {
      // pnpm remove only when the manifest declares it; a stale link or bundle
      // entry is dropped below without invoking pnpm over an unknown package.
      if (entry.declared) {
        runCli(runtime, ['plugin', '--profile', profileName, 'remove', entry.package], shadowHome, root)
      }
      fs.rmSync(path.join(shadowProfile, 'node_modules', entry.package), { recursive: true, force: true })
    }
    if (retiredNames.length > 0) dropProfileBundles(shadowProfile, retiredNames)
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
  if (retired.length > 0) writeRetiredMarker(root, profileName, retiredNames)
}

export function frozenProfileInstallOnce(runtime: Runtime, home: string, root: string, profileName: string): void {
  runCli(runtime, ['plugin', '--profile', profileName, 'install'], home, root)
}

export function validateProfileConfig(runtime: Runtime, home: string, root: string, profileName: string): void {
  runCli(runtime, ['--profile', profileName, '--dump-config'], home, root)
}
