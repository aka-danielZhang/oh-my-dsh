/**
 * Host-only ESM build. Keep every harness import in src/ type-only so the
 * emitted bundle carries zero @deepseek-ai/* runtime imports and no
 * externals list is needed — the plugin cannot drag a second copy of cordis
 * into the process (the module-instance split that breaks unique-symbol
 * registries; see the repo's npm dependency discipline). Grow entries here
 * as src/ gains modules.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-ohmymemo',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
