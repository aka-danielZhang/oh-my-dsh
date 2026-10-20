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
const OFFICIAL_VERSION = '0.2.1-rc.2'
const FORK_VERSION = '0.2.1-rc.2.zw.3'

/**
 * The fork-modified package set — exactly what
 * `deepseek-harness $ node scripts/publish-fork.mjs --list` prints for the
 * target release. Every entry must exist on npm as `@crazx/<name>` at
 * FORK_VERSION before the registry posture resolves; the harness-root
 * package carries no @deepseek-ai/dsh- prefix and is aliased directly.
 */
const FORK_PACKAGES = new Set([
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-tool-cordis',
])

/** Compatibility packages whose superclass must stay on the official baseline. */
const OFFICIAL_BASELINE_DEPS = new Map([
  ['dsh-compaction-hierarchical', new Set(['@deepseek-ai/dsh-compaction-basic'])],
])

/** Registry coordinates that do not follow the official DSH release version. */
const REGISTRY_OVERRIDES = {
  '@deepseek-ai/cordis': '4.0.5',
  '@deepseek-ai/cordis-plugin-timer': '1.1.7',
  '@deepseek-ai/schemastery': '3.18.5',
  // Upstream 0.2.1-rc.2 did not republish these two (partial release); the
  // 0.0.1-rc.1 line is the newest on the registry and API-compatible here.
  '@deepseek-ai/dsh-agent-presets': '0.0.1-rc.1',
  '@deepseek-ai/dsh-invariants': '0.0.1-rc.1',
}

/**
 * Transitive-dependency containment: official rc.1 packages depend on
 * caret ranges (`^0.1.6-alpha.1`), which silently float to any newer prerelease
 * on the registry — a partial upstream rc.2 then dead-ends the install
 * (`dsh-llm@^0.1.6-alpha.1` unresolved) and, worse, mixes upstream lines into
 * one tree. Every plugin therefore pins the FULL official dsh package
 * inventory to the baseline (fork packages to the fork layer) through
 * `pnpm.overrides`, making the install hermetic against registry drift.
 */
function dshOverrides(sources, plugin, link) {
  const overrides = {}
  const anchorVersions = sources?.versions
  for (const [name, _subpath] of sources) {
    if (!name.startsWith('@deepseek-ai/dsh-') && name !== '@deepseek-ai/dsh') continue
    // Link posture pins every @deepseek-ai/* to the ANCHOR's own manifest
    // version: the hardcoded registry baseline below describes the last
    // published fork release, which would drag the resolved instances back
    // off the source tree under evaluation.
    if (link && _subpath !== undefined && _subpath !== '') {
      // Link posture pins by SOURCE PATH, not version: a version-string
      // override would redirect even the link: devDep edges to the registry
      // build (official copies lack fork patches and, for some packages,
      // the published sourcemaps the vite test loader expects).
      overrides[name] = `link:../deepseek-harness/${_subpath}`
      continue
    }
    // The official-baseline exception wins over the fork alias: a plugin
    // that deliberately tests against the stock package (hierarchical's
    // dsh-compaction-basic) stays on the official release even though the
    // package also rides the fork layer for everyone else.
    if (OFFICIAL_BASELINE_DEPS.get(plugin)?.has(name) === true) {
      overrides[name] = OFFICIAL_VERSION
    } else if (FORK_PACKAGES.has(name)) {
      overrides[name] = `npm:@crazx/${name.slice('@deepseek-ai/'.length)}@${FORK_VERSION}`
    } else {
      overrides[name] = OFFICIAL_VERSION
    }
  }
  return overrides
}

function registryVersion(name, plugin) {
  if (OFFICIAL_BASELINE_DEPS.get(plugin)?.has(name) === true) return OFFICIAL_VERSION
  if (name in REGISTRY_OVERRIDES) return REGISTRY_OVERRIDES[name]
  // Fork-modified packages alias to the @crazx layer; everything else rides
  // the official release line. One exact fork version for the whole set — a
  // mixed .zw layer across packages is a release defect, never a fallback.
  if (FORK_PACKAGES.has(name)) {
    return `npm:@crazx/${name.slice('@deepseek-ai/'.length)}@${FORK_VERSION}`
  }
  if (name.startsWith('@deepseek-ai/dsh-')) return OFFICIAL_VERSION
  return undefined
}

