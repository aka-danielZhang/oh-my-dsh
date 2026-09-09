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
 *
 * The band controls this module seats (rail-controls.tsx) also shadow the
 * collapsed center column's session header, so the same module publishes
 * their measured right edge as a document CSS variable
 * (installRailClearance) for titlebar.ts's collapsed-header clearance rule
 * to consume — the avoidance must cover the controls' live width, not just
 * the traffic-light row.
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

/** Document CSS variable publishing the rail controls' measured right edge (installRailClearance). */
export const RAIL_CLEARANCE_VAR = '--desktop-band-controls-right'

/** Breathing room kept between the rail controls' right edge and the header content (px). */
export const RAIL_CLEARANCE_GAP_PX = 8

/** The rail-controls container rendered by the shell.overlay entry (rail-controls.tsx). */
const RAIL_CONTROLS_SELECTOR = '[data-desktop-rail-controls]'

/**
 * The clearance value for the collapsed session header: the rail controls'
 * right edge plus the breathing gap. `Math.ceil` so fractional layout widths
 * never shave the gap.
 * @param right - the rail-controls container's viewport right edge in px.
 * @param gap - breathing room past the right edge (px).
 * @returns the CSS length to publish as RAIL_CLEARANCE_VAR.
 */
export function railClearanceValue(right: number, gap = RAIL_CLEARANCE_GAP_PX): string {
  return `${String(Math.ceil(right + gap))}px`
}

/** Observer constructors read off the injected window so tests can stub them. */
type ObserverWindow = Window & {
  ResizeObserver?: typeof ResizeObserver
  MutationObserver?: typeof MutationObserver
}

/**
 * Publish the rail controls' right edge as a document CSS variable.
 *
 * The collapsed-header clearance rule (titlebar.ts) consumes it via
 * `max(80px, var(--desktop-band-controls-right, 80px))`: rc.13's fixed 80px
 * only cleared the traffic lights (x≈16–70), while the rail controls
 * themselves occupy the same band from x=86 rightward — the persistent
 * toggle, the conditional updater button, the notify bell, and the
 * collapsed-only New Session bubble stretch to roughly x≈350, and their
 * width is dynamic (the updater and the bell mount/unmount with state). A
 * ResizeObserver on the container keeps the published edge in step with
 * every such change.
 *
 * The container is SLOT-rendered (rail-controls.tsx via shell.overlay), so
 * its DOM lifetime outlives any single node: `slots.inject` reruns on every
 * slot-owner redeclaration, and a ui-layout remount unmounts the old node
 * and mounts a fresh one while THIS effect keeps running. A child-list
 * MutationObserver therefore stays alive for the whole effect and every
 * reconcile compares the selector's current node with the observed one: a
 * replacement rebinds the ResizeObserver onto the new node and republishes
 * immediately, and a temporary absence (between unmount and remount)
 * removes the variable so the consuming rule falls back to its 80px floor.
 * An observer left bound to a detached node is exactly the failure this
 * guards against — its rect reads 0 (publishing a useless 8px that max()
 * clamps away) or it simply never fires again, and the header re-overlaps
 * the controls until a full reload.
 *
 * Measurement lives in this apply-world installer on purpose: components
 * stay subscription-free (the repo convention); the frame sits at the
 * viewport origin, so `getBoundingClientRect().right` is directly usable
 * as the header's padding-left. The New Session bubble animates via
 * `visibility` (its box never collapses), so collapse/expand needs no
 * special handling — the observer covers every real width change.
 *
 * Fail-soft: when observers are missing the installer no-ops and the
 * consuming rule degrades to its own 80px fallback.
 * @param doc - the document hosting the rail controls.
 * @returns the disposer disconnecting observers and removing the variable.
 */
export function installRailClearance(doc: Document): () => void {
  const win = doc.defaultView as ObserverWindow | null
  if (win === null || win.ResizeObserver === undefined || win.MutationObserver === undefined) return () => {}
  let observed: Element | undefined
  let observer: ResizeObserver | undefined
  const publish = (el: Element): void => {
    doc.documentElement.style.setProperty(RAIL_CLEARANCE_VAR, railClearanceValue(el.getBoundingClientRect().right))
  }
  const detach = (): void => {
    observer?.disconnect()
    observer = undefined
    observed = undefined
    doc.documentElement.style.removeProperty(RAIL_CLEARANCE_VAR)
  }
  const reconcile = (): void => {
    const el = doc.querySelector(RAIL_CONTROLS_SELECTOR)
    // Absent (between unmount and remount): drop the variable so the rule
    // falls back to its 80px floor instead of trusting a stale edge.
    if (el === null) {
      if (observed !== undefined) detach()
      return
    }
    if (el === observed) return
    // First attach, or the slot redeclared and replaced the node: bind the
    // observer to the CURRENT node and publish its edge right away.
    observer?.disconnect()
    observed = el
    publish(el)
    observer = new win.ResizeObserver!(() => { if (observed !== undefined) publish(observed) })
    observer.observe(el)
  }
  reconcile()
  const watch = new win.MutationObserver!(reconcile)
  watch.observe(doc.documentElement, { childList: true, subtree: true })
  return () => {
    watch.disconnect()
    detach()
  }
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
