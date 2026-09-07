/**
 * Typecheck, test, and build every dsh.desktop.ship plugin.
 * CI calls this instead of a hardcoded per-plugin job list.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pnpm } from './cli-bins.mjs'
import { listShippedPluginSpecs } from './shipped-plugins.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(args, cwd, env = process.env) {
  execFileSync(pnpm, args, { cwd, stdio: 'inherit', env, shell: process.platform === 'win32' })
}

const specs = listShippedPluginSpecs(repoRoot)
for (const spec of specs) {
  console.log(`check-shipped-plugins: ${spec.package}`)
  run(['install', spec.package === 'dsh-desktop-bridge' ? '--no-frozen-lockfile' : '--frozen-lockfile'], spec.dir)
  if (spec.package === 'dsh-desktop-bridge') {
    const checkout = process.env.DSH_CHECKOUT
    if (!checkout) throw new Error('check-shipped-plugins: DSH_CHECKOUT is required for the bridge')
    run(['run', 'setup'], spec.dir, { ...process.env, DSH_CHECKOUT: checkout })
  }
  for (const script of ['typecheck', 'test', 'build']) {
    run(['run', '--if-present', script], spec.dir)
  }
}
console.log(`check-shipped-plugins: ok (${String(specs.length)} plugins)`)
