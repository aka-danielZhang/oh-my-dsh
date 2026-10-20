import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { runDesktopPluginInstall } from './install.ts'
import type { Runtime } from './runtime.ts'

const SUCCESS_CLI = `
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const profileFlag = args.indexOf('--profile')
if (profileFlag < 0 || args[profileFlag + 1] === undefined) process.exit(64)
const profileName = args[profileFlag + 1]
const profile = path.join(process.env.DSH_HOME, 'profiles', profileName)

if (args[0] === 'plugin') {
  const command = args[profileFlag + 2]
  if (command === 'install') {
    const dirty = path.join(profile, '.test-stale-lock')
    if (args.includes('--no-frozen-lockfile')) {
      fs.rmSync(dirty, { force: true })
      fs.appendFileSync(path.join(profile, '.test-install-phases'), 'resolve\\n')
    } else {
      if (fs.existsSync(dirty)) process.exit(65)
      fs.appendFileSync(path.join(profile, '.test-install-phases'), 'frozen\\n')
    }
    process.exit(0)
  }
  if (command !== 'add') process.exit(64)
  const pluginDir = args[profileFlag + 3]
  if (pluginDir === undefined) process.exit(64)
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  const manifestPath = path.join(profile, 'package.json')
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { name: 'dsh-profile-' + profileName, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }
  manifest.dependencies ??= {}
  manifest.dependencies[pluginManifest.name] = 'link:' + pluginDir
  manifest.dsh ??= { profile: { bundles: [] } }
  manifest.dsh.profile ??= { bundles: [] }
  manifest.dsh.profile.bundles ??= []
  if (!manifest.dsh.profile.bundles.includes(pluginManifest.name)) {
    manifest.dsh.profile.bundles.push(pluginManifest.name)
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')
  fs.writeFileSync(path.join(profile, '.test-stale-lock'), 'directory add did not update the lockfile')
  const link = path.join(profile, 'node_modules', pluginManifest.name)
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(pluginDir, link, 'junction')
  process.exit(0)
}

if (args.includes('--dump-config')) process.exit(0)
process.exit(64)
`

