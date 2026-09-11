/**
 * Build the dynamic-plugin PREVIEW bodies for cordis_define (temporary dev
 * tool, not part of the shipped plugin):
 *
 *   node scripts/build-dynamic-preview.mjs
 *   → .preview/host-body.js    plain-JS Host half (fold + fs reads + RPC)
 *   → .preview/client-body.js  plain-JS Client half (real section UI bundle)
 *
 * The client bundle compiles the REAL redesigned sources (UsageStatsSection,
 * charts, chart-data, format, locales) with the primitives swapped for the
 * preview stand-ins, React mapped onto the evaluator's global, and the CSS
 * module compiled with the production `[hash]_[local]` pattern.
 */

import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const outDir = join(pkgRoot, '.preview')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// ── Client bundle ─────────────────────────────────────────────────────────

const stubDir = join(outDir, 'stubs')
mkdirSync(stubDir, { recursive: true })
const reactStub = join(stubDir, 'react-stub.cjs')
writeFileSync(reactStub, 'module.exports = globalThis.React\n')
const jsxStub = join(stubDir, 'jsx-stub.js')
writeFileSync(jsxStub, `var React = globalThis.React
function shim(type, props, key) {
  var rest = {}
  var children
  if (props !== null && props !== undefined) {
    for (var k in props) {
      if (k === 'children') { children = props[k]; continue }
      rest[k] = props[k]
    }
  }
  if (key !== undefined) rest.key = key
  return React.createElement(type, rest, children)
}
export var jsx = shim
export var jsxs = shim
export var jsxDEV = shim
export var Fragment = React.Fragment
`)

const cssFiles = []
const virtualCss = { css: '' }
const cssPlugin = {
  name: 'preview-css-modules',
  setup(build) {
    build.onResolve({ filter: /^__preview-css__$/ }, () => ({ path: 'preview-css', namespace: 'preview-css' }))
    build.onLoad({ filter: /.*/, namespace: 'preview-css' }, () => ({
      // A template literal with REAL newlines: the generated body must stay
      // readable in chunks (no single 7KB line).
      contents: 'export default `' + virtualCss.css.replaceAll('`', '\\`').replaceAll('${', '\\${') + '`',
      loader: 'js',
    }))
    build.onLoad({ filter: /\.module\.css$/ }, (args) => {
      const source = readFileSync(args.path)
      const { code, exports: cssExports } = transform({
        filename: args.path,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        // Unminified: the CSS template literal must keep its newlines so the
        // generated body stays readable in chunks.
        minify: false,
      })
      const classMap = {}
      for (const [local, value] of Object.entries(cssExports ?? {})) classMap[local] = value.name
      cssFiles.push(code.toString())
      return { contents: `export default ${JSON.stringify(classMap)};`, loader: 'js' }
    })
  },
}

// Pass 1 collects the compiled CSS blocks; pass 2 bakes them in (esbuild
// snapshots `define` before onLoad runs, so the text must exist first).
function buildClient(_unused) {
  return build({
    entryPoints: [join(pkgRoot, 'scripts/preview-client-entry.tsx')],
    bundle: true,
    format: 'iife',
    globalName: 'ustatPreview',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    alias: {
      'react': reactStub,
      'react/jsx-runtime': jsxStub,
      'react/jsx-dev-runtime': jsxStub,
      '@deepseek-ai/dsh-client-ui-primitives': join(pkgRoot, 'scripts/preview-primitives.tsx'),
    },
    plugins: [cssPlugin],
    write: false,
    logLevel: 'warning',
  })
}

await buildClient('')
virtualCss.css = cssFiles.join('\n')
cssFiles.length = 0
const clientResult = await buildClient('')
const clientCode = clientResult.outputFiles[0].text
const clientBody = `${clientCode}
return { apply(ctx) { return ustatPreview.install(ctx) } }
`
writeFileSync(join(outDir, 'client-body.js'), clientBody)
copyFileSync(join(here, 'preview-host-body.js'), join(outDir, 'host-body.js'))
console.log(`client-body.js: ${(clientBody.length / 1024).toFixed(1)} KB, css blocks: ${cssFiles.length}`)
