import fs from 'node:fs'
import path from 'node:path'

import { app, BrowserWindow } from 'electron'
import { PRODUCT_NAME } from './constants.ts'
import { redactLaunchUrl, withE2eQuery } from './urls.ts'
import { watchE2eExit } from './e2e.ts'
import { focusMainWindow, getMainWindow, setMainWindow } from './ipc.ts'
import { shouldRetainBackground } from './keep-alive.ts'

export { shouldRetainBackground }

let quitting = false
let lastUrl: string | undefined
let lastE2e = false

/** Cmd+Q / before-quit: the next close may destroy the window. */
export function setAppQuitting(value: boolean): void {
  quitting = value
}

function preloadScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'preload.cjs'),
    path.join(app.getAppPath(), 'dist-electron/preload.cjs'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`preload missing; tried ${candidates.join(', ')}`)
}

export async function openMainWindow(url: string, e2e: boolean): Promise<void> {
  lastUrl = url
  lastE2e = e2e
  const preload = preloadScript()
  const loadUrl = e2e ? withE2eQuery(url) : url
  const window = new BrowserWindow({
    title: PRODUCT_NAME,
    width: 1400,
    height: 900,
    show: true,
    // Official-desktop darwin posture (harness apps/desktop main.ts): the
    // web UI reads data-platform=darwin (marked by the preload) and renders
    // its stock darwin layout — traffic lights over the vibrancy sidebar,
    // conversation header owning the top strip, right panel at the frame
    // top. 'active' keeps the vibrancy material stable when the window
    // blurs ('followWindow' would wash the sidebar out unfocused).
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 16, y: 18 },
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
          backgroundColor: '#00000000',
        }
      : {}),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  setMainWindow(window)
  if (process.platform === 'darwin') {
    // Fullscreen hides the traffic lights; the preload mirrors the state
    // onto html[data-fullscreen] so the web UI drops its top clearance.
    // did-finish-load resends so a reload keeps the current state.
    const sendFullscreen = (): void => {
      if (!window.isDestroyed()) window.webContents.send('dsh-desktop-window-fullscreen', window.isFullScreen())
    }
    window.on('enter-full-screen', sendFullscreen)
    window.on('leave-full-screen', sendFullscreen)
    window.webContents.on('did-finish-load', sendFullscreen)
    // Deminiaturize reattaches the NSVisualEffectView material late
    // (electron/electron#25368), so a transparent window would show the
    // desktop through the sidebar until then: paint an opaque base while
    // minimized or hidden; restoring flips back and the null -> 'sidebar'
    // transition forces the material to reattach.
    const applyBackdrop = (): void => {
      if (window.isDestroyed()) return
      if (window.isMinimized() || !window.isVisible()) {
        window.setVibrancy(null)
        window.setBackgroundColor('#FFFFFF')
      } else {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      }
    }
    window.on('minimize', applyBackdrop)
    window.on('hide', applyBackdrop)
    window.on('restore', applyBackdrop)
    window.on('show', applyBackdrop)
  }
  window.on('close', (event) => {
    if (!shouldRetainBackground(process.platform, quitting)) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => setMainWindow(undefined))
  if (e2e) {
    window.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`dsh-desktop: preload error ${preloadPath}: ${error}`)
    })
    watchE2eExit()
  }
  console.log(`dsh-desktop: window built, loading ${redactLaunchUrl(loadUrl)}`)
  await window.loadURL(loadUrl)
}

/** Dock / taskbar activate: show the hidden window, or rebuild if it is gone. */
export async function revealMainWindow(): Promise<void> {
  const current = getMainWindow()
  if (current !== undefined && !current.isDestroyed()) {
    focusMainWindow()
    return
  }
  if (lastUrl === undefined) return
  await openMainWindow(lastUrl, lastE2e)
}

/**
 * Point the live window at a new sidecar URL (surface switch). A destroyed
 * window (macOS background retention corner) is rebuilt at the new URL.
 */
export async function reloadMainWindow(url: string): Promise<void> {
  lastUrl = url
  const current = getMainWindow()
  if (current === undefined || current.isDestroyed()) {
    await openMainWindow(url, lastE2e)
    return
  }
  await current.loadURL(url)
}
