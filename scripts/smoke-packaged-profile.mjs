/**
 * Packaged-path smoke: extract the same tarballs the .app ships, link
 * runtime deps the way the shell does, import every host lib entry
 * (the path that died on missing zod / deleted settingsNamespace),
 * `plugin add` them into a fresh home, then `--dump-config` against
 * the pinned assembled runtime.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { pnpm } from './cli-bins.mjs'
import { linkPluginRuntimeDeps, listShippedPluginSpecs } from './shipped-plugins.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(cmd, args, opts = {}) {
  const shell = opts.shell ?? (process.platform === 'win32' && /\.cmd$/i.test(String(cmd)))
  execFileSync(cmd, args, { stdio: 'inherit', ...opts, shell })
}

function tarSupportsForceLocal() {
  try {
    return execFileSync('tar', ['--help'], { encoding: 'utf8' }).includes('--force-local')
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`
    return text.includes('--force-local')
  }
}

function tarCreate(archive, changeDir, entries) {
  const args = []
  if (tarSupportsForceLocal()) args.push('--force-local')
  args.push('--exclude', '.DS_Store', '-czf', archive, '-C', changeDir, ...entries)
  run('tar', args, { cwd: repoRoot })
}

function tarExtract(archive, dest) {
  mkdirSync(dest, { recursive: true })
  const args = []
  if (tarSupportsForceLocal()) args.push('--force-local')
  args.push('-xzf', archive, '-C', dest)
  run('tar', args)
}

function importHostLib(dest, node, packageName) {
  const lib = join(dest, 'lib')
  if (!existsSync(lib)) {
    throw new Error(`smoke-packaged-profile: ${packageName} tarball has no lib/`)
  }
  const files = readdirSync(lib).filter((name) => name.endsWith('.js') && name !== 'client.js').sort()
  if (files.length === 0) {
    throw new Error(`smoke-packaged-profile: ${packageName} lib/ has no host entry`)
  }
  for (const file of files) {
    const href = pathToFileURL(join(lib, file)).href
    console.log(`smoke-packaged-profile: import ${packageName}/${file}`)
    run(node, ['--input-type=module', '-e', `await import(${JSON.stringify(href)})`], { cwd: dest })
  }
}

function findNode(runtimeDir) {
  for (const rel of [
    'tools/node_modules/node/bin/node',
    'tools/node_modules/node/bin/node.exe',
    'tools/node_modules/.pnpm/node@24.9.0/node_modules/node/bin/node',
  ]) {
    const candidate = join(runtimeDir, rel)
    if (existsSync(candidate)) return candidate
  }
  return process.execPath
}

function main() {
  const revision = JSON.parse(readFileSync(join(repoRoot, 'runtime/revision.json'), 'utf8'))
  const runtimeDir = join(repoRoot, 'runtime/build', revision.sha)
  const cli = join(runtimeDir, 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
  if (!existsSync(cli)) {
    throw new Error(`smoke-packaged-profile: assemble the runtime first (missing ${cli})`)
  }
  const specs = listShippedPluginSpecs(repoRoot)
  const work = mkdtempSync(join(tmpdir(), 'dsh-packaged-smoke-'))
  const tarballDir = join(work, 'tarballs')
  const extractDir = join(work, 'extract')
  const home = join(work, 'home')
  mkdirSync(tarballDir)
  mkdirSync(extractDir)
  mkdirSync(join(home, 'profiles/web'), { recursive: true })
  try {
    for (const spec of specs) {
      if (!existsSync(join(spec.dir, 'lib/index.js'))) {
        console.log(`smoke-packaged-profile: build ${spec.package}`)
        run(pnpm, ['run', '--if-present', 'build'], { cwd: spec.dir })
      }
      const tar = join(tarballDir, spec.tarball)
      tarCreate(tar, spec.dir, spec.packEntries)
      const dest = join(extractDir, spec.package)
      tarExtract(tar, dest)
      if (!existsSync(join(dest, 'package.json'))) {
        throw new Error(`smoke-packaged-profile: ${spec.tarball} extracted without package.json`)
      }
      linkPluginRuntimeDeps(dest, join(runtimeDir, 'dsh'))
      importHostLib(dest, findNode(runtimeDir), spec.package)
    }
    const node = findNode(runtimeDir)
    const profile = join(home, 'profiles/web')
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
    writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
    const env = { ...process.env, DSH_HOME: home, CI: 'true' }
    const cwd = join(runtimeDir, 'dsh')
    for (const spec of specs) {
      const dest = join(extractDir, spec.package)
      console.log(`smoke-packaged-profile: plugin add ${spec.package}`)
      run(node, ['--import', 'tsx/esm', cli, 'plugin', '--profile', 'web', 'add', dest], { cwd, env })
    }
    const profilePkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    const bundles = profilePkg.dsh?.profile?.bundles ?? []
    for (const spec of specs) {
      if (!bundles.includes(spec.package)) {
        throw new Error(`smoke-packaged-profile: plugin add did not record ${spec.package} in dsh.profile.bundles`)
      }
    }
    console.log('smoke-packaged-profile: dump-config')
    const dump = execFileSync(node, ['--import', 'tsx/esm', cli, '--profile', 'web', '--dump-config'], {
      cwd,
      env,
      encoding: 'utf8',
    })
    for (const spec of specs) {
      const patch = join(extractDir, spec.package, 'cordis.patch.yml')
      const inserts = existsSync(patch) && /\bname:\s/.test(readFileSync(patch, 'utf8'))
      if (inserts && !dump.includes(spec.package)) {
        throw new Error(`smoke-packaged-profile: dump-config omitted ${spec.package}`)
      }
    }
    console.log(`smoke-packaged-profile: ok (${String(specs.length)} shipped plugins against ${revision.ref})`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main()
