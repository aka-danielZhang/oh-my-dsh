/**
 * Build config for dsh-usage-stats, distilled from the harness's
 * packages/client/tsdown.client.ts contract (same shape as
 * dsh-web-search-toggle):
 *
 * - Node half (lib/*.js): plain ESM libs, one entry per plugin row plus the
 *   shared wire/typert modules, with standard decorators pre-transpiled for
 *   Rolldown. zod rides inside the host libs (deps.onlyBundle): git installs
 *   and assembled runtimes have no devDependencies materialized, and the
 *   typert registry duck-types codecs (parse()) rather than checking zod
 *   instance identity.
 * - Browser half (lib/client.js): the closure-factory artifact the client
 *   module system expects — window.__ModuleLoader__.load({id, factory})
 *   with platform modules externalized to the loader's module table.
 */

import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const PACKAGE_ID = 'dsh-usage-stats'
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  // Documented runtime exemption (preloaded by the parser before the shell
  // starts) — the table answers it natively.
] as const
const DECORATOR_SYNTAX = /^\s*@[A-Za-z_$][\w$]*/m

/** Compile standard TypeScript decorators before Rolldown parses Host modules. */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !DECORATOR_SYNTAX.test(code)) return null
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig([
  {
    name: PACKAGE_ID,
    entry: {
      index: 'src/index.ts',
      collector: 'src/collector.ts',
      gateway: 'src/gateway.ts',
      types: 'src/types.ts',
      fold: 'src/fold.ts',
      'typert.remote-client': 'src/typert.remote-client.ts',
      'typert.host': 'src/typert.host.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    // zod rides inside the host libs (see header): the typert registry
    // validates codecs by shape, and consumers have no node_modules.
    deps: {
      onlyBundle: ['zod'],
    },
    plugins: [standardDecoratorPlugin()],
  },
  {
    name: `${PACKAGE_ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: CLIENT_EXTERNALS as unknown as string[],
      alwaysBundle: (id: string) => ((CLIENT_EXTERNALS as readonly string[]).includes(id) ? undefined : true),
      onlyBundle: ['zod'],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: "${PACKAGE_ID}", factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    plugins: [{
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const absolute = importer === undefined ? source : resolve(dirname(importer), source)
        return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
        const tagId = `${PACKAGE_ID}/${basename(fileId)}`
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
          "  const tag = document.createElement('style');",
          `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classMap)};`,
        ].join('\n')
      },
    }],
  },
])
