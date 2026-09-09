/**
 * macOS titlebar fusion, browser half. The shell builds the main window with
 * `TitleBarStyle::Overlay` and hides the painted title
 * (`NSWindowTitleVisibility::Hidden`): the traffic lights float over the page
 * and no native chrome is drawn. This module owns the CSS half of that
 * contract — the app's columns run edge to edge (their surfaces paint under
 * the lights) while each column's content keeps clearing the reserved top
 * band, so no interactive row sits under the lights; the drag region the
 * Overlay style requires is a shell.overlay entry (titlebar.tsx). Gated on
 * the shell platform: platforms that keep a native title bar get zero
 * DOM/CSS side effects.
 */

/** Reserved top band height in px (the standard macOS titlebar height). */
export const TITLEBAR_ZONE_PX = 28

/**
 * Whether the overlay-titlebar fusion applies to this shell platform. The
 * shell injects `std::env::consts::OS` as the gate's platform, and only the
 * macOS window is built with `TitleBarStyle::Overlay`.
 * @param platform - the gate signal's platform string.
 * @returns true when the page must reserve the titlebar band.
 */
export function shouldFuseTitlebar(platform: string): boolean {
  return platform === 'macos'
}

/**
 * The column-inset rule. The app frame is the div whose direct child carries
 * `data-shell-overlay` (ui-layout's overlay layer); its first three element
 * children are the sidebar / center / details grid columns. Padding the
 * frame itself (the previous contract) pushed the column SURFACES below the
 * band too, leaving a blank strip under the floating lights. Padding each
 * column instead keeps every surface edge to edge — the sidebar fill runs
 * under the traffic lights, the native-app look — while the content of all
 * three columns starts below the band. The absolutely-positioned overlay
 * layer still spans the full frame, so the drag strip lands exactly inside
 * the band. `:has()` and `:nth-child(-n+3)` are supported by every WKWebView
 * new enough to run Tauri 2.
 *
 * The same sheet locks the document itself non-scrollable: the app is a
 * fixed-viewport shell (html/body/#root height 100%), and any scrollable
 * surplus on the root scroller — e.g. AppKit handing the WKWebView's scroll
 * view titlebar-height content insets under the Overlay titlebar, which the
 * shell also disables natively — only ever manifests as chained scrolling
 * shifting the whole page a few pixels under the lights (the band controls
 * "drifting up" until a resize clamps it). `overflow: hidden` on the root
 * pair makes the document unscrollable so the band geometry stays put.
 *
 * Two more rules complete the band contract:
 * - `[data-sidebar-right-panel]` is the runtime's ABSOLUTE right-sidebar
 *   surface (positioned against its zero-width grid column), so the column
 *   padding above never reaches it: without an explicit top offset its
 *   dockkit tab strip renders at y=0 — inside the band (docked) or under
 *   the floating traffic lights (maximized). Pushing its top edge down by
 *   the band height aligns it with the padded columns in every panel mode.
 * - the drag surface is a set of gap segments inside the slot-rendered host
 *   (drag-strip.ts); the segments carry `-webkit-app-region: drag` while the
 *   host stays click-through so holes let band controls receive events.
 * @param zonePx - reserved band height in px.
 * @returns the stylesheet text.
 */
export function titlebarCss(zonePx: number): string {
  const band = `${String(zonePx)}px`
  return [
    'html,body{overflow:hidden;}',
    `div:has(> [data-shell-overlay])>div:nth-child(-n+3){box-sizing:border-box;padding-top:${band};}`,
    `[data-sidebar-right-panel]{top:${band}!important;}`,
    '[data-desktop-drag-strip]{pointer-events:none;}',
    '[data-desktop-drag-seg]{position:absolute;top:0;bottom:0;-webkit-app-region:drag;pointer-events:auto;}',
  ].join('')
}

/**
 * Append the frame-padding stylesheet to the document head.
 *
 * Pre-claimed with `data-plugin`/`data-plugin-css` and dedup-guarded exactly
 * like installRailCss (rail.ts) — see the 2026-09-08 incident note: an
 * untagged sheet gets attributed to whichever plugin materializes next and
 * is deleted by that plugin's next HMR reload.
 * @param doc - the document to patch (injected for tests).
 * @param zonePx - reserved band height in px.
 * @returns the disposer removing the style element (no-op when deduped).
 */
export function installTitlebarCss(doc: Document, zonePx: number): () => void {
  const tagId = 'dsh-desktop-bridge/titlebar'
  if (doc.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
  const style = doc.createElement('style')
  style.setAttribute('data-desktop-titlebar', '')
  style.dataset.plugin = 'dsh-desktop-bridge'
  style.dataset.pluginCss = tagId
  style.textContent = titlebarCss(zonePx)
  doc.head.append(style)
  return () => { style.remove() }
}
