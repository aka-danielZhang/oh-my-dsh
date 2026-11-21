#!/usr/bin/env node
/**
 * Scaffold a new out-of-tree DSH plugin package under plugin/.
 *
 * Usage:
 *   node scripts/new-plugin.mjs <dsh-name> [--face host|client|dual]
 *                               [--id <rowId>] [--description <text>]
 *                               [--preset-owned] [--ship]
 *   pnpm run plugin:new -- <dsh-name> --face dual
 *
 * Faces (each distilled from a shipped plugin in this repo):
 *   host   — host-only row          (blueprint: dsh-fs-observation-log)
 *   client — browser-only surface   (blueprint: dsh-branding: empty host
 *                                     apply + exports["./client"] half)
 *   dual   — host + client in one   (blueprint: dsh-usage-stats)
 *
 * What it generates (per face): package.json (exports / dsh.bundle /
 * dsh.client / pinned registry devDeps), cordis.patch.yml row (or an
 * install-only empty patch + preset-snippet.yml with --preset-owned),
 * tsconfig.json, tsdown.config.ts (client faces carry the ModuleLoader
 * closure contract with the purity gate), src skeletons, a node:test file,
 * README.md — plus the plugin/<name>/lib/ line appended to the root
 * .gitignore.
 *
 * devDep pins are read at runtime from the blueprint packages, so the
 * scaffold follows the repo's current harness baseline automatically
 * (hardcoded fallbacks only if a blueprint is missing).
 *
 * It deliberately does NOT touch the root AGENTS.md roster or docs/notes/:
 * roster entries and decision records need human/agent prose. The printed
 * checklist covers both.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FACES = new Set(['host', 'client', 'dual'])
const NAME_RE = /^dsh-[a-z][a-z0-9-]*[a-z0-9]$/
const ID_RE = /^[a-z][a-z0-9-]*[a-z0-9]$/

/** Fallback pins, used only when a blueprint package cannot be read. */
const FALLBACK_PINS = {
  '@deepseek-ai/cordis': '4.0.1',
  '@deepseek-ai/dsh-client-runtime': '0.1.1-rc.1',
  '@deepseek-ai/dsh-client-ui-primitives': '0.1.1-rc.1',
  '@deepseek-ai/dsh-client-ui-slots': '0.1.1-rc.1',
  '@types/node': '^24.13.3',
  '@types/react': '~18.3.1',
  react: '^18.2.0',
  'react-dom': '18.3.1',
  tsdown: '^0.22.2',
  tsx: '^4.19.2',
  typescript: '^6.0.3',
}

/** Semver ranges for peerDependencies on client faces (mirrors dsh-branding). */
const PEER_RANGES = {
  '@deepseek-ai/cordis': '>=4.0.0-rc.7 <5',
  '@deepseek-ai/dsh-client-runtime': '>=0.0.1-rc.1 <1',
  '@deepseek-ai/dsh-client-ui-slots': '>=0.0.1-rc.1 <1',
  react: '^18.2.0',
}

function fail(message) {
  console.error(`new-plugin: ${message}`)
  process.exit(1)
}

function usage() {
  return [
    'usage: node scripts/new-plugin.mjs <dsh-name> [options]',
    '       pnpm run plugin:new -- <dsh-name> [options]',
    '',
    'options:',
    '  --face <host|client|dual>  plugin shape (default: host)',
    '  --id <rowId>               cordis row id (default: name minus the dsh- prefix;',
    '                             client/dual faces default to the full package name,',
    '                             which doubles as the client bundle id)',
    '  --description <text>       package.json description (default: TODO placeholder)',
    '  --preset-owned             host face only: empty install-only patch +',
    '                             preset-snippet.yml (dsh-fs-observation-log shape)',
    '  --ship                     mark dsh.desktop.ship so prepare/CI/install follow',
    '  -h, --help                 show this help',
  ].join('\n')
}

// ---------------------------------------------------------------- args ----
const args = process.argv.slice(2)
const positional = []
const opts = { face: 'host', presetOwned: false, ship: false }

for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--face') opts.face = args[++i]
  else if (a === '--id') opts.rowId = args[++i]
  else if (a === '--description' || a === '-d') opts.description = args[++i]
  else if (a === '--preset-owned') opts.presetOwned = true
  else if (a === '--ship') opts.ship = true
  else if (a === '-h' || a === '--help') {
    console.log(usage())
    process.exit(0)
  } else if (a.startsWith('--')) {
    fail(`unknown option ${a}\n\n${usage()}`)
  } else positional.push(a)
}

