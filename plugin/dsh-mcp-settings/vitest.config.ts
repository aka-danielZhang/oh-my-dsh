import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from './tsdown.config.ts'

export default defineConfig({
  plugins: [standardDecoratorPlugin()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: fileURLToPath(new URL('./node_modules/react/index.js', import.meta.url)) },
      { find: 'react/jsx-runtime', replacement: fileURLToPath(new URL('./node_modules/react/jsx-runtime.js', import.meta.url)) },
      { find: 'react/jsx-dev-runtime', replacement: fileURLToPath(new URL('./node_modules/react/jsx-dev-runtime.js', import.meta.url)) },
      { find: '@modelcontextprotocol/sdk/client/index.js', replacement: fileURLToPath(new URL('./node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js', import.meta.url)) },
      { find: '@modelcontextprotocol/sdk/client/stdio.js', replacement: fileURLToPath(new URL('./node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js', import.meta.url)) },
      { find: '@modelcontextprotocol/sdk/client/streamableHttp.js', replacement: fileURLToPath(new URL('./node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    server: { deps: { inline: [/@deepseek-ai\//, /@crazx\//] } },
    include: ['tests/**/*.spec.{ts,tsx}'],
    pool: 'forks',
  },
})
