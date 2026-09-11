/**
 * The three settings-nav glyphs this package paints, as CSS mask data URIs.
 *
 * One visual language: a shared 16x16 viewBox, 1.2-1.4px round-capped strokes,
 * no fill and no colour of their own. The mask paints them in the nav row's
 * own `currentColor`, so hover, the active row and both themes follow the
 * shell automatically — this package never touches a theme token.
 *
 * The masks are what ships; the inline SVG below is only their source, so the
 * geometry stays reviewable instead of being an opaque percent-encoded blob.
 *
 * @module dsh-settings-icons/icons
 */

import type { NavIconTarget } from './inject.ts'

/** Shared drawing surface for every glyph. */
const VIEW_BOX = '0 0 16 16'

/**
 * Wrap a glyph body in the shared outline-group envelope.
 * @param body - the `<path>` elements of the glyph.
 * @param strokeWidth - stroke weight in viewBox units.
 * @returns the standalone SVG document source.
 */
function glyph(body: string, strokeWidth: string): string {
  return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='" + VIEW_BOX + "'>"
    + "<g fill='none' stroke='black' stroke-width='" + strokeWidth + "'"
    + " stroke-linecap='round' stroke-linejoin='round'>" + body + '</g></svg>'
}

/**
 * Encode one glyph as a CSS `mask-image` value.
 * @param svg - the SVG document source.
 * @returns a quoted `url()` wrapping the percent-encoded data URI.
 */
function maskImage(svg: string): string {
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")'
}

/**
 * 使用统计 — three ascending bars on a baseline. A chart, not a gauge: the
 * section is a token/usage report, and the bars read as "volume over time"
 * without the busyness of an axis, a trend line and a plot frame.
 */
const USAGE_STATS = glyph(
  "<path d='M2 13.5h12'/><path d='M4 11V8.75M8 11V5.75M12 11V2.75'/>",
  '1.4',
)

/**
 * MCP — one standalone plug: two prongs entering a rounded body. MCP is a
 * connection protocol, and the plug is its plainest mark; the earlier
 * plug-and-socket draft read as a wiring diagram at 16px, and the cable stub
 * under the body only added a fourth element competing with the prongs.
 */
const MCP = glyph(
  "<path d='M5.5 2v3M10.5 2v3M3.5 5h9v2a4.5 4.5 0 0 1-9 0V5Z'/>",
  '1.25',
)

/**
 * 记忆 — an open-lined brain: two hemispheres split by a centre seam, with two
 * sulci per side. The outline carries the meaning on its own, so the mark
 * survives at 16px where a filled or heavily folded brain would smear.
 */
const MEMORY = glyph(
  "<path d='M7.75 3.55A2.7 2.7 0 0 0 3 2.65a2.35 2.35 0 0 0-1.15 3.9 2.55 2.55 0 0 0 .95 4.25"
  + " 2.65 2.65 0 0 0 4.95 1.3V3.55Z'/>"
  + "<path d='M8.25 3.55A2.7 2.7 0 0 1 13 2.65a2.35 2.35 0 0 1 1.15 3.9 2.55 2.55 0 0 1-.95 4.25"
  + " 2.65 2.65 0 0 1-4.95 1.3V3.55Z'/>"
  + "<path d='M3.35 5.35c1.2-.2 2.1.45 2.2 1.5M2.8 10.8c.1-1.15.85-1.9 1.95-2.05"
  + "M12.65 5.35c-1.2-.2-2.1.45-2.2 1.5M13.2 10.8c-.1-1.15-.85-1.9-1.95-2.05'/>",
  '1.2',
)

/**
 * Section id → glyph. The ids are the `settings.section` registration ids the
 * three owning plugins already use (dsh-usage-stats, dsh-mcp-settings,
 * dsh-ohmymemo); a section that is not mounted is simply never matched.
 */
export const NAV_ICON_TARGETS: readonly NavIconTarget[] = [
  { id: 'usage-stats', mask: maskImage(USAGE_STATS) },
  { id: 'mcp', mask: maskImage(MCP) },
  { id: 'memory', mask: maskImage(MEMORY) },
]