if (positional.length === 0) fail(`missing <dsh-name>\n\n${usage()}`)
if (positional.length > 1) fail(`unexpected extra argument: ${positional[1]}`)
const name = positional[0]
if (!NAME_RE.test(name)) {
  fail(`name "${name}" must match ${NAME_RE.toString()} — unscoped, lowercase, dsh- prefixed (directory name === package name)`)
}
if (!FACES.has(opts.face)) fail(`--face must be one of host|client|dual, got "${opts.face}"`)
if (opts.presetOwned && opts.face !== 'host') {
  fail('--preset-owned applies to --face host only (client rows mount through the profile patch)')
}

/** Default row id: short id for host rows; the full name for rows that carry a client half (it doubles as the client bundle id). */
const rowId = opts.rowId ?? (opts.face === 'host' ? name.replace(/^dsh-/, '') : name)
if (!ID_RE.test(rowId)) fail(`row id "${rowId}" must match ${ID_RE.toString()}`)

const pkgDir = join(repoRoot, 'plugin', name)
if (existsSync(pkgDir)) fail(`plugin/${name} already exists — the scaffold never overwrites`)

const description = opts.description ?? `TODO: one-line purpose for ${name} — what it changes and where it mounts`

// ------------------------------------------------------- version pins ----
function pinsFrom(packageName, keys) {
  const out = {}
  const file = join(repoRoot, 'plugin', packageName, 'package.json')
  try {
    const dev = JSON.parse(readFileSync(file, 'utf8')).devDependencies ?? {}
    for (const key of keys) if (typeof dev[key] === 'string') out[key] = dev[key]
  } catch {
    // blueprint unreadable — caller falls back to FALLBACK_PINS
  }
  return out
}

const pin = (key) =>
  pinsFrom('dsh-fs-observation-log', [key])[key]
  ?? pinsFrom('dsh-branding', [key])[key]
  ?? FALLBACK_PINS[key]

// ------------------------------------------------------------ templates ----
function cordisPatchYml() {
  if (opts.presetOwned) {
    return [
      '# Install-only profile bundle: this plugin contributes no host-layer',
      '# service of its own, so activation belongs to each agent preset —',
      '# add the row from preset-snippet.yml to a copied user preset (the',
      '# dsh-fs-observation-log / dsh-compaction-hierarchical shape).',
      '[]',
      '',
    ].join('\n')
  }
  const lines = [
    `# ${name} bundle patch: the row(s) mounted for every profile that installs`,
    '# this plugin. Grow extra rows here as needed (see dsh-usage-stats',
    '# for a host-gateway + client pair). If the row should be preset-owned',
    '# instead (host service only some agent presets mount), empty this patch',
    '# to [] and ship a preset-snippet.yml.',
  ]
  if (opts.face !== 'host') {
    lines.push(
      '# Rows carrying the browser half keep the entry id equal to the client',
      `# bundle id (the package name) so the loader can serve /plugins/${name}/client.js.`,
    )
  }
  lines.push('- insert:', `    - id: ${rowId}`, `      name: ${name}`, '')
  return lines.join('\n')
}

function presetSnippetYml() {
  return [
    '# Add to a copied user preset (e.g. one derived from `standard`).',
    `# ${name} row owned by the preset, not the profile patch.`,
    `- id: ${rowId}`,
    `  name: ${name}`,
    '',
  ].join('\n')
}

function tsconfigJson() {
  const base = {
    compilerOptions: {
      target: 'es2024',
      lib: opts.face === 'host' ? ['es2024'] : ['es2024', 'dom', 'dom.iterable'],
      module: 'node16',
      moduleResolution: 'node16',
      ...(opts.face !== 'host' ? { jsx: 'react-jsx' } : {}),
      strict: true,
      noImplicitAny: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      ...(opts.face === 'host' ? { erasableSyntaxOnly: true } : {}),
      noUncheckedSideEffectImports: true,
      types: ['node'],
    },
    include:
      opts.face === 'host'
        ? ['src/**/*.ts', 'tests/**/*.ts']
        : ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts'],
  }
  return `${JSON.stringify(base, null, 2)}\n`
}

