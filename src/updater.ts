import { app, session } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import fs from 'node:fs'
import path from 'node:path'

import { shellRoot } from './paths.ts'
import {
  downloadRuntimeTarballAsync,
  readBundledRevisionFromZip,
  runtimeArtifactName,
  runtimeShaDirReady,
  shouldPrestageRuntime,
} from './runtime-artifact.ts'
import {
  electronProxyRules,
  readProxyUrl,
  readUpdateMirror,
  rewriteGithubReleaseDownloadUrl,
} from './update-mirror.ts'
import {
  claimUpdateCheck,
  claimUpdateDownload,
  claimUpdateInstall,
  setUpdateStatus,
  statusVersion,
  updateStatusSnapshot,
  type DesktopUpdateStatus,
} from './updater-state.ts'

export type { DesktopUpdateStatus }
export { updateStatusSnapshot }

type DownloadFn = (url: URL, destination: string, options: unknown) => Promise<unknown>

function notesOf(info: UpdateInfo): string {
  return typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
}

function updaterLogPath(): string {
  return path.join(shellRoot(), 'logs', 'updater.log')
}

function writeUpdaterLog(level: string, args: unknown[]): void {
  const text = args.map((arg) => {
    if (arg instanceof Error) return arg.stack ?? arg.message
    return typeof arg === 'string' ? arg : JSON.stringify(arg)
  }).join(' ')
  const line = `${new Date().toISOString()} ${level} ${text}\n`
  try {
    fs.appendFileSync(updaterLogPath(), line)
  } catch {
    // logging must never break an update
  }
  if (level === 'error') console.error(`[updater] ${text}`)
  else if (level === 'warn') console.warn(`[updater] ${text}`)
  else console.log(`[updater] ${text}`)
}

function attachUpdaterLogger(): void {
  autoUpdater.logger = {
    info: (...args: unknown[]) => writeUpdaterLog('info', args),
    warn: (...args: unknown[]) => writeUpdaterLog('warn', args),
    error: (...args: unknown[]) => writeUpdaterLog('error', args),
    debug: (...args: unknown[]) => writeUpdaterLog('debug', args),
  }
}

function applyUpdaterProxy(): void {
  const proxy = readProxyUrl()
  if (proxy === undefined) return
  const rules = electronProxyRules(proxy)
  void session.defaultSession.setProxy({ proxyRules: rules })
  writeUpdaterLog('info', [`using proxy ${rules}`])
}

function wrapExecutorDownload(download: DownloadFn, mirror: string | undefined): DownloadFn {
  return async (url, destination, options) => {
    const original = url.href
    const mirrored = rewriteGithubReleaseDownloadUrl(original, mirror)
    if (mirrored !== undefined && mirrored !== original) {
      try {
        writeUpdaterLog('info', [`trying update mirror ${mirrored}`])
        return await download(new URL(mirrored), destination, options)
      } catch (error) {
        writeUpdaterLog('warn', [`update mirror failed, falling back to GitHub: ${error instanceof Error ? error.message : String(error)}`])
      }
    }
    return await download(url, destination, options)
  }
}

let executorWrapped = false

function applyUpdateMirror(): void {
  if (executorWrapped) return
  const mirror = readUpdateMirror()
  const executor = (autoUpdater as { httpExecutor?: { download?: DownloadFn } }).httpExecutor
  if (executor === undefined || typeof executor.download !== 'function') return
  if (mirror === undefined) return
  executor.download = wrapExecutorDownload(executor.download.bind(executor), mirror)
  executorWrapped = true
  writeUpdaterLog('info', [`DSH_UPDATE_MIRROR=${mirror} (versioned /releases/download/ only)`])
}

/** Cancel handle carried by each checkForUpdates result (no new dependency). */
type UpdateCancellation = NonNullable<
  NonNullable<Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>>['cancellationToken']
>

/** The token of the in-flight download; cancelUpdate() cancels exactly this. */
let activeCancellation: UpdateCancellation | undefined
/** The mac runtime pre-stage child; cancelUpdate() aborts it. */
let activePrestage: AbortController | undefined
/** Cancel arriving while downloadUpdate is still in its pre-download check. */
let cancelRequested = false
/** Notes survive status phases that omit the field (cancel restores available). */
let lastUpdateNotes = ''

let updaterConfigured = false

function configureUpdater(): typeof autoUpdater {
  if (!updaterConfigured) {
    attachUpdaterLogger()
    applyUpdaterProxy()
    applyUpdateMirror()
    updaterConfigured = true
  }
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // Semver `-rc` is not a GitHub prerelease channel. Default allowPrerelease
  // would scrape releases.atom and treat the first `rc` tag as the feed, so a
  // failed `v*` tag with no latest-mac.yml poisons every installed -rc build.
  // Pin false so checks follow /releases/latest (make_latest desktop only).
  autoUpdater.allowPrerelease = false
  // Mac differential needs ~/Library/Caches/oh-my-dsh-updater/update.zip.
  // Never turn this on: a DMG install already falls back to a full zip once.
  autoUpdater.disableDifferentialDownload = false
  return autoUpdater
}

