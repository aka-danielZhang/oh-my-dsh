/**
 * Desktop webview bridge, browser half. Probes the desktop gate signal; in a
 * plain browser (terminal `dsh web`) the probe is 'absent' and apply returns
 * with zero registrations, so the row is always safe to mount. Inside the
 * shell it installs external-link routing, download saving, native
 * notifications, the header update entry, and the collapsed-rail update
 * badge — all as reversible effects collected by the plugin fiber.
 *
 * Chrome posture (0.2.1-rc.2 zw line): the shell marks
 * `data-platform=darwin` like the official desktop preload and configures
 * the hiddenInset/vibrancy window, so the stock web UI renders the official
 * layout — conversation header at the top, right panel anchored at the frame
 * top, official shell.leading controls for the collapsed sidebar. The bridge
 * adds no chrome of its own: its only seats are the sidebar header action
 * (fork `sidebar.header.action`, left of the toggle), the collapsed-rail
 * badge (official `sidebar.toggle.badge`), and the html liveness marker the
 * shell's e2e probe waits for.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls ui-session's cordis Context merge (ctx.uiSession) and its
// pendingInteractions authority face.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-sidebar's `sidebar` SlotMap declaration and its children
// (`sidebar.header.action` on zw.4 runtimes, `sidebar.toggle.badge`), so the
// updater seats typecheck against the real declarations.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LinkDecision } from './links.ts'
import { classifyAnchor } from './links.ts'
import type { DownloadDecision } from './downloads.ts'
import { classifyDownload, saveViaShell } from './downloads.ts'
import type { DesktopProbe, TauriInvoke } from './env.ts'
import { probeDesktop } from './env.ts'
import type { UpdateIndicatorInjected } from './update-indicator.tsx'
import { createUpdateCoordinator } from './update-coordinator.ts'
import { installUpdateSeats, type WarnLog } from './update-seats.ts'
import { en, zh, type DesktopBridgeKey } from './locales.ts'
import { installNotifications } from './notifications.ts'
import { installSurfaceMenu } from './surface-menu.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The desktop bridge's localized labels. */
    'desktop-bridge': DesktopBridgeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'desktop-bridge'

/** Required services: the slot registry, the sessions list feed, the ui-session pending-interaction authority, the locale registry, and Workspace UI navigation. */
export const inject = ['slots', 'sessions', 'uiSession', 'locale', 'uiWorkspace']

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

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'desktop-bridge: dictionaries')
  // Liveness marker: the shell's e2e probe waits for `html[data-dsh-desktop-bridge]`
  // to prove the bridge is mounted on this surface (bridge-contract doc), and
  // the attribute leaves with the fiber.
  ctx.effect(() => {
    document.documentElement.dataset.dshDesktopBridge = '1'
    return () => { delete document.documentElement.dataset.dshDesktopBridge }
  }, 'desktop-bridge: liveness marker')
  ctx.effect(() => installExternalLinks(document, invoke, logger), 'desktop-bridge: external links')
  ctx.effect(() => installDownloads(document, invoke, logger), 'desktop-bridge: downloads')
  ctx.effect(() => installSurfaceMenu(document, invoke, logger), 'desktop-bridge: surface menu')
  const openSession = (sessionId: string): void => {
    ctx.uiWorkspace.openSession(sessionId as Parameters<typeof ctx.uiWorkspace.openSession>[0])
  }
  ctx.effect(() => {
    const t = ctx.locale.bind(NS)
    return installNotifications({
      list: ctx.sessions.list,
      // The await-input authority is per-session status now; the notification
      // scan wants the subset with a live interaction, as a plain id map.
      pending: {
        getSnapshot: () => new Map([...ctx.uiSession.sessionStatus.getSnapshot()]
          .filter(([, status]) => status.pendingInteraction !== undefined)
          .map(([id, status]) => [id as string, status.pendingInteraction])),
        subscribe: (listener: () => void) => ctx.uiSession.sessionStatus.subscribe(listener),
      },
      invoke,
      logger,
      copy: () => ({ turnDone: t('notify.turnDone'), awaitInput: t('notify.awaitInput') }),
      openSession,
    })
  }, 'desktop-bridge: notifications')
  // One ordered browser coordinator backs the quiet periodic check and the
  // explicit download/install actions; Rust owns the durable process state.
  const updater = createUpdateCoordinator((command) => invoke.invoke(command))
  const updateInjected = (): UpdateIndicatorInjected => updater
  // Both updater seats ride ui-sidebar's `sidebar` declaration: its children
  // (`sidebar.header.action` on zw.4 runtimes, the stock `sidebar.toggle.badge`)
  // commit with it, so seat placement can read the declared slots instead of
  // waiting on a slot the old runtime will never declare. `slots.inject`
  // treats a missing declaration as "wait", never as a failure.
  ctx.slots.inject('sidebar', () => installUpdateSeats(ctx.slots, updateInjected, logger))
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