function tsdownHostConfig() {
  return `/**
 * Host-only ESM build. Keep every harness import in src/ type-only so the
 * emitted bundle carries zero @deepseek-ai/* runtime imports and no
 * externals list is needed — the plugin cannot drag a second copy of cordis
 * into the process (the module-instance split that breaks unique-symbol
 * registries; see the repo's npm dependency discipline). Grow entries here
 * as src/ gains modules.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '${name}',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
`
}

function tsdownClientConfig() {
  return `/**
 * Build config for ${name}, distilled from the harness's
 * packages/client/tsdown.client.ts contract (same shape as
 * dsh-desktop-bridge / dsh-branding):
 *
 * - Node half (lib/index.js): plain ESM library so the host Loader can
 *   import the row's node half from a plugin install.
 * - Browser half (lib/client.js): the closure-factory artifact the client
 *   module system expects — window.__ModuleLoader__.load({id, factory})
 *   with platform modules externalized to the loader's module table.
 */

import { defineConfig } from 'tsdown'

/** Module-table entries the browser shell answers natively (mirror of the
 * harness rc.8+ implicit baseline: PLATFORM_MODULES — shell-seeded React,
 * Cordis, and static UI libraries — plus the parser-preloaded runtime
 * exemption). Should the baseline move, re-check against PLATFORM_MODULES. */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  // Documented runtime exemption (preloaded by the parser before the shell
  // starts) — the table answers it natively.
  '@deepseek-ai/dsh-client-runtime/client',
] as const

/**
 * Bundle purity gate: any @deepseek-ai/* value import that is not a platform
 * module is a build error — cross-plugin collaboration goes through cordis
 * services; type-only imports are erased before this gate runs.
 */
function purityGate(): import('tsdown').UserConfig['plugins'][number] {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if ((CLIENT_EXTERNALS as readonly string[]).includes(source)) return null
      throw new Error(
        'client bundle purity: "' + source + '" is not a platform module (CLIENT_EXTERNALS) — '
        + 'cross-plugin value imports are forbidden; collaborate through cordis services',
      )
    },
  }
}

export default defineConfig([
  {
    name: '${name}',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: '${name}/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    noExternal: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
    plugins: [purityGate()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "${name}", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
`
}

function hostIndexTs() {
  if (opts.face === 'client') {
    return `/**
 * ${name}, host half. Pure surface entry: the empty apply exists so the
 * cordis row is valid and the package appears in the host Loader; the
 * browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration. No host-side behavior.
 */

/** Host plugin body — no host-side behavior for this surface. */
export function apply(): void {}
`
  }
  return `/**
 * ${name}, host half. TODO: one-paragraph purpose — what this plugin
 * changes and where it mounts (mirror it in README.md).
 *
 * Skeleton reminders (repo conventions, see the root AGENTS.md):
 * - Every side effect reversible: ctx.on / ctx.effect / register() all
 *   return disposers collected by this fiber (HMR-safe).
 * - Hard dependencies: export inject = ['service'] (the loader waits for
 *   them); optional services: const s = ctx.get('x'), handle undefined.
 * - Keep @deepseek-ai/* imports type-only where possible so the built
 *   bundle cannot drag a second module instance into the process.
 * @module ${name}
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name used by loader diagnostics. */
export const name = '${name}'

/**
 * Host plugin body.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  // TODO: implement. Example effect discipline:
  //
  // ctx.effect(() => {
  //   const timer = setInterval(() => {}, 5_000)
  //   return () => clearInterval(timer)
  // })
}
`
}

function clientIndexTs() {
  return `/**
 * ${name}, browser half. TODO: purpose.
 *
 * Skeleton reminders (repo conventions, see the root AGENTS.md):
 * - Compose UI only through declared additive slots (ctx.slots.register /
 *   ctx.slots.inject); never punch a declared hole. shell.overlay is the
 *   usual first seat.
 * - Style with --dsw-* semantic tokens only; never hard-code colors.
 * - Registrations are effects: disposers are collected by this fiber.
 * - Lazy-read optional services at interaction time (ctx.get), not at
 *   register time — strict get only serves ACTIVE providers.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Required services: the slot registry (declaration-aware). */
export const inject = ['slots']

/**
 * Client plugin body.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // TODO: implement. Example — an additive overlay seat:
  //
  // ctx.slots.inject('shell.overlay', () =>
  //   ctx.slots.register({ name: 'shell.overlay' }, MyComponent),
  // )
}
`
}

