/**
 * Sidebar entry row-qualification tests: the header row must be picked by
 * structural census alone, never counting this plugin's own entry button or
 * the search control's transient buttons.
 *
 * Regression (0.1.3): expanding the session search mounts a clear button
 * inside the search control, which made the control itself qualify as the
 * header row (≥2 buttons); the entry was re-parented into it and hidden
 * behind its `overflow: hidden`, and after collapse the entry's own button
 * kept the count at 2 — the clock icon stayed gone. Both inputs to the census
 * are pinned here, DOM-free.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { qualifyingRowButtons } from '../src/client/entry.ts'

const anchor = { isAnchor: true, isOwn: false, inSearchCluster: true }
const clear = { isAnchor: false, isOwn: false, inSearchCluster: true }
const viewMenu = { isAnchor: false, isOwn: false, inSearchCluster: false }
const addWorkspace = { isAnchor: false, isOwn: false, inSearchCluster: false }
const ownEntry = { isAnchor: false, isOwn: true, inSearchCluster: false }

test('the clipped search control never qualifies as the row, expanded or stuck', () => {
  // Expanded: the anchor plus the transient clear button — was ≥2 before.
  assert.equal(qualifyingRowButtons([anchor, clear]), 1)
  // Collapsed after the old regression: the anchor plus the swallowed entry.
  assert.equal(qualifyingRowButtons([anchor, ownEntry]), 1)
  // Expanded and stuck at once.
  assert.equal(qualifyingRowButtons([anchor, clear, ownEntry]), 1)
})

test('the real header row qualifies via its own controls, with the entry ignored', () => {
  assert.equal(qualifyingRowButtons([anchor, viewMenu, addWorkspace, ownEntry]), 3)
  // No directory flow composed: anchor + view menu still seats the entry.
  assert.equal(qualifyingRowButtons([anchor, viewMenu]), 2)
})

test('wrappers and partial rows stay unqualified', () => {
  // A Tooltip wrapper around the anchor alone.
  assert.equal(qualifyingRowButtons([anchor]), 1)
  // Transient cluster buttons without the anchor present (other controls).
  assert.equal(qualifyingRowButtons([clear]), 0)
})
