/**
 * The unified desktop toolbar, browser half (macOS only): the bridge's
 * occupant of ui-layout's `shell.toolbar` slot — a real first grid row, not
 * an overlay. The row re-exposes the AppFrame's three tracks as a subgrid
 * (rail.ts), so the session-title host starts exactly at the conversation
 * column's left edge while the sidebar is expanded and follows its drag
 * live; with the sidebar collapsed (rail.ts zeroes the first track) the
 * controls flow across the full row and the main lane's fixed left
 * clearance clears them instead. The row background is the window drag
 * region and every interactive child opts out — with `!important`, so the
 * rail buttons' `all:unset` can never wipe the no-drag hole.
 *
 * Two zones, both IN-FLOW grid items (an absolutely-positioned overlay
 * cluster lost click hit-testing against the main lane's box — the v1
 * rework regression this layout fixes):
 * - Controls: grid column 1, mirroring the pre-toolbar title band's left
 *   cluster — the ONE sidebar toggle, the conditional updater, the notify
 *   bell, and New Session. New Session stays hidden while the sidebar is
 *   expanded (the sidebar's own primary button owns that state) and appears
 *   only collapsed. No back/forward history chrome and no surface-switch
 *   glyph: those duplicated existing affordances or misread as something
 *   else.
 * - Main: the session-header center host (title/actions/utilities portal)
 *   plus the trailing cluster, which now holds only the session-end host
 *   cell keeping the rightbar corner last. Host absence (old runtime,
 *   bridge unmount) leaves the header in place — graceful on both sides.
 */
import type { ReactElement } from 'react'
import {
  IconNewChatOutline16, IconPanelLeftOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { UpdateControl } from './update-indicator.tsx'
import { NotifyCenter, type NotifyCenterInjected } from './notify-center.tsx'
import type { DesktopUpdaterInjected } from './updates.ts'

/** Injected face bound in apply's closure: band gestures and portal hosts. */
export interface DesktopToolbarInjected extends DesktopUpdaterInjected, NotifyCenterInjected {
  /** Toggle the sidebar panel both ways (ctx.layout, resolved lazily per click). */
  toggleSidebar: () => void
  /** The shared New Session action (ctx.uiWorkspace.startSession). */
  startSession: () => void
  /** Callback refs publishing the two portal hosts (identity-guarded). */
  readonly centerRef: (el: HTMLElement | null) => void
  readonly endRef: (el: HTMLElement | null) => void
}

/**
 * Full toolbar props: the injected face and the locale seat. The slot's
 * session-maybe runtime shares (sessionId/useSessions/…) still arrive from
 * the framework; this toolbar derives nothing from them anymore.
 */
export type DesktopToolbarProps =
  & DesktopToolbarInjected
  & PropsLocale<'desktop-bridge'>

/**
 * One toolbar icon button (26px hit). `collapsedOnly` marks New Session so
 * the sheet can reveal it only while the sidebar is collapsed.
 */
function ToolbarButton(props: {
  label: string
  onClick: () => void
  collapsedOnly?: boolean
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      data-desktop-rail-button=""
      {...props.collapsedOnly ? { 'data-desktop-toolbar-new': '' } : {}}
      aria-label={props.label}
      title={props.label}
      onClick={() => { props.onClick() }}
    >
      {props.children}
    </button>
  )
}

/**
 * The unified toolbar row (see module doc).
 * @param props - the injected face plus the locale seat.
 * @returns the toolbar element.
 */
export function DesktopToolbar(props: DesktopToolbarProps): ReactElement {
  const {
    toggleSidebar, startSession,
    centerRef, endRef, t,
  } = props
  return (
    <div data-desktop-toolbar="" role="toolbar" aria-label={t('toolbar.label')}>
      <div data-desktop-toolbar-controls="">
        <ToolbarButton label={t('rail.toggle')} onClick={() => { toggleSidebar() }}>
          <IconPanelLeftOutline16 size={16} />
        </ToolbarButton>
        <UpdateControl {...props} />
        <NotifyCenter {...props} />
        <ToolbarButton collapsedOnly label={t('rail.newSession')} onClick={() => { startSession() }}>
          <IconNewChatOutline16 size={16} />
        </ToolbarButton>
      </div>
      <div data-desktop-toolbar-main="">
        <div data-desktop-toolbar-center="" ref={centerRef} />
        <div data-desktop-toolbar-trailing="">
          <div data-desktop-toolbar-end="" ref={endRef} />
        </div>
      </div>
    </div>
  )
}
