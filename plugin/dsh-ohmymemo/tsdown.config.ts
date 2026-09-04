import { defineConfig } from 'tsdown'

const PACKAGE_ID = 'dsh-ohmymemo'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

function purityGate(): import('tsdown').UserConfig['plugins'][number] {
  return {
    name: 'dsh-ohmymemo-client-purity',
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
    entry: ['src/index.ts', 'src/tools.ts', 'src/context.ts', 'src/manager.ts', 'src/api.ts'],
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
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      onlyBundle: false,
      neverBundle: (id: string) => (CLIENT_EXTERNALS as readonly string[]).includes(id),
      alwaysBundle: (id: string) => !(CLIENT_EXTERNALS as readonly string[]).includes(id),
    },
    plugins: [purityGate()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "${PACKAGE_ID}", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
