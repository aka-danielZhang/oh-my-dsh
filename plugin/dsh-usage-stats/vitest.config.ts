import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Registry @deepseek-ai/* packages ship compiled JS + adjacent
    // .module.css; inlining them runs those through Vite's CSS-module
    // pipeline so component specs see real class maps (the source of the
    // P0 “raw class names never matched hashed selectors” failure). One
    // React instance across the tree.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    // Package-level node:test suites still run through `node --test`;
    // Vitest owns only the jsdom specs here (each carries its own
    // `// @vitest-environment jsdom` docblock).
    include: ['tests/**/*.spec.tsx'],
    testTimeout: 15_000,
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})
