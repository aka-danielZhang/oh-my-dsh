/**
 * Assemble the self-contained dsh runtime from our fork at the pinned
 * revision (runtime/revision.json). SHA-keyed caching makes rebuilds cheap:
 * the same SHA assembles once, later runs only verify and print the path.
 *
 * Approach: the publish path, pointed at a local directory instead of npm.
 * Every @deepseek-ai/* package is packed (pnpm pack rewrites workspace:
 * protocols exactly like publishing does), then installed with an overrides
 * map so the whole tree resolves to our fork tarballs while third-party
 * deps come from the registry. (`pnpm deploy --legacy` drops transitive
 * vendored workspace deps — cosmokit et al. — so it is not usable here.)
 *
 * Layout produced:
 *   runtime/build/<sha>/dsh/       self-contained runtime (bin: lib/bin.js)
 *   runtime/build/<sha>/tools/     node + pnpm binaries the sidecar uses
 *   runtime/src/                   persistent partial clone (fetch deltas)
 *   runtime/tarballs/              packed fork packages (rebuilt per SHA)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execNpm, execPnpm } from './cli-bins.mjs'

// Bump when the ASSEMBLY changes (deps, layout) so the SHA-keyed caches
// invalidate themselves instead of shipping a stale tree.
const SCRIPT_REV = 16
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function electronAbiToken() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'node_modules/electron/package.json'), 'utf8'))
    return `electron-${pkg.version}`
  } catch {
    return 'electron-none'
  }
}
const cacheToken = `${SCRIPT_REV} ${process.platform} ${process.arch} ${electronAbiToken()}`

const revision = JSON.parse(readFileSync(resolve(repoRoot, 'runtime/revision.json'), 'utf8'))
const srcDir = resolve(repoRoot, 'runtime/src')
const outDir = resolve(repoRoot, 'runtime/build', revision.sha)
const tarballDir = resolve(repoRoot, 'runtime/tarballs', revision.sha)
const buildMarker = resolve(srcDir, '.prepare-runtime-ok')

const cachedRev = existsSync(resolve(outDir, '.script-rev'))
  ? readFileSync(resolve(outDir, '.script-rev'), 'utf8').trim()
  : ''
const cachedNode = process.platform === 'win32'
  ? resolve(outDir, 'tools/node_modules/node/bin/node.exe')
  : resolve(outDir, 'tools/node_modules/node/bin/node')
if (
  cachedRev === cacheToken
  && existsSync(resolve(outDir, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'))
  && existsSync(cachedNode)
) {
  console.log(`prepare-runtime: cached ${revision.sha.slice(0, 12)} -> ${outDir}`)
  process.exit(0)
}
rmSync(outDir, { recursive: true, force: true })

mkdirSync(outDir, { recursive: true })

// 1. Persistent partial clone; fetch only the delta to the pinned ref.
if (!existsSync(resolve(srcDir, '.git'))) {
  console.log('prepare-runtime: cloning fork (partial)...')
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', revision.repo, srcDir], { stdio: 'inherit' })
}
console.log(`prepare-runtime: fetching ${revision.ref}...`)
execFileSync('git', ['fetch', '--filter=blob:none', 'origin', revision.ref], { cwd: srcDir, stdio: 'inherit' })
// reset --hard, not checkout --detach: the pack step below flips private
// flags on tracked manifests and never restores them, so a reused clone
// carries a dirty tree that a plain checkout refuses to abandon (first
// hit reusing the zw.2 clone for zw.3). Untracked files (the SHA build
// marker) survive the reset.
execFileSync('git', ['reset', '--hard', revision.sha], { cwd: srcDir, stdio: 'inherit' })
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: srcDir, encoding: 'utf8' }).trim()
if (actual !== revision.sha) {
  console.error(`prepare-runtime: checkout drifted (want ${revision.sha}, got ${actual})`)
  process.exit(1)
}

// 2. Install + build, cached per SHA.
if (!existsSync(buildMarker) || readFileSync(buildMarker, 'utf8').trim() !== revision.sha) {
  console.log('prepare-runtime: pnpm install (frozen)...')
  execPnpm(['install', '--frozen-lockfile'], { cwd: srcDir, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
  console.log('prepare-runtime: pnpm build...')
  execPnpm( ['run', 'build'], { cwd: srcDir, stdio: 'inherit' })
  writeFileSync(buildMarker, revision.sha + '\n')
} else {
  console.log('prepare-runtime: install+build cached for this SHA')
}

// 3. Pack every publishable @deepseek-ai/* package. Vendored packages are
// private:true in the workspace (rescope policy); the publish flow still
// ships them, so flip the flag in this disposable clone before packing.
rmSync(tarballDir, { recursive: true, force: true })
mkdirSync(tarballDir, { recursive: true })
const packages = JSON.parse(
  execPnpm( ['-r', 'ls', '--depth', '-1', '--json'], { cwd: srcDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
)
const overrides = {}
let packed = 0
const skipped = []
// Fork-modified packages ship as npm releases under the fork scope (FORK.md
// 「发布纪律」); the runtime consumes those published versions instead of
// packing the clone — same bytes the world can install, one provenance.
// Source of truth: fork repo FORK.md (`node scripts/publish-fork.mjs --list`).
// The 0.1.5-rc.2 set restores the unified desktop toolbar dropped from the
// old release-only lineage: `dsh-client-ui-layout` (shell.toolbar seat +
// host registry), `dsh-client-ui-conversation` (session-header portal), and
// `dsh-client-test-runtime` (its test support) join here, as does
// `dsh-llm-pi-ai` (route-level session-affinity headers for affinity
// gateways like OpenCode Go). Retired earlier:
// `dsh-client-ui-settings-models` (revert ffffaf39, 2026-08-20). In 0.1.5
// the upstream lifetime write lease replaces the retired fork persistence
// coordinator, so session-persistence rides the official package set.
const FORK_MODIFIED = new Set([
  '@deepseek-ai/dsh-agent-default-model',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-test-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-todo-completion-guard',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh',
])
const FORK_NPM_SCOPE = process.env.FORK_NPM_SCOPE ?? '@crazx'
// revision.ref spells v<upstream-baseline>+zw.<N>; npm versions are
// <upstream-baseline>.zw.<N>.
const zwMatch = /^(v[^+]+)\+zw\.(\d+)$/.exec(revision.ref)
if (zwMatch === null) {
  console.error(`prepare-runtime: revision.ref carries no zw layer: ${revision.ref}`)
  process.exit(1)
}
const forkBaseVersion = zwMatch[1].slice(1)
const wantedZw = Number(zwMatch[2])
function resolveForkNpmVersion(forkName) {
  // Exact release only: letting each package descend to an older .zw layer
  // assembles a mixed fork release — the failure mode the single-version
  // discipline in FORK.md exists to prevent.
  const ver = `${forkBaseVersion}.zw.${wantedZw}`
  try {
    execNpm(['view', `${forkName}@${ver}`, 'version'], { stdio: 'pipe' })
    return ver
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
      console.error(`prepare-runtime: could not run npm view (${err.code}: ${err.message.split('\n')[0]}) — npm must be on PATH`)
      process.exit(1)
    }
  }
  console.error(`prepare-runtime: fork npm release not on the registry: ${forkName}@${ver}`)
  console.error('  publish the complete .zw layer in the fork repo (node scripts/publish-fork.mjs), then re-run')
  process.exit(1)
}
const forkNpmOf = {}
for (const name of FORK_MODIFIED) {
  const forkName = `${FORK_NPM_SCOPE}/${name.slice('@deepseek-ai/'.length)}`
  const ver = resolveForkNpmVersion(forkName)
  forkNpmOf[name] = ver
  overrides[name] = `npm:${forkName}@${ver}`
}
console.log(`prepare-runtime: fork-modified set -> npm ${FORK_NPM_SCOPE}/*`)
for (const name of FORK_MODIFIED) {
  console.log(`  ${name} -> ${forkNpmOf[name]}`)
}

// Pin EVERY @deepseek-ai/* package to the fork's baseline version. The fork
// tree is one upstream line; letting unmodified packages float on their
// ^ranges silently mixes upstream lines when upstream publishes a newer rc
// (rc.8 matching ^0.1.0-rc.7 mixed 18 packages in — unique-symbol registries
// then break across module copies: `undefined (reading 'prepare')`). The
// baseline moves only when WE merge upstream and re-release. Skipped natives
// (landlock etc.) get the exact-version pin too — same rule, no float.
const BASELINE_PIN = {}
for (const pkg of packages) {
  if (!pkg.name?.startsWith('@deepseek-ai/')) continue
  if (overrides[pkg.name] !== undefined) continue
  // Pin to the version the fork tree itself declares (its manifest version),
  // not the raw baseline string: vendored framework packages (schemastery,
  // cordis) carry their own version lines unrelated to the dsh rc cadence.
  const manifest = JSON.parse(readFileSync(resolve(pkg.path, 'package.json'), 'utf8'))
  BASELINE_PIN[pkg.name] = manifest.version
}
for (const pkg of packages) {
  if (!pkg.name?.startsWith('@deepseek-ai/')) continue
  if (FORK_MODIFIED.has(pkg.name)) continue // consumed from npm via overrides
  const manifestPath = resolve(pkg.path, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.private === true) {
    manifest.private = false
  }
  // Rewrite fork-name references to the @crazx alias BEFORE packing. pnpm's
  // `npm:` alias overrides do not reach into file:-tarball manifests, so a
  // packed `@deepseek-ai/dsh-base` keeping `dsh-agent-default-model:
  // workspace:^` (pack expands it to the bare rc version) resolves the
  // OFFICIAL registry copy of a fork-modified package once upstream
  // publishes that rc (the zw.4 assembly leaked six packages this way).
  // Dependency edges point at the alias; peer edges KEEP the original
  // `@deepseek-ai/*` key and pin the exact fork version — the same policy
  // publish-fork.mjs applies — because peers require semver, not npm
  // aliases, and the overrides map re-points the original name at the
  // @crazx instance for the install.
  let rewrote = false
  for (const field of ['dependencies', 'optionalDependencies']) {
    const deps = manifest[field]
    if (deps === undefined) continue
    for (const name of Object.keys(deps)) {
      if (!FORK_MODIFIED.has(name)) continue
      deps[name] = `npm:${FORK_NPM_SCOPE}/${name.slice('@deepseek-ai/'.length)}@${forkNpmOf[name]}`
      rewrote = true
    }
  }
  if (manifest.peerDependencies !== undefined) {
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (!FORK_MODIFIED.has(name)) continue
      manifest.peerDependencies[name] = forkNpmOf[name]
      rewrote = true
    }
  }
  if (manifest.private === false || rewrote) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  // Platform-specific natives (landlock linux builds etc.) fail their own
  // prepare verification off-target; skip them — overrides then leaves them
  // to the official npm build, which is the same artifact either way.
  try {
    execPnpm( ['pack', '--pack-destination', tarballDir], { cwd: pkg.path, stdio: 'pipe' })
  } catch {
    skipped.push(pkg.name)
    continue
  }
  // pnpm pack names scoped tarballs "<scope>-<name>-<version>.tgz" (@ stripped).
  const expected = `${pkg.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
  const tarball = resolve(tarballDir, expected)
  if (!existsSync(tarball)) {
    console.error(`prepare-runtime: expected tarball missing for ${pkg.name}: ${expected}`)
    process.exit(1)
  }
  overrides[pkg.name] = `file:${tarball}`
  packed += 1
}
console.log(`prepare-runtime: packed ${packed} fork packages` + (skipped.length > 0 ? ` (skipped to npm: ${skipped.join(', ')})` : ''))
console.log(`prepare-runtime: pinning ${Object.keys(BASELINE_PIN).length} unmodified package(s) to baseline ${forkBaseVersion} (no upstream float)`)
// Tarball pins (file:) WIN — a bare-version pin would silently fetch the
// OFFICIAL registry build for packed packages, losing every fork change in
// them (the zw.4 assembly leaked dsh-web-app this way: its official rc.8
// build carried an unpatched frontend-static chain). The baseline pin only
// catches what the pack loop skipped.
const finalOverrides = { ...BASELINE_PIN, ...overrides }

// 4. Runtime manifest: the CLI rides the fork npm release (the
// `npm:@crazx/dsh` override above); every other @deepseek-ai/* is pinned to
// our tarballs via overrides, plus the node/pnpm tools the sidecar needs.
// tsx is a first-class runtime dep, not a dev nicety: profiles may install
// source-distributed plugins (.ts entries under their node_modules), which
// plain Node refuses to type-strip — the terminal source runtime loads them
// via `node --import tsx/esm`, and the bundled runtime must match (the shell
// passes the same --import for bundled runs).
const runtimeDir = resolve(outDir, 'dsh')
rmSync(runtimeDir, { recursive: true, force: true })
mkdirSync(runtimeDir, { recursive: true })
// Overrides MUST live in pnpm-workspace.yaml: pnpm 11 dropped support for the
// package.json `pnpm.overrides` field, and under pnpm 11 the runtime manifest's
// overrides were silently IGNORED — every ^range edge resolved to the official
// registry while the same tree kept passing the version-equality scan (same
// rc.8 on both sides, two module builds, split unique-symbol registries: the
// 2026-08-20 zw.4 release failure). pnpm 10 reads the yaml form too.
// Override VALUES stay absolute file: paths (pnpm rejects `..` segments in
// version unions); the direct-dependency edges below use relative specs so
// the built tree relocates with the repo.
const relSpec = (spec) => {
  if (!spec.startsWith('file:')) return spec
  // Forward slashes: pnpm's allowBuilds keys (and its own diagnostics) spell
  // file: specs canonically with /, so a Windows backslash path never matches.
  return 'file:' + relative(runtimeDir, spec.slice('file:'.length)).split('\\').join('/')
}
const overrideLines = []
for (const [name, spec] of Object.entries(finalOverrides)) {
  overrideLines.push(`  '${name}': ${spec}`)
}
// pnpm 11 keys build approvals for non-registry deps by the QUALIFIED
// `name@spec` form — a bare-name entry never matches a file: tarball, and
// the install hard-fails on the unresolved decision. Every packed tarball
// is our own artifact, so its build scripts are allowed wholesale.
const buildApprovalLines = []
for (const [name, spec] of Object.entries(overrides)) {
  if (spec.startsWith('file:')) {
    // dsh-root's postinstall wires husky into the checkout — meaningless and
    // unresolvable inside the runtime tree (its lefthook devDep is not
    // installed), so it is explicitly denied while every other packed
    // artifact's scripts run as they would in the fork repo.
    const allow = name !== '@deepseek-ai/dsh-root'
    buildApprovalLines.push(`  '${name}@${relSpec(spec)}': ${allow}`)
  }
}
const forkDirectDeps = {}
for (const name of FORK_MODIFIED) {
  const forkName = `${FORK_NPM_SCOPE}/${name.slice('@deepseek-ai/'.length)}`
  forkDirectDeps[name] = `npm:${forkName}@${forkNpmOf[name]}`
}
// EVERY packed tarball rides as a direct dependency too. Overrides reach only
// ordinary dependency edges: host packages expose their seams as
// peerDependencies (dsh-workflow-worker-thread et al. peer on @deepseek-ai/
// dsh-tools/dsh-session/dsh-agent), and neither file: overrides NOR alias
// overrides touch peer edges. Direct deps give peer resolution a root-level
// tarball instance to bind; combined with autoInstallPeers:false (below) no
// edge can pull the official registry build while upstream publishes the same
// rc — the duplicate-instance failure mode behind `undefined (reading
// 'prepare')` and the typert gateway losing /api/<remote>/* routes.
const tarballDirectDeps = {}
for (const [name, spec] of Object.entries(overrides)) {
  if (spec.startsWith('file:')) tarballDirectDeps[name] = relSpec(spec)
}
writeFileSync(resolve(runtimeDir, 'package.json'), JSON.stringify({
  private: true,
  // Deterministic installer: the pnpm shim honors the nearest packageManager
  // pin, so the runtime tree installs under the same major the repo pins
  // instead of whatever pnpm the assembling shell defaults to.
  packageManager: 'pnpm@11.7.0',
  dependencies: {
    ...forkDirectDeps,
    ...tarballDirectDeps,
    '@deepseek-ai/dsh': `npm:${FORK_NPM_SCOPE}/dsh@${forkNpmOf['@deepseek-ai/dsh']}`,
    tsx: '^4.19.2',
  },
}, null, 2) + '\n')
// Build-script decisions. QUALIFIED `name@file:` keys are NOT usable here:
// pnpm rejects file: specifiers in allowBuilds version unions
// (ERR_PNPM_INVALID_VERSION_UNION) — bare-name keys match these deps fine
// (verified: the spawn-helper chmod ran under pnpm 10.28). The vendored root
// package's husky is noise; it fails safe as an ignored-build warning.
writeFileSync(resolve(runtimeDir, 'pnpm-workspace.yaml'), [
  // Peers resolve from ancestors only: auto-install would fetch registry
  // builds for unsatisfied peer ranges, the exact leak this assembly prevents.
  'autoInstallPeers: false',
  // All inputs are fork tarballs or pinned registry deps; the local supply-chain
  // release-age guard (if configured globally) has nothing to add here.
  'minimumReleaseAge: 0',
  'overrides:',
  ...overrideLines,
  'allowBuilds:',
  '  node-pty: true',
  '  koffi: true',
  '  esbuild: true',
  '  protobufjs: false',
  "  '@google/genai': false",
  '  node-addon-require-builtin: false',
  ...buildApprovalLines,
  '',
].join('\n'))
// Windows bsdtar follows NTFS junctions into copies, which breaks pnpm's
// nested .pnpm layout (tsx then cannot resolve sibling esbuild). Hoist so
// the tree is real directories and survives the tar round-trip. Unix keeps
// the default isolated linker — tar preserves POSIX symlinks.
if (process.platform === 'win32') {
  writeFileSync(resolve(runtimeDir, '.npmrc'), 'node-linker=hoisted\n')
}
console.log('prepare-runtime: installing runtime tree...')
// Both the lockfile AND node_modules must go: pnpm install with no lockfile
// but a stale node_modules resolves incrementally against the existing
// layout, silently keeping registry copies the new overrides re-point at
// tarballs (the SCRIPT_REV=4 half-assembly shipped exactly that).
rmSync(resolve(runtimeDir, 'pnpm-lock.yaml'), { force: true })
rmSync(resolve(runtimeDir, 'node_modules'), { recursive: true, force: true })
execPnpm(['install', '--no-frozen-lockfile'], { cwd: runtimeDir, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
// node-pty's spawn-helper needs its exec bit; the postinstall that restores it
// may be skipped as an ignored build, so run the same idempotent chmod directly.
{
  const chmod = resolve(runtimeDir, 'node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs')
  if (existsSync(chmod)) execFileSync('node', [chmod], { cwd: runtimeDir, stdio: 'pipe' })
}

// 4b. Fail loud if any fork-modified package still resolved to an official
// registry copy: the fix above is structural, but a future pnpm peer-resolution
// path could reintroduce the drift — shipping the unpatched build is exactly
// the failure this assembly exists to prevent.
{
  const { readdirSync } = await import('node:fs')
  const drifted = []
  const offBaseline = []
  const duplicated = []
  const pnpmDir = resolve(runtimeDir, 'node_modules/.pnpm')
  if (existsSync(pnpmDir)) {
    // package name -> whether any file: (packed tarball) instance exists
    const packedNames = new Set()
    for (const entry of readdirSync(pnpmDir)) {
      // Non-greedy name + the LAST '@' before the version segment: dir names
      // embed peer suffixes ("pkg@ver_peer@ver"), so a greedy name group would
      // swallow the real version.
      const hit = /^@deepseek-ai\+(.+?)@([^_]+)/.exec(entry)
      if (hit === null) continue
      if (hit[2].includes('file+')) packedNames.add(`@deepseek-ai/${hit[1]}`)
    }
    for (const entry of readdirSync(pnpmDir)) {
      const hit = /^@deepseek-ai\+(.+?)@([^_]+)/.exec(entry)
      if (hit === null) continue
      const pkg = `@deepseek-ai/${hit[1]}`
      const version = hit[2]
      // pnpm truncates over-long tarball directory names to arbitrary
      // prefixes (`@f_<hash>`), so a non-numeric "version" is a packed
      // file: instance, never a registry copy to baseline-check.
      if (!/^\d/.test(version)) {
        packedNames.add(pkg)
        continue
      }
      if (FORK_MODIFIED.has(pkg)) drifted.push(`${pkg} (${entry})`)
      // A registry-semver instance of a package that ALSO has a packed tarball
      // instance is a duplicate module build regardless of version equality:
      // same-version official copies passed the baseline scan below on
      // 2026-08-20 while splitting every unique-symbol registry across the two
      // instances (`undefined (reading 'prepare')`, lost typert routes). Only
      // pack-skipped natives may exist as registry-only singletons.
      if (!version.includes('file+') && packedNames.has(pkg)) {
        duplicated.push(`${pkg}@${version} (tarball instance also present)`)
      }
      // Tarball copies (file:+..) carry no version in the dir name beyond the
      // sha prefix; only registry copies spell a real version. The expected
      // version per package is the fork tree's own manifest (BASELINE_PIN), so
      // vendored framework lines (schemastery 3.x) and natives (landlock 0.1.1)
      // compare against themselves, not the dsh rc cadence.
      if (!version.includes('file+') && version !== (BASELINE_PIN[pkg] ?? forkBaseVersion) && !version.endsWith(`.zw.${zwMatch[2]}`)) {
        offBaseline.push(`${pkg}@${version} (expected ${BASELINE_PIN[pkg] ?? forkBaseVersion})`)
      }
    }
  } else {
    // Windows hoisted layout (node-linker=hoisted) has no .pnpm package dirs;
    // approximate the same fail-loud net over the flattened tree: fork-modified
    // packages must not exist under @deepseek-ai at all (they ship as @crazx/*),
    // and every package's version must sit on the pinned upstream line.
    // Duplicate-instance detection stays isolated-only: hoisted dedupes to one
    // visible dir per name; a second version only hides in suffixed dirs the
    // resolver would rather surface as offBaseline here anyway.
    const scopeDir = resolve(runtimeDir, 'node_modules/@deepseek-ai')
    if (existsSync(scopeDir)) {
      for (const name of readdirSync(scopeDir)) {
        const pkg = `@deepseek-ai/${name}`
        if (FORK_MODIFIED.has(pkg)) drifted.push(`${pkg} (hoisted top-level official copy)`)
        const manifest = resolve(scopeDir, name, 'package.json')
        if (!existsSync(manifest)) continue
        const version = JSON.parse(readFileSync(manifest, 'utf8')).version ?? ''
        if (version !== (BASELINE_PIN[pkg] ?? forkBaseVersion) && !version.endsWith(`.zw.${zwMatch[2]}`)) {
          offBaseline.push(`${pkg}@${version} (expected ${BASELINE_PIN[pkg] ?? forkBaseVersion})`)
        }
      }
    }
  }
  if (drifted.length > 0) {
    console.error('prepare-runtime: fork-modified packages resolved to official registry copies:')
    for (const line of drifted) console.error(`  ${line}`)
    process.exit(1)
  }
  if (duplicated.length > 0) {
    console.error('prepare-runtime: duplicate @deepseek-ai module instances (official registry copy beside the packed tarball):')
    for (const line of duplicated) console.error(`  ${line}`)
    console.error('  peer edges bypass file: overrides; the runtime manifest must carry every tarball as a direct dependency')
    process.exit(1)
  }
  if (offBaseline.length > 0) {
    console.error(`prepare-runtime: mixed upstream lines in tree (baseline ${forkBaseVersion}):`)
    for (const line of offBaseline) console.error(`  ${line}`)
    console.error('  the fork tracks ONE upstream line; merge upstream in the fork and re-release to move it')
    process.exit(1)
  }
}

// 5. Runtime tools: node + pnpm binaries.
const toolsDir = resolve(outDir, 'tools')
rmSync(toolsDir, { recursive: true, force: true })
mkdirSync(toolsDir, { recursive: true })
writeFileSync(resolve(toolsDir, 'package.json'), JSON.stringify({
  private: true,
  dependencies: { node: '24.9.0', pnpm: '11.7.0' },
}, null, 2) + '\n')
writeFileSync(resolve(toolsDir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  node: true\n')
if (process.platform === 'win32') {
  writeFileSync(resolve(toolsDir, '.npmrc'), 'node-linker=hoisted\n')
}
rmSync(resolve(toolsDir, 'pnpm-lock.yaml'), { force: true })
execPnpm( ['install', '--no-frozen-lockfile'], { cwd: toolsDir, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
writeFileSync(resolve(outDir, '.script-rev'), `${cacheToken}\n`)

console.log(`prepare-runtime: done -> ${outDir}`)
