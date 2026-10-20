/**
 * Quiet updater control (the sidebar header action, footer fallback on old
 * runtimes) plus its download dialog and the collapsed-rail badge.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconDownloadOutlineRegular,
  IconLoadingOutlineRegular,
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
  // The button sizes itself inline (all:unset + 22px box); the sheet adds
  // only the hover fill and the no-drag hole that survives the unset.
  '[data-desktop-update-button]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
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

/**
 * Collapsed-rail badge CSS. The toggle is `position:relative` (ui-sidebar's
 * `.iconButton`), so the badge pins to its top-right corner; `pointer-events`
 * stays off so every click falls through to the toggle underneath.
 */
const UPDATE_BADGE_CSS = [
  '@keyframes desktop-update-badge-spin{to{transform:rotate(360deg)}}',
  '[data-desktop-update-badge]{position:absolute;top:-1px;right:-1px;display:inline-flex;align-items:center;justify-content:center;width:9px;height:9px;border-radius:999px;background:var(--dsw-alias-bg-overlay);box-shadow:0 0 0 1px var(--dsw-alias-bg-overlay);pointer-events:none}',
  '[data-desktop-update-badge-dot]{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-brand-text)}',
  '[data-desktop-update-badge-spin]{width:7px;height:7px;box-sizing:border-box;border-radius:999px;border:1.5px solid var(--dsw-alias-border-l);border-top-color:var(--dsw-alias-brand-text);animation:desktop-update-badge-spin .8s linear infinite}',
  '@media (prefers-reduced-motion:reduce){[data-desktop-update-badge-spin]{animation:none}}',
  '[data-desktop-update-badge-ring-fill]{transition:stroke-dashoffset .15s linear}',
  '@media (prefers-reduced-motion:reduce){[data-desktop-update-badge-ring-fill]{transition:none}}',
].join('')

/** Badge poll cadence: quiet when nothing moves, tight while a download does. */
const BADGE_IDLE_POLL_MS = 1000
const BADGE_BUSY_POLL_MS = 150

/** Ring geometry for the micro progress indicator (9px box, 3px radius). */
const RING_RADIUS = 3
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** Version carried by the status variants that have one. */
function statusVersionOf(status: DesktopUpdateStatus): string | undefined {
  return 'version' in status ? status.version : undefined
}

/** The compact updater button seated in the sidebar foot. */
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
    ? <IconCheckOutlineRegular />
    : busy
      ? <span data-desktop-update-spinner=""><IconLoadingOutlineRegular /></span>
      : <IconDownloadOutlineRegular />

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
      <style data-plugin="dsh-desktop-bridge" data-plugin-css="dsh-desktop-bridge/update-control">{UPDATE_CONTROL_CSS}</style>
      <button
        type="button"
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

/**
 * Header form of the updater: the same control, absent in the collapsed rail
 * (the toggle badge speaks there — 56px leaves no room for a second button).
 * @param props - the updater face, locale seat, and the owner's column state.
 * @returns the control when the column is wide, otherwise nothing.
 */
export function HeaderUpdateControl(props: UpdateIndicatorProps & { wide: boolean }): ReactElement | null {
  if (!props.wide) return null
  return <UpdateControl {...props} />
}

/** Phases the rail badge speaks for; a background check stays silent. */
function isRailBadgeVisible(status: DesktopUpdateStatus): boolean {
  return status.phase === 'available'
    || status.phase === 'ready'
    || status.phase === 'failed'
    || status.phase === 'preparing'
    || status.phase === 'downloading'
    || status.phase === 'installing'
    || status.phase === 'restarting'
}

/**
 * Poll the shell's updater snapshot while the rail badge is mounted. The
 * header control unmounts with the expanded column, so the badge cannot share
 * its state and polls on its own: once a second at rest, tightly while a
 * download owns the updater.
 * @param read - the shell status reader.
 * @returns the latest snapshot, or undefined before the first reply.
 */
function useRailStatus(read: () => Promise<DesktopUpdateStatus>): DesktopUpdateStatus | undefined {
  const [status, setStatus] = useState<DesktopUpdateStatus | undefined>(undefined)
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      let next: DesktopUpdateStatus | undefined
      try {
        next = await read()
      } catch {
        next = undefined
      }
      if (!live) return
      if (next !== undefined) setStatus(next)
      const busy = next !== undefined
        && (next.phase === 'preparing' || next.phase === 'downloading'
          || next.phase === 'installing' || next.phase === 'restarting')
      timer = setTimeout(() => { void poll() }, busy ? BADGE_BUSY_POLL_MS : BADGE_IDLE_POLL_MS)
    }
    void poll()
    return () => {
      live = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [read])
  return status
}

/**
 * The collapsed-rail update badge: a dot for a waiting package or a failed
 * download, a micro progress ring while the updater works. Rendered inside the
 * sidebar toggle, so it never owns a click.
 * @param props - the updater face and locale seat.
 * @returns the badge, or nothing when the updater has no news.
 */
export function UpdateBadge(props: UpdateIndicatorProps): ReactElement | null {
  const { getUpdateStatus, t } = props
  const status = useRailStatus(getUpdateStatus)
  if (status === undefined || !isRailBadgeVisible(status)) return null
  const percent = updatePercent(status)
  const working = status.phase === 'preparing' || status.phase === 'downloading'
    || status.phase === 'installing' || status.phase === 'restarting'
  const label = status.phase === 'available'
    ? t('update.available', { version: status.version })
    : status.phase === 'ready'
      ? t('update.ready', { version: status.version })
      : status.phase === 'failed'
        ? t('update.failed')
        : percent === undefined
          ? t('update.preparing')
          : t('update.progress', { percent })
  const ring = working && percent !== undefined
    ? (
      <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
        <circle cx="4.5" cy="4.5" r={RING_RADIUS} fill="none" stroke="var(--dsw-alias-border-l)" strokeWidth="1.4" />
        <circle
          cx="4.5" cy="4.5" r={RING_RADIUS} fill="none" stroke="var(--dsw-alias-brand-text)" strokeWidth="1.4"
          strokeLinecap="round" strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
          transform="rotate(-90 4.5 4.5)" data-desktop-update-badge-ring-fill=""
        />
      </svg>
    )
    : working
      ? <span data-desktop-update-badge-spin="" />
      : <span data-desktop-update-badge-dot="" />
  return (
    <>
      <style data-plugin="dsh-desktop-bridge" data-plugin-css="dsh-desktop-bridge/update-badge">{UPDATE_BADGE_CSS}</style>
      <span data-desktop-update-badge="" data-phase={status.phase} role="img" aria-label={label}>{ring}</span>
    </>
  )
}
