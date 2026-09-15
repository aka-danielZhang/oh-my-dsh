import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // The package's `dsh` debug anchor links the Harness checkout, whose own
    // node_modules would otherwise resolve a second React instance.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    // Package-level node:test suites still run through `node --test`; Vitest
    // owns only the jsdom component specs in this package.
    include: ['tests/**/*.spec.tsx'],
    testTimeout: 10_000,
    // Registry `@deepseek-ai/dsh-client-ui-primitives` ships `.module.css`
    // next to compiled JS. Vite does not transform node_modules CSS unless
    // the package is inlined — source `link:` hid this because the checkout
    // files went through the Vite pipeline.
    server: {
      deps: {
        inline: [/@(deepseek-ai|crazx)\/dsh-client-ui-primitives/],
      },
    },
  },
})
