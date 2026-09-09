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
  it('marks only the gap segments for Electron window dragging, never the host', () => {
    const css = titlebarCss(28)
    assert.ok(css.includes('[data-desktop-drag-seg]{position:absolute;top:0;bottom:0;-webkit-app-region:drag;pointer-events:auto;}'))
    assert.ok(css.includes('[data-desktop-drag-strip]{pointer-events:none;}'), 'the host stays click-through so band controls keep their events')
    assert.ok(!css.includes('[data-desktop-drag-strip]{-webkit-app-region:drag;}'), 'a full-width drag strip covers band controls')
  })
  it('offsets only the fullscreen right-sidebar panel below the band', () => {
    const css = titlebarCss(28)
    assert.ok(css.includes('[data-sidebar-right-panel="fullscreen"]{top:28px!important;}'), 'fullscreen is fixed z-40 above the overlay layer and cannot be holed through')
    assert.ok(!css.includes('[data-sidebar-right-panel]{'), 'push/float stay at y=0 — the overlay layer holes their strip like any band control')
  })
  it('carves the traffic-light row out of the collapsed session header', () => {
    assert.ok(titlebarCss(28).includes('div[data-sidebar-collapsed]:has(> [data-shell-overlay]) [data-slot="conversation.session.header"]{padding-left:80px;}'), 'collapsed center column starts at x=0 and must clear the lights (rail-controls left:86px baseline)')
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