/** Discover source owners from package manifests in the selected Harness. */
function sourcePackages(root) {
  const packages = new Map()
  const anchorVersions = new Map()
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
      anchorVersions.set(manifest.name, manifest.version)
    }
  }
  visit(resolve(root, 'packages'))
  visit(resolve(root, 'vendor'))
  // CLI/web app entries and the native addon family own their own manifests.
  visit(resolve(root, 'apps'))
  visit(resolve(root, 'native/system'))
  packages.versions = anchorVersions
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

// The override inventory comes from the anchor checkout in both modes:
// unlink without an anchor keeps whatever overrides the manifest already
// carries (they pin the baseline; dropping them would reopen drift).
const anchorAvailable = existsSync(resolve(anchor, 'docs/architecture.md'))
if (!link && !anchorAvailable) {
  console.error('source-deps: unlink needs the harness anchor for the override inventory (set DSH_CHECKOUT or run plugin:setup)')
  process.exit(1)
}
const sources = anchorAvailable ? sourcePackages(anchor) : undefined

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
      // The anchor no longer ships this package (retired upstream). The dep
      // stays on its registry version — stale by construction — and the
      // consumer's port drops it; failing the whole tree here would block
      // every other plugin's source validation.
      console.warn(`source-deps: ${name}: ${dep} not in the selected Harness; keeping registry spec (port pending)`)
      continue
    }
    const next = link && !keepOfficial ? `link:../deepseek-harness/${source}` : registry
    if (deps[dep] === next) continue
    deps[dep] = next
    touched += 1
  }
  // Overrides are written unconditionally: even a manifest already in the
  // target posture must gain (or refresh) the baseline pins, or a later
  // install floats transitive carets onto a newer upstream prerelease.
  manifest.devDependencies = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  )
  // Overrides live in pnpm-workspace.yaml: pnpm 11+ no longer reads the
  // package.json `pnpm` field, and 10.x reads the yaml form as well.
  const workspacePath = resolve(pkgPath, '..', 'pnpm-workspace.yaml')
  const overrideBlock = ['autoInstallPeers: false', 'minimumReleaseAge: 0', 'allowBuilds:',
    '  esbuild: true', '  koffi: true', '  node-pty: true',
    'overrides:',
    ...Object.entries(dshOverrides(sources ?? new Map(), name, link)).map(([dep, version]) => `  '${dep}': ${version}`),
  ].join('\n')
  if (existsSync(workspacePath)) {
    const text = readFileSync(workspacePath, 'utf8')
    // Idempotent rewrite: strip every fragment this script has ever written
    // (preamble keys, allowBuilds, overrides) so re-running link/unlink can
    // never stack a second copy — the malformed-yaml failure mode where a
    // prior file without a clean `overrides:` anchor hit the append branch.
    const cleaned = text
      .replace(/^(autoInstallPeers|minimumReleaseAge):[^\n]*\n?/gm, '')
      .replace(/^overrides:\n(?:[ \t]+.*\n?)*/gm, '')
      .replace(/^allowBuilds:\n(?:[ \t]+.*\n?)*/gm, '')
    const rest = cleaned.replace(/\n{2,}/g, '\n').trim()
    writeFileSync(workspacePath, rest === '' ? `${overrideBlock}\n` : `${rest}\n\n${overrideBlock}\n`)
  } else {
    writeFileSync(workspacePath, `${overrideBlock}\n`)
  }
  writeFileSync(pkgPath, JSON.stringify(manifest, null, 2) + '\n')
  if (touched === 0) {
    console.log(`${name}: already ${link ? 'link' : 'registry'} posture (overrides refreshed)`)
    continue
  }
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
