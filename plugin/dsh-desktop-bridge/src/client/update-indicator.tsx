/** Quiet updater control plus the download dialog shared by rail and fallback. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Button,
  IconCheckOutline16,
  IconDownloadOutline16,
  IconLoadingOutline16,
  Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { UpdateLogo } from './update-logo.tsx'
import { isElectronCutoverNotes, parseUpdateNotes } from './update-notes.ts'
import {
  formatBytes, isUpdateBusy, isUpdateIndicatorVisible, notesFromStatus, statusFromCheck,
  updatePercent, visibleUpdateNotes,
  type DesktopUpdaterInjected, type DesktopUpdateStatus,
} from './updates.ts'

export type UpdateIndicatorInjected = DesktopUpdaterInjected
export type UpdateIndicatorProps = UpdateIndicatorInjected & PropsLocale<'desktop-bridge'>

/** Periodic check interval (quiet background poll; 2h). */
const UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000
/** First check delay after mount, beyond the boot request burst. */
const FIRST_CHECK_DELAY_MS = 3000

/** Shared CSS for the busy spinner, the download dialog, and the notes panel. */
const UPDATE_CONTROL_CSS = [
  '@keyframes desktop-update-spin{to{transform:rotate(360deg)}}',
  '[data-desktop-update-spinner]{display:inline-flex;animation:desktop-update-spin .8s linear infinite}',
  '@media (prefers-reduced-motion:reduce){[data-desktop-update-spinner]{animation:none}}',
  // Inline `all:unset` on this button wipes the rail sheet's no-drag; the
  // 28px drag strip then steals clicks except the bottom ~2px of the icon.
  '[data-desktop-update-button]{-webkit-app-region:no-drag!important}',
  // Headless dialog card: wider than the 380px default, and the card's own
  // bottom padding is replaced by the dialog body's.
  '.dsh-desktop-update-dialog{width:min(440px,100%);max-height:calc(100dvh - 48px);padding-bottom:0}',
  '[data-desktop-update-dialog-card]{display:flex;flex-direction:column;gap:16px;padding:22px 24px 20px;min-width:0}',
  '[data-desktop-update-dialog-head]{display:flex;align-items:center;gap:12px;min-width:0}',
  '[data-desktop-update-dialog-icon]{flex:none;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center}',
  '[data-desktop-update-dialog-title]{margin:0;font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '[data-desktop-update-dialog-description]{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}',
  '[data-desktop-update-progress-block]{display:flex;flex-direction:column;gap:8px}',
  '[data-desktop-update-progress-meta]{display:flex;align-items:baseline;justify-content:space-between;gap:12px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary))}',
  '[data-desktop-update-progress]{height:6px;border-radius:999px;background:var(--dsw-alias-border-l);overflow:hidden}',
  '[data-desktop-update-progress-fill]{height:100%;border-radius:inherit;background:var(--dsw-alias-label-primary);transition:width .15s linear}',
  '[data-desktop-update-progress][data-indeterminate] [data-desktop-update-progress-fill]{width:36%;transition:none;animation:desktop-update-indeterminate 1.1s ease-in-out infinite}',
  '@keyframes desktop-update-indeterminate{0%{margin-left:-36%}100%{margin-left:100%}}',
  '@media (prefers-reduced-motion:reduce){[data-desktop-update-progress][data-indeterminate] [data-desktop-update-progress-fill]{animation:none;width:100%}}',
  '[data-desktop-update-dialog-footer]{display:flex;align-items:center;justify-content:flex-end;gap:8px}',
  // The notes pane scrolls inside the capped card instead of shoving the
  // footer off-screen.
  '[data-desktop-update-notes]{margin:0;min-height:0;max-height:min(240px,36vh);overflow:auto;overscroll-behavior:contain;padding:12px 14px;border:1px solid var(--dsw-alias-border-l);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);}',
  '[data-desktop-update-notes] h3{margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));}',
  '[data-desktop-update-notes][data-empty] p{margin:0;font-size:13px;line-height:1.5;opacity:.72}',
  '[data-desktop-update-changelog]{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.55}',
  '[data-desktop-update-changelog] h4{margin:0;font-size:12px;font-weight:600}',
  '[data-desktop-update-changelog] p{margin:0}',
  '[data-desktop-update-changelog] ul{margin:0;padding-left:1.15em}',
  '[data-desktop-update-changelog] li{margin:0 0 4px}',
  '[data-desktop-update-changelog] li:last-child{margin:0}',
].join('')

