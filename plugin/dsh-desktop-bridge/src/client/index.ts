/**
 * Desktop webview bridge, browser half. Probes the desktop gate signal; in a
 * plain browser (terminal `dsh web`) the probe is 'absent' and apply returns
 * with zero registrations, so the row is always safe to mount. Inside the
 * shell it installs external-link routing, download saving, native
 * notifications, an in-app notification center, shell.overlay desktop
 * controls, and macOS titlebar fusion —
 * all as reversible effects collected by the plugin fiber.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the 'shell.overlay' SlotMap declaration (ui-layout's
// frame declares it) so the registration below typechecks against the real
// declaration — no runtime edge to ui-layout.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LinkDecision } from './links.ts'
import { classifyAnchor } from './links.ts'
import type { DownloadDecision } from './downloads.ts'
import { classifyDownload, saveViaShell } from './downloads.ts'
import type { DesktopProbe, TauriInvoke } from './env.ts'
import { probeDesktop } from './env.ts'
import { DesktopBadge, type BadgeInjected } from './badge.tsx'
import { UpdateIndicator, type UpdateIndicatorInjected } from './update-indicator.tsx'
import { createUpdateCoordinator } from './update-coordinator.ts'
import { en, zh, type DesktopBridgeKey } from './locales.ts'
import { installRailClearance, installRailCss, installRailHider } from './rail.ts'
import { DesktopRailControls, type RailControlsInjected } from './rail-controls.tsx'
import { installTitlebarCss, shouldFuseTitlebar, TITLEBAR_ZONE_PX } from './titlebar.ts'
import { DesktopDragStrip, type DragStripInjected } from './titlebar.tsx'
import { installDragSegments } from './drag-strip.ts'
import { installNotifications } from './notifications.ts'
import { createNotifyInbox } from './notify-inbox.ts'
import { NotifyIndicator, type NotifyCenterInjected } from './notify-center.tsx'
import { installSurfaceMenu } from './surface-menu.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The desktop bridge's localized labels. */
    'desktop-bridge': DesktopBridgeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'desktop-bridge'

/** Required services: the slot registry, the sessions list feed, the locale registry, and Workspace UI navigation. */
export const inject = ['slots', 'sessions', 'locale', 'uiWorkspace']

/** Logger face used by the installers (the cordis logger satisfies this). */
interface WarnLog {
  warn(message: string): void
}

/**
 * Client plugin body: probe, then install the desktop integrations.
 * @param ctx - client root context.
 * @throws when the gate signal is present but malformed, or the Tauri IPC carrier is missing (shell-contract violation; the boot audit reports the failed fiber without affecting other plugins).
 */
export function apply(ctx: ClientContext): void {
  const logger: WarnLog = { warn: (m) => { ctx.logger.warn(m) } }
  const probe = probeDesktop(window, logger.warn)
  if (probe.status === 'absent') return
  if (probe.status === 'shell-contract-violation') {
    throw new Error(`dsh-desktop-bridge: ${probe.reason}`)
  }
  const { invoke } = probe

  // macOS overlay-titlebar fusion: reserve the top band under the floating
  // traffic lights; the strip entry registered below hosts the segmented
  // drag surface (drag-strip.ts — gap segments, never a full-width strip, so
  // absolute panel controls living in the band keep their events).
  // Same gate hides the collapsed sidebar rail outright (rail.ts): the 56px
  // strip ui-layout keeps would sit dead under the traffic lights.
  const fuseTitlebar = shouldFuseTitlebar(probe.gate.platform)
  if (fuseTitlebar) {
    ctx.effect(() => installTitlebarCss(document, TITLEBAR_ZONE_PX), 'desktop-bridge: titlebar band')
    ctx.effect(() => installRailCss(document), 'desktop-bridge: collapsed-rail css')
    ctx.effect(() => installRailHider(document), 'desktop-bridge: collapsed-rail hider')
    // Publishes the rail controls' measured right edge for the collapsed
    // header's clearance rule (titlebar.ts consumes the variable).
    ctx.effect(() => installRailClearance(document), 'desktop-bridge: rail clearance')
  }

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-bridge: dictionaries')
  ctx.effect(() => installExternalLinks(document, invoke, logger), 'desktop-bridge: external links')
  ctx.effect(() => installDownloads(document, invoke, logger), 'desktop-bridge: downloads')
  ctx.effect(() => installSurfaceMenu(document, invoke, logger), 'desktop-bridge: surface menu')
  const inbox = createNotifyInbox()
  const openSession = (sessionId: string): void => {
    ctx.sessions.open(sessionId as Parameters<typeof ctx.sessions.open>[0])
  }
  ctx.effect(() => {
    const t = ctx.locale.bind(NS)
    return installNotifications({
      list: ctx.sessions.list,
      invoke,
      logger,
      copy: () => ({ turnDone: t('notify.turnDone'), awaitInput: t('notify.awaitInput') }),
      openSession,
      record: (edge) => { inbox.push(edge) },
    })
  }, 'desktop-bridge: notifications')
  const notifyInjected = (): NotifyCenterInjected => ({ inbox, openSession })
  const injected = (): BadgeInjected => ({
    openExternal: (url) => { void callOpenExternal(invoke, url, logger) },
  })
  // One ordered browser coordinator backs the quiet periodic check and the
  // explicit download/install actions; Rust owns the durable process state.
  const updater = createUpdateCoordinator((command) => invoke.invoke(command))
  const updateInjected = (): UpdateIndicatorInjected => updater
  // slots.inject waits on the ui-layout declaration (activation order is
  // unconstrained), reruns after redeclaration, and leaves with this fiber.
  ctx.slots.inject('shell.overlay', () => {
    const disposeBadge = ctx.slots.register({ name: 'shell.overlay', id: 'desktop-badge', order: 10, locale: NS, inject: injected }, DesktopBadge)
    if (!fuseTitlebar) {
      const disposeUpdate = ctx.slots.register({ name: 'shell.overlay', id: 'desktop-update-indicator', order: 6, locale: NS, inject: updateInjected }, UpdateIndicator)
      const disposeNotify = ctx.slots.register({ name: 'shell.overlay', id: 'desktop-notify-center', order: 7, locale: NS, inject: notifyInjected }, NotifyIndicator)
      return () => { disposeNotify(); disposeUpdate(); disposeBadge() }
    }
    const dragInjected = (): DragStripInjected => ({
      mount: (host) => installDragSegments(host, TITLEBAR_ZONE_PX),
    })
    const disposeStrip = ctx.slots.register({ name: 'shell.overlay', id: 'desktop-drag-strip', order: 0, inject: dragInjected }, DesktopDragStrip)
    // Resolve ctx.layout lazily per click, never at registration time:
    // slots.inject fires the moment ui-layout's declaration lands — inside
    // that fiber's startup, before it turns ACTIVE — and strict ctx.get only
    // serves ACTIVE providers, so a registration-time read can miss a layout
    // that is about to exist (the controls would never appear).
    const railInjected = (): RailControlsInjected => ({
      ...updater,
      ...notifyInjected(),
      toggleSidebar: () => {
        const layout = ctx.get('layout')
        if (layout === undefined) {
          logger.warn('dsh-desktop-bridge: ctx.layout unavailable, sidebar toggle ignored')
          return
        }
        layout.toggleSidebar()
      },
      startSession: () => { ctx.uiWorkspace.startSession() },
    })
    const disposeControls = ctx.slots.register({ name: 'shell.overlay', id: 'desktop-rail-controls', order: 5, locale: NS, inject: railInjected }, DesktopRailControls)
    return () => { disposeControls(); disposeStrip(); disposeBadge() }
  })
}

