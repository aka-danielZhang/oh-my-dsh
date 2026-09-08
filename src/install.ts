import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { PluginRef } from './plugins.ts'
import { mutateProfileExpected, type ProfileExpectation } from './profile-repair.ts'
import { runtimeEnv, type Runtime } from './runtime.ts'

function openInstallLog(logs: string): number {
  fs.mkdirSync(path.join(logs, 'logs'), { recursive: true })
  return fs.openSync(path.join(logs, 'logs/install.log'), 'a')
}

function runCli(runtime: Runtime, args: string[], home: string, logs: string): void {
  const log = openInstallLog(logs)
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
  logs: string,
  profileName: string,
  expectation: ProfileExpectation,
): void {
  const missing = plugins
    .filter((plugin) => !pluginAlreadyInProfile(plugin.dir, plugin.package, home, profileName))
    .map((plugin) => plugin.package)
  if (missing.length === 0) {
    console.log(`dsh-desktop: desktop-owned packages already target this release in ${profileName}, skip plugin add`)
    return
  }
  console.log(`dsh-desktop: stage ${profileName} profile update for ${missing.join(', ')}`)
  const targets = plugins.map((plugin) => [plugin.package, plugin.dir] as const)
  const managed = plugins.map((plugin) => plugin.package)
  const preserved = resolvedProfileDependencies(home, profileName, managed)
  mutateProfileExpected(home, profileName, targets, expectation, (shadowHome, hadOriginal) => {
    const shadowProfile = path.join(shadowHome, 'profiles', profileName)
    const protectedFiles = hadOriginal ? captureProtectedProfileFiles(shadowProfile) : []
    ensureProfileScaffold(shadowProfile)
    if (hadOriginal && fs.existsSync(path.join(shadowProfile, 'pnpm-lock.yaml'))) {
      runCli(runtime, ['plugin', '--profile', profileName, 'install'], shadowHome, logs)
    }
    for (const plugin of plugins) {
      if (!pluginAlreadyInProfile(plugin.dir, plugin.package, shadowHome, profileName)) {
        runCli(runtime, ['plugin', '--profile', profileName, 'add', plugin.dir], shadowHome, logs)
      }
    }
    // pnpm's Windows directory-add path can leave new link specs out of the
    // lockfile. Resolve the deliberate mutation before validating it frozen.
    runCli(runtime, ['plugin', '--profile', profileName, 'install', '--no-frozen-lockfile'], shadowHome, logs)
    runCli(runtime, ['plugin', '--profile', profileName, 'install', '--frozen-lockfile'], shadowHome, logs)
    for (const plugin of plugins) {
      if (!pluginAlreadyInProfile(plugin.dir, plugin.package, shadowHome, profileName)) {
        throw new Error(`staged ${plugin.package} does not resolve to ${plugin.dir}`)
      }
    }
    validatePreservedDependencies(shadowHome, profileName, preserved)
    validateProtectedProfileFiles(shadowProfile, protectedFiles)
    runCli(runtime, ['--profile', profileName, '--dump-config'], shadowHome, logs)
  })
}

export function frozenProfileInstallOnce(runtime: Runtime, home: string, logs: string, profileName: string): void {
  runCli(runtime, ['plugin', '--profile', profileName, 'install'], home, logs)
}

export function validateProfileConfig(runtime: Runtime, home: string, logs: string, profileName: string): void {
  runCli(runtime, ['--profile', profileName, '--dump-config'], home, logs)
}
