/**
 * The titlebar drag host, browser half. A macOS Overlay titlebar paints no
 * draggable chrome, so the desktop supplies the drag surface itself. The
 * surface is NOT one full-width strip: the 0.1.2 runtime renders the
 * right-sidebar panel as an absolute surface whose tab strip and pane
 * controls live inside the reserved top band, and a full-width overlay strip
 * above them made those pixels OS-level window-drag (hover cancelled, clicks
 * swallowed). Instead this entry renders a click-through host and the apply
 * world tiles it with gap segments that leave every band control uncovered
 * (drag-strip.ts). Rendered as a shell.overlay entry — the overlay layer
 * spans the full app frame, so `top: 0` is exactly the band the frame
 * padding reserved (titlebar.ts).
 */
import { useEffect, useRef, type ReactElement } from 'react'

import { TITLEBAR_ZONE_PX } from './titlebar.ts'

/** Injected face bound in apply's closure: the segment reconciler mount. */
export interface DragStripInjected {
  /**
   * Tile the host with drag segments and keep them reconciled.
   * @param host - the container div this component rendered.
   * @returns the disposer stopping the reconciler (React effect cleanup).
   */
  mount: (host: HTMLElement) => () => void
}

/**
 * The segment host: transparent, full-band, click-through; only the segment
 * children the reconciler appends take pointer events (and carry drag).
 * @param props.mount - apply-world reconciler entry; owns all subscription
 *   machinery so the component stays declarative.
 * @returns the host element.
 */
export function DesktopDragStrip(props: DragStripInjected): ReactElement {
  const { mount } = props
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return undefined
    return mount(host)
  }, [mount])
  return (
    <div
      data-desktop-drag-strip=""
      ref={hostRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: TITLEBAR_ZONE_PX,
      }}
    />
  )
}