function createFixture(name: string, cliSource: string): {
  root: string
  home: string
  logs: string
  plugin: string
  runtime: Runtime
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-desktop-install-${name}-`))
  const home = path.join(root, 'home')
  const logs = path.join(root, 'shell')
  const plugin = path.join(root, 'plugin')
  const cli = path.join(root, 'fake-dsh.mjs')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(
    path.join(plugin, 'package.json'),
    '{"name":"dsh-test-plugin","dsh":{"bundle":"cordis.patch.yml"}}\n',
  )
  fs.writeFileSync(path.join(plugin, 'cordis.patch.yml'), '[]\n')
  fs.writeFileSync(cli, cliSource)
  return {
    root,
    home,
    logs,
    plugin,
    runtime: {
      node: process.execPath,
      argsPrefix: [],
      cli,
      cwd: root,
      pathPrepend: [],
      oneNode: process.versions.electron !== undefined,
    },
  }
}

function repairArtifacts(root: string, home: string): string[] {
  const prefix = `.${path.basename(home)}-desktop-profile-repair-`
  return fs.readdirSync(root).filter((entry) => entry.startsWith(prefix))
}

test('installs desktop packages into a completely missing profile', () => {
  const fixture = createFixture('fresh', SUCCESS_CLI)
  try {
    assert.ok(!fs.existsSync(fixture.home))
    runDesktopPluginInstall(
      fixture.runtime,
      [{ package: 'dsh-test-plugin', dir: fixture.plugin }],
      fixture.home,
      fixture.logs,
      'web',
      'missing',
    )

    const profile = path.join(fixture.home, 'profiles', 'web')
    assert.ok(fs.statSync(path.join(profile, 'package.json')).isFile())
    assert.equal(fs.readFileSync(path.join(profile, '.test-install-phases'), 'utf8'), 'resolve\nfrozen\n')
    assert.match(fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8'), /\[\]/)
    assert.match(fs.readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8'), /nodeLinker: hoisted/)
    assert.equal(
      fs.realpathSync.native(path.join(profile, 'node_modules', 'dsh-test-plugin')),
      fs.realpathSync.native(fixture.plugin),
    )
    assert.ok(!fs.existsSync(path.join(fixture.home, '.desktop-profile-repair.json')))
    assert.ok(!fs.existsSync(path.join(fixture.logs, 'retired-plugins.json')))
    assert.deepEqual(repairArtifacts(fixture.root, fixture.home), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('missing profile install preserves existing home data and root patch', () => {
  const fixture = createFixture('existing-home', SUCCESS_CLI)
  try {
    const homePatch = Buffer.from('- id: home-layer\n')
    const settings = Buffer.from('{"theme":"system"}\n')
    const session = Buffer.from('{"type":"session-created"}\n')
    fs.mkdirSync(path.join(fixture.home, 'settings'), { recursive: true })
    fs.mkdirSync(path.join(fixture.home, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(fixture.home, 'cordis.patch.yml'), homePatch)
    fs.writeFileSync(path.join(fixture.home, 'settings', 'settings.json'), settings)
    fs.writeFileSync(path.join(fixture.home, 'sessions', 'existing.jsonl'), session)

    runDesktopPluginInstall(
      fixture.runtime,
      [{ package: 'dsh-test-plugin', dir: fixture.plugin }],
      fixture.home,
      fixture.logs,
      'web',
      'missing',
    )

    assert.ok(fs.statSync(path.join(fixture.home, 'profiles', 'web', 'package.json')).isFile())
    assert.deepEqual(fs.readFileSync(path.join(fixture.home, 'cordis.patch.yml')), homePatch)
    assert.deepEqual(fs.readFileSync(path.join(fixture.home, 'settings', 'settings.json')), settings)
    assert.deepEqual(fs.readFileSync(path.join(fixture.home, 'sessions', 'existing.jsonl')), session)
    assert.deepEqual(repairArtifacts(fixture.root, fixture.home), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

const RETIRE_CLI = `
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const profileFlag = args.indexOf('--profile')
if (profileFlag < 0 || args[profileFlag + 1] === undefined) process.exit(64)
const profileName = args[profileFlag + 1]
const profile = path.join(process.env.DSH_HOME, 'profiles', profileName)
const manifestPath = path.join(profile, 'package.json')
const phases = path.join(profile, '.test-phases')
const readManifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const writeManifest = (manifest) => fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n')

if (args[0] === 'plugin') {
  const command = args[profileFlag + 2]
  if (command === 'install') {
    const phase = args.includes('--frozen-lockfile')
      ? 'install-frozen'
      : args.includes('--no-frozen-lockfile') ? 'install-no-frozen' : 'install'
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
    // pnpm re-links local dependencies from the manifest; the shadow copy has
    // no node_modules, so preserved link installs must come back here.
    for (const [name, spec] of Object.entries(readManifest().dependencies ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const link = path.join(profile, 'node_modules', name)
      fs.rmSync(link, { recursive: true, force: true })
      fs.symlinkSync(spec.slice('link:'.length), link, 'junction')
    }
    fs.appendFileSync(phases, phase + '\\n')
    process.exit(0)
  }
  if (command === 'add') {
    const pluginDir = args[profileFlag + 3]
    const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'))
    const manifest = readManifest()
    manifest.dependencies ??= {}
    manifest.dependencies[pluginManifest.name] = 'link:' + pluginDir
    manifest.dsh ??= { profile: { bundles: [] } }
    manifest.dsh.profile ??= { bundles: [] }
    manifest.dsh.profile.bundles ??= []
    if (!manifest.dsh.profile.bundles.includes(pluginManifest.name)) {
      manifest.dsh.profile.bundles.push(pluginManifest.name)
    }
    writeManifest(manifest)
    fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
    const link = path.join(profile, 'node_modules', pluginManifest.name)
    fs.rmSync(link, { recursive: true, force: true })
    fs.symlinkSync(pluginDir, link, 'junction')
    fs.appendFileSync(phases, 'add:' + pluginManifest.name + '\\n')
    process.exit(0)
  }
  process.exit(64)
}

if (args.includes('--dump-config')) process.exit(0)
process.exit(64)
`

const RETIRED = 'dsh-scheduled-tasks'

interface RetireFixture {
  root: string
  home: string
  logs: string
  plugin: string
  runtime: Runtime
  profile: string
  extracted: string
}

/**
 * Home whose web profile carries the retired package exactly like an installed
 * 0.4.0-rc.2 does: a dependency pinned to the extracted copy, its node_modules
 * link, and the `dsh.profile.bundles` entry.
 */
function createRetireFixture(): RetireFixture {
  const fixture = createFixture('retire', RETIRE_CLI)
  const profile = path.join(fixture.home, 'profiles', 'web')
  const extracted = path.join(fixture.logs, 'plugins', RETIRED)
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  fs.mkdirSync(extracted, { recursive: true })
  fs.writeFileSync(path.join(extracted, 'package.json'), `{"name":"${RETIRED}"}\n`)
  fs.writeFileSync(path.join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  wireDesktopCopy(profile, extracted)
  return { ...fixture, profile, extracted }
}

/** Write what `dsh plugin add <extracted dir>` leaves in a profile. */
function wireDesktopCopy(profile: string, extracted: string): void {
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-web',
        private: true,
        dependencies: { [RETIRED]: `link:${extracted}` },
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', RETIRED] } },
      },
      undefined,
      2,
    ) + '\n',
  )
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  const link = path.join(profile, 'node_modules', RETIRED)
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(extracted, link, 'junction')
}

function readManifest(profile: string): {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
} {
  return JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'))
}

function readPhases(profile: string): string[] {
  const file = path.join(profile, '.test-phases')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
}

function pluginsFor(fixture: RetireFixture): Array<{ package: string; dir: string }> {
  return [{ package: 'dsh-test-plugin', dir: fixture.plugin }]
}

test('retires the desktop-owned copy from an existing profile in one transaction', () => {
  const fixture = createRetireFixture()
  try {
    runDesktopPluginInstall(fixture.runtime, pluginsFor(fixture), fixture.home, fixture.logs, 'web', 'unchecked')

    const manifest = readManifest(fixture.profile)
    assert.deepEqual(Object.keys(manifest.dependencies), ['dsh-test-plugin'])
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-test-plugin'])
    assert.ok(!fs.existsSync(path.join(fixture.profile, 'node_modules', RETIRED)))
    assert.ok(!fs.existsSync(fixture.extracted))
    assert.deepEqual(readPhases(fixture.profile), [
      'install',
      'add:dsh-test-plugin',
      'install-no-frozen',
      'install-frozen',
    ])
    assert.ok(!fs.existsSync(path.join(fixture.home, '.desktop-profile-repair.json')))
    assert.deepEqual(repairArtifacts(fixture.root, fixture.home), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('an older release that still ships the plugin cannot resurrect it', () => {
  const fixture = createRetireFixture()
  try {
    runDesktopPluginInstall(fixture.runtime, pluginsFor(fixture), fixture.home, fixture.logs, 'web', 'unchecked')
    // 0.4.0-rc.2 boots: it re-extracts its shipped copy and adds it back.
    fs.mkdirSync(fixture.extracted, { recursive: true })
    fs.writeFileSync(path.join(fixture.extracted, 'package.json'), `{"name":"${RETIRED}"}\n`)
    wireDesktopCopy(fixture.profile, fixture.extracted)

    runDesktopPluginInstall(fixture.runtime, pluginsFor(fixture), fixture.home, fixture.logs, 'web', 'unchecked')

    const manifest = readManifest(fixture.profile)
    assert.deepEqual(manifest.dependencies, { 'dsh-test-plugin': `link:${fixture.plugin}` })
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-test-plugin'])
    assert.ok(!fs.existsSync(fixture.extracted))
    assert.ok(!fs.existsSync(path.join(fixture.profile, 'node_modules', RETIRED)))
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a registry install of the retired package is not a retirement candidate', () => {
  const fixture = createRetireFixture()
  try {
    // Replace the desktop copy with a registry-style install in node_modules.
    const manifest = readManifest(fixture.profile)
    fs.writeFileSync(
      path.join(fixture.profile, 'package.json'),
      JSON.stringify({ ...manifest, dependencies: { [RETIRED]: '^0.1.4' } }, undefined, 2) + '\n',
    )
    const link = path.join(fixture.profile, 'node_modules', RETIRED)
    fs.rmSync(link, { recursive: true, force: true })
    fs.mkdirSync(link, { recursive: true })
    fs.writeFileSync(path.join(link, 'package.json'), `{"name":"${RETIRED}","version":"0.1.4"}\n`)
    fs.rmSync(fixture.extracted, { recursive: true, force: true })

    runDesktopPluginInstall(fixture.runtime, [], fixture.home, fixture.logs, 'web', 'unchecked')

    const after = readManifest(fixture.profile)
    assert.equal(after.dependencies[RETIRED], '^0.1.4')
    assert.ok(fs.existsSync(path.join(link, 'package.json')))
    assert.deepEqual(readPhases(fixture.profile), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a link install outside the shell root survives the sweep transaction', () => {
  const fixture = createRetireFixture()
  try {
    // A person's own checkout, linked from the profile instead of the copy.
    const userCopy = path.join(fixture.root, 'user-scheduled-tasks')
    fs.mkdirSync(userCopy, { recursive: true })
    fs.writeFileSync(path.join(userCopy, 'package.json'), `{"name":"${RETIRED}","version":"0.1.4"}\n`)
    const manifest = readManifest(fixture.profile)
    manifest.dependencies[RETIRED] = `link:${userCopy}`
    manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base']
    fs.writeFileSync(path.join(fixture.profile, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
    const link = path.join(fixture.profile, 'node_modules', RETIRED)
    fs.rmSync(link, { recursive: true, force: true })
    fs.symlinkSync(userCopy, link, 'junction')

    runDesktopPluginInstall(fixture.runtime, pluginsFor(fixture), fixture.home, fixture.logs, 'web', 'unchecked')

    const after = readManifest(fixture.profile)
    assert.equal(after.dependencies[RETIRED], `link:${userCopy}`)
    assert.ok(Object.hasOwn(after.dependencies, 'dsh-test-plugin'))
    assert.ok(!after.dsh.profile.bundles.includes(RETIRED))
    assert.equal(
      fs.realpathSync.native(path.join(fixture.profile, 'node_modules', RETIRED)),
      fs.realpathSync.native(userCopy),
    )
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a stale desktop link and bundle entry are cleaned without a dependency', () => {
  const fixture = createRetireFixture()
  try {
    const manifest = readManifest(fixture.profile)
    delete manifest.dependencies[RETIRED]
    fs.writeFileSync(path.join(fixture.profile, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')

    runDesktopPluginInstall(fixture.runtime, [], fixture.home, fixture.logs, 'web', 'unchecked')

    const after = readManifest(fixture.profile)
    assert.deepEqual(after.dependencies, {})
    assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
    assert.ok(!fs.existsSync(path.join(fixture.profile, 'node_modules', RETIRED)))
    assert.ok(!fs.existsSync(fixture.extracted))
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('a dangling desktop link is cleaned even when the copy is already gone', () => {
  const fixture = createRetireFixture()
  try {
    fs.rmSync(fixture.extracted, { recursive: true, force: true })
    fs.rmSync(path.join(fixture.profile, 'node_modules', RETIRED), { recursive: true, force: true })

    runDesktopPluginInstall(fixture.runtime, [], fixture.home, fixture.logs, 'web', 'unchecked')

    const after = readManifest(fixture.profile)
    assert.deepEqual(after.dependencies, {})
    assert.deepEqual(after.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('failed fresh install removes staging and leaves the real profile absent', () => {
  const fixture = createFixture('rollback', 'process.exit(23)\n')
  try {
    assert.throws(
      () => runDesktopPluginInstall(
        fixture.runtime,
        [{ package: 'dsh-test-plugin', dir: fixture.plugin }],
        fixture.home,
        fixture.logs,
        'web',
        'missing',
      ),
      /failed with 23/,
    )
    assert.ok(!fs.existsSync(path.join(fixture.home, 'profiles', 'web')))
    assert.ok(!fs.existsSync(path.join(fixture.home, '.desktop-profile-repair.json')))
    assert.deepEqual(repairArtifacts(fixture.root, fixture.home), [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})
