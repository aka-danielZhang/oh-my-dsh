import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectBandHoles, computeDragSegments, DRAG_SEGMENT_HOLE_PAD_PX } from '../src/client/drag-strip.ts'

describe('computeDragSegments', () => {
  it('returns the full width when there are no holes', () => {
    assert.deepEqual(computeDragSegments(1000, []), [[0, 1000]])
  })
  it('complements one hole into two segments', () => {
    assert.deepEqual(computeDragSegments(1000, [[400, 500]]), [[0, 400], [500, 1000]])
  })
  it('merges overlapping holes', () => {
    assert.deepEqual(computeDragSegments(1000, [[400, 500], [450, 600]]), [[0, 400], [600, 1000]])
  })
  it('merges adjacent holes that touch after padding', () => {
    assert.deepEqual(computeDragSegments(1000, [[400, 500], [500, 600]]), [[0, 400], [600, 1000]])
  })
  it('clamps holes to the viewport', () => {
    assert.deepEqual(computeDragSegments(1000, [[-50, 100], [900, 1200]]), [[100, 900]])
  })
  it('drops holes fully outside the viewport', () => {
    assert.deepEqual(computeDragSegments(1000, [[1400, 2000]]), [[0, 1000]])
    assert.deepEqual(computeDragSegments(1000, [[-300, -10]]), [[0, 1000]])
  })
  it('drops segments narrower than the minimum grip', () => {
    assert.deepEqual(computeDragSegments(1000, [[6, 995]]), [], 'both edge slivers are below the grip minimum')
    assert.deepEqual(computeDragSegments(1000, [[0, 990]]), [], 'a 10px trailing sliver is below the grip minimum')
  })
  it('handles an unsorted hole list', () => {
    assert.deepEqual(computeDragSegments(1000, [[800, 900], [100, 200]]), [[0, 100], [200, 800], [900, 1000]])
  })
  it('never emits a zero-width segment when a hole covers an edge', () => {
    assert.deepEqual(computeDragSegments(1000, [[0, 100]]), [[100, 1000]])
    assert.deepEqual(computeDragSegments(1000, [[988, 1000]]), [[0, 988]])
  })
})

/**
 * Minimal DOM stubs for collectBandHoles: the function only walks a
 * querySelectorAll result, reads rects, and asks the window for computed
 * styles, so identity + rect + style carry the whole contract.
 */
interface StubControl {
  el: Element
  style: { visibility: string; opacity: string }
}

function stubControl(left: number, right: number, top: number, bottom: number, style: Partial<StubControl['style']> = {}): StubControl {
  const rect = { left, right, top, bottom, width: right - left, height: bottom - top }
  const full = { visibility: 'visible', opacity: '1', ...style }
  const el = { getBoundingClientRect: () => rect } as unknown as Element
  return { el, style: full }
}

/**
 * Dispatch by selector shape: the interactive selector mentions `button`;
 * every other anchor (e.g. a right-sidebar panel wrapper) matches nothing.
 * That is what lets the test below prove holes no longer depend on a panel
 * ancestor — under the pre-rc.12 panel-scoped collection this stub returns
 * zero panels, hence zero holes.
 */
function stubDoc(controls: StubControl[]): Document {
  return {
    querySelectorAll: (selector: string): Element[] => (selector.includes('button') ? controls.map(c => c.el) : []),
  } as unknown as Document
}

function stubWin(controls: StubControl[]): Window {
  return {
    getComputedStyle: (el: Element): StubControl['style'] =>
      controls.find(c => c.el === el)?.style ?? { visibility: 'visible', opacity: '1' },
  } as unknown as Window
}

describe('collectBandHoles', () => {
  it('carves for band controls anywhere in the document, not only inside the right-sidebar panel', () => {
    const controls = [
      stubControl(300, 324, 4, 28), // conversation-header utility at y=0, no panel ancestor
      stubControl(1800, 1824, 2, 26), // right-panel strip button
    ]
    const pad = DRAG_SEGMENT_HOLE_PAD_PX
    assert.deepEqual(collectBandHoles(stubDoc(controls), stubWin(controls), 28), [
      [300 - pad, 324 + pad],
      [1800 - pad, 1824 + pad],
    ], 'header controls entered the band in 0.2.0-rc.12 and must keep their events')
  })
  it('ignores controls below the band and invisible ones inside it', () => {
    const controls = [
      stubControl(300, 324, 40, 64), // fully below the band
      stubControl(400, 424, 4, 28, { visibility: 'hidden' }),
      stubControl(500, 524, 4, 28, { opacity: '0' }),
    ]
    assert.deepEqual(collectBandHoles(stubDoc(controls), stubWin(controls), 28), [])
  })
})