export async function checkUpdate(): Promise<{ update: { version: string; notes: string } | null }> {
  if (!app.isPackaged) {
    setUpdateStatus({ phase: 'current' })
    return { update: null }
  }
  const expected = claimUpdateCheck()
  const updater = configureUpdater()
  try {
    const result = await updater.checkForUpdates()
    if (result === null || result.isUpdateAvailable === false) {
      setUpdateStatus({ phase: 'current' })
      return { update: null }
    }
    const info = result.updateInfo
    const notes = notesOf(info)
    lastUpdateNotes = notes
    setUpdateStatus({ phase: 'available', version: info.version, notes })
    return { update: { version: info.version, notes } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    setUpdateStatus({
      phase: 'failed',
      message,
      ...(expected === undefined ? {} : { version: expected }),
    })
    throw new Error(message)
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) throw new Error('updates are disabled in unpackaged builds')
  const expected = claimUpdateDownload()
  const updater = configureUpdater()
  cancelRequested = false
  let token: UpdateCancellation | undefined
  try {
    const result = await updater.checkForUpdates()
    if (result === null) throw new Error('no update available')
    const info = result.updateInfo
    lastUpdateNotes = notesOf(info)
    token = result.cancellationToken
    activeCancellation = token
    // A cancel that arrived during the pre-download check still wins.
    if (cancelRequested || token?.cancelled === true) {
      token?.cancel()
      setUpdateStatus({ phase: 'available', version: info.version, notes: lastUpdateNotes })
      return
    }
    setUpdateStatus({ phase: 'downloading', version: info.version, downloaded: 0 })
    updater.removeAllListeners('download-progress')
    updater.on('download-progress', (progress) => {
      setUpdateStatus({
        phase: 'downloading',
        version: info.version,
        downloaded: progress.transferred,
        ...(progress.total > 0 ? { total: progress.total } : {}),
      })
    })
    // The zip path is needed for the mac runtime pre-stage below.
    let downloadedFile: string | undefined
    const onDownloaded = (event: { downloadedFile?: unknown }): void => {
      downloadedFile = typeof event.downloadedFile === 'string' ? event.downloadedFile : undefined
    }
    updater.once('update-downloaded', onDownloaded)
    try {
      await updater.downloadUpdate(token)
    } finally {
      updater.removeListener('update-downloaded', onDownloaded)
    }
    // Slim mac zips carry no runtime.tar.gz: pre-stage the new runtime while
    // the user is still on the working app. Otherwise the post-restart boot
    // stalls on an invisible ~370MB download (the 2026-08-31 restart failure's
    // second half). ready means every payload is local.
    if (process.platform === 'darwin' && downloadedFile !== undefined) {
      setUpdateStatus({ phase: 'downloading', version: info.version, downloaded: 0 })
      await prestageRuntime(downloadedFile, info.version)
    }
    if (cancelRequested) {
      setUpdateStatus({ phase: 'available', version: info.version, notes: lastUpdateNotes })
      return
    }
    setUpdateStatus({ phase: 'ready', version: info.version, notes: notesOf(info) })
  } catch (error) {
    // A user cancel is not a failure: restore the downloadable state.
    if (cancelRequested || token?.cancelled === true) {
      const version = statusVersion(updateStatusSnapshot()) ?? expected
      setUpdateStatus({ phase: 'available', version, notes: lastUpdateNotes })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    const version = statusVersion(updateStatusSnapshot()) ?? expected
    setUpdateStatus({
      phase: 'failed',
      message,
      ...(version === undefined ? {} : { version }),
    })
    throw new Error(message)
  } finally {
    if (activeCancellation === token) activeCancellation = undefined
  }
}

/**
 * Pre-stage the slim zip's runtime tarball into the shellRoot cache so the
 * post-restart boot extracts a local tar. Cache hits (extracted .ok or an
 * already fetched tarball) make this a no-op. Fail loud: a runtime that
 * cannot be fetched now would also fail at boot, and failing here keeps the
 * user on the working app with a retryable error.
 */
async function prestageRuntime(zipPath: string, version: string): Promise<void> {
  const revision = readBundledRevisionFromZip(zipPath)
  const sha = typeof revision?.sha === 'string' ? revision.sha : ''
  const expected = typeof revision?.runtimeTarball === 'string' ? revision.runtimeTarball : ''
  if (sha === '' || expected === '') {
    writeUpdaterLog('warn', [`runtime pre-stage skipped: no runtime-revision.json in ${zipPath}`])
    return
  }
  const extracted = path.join(shellRoot(), 'runtime', sha)
  const okFile = path.join(extracted, '.ok')
  const okMatches = fs.existsSync(okFile) && fs.readFileSync(okFile, 'utf8').trim() === expected
  const shaDirReady = runtimeShaDirReady(extracted)
  if (!shouldPrestageRuntime({ okMatches, shaDirReady })) {
    writeUpdaterLog('info', [`runtime ${sha.slice(0, 12)} already present; pre-stage skipped`])
    return
  }
  const controller = new AbortController()
  activePrestage = controller
  try {
    await downloadRuntimeTarballAsync({
      sha,
      expectedSha256: expected,
      version,
      dest: path.join(shellRoot(), 'runtime-tarballs', runtimeArtifactName(sha)),
      signal: controller.signal,
      onBytes: (bytes) => {
        if (!controller.signal.aborted) {
          setUpdateStatus({ phase: 'downloading', version, downloaded: bytes })
        }
      },
    })
  } finally {
    if (activePrestage === controller) activePrestage = undefined
  }
}

/**
 * Cancel an in-flight preparing/downloading run. The status returns to
 * `available` (version and notes retained) once the download unwinds, and the
 * pending download_update call resolves instead of failing. Idempotent: any
 * other phase is a no-op.
 */
export function cancelUpdate(): void {
  const snapshot = updateStatusSnapshot()
  if (snapshot.phase !== 'preparing' && snapshot.phase !== 'downloading') return
  cancelRequested = true
  activeCancellation?.cancel()
  activePrestage?.abort()
}

export function installUpdate(): never {
  const expected = claimUpdateInstall()
  setUpdateStatus({ phase: 'restarting', version: expected })
  configureUpdater().quitAndInstall(false, true)
  throw new Error('install did not replace the process')
}
