/**
 * Sidebar collapse suppression + desktop toolbar styling, browser half
 * (macOS overlay titlebar only).
 *
 * ui-layout never removes the closed sidebar: the AppFrame solves it to the
 * fixed 56px control rail (SIDEBAR_COLLAPSED) and keeps the rail UI mounted.
 * Under the shell's floating traffic lights that rail is a dead strip under
 * the close/minimize/zoom buttons, so the desktop form factor hides the
 * column outright and replaces it with the unified toolbar (toolbar.tsx),
 * which mounts into ui-layout's `shell.toolbar` slot — a real grid row, not
 * an overlay.
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
 * The desktop styling sheet, macOS desktop form factor:
 * - no border seam on the zero-width sidebar column (its 1px border-right
 *   would paint a line at x=0);
 * - the sidebar's NATIVE toggle is hidden while the brand wordmark stays
 *   visible — the desktop keeps exactly ONE sidebar toggle, the one in the
 *   unified toolbar. Anchor: the slot system's stable `data-slot` wrapper
 *   (documented addressable seam), then SidebarRoot's first row, then its
 *   last button (the toggle; Tooltip adds no wrapper DOM);
 * - the `shell.toolbar` occupant (toolbar.tsx) rides the frame's own three
 *   tracks: `[data-shell-toolbar-row]` (AppFrame's first-row wrapper)
 *   becomes a `subgrid`, the slot anchor is already `display: contents`
 *   (inline, ui-renderer's ANCHOR_STYLE), and the toolbar root spans
 *   `1 / -1` as a nested subgrid — so a `grid-column: 2 / -1` main lane
 *   starts exactly at the conversation column's edge and follows sidebar
 *   drags, the concession solve, and the collapse animation with zero JS
 *   measurement. The 38px row's center line (y19) rides the traffic
 *   lights' dropped center; the root is the drag background with every
 *   interactive child opting out;
 * - the sidebar-tinted segment is a `::before` pinned to grid column 1
 *   only: expanded, the toolbar's first segment continues the sidebar's
 *   fill; collapsed (first track already 0px) it vanishes instead of
 *   painting a full-window dark band;
 * - the controls cluster (toggle / updater / bell / New Session) is an
 *   IN-FLOW grid item in column 1 after the 86px light inset — never
 *   absolutely positioned: the v1 overlay cluster lost click hit-testing
 *   against the main lane's box. Collapsed, the zero-width first track
 *   lets the cluster's min-content box overflow rightward past the lights;
 *   the main lane yields content-aware clearance: 176px for the normal
 *   toggle / bell / New Session trio, promoted to 204px only while the
 *   conditional updater button exists. Both leave 8px after the actual last
 *   control, ride the frame's track curve, and disable under reduced motion.
 *   New Session is revealed only while collapsed —
 *   expanded, the sidebar's own primary button owns that action. Both state
 *   rules carry `!important`: the rail-button reset later in this sheet
 *   re-asserts `display:inline-flex` at equal specificity, and sheet order
 *   would silently un-hide the button in the expanded state;
 * - the center host restores the header's TWO semantic clusters. The fork
 *   portals exactly [titleCluster, headerUtilities]: titleCluster contains
 *   crumbs + session actions (Creator mode, model, Session log) and stays
 *   compact at the conversation edge; headerUtilities (Thread and future
 *   panel tools) uses margin-left:auto and joins the trailing rightbar corner
 *   at the far edge. Stock private gaps/margins are flattened: session
 *   content keeps an 8px rhythm, while Thread → rightbar corner uses the
 *   same 2px chrome-control gap as toggle → bell on the left. The host grows
 *   to own the flexible middle space, but neither cluster does; an empty center
 *   therefore still leaves the non-shrinking corner at the trailing edge;
 * - the main lane is `pointer-events: none` with the center/trailing hosts
 *   re-enabling it, so the collapsed control cluster (z-index:1 grid item
 *   above the lane) always wins the hit test in its zone while portalled
 *   title/actions keep clicking;
 * - every interactive child opts out of the drag region with `!important`:
 *   the rail buttons' `all:unset` would otherwise wipe the no-drag hole
 *   (the update-indicator precedent);
 * - responsive tier: below 1100px the center truncates with ellipsis.
 * The frame anchor mirrors titlebar.ts: the div whose direct child carries
 * data-shell-overlay; its first element child is the sidebar column.
 * @returns the stylesheet text.
 */
