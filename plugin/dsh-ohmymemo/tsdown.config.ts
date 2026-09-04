/**
 * Host-only ESM build. Three entries mirror the three cordis rows:
 *
 * - `src/index.ts` → `lib/index.js` (row `ohmymemo-store`): the Markdown
 *   store plus the `ctx.ohMyMemo` service. Keeps zero runtime imports of
 *   harness packages.
 * - `src/tools.ts` → `lib/tools.js` (row `ohmymemo-tools`): the five
 *   `memory_*` tools. Runtime-imports `@deepseek-ai/dsh-tools`
 *   (`defineTool`), declared as a peerDependency so the profile tree binds
 *   the runtime's own copy (the module-identity split lesson; see the
 *   dsh-thread precedent).
 * - `src/context.ts` → `lib/context.js` (row `ohmymemo-context`): the
 *   pre-step capsule injector. Only type-only harness imports.
 */

import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'dsh-ohmymemo',
  entry: ['src/index.ts', 'src/tools.ts', 'src/context.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
