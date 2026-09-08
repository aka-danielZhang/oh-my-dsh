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