export function railCss(): string {
  return [
    'div[data-sidebar-collapsed]:has(> [data-shell-overlay])>div:nth-child(1){border-right:none;}',
    "div[data-slot='sidebar']>div>div:first-child>button:last-child{display:none;}",
    '[data-shell-toolbar-row]{display:grid;grid-template-columns:subgrid;}',
    '[data-desktop-toolbar]{position:relative;display:grid;grid-template-columns:subgrid;grid-column:1/-1;height:38px;min-width:0;-webkit-app-region:drag;background:var(--dsw-alias-bg-base);border-bottom:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);}',
    '[data-desktop-toolbar]::before{content:"";grid-column:1;grid-row:1;background:var(--dsw-specific-sidebar-fill);border-right:0.5px solid var(--dsw-alias-border-l3);}',
    '[data-desktop-toolbar-controls]{grid-column:1;grid-row:1;justify-self:start;z-index:1;display:flex;align-items:center;gap:2px;padding-left:86px;}',
    '[data-desktop-toolbar] [data-desktop-toolbar-new]{display:none!important;}',
    '[data-sidebar-collapsed] [data-desktop-toolbar] [data-desktop-toolbar-new]{display:inline-flex!important;}',
    '[data-desktop-toolbar-main]{grid-column:2/-1;grid-row:1;display:flex;align-items:center;gap:2px;min-width:0;padding-left:12px;padding-right:8px;pointer-events:none;transition:padding-left var(--ds-transition-duration-slow) var(--ds-ease-in-out);}',
    '[data-sidebar-collapsed] [data-desktop-toolbar-main]{padding-left:176px;}',
    '[data-sidebar-collapsed] [data-desktop-toolbar]:has([data-desktop-update-button]) [data-desktop-toolbar-main]{padding-left:204px;}',
    '[data-desktop-toolbar-center]{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;pointer-events:auto;}',
    '[data-desktop-toolbar-center]>*{min-width:0;gap:8px;margin:0;}',
    '[data-desktop-toolbar-center]>:first-child{flex:0 1 auto;}',
    '[data-desktop-toolbar-center]>:last-child{flex:none;margin-left:auto;}',
    '[data-desktop-toolbar-trailing]{display:flex;align-items:center;gap:2px;flex:none;pointer-events:auto;}',
    '[data-desktop-toolbar-end] [data-conversation-header-corner]{margin:0;}',
    '[data-desktop-toolbar] button,[data-desktop-toolbar] a[href],[data-desktop-toolbar] input,[data-desktop-toolbar] textarea,[data-desktop-toolbar] [role="button"],[data-desktop-toolbar] [role="tab"]{-webkit-app-region:no-drag!important;}',
    '[data-desktop-toolbar] [data-desktop-rail-button]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;cursor:pointer;color:inherit;position:relative;}',
    '[data-desktop-toolbar] [data-desktop-rail-button]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '@media (prefers-reduced-motion:reduce){[data-desktop-toolbar-main]{transition:none;}}',
    '@media (max-width: 1099px){[data-desktop-toolbar-center]{overflow:hidden;}[data-desktop-toolbar-center]>*{flex-shrink:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}',
  ].join('')
}

/**
 * Append the desktop styling sheet to the document head.
 *
 * The tag is pre-claimed with `data-plugin`/`data-plugin-css` (the build-time
 * CSS emission convention, tsdown.client.ts): the client module system's
 * `claimStyles` attributes every UNTAGGED `<style>` in the document to
 * whichever plugin materializes next, and a later HMR reload of that plugin
 * would delete the claimed sheet via `removeOwnedStyles` — the 2026-09-08
 * incident where ohmymemo dev rebuilds stripped this stylesheet from the
 * live page. A claimed tag is only touched by a rebuild of THIS plugin,
 * whose reload re-inserts the sheet anyway. The dedup guard keeps a double
 * apply from stacking identical sheets (same rationale as the stock
 * emission's idempotency check).
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