function testTs() {
  const imports = ["import assert from 'node:assert/strict'", "import { test } from 'node:test'"]
  const tests = []
  if (opts.face === 'client') {
    imports.push("import { apply } from '../src/index.ts'")
    tests.push([
      "test('host half exports a loadable surface entry', () => {",
      "  assert.equal(typeof apply, 'function')",
      '})',
    ])
  } else {
    imports.push(`import { name, apply } from '../src/index.ts'`)
    tests.push([
      'test(\'host half exports a loadable plugin\', () => {',
      `  assert.equal(name, '${name}')`,
      "  assert.equal(typeof apply, 'function')",
      '})',
    ])
  }
  if (opts.face !== 'host') {
    imports.push("import { apply as clientApply, inject } from '../src/client/index.ts'")
    tests.push([
      "test('client half exports a loadable plugin', () => {",
      "  assert.equal(typeof clientApply, 'function')",
      "  assert.ok(Array.isArray(inject) && inject.includes('slots'))",
      '})',
    ])
  }
  return `${imports.join('\n')}\n\n${tests.map((t) => t.join('\n')).join('\n\n')}\n`
}

function readmeMd() {
  const fence = '```'
  const lines = [
    `# ${name}`,
    '',
    'TODO: one paragraph — what this plugin changes and where it mounts.',
    '',
    '## Install',
    '',
    `${fence}sh`,
    `dsh plugin --profile web add <repo>/plugin/${name}`,
    `${fence}`,
    '',
  ]
  if (opts.presetOwned) {
    lines.push(
      'The bundle patch is intentionally empty (install-only registration, like',
      '`dsh-fs-observation-log`): activation belongs to each agent preset — add the',
      'row from `preset-snippet.yml` to your user preset:',
      '',
      `${fence}yaml`,
      `- id: ${rowId}`,
      `  name: ${name}`,
      `${fence}`,
      '',
    )
  } else {
    lines.push(
      `The bundle patch mounts the \`${rowId}\` row for every profile that installs`,
      'this plugin.',
      '',
    )
  }
  if (opts.face !== 'host') {
    lines.push(
      '## Client half',
      '',
      '`lib/client.js` is the ModuleLoader closure artifact (window.__ModuleLoader__',
      '.load) with platform modules externalized — the build contract lives in this',
      "package's `tsdown.config.ts`; keep `CLIENT_EXTERNALS` in sync with the",
      'harness `PLATFORM_MODULES` baseline when it moves.',
      '',
    )
  }
  lines.push(
    '## Config',
    '',
    'TODO: document cordis.yml `config` fields (invalid values must fail loud),',
    'or remove this section.',
    '',
    '## Design notes',
    '',
    `- TODO: link the decision record \`docs/notes/<date>-${rowId}.md\` (repo root).`,
    '- Contracts live in the repo root `AGENTS.md` (plugin monorepo rules, npm',
    '  dependency discipline, client bundle build contract).',
    '',
  )
  return lines.join('\n')
}

function packageJson() {
  const hasClient = opts.face !== 'host'
  const pkg = {
    name,
    version: '0.1.0',
    description,
    type: 'module',
    main: 'lib/index.js',
    exports: hasClient
      ? {
          '.': { default: './lib/index.js' },
          './client': { default: './lib/client.js' },
          './src/*': './src/*',
          './package.json': './package.json',
        }
      : {
          '.': { default: './lib/index.js' },
          './src/*': './src/*',
          './package.json': './package.json',
        },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...(hasClient
        ? {
            client: {
              inject: ['@deepseek-ai/dsh-client-runtime'],
              platform: 'web',
            },
          }
        : {}),
      ...(opts.ship ? { desktop: { ship: true } } : {}),
    },
    scripts: {
      typecheck: 'tsc --noEmit',
      build: 'tsdown',
      watch: 'tsdown --watch',
      test: 'node --import tsx --test tests/*.test.ts',
      'plugin:add': 'dsh plugin --profile web add file:.',
      'plugin:remove': `dsh plugin --profile web remove ${name}`,
    },
    files: [
      'lib/index.js',
      ...(hasClient ? ['lib/client.js', 'lib/client.js.map'] : []),
      'cordis.patch.yml',
      ...(opts.presetOwned ? ['preset-snippet.yml'] : []),
      'README.md',
    ],
    keywords: ['deepseek-harness', 'dsh', 'dsh-plugin'],
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'git+https://github.com/aka-danielZhang/oh-my-dsh.git',
      directory: `plugin/${name}`,
    },
    ...(hasClient
      ? {
          peerDependencies: {
            '@deepseek-ai/cordis': PEER_RANGES['@deepseek-ai/cordis'],
            '@deepseek-ai/dsh-client-runtime': PEER_RANGES['@deepseek-ai/dsh-client-runtime'],
            '@deepseek-ai/dsh-client-ui-slots': PEER_RANGES['@deepseek-ai/dsh-client-ui-slots'],
            react: PEER_RANGES.react,
          },
        }
      : {}),
    devDependencies: hasClient
      ? {
          '@deepseek-ai/cordis': pin('@deepseek-ai/cordis'),
          '@deepseek-ai/dsh-client-runtime': pin('@deepseek-ai/dsh-client-runtime'),
          '@deepseek-ai/dsh-client-ui-primitives': pin('@deepseek-ai/dsh-client-ui-primitives'),
          '@deepseek-ai/dsh-client-ui-slots': pin('@deepseek-ai/dsh-client-ui-slots'),
          '@types/node': pin('@types/node'),
          '@types/react': pin('@types/react'),
          react: pin('react'),
          'react-dom': pin('react-dom'),
          tsdown: pin('tsdown'),
          tsx: pin('tsx'),
          typescript: pin('typescript'),
        }
      : {
          '@deepseek-ai/cordis': pin('@deepseek-ai/cordis'),
          '@types/node': pin('@types/node'),
          tsdown: pin('tsdown'),
          tsx: pin('tsx'),
          typescript: pin('typescript'),
        },
    packageManager: 'pnpm@10.28.0',
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

