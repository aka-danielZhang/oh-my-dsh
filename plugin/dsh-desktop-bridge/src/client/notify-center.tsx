/**
 * In-app notification center: a 22px trigger plus a simple list of recent
 * attention events. Clicking a row opens that session.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { IconQueueOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { formatInboxAge, unreadBadge, type NotifyInbox } from './notify-inbox.ts'

/** Injected face: the process inbox and the session opener. */
export interface NotifyCenterInjected {
  inbox: NotifyInbox
  openSession: (sessionId: string) => void
}

export type NotifyCenterProps = NotifyCenterInjected & PropsLocale<'desktop-bridge'> & {
  /** Dropdown alignment; rail uses start, the non-mac fallback uses end. */
  align?: 'start' | 'end'
}

const PANEL_CSS = [
  '[data-desktop-notify-root]{position:relative;pointer-events:auto;}',
  '[data-desktop-notify-button]{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;cursor:pointer;color:inherit;position:relative;-webkit-app-region:no-drag;}',
  '[data-desktop-notify-button]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '[data-desktop-notify-dot]{position:absolute;top:1px;right:1px;min-width:8px;height:8px;padding:0 2px;border-radius:8px;background:var(--dsw-alias-brand);color:var(--dsw-alias-brand-text);font-size:8px;line-height:8px;text-align:center;pointer-events:none;}',
  '[data-desktop-notify-panel]{position:absolute;top:calc(100% + 8px);left:0;z-index:20;width:280px;max-height:min(360px,50vh);display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 8px 24px var(--dsw-alias-bg-mask-drop);color:var(--dsw-alias-label-primary);pointer-events:auto;-webkit-app-region:no-drag;}',
  '[data-desktop-notify-panel][data-align=end]{left:auto;right:0;}',
  '[data-desktop-notify-head]{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;font-size:12px;font-weight:600;}',
  '[data-desktop-notify-head] button{all:unset;cursor:pointer;margin-left:auto;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);}',
  '[data-desktop-notify-head] button:hover{color:var(--dsw-alias-label-primary);}',
  '[data-desktop-notify-list]{overflow:auto;padding:0 6px 8px;}',
  '[data-desktop-notify-empty]{padding:20px 12px;font-size:12px;text-align:center;color:var(--dsw-alias-label-secondary);}',
  '[data-desktop-notify-row]{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:100%;padding:8px;border-radius:8px;cursor:pointer;}',
  '[data-desktop-notify-row]:hover{background:var(--dsw-alias-interactive-bg-hover);}',
  '[data-desktop-notify-row][data-unread]{background:var(--dsw-alias-interactive-bg-hover);}',
  '[data-desktop-notify-title]{font-size:12px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '[data-desktop-notify-meta]{font-size:11px;color:var(--dsw-alias-label-secondary);}',
].join('')

/**
 * Bell-sized trigger plus the dropdown list.
 * @param props - inbox, opener, locale.
 */
export function NotifyCenter(props: NotifyCenterProps): ReactElement {
  const { inbox, openSession, t, align = 'start' } = props
  const [open, setOpen] = useState(false)
  const [tick, setTick] = useState(0)
  const rootRef = useRef<HTMLSpanElement>(null)
  const snapshot = inbox.getSnapshot()

  useEffect(() => inbox.subscribe(() => { setTick((value) => value + 1) }), [inbox])
  useEffect(() => {
    if (!open) return undefined
    const onDoc = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node) || rootRef.current?.contains(target) !== true) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => { document.removeEventListener('mousedown', onDoc) }
  }, [open])

  const badge = unreadBadge(snapshot.unread)
  const now = Date.now()
  void tick

  return (
    <span ref={rootRef} data-desktop-notify-root="">
      <style>{PANEL_CSS}</style>
      <button
        type="button"
        data-desktop-rail-button=""
        data-desktop-notify-button=""
        aria-label={t('notify.center')}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={t('notify.center')}
        onClick={() => { setOpen((value) => !value) }}
      >
        <IconQueueOutlineRegular size={16} />
        {badge !== '' ? <span data-desktop-notify-dot="" aria-hidden="true" /> : null}
      </button>
      {open && (
        <div data-desktop-notify-panel="" data-align={align} role="dialog" aria-label={t('notify.center')}>
          <div data-desktop-notify-head="">
            <span>{t('notify.center')}</span>
            {snapshot.items.length > 0
              ? (
                <button type="button" onClick={() => { inbox.clear() }}>
                  {t('notify.clear')}
                </button>
              )
              : null}
          </div>
          {snapshot.items.length === 0
            ? <div data-desktop-notify-empty="">{t('notify.empty')}</div>
            : (
              <div data-desktop-notify-list="">
                {snapshot.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-desktop-notify-row=""
                    data-unread={item.unread ? '' : undefined}
                    onClick={() => {
                      inbox.markRead(item.id)
                      openSession(item.sessionId)
                      setOpen(false)
                    }}
                  >
                    <span data-desktop-notify-title="">{item.title}</span>
                    <span data-desktop-notify-meta="">
                      {t(item.kind === 'await-input' ? 'notify.awaitInput' : 'notify.turnDone')}
                      {' · '}
                      {formatInboxAge(item.at, now, {
                        justNow: t('notify.justNow'),
                        minutesAgo: t('notify.minutesAgo'),
                        hoursAgo: t('notify.hoursAgo'),
                      })}
                    </span>
                  </button>
                ))}
              </div>
            )}
        </div>
      )}
    </span>
  )
}

/** Non-macOS fallback: top-right, left of the updater. */
export function NotifyIndicator(props: NotifyCenterProps): ReactElement {
  return (
    <div
      data-desktop-notify-indicator=""
      style={{
        position: 'absolute',
        top: '8px',
        right: '44px',
        height: '22px',
        display: 'flex',
        alignItems: 'center',
        zIndex: 1,
        color: 'var(--dsw-alias-label-primary)',
        pointerEvents: 'none',
      }}
    >
      <NotifyCenter {...props} align="end" />
    </div>
  )
}
