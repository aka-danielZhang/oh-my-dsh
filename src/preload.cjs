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
async function assertDesktopToolbar(toolbar) {
  if (platform !== 'macos') return
  if (!toolbar || typeof toolbar.querySelectorAll !== 'function') {
    throw new Error(`toolbar probe: matched node is ${String(toolbar && toolbar.constructor && toolbar.constructor.name || toolbar)}`)
  }
  if (!toolbar) throw new Error('toolbar DOM missing (desktop-toolbar not mounted)')
  const bar = toolbar.getBoundingClientRect()
  if (bar.height < 36 || bar.height > 40) throw new Error(`toolbar height ${bar.height} != 38`)
  const buttons = [...toolbar.querySelectorAll('button')]
  // The updater control is conditional (UpdateControl renders null until the
  // coordinator has state), so the standing row is toggle + bell + collapsed-only
  // New Session = 3; the sidebar toggle is mandatory — the collapse cycle below
  // drives it. The stale >=4 gate aborted the probe before that cycle ever ran
  // (0.3.1-rc.6: the collapsed lane's drag region swallowed the toggle and the
  // e2e never saw it).
  const toggleRequired = buttons.find((button) => /侧边栏|sidebar/i.test(button.getAttribute('aria-label') || ''))
  if (buttons.length < 3 || !toggleRequired) {
    const layout = buttons
      .map((button) => {
        const rect = button.getBoundingClientRect()
        const label = button.getAttribute('aria-label') || button.textContent?.trim().slice(0, 24) || '<unlabeled>'
        return `${label}@${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}${rect.width === 0 ? ' (hidden)' : ''}`
      })
      .join(' | ')
    throw new Error(`toolbar buttons ${buttons.length} < 3 or sidebar toggle missing: ${layout}`)
  }
  // State-conditional buttons (collapsed-only New Session) collapse to a 0x0
  // rect at the origin while hidden — geometry assertions must run over the
  // VISIBLE buttons only.
  const rects = buttons.map((button) => button.getBoundingClientRect()).filter((rect) => rect.width > 0)
  const left = Math.min(...rects.map((rect) => rect.left))
  if (left < 80) {
    const layout = buttons
      .map((button) => {
        const rect = button.getBoundingClientRect()
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

/**
 * Collapse/expand cycle driven through the toolbar's own sidebar toggle
 * (a DOM click, so the whole ctx.layout → inline-grid reconciliation chain
 * runs; NOTE a DOM click bypasses Electron's drag-region hit-test — the
 * drag-coverage class of regression is asserted geometrically inside).
 * Asserts the sidebar actually collapses, the collapsed first track
 * is reconciled to 0px by the rail hider, and the toolbar's own geometry
 * does not drift while collapsed — then expands back.
 */
async function assertCollapsedCycle(toolbar) {
  const toggle = [...toolbar.querySelectorAll('button')].find((button) =>
    /侧边栏|sidebar/i.test(button.getAttribute('aria-label') || ''))
  if (!toggle) return // unknown dictionary: skip the cycle rather than fail it
  const frame = document.querySelector('div:has(> [data-shell-overlay])')
  if (!frame) return
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      if (predicate()) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }
  const collapsed = () => frame.hasAttribute('data-sidebar-collapsed')
  toggle.click()
  if (!(await waitFor(collapsed))) throw new Error('sidebar did not collapse after toolbar toggle click')
  const firstTrack = (frame.style.gridTemplateColumns.match(/^\S+/) || [''])[0]
  if (firstTrack !== '0px') {
    throw new Error(`collapsed first track "${firstTrack}" != 0px (rail hider not reconciling)`)
  }
  // Drag-region overlap invariant (0.3.1-rc.6): `-webkit-app-region` combines
  // by paint order, so a collapsed main lane whose BOX starts inside the
  // controls cluster covers the rail buttons' no-drag holes — native clicks
  // then start a window drag and the sidebar can never expand again. This
  // synthetic click bypasses the drag hit-test, so the cycle asserts the
  // GEOMETRY instead: the lane's box must start at or past the cluster's
  // right edge, and every rail button must keep its computed no-drag hole.
  const controls = toolbar.querySelector('[data-desktop-toolbar-controls]')
  const main = toolbar.querySelector('[data-desktop-toolbar-main]')
  if (controls && main) {
    const clusterRight = controls.getBoundingClientRect().right
    const laneLeft = main.getBoundingClientRect().left
    if (laneLeft < clusterRight) {
      throw new Error(`collapsed main lane box starts at ${Math.round(laneLeft)} inside the controls cluster (right edge ${Math.round(clusterRight)}) — its inherited drag region covers the no-drag rail buttons`)
    }
  }
  const region = getComputedStyle(toggle).webkitAppRegion
  if (region !== 'no-drag') throw new Error(`toggle app-region ${region} != no-drag while collapsed`)
  const bar = toolbar.getBoundingClientRect()
  if (bar.height < 36 || bar.height > 40) throw new Error(`toolbar height drifted to ${bar.height} while collapsed`)
  toggle.click()
  if (!(await waitFor(() => !collapsed()))) throw new Error('sidebar did not expand back after second toggle click')
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
        const toolbar = document.querySelector('[data-desktop-toolbar]')
        await assertDesktopToolbar(toolbar)
        await assertCollapsedCycle(toolbar)
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
