import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from './tsdown.config.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    // The fork's bundled dsh-mcp-client lib imports the SDK externally; a
    // config alias (not vi.mock) is the only interception that survives the
    // externalized-CJS chain.
    alias: [
      // Tests alias the mcp-client package to a controllable stand-in: the
      // published lib is externalized CJS, whose require chain bypasses both
      // vi.mock and the vite resolver.
      { find: /^@deepseek-ai\/dsh-mcp-client$/, replacement: fileURLToPath(new URL('./tests/mcp-client-fake.ts', import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL('./node_modules/react/index.js', import.meta.url)) },
      { find: 'react/jsx-runtime', replacement: fileURLToPath(new URL('./node_modules/react/jsx-runtime.js', import.meta.url)) },
      { find: 'react/jsx-dev-runtime', replacement: fileURLToPath(new URL('./node_modules/react/jsx-dev-runtime.js', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    server: { deps: { inline: [/@deepseek-ai\//, /@crazx\//] } },
    include: ['tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
  },
})
