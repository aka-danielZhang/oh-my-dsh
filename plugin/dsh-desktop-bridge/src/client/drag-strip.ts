/**
 * Segmented titlebar drag strip, browser half (macOS overlay titlebar only).
 *
 * Historical form: one full-width transparent strip in shell.overlay carried
 * `-webkit-app-region: drag`. That worked while the top band held only window
 * chrome. The 0.1.2 runtime renders the right-sidebar panel as an ABSOLUTE
 * surface (`[data-sidebar-right-panel]`, positioned against its zero-width
 * grid column, `top: 0`) whose dockkit tab strip and pane controls (split /
 * maximize / collapse / close) live inside the reserved 28px band. The
 * full-width strip sat above every column (overlay z-index) and the OS treats
 * drag-region pixels as window-drag: hover over those buttons cancelled
 * mid-gesture and clicks were swallowed as drags.
 *
 * The replacement is a set of drag SEGMENTS that tile only the band's empty
 * gaps: a reconciler measures every interactive element in the document that
 * intersects the band, pads each rect, merges the intervals, and renders one
 * segment per gap. Buttons sit in the holes with nothing above them; the
 * gaps remain native drag regions. Since 0.2.0-rc.12 the center/details
 * columns also run their content up to y=0, so band controls are no longer
 * confined to the right-sidebar panel — the conversation header's
 * utilities/tabs and any other y=0 row must carve holes exactly like the
 * panel strip or the segments swallow them (the pre-rc.11 failure). Clipped
 * scroll content is a non-issue in this layout (the conversation scroller
 * starts below the header, so nothing scrolls into the band); should a
 * future layout clip content under the band anyway, the worst case is an
 * extra hole — drag area shrinks slightly, no control loses events.
 *
 * Pure interval math lives in computeDragSegments; DOM wiring in
 * installDragSegments, owned by the titlebar-fusion effect in index.ts.
 */

/** A half-open horizontal interval [left, right) in px. */
export type Interval = readonly [number, number]

/** Padding added around each band control rect before carving (px). */
export const DRAG_SEGMENT_HOLE_PAD_PX = 6
/** Segments narrower than this are useless as drag grip and are dropped (px). */
export const DRAG_SEGMENT_MIN_WIDTH_PX = 12

/**
 * Interactive elements worth carving holes for. Limited to known action
 * surfaces: native buttons/links and ARIA action roles.
 */
const BAND_INTERACTIVE_SELECTOR = 'button, a[href], [role="button"], [role="tab"], input, textarea, [contenteditable="true"]'

/**
 * Merge, clamp, and complement padded hole intervals into drag segments.
 * @param width - viewport width in px.
 * @param holes - raw hole intervals (unsorted, possibly overlapping or
 *   partially/fully outside the viewport).
 * @param minWidth - drop segments narrower than this (px).
 * @returns the gap intervals to render as drag segments, in order.
 */
export function computeDragSegments(width: number, holes: readonly Interval[], minWidth = DRAG_SEGMENT_MIN_WIDTH_PX): Interval[] {
  const clamped: Interval[] = []
  for (const [left, right] of holes) {
    const l = Math.max(0, left)
    const r = Math.min(width, right)
    if (r - l > 0) clamped.push([l, r])
  }
  clamped.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [left, right] of clamped) {
    const last = merged[merged.length - 1]
    if (last !== undefined && left <= last[1]) last[1] = Math.max(last[1], right)
    else merged.push([left, right])
  }
  const segments: Interval[] = []
  let cursor = 0
  for (const [left, right] of merged) {
    if (left - cursor >= minWidth) segments.push([cursor, left])
    cursor = Math.max(cursor, right)
  }
  if (width - cursor >= minWidth) segments.push([cursor, width])
  return segments
}

/**
 * Collect the padded hole intervals for one reconcile pass: every interactive
 * element in the document whose rect intersects the reserved band — right
 * panel strip, conversation header utilities/tabs, any y=0 control row
 * (0.2.0-rc.12: document-wide, not just the right-sidebar panel; see the
 * module header). Invisible controls (hidden, zero-opacity) do not carve —
 * they take no events, so the drag segment may keep their pixels.
 * @param doc - the document to measure.
 * @param win - the window for viewport bounds and computed styles.
 * @param bandPx - reserved band height in px.
 * @returns raw hole intervals (unmerged).
 */
export function collectBandHoles(doc: Document, win: Window, bandPx: number): Interval[] {
  const holes: Interval[] = []
  const controls = doc.querySelectorAll(BAND_INTERACTIVE_SELECTOR)
  for (const el of controls) {
    const rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    if (rect.top >= bandPx || rect.bottom <= 0) continue
    const style = win.getComputedStyle(el)
    if (style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    holes.push([rect.left - DRAG_SEGMENT_HOLE_PAD_PX, rect.right + DRAG_SEGMENT_HOLE_PAD_PX])
  }
  return holes
}

/**
 * Keep the drag-segment container tiled with gap segments. Watches body
 * subtree mutations (panel open/close/mode flips) and window resize with a
 * short debounce, plus a slow interval as a layout-drift backstop. Segment
 * children are plain divs keyed by position; the container itself is the
 * slot-rendered host this installer is handed.
 * @param host - the container div rendered by the shell.overlay entry.
 * @param bandPx - reserved band height in px.
 * @returns the disposer removing segments and observers.
 */
export function installDragSegments(host: HTMLElement, bandPx: number): () => void {
  const doc = host.ownerDocument
  const win = doc.defaultView
  if (win === null) return () => {}
  let segments: HTMLElement[] = []
  const reconcile = (): void => {
    const want = computeDragSegments(win.innerWidth, collectBandHoles(doc, win, bandPx))
    for (const seg of segments) seg.remove()
    segments = []
    for (const [left, right] of want) {
      const el = doc.createElement('div')
      el.setAttribute('data-desktop-drag-seg', '')
      // Archived Tauri shells drag via this declarative marker.
      el.setAttribute('data-tauri-drag-region', '')
      el.style.left = `${String(left)}px`
      el.style.width = `${String(right - left)}px`
      host.append(el)
      segments.push(el)
    }
  }
  reconcile()
  let timer: ReturnType<typeof setTimeout> | null = null
  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      reconcile()
    }, 100)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(doc.body, { childList: true, subtree: true })
  win.addEventListener('resize', schedule)
  const interval = setInterval(reconcile, 2000)
  return () => {
    observer.disconnect()
    win.removeEventListener('resize', schedule)
    clearInterval(interval)
    if (timer !== null) clearTimeout(timer)
    for (const seg of segments) seg.remove()
    segments = []
  }
}