// --------------------------------------------------------------- write ----
const created = []
function write(relPath, content) {
  if (typeof content !== 'string' || !content.endsWith('\n')) {
    fail(`internal: template for ${relPath} must end with exactly one newline`)
  }
  if (content.includes('\n\n\n')) fail(`internal: template for ${relPath} has a blank-line run`)
  writeFileSync(join(pkgDir, relPath), content)
  created.push(relPath)
}

mkdirSync(join(pkgDir, 'src'), { recursive: true })
mkdirSync(join(pkgDir, 'tests'), { recursive: true })
if (opts.face !== 'host') mkdirSync(join(pkgDir, 'src/client'), { recursive: true })

write('package.json', packageJson())
write('cordis.patch.yml', cordisPatchYml())
if (opts.presetOwned) write('preset-snippet.yml', presetSnippetYml())
write('tsconfig.json', tsconfigJson())
write('tsdown.config.ts', opts.face === 'host' ? tsdownHostConfig() : tsdownClientConfig())
write('src/index.ts', hostIndexTs())
if (opts.face !== 'host') write('src/client/index.ts', clientIndexTs())
write(`tests/${rowId}.test.ts`, testTs())
write('README.md', readmeMd())

// Root .gitignore: every plugin's lib/ is ignored explicitly — append ours.
const gitignorePath = join(repoRoot, '.gitignore')
const gitignore = readFileSync(gitignorePath, 'utf8')
const ignoreLine = `plugin/${name}/lib/`
let gitignoreTouched = false
if (!gitignore.split('\n').includes(ignoreLine)) {
  const prefix = gitignore.endsWith('\n') ? '' : '\n'
  writeFileSync(gitignorePath, `${gitignore}${prefix}\n# ${name}：构建产物（scripts/new-plugin.mjs 生成）\n${ignoreLine}\n`)
  gitignoreTouched = true
}

// -------------------------------------------------------------- report ----
const today = new Date().toISOString().slice(0, 10)
console.log(`new-plugin: plugin/${name} scaffolded (face=${opts.face}, row id=${rowId}${opts.presetOwned ? ', preset-owned' : ''})`)
for (const file of created) console.log(`  created  ${file}`)
console.log(gitignoreTouched ? `  appended .gitignore <- ${ignoreLine}` : '  .gitignore already covered (unexpected — check manually)')
console.log(`
next steps:
  1. cd plugin/${name} && pnpm install && pnpm run typecheck && pnpm run build && pnpm run test
  2. fill the TODO description in package.json and README.md
  3. implement: host logic in src/index.ts${opts.face !== 'host' ? ', browser half in src/client/index.ts' : ''}
  4. decision record: docs/notes/${today}-${rowId}.md (non-trivial changes must carry one)
  5. add a roster line under "插件 monorepo 规范" in the root AGENTS.md
  6. to ship inside the .app: rerun with --ship, or set dsh.desktop.ship
     (prepare / CI / dump-config smoke follow that field; do not edit ci.yml)`)
