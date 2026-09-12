/**
 * Sidebar entry: the clock button beside the session browser's search control.
 *
 * The session browser's header row (`ui-workspace` WorkspaceBrowser
 * `.sectionHeader`) declares no action seat — only the workspaces region and
 * its directory flow — so this plugin decorates that row instead of claiming a
 * slot, the same posture as the repo's other DOM-side plugins
 * (`dsh-settings-icons`, `dsh-provider-balance`): own namespace, own class, no
 * other plugin's class names touched, everything reversible.
 *
 * Anchoring is bilingual and structural, never by private class name: the row
 * is the one holding the search control (`搜索会话` / `Search sessions`) and, when
 * a directory flow is composed, the add-workspace control (`添加工作区` /
 * `Add workspace`). The button is appended as the row's LAST child — React
 * reconciles its own children, and appending is the one mutation outside that
 * list that survives re-renders — then absolutely positioned to the left of the
 * search control with the row's own measured gap, so every icon in the group
 * stays equidistant. Anchors missing ⇒ nothing is drawn (fail invisible).
 *
 * Clicking toggles the main panel: the same button returns to the Conversation,
 * which is why it also mirrors its pressed state from the document marker the
 * panel sets while mounted.
 * @module dsh-scheduled-tasks/client/entry
 */

/** Main panel key this entry selects (`./index.ts` registers it). */
export const PANEL_KEY = 'automation'

/** Labels of the session browser's search control, both shipped locales. */
const SEARCH_LABELS = ['搜索会话', 'Search sessions']
/** Labels of the add-workspace control that shares the same row. */
const ADD_LABELS = ['添加工作区', 'Add workspace']
/** Zero-child texts of the session browser's section label, both locales. */
const SECTION_LABELS = ['会话', 'Sessions', '工作区', 'Workspaces']

const MARK = 'data-dsh-stask-entry'
const ROW_MARK = 'data-dsh-stask-entry-row'
/** Panel-mounted marker published by the page (never another plugin's state). */
const PANEL_FLAG = 'dshStaskPanel'
const BUTTON_SIZE = 28
const FALLBACK_GAP = 8
/** Coalescing window for DOM mutations, in ms. */
const SCAN_DEBOUNCE = 60
/** Walk-up budget when looking for the header row above a control. */
const MAX_ROW_HOPS = 6

const CLOCK_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="6.2" stroke="currentColor" stroke-width="1.4"/>'
  + '<path d="M8 4.6V8l2.4 1.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'

/** Structural face of `ctx.layout` this entry needs. */
export interface LayoutFace {
  selectPanel(panelId: string | null): void
}

/** Find a button whose accessible label is one of `labels`. */
function buttonByLabels(labels: readonly string[]): HTMLButtonElement | null {
  for (const label of labels) {
    const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (found !== null) return found
  }
  return null
}

/**
 * Walk up from a control to the header row that holds it: the nearest
 * ancestor containing at least one other button (the row always holds the
 * search and add controls together; a Tooltip wrapper or icon span in between
 * must not win). Returns null past the hop budget.
 */
function rowOf(control: HTMLElement): HTMLElement | null {
  let row: HTMLElement | null = control
  for (let hop = 0; hop < MAX_ROW_HOPS && row !== null; hop++) {
    if (row.querySelectorAll('button').length >= 2) return row
    row = row.parentElement
  }
  return null
}

/**
 * Fallback anchor used when the aria-label lookup misses (a fork or locale
 * variant that renders the search control differently): the section label is
 * a zero-child element reading 会话/Sessions/工作区/Workspaces, and its header
 * row is the nearest ancestor holding two or more buttons.
 */
function rowBySectionLabel(): { row: HTMLElement, anchor: HTMLButtonElement } | null {
  for (const text of SECTION_LABELS) {
    for (const label of document.querySelectorAll<HTMLElement>('span,div,h1,h2,h3,h4')) {
      if (label.childElementCount !== 0 || label.textContent?.trim() !== text) continue
      let row: HTMLElement | null = label
      for (let hop = 0; hop < MAX_ROW_HOPS && row !== null; hop++) {
        row = row.parentElement
        if (row === null) break
        const buttons = row.querySelectorAll<HTMLButtonElement>('button')
        if (buttons.length >= 2) return { row, anchor: buttons[0] }
      }
    }
  }
  return null
}

