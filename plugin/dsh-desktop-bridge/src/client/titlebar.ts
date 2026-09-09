/**
 * macOS titlebar fusion, browser half. The shell builds the main window with
 * `TitleBarStyle::Overlay` and hides the painted title
 * (`NSWindowTitleVisibility::Hidden`): the traffic lights float over the page
 * and no native chrome is drawn. This module owns the CSS half of that
 * contract — the app's columns run edge to edge and their content tops out
 * at y=0 (macOS toolbar look), except the sidebar column whose surface sits
 * under the floating lights and whose content keeps clearing the reserved
 * top band; the drag region the Overlay style requires is a shell.overlay
 * entry (titlebar.tsx). Band controls that moved up to y=0 keep their events
 * via the segmented drag surface's holes (drag-strip.ts). Gated on the
 * shell platform: platforms that keep a native title bar get zero
 * DOM/CSS side effects.
 */

/** Reserved top band height in px (the standard macOS titlebar height). */
export const TITLEBAR_ZONE_PX = 28

import { RAIL_CLEARANCE_VAR } from './rail.ts'

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
 * The band rules. The app frame is the div whose direct child carries
 * `data-shell-overlay` (ui-layout's overlay layer); its first three element
 * children are the sidebar / center / details grid columns.
 *
 * Only the FIRST column keeps the band inset (0.2.0-rc.12): the sidebar
 * surface paints under the floating traffic lights, so its content must
 * clear the band, while the center/details columns run their content up to
 * y=0 — the conversation header and the right-sidebar strip land inside the
 * band like a native macOS toolbar and the blank strip under the lights is
 * gone. Column padding cannot reach two kinds of surfaces, so they get their
 * own rules:
 *
 * - `[data-sidebar-right-panel]` is the runtime's ABSOLUTE right-sidebar
 *   surface (positioned against its zero-width grid column). `push`/`float`
 *   (z-10, under the overlay layer) stay at y=0 and get their strip holed
 *   like every other band control. `fullscreen` (0.2.0-rc.13) keeps its
 *   native `position:fixed; inset:0` and truly takes over the window — an
 *   rc.12 attempt to hold it below the band instead stranded it on a second
 *   row beside the still-visible center header. While fullscreen the panel
 *   (z-40) covers the overlay layer, so the drag segments cannot reach the
 *   band: the first pane's strip background becomes the drag surface (every
 *   interactive child opts out) and pads its left edge past the traffic
 *   lights. The band rail controls stay covered for the whole fullscreen
 *   session — a deliberate tradeoff; exit goes through the panel's own
 *   buttons.
 * - when the sidebar is collapsed the first grid track is 0px wide, so the
 *   center column starts at x=0 and its session header would slide under
 *   BOTH the traffic lights and the band's rail controls (0.2.0-rc.14): the
 *   lights span x≈16–70 but the controls — the persistent toggle plus the
 *   conditional updater, notify bell, and collapsed-only New Session
 *   bubble — run from left:86px to a DYNAMIC right edge, so no fixed
 *   padding can clear them (the rc.13 80px let titles run under the icons).
 *   The clearance is therefore the larger of the light row and the
 *   measured controls edge published as a CSS variable by
 *   installRailClearance (rail.ts); the var() fallback degrades to the
 *   80px light row before the first measurement or if the controls never
 *   appear. The expanded header already clears everything at x≥280.
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
 * The drag surface itself is a set of gap segments inside the slot-rendered
 * host (drag-strip.ts); the segments carry `-webkit-app-region: drag` while
 * the host stays click-through so holes let band controls receive events.
 * `:has()` is supported by every WKWebView new enough to run the shells.
 * @param zonePx - reserved band height in px.
 * @returns the stylesheet text.
 */
export function titlebarCss(zonePx: number): string {
  const band = `${String(zonePx)}px`
  return [
    'html,body{overflow:hidden;}',
    `div:has(> [data-shell-overlay])>div:nth-child(1){box-sizing:border-box;padding-top:${band};}`,
    // rc.13: fullscreen truly takes over (native fixed inset:0, no top
    // offset). The lights only overlap the first pane's strip background;
    // tabs start at x=80 — the same baseline the rail controls sit on.
    '[data-sidebar-right-panel="fullscreen"] [data-dockkit-pane]:first-of-type [data-dockkit-strip]{padding-left:80px;}',
    // The z-40 panel covers the overlay layer, so the drag segments cannot
    // reach the band while fullscreen — the strip background becomes the
    // drag surface and every interactive child opts out.
    '[data-sidebar-right-panel="fullscreen"] [data-dockkit-strip]{-webkit-app-region:drag;}',
    '[data-sidebar-right-panel="fullscreen"] [data-dockkit-strip] :is(button, a[href], [role="button"], [role="tab"], input, textarea, [contenteditable="true"]){-webkit-app-region:no-drag;}',
    // rc.14: the collapsed header clears the measured rail controls, not
    // just the lights — max() keeps the 80px light row as the floor and the
    // var() fallback degrades to it until installRailClearance measures.
    `div[data-sidebar-collapsed]:has(> [data-shell-overlay]) [data-slot="conversation.session.header"]{padding-left:max(80px, var(${RAIL_CLEARANCE_VAR}, 80px));}`,
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
