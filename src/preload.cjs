const { contextBridge, ipcRenderer } = require('electron')

const platform = process.platform === 'darwin'
  ? 'macos'
  : process.platform === 'win32'
    ? 'windows'
    : 'linux'

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
 * Unified-toolbar assertions (macOS fusion, 0.2.0-rc.14): run before the IPC
 * round-trip so a layout regression fails the probe with a precise reason.
 * Covers the no-session automatable slice of the acceptance matrix — single
 * 38px row, buttons on one line clear of the traffic-light inset, drag
 * region on the row background, and the columns starting exactly at the
 * toolbar's bottom edge. Throws on the first violated invariant.
 */
function assertDesktopToolbar() {
  if (platform !== 'macos') return
  const toolbar = document.querySelector('[data-desktop-toolbar]')
  if (!toolbar) throw new Error('toolbar DOM missing (desktop-toolbar not mounted)')
  const bar = toolbar.getBoundingClientRect()
  if (bar.height < 36 || bar.height > 40) throw new Error(`toolbar height ${bar.height} != 38`)
  const buttons = [...toolbar.querySelectorAll('button')]
  if (buttons.length < 4) throw new Error(`toolbar buttons ${buttons.length} < 4`)
  const rects = buttons.map((button) => button.getBoundingClientRect())
  const left = Math.min(...rects.map((rect) => rect.left))
  if (left < 80) {
    const layout = buttons
      .map((button, index) => {
        const rect = rects[index]
        const label = button.getAttribute('aria-label') || button.textContent?.trim().slice(0, 24) || '<unlabeled>'
        return `${label}@${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}${rect.width === 0 ? ' (hidden)' : ''}`
      })
      .join(' | ')
    throw new Error(`leading button at x=${left} overlaps the traffic lights (>=80 required): ${layout}`)
  }
  const tops = rects.map((rect) => rect.top)
  const spread = Math.max(...tops) - Math.min(...tops)
  if (spread > 2) throw new Error(`toolbar buttons span ${spread}px vertically (wrapped rows)`)
  const region = getComputedStyle(toolbar).webkitAppRegion
  if (region !== 'drag') throw new Error(`toolbar app-region ${region} != drag (window cannot be dragged)`)
  const frame = document.querySelector('div:has(> [data-shell-overlay])')
  const sidebar = frame?.children[1]
  if (sidebar) {
    const offset = sidebar.getBoundingClientRect().top - bar.bottom
    if (Math.abs(offset) > 2) throw new Error(`columns start ${offset}px off the toolbar bottom edge`)
  }
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
  const timer = setInterval(() => {
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
        assertDesktopToolbar()
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
