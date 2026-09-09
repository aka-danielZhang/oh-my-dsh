/**
 * Collapsed-rail suppression, browser half (macOS overlay titlebar only).
 * ui-layout never removes the closed sidebar: the AppFrame solves it to the
 * fixed 56px control rail (SIDEBAR_COLLAPSED) and keeps the rail UI mounted.
 * Under the shell's floating traffic lights that rail is a dead strip under
 * the close/minimize/zoom buttons, so the desktop form factor hides the
 * column outright and replaces it with titlebar-band controls
 * (rail-controls.tsx), including the conditional updater affordance.
 *
 * The column width lives in the frame's INLINE grid-template-columns (React
 * writes `<sidebar>px minmax(0, 1fr) <details>px` per render), so a plain
 * stylesheet cannot drop the first track without also losing the dynamic
 * details width. Instead a MutationObserver reconciles the inline template:
 * while `data-sidebar-collapsed` is present the first track is rewritten to
 * 0px (React rewrites on its own renders; the observer re-corrects in the
 * same microtask, before paint). The frame's grid-track transition animates
 * both directions, so collapse/expand stays a smooth slide. React never
 * reads DOM style back for diffing, so the external write is stable until
 * the next real change.
 */

/**
 * Rewrite the frame's inline grid template with a zero-width first track.
 * Only the AppFrame contract shape is touched — a leading `<number>px`
 * first track followed by more tracks; anything else passes through
 * unchanged (fail soft: an unexpected template means the feature degrades
 * to the stock rail, never a broken frame).
 * @param template - the frame element's inline gridTemplateColumns value.
 * @returns the template with the first track zeroed, or the input unchanged.
 */
export function collapseRailTemplate(template: string): string {
  const match = /^\d+(?:\.\d+)?px(?=\s)/.exec(template)
  if (match === null) return template
  return `0px${template.slice(match[0].length)}`
}

/**
 * Restore a template only while the frame still carries this installer's exact
 * last write. A later React/plugin write owns the value and must win.
 * @param current - template present when cleanup runs.
 * @param owned - exact template last written by this installer.
 * @param original - template captured immediately before that write.
 * @returns the safe cleanup value.
 */
export function restoreRailTemplate(current: string, owned: string, original: string): string {
  return current === owned ? original : current
}

/**
 * The collapsed-rail stylesheet, macOS desktop form factor:
 * - no border seam on the zero-width sidebar column (its 1px border-right
 *   would paint a line at x=0);
 * - the sidebar's NATIVE toggle is hidden while the brand wordmark stays
 *   visible — the desktop keeps exactly ONE sidebar toggle, the persistent
 *   one in the titlebar band. Anchor: the slot system's stable `data-slot`
 *   wrapper (documented addressable seam), then SidebarRoot's first row,
 *   then its last button (the toggle; Tooltip adds no wrapper DOM);
 * - the rail-controls entry: a persistent expand/collapse toggle seated in
 *   the band right of the traffic lights (visible in BOTH states), at
 *   top:8px so its box center (y19) lands on the dropped traffic-light
 *   row's line (the shell insets the lights 3pt down / 6pt right off the
 *   measured 32pt container, inset_traffic_lights), plus the New Session
 *   bubble that appears beside it only while collapsed, sliding in on a
 *   staggered opacity/transform/visibility transition (display cannot
 *   animate). The container never takes pointer events; the toggle always
 *   does, the bubble only while visible.
 * The frame anchor mirrors titlebar.ts: the div whose direct child carries
 * data-shell-overlay; its first element child is the sidebar column.
 * @returns the stylesheet text.
 */
export function railCss(): string {
  return [
    'div[data-sidebar-collapsed]:has(> [data-shell-overlay])>div:nth-child(1){border-right:none;}',
    "div[data-slot='sidebar']>div>div:first-child>button:last-child{display:none;}",
    '[data-desktop-rail-controls]{position:absolute;top:8px;left:86px;height:22px;display:flex;align-items:center;gap:8px;z-index:1;color:var(--dsw-alias-label-primary);pointer-events:none;}',
    '[data-desktop-rail-controls] [data-desktop-rail-button]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;cursor:pointer;color:inherit;pointer-events:auto;position:relative;-webkit-app-region:no-drag!important;}',
    '[data-desktop-rail-controls] [data-desktop-rail-button]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '[data-desktop-rail-controls] [data-desktop-new-session]{opacity:0;visibility:hidden;transform:translateX(12px);pointer-events:none!important;transition:opacity .16s ease,transform .16s ease,visibility 0s linear .16s;}',
    'div[data-sidebar-collapsed] [data-desktop-rail-controls] [data-desktop-new-session]{opacity:1;visibility:visible;transform:none;pointer-events:auto!important;transition:opacity .2s ease .18s,transform .2s ease .18s,visibility 0s;}',
    '@media (prefers-reduced-motion: reduce){[data-desktop-rail-controls] [data-desktop-new-session],div[data-sidebar-collapsed] [data-desktop-rail-controls] [data-desktop-new-session]{transition:none;}}',
  ].join('')
}

