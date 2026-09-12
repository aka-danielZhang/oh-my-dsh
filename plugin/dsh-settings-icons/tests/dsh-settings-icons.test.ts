/**
 * dsh-settings-icons tests: the row projection, the DOM painter (placement,
 * repaint after a React swap, fail-invisible behaviour, exact undo) and the
 * apply wiring against a fake slot ledger.
 *
 * The engine is deliberately framework-free, so it runs against jsdom with the
 * only two globals it touches (`document`, `MutationObserver`) installed per
 * test.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { apply as hostApply } from '../src/index.ts'
import { apply as clientApply, inject } from '../src/client/index.ts'
import { NAV_ICON_TARGETS } from '../src/client/icons.ts'
import { projectRows, startInjection } from '../src/client/inject.ts'
import type { NavRow } from '../src/client/inject.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Every painted glyph must carry a data-URI mask, never a re-hosted icon font. */
const MASK_PREFIX = 'mask-image:url("data:image/svg+xml,'

/** The three sections as their owning plugins register them. */
const ROWS: readonly NavRow[] = [
  { id: 'usage-stats', label: '使用统计' },
  { id: 'mcp', label: 'MCP 服务器' },
  { id: 'memory', label: '记忆' },
]

/**
 * Install a document whose globals the engine can use.
 * @returns the fresh, empty document.
 */
function installDom(): Document {
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  Object.defineProperty(globalThis, 'MutationObserver', {
    value: dom.window.MutationObserver,
    configurable: true,
  })
  return dom.window.document
}

/**
 * Append a settings modal shaped like the stock shell's nav rail.
 * @param document - target document.
 * @param labels - nav row labels, in render order.
 */
function mount(document: Document, labels: readonly string[]): void {
  const cells = labels.map(label =>
    '<button type="button"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1h2"/></svg>'
    + '<span>' + label + '</span></button>').join('')
  document.body.insertAdjacentHTML('beforeend',
    '<div role="dialog" aria-modal="true"><nav><div class="navTitle">设置</div>'
    + '<div class="navList">' + cells + '</div></nav></div>')
}

/**
 * Start the engine against a static row table.
 * @param rows - the rows the fake ledger reports.
 * @returns the disposer (rescans ride the observer microtask directly).
 */
function harness(rows: readonly NavRow[]): { stop: () => void } {
  return { stop: startInjection({ rows: () => rows }, NAV_ICON_TARGETS) }
}

