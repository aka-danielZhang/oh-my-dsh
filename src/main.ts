import { app, autoUpdater as nativeAutoUpdater } from 'electron'
import { join } from 'node:path'

import { bootSequence } from './boot.ts'
import { APP_ID, PRODUCT_NAME } from './constants.ts'
import { alertDialog } from './dialog.ts'
import { focusMainWindow, registerIpc } from './ipc.ts'
import { killSidecar } from './sidecar.ts'
import { shouldRetainBackground } from './keep-alive.ts'
import { revealMainWindow, setAppQuitting } from './window.ts'

function electronPath(): string {
  return process.execPath
}

// dev 与已安装的正式版并存：单实例锁按 userData 目录比较，unpackaged dev
// 若沿用正式版的 userData 会争不到锁而静默退出（2026-09-10 实机验收踩中）。
// dev 实例一律用独立的 -dev userData，正式版不受影响。
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), `${APP_ID}-dev`))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.setName(PRODUCT_NAME)
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID)
  registerIpc()
  app.on('second-instance', () => {
    focusMainWindow()
  })

  app.on('before-quit', () => {
    setAppQuitting(true)
    killSidecar()
  })
  // electron-updater's quitAndInstall closes every window BEFORE app emits
  // before-quit; the keep-alive close veto would otherwise veto those closes
  // and ShipIt would wait for a termination that never happens (the 2026-08-31
  // restart failure). Lift the veto as soon as the update quit sequence starts.
  nativeAutoUpdater.on('before-quit-for-update', () => {
    setAppQuitting(true)
  })
  app.on('window-all-closed', () => {
    if (shouldRetainBackground(process.platform, false)) return
    killSidecar()
    app.quit()
  })
  app.on('activate', () => {
    void revealMainWindow()
  })
  process.on('SIGINT', () => {
    killSidecar()
    app.exit(128 + 2)
  })
  process.on('SIGTERM', () => {
    killSidecar()
    app.exit(128 + 15)
  })

  app.whenReady().then(async () => {
    try {
      const outcome = await bootSequence(app.isPackaged, electronPath())
      if (outcome === 'exitRequested') {
        killSidecar()
        app.exit(0)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`dsh-desktop: boot failed: ${message}`)
      try {
        alertDialog('无法启动 Oh My DSH', message)
      } catch {
        // dialog may fail before app is fully ready
      }
      killSidecar()
      app.exit(1)
    }
  })
}
