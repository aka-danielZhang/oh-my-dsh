/**
 * Source-dependency switcher for debugging against a local harness checkout.
 *
 * Policy (AGENTS.md 「npm 依赖纪律」): every package's dependencies resolve
 * from the npm registry by default. Source dependencies — `link:` entries
 * pointing into the sibling harness checkout — are a DEBUG-ONLY posture,
 * entered and left exclusively through this script, never by hand-editing
 * package.json. The registry posture is the committed state; `link:source`
 * is a local, uncommitted-by-convention detour.
 *
 * Usage:
 *   pnpm run link:source [pkg ...]                # switch (default: every mapped plugin)
 *   pnpm run unlink:source [pkg ...]              # restore and install registry versions
 *   pnpm run unlink:source -- --no-install        # restore manifests before fork publication
 *
 * The link posture rewrites each mapped @deepseek-ai/* devDependency to
 * `link:../deepseek-harness/<subpath>` (the sibling anchor the root
 * plugin:setup creates) and runs pnpm install in each touched package.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = resolve(repoRoot, 'plugin')
const anchor = resolve(pluginRoot, 'deepseek-harness')
const OFFICIAL_VERSION = '0.1.5-alpha.1'
const FORK_VERSION = '0.1.5-alpha.1.zw.1'

/** Compatibility packages whose superclass must stay on the official baseline. */
const OFFICIAL_BASELINE_DEPS = new Map([
  ['dsh-compaction-hierarchical', new Set(['@deepseek-ai/dsh-compaction-basic'])],
])

/** Registry coordinates that do not follow the official DSH release version. */
const REGISTRY_OVERRIDES = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/cordis-plugin-timer': '1.1.4',
  '@deepseek-ai/schemastery': '3.18.2',
  '@deepseek-ai/dsh-agent-default-model': `npm:@crazx/dsh-agent-default-model@${FORK_VERSION}`,
  '@deepseek-ai/dsh-api-session-controller': `npm:@crazx/dsh-api-session-controller@${FORK_VERSION}`,
  '@deepseek-ai/dsh-compaction-basic': `npm:@crazx/dsh-compaction-basic@${FORK_VERSION}`,
  '@deepseek-ai/dsh-mcp-client': `npm:@crazx/dsh-mcp-client@${FORK_VERSION}`,
}

function registryVersion(name, plugin) {
  if (OFFICIAL_BASELINE_DEPS.get(plugin)?.has(name) === true) return OFFICIAL_VERSION
  if (name in REGISTRY_OVERRIDES) return REGISTRY_OVERRIDES[name]
  if (name.startsWith('@deepseek-ai/dsh-')) return OFFICIAL_VERSION
  return undefined
}

/** Discover source owners from package manifests in the selected Harness. */
function sourcePackages(root) {
  const packages = new Map()
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        visit(path)
        continue
      }
      if (entry.name !== 'package.json') continue
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@deepseek-ai/')) continue
      const subpath = relative(root, dir).replaceAll('\\', '/')
      const previous = packages.get(manifest.name)
      if (previous !== undefined && previous !== subpath) {
        throw new Error(`duplicate Harness package ${manifest.name}: ${previous}, ${subpath}`)
      }
      packages.set(manifest.name, subpath)
    }
  }
  visit(resolve(root, 'packages'))
  visit(resolve(root, 'vendor'))
  return packages
}

/** Every checked-in plugin package participates unless explicitly named. */
const PLUGINS = readdirSync(pluginRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-')
    && existsSync(resolve(pluginRoot, entry.name, 'package.json')))
  .map(entry => entry.name)
  .sort()

const mode = process.argv[2] === 'link' ? 'link' : process.argv[2] === 'unlink' ? 'unlink' : undefined
if (mode === undefined) {
  console.error('source-deps: mode required — "link" (source debug) or "unlink" (registry restore)')
  process.exit(1)
}
const link = mode === 'link'
const args = process.argv.slice(3)
const install = !args.includes('--no-install')
const targets = args.filter(arg => arg !== '--' && arg !== '--no-install')
if (link && !install) {
  console.error('source-deps: --no-install is only valid while restoring registry manifests')
  process.exit(1)
}
const unknownOptions = targets.filter(arg => arg.startsWith('-'))
if (unknownOptions.length > 0) {
  console.error(`source-deps: unknown option(s): ${unknownOptions.join(', ')}`)
  process.exit(1)
}
const fixed = targets.length > 0 ? targets : PLUGINS

if (link && !existsSync(resolve(anchor, 'docs/architecture.md'))) {
  console.error(
    'source-deps: no harness checkout at plugin/deepseek-harness '
    + '(need docs/architecture.md).\n'
    + '  run: pnpm run plugin:setup   # creates the sibling anchor, or set DSH_CHECKOUT',
  )
  process.exit(1)
}

const sources = link ? sourcePackages(anchor) : undefined

for (const name of fixed) {
  const pkgPath = resolve(repoRoot, 'plugin', name, 'package.json')
  if (!existsSync(pkgPath)) {
    console.error(`source-deps: no such plugin package: ${name}`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const deps = manifest.devDependencies ?? {}
  let touched = 0
  for (const dep of Object.keys(deps)) {
    const registry = registryVersion(dep, name)
    if (registry === undefined) {
      if (dep.startsWith('@deepseek-ai/')) throw new Error(`no registry policy for ${dep}`)
      continue
    }
    const keepOfficial = OFFICIAL_BASELINE_DEPS.get(name)?.has(dep) === true
    const source = link && !keepOfficial ? sources?.get(dep) : undefined
    if (link && !keepOfficial && source === undefined) {
      throw new Error(`selected Harness does not provide ${dep}`)
    }
    const next = link && !keepOfficial ? `link:../deepseek-harness/${source}` : registry
    if (deps[dep] === next) continue
    deps[dep] = next
    touched += 1
  }
  if (touched === 0) {
    console.log(`${name}: already ${link ? 'link' : 'registry'} posture`)
    continue
  }
  manifest.devDependencies = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n')
  if (install) execFileSync('pnpm', ['install'], { cwd: resolve(pkgPath, '..'), stdio: 'inherit' })
  console.log(`${name}: ${touched} dep(s) -> ${link ? 'link: (source debug)' : install ? 'registry' : 'registry manifest (install deferred)'}`)
}

if (link) {
  console.log(
    '\nsource-deps: DEBUG posture active — source dependencies must not be committed.\n'
    + '  restore with: pnpm run unlink:source',
  )
} else if (!install) {
  console.log(
    '\nsource-deps: registry manifests restored without install.\n'
    + '  run pnpm install/frozen validation after every referenced fork package is published.',
  )
}
