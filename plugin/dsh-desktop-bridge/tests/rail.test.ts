import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  RAIL_CLEARANCE_GAP_PX,
  RAIL_CLEARANCE_VAR,
  collapseRailTemplate,
  installRailClearance,
  installRailCss,
  railClearanceValue,
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
  it('seats the controls right of the traffic lights, centered on the dropped row', () => {
    const css = railCss()
    assert.ok(css.includes('top:8px;left:86px;height:22px;'))
    assert.ok(css.includes('gap:8px;'), 'breathing room between toggle and bubble')
    assert.ok(css.includes('z-index:1'))
  })
  it('keeps the toggle always visible and clickable', () => {
    const css = railCss()
    const toggleRule = css.match(/\[data-desktop-rail-controls\] \[data-desktop-rail-button\]\{[^}]*\}/)
    assert.ok(toggleRule !== null)
    assert.ok(toggleRule[0].includes('pointer-events:auto'))
    assert.ok(toggleRule[0].includes('-webkit-app-region:no-drag!important'))
    assert.ok(!toggleRule[0].includes('opacity:0'))
  })
  it('shows the New Session bubble only while collapsed, sliding in delayed', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-rail-controls] [data-desktop-new-session]{opacity:0;visibility:hidden;transform:translateX(12px);pointer-events:none!important;'))
    assert.ok(css.includes('div[data-sidebar-collapsed] [data-desktop-rail-controls] [data-desktop-new-session]{opacity:1;visibility:visible;'))
    assert.ok(css.includes('transition:opacity .2s ease .18s,transform .2s ease .18s'))
  })
  it('respects reduced motion', () => {
    assert.ok(railCss().includes('@media (prefers-reduced-motion: reduce)'))
  })
  it('styles with semantic tokens only', () => {
    const css = railCss()
    assert.ok(css.includes('var(--dsw-alias-label-primary)'))
    assert.ok(css.includes('var(--dsw-alias-interactive-bg-hover)'))
    assert.ok(!css.includes('#'), 'no literal colors')
  })
})

describe('railClearanceValue', () => {
  it('publishes the right edge plus the breathing gap, rounded up', () => {
    assert.equal(railClearanceValue(350), '358px')
    assert.equal(railClearanceValue(349.3), '358px', 'fractional widths must not shave the gap')
    assert.equal(railClearanceValue(86), `${String(86 + RAIL_CLEARANCE_GAP_PX)}px`)
  })
  it('keeps the variable name the titlebar rule consumes', () => {
    assert.equal(RAIL_CLEARANCE_VAR, '--desktop-band-controls-right')
  })
})

describe('installRailClearance', () => {
  class StubResizeObserver {
    static instances: StubResizeObserver[] = []
    readonly callback: () => void
    observed: unknown[] = []
    disconnected = false
    constructor(callback: () => void) {
      this.callback = callback
      StubResizeObserver.instances.push(this)
    }
    observe(target: unknown): void { this.observed.push(target) }
    disconnect(): void { this.disconnected = true }
  }
  class StubMutationObserver {
    static instances: StubMutationObserver[] = []
    readonly callback: () => void
    observing = false
    disconnected = false
    constructor(callback: () => void) {
      this.callback = callback
      StubMutationObserver.instances.push(this)
    }
    observe(): void { this.observing = true }
    disconnect(): void { this.disconnected = true }
  }
  function stubDoc(railControls: unknown) {
    const props = new Map<string, string>()
    return {
      props,
      doc: {
        defaultView: { ResizeObserver: StubResizeObserver, MutationObserver: StubMutationObserver },
        documentElement: {
          style: {
            setProperty: (k: string, v: string): void => { props.set(k, v) },
            removeProperty: (k: string): void => { props.delete(k) },
          },
        },
        querySelector: (selector: string): unknown => (selector === '[data-desktop-rail-controls]' ? railControls : null),
      },
    }
  }
  function stubControls(right: number): { el: unknown; setRight: (v: number) => void } {
    let edge = right
    return {
      el: { getBoundingClientRect: (): { right: number } => ({ right: edge }) },
      setRight: (v: number): void => { edge = v },
    }
  }

  it('publishes the measured edge and observes the container', () => {
    StubResizeObserver.instances = []
    const { el } = stubControls(350.4)
    const { doc, props } = stubDoc(el)
    installRailClearance(doc as unknown as Document)
    assert.equal(props.get(RAIL_CLEARANCE_VAR), '359px')
    assert.equal(StubResizeObserver.instances.length, 1)
    assert.deepEqual(StubResizeObserver.instances[0].observed, [el])
  })
  it('republishes when the controls resize (updater/bell mount or unmount)', () => {
    StubResizeObserver.instances = []
    const { el, setRight } = stubControls(200)
    const { doc, props } = stubDoc(el)
    installRailClearance(doc as unknown as Document)
    assert.equal(props.get(RAIL_CLEARANCE_VAR), '208px')
    setRight(350)
    StubResizeObserver.instances[0].callback()
    assert.equal(props.get(RAIL_CLEARANCE_VAR), '358px')
  })
  it('removes the variable and disconnects on dispose', () => {
    StubResizeObserver.instances = []
    const { el } = stubControls(350)
    const { doc, props } = stubDoc(el)
    const dispose = installRailClearance(doc as unknown as Document)
    assert.ok(props.has(RAIL_CLEARANCE_VAR))
    dispose()
    assert.ok(!props.has(RAIL_CLEARANCE_VAR), 'the effect must not leak its variable into the next mount')
    assert.equal(StubResizeObserver.instances[0].disconnected, true)
  })
  it('waits for the slot-rendered container when absent at apply time', () => {
    StubResizeObserver.instances = []
    StubMutationObserver.instances = []
    let railControls: unknown = null
    const { el } = stubControls(300)
    const base = stubDoc(null)
    const doc = { ...base.doc, querySelector: (selector: string): unknown => (selector === '[data-desktop-rail-controls]' ? railControls : null) }
    const dispose = installRailClearance(doc as unknown as Document)
    assert.ok(!base.props.has(RAIL_CLEARANCE_VAR), 'nothing published before the container exists')
    assert.ok(StubMutationObserver.instances[0].observing, 'a boot observer watches for the slot render')
    railControls = el
    StubMutationObserver.instances[0].callback()
    assert.equal(base.props.get(RAIL_CLEARANCE_VAR), '308px')
    assert.equal(StubMutationObserver.instances[0].disconnected, true, 'the boot observer detaches once attached')
    dispose()
    assert.ok(!base.props.has(RAIL_CLEARANCE_VAR))
  })
  it('is a no-op without observer support (rule degrades to its 80px fallback)', () => {
    const props = new Map<string, string>()
    const doc = {
      defaultView: {},
      documentElement: {
        style: {
          setProperty: (k: string, v: string): void => { props.set(k, v) },
          removeProperty: (k: string): void => { props.delete(k) },
        },
      },
      querySelector: (): unknown => null,
    }
    const dispose = installRailClearance(doc as unknown as Document)
    assert.ok(!props.has(RAIL_CLEARANCE_VAR))
    dispose()
    assert.ok(!props.has(RAIL_CLEARANCE_VAR))
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
