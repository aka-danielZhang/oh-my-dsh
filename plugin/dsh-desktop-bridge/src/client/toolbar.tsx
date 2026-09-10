/**
 * The unified desktop toolbar, browser half (macOS only): the bridge's
 * occupant of ui-layout's `shell.toolbar` slot — a real first grid row, not
 * an overlay. Single 38px row whose center line rides the traffic lights'
 * dropped center; the leading 86px inset leaves the native light row alone;
 * the row background is the window drag region and every interactive child
 * opts out.
 *
 * Three zones:
 * - Leading: the light inset, the ONE sidebar toggle, bounded session
 *   back/forward (transient selection history from the session controller),
 *   and New Session — always available, no collapsed-only bubble anymore.
 * - Center: the two portal HOST cells (callback refs through
 *   ToolbarHostPublisher). ui-conversation's session header portals its
 *   title cluster and utilities into `centerHost`, and the rightbar corner
 *   into `sessionEndHost` so it stays the trailing item. Host absence (old
 *   runtime, bridge unmount) leaves the header in place — graceful on both
 *   sides.
 * - Trailing: the surface switch (same native shell menu the brand-area
 *   right-click fires), the conditional updater, the notify bell, then the
 *   session-end host cell.
 *
 * The workspace pill derives from the Session/Workspace mirror (the same
 * ownership walk the hero chip does); with no owning workspace it renders
 * nothing — never a dead control.
 */
import type { ReactElement } from 'react'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14,
  IconNewChatOutline16, IconPanelLeftOutline16, IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { UpdateControl } from './update-indicator.tsx'
import { NotifyCenter, type NotifyCenterInjected } from './notify-center.tsx'
import type { DesktopUpdaterInjected } from './updates.ts'
import type { ToolbarHostPublisher } from './toolbar-hosts.ts'

/**
 * The session-maybe runtime shares the toolbar consumes, declared locally as
 * a structural twin of the fork's `PropsRuntime<'shell.toolbar'>`: the
 * bridge devDeps still pin the pre-toolbar registry (the fork revision
 * shipping `shell.toolbar` is pending), so the real slot-keyed type is not
 * importable yet. Replace this twin with the PropsRuntime form when the
 * devDeps bump lands — the runtime object is structurally compatible either
 * way.
 */
export interface ToolbarRuntimeShares {
  /** Current session id, undefined while no session is current. */
  readonly sessionId?: string
  /** The workspace mirror feed (only the ownership walk the pill performs). */
  useWorkspaces(select: (state: {
    items: ReadonlyArray<{ readonly sessionIds: ReadonlyArray<string>, readonly title?: string }>
  }) => string | undefined): string | undefined
}

/** Injected face bound in apply's closure: band gestures, hosts, history. */
export interface DesktopToolbarInjected extends DesktopUpdaterInjected, NotifyCenterInjected {
  /** Toggle the sidebar panel both ways (ctx.layout, resolved lazily per click). */
  toggleSidebar: () => void
  /** The shared New Session action (ctx.uiWorkspace.startSession). */
  startSession: () => void
  /** Fire the shell's native surface-switch menu (same as the brand right-click). */
  switchSurface: () => void
  /** Whether transient selection history has an older entry. */
  canBack: () => boolean
  /** Whether transient selection history has a newer entry. */
  canForward: () => boolean
  /** Select the previous history entry. */
  back: () => void
  /** Select the next history entry. */
  forward: () => void
  /** Callback refs publishing the two portal hosts (identity-guarded). */
  readonly centerRef: (el: HTMLElement | null) => void
  readonly endRef: (el: HTMLElement | null) => void
}

/**
 * Full toolbar props: the structural session-maybe runtime shares, the
 * injected face, and the locale seat.
 */
export type DesktopToolbarProps =
  & ToolbarRuntimeShares
  & DesktopToolbarInjected
  & PropsLocale<'desktop-bridge'>

/** One toolbar icon button (26px hit, no-drag via the sheet's child rule). */
function ToolbarButton(props: {
  label: string
  disabled?: boolean
  onClick: () => void
  nav?: boolean
  children: ReactElement
}): ReactElement {
  return (
    <button
      type="button"
      data-desktop-rail-button=""
      {...props.nav ? { 'data-desktop-toolbar-nav': '' } : {}}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => { props.onClick() }}
    >
      {props.children}
    </button>
  )
}

/**
 * The workspace pill: the owning workspace's title from the live mirror, or
 * nothing — an unnamed session renders no pill rather than a dead control.
 * @param props - session id plus the standard workspace feed.
 * @returns the pill, or null.
 */
function WorkspacePill(props: {
  sessionId: DesktopToolbarProps['sessionId']
  useWorkspaces: DesktopToolbarProps['useWorkspaces']
}): ReactElement | null {
  const sessionId = props.sessionId
  const title = props.useWorkspaces(s => sessionId === undefined
    ? undefined
    : s.items.find(workspace => workspace.sessionIds.includes(sessionId))?.title)
  if (title === undefined) return null
  return <span data-desktop-toolbar-workspace="" title={title}>{title}</span>
}

/**
 * The unified toolbar row (see module doc).
 * @param props - the injected face plus session shares and the locale seat.
 * @returns the toolbar element.
 */
export function DesktopToolbar(props: DesktopToolbarProps): ReactElement {
  const {
    sessionId, useWorkspaces,
    toggleSidebar, startSession, switchSurface,
    canBack, canForward, back, forward,
    centerRef, endRef, t,
  } = props
  return (
    <div data-desktop-toolbar="" role="toolbar" aria-label={t('toolbar.label')}>
      <div data-desktop-toolbar-leading="">
        <ToolbarButton label={t('rail.toggle')} onClick={() => { toggleSidebar() }}>
          <IconPanelLeftOutline16 size={16} />
        </ToolbarButton>
        <ToolbarButton nav label={t('toolbar.back')} disabled={!canBack()} onClick={() => { back() }}>
          <IconChevronLeftOutline14 size={14} />
        </ToolbarButton>
        <ToolbarButton nav label={t('toolbar.forward')} disabled={!canForward()} onClick={() => { forward() }}>
          <IconChevronRightOutline14 size={14} />
        </ToolbarButton>
        <ToolbarButton label={t('rail.newSession')} onClick={() => { startSession() }}>
          <IconNewChatOutline16 size={16} />
        </ToolbarButton>
      </div>
      <div data-desktop-toolbar-center="" ref={centerRef} />
      <WorkspacePill sessionId={sessionId} useWorkspaces={useWorkspaces} />
      <div data-desktop-toolbar-trailing="">
        <ToolbarButton label={t('toolbar.surface')} onClick={() => { switchSurface() }}>
          <IconRefreshOutline16 size={16} />
        </ToolbarButton>
        <UpdateControl {...props} />
        <NotifyCenter {...props} />
        <div data-desktop-toolbar-end="" ref={endRef} />
      </div>
    </div>
  )
}
