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
  it('insets the three frame columns via the overlay-layer anchor', () => {
    const css = titlebarCss(28)
    assert.ok(css.includes('div:has(> [data-shell-overlay])'))
    assert.ok(css.includes('>div:nth-child(-n+3)'), 'the sidebar/center/details columns')
    assert.ok(css.includes('padding-top:28px'))
    assert.ok(css.includes('box-sizing:border-box'))
  })
  it('locks the document scrollable root pair', () => {
    assert.ok(titlebarCss(28).includes('html,body{overflow:hidden;}'), 'the fixed-viewport shell must not be scrollable')
  })
  it('marks the drag strip for Electron window dragging', () => {
    assert.ok(titlebarCss(28).includes('[data-desktop-drag-strip]{-webkit-app-region:drag;}'))
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
