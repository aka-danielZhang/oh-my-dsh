/**
 * Launch the unpackaged Electron shell.
 *
 * `ELECTRON_RUN_AS_NODE` must never leak into this process: if it is set,
 * Electron runs as plain Node, `require('electron')` is the npm path string,
 * and `app` is undefined. Sidecar children that share the Electron binary
 * set the variable themselves.
 *
 * Launch as `electron .` so `app.getAppPath()` is the repo root (package.json).
 */
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundleElectronMain } from './bundle-electron-main.mjs'
import { listShippedPluginSpecs } from './shipped-plugins.mjs'

const require = createRequire(import.meta.url)
const electronBin = require('electron')
if (typeof electronBin !== 'string' || electronBin.length === 0) {
  throw new Error('the electron package did not export its binary path')
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function buildPlugin(name) {
  const dir = resolve(repoRoot, 'plugin', name)
  execFileSync(pnpm, ['--dir', dir, 'run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

function ensureDesktopPluginsBuilt() {
  for (const spec of listShippedPluginSpecs(repoRoot)) {
    const pkg = JSON.parse(readFileSync(resolve(spec.dir, 'package.json'), 'utf8'))
    if (typeof pkg.scripts?.build === 'string') buildPlugin(spec.package)
  }
}

await bundleElectronMain()
ensureDesktopPluginsBuilt()

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronBin, ['.', ...process.argv.slice(2)], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