/**
 * Capture-phase external-link router.
 * @param doc - the document to listen on (injected for tests).
 * @param invoke - the shell IPC carrier.
 * @param logger - warning sink for rejected invokes.
 * @returns the disposer removing the listener.
 */
export function installExternalLinks(doc: Document, invoke: TauriInvoke, logger: WarnLog): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const decision = anchorDecision(event, doc, classifyAnchor)
    if (decision === undefined) return
    if (decision.action === 'route') {
      event.preventDefault()
      void callOpenExternal(invoke, decision.url, logger)
    }
  }
  doc.addEventListener('click', onClick, true)
  return () => { doc.removeEventListener('click', onClick, true) }
}

/**
 * Capture-phase download bridge: `a[download]` clicks fetch their bytes and
 * hand them to the shell's save command; a rejected save falls back to a
 * plain navigational download.
 * @param doc - the document to listen on (injected for tests).
 * @param invoke - the shell IPC carrier.
 * @param logger - warning sink for rejected invokes.
 * @returns the disposer removing the listener.
 */
export function installDownloads(doc: Document, invoke: TauriInvoke, logger: WarnLog): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const decision = anchorDecision(event, doc, classifyDownload)
    if (decision === undefined) return
    if (decision.action === 'pass') return
    event.preventDefault()
    saveViaShell(decision, invoke).then(
      (saved) => { if (saved === undefined) fallbackDownload(decision.url) },
      (error: unknown) => {
        logger.warn(`dsh-desktop-bridge: save failed for ${decision.url}, falling back to navigation: ${String(error)}`)
        fallbackDownload(decision.url)
      },
    )
  }
  doc.addEventListener('click', onClick, true)
  return () => { doc.removeEventListener('click', onClick, true) }
}

/** Resolve the clicked anchor and run one classifier; undefined = not an anchor click. */
function anchorDecision<T>(
  event: MouseEvent,
  doc: Document,
  classify: (anchor: Pick<HTMLAnchorElement, 'href' | 'target' | 'download' | 'getAttribute'>, origin: string) => T,
): T | undefined {
  const target = event.target
  if (target === null || typeof (target as Element).closest !== 'function') return undefined
  const anchor = (target as Element).closest('a')
  if (anchor === null) return undefined
  try {
    return classify(anchor as HTMLAnchorElement, doc.defaultView?.location.origin ?? '')
  } catch {
    return undefined
  }
}

/** Last-resort download: let the webview navigate to the URL. */
function fallbackDownload(url: string): void {
  window.location.href = url
}

/** Fire one open-external IPC call; on rejection fall back to window.open. */
async function callOpenExternal(invoke: TauriInvoke, url: string, logger: WarnLog): Promise<void> {
  try {
    await invoke.invoke('dsh_desktop_open_external', { url })
  } catch (error) {
    logger.warn(`dsh-desktop-bridge: open_external failed for ${url}, falling back to window.open: ${String(error)}`)
    window.open(url, '_blank', 'noopener')
  }
}

/** Re-exported probe type for same-package tests through ./src. */
export type { DesktopProbe } from './env.ts'
