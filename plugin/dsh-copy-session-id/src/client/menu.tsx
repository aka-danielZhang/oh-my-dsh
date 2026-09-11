/**
 * The taken-over session-header ellipsis menu, browser half.
 *
 * This plugin reuses the shipped cell id `session-log-download` in the
 * additive `conversation.session.header.utilities` seat, which — per the
 * slot contract — puts it IN that cell and replaces its occupant. It
 * therefore re-renders the stock affordances it displaces:
 *
 * - the 28px ellipsis anchor button (same `.moreButton` dress);
 * - the "Download Session Log" menu item, wired to the stock controller
 *   through the `sessionLogDownload` cordis service (never an import);
 * - the download status dialog driven by that controller's state store.
 *
 * Plus the new first item: Copy Session ID.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { browserCopyDeps, copyText } from './copy-text.ts'
import type { SessionLogActions, SessionLogEntry } from './download-state.ts'
import { NS } from './locales.ts'

/** Provider-owned timer one-shot handed to the component (Cordis `timer`). */
export type Defer = (fn: () => void, ms: number) => () => void

/** Actions injected into this contribution (per-session, see index.ts). */
export type SessionActionsMenuInjected = SessionLogActions

/** Full props of the session-actions menu contribution. */
export type SessionActionsMenuProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionActionsMenuInjected>

/** How long the copied confirmation stays on the menu item. */
const COPIED_FLASH_MS = 1600

/** How long the success status dialog lingers before it closes itself. */
const SUCCESS_AUTO_CLOSE_MS = 5000

/** The ellipsis glyph of the anchor button (stock moreButton size). */
function EllipsisIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  )
}

/** The copy glyph of the Copy Session ID item. */
function CopyIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </svg>
  )
}

/** The confirmation glyph shown while the copied state is live. */
function CheckIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

/** The download glyph of the Download Session Log item (stock menu icon). */
function DownloadIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v11" />
      <path d="M6.5 9.5 12 15l5.5-5.5" />
      <path d="M4 16.5V18a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-1.5" />
    </svg>
  )
}

/**
 * The download status dialog driven by the stock controller's state: the
 * stock export plugin renders this itself, so replacing its cell means
 * re-rendering it here (same phases, same dismissal semantics).
 * @param props - the entry to present, its dismiss verb, and the locale.
 * @returns the dialog, or null when no entry is open.
 */
function DownloadStatusDialog(props: { entry: SessionLogEntry; dismiss: () => void; defer: Defer; t: SessionActionsMenuProps['t'] }): ReactNode {
  const { entry, dismiss, defer, t } = props
  const status = entry.status
  useEffect(() => {
    if (status !== 'success') return undefined
    return defer(dismiss, SUCCESS_AUTO_CLOSE_MS)
  }, [status, dismiss, defer])
  const title = status === 'downloading'
    ? t('status.preparingTitle')
    : status === 'success' ? t('status.successTitle') : t('status.errorTitle')
  const description = status === 'downloading'
    ? t('status.preparingDesc')
    : status === 'success' ? t('status.successDesc') : (entry.error ?? t('status.unknownError'))
  const titleStyle = status === 'error'
    ? { color: 'var(--dsw-alias-state-error-primary)' }
    : status === 'success' ? { color: 'var(--dsw-alias-state-success-primary)' } : undefined
  return (
    <>
      <button type="button" className="dsh-csid-backdrop" aria-label={t('status.close')} onClick={dismiss} />
      <div className="dsh-csid-dialog" role="alertdialog" aria-label={title}>
        <p className="dsh-csid-dialog-title" style={titleStyle}>{title}</p>
        <p className="dsh-csid-dialog-desc">{description}</p>
        <div className="dsh-csid-dialog-foot">
          <button type="button" className="dsh-csid-dialog-close" onClick={dismiss}>{t('status.close')}</button>
        </div>
      </div>
    </>
  )
}

/**
 * Session-header "more actions" contribution: the ellipsis anchor, its menu
 * (Copy Session ID + Download Session Log), and the download status dialog.
 * @param props - injected session actions and localized copy.
 * @returns the anchor and its popovers.
 */
export function SessionActionsMenu(props: SessionActionsMenuProps): ReactNode {
  const { sessionId, t, defer, downloadAvailable, download, dismiss, readDownload, subscribeDownload } = props
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [entry, setEntry] = useState<SessionLogEntry | null>(null)

  useEffect(() => {
    const read = (): void => { setEntry(readDownload()) }
    read()
    return subscribeDownload(read)
  }, [readDownload, subscribeDownload])

  useEffect(() => {
    if (!copied) return undefined
    return defer(() => { setCopied(false) }, COPIED_FLASH_MS)
  }, [copied, defer])

  const busy = entry !== null && entry.status === 'downloading'

  const onCopy = (): void => {
    setOpen(false)
    copyText(String(sessionId), browserCopyDeps()).then(() => {
      setCopied(true)
    }, (error: unknown) => {
      console.error('copy-session-id: copy failed', error)
    })
  }

  return (
    <span className="dsh-csid-wrap">
      <button
        type="button"
        className="dsh-csid-anchor"
        aria-label={t('header.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={busy || undefined}
        onClick={() => { setOpen(value => !value) }}
      >
        <EllipsisIcon />
      </button>
      {open && (
        <button
          type="button"
          className="dsh-csid-veil"
          aria-label={t('header.more')}
          tabIndex={-1}
          onClick={() => { setOpen(false) }}
        />
      )}
      {open && (
        <div
          className="dsh-csid-menu"
          role="menu"
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
        >
          <button
            type="button"
            role="menuitem"
            className="dsh-csid-item"
            title={String(sessionId)}
            onClick={onCopy}
          >
            <span className="dsh-csid-item-icon">{copied ? <CheckIcon /> : <CopyIcon />}</span>
            <span>{copied ? t('menu.copied') : t('menu.copy')}</span>
          </button>
          {downloadAvailable && (
            <button
              type="button"
              role="menuitem"
              className="dsh-csid-item"
              disabled={busy}
              onClick={() => {
                setOpen(false)
                download()
              }}
            >
              <span className="dsh-csid-item-icon"><DownloadIcon /></span>
              <span>{busy ? t('menu.downloading') : t('menu.download')}</span>
            </button>
          )}
        </div>
      )}
      {entry !== null && entry.open && (
        <DownloadStatusDialog entry={entry} dismiss={dismiss} defer={defer} t={t} />
      )}
    </span>
  )
}