/** Let jsdom deliver its queued MutationObserver records. */
async function tick(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * Read the painted markers in document order.
 * @param document - target document.
 * @returns each painted element's target id.
 */
function marked(document: Document): readonly (string | null)[] {
  return [...document.querySelectorAll('[data-dsh-sicons]')]
    .map(node => node.getAttribute('data-dsh-sicons'))
}

test('both halves export a loadable entry', () => {
  assert.equal(typeof hostApply, 'function')
  assert.equal(typeof clientApply, 'function')
  assert.deepEqual([...inject], ['slots'])
})

test('the target table covers the three sections and every glyph is a mask', () => {
  assert.deepEqual(NAV_ICON_TARGETS.map(target => target.id), ['usage-stats', 'mcp', 'memory'])
  for (const target of NAV_ICON_TARGETS) assert.match(target.mask, /^url\("data:image\/svg\+xml,/)
})

test('projectRows keeps section ids with resolved labels and drops malformed entries', () => {
  assert.deepEqual(projectRows([
    { id: 'usage-stats', order: 11, label: () => '使用统计' },
    { id: 'mcp', order: 12, label: 'MCP 服务器' },
    { id: 'memory', order: 14, label: () => { throw new Error('registrant thunk') } },
    { order: 1, label: 'no id' },
    null,
    'nope',
  ]), [
    { id: 'usage-stats', label: '使用统计' },
    { id: 'mcp', label: 'MCP 服务器' },
    { id: 'memory', label: '' },
  ])
})

test('paints the matched rows only, and stop restores them exactly', () => {
  const document = installDom()
  mount(document, ['通用设置', '使用统计', 'MCP 服务器', '记忆'])
  const { stop } = harness(ROWS)
  assert.deepEqual(marked(document), ['usage-stats', 'mcp', 'memory'])

  const painted = document.querySelector('[data-dsh-sicons="usage-stats"]')
  assert.ok(painted !== null)
  const style = painted.getAttribute('style')
  assert.ok(style?.includes(MASK_PREFIX))
  // Both spellings: older Chromium/WebKit builds only honour the prefixed set.
  assert.ok(style?.includes('-webkit-mask-size:16px 16px'))
  assert.ok(style?.includes('mask-position:center'))
  assert.ok(style?.includes('background-color:currentColor'))
  assert.equal(painted.querySelector('path')?.getAttribute('display'), 'none')

  // The stock row next to it is untouched — no marker, no style, no hidden child.
  const stock = document.querySelectorAll('button')[0]
  assert.equal(stock?.querySelector('svg')?.getAttribute('style'), null)
  assert.equal(stock?.querySelector('path')?.getAttribute('display'), null)

  stop()
  assert.deepEqual(marked(document), [])
  assert.equal(document.querySelector('svg')?.getAttribute('style'), null)
  assert.equal(document.querySelector('path')?.getAttribute('display'), null)
})

test('paints rows that mount after the plugin starts', async () => {
  const document = installDom()
  const { stop } = harness(ROWS)
  assert.deepEqual(marked(document), [])

  mount(document, ['使用统计', '记忆'])
  await tick()
  assert.deepEqual(marked(document), ['usage-stats', 'memory'])
  stop()
})

test('repaints when the shell replaces the mounted glyph element', async () => {
  const document = installDom()
  mount(document, ['记忆'])
  const { stop } = harness(ROWS)
  const button = document.querySelector('button')
  assert.ok(button !== null)

  const fresh = document.createElementNS(SVG_NS, 'svg')
  fresh.setAttribute('width', '16')
  fresh.appendChild(document.createElementNS(SVG_NS, 'path'))
  button.querySelector('svg')?.replaceWith(fresh)
  await tick()

  assert.equal(fresh.getAttribute('data-dsh-sicons'), 'memory')
  assert.equal(fresh.querySelector('path')?.getAttribute('display'), 'none')
  assert.equal(marked(document).length, 1)
  stop()
})

test('stays invisible when no mounted row matches the ledger', () => {
  const document = installDom()
  mount(document, ['通用设置', '使用统计'])
  const { stop } = harness([
    { id: 'mcp', label: 'MCP 服务器' },
    { id: 'memory', label: '记忆' },
  ])
  assert.deepEqual(marked(document), [])
  stop()
})

test('stays invisible while the settings panel is closed', async () => {
  const document = installDom()
  const { stop } = harness(ROWS)
  await tick()
  assert.deepEqual(marked(document), [])
  stop()
})

test('apply projects the ledger once per version and unmounts clean', async () => {
  const document = installDom()
  mount(document, ['通用设置', '使用统计', 'MCP 服务器', '记忆'])
  const sections = [
    { options: { id: 'general', order: 0, label: () => '通用设置' } },
    { options: { id: 'usage-stats', order: 11, label: () => '使用统计' } },
    { options: { id: 'mcp', order: 12, label: 'MCP 服务器' } },
    { options: { id: 'memory', order: 14, label: '记忆' } },
  ]
  let ledgerVersion = 3
  let reads = 0
  const disposers: (() => void)[] = []
  const ctx = {
    slots: {
      getVersion: (): number => ledgerVersion,
      entries: (): readonly unknown[] => { reads += 1; return sections },
    },
    effect: (fn: () => () => void): void => { disposers.push(fn()) },
  }

  clientApply(ctx as unknown as Parameters<typeof clientApply>[0])
  assert.deepEqual(marked(document), ['usage-stats', 'mcp', 'memory'])
  assert.equal(reads, 1)

  // An unrelated repaint rescans without re-projecting an unchanged ledger.
  document.body.insertAdjacentHTML('beforeend', '<div id="noise"></div>')
  await tick()
  assert.equal(reads, 1)

  // A ledger mutation (registration, teardown, locale re-registration) re-projects.
  ledgerVersion += 1
  document.body.insertAdjacentHTML('beforeend', '<div id="noise-2"></div>')
  await tick()
  assert.equal(reads, 2)

  for (const dispose of disposers) dispose()
  assert.deepEqual(marked(document), [])
  assert.equal(document.querySelector('svg')?.getAttribute('style'), null)
})
