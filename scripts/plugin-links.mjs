#!/usr/bin/env node
/**
 * Plugin dependency-link guard.
 *
 * `pnpm desktop:dev` relinks every shipped plugin's `@deepseek-ai/*` runtime
 * peers into the dev runtime (`linkPluginRuntimeDeps` in shipped-plugins.mjs)
 * so the sidecar loads ONE module instance per package. The links outlive the
 * app, and only the peers move — transitive registry packages keep their own
 * copies. A plugin test run in that state executes against a split module
 * graph (two cordis instances: symbol-keyed checks such as tool scoping fail),
 * so its results mean nothing in either direction.
 *
 *   --check    list plugins whose node_modules disagree with their manifest
 *              (a non-`link:` `@deepseek-ai/*` entry resolving outside the
 *              package's own node_modules/.pnpm); exit 1 when any does.
 *   --restore  reinstall exactly those plugins from their lockfile, then
 *              re-check.
 *
 * Deliberate source posture (`pnpm run link:source`) declares `link:` in the
 * manifest and is skipped: that is a chosen state, not drift.
 *
 * @module plugin-links
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCOPE = '@deepseek-ai'

/**
 * One plugin's drifted links.
 * @typedef {{ plugin: string, links: { name: string, target: string }[] }} Drift
 */

/**
 * Scan `<root>/plugin/*` for runtime-relinked harness dependencies.
 * @param {string} root - repository root.
 * @returns {Drift[]}
 */
export function scanPluginLinks(root) {
  const pluginRoot = join(root, 'plugin')
  /** @type {Drift[]} */
  const drift = []
  for (const name of readdirSync(pluginRoot).sort()) {
    const dir = join(pluginRoot, name)
    // The harness anchor (plugin/deepseek-harness) is itself a symlink.
    if (lstatSync(dir).isSymbolicLink()) continue
    const scopeDir = join(dir, 'node_modules', SCOPE)
    const manifest = join(dir, 'package.json')
    if (!existsSync(scopeDir) || !existsSync(manifest)) continue
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const declared = { ...pkg.optionalDependencies, ...pkg.devDependencies, ...pkg.dependencies }
    // Compare real paths on both sides (macOS /var is a symlink to /private/var).
    const store = join(realpathSync(dir), 'node_modules', '.pnpm') + sep
    /** @type {Drift['links']} */
    const links = []
    for (const entry of readdirSync(scopeDir).sort()) {
      const link = join(scopeDir, entry)
      if (!lstatSync(link).isSymbolicLink()) continue
      const spec = declared[`${SCOPE}/${entry}`]
      if (typeof spec === 'string' && spec.startsWith('link:')) continue
      let target
      try {
        target = realpathSync(link)
      } catch {
        links.push({ name: `${SCOPE}/${entry}`, target: '(broken link)' })
        continue
      }
      if (!target.startsWith(store)) links.push({ name: `${SCOPE}/${entry}`, target })
    }
    if (links.length > 0) drift.push({ plugin: name, links })
  }
  return drift
}

/**
 * @param {Drift[]} drift
 * @returns {string}
 */
export function describeDrift(drift) {
  const lines = drift.map(({ plugin, links }) =>
    `  plugin/${plugin}: ${String(links.length)} link(s) outside its lockfile, e.g. ${links[0]?.name} -> ${links[0]?.target}`)
  return [
    'plugin-links: these plugins resolve @deepseek-ai/* outside their lockfile (left behind by `pnpm desktop:dev`):',
    ...lines,
    'Tests in this state run against a split module graph and prove nothing.',
    'Restore with: pnpm run plugins:restore-links',
  ].join('\n')
}

/**
 * Reinstall the drifted plugins from their own lockfile.
 * @param {string} root
 * @param {Drift[]} drift
 */
function restore(root, drift) {
  for (const { plugin } of drift) {
    const dir = join(root, 'plugin', plugin)
    console.log(`plugin-links: reinstalling plugin/${plugin} from its lockfile`)
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    const args = existsSync(join(dir, 'pnpm-lock.yaml')) ? ['install', '--frozen-lockfile'] : ['install']
    const result = spawnSync('pnpm', args, { cwd: dir, stdio: 'inherit' })
    if (result.status !== 0) {
      throw new Error(`plugin-links: pnpm ${args.join(' ')} failed in plugin/${plugin}`)
    }
  }
}

const invokedAsCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsCli) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const mode = process.argv[2] ?? '--check'
  const drift = scanPluginLinks(root)
  if (mode === '--restore') {
    if (drift.length === 0) {
      console.log('plugin-links: every plugin already resolves from its lockfile')
    } else {
      restore(root, drift)
      const after = scanPluginLinks(root)
      if (after.length > 0) {
        console.error(describeDrift(after))
        process.exit(1)
      }
      console.log(`plugin-links: restored ${String(drift.length)} plugin(s)`)
    }
  } else if (mode === '--check') {
    if (drift.length > 0) {
      console.error(describeDrift(drift))
      process.exit(1)
    }
  } else {
    console.error(`plugin-links: unknown mode ${mode} (use --check or --restore)`)
    process.exit(2)
  }
}
