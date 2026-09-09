import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computeDragSegments } from '../src/client/drag-strip.ts'

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