/** Version carried by the status variants that have one. */
function statusVersionOf(status: DesktopUpdateStatus): string | undefined {
  return 'version' in status ? status.version : undefined
}

/** The compact updater button rendered beside the sidebar toggle. */
export function UpdateControl(props: UpdateIndicatorProps): ReactElement | null {
  const { checkUpdate, getUpdateStatus, updateGeneration, downloadUpdate, cancelUpdate, installUpdate, t } = props
  const [status, setStatus] = useState<DesktopUpdateStatus>({ phase: 'idle' })
  const [requested, setRequested] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const mounted = useRef(true)
  const statusRequest = useRef(0)
  /** Notes survive preparing/downloading snapshots that omit the field. */
  const lastNotes = useRef('')
  /** Version survives the versionless preparing snapshot. */
  const lastVersion = useRef('')
  /** Previous phase, for the busy → ready auto-reopen of the dialog. */
  const prevPhase = useRef<DesktopUpdateStatus['phase']>('idle')

  const refreshStatus = useCallback(async (
    requestGeneration: number,
    fallback?: DesktopUpdateStatus,
  ): Promise<void> => {
    const sequence = ++statusRequest.current
    try {
      const snapshot = await getUpdateStatus()
      if (mounted.current && updateGeneration() === requestGeneration && statusRequest.current === sequence) {
        const incoming = visibleUpdateNotes(notesFromStatus(snapshot))
        if (incoming.length > 0) lastNotes.current = incoming
        const version = statusVersionOf(snapshot)
        if (version !== undefined && version !== '') lastVersion.current = version
        setStatus(snapshot)
      }
    } catch {
        if (fallback !== undefined
          && mounted.current
          && updateGeneration() === requestGeneration
          && statusRequest.current === sequence) {
          const incoming = visibleUpdateNotes(notesFromStatus(fallback))
          if (incoming.length > 0) lastNotes.current = incoming
          const version = statusVersionOf(fallback)
          if (version !== undefined && version !== '') lastVersion.current = version
          setStatus(fallback)
        }
    }
  }, [getUpdateStatus, updateGeneration])

  const startDownload = useCallback((target?: string): void => {
    setRequested(true)
    setStatus(target === undefined ? { phase: 'preparing' } : { phase: 'preparing', version: target })
    void (async () => {
      try {
        const request = downloadUpdate()
        const requestGeneration = updateGeneration()
        await request
        await refreshStatus(requestGeneration)
      } catch {
        const fallback: DesktopUpdateStatus = target === undefined
          ? { phase: 'failed', message: 'Update download failed' }
          : { phase: 'failed', version: target, message: 'Update download failed' }
        await refreshStatus(updateGeneration(), fallback)
      }
    })()
  }, [downloadUpdate, refreshStatus, updateGeneration])

  useEffect(() => {
    mounted.current = true
    const run = (force: boolean): void => {
      const request = checkUpdate(force)
      const requestGeneration = updateGeneration()
      request.then(
        (found) => {
          if (mounted.current && updateGeneration() === requestGeneration) setRequested(false)
          if (found !== null) {
            const incoming = visibleUpdateNotes(found.notes)
            if (incoming.length > 0) lastNotes.current = incoming
            lastVersion.current = found.version
          }
          void refreshStatus(requestGeneration, statusFromCheck(found))
        },
        () => { void refreshStatus(requestGeneration) },
      )
    }
    void refreshStatus(updateGeneration())
    const first = setTimeout(() => { run(false) }, FIRST_CHECK_DELAY_MS)
    const interval = setInterval(() => { run(true) }, UPDATE_INTERVAL_MS)
    return () => {
      mounted.current = false
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [checkUpdate, refreshStatus, updateGeneration])

  useEffect(() => {
    if (!isUpdateBusy(status)) return
    let pending = false
    const poll = (): void => {
      if (pending) return
      pending = true
      const requestGeneration = updateGeneration()
      refreshStatus(requestGeneration).finally(() => { pending = false })
    }
    const timer = setInterval(poll, 120)
    return () => { clearInterval(timer) }
  }, [refreshStatus, status, updateGeneration])

  // A user-driven download that finishes while the dialog is hidden reopens it
  // for the restart confirmation.
  useEffect(() => {
    const previous = prevPhase.current
    prevPhase.current = status.phase
    if (!requested) return
    if ((previous === 'preparing' || previous === 'downloading') && status.phase === 'ready') {
      setDialogOpen(true)
    }
  }, [status, requested])

  const onActivate = useCallback(() => {
    if (isUpdateBusy(status) || status.phase === 'ready') {
      setDialogOpen(true)
      return
    }
    const target = statusVersionOf(status)
    void (async () => {
      try {
        if (status.phase === 'failed') {
          const found = await checkUpdate(true)
          if (found === null) {
            setRequested(false)
            setStatus({ phase: 'current' })
            await refreshStatus(updateGeneration(), { phase: 'current' })
            return
          }
          setDialogOpen(true)
          startDownload(found.version)
          return
        }
        setDialogOpen(true)
        startDownload(target)
      } catch {
        const fallback: DesktopUpdateStatus = target === undefined
          ? { phase: 'failed', message: 'Update download failed' }
          : { phase: 'failed', version: target, message: 'Update download failed' }
        await refreshStatus(updateGeneration(), fallback)
      }
    })()
  }, [checkUpdate, refreshStatus, startDownload, status, updateGeneration])

  const onCancelDownload = useCallback(() => {
    setDialogOpen(false)
    void (async () => {
      try {
        await cancelUpdate()
      } catch {
        // Archived shells without the cancel command keep downloading; the
        // status resync below leaves the spinner clickable for reopening.
      }
      await refreshStatus(updateGeneration())
    })()
  }, [cancelUpdate, refreshStatus, updateGeneration])

  const onInstall = useCallback(() => {
    if (status.phase !== 'ready') return
    setDialogOpen(false)
    const request = installUpdate()
    const requestGeneration = updateGeneration()
    setStatus({ phase: 'installing', version: status.version })
    request.catch(() => {
      void refreshStatus(requestGeneration, {
        phase: 'failed',
        version: status.version,
        message: 'Update install failed',
      })
    })
  }, [installUpdate, refreshStatus, status, updateGeneration])

  const visible = isUpdateIndicatorVisible(status) || (requested && status.phase === 'failed')
  if (!visible) return null

  const busy = isUpdateBusy(status)
  const percent = updatePercent(status)
  const version = statusVersionOf(status) ?? lastVersion.current
  const notes = visibleUpdateNotes(
    (status.phase === 'ready' ? status.notes : '') || lastNotes.current,
  )
  const cutover = isElectronCutoverNotes(notes)
  const noteBlocks = parseUpdateNotes(notes)
  const title = status.phase === 'available'
    ? t('update.available', { version: status.version })
    : status.phase === 'downloading' && percent !== undefined
      ? t('update.progress', { percent })
      : status.phase === 'ready'
        ? t('update.ready', { version: status.version })
        : status.phase === 'failed'
          ? t('update.failed')
          : status.phase === 'installing' || status.phase === 'restarting'
            ? t('update.installing')
            : t('update.preparing')
  const icon = status.phase === 'ready'
    ? <IconCheckOutline16 />
    : busy
      ? <span data-desktop-update-spinner=""><IconLoadingOutline16 /></span>
      : <IconDownloadOutline16 />

  const dialogVisible = dialogOpen
    && (status.phase === 'preparing' || status.phase === 'downloading' || status.phase === 'ready'
      || status.phase === 'failed' || status.phase === 'installing' || status.phase === 'restarting')
  const downloading = status.phase === 'preparing' || status.phase === 'downloading'
  const installing = status.phase === 'installing' || status.phase === 'restarting'
  const dialogTitle = downloading
    ? t('update.dialog.downloading', { version })
    : status.phase === 'ready'
      ? t(cutover ? 'update.confirm.downloadTitle' : 'update.dialog.ready', { version })
      : status.phase === 'failed'
        ? t('update.dialog.failed')
        : t('update.installing')
  // The dialog header shows the static app logo in every phase; live progress
  // belongs to the bar and the byte counter, not a spinning icon.
  const dialogIcon = <UpdateLogo />
  const bytesLabel = status.phase === 'downloading'
    ? status.total === undefined
      ? formatBytes(status.downloaded)
      : `${formatBytes(status.downloaded)} / ${formatBytes(status.total)}`
    : t('update.preparing')

  return (
    <>
      <style>{UPDATE_CONTROL_CSS}</style>
      <button
        type="button"
        data-desktop-rail-button=""
        data-desktop-update-button=""
        aria-label={title}
        aria-busy={busy}
        title={title}
        onClick={onActivate}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '22px',
          height: '22px',
          borderRadius: '6px',
          cursor: 'pointer',
          opacity: busy ? 0.72 : 1,
          color: 'inherit',
          pointerEvents: 'auto',
        }}
        onMouseEnter={(event) => { if (!busy) event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)' }}
        onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent' }}
      >
        {icon}
      </button>
      <Modal
        open={dialogVisible}
        onClose={() => { setDialogOpen(false) }}
        className="dsh-desktop-update-dialog"
        title={dialogTitle}
        headless
      >
        <div data-desktop-update-dialog-card="">
          <div data-desktop-update-dialog-head="">
            <span data-desktop-update-dialog-icon="">{dialogIcon}</span>
            <h2 data-desktop-update-dialog-title="">{dialogTitle}</h2>
          </div>
          {downloading && (
            <div data-desktop-update-progress-block="">
              <div data-desktop-update-progress-meta="">
                <span>{t('update.dialog.progress')}</span>
                <span>{bytesLabel}</span>
              </div>
              <div
                data-desktop-update-progress=""
                role="progressbar"
                aria-label={t('update.dialog.progress')}
                aria-valuemin={0}
                aria-valuemax={100}
                {...(percent === undefined
                  ? { 'data-indeterminate': '' }
                  : { 'aria-valuenow': percent })}
              >
                <div
                  data-desktop-update-progress-fill=""
                  style={percent === undefined ? undefined : { width: `${percent}%` }}
                />
              </div>
            </div>
          )}
          {status.phase === 'ready' && (
            <>
              <p data-desktop-update-dialog-description="">
                {t(cutover ? 'update.confirm.downloadDescription' : 'update.confirm.description', { version })}
              </p>
              <section
                data-desktop-update-notes=""
                data-empty={notes.length === 0 ? '' : undefined}
                aria-label={t('update.confirm.notes')}
              >
                <h3>{t('update.confirm.notes')}</h3>
                {notes.length === 0 || noteBlocks.length === 0
                  ? <p>{t('update.confirm.empty')}</p>
                  : (
                    <div data-desktop-update-changelog="">
                      {noteBlocks.map((block, index) => {
                        if (block.type === 'heading') return <h4 key={index}>{block.text}</h4>
                        if (block.type === 'list') {
                          return (
                            <ul key={index}>
                              {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
                            </ul>
                          )
                        }
                        return <p key={index}>{block.text}</p>
                      })}
                    </div>
                  )}
              </section>
            </>
          )}
          {status.phase === 'failed' && (
            <p data-desktop-update-dialog-description="">{status.message}</p>
          )}
          {installing && (
            <p data-desktop-update-dialog-description="">{t('update.installing')}</p>
          )}
          {!installing && (
            <div data-desktop-update-dialog-footer="">
              {downloading && (
                <Button variant="outline" size="sm" onClick={onCancelDownload}>
                  {t('update.dialog.cancel')}
                </Button>
              )}
              {status.phase === 'ready' && (
                <>
                  <Button variant="outline" size="sm" onClick={() => { setDialogOpen(false) }}>
                    {t('update.confirm.later')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={onInstall}>
                    {t(cutover ? 'update.confirm.download' : 'update.dialog.restart')}
                  </Button>
                </>
              )}
              {status.phase === 'failed' && (
                <>
                  <Button variant="outline" size="sm" onClick={() => { setDialogOpen(false) }}>
                    {t('update.dialog.close')}
                  </Button>
                  <Button variant="primary" size="sm" onClick={onActivate}>
                    {t('update.dialog.retry')}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}

/** Non-macOS fallback where no overlay-titlebar rail exists. */
export function UpdateIndicator(props: UpdateIndicatorProps): ReactElement {
  return (
    <div
      data-desktop-update-indicator=""
      style={{
        position: 'absolute',
        top: '8px',
        right: '14px',
        height: '22px',
        display: 'flex',
        alignItems: 'center',
        zIndex: 1,
        color: 'var(--dsw-alias-label-primary)',
        pointerEvents: 'none',
      }}
    >
      <UpdateControl {...props} />
    </div>
  )
}
