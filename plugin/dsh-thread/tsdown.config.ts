import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-thread'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

function purityGate(): import('tsdown').UserConfig['plugins'][number] {
  return {
    name: 'dsh-thread-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if ((CLIENT_EXTERNALS as readonly string[]).includes(source)) return null
      throw new Error(`client bundle purity: ${source} is not a platform module`)
    },
  }
}

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: ['src/index.ts', 'src/gateway.ts', 'src/tool.ts', 'src/draft.ts', 'src/identity.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // zod rides inside the host libs: consumers (git installs, assembled
    // runtimes, and the desktop tarball extraction — no node_modules, only
    // the THREAD_RUNTIME_PEERS symlinks) cannot resolve a bare zod import,
    // and the typert registry duck-types codecs (parse()) rather than
    // checking zod instance identity — a bundled copy validates fine.
    deps: {
      onlyBundle: ['zod'],
    },
    outputOptions: {
      chunkFileNames: '[name].js',
    },
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
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
      banner: `window.__ModuleLoader__.load({ id: "${PACKAGE_ID}", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
