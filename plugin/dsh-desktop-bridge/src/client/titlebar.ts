/**
 * macOS titlebar fusion, browser half. The shell builds the main window with
 * `TitleBarStyle::Overlay` and hides the painted title
 * (`NSWindowTitleVisibility::Hidden`): the traffic lights float over the page
 * and no native chrome is drawn.
 *
 * Since the unified toolbar (bridge 0.2.0-rc.14) the desktop's band layout
 * lives in ui-layout's `shell.toolbar` slot — a real first grid row owned by
 * the frame, occupied by the bridge's DesktopToolbar with the floating
 * lights inside its leading inset. THIS module now only carries the
 * pre-toolbar fallback: until the toolbar publishes its
 * `data-shell-toolbar-on` marker on the document root, the legacy rules hold
 * (the sidebar column clears the lights; a collapsed session header clears
 * the light row with a fixed 80px inset). Once the toolbar mounts, its grid
 * row pushes every column below the band and the header portals into the
 * toolbar, so both legacy rules turn themselves off — plain web, Windows,
 * and Linux never see any of this (the gate is the macOS platform only).
 *
 * The fullscreen right-sidebar keeps its rc.13 semantics untouched: a fixed
 * `inset: 0` takeover whose first pane strip clears the lights and carries
 * the drag region itself (the toolbar stays mounted underneath the z-40
 * panel and resumes drag duty on exit).
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
 * The band rules. See the module doc: every layout rule here is scoped to
 * `html:not([data-desktop-toolbar])` — the pre-toolbar fallback posture —
 * because the toolbar's grid row supersedes them the moment it mounts.
 *
 * - The sidebar column keeps its band inset while no toolbar exists: its
 *   surface paints under the floating traffic lights, so its content must
 *   clear the band. With the toolbar mounted the columns start below the
 *   first grid row and no inset is needed.
 * - A collapsed session header keeps the fixed 80px light-row inset while
 *   no toolbar exists (the same baseline the toolbar's leading inset sits
 *   on; the rc.14 dynamic-clearance experiment is superseded by the
 *   toolbar). With the toolbar mounted the header portals INTO the toolbar
 *   and the in-body header collapses to `display: contents`, so the rule
 *   has no target anyway.
 * - The fullscreen right-sidebar is NOT fallback-scoped: it keeps its
 *   native `position: fixed; inset: 0` takeover in every posture, and its
 *   first pane strip clears the lights (the toolbar is covered by the z-40
 *   panel while fullscreen, so the strip IS the drag surface — every
 *   interactive child opts out).
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
 * `:has()` is supported by every WKWebView new enough to run the shells.
 * @param zonePx - reserved band height in px.
 * @returns the stylesheet text.
 */
export function titlebarCss(zonePx: number): string {
  const band = `${String(zonePx)}px`
  const pre = 'html:not([data-shell-toolbar-on])'
  return [
    'html,body{overflow:hidden;}',
    `${pre} div:has(> [data-shell-overlay])>div:nth-child(1){box-sizing:border-box;padding-top:${band};}`,
    // Fullscreen truly takes over (native fixed inset:0, no top offset). The
    // lights only overlap the first pane's strip background; tabs start at
    // x=80 — the same baseline the toolbar's leading inset sits on.
    '[data-sidebar-right-panel="fullscreen"] [data-dockkit-pane]:first-of-type [data-dockkit-strip]{padding-left:80px;}',
    // The z-40 panel covers the overlay layer AND the toolbar, so the strip
    // background becomes the drag surface and every interactive child opts
    // out.
    '[data-sidebar-right-panel="fullscreen"] [data-dockkit-strip]{-webkit-app-region:drag;}',
    '[data-sidebar-right-panel="fullscreen"] [data-dockkit-strip] :is(button, a[href], [role="button"], [role="tab"], input, textarea, [contenteditable="true"]){-webkit-app-region:no-drag;}',
    `${pre} div[data-sidebar-collapsed]:has(> [data-shell-overlay]) [data-slot="conversation.session.header"]{padding-left:80px;}`,
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
