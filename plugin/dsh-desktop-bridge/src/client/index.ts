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
import { installRailCss, installRailHider } from './rail.ts'
import { DesktopToolbar, type DesktopToolbarInjected } from './toolbar.tsx'
import { ToolbarHostPublisher, type ToolbarHostRegistry } from './toolbar-hosts.ts'
import { installTitlebarCss, shouldFuseTitlebar, TITLEBAR_ZONE_PX } from './titlebar.ts'
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

  // macOS overlay-titlebar fusion. Since 0.2.0-rc.14 the unified toolbar
  // (toolbar.tsx) mounts into ui-layout's `shell.toolbar` slot — a real
  // first grid row with the traffic lights in its leading inset; the row's
  // background is the drag region and the session header portals into its
  // hosts. The styles below carry the pre-toolbar FALLBACK (sidebar band
  // inset, collapsed-header light row) plus the unchanged fullscreen
  // semantics; the same gate hides the collapsed sidebar rail outright
  // (rail.ts): the 56px strip ui-layout keeps would sit dead under the
  // traffic lights.
  const fuseTitlebar = shouldFuseTitlebar(probe.gate.platform)
  if (fuseTitlebar) {
    ctx.effect(() => installTitlebarCss(document, TITLEBAR_ZONE_PX), 'desktop-bridge: titlebar band')
    ctx.effect(() => installRailCss(document), 'desktop-bridge: collapsed-rail css')
    ctx.effect(() => installRailHider(document), 'desktop-bridge: collapsed-rail hider')
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
    // Resolve ctx.layout lazily per use, never at registration time:
    // slots.inject fires the moment ui-layout's declaration lands — inside
    // that fiber's startup, before it turns ACTIVE — and strict ctx.get only
    // serves ACTIVE providers, so a registration-time read can miss a layout
    // that is about to exist (the controls would never appear). The
    // toolbar-host registry is structural: an OLD runtime without it simply
    // never publishes hosts, and the session header stays in place.
    const toolbarRegistry = (): ToolbarHostRegistry | undefined => {
      const layout = ctx.get('layout') as unknown as ToolbarHostRegistry | undefined
      return layout !== undefined && typeof layout.setToolbarHosts === 'function' ? layout : undefined
    }
    const historyApi = (): Partial<{
      canBack(): boolean
      canForward(): boolean
      back(): void
      forward(): void
    }> => ctx.sessions as unknown as Partial<{
      canBack(): boolean
      canForward(): boolean
      back(): void
      forward(): void
    }>
    // One publisher per fiber: identity-stable callback refs for the
    // toolbar's two host cells (old-HMR disposers release only their OWN
    // pair — see ToolbarHostPublisher).
    let publisher: ToolbarHostPublisher | undefined
    const publisherOf = (): ToolbarHostPublisher => {
      publisher ??= new ToolbarHostPublisher(toolbarRegistry())
      return publisher
    }
    const toolbarInjected = (): DesktopToolbarInjected => ({
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
      switchSurface: () => { void invoke.invoke('dsh_desktop_switch_surface').catch((error: unknown) => { logger.warn(`dsh-desktop-bridge: surface switch failed: ${String(error)}`) }) },
      // Transient selection history from the session controller — structural
      // again: a runtime older than the fork revision shipping the history
      // simply reports both buttons disabled and no-ops them.
      canBack: () => historyApi().canBack?.() ?? false,
      canForward: () => historyApi().canForward?.() ?? false,
      back: () => { historyApi().back?.() },
      forward: () => { historyApi().forward?.() },
      centerRef: (el) => { publisherOf().center(el) },
      endRef: (el) => { publisherOf().end(el) },
    })
    // The slot key and component face exist in the fork's SlotMap first; the
    // pinned registry lags behind, so the registration casts through — same
    // structural posture as the toolbar's runtime shares. The registration
    // itself MUST stay guarded: `shell.toolbar` is declared by the fork
    // revision that carries the unified toolbar, and on an older runtime
    // cordis rejects the entry loudly ("slot not declared") — without the
    // guard that failure takes the WHOLE bridge fiber down (links, downloads,
    // notifications, updates — the 0.2.0-rc.14-in-0.3.0-rc.45 incident).
    // Degraded posture on an old runtime: no toolbar, and the legacy band
    // rules in titlebar.ts stay active because the marker below is only set
    // by a successfully mounted toolbar.
    let disposeToolbar: (() => void) | undefined
    try {
      disposeToolbar = (ctx.slots.register as Function)({ name: 'shell.toolbar', id: 'desktop-toolbar', locale: NS, inject: toolbarInjected }, DesktopToolbar) as () => void
    } catch (error) {
      logger.warn(`dsh-desktop-bridge: shell.toolbar is not declared by this runtime (fork revision predates the unified toolbar); toolbar disabled, legacy band rules stay active: ${String(error)}`)
      return () => { disposeBadge() }
    }
    // While the toolbar is mounted the frame's first grid row IS the band;
    // the fallback rules in titlebarCss scope themselves off this marker.
    // Registered only AFTER a successful slot registration — a toolbar that
    // never mounts must never suppress the fallback.
    ctx.effect(() => {
      document.documentElement.setAttribute('data-shell-toolbar-on', '')
      return () => { document.documentElement.removeAttribute('data-shell-toolbar-on') }
    }, 'desktop-bridge: toolbar marker')
    return () => {
      disposeToolbar?.()
      publisher?.release()
      disposeBadge()
    }
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
