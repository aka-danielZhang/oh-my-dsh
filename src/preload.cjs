const { contextBridge, ipcRenderer } = require('electron')

const platform = process.platform === 'darwin'
  ? 'macos'
  : process.platform === 'win32'
    ? 'windows'
    : 'linux'

// Official-desktop platform marking (harness apps/desktop preload-platform):
// `data-platform` on <html> scopes the web UI's darwin layout — vibrancy
// sidebar, conversation header owning the top strip, right panel at the
// frame top, official shell.leading controls for the collapsed sidebar.
// The preload may run before the document root exists; defer to
// DOMContentLoaded then.
const markPlatform = () => { document.documentElement.dataset.platform = process.platform }
const platformRoot = document.documentElement
if (platformRoot === null || platformRoot === undefined) {
  window.addEventListener('DOMContentLoaded', markPlatform)
} else {
  markPlatform()
}

// Fullscreen hides the native controls; main mirrors the state so the web
// UI drops its top clearance (html[data-fullscreen]).
ipcRenderer.on('dsh-desktop-window-fullscreen', (_event, fullscreen) => {
  const root = document.documentElement
  if (root === null || root === undefined) return
  if (fullscreen) root.dataset.fullscreen = 'true'
  else delete root.dataset.fullscreen
})

contextBridge.exposeInMainWorld('__DSH_DESKTOP__', Object.freeze({
  version: 1,
  shell: 'dsh-desktop',
  platform,
}))

const ALLOWED_EVENTS = new Set(['dsh-desktop-notify-click'])

contextBridge.exposeInMainWorld('__DSH_DESKTOP_IPC__', Object.freeze({
  invoke: (cmd, args) => ipcRenderer.invoke(cmd, args ?? {}),
  on: (event, handler) => {
    if (!ALLOWED_EVENTS.has(event)) throw new Error(`event not allowed: ${event}`)
    const listener = (_ipcEvent, payload) => { handler(payload) }
    ipcRenderer.on(event, listener)
    return () => { ipcRenderer.removeListener(event, listener) }
  },
}))

function isHarnessPage() {
  return /^https?:\/\/127\.0\.0\.1(?::\d+)?/i.test(location.href)
}

/**
 * Official-posture assertions (0.2.1-rc.2 zw line): the unified toolbar is
 * retired and the web UI renders the stock darwin layout. Covers the
 * no-session automatable slice — platform marked, no bridge chrome left,
 * darwin drag rows active, and (with the sidebar open) the official strip
 * toggle present. Throws on the first violated invariant.
 */
async function assertOfficialPosture() {
  if (platform !== 'macos') return
  const html = document.documentElement
  if (html.dataset.platform !== 'darwin') {
    throw new Error(`data-platform is "${String(html.dataset.platform ?? '')}" (darwin posture not marked)`)
  }
  if (document.querySelector('[data-desktop-toolbar]') !== null) {
    throw new Error('desktop toolbar still mounted (retired with the official-posture adoption)')
  }
  const drag = document.querySelector('[data-window-drag]')
  if (drag === null) {
    throw new Error('no [data-window-drag] row (darwin drag regions missing)')
  }
  const region = getComputedStyle(drag).webkitAppRegion
  if (region !== 'drag') {
    throw new Error(`drag row app-region ${region} != drag (window cannot be dragged)`)
  }
}

/**
 * Collapse/expand cycle through the sidebar's OWN strip toggle (a DOM click,
 * so the ctx.layout → grid reconciliation chain runs). Official darwin
 * behavior: the column collapses to zero width and the frame's shell.leading
 * seat mounts the reopen controls. Unknown dictionary labels skip the cycle
 * rather than fail it.
 */
async function assertSidebarCycle() {
  const frame = document.querySelector('div:has(> [data-shell-overlay])')
  if (frame === null) return
  const stripToggle = [...frame.querySelectorAll('button')]
    .find((button) => {
      if (/侧边栏|sidebar/i.test(button.getAttribute('aria-label') || '') === false) return false
      const rect = button.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    })
  if (stripToggle === undefined) return
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }
  const collapsed = () => frame.hasAttribute('data-sidebar-collapsed')
  stripToggle.click()
  if (!(await waitFor(collapsed))) throw new Error('sidebar did not collapse after strip toggle click')
  const leading = document.querySelector('[data-shell-leading]')
  if (leading === null) {
    throw new Error('collapsed sidebar mounted no [data-shell-leading] reopen controls')
  }
  const reopen = [...leading.querySelectorAll('button')]
    .find((button) => {
      const rect = button.getBoundingClientRect()
      return rect.width > 0 && /侧边栏|sidebar/i.test(button.getAttribute('aria-label') || '')
    })
  if (reopen === undefined) {
    throw new Error('shell.leading seat mounted without a visible reopen toggle')
  }
  reopen.click()
  if (!(await waitFor(() => !collapsed()))) throw new Error('sidebar did not expand back after leading-seat toggle click')
}

function startE2eProbe() {
  if (process.env.DSH_DESKTOP_E2E_PROBE !== '1') return
  if (!isHarnessPage()) return
  if (globalThis.__DSH_E2E_PROBE_STARTED__) return
  globalThis.__DSH_E2E_PROBE_STARTED__ = true
  // Surface-switch e2e: the badge proves the bridge is alive on the current
  // surface, then the switch command drives menu→pick→confirm→restart with
  // the env-picked directory; the shell reports the verdict itself when the
  // new sidecar answers (or fails). Never re-invoke after the reload — the
  // flow's active-surface check makes the second run a harmless no-op.
  const surface = process.env.DSH_DESKTOP_E2E_SURFACE
  const started = Date.now()
  const timer = setInterval(async () => {
    const root = document.getElementById('root') || document.querySelector('[data-app-root], #app')
    const badge = document.querySelector('[data-desktop-badge]')
    if (root && badge) {
      clearInterval(timer)
      if (surface) {
        ipcRenderer
          .invoke('dsh_desktop_switch_surface', {})
          .catch((error) => {
            const message = error && error.message ? error.message : String(error)
            return ipcRenderer.invoke('dsh_desktop_e2e_report', { verdict: `fail:${message}` })
          })
        return
      }
      try {
        await assertOfficialPosture()
        await assertSidebarCycle()
      } catch (error) {
        ipcRenderer
          .invoke('dsh_desktop_e2e_report', { verdict: `fail:${error.message}` })
          .catch(() => {})
        return
      }
      ipcRenderer
        .invoke('dsh_desktop_save_file', {
          name: 'dsh-e2e-probe.txt',
          base64: btoa('dsh-desktop e2e check'),
        })
        .then(() => ipcRenderer.invoke('dsh_desktop_e2e_report', { verdict: 'ok' }))
        .catch((error) => {
          const message = error && error.message ? error.message : String(error)
          return ipcRenderer.invoke('dsh_desktop_e2e_report', { verdict: `fail:${message}` })
        })
      return
    }
    if (Date.now() - started > 90_000) {
      clearInterval(timer)
      const reason = !root ? 'app root missing' : 'badge DOM missing'
      ipcRenderer.invoke('dsh_desktop_e2e_report', { verdict: `fail:${reason}` }).catch(() => {})
    }
  }, 250)
}

if (process.env.DSH_DESKTOP_E2E_PROBE === '1') {
  window.addEventListener('DOMContentLoaded', startE2eProbe)
  if (document.readyState !== 'loading') startE2eProbe()
}
