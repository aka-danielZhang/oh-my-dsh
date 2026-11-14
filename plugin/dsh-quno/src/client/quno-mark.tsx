/**
 * Quno's brand mark: one flat mist-blue disc carrying the white geometric “Q”
 * ring and its tail stroke, with a hairline inner edge and no outer shadow.
 * One SVG source is used everywhere — sidebar entry, header identity, welcome
 * hero, panel header and the message avatar (the latter through a data URI in
 * QUNO_CSS) — so the mark stays identical at every size.
 *
 * The disc stays flat on purpose: it must sit next to native sidebar icons
 * without reading as a glowing app icon (sidebar visual plan, 2026-10-28).
 *
 * @module dsh-quno/client/quno-mark
 */

import React from 'react'

/**
 * Flat disc + ring path, shared by the inline SVG and the CSS data URIs. The
 * avatar is a raster-like CSS background, so its colours cannot come from a
 * CSS variable: the light and dark discs are generated separately and switched
 * by `--quno-mark-message-image`.
 */
function markSvg(fill: string, ring: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<circle cx="16" cy="16" r="16" fill="${fill}"/>`
    + `<circle cx="16" cy="16" r="15.5" fill="none" stroke="${ring}" stroke-width="1"/>`
    + `<g fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round">`
    + `<circle cx="15" cy="14.6" r="7.1"/><path d="M19.4 19 24.3 23.9"/>`
    + `</g></svg>`
}

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Light-theme data URI for CSS backgrounds (the message avatar pseudo-element). */
export const QUNO_MARK_DATA_URI = dataUri(markSvg('#48669D', 'rgba(255,255,255,0.20)'))

/** Dark-theme variant: one step lighter, with a visible tinted hairline. */
export const QUNO_MARK_DATA_URI_DARK = dataUri(markSvg('#4E6DA4', 'rgba(142,169,210,0.45)'))

/** Props of the inline mark. */
export interface QunoMarkProps {
  /** Square edge in pixels. */
  readonly size?: number
  /** Extra style for alignment (margin and the like); never a shadow. */
  readonly style?: React.CSSProperties
}

/** The flat Q disc, sized by the caller. */
export function QunoMark({ size = 20, style }: QunoMarkProps): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--quno-mark-bg, #48669D)',
        boxShadow: 'inset 0 0 0 0.5px var(--quno-mark-ring, rgba(255,255,255,0.22))',
        userSelect: 'none',
        ...style,
      }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 32 32" fill="none">
        <g stroke="#FFFFFF" strokeWidth="3.1" strokeLinecap="round">
          <circle cx="15" cy="14.6" r="7.1" />
          <path d="M19.4 19 24.3 23.9" />
        </g>
      </svg>
    </span>
  )
}
