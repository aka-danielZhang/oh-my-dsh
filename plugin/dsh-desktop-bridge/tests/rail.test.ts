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
  it('subgrids the toolbar row and root onto the frame tracks', () => {
    const css = railCss()
    assert.ok(css.includes('[data-shell-toolbar-row]{display:grid;grid-template-columns:subgrid;}'), 'the AppFrame toolbar row re-exposes the three frame tracks')
    assert.ok(css.includes('[data-desktop-toolbar]{position:relative;display:grid;grid-template-columns:subgrid;grid-column:1/-1;height:38px;'), 'the toolbar root spans all tracks as a nested subgrid')
    assert.ok(css.includes('[data-desktop-toolbar]{') && css.includes('-webkit-app-region:drag;'), 'the row background is the drag region')
  })
  it('paints the sidebar segment only over the first track', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar]::before{content:"";grid-column:1;grid-row:1;background:var(--dsw-specific-sidebar-fill);border-right:0.5px solid var(--dsw-alias-border-l3);}'), 'the sidebar fill is confined to grid column 1 and continues the column seam')
    assert.ok(css.includes('background:var(--dsw-alias-bg-base)'), 'the row base is the conversation background, not a full-width sidebar band')
  })
  it('keeps the controls cluster past the lights and the main lane in the conversation tracks', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar-controls]{grid-column:1;grid-row:1;justify-self:start;z-index:1;display:flex;align-items:center;gap:2px;padding-left:86px;}'), 'the controls are an in-flow column-1 cluster after the light inset (never an overlay)')
    assert.ok(!css.includes('[data-desktop-toolbar-controls]{position:absolute'), 'the cluster is never absolutely positioned (v1 hit-test regression)')
    assert.ok(css.includes('[data-desktop-toolbar-main]{grid-column:2/-1;grid-row:1;'), 'the main lane starts at the conversation column edge')
    assert.ok(css.includes('padding-left:12px;'), 'the expanded title insets 12px from the conversation column edge')
    assert.ok(css.includes('pointer-events:none;transition:padding-left'), 'the main lane never wins the hit test over the collapsed cluster')
    assert.ok(css.includes('[data-desktop-toolbar-center]{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;pointer-events:auto;}'), 'the center host owns the flexible middle space while re-enabling pointer events')
  })
  it('reveals New Session only while the sidebar is collapsed (immune to the rail reset)', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar] [data-desktop-toolbar-new]{display:none!important;}'), 'expanded keeps the sidebar primary button as the only new-session affordance; !important beats the later rail-button display reset')
    assert.ok(css.includes('[data-sidebar-collapsed] [data-desktop-toolbar] [data-desktop-toolbar-new]{display:inline-flex!important;}'), 'collapsed reveals the toolbar New Session control')
  })
  it('splits title actions left and panel utilities right with matched control gaps', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar-center]>*{min-width:0;gap:8px;margin:0;}'), 'stock private margins cannot disturb the 8px session-content rhythm')
    assert.ok(css.includes('[data-desktop-toolbar-center]>:first-child{flex:0 1 auto;}'), 'title and session actions stay compact at the conversation edge')
    assert.ok(css.includes('[data-desktop-toolbar-center]>:last-child{flex:none;margin-left:auto;}'), 'Thread and future panel utilities form the far-right group')
    assert.ok(css.includes('[data-desktop-toolbar-main]{grid-column:2/-1;grid-row:1;display:flex;align-items:center;gap:2px;'), 'Thread → rightbar corner matches the left chrome controls\' 2px gap')
    assert.ok(css.includes('[data-desktop-toolbar-end] [data-conversation-header-corner]{margin:0;}'), 'the rightbar corner follows the utilities at the main lane gap')
    assert.ok(!css.includes('space-between'), 'the middle space belongs to the host, not distributed between every control')
  })
  it('clears the actual collapsed control cluster without a phantom updater gap', () => {
    const css = railCss()
    assert.ok(css.includes('[data-sidebar-collapsed] [data-desktop-toolbar-main]{padding-left:176px;}'), 'idle clearance = 86px lights + three 26px controls + gaps + 8px')
    assert.ok(css.includes('[data-sidebar-collapsed] [data-desktop-toolbar]:has([data-desktop-update-button]) [data-desktop-toolbar-main]{padding-left:204px;}'), 'the conditional updater expands clearance by exactly one 26px control plus its 2px gap')
    assert.ok(css.includes('transition:padding-left var(--ds-transition-duration-slow) var(--ds-ease-in-out);'), 'the clearance rides the frame track curve')
    assert.ok(css.includes('@media (prefers-reduced-motion:reduce){[data-desktop-toolbar-main]{transition:none;}}'), 'reduced motion disables the clearance transition')
  })
  it('lets every interactive child opt out of the drag region (immune to all:unset)', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar] button,[data-desktop-toolbar] a[href],[data-desktop-toolbar] input,[data-desktop-toolbar] textarea,[data-desktop-toolbar] [role="button"],[data-desktop-toolbar] [role="tab"]{-webkit-app-region:no-drag!important;}'), 'no-drag must survive the rail buttons\' all:unset reset')
  })
  it('lets the center host span while the trailing cluster stays non-shrinking', () => {
    const css = railCss()
    assert.ok(css.includes('[data-desktop-toolbar-center]{flex:1 1 0;min-width:0;'), 'center spans the middle without making its title cluster grow')
    assert.ok(css.includes('[data-desktop-toolbar-trailing]{display:flex;align-items:center;gap:2px;flex:none;pointer-events:auto;}'))
    assert.ok(css.includes('[data-desktop-toolbar-end] [data-conversation-header-corner]{margin:0;}'), 'the corner drops both in-header margins')
  })
  it('carries no removed affordance selectors or disabled styling', () => {
    const css = railCss()
    for (const gone of ['data-desktop-toolbar-leading', 'data-desktop-toolbar-workspace', 'data-desktop-toolbar-nav']) {
      assert.ok(!css.includes(gone), `${gone} is removed`)
    }
    assert.ok(!css.includes('button:disabled'), 'no disabled chrome remains — every rendered control is live')
    assert.ok(!css.includes('data-desktop-new-session'), 'the bubble and its slide animation are superseded')
  })
  it('narrows responsively without shrinking type', () => {
    const css = railCss()
    assert.ok(css.includes('@media (max-width: 1099px){[data-desktop-toolbar-center]{overflow:hidden;}'), 'below 1100px the center truncates')
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
