/**
 * Build config for dsh-scheduled-tasks (dsh-ohmymemo's dual shape):
 *
 * - Node half: one ESM file per composition row (core service / ohmymemo
 *   adapter / typert registration) plus the shared contract, schedule,
 *   lease, and launch modules. `zod` is bundled — the assembled desktop
 *   runtime carries no node_modules and the storage-domain + typert strict
 *   path duck-type `parse()`.
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
    name: 'dsh-scheduled-tasks',
    entry: [
      'src/index.ts',
      'src/ohmymemo.ts',
      'src/api.ts',
      'src/contract.ts',
      'src/types.ts',
      'src/schedule.ts',
      'src/lease.ts',
      'src/typert.remote-client.ts',
      'src/typert.host.ts',
    ],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      onlyBundle: ['zod'],
    },
    outputOptions: {
      chunkFileNames: '[name].js',
    },
  },
  {
    name: 'dsh-scheduled-tasks/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      onlyBundle: ['zod'],
      neverBundle: (id: string) => (CLIENT_EXTERNALS as readonly string[]).includes(id),
      alwaysBundle: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
    },
    plugins: [purityGate()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-scheduled-tasks", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
