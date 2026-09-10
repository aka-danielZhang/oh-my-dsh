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
 * - the `shell.toolbar` occupant (toolbar.tsx): a 38px single-row toolbar —
 *   the row's center line (y19) rides the traffic lights' dropped center —
 *   with a native drag background and interactive children opting out, a
 *   leading 86px light inset, a flexible center that receives the session
 *   header's portal, and a trailing cluster whose last cell receives the
 *   rightbar corner portal so it stays the trailing item;
 * - responsive tiers per the toolbar contract: below 1100px the center
 *   truncates with ellipsis; below 768px the navigation and workspace
 *   affordances drop instead of shrinking type.
 * The frame anchor mirrors titlebar.ts: the div whose direct child carries
 * data-shell-overlay; its first element child is the sidebar column.
 * @returns the stylesheet text.
 */
export function railCss(): string {
  return [
    'div[data-sidebar-collapsed]:has(> [data-shell-overlay])>div:nth-child(1){border-right:none;}',
    "div[data-slot='sidebar']>div>div:first-child>button:last-child{display:none;}",
    '[data-desktop-toolbar]{position:relative;display:flex;align-items:stretch;height:38px;min-width:0;-webkit-app-region:drag;background:var(--dsw-specific-sidebar-fill);border-bottom:0.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary);}',
    '[data-desktop-toolbar] button,[data-desktop-toolbar] a[href],[data-desktop-toolbar] input,[data-desktop-toolbar] textarea,[data-desktop-toolbar] [role="button"],[data-desktop-toolbar] [role="tab"]{-webkit-app-region:no-drag;}',
    '[data-desktop-toolbar-leading]{display:flex;align-items:center;gap:2px;flex:none;padding-left:86px;}',
    '[data-desktop-toolbar-center]{flex:1 1 0;min-width:0;display:flex;align-items:center;gap:8px;padding:0 12px;}',
    '[data-desktop-toolbar-center]>*{min-width:0;}',
    '[data-desktop-toolbar-workspace]{flex:none;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:18px;}',
    '[data-desktop-toolbar-trailing]{display:flex;align-items:center;gap:2px;flex:none;padding-right:8px;}',
    '[data-desktop-toolbar] [data-desktop-rail-button]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;cursor:pointer;color:inherit;position:relative;}',
    '[data-desktop-toolbar] [data-desktop-rail-button]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
    '[data-desktop-toolbar] [data-desktop-rail-button]:disabled{opacity:0.35;cursor:default;}',
    '[data-desktop-toolbar] [data-desktop-rail-button]:disabled:hover{background:none;}',
    '@media (max-width: 1099px){[data-desktop-toolbar-center]{overflow:hidden;}[data-desktop-toolbar-center]>*{flex-shrink:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}}',
    '@media (max-width: 767px){[data-desktop-toolbar-nav],[data-desktop-toolbar-workspace]{display:none;}}',
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