/** Coalesce a burst of mutations into one scan. */
class Scanner {
  private timer: number | null = null
  private readonly observer: MutationObserver
  private readonly onScan: () => void

  constructor(onScan: () => void) {
    this.onScan = onScan
    this.observer = new MutationObserver(() => { this.schedule() })
  }

  /** Begin observing and run the first scan. */
  start(): void {
    this.observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', this.schedule)
    this.onScan()
  }

  /** Stop observing and cancel a pending scan. */
  stop(): void {
    this.observer.disconnect()
    window.removeEventListener('resize', this.schedule)
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }

  private readonly schedule = (): void => {
    if (this.timer !== null) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      this.onScan()
    }, SCAN_DEBOUNCE)
  }
}

/**
 * Mount the sidebar entry; the returned disposer removes the button, the row
 * marker and every listener.
 * @param layout - the layout service face the entry toggles through.
 * @param label - accessible name / tooltip, resolved per scan so a locale
 *   switch (which mutates the DOM and triggers a rescan anyway) follows.
 * @returns the disposer.
 */
export function installEntry(layout: LayoutFace, label: () => string): () => void {
  const scan = (): void => {
    // Primary: the search/add controls by accessible label. Fallback: the
    // section label text — the previewed injector's proven path, kept for
    // forks or locales where the rendered control lost the expected label.
    const byLabel = buttonByLabels(SEARCH_LABELS) ?? buttonByLabels(ADD_LABELS)
    const located = byLabel !== null && byLabel.parentElement !== null
      ? { row: rowOf(byLabel), anchor: byLabel }
      : rowBySectionLabel()
    const anchor = located?.anchor ?? null
    const row = located?.row ?? null
    const existing = document.querySelector<HTMLButtonElement>(`[${MARK}]`)
    if (anchor === null || row === null) {
      // Anchor absent (sidebar collapsed to its rail, or a composition without
      // the session browser): withdraw rather than draw in the wrong place.
      existing?.remove()
      return
    }
    let button = existing
    if (button === null) {
      button = document.createElement('button')
      button.setAttribute(MARK, 'true')
      button.type = 'button'
      button.className = 'dsh-stask-entry'
      button.innerHTML = CLOCK_SVG
      const stop = (event: Event): void => { event.stopPropagation() }
      button.addEventListener('mousedown', stop)
      button.addEventListener('mouseup', stop)
      button.addEventListener('keydown', stop)
      button.addEventListener('click', () => {
        const active = document.documentElement.dataset[PANEL_FLAG] === 'on'
        layout.selectPanel(active ? null : PANEL_KEY)
      })
    }
    if (button.parentElement !== row) {
      if (row.style.position === '') row.style.position = 'relative'
      row.setAttribute(ROW_MARK, 'true')
      row.appendChild(button)
    }
    const name = label()
    button.title = name
    button.setAttribute('aria-label', name)
    button.setAttribute('aria-pressed', document.documentElement.dataset[PANEL_FLAG] === 'on' ? 'true' : 'false')
    const rowRect = row.getBoundingClientRect()
    const anchorRect = anchor.getBoundingClientRect()
    // The row's own icon gap: measured between the two shipped controls so this
    // button lands in the same rhythm instead of guessing a value.
    const sibling = Array.from(row.querySelectorAll('button')).find(candidate => candidate !== button && candidate !== anchor)
    const measured = sibling === undefined ? Number.NaN : sibling.getBoundingClientRect().left - anchorRect.right
    const gap = Number.isFinite(measured) && measured > 0 && measured < 40 ? measured : FALLBACK_GAP
    button.style.left = `${String(anchorRect.left - rowRect.left - BUTTON_SIZE - gap)}px`
    button.style.top = `${String(anchorRect.top - rowRect.top + Math.max(0, (anchorRect.height - BUTTON_SIZE) / 2))}px`
  }

  const scanner = new Scanner(scan)
  scanner.start()
  return () => {
    scanner.stop()
    document.querySelector<HTMLButtonElement>(`[${MARK}]`)?.remove()
    for (const row of document.querySelectorAll<HTMLElement>(`[${ROW_MARK}]`)) {
      row.style.position = ''
      row.removeAttribute(ROW_MARK)
    }
  }
}