/**
 * Append the collapsed-rail stylesheet to the document head.
 *
 * The tag is pre-claimed with `data-plugin`/`data-plugin-css` (the build-time
 * CSS emission convention, tsdown.client.ts): the client module system's
 * `claimStyles` attributes every UNTAGGED `<style>` in the document to
 * whichever plugin materializes next, and a later HMR reload of that plugin
 * would delete the claimed sheet via `removeOwnedStyles` — the 2026-09-08
 * incident where ohmymemo dev rebuilds stripped this stylesheet from the
 * live page (rail controls fell back to unstyled static layout). A claimed
 * tag is only touched by a rebuild of THIS plugin, whose reload re-inserts
 * the sheet anyway. The dedup guard keeps a double apply from stacking
 * identical sheets (same rationale as the stock emission's idempotency
 * check).
 * @param doc - the document to patch (injected for tests).
 * @returns the disposer removing the style element (no-op when deduped).
 */
export function installRailCss(doc: Document): () => void {
  const tagId = 'dsh-desktop-bridge/rail'
  if (doc.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
  const style = doc.createElement('style')
  style.setAttribute('data-desktop-rail', '')
  style.dataset.plugin = 'dsh-desktop-bridge'
  style.dataset.pluginCss = tagId
  style.textContent = railCss()
  doc.head.append(style)
  return () => { style.remove() }
}

/** The AppFrame element: the div whose direct child is the shell overlay layer. */
const FRAME_SELECTOR = 'div:has(> [data-shell-overlay])'

/**
 * Keep the collapsed frame's first grid track at zero width. Watches the
 * frame's `data-sidebar-collapsed` flag and inline style; while collapsed,
 * any first track other than 0px is rewritten (React re-renders included).
 * The frame may not exist at apply time (ui-layout activation order is
 * unconstrained), so a boot observer waits for it to appear.
 * @param doc - the document hosting the app frame.
 * @returns the disposer disconnecting every observer.
 */
export function installRailHider(doc: Document): () => void {
  let frameObserver: MutationObserver | undefined
  let attachedFrame: HTMLElement | undefined
  let originalTemplate: string | undefined
  let ownedTemplate: string | undefined
  const restoreOwnedTemplate = (): void => {
    if (attachedFrame === undefined || originalTemplate === undefined || ownedTemplate === undefined) return
    const current = attachedFrame.style.gridTemplateColumns
    const restored = restoreRailTemplate(current, ownedTemplate, originalTemplate)
    if (restored !== current) attachedFrame.style.gridTemplateColumns = restored
    originalTemplate = undefined
    ownedTemplate = undefined
  }
  const reconcile = (frame: HTMLElement): void => {
    if (!frame.hasAttribute('data-sidebar-collapsed')) return
    const current = frame.style.gridTemplateColumns
    const next = collapseRailTemplate(current)
    // Writing only on change keeps the observer from re-entering on our own write.
    if (next !== current) {
      originalTemplate = current
      ownedTemplate = next
      frame.style.gridTemplateColumns = next
    }
  }
  const attach = (frame: Element): void => {
    const el = frame as HTMLElement
    attachedFrame = el
    reconcile(el)
    frameObserver = new MutationObserver(() => { reconcile(el) })
    frameObserver.observe(el, { attributes: true, attributeFilter: ['style', 'data-sidebar-collapsed'] })
  }
  const dispose = (bootObserver?: MutationObserver): void => {
    bootObserver?.disconnect()
    frameObserver?.disconnect()
    restoreOwnedTemplate()
  }
  const existing = doc.querySelector(FRAME_SELECTOR)
  if (existing !== null) {
    attach(existing)
    return () => { dispose() }
  }
  const bootObserver = new MutationObserver(() => {
    const frame = doc.querySelector(FRAME_SELECTOR)
    if (frame === null) return
    bootObserver.disconnect()
    attach(frame)
  })
  bootObserver.observe(doc.documentElement, { childList: true, subtree: true })
  return () => { dispose(bootObserver) }
}
