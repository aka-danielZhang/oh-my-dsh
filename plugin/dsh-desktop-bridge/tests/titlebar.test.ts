import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { installTitlebarCss, shouldFuseTitlebar, titlebarCss, TITLEBAR_ZONE_PX } from '../src/client/titlebar.ts'

describe('shouldFuseTitlebar', () => {
  it('fuses only on the macOS shell platform', () => {
    assert.equal(shouldFuseTitlebar('macos'), true)
    assert.equal(shouldFuseTitlebar('windows'), false)
    assert.equal(shouldFuseTitlebar('linux'), false)
    assert.equal(shouldFuseTitlebar(''), false)
  })
})

describe('titlebarCss', () => {
  it('insets only the sidebar column via the overlay-layer anchor', () => {
    const css = titlebarCss(28)
    assert.ok(css.includes('div:has(> [data-shell-overlay])'))
    assert.ok(css.includes('>div:nth-child(1)'), 'only the sidebar column clears the band (its surface sits under the lights)')
    assert.ok(!css.includes('>div:nth-child(-n+3)'), 'the center/details columns run their content to y=0 (toolbar look)')
    assert.ok(css.includes('padding-top:28px'))
    assert.ok(css.includes('box-sizing:border-box'))
  })
  it('locks the document scrollable root pair', () => {
    assert.ok(titlebarCss(28).includes('html,body{overflow:hidden;}'), 'the fixed-viewport shell must not be scrollable')
  })
  it('scopes the legacy band rules to the pre-toolbar fallback posture', () => {
    const css = titlebarCss(28)
    assert.ok(
      css.includes('html:not([data-shell-toolbar-on]) div:has(> [data-shell-overlay])>div:nth-child(1){box-sizing:border-box;padding-top:28px;}'),
      'the sidebar band inset holds only until the toolbar grid row mounts',
    )
    assert.ok(
      css.includes('html:not([data-shell-toolbar-on]) div[data-sidebar-collapsed]:has(> [data-shell-overlay]) [data-slot="conversation.session.header"]{padding-left:80px;}'),
      'the collapsed-header fallback is the fixed 80px light row; with the toolbar mounted the header portals away and the rule has no target',
    )
    assert.ok(!css.includes('--desktop-band-controls-right'), 'the dynamic-clearance experiment is superseded by the toolbar')
    assert.ok(!css.includes('[data-desktop-drag-seg]'), 'the segmented drag strip is superseded: the toolbar row is the drag region')
    assert.ok(!css.includes('[data-desktop-drag-strip]'), 'no segmented strip host remains')
  })
  it('lets the fullscreen right-sidebar panel truly take over the window', () => {
    const css = titlebarCss(28)
    assert.ok(!css.includes('[data-sidebar-right-panel="fullscreen"]{top:'), 'fullscreen keeps native fixed inset:0 — a top offset strands it on a second row beside the center header')
    assert.ok(!css.includes('[data-sidebar-right-panel]{'), 'push/float stay at y=0 — the overlay layer holes their strip like any band control')
    assert.ok(css.includes('[data-sidebar-right-panel="fullscreen"] [data-dockkit-pane]:first-of-type [data-dockkit-strip]{padding-left:80px;}'), 'the first pane strip clears the traffic lights (toolbar leading-inset baseline); a second split pane needs no carve')
    assert.ok(css.includes('[data-sidebar-right-panel="fullscreen"] [data-dockkit-strip]{-webkit-app-region:drag;}'), 'the strip background is the drag surface while the z-40 panel covers the toolbar')
    assert.ok(css.includes('[data-sidebar-right-panel="fullscreen"] [data-dockkit-strip] :is(button, a[href], [role="button"], [role="tab"], input, textarea, [contenteditable="true"]){-webkit-app-region:no-drag;}'), 'strip interactive children (tabs are role=tab, close is a button) keep their clicks')
  })
  it('embeds the configured band height', () => {
    assert.ok(titlebarCss(TITLEBAR_ZONE_PX).includes(`padding-top:${String(TITLEBAR_ZONE_PX)}px`))
    assert.ok(titlebarCss(40).includes('padding-top:40px'))
  })
})

describe('installTitlebarCss', () => {
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
    const dispose = installTitlebarCss(doc as unknown as Document, 28)
    assert.equal(appended.length, 1)
    assert.equal(appended[0].dataset.plugin, 'dsh-desktop-bridge')
    assert.equal(appended[0].dataset.pluginCss, 'dsh-desktop-bridge/titlebar')
    assert.equal(appended[0].attributes['data-desktop-titlebar'], '')
    assert.equal(appended[0].textContent, titlebarCss(28))
    assert.equal(appended[0].removed, false)
    dispose()
    assert.equal(appended[0].removed, true)
  })
  it('dedups against a live tag and returns a no-op disposer', () => {
    const { doc, appended } = stubDoc({ dataset: { pluginCss: 'dsh-desktop-bridge/titlebar' } })
    const dispose = installTitlebarCss(doc as unknown as Document, 28)
    assert.equal(appended.length, 0)
    dispose()
  })
})
