import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  collapseRailTemplate,
  installRailCss,
  railCss,
  restoreRailTemplate,
} from '../src/client/rail.ts'

describe('collapseRailTemplate', () => {
  it('zeroes the first track of the AppFrame template (details closed)', () => {
    assert.equal(collapseRailTemplate('56px minmax(0, 1fr) 0px'), '0px minmax(0, 1fr) 0px')
  })
  it('zeroes the first track and keeps the live details width', () => {
    assert.equal(collapseRailTemplate('56px minmax(0px, 1fr) 412px'), '0px minmax(0px, 1fr) 412px')
  })
  it('rewrites any leading pixel track (tolerant of solver drift)', () => {
    assert.equal(collapseRailTemplate('280px minmax(0, 1fr) 0px'), '0px minmax(0, 1fr) 0px')
  })
  it('is idempotent on an already-zero first track', () => {
    assert.equal(collapseRailTemplate('0px minmax(0, 1fr) 0px'), '0px minmax(0, 1fr) 0px')
  })
  it('passes non-contract templates through unchanged (fail soft)', () => {
    assert.equal(collapseRailTemplate(''), '')
    assert.equal(collapseRailTemplate('none'), 'none')
    assert.equal(collapseRailTemplate('56px'), '56px')
    assert.equal(collapseRailTemplate('minmax(0, 1fr) 360px'), 'minmax(0, 1fr) 360px')
  })
})

describe('restoreRailTemplate', () => {
  it('restores the captured template while cleanup still owns the value', () => {
    assert.equal(
      restoreRailTemplate('0px minmax(0, 1fr) 320px', '0px minmax(0, 1fr) 320px', '56px minmax(0, 1fr) 320px'),
      '56px minmax(0, 1fr) 320px',
    )
  })

  it('preserves a later frame write', () => {
    assert.equal(
      restoreRailTemplate('280px minmax(0, 1fr) 0px', '0px minmax(0, 1fr) 320px', '56px minmax(0, 1fr) 320px'),
      '280px minmax(0, 1fr) 0px',
    )
  })
})

describe('railCss', () => {
  it('drops the zero-width sidebar column border seam', () => {
    const css = railCss()
    assert.ok(css.includes('div[data-sidebar-collapsed]:has(> [data-shell-overlay])>div:nth-child(1)'))
    assert.ok(css.includes('border-right:none'))
  })
  it('hides the native toggle but keeps the brand wordmark visible', () => {
    const css = railCss()
    assert.ok(css.includes("div[data-slot='sidebar']>div>div:first-child>button:last-child{display:none;}"))
  })
  it('styles the unified toolbar row: 38px, native drag background, leading light inset', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar]{position:relative;display:flex;align-items:stretch;height:38px;'))
    assert.ok(css.includes('[data-desktop-toolbar]{') && css.includes('-webkit-app-region:drag;'), 'the row background is the drag region')
    assert.ok(css.includes('[data-desktop-toolbar-leading]{display:flex;align-items:center;gap:2px;flex:none;padding-left:86px;}'), 'the traffic lights own the leading inset')
  })
  it('lets every interactive child opt out of the drag region', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar] button,[data-desktop-toolbar] a[href],[data-desktop-toolbar] input,[data-desktop-toolbar] textarea,[data-desktop-toolbar] [role="button"],[data-desktop-toolbar] [role="tab"]{-webkit-app-region:no-drag;}'))
  })
  it('keeps the flexible center host cell and the trailing cluster', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar-center]{flex:1 1 0;min-width:0;'))
    assert.ok(css.includes('[data-desktop-toolbar-trailing]{display:flex;align-items:center;gap:2px;flex:none;padding-right:8px;}'))
  })
  it('drops the collapsed-only New Session bubble (New Session lives in the toolbar)', () => {
    const css = railCss()
    assert.ok(!css.includes('data-desktop-new-session'), 'the bubble and its slide animation are superseded')
  })
  it('narrows responsively without shrinking type', () => {
    const css = railCss()
    assert.ok(css.includes('@media (max-width: 1099px)'), 'below 1100px the center truncates')
    assert.ok(css.includes('@media (max-width: 767px){[data-desktop-toolbar-nav],[data-desktop-toolbar-workspace]{display:none;}}'), 'below 768px navigation and workspace affordances drop')
  })
  it('styles with semantic tokens only', () => {
    const css = railCss()
    assert.ok(css.includes('var(--dsw-alias-label-primary)'))
    assert.ok(css.includes('var(--dsw-specific-sidebar-fill)'))
    assert.ok(!css.includes('#'), 'no literal colors')
  })
})

describe('installRailCss', () => {
  class StubStyle {
    readonly attributes: Record<string, string> = {}
    readonly dataset: Record<string, string> = {}
    textContent: string | null = null
    removed = false
    setAttribute(name: string, value: string): void { this.attributes[name] = value }
    remove(): void { this.removed = true }
  }
  function stubDoc(existing: unknown = null) {
    const appended: StubStyle[] = []
    return {
      appended,
      doc: {
        querySelector: () => existing,
        createElement: (tagName: string) => {
          assert.equal(tagName, 'style')
          return new StubStyle()
        },
        head: { append(...nodes: unknown[]): void { appended.push(...(nodes as StubStyle[])) } },
      },
    }
  }

  it('appends a claimed style element (data-plugin + data-plugin-css + marker)', () => {
    const { doc, appended } = stubDoc()
    const dispose = installRailCss(doc as unknown as Document)
    assert.equal(appended.length, 1)
    assert.equal(appended[0].dataset.plugin, 'dsh-desktop-bridge')
    assert.equal(appended[0].dataset.pluginCss, 'dsh-desktop-bridge/rail')
    assert.equal(appended[0].attributes['data-desktop-rail'], '')
    assert.equal(appended[0].textContent, railCss())
    assert.equal(appended[0].removed, false)
    dispose()
    assert.equal(appended[0].removed, true)
  })
  it('dedups against a live tag and returns a no-op disposer', () => {
    const { doc, appended } = stubDoc({ dataset: { pluginCss: 'dsh-desktop-bridge/rail' } })
    const dispose = installRailCss(doc as unknown as Document)
    assert.equal(appended.length, 0)
    dispose()
  })
})
