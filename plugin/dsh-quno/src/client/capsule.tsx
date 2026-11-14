/**
 * The in-conversation Quno capsule.
 *
 * Registration stays on `conversation.session.header.utilities` because that
 * seat provides the session id, the preset projection and the lifetime. The
 * visible pill, however, is NOT rendered into the header's button row: the
 * component emits a hidden sentinel there and portals the pill into this
 * session's own `[data-conversation-content]` container. That container is
 * `position: relative`, owns the scrollport and the composer, and resizes with
 * both sidebars — so the pill sits at the content's top-right corner without
 * any fixed-position math.
 *
 * Interaction: the pill opens a summary flyout; choosing a row closes the
 * flyout, hides the pill immediately (the panel is about to animate in) and
 * opens the right panel on that view. Closing the panel brings the pill back
 * while there is still something to report.
 *
 * @module dsh-quno/client/capsule
 */

import React from 'react'
import { createPortal } from 'react-dom'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QunoTranslate } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { QunoPanelView } from './right-tab.ts'
import { QUNO_PANEL_KIND } from './right-tab.ts'
import { format } from './locales.ts'
import {
  capsuleItems,
  capsuleSummaries,
  capsuleTotal,
  capsuleVisibility,
  isCapsuleVisible,
  panelCounts,
  type CapsuleKind,
} from './view-model.ts'
import {
  escapeSelector,
  findConversationContent,
  isCompactCapsule,
  isQunoPanelVisible,
  readGeometry,
  type CapsuleGeometry,
} from './capsule-anchor.ts'
import { CapsuleFlyout, capsuleIcon, type CapsuleRow } from './capsule-flyout.tsx'
import { PanelIcon } from './panel-primitives.tsx'
import { QunoMark } from './quno-mark.tsx'

/** Structural face of `ctx.sidebarRight` this capsule consumes (duck-checked upstream). */
export interface SidebarRightFace {
  /** Open a page type by kind; the column expands in the same step. */
  openTab(kind: string, options?: { params?: unknown }): void
}

/** Injected face of the capsule. */
export interface QunoCapsuleInjected {
  readonly store: QunoClientStore
  readonly t: QunoTranslate
  readonly face: SidebarRightFace | undefined
}

/** Left offset of the flyout's available width (content padding + margin). */
const WIDTH_GUTTER = 24
/** Vertical room kept free below the flyout (composer breathing space). */
const HEIGHT_GUTTER = 64

/** Render the capsule pill + its summary flyout, or nothing when it does not apply. */
export function QunoCapsule(props: PropsRuntime<'conversation.session.header.utilities'> & QunoCapsuleInjected): React.ReactElement | null {
  const snapshot = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
  const face = props.face
  const sessionId = props.sessionId
  const preset = props.useSessions(sessions => sessions.byId[sessionId]?.projectionValues?.agentPreset)

  const [sentinel, setSentinel] = React.useState<HTMLSpanElement | null>(null)
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null)
  const [geometry, setGeometry] = React.useState<CapsuleGeometry>({ width: 0, height: 0 })
  const [open, setOpen] = React.useState(false)
  const [panelVisible, setPanelVisible] = React.useState(() =>
    typeof document !== 'undefined' && isQunoPanelVisible(sessionId))
  const [navigationHidden, setNavigationHidden] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const flyoutId = React.useId()

  const state = snapshot.state
  const counts = state === null ? null : panelCounts(state)
  const items = counts === null ? [] : capsuleItems(counts)
  const summaries = state === null
    ? []
    : capsuleSummaries({ tasks: state.tasks, attention: state.attention, senses: state.senses, senseTypes: state.senseTypes })

  const visibility = capsuleVisibility({
    preset,
    hasFace: face !== undefined,
    hasContent: items.length > 0,
    hasAnchor: anchor !== null,
    panelVisible,
    navigationHidden,
    open,
  })

  // A different session is a different capsule: no flyout, no leftover hide.
  React.useEffect(() => {
    setOpen(false)
    setNavigationHidden(false)
    setNotice(null)
    if (typeof document !== 'undefined') setPanelVisible(isQunoPanelVisible(sessionId))
  }, [sessionId])

  // Resolve the portaled anchor (and re-resolve once the content mounts).
  React.useLayoutEffect(() => {
    if (sentinel === null) {
      setAnchor(null)
      return
    }
    const settle = (): void => {
      const next = findConversationContent(sentinel, sessionId)
      setAnchor(previous => previous === next ? previous : next)
      if (next !== null) {
        const box = readGeometry(next)
        setGeometry(previous => previous.width === box.width && previous.height === box.height ? previous : box)
      }
    }
    settle()
    const frame = requestAnimationFrame(settle)
    return () => { cancelAnimationFrame(frame) }
  }, [sentinel, sessionId])

  // Native content can be rebuilt (hero → active, layout change). Re-resolve
  // instead of portalling into a detached node.
  React.useEffect(() => {
    if (anchor === null || sentinel === null) return
    const parent = anchor.parentElement
    if (parent === null) return
    const observer = new MutationObserver(() => {
      if (anchor.isConnected) return
      setAnchor(findConversationContent(sentinel, sessionId))
    })
    observer.observe(parent, { childList: true })
    return () => { observer.disconnect() }
  }, [anchor, sentinel, sessionId])

  // Width/height of the content column drive compact mode and the flyout caps.
  React.useLayoutEffect(() => {
    if (anchor === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { setGeometry(readGeometry(anchor)) })
    observer.observe(anchor)
    return () => { observer.disconnect() }
  }, [anchor])

  // Panel visibility is session-scoped: another session's open panel must not
  // hide this pill. Observe only this session's right-panel subtree.
  React.useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const sync = (): void => { setPanelVisible(isQunoPanelVisible(sessionId)) }
    sync()
    const observer = new MutationObserver(sync)
    const attach = (): boolean => {
      const root = document.querySelector(`[data-sidebar-right-session="${escapeSelector(sessionId)}"]`)
      if (root === null) return false
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-sidebar-right-open'],
      })
      return true
    }
    let attached = attach()
    // The right panel can mount after the conversation; wait only until it does.
    const waiter = new MutationObserver(() => {
      if (attached) return
      attached = attach()
      if (attached) waiter.disconnect()
    })
    if (!attached) waiter.observe(document.body, { childList: true })
    return () => {
      observer.disconnect()
      waiter.disconnect()
    }
  }, [sessionId])

  // `navigationHidden` covers the open animation. Once the panel is visible it
  // takes over the hiding; if it never opens, the pill returns.
  React.useEffect(() => {
    if (!navigationHidden) return
    if (panelVisible) {
      setNavigationHidden(false)
      return
    }
    const timer = setTimeout(() => {
      if (!isQunoPanelVisible(sessionId)) setNavigationHidden(false)
    }, 1500)
    return () => { clearTimeout(timer) }
  }, [navigationHidden, panelVisible, sessionId])

  // Any hidden state closes the flyout; a hidden pill must not keep a dialog.
  React.useEffect(() => {
    if (!isCapsuleVisible(visibility) && open) setOpen(false)
  }, [visibility, open])

  React.useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => { setNotice(null) }, 4000)
    return () => { clearTimeout(timer) }
  }, [notice])

  // Outside click / Escape. The root ref points into the PORTAL, so clicks on
  // the pill and the flyout count as inside.
  React.useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node && rootRef.current.contains(event.target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (face === undefined || preset !== 'quno') return null

  const compact = isCompactCapsule(geometry.width)
  const total = counts === null ? 0 : capsuleTotal(counts)
  const ariaLabel = counts === null
    ? props.t('capsuleTitle')
    : format(props.t('capsuleAria'), {
      tasks: counts.runningTasks,
      attention: counts.attentionOpen,
      alarms: counts.senseAlarms,
    })

  const rows: readonly CapsuleRow[] = summaries.map(summary => ({
    kind: summary.kind,
    title: summary.kind === 'activity'
      ? `${props.t('capsuleActivity')} · ${format(props.t('capsuleActivityCount'), { count: summary.count })}`
      : `${props.t(summaryLabelKey(summary.kind))} · ${summary.count}`,
    detail: summary.subject ?? props.t(subjectFallbackKey(summary.kind)),
    tone: summary.kind === 'tasks' ? 'ok' : 'warn',
    view: viewForKind(summary.kind),
  }))

  const openView = (view: QunoPanelView): void => {
    setOpen(false)
    setNotice(null)
    setNavigationHidden(true)
    try {
      face.openTab(QUNO_PANEL_KIND, { params: { view } })
    } catch {
      setNavigationHidden(false)
      setNotice(props.t('capsuleOpenFailed'))
    }
  }

  const availableWidth = Math.max(180, Math.min(300, geometry.width - WIDTH_GUTTER))
  const availableHeight = Math.max(160, Math.min(420, geometry.height - HEIGHT_GUTTER))

  const pill = (
    <button
      ref={triggerRef}
      type="button"
      style={styles.pill}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={flyoutId}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() => { setOpen(value => !value) }}
    >
      <QunoMark size={14} />
      {compact
        ? <span style={styles.count}>{total}</span>
        : items.map(item => (
          <span
            key={item.kind}
            style={{ ...styles.metric, ...(item.kind === 'activity' ? styles.metricAlarm : {}) }}
          >
            <PanelIcon kind={capsuleIcon(item.kind)} size={12} />
            <span style={styles.count}>{item.count}</span>
          </span>
        ))}
    </button>
  )

  return (
    <>
      <span
        ref={setSentinel}
        hidden
        aria-hidden="true"
        data-quno-capsule-sentinel=""
      />
      {anchor !== null && isCapsuleVisible(visibility) && createPortal(
        <div
          ref={rootRef}
          data-quno-capsule-root=""
          style={{
            '--quno-capsule-width': `${availableWidth}px`,
            '--quno-capsule-max-height': `${availableHeight}px`,
          } as React.CSSProperties}
        >
          {pill}
          {notice !== null && <div role="status" style={styles.notice}>{notice}</div>}
          {open && (
            <CapsuleFlyout
              id={flyoutId}
              t={props.t}
              rows={rows}
              onSelect={openView}
              onClose={() => { setOpen(false); triggerRef.current?.focus() }}
            />
          )}
        </div>,
        anchor,
      )}
    </>
  )
}

/** Locale key of a summary row's category label. */
function summaryLabelKey(kind: CapsuleKind): 'capsuleTasks' | 'capsuleAttention' | 'capsuleActivity' {
  switch (kind) {
    case 'tasks': return 'capsuleTasks'
    case 'attention': return 'capsuleAttention'
    case 'activity': return 'capsuleActivity'
  }
}

/** Locale fallback when a non-zero category has no representative title. */
function subjectFallbackKey(kind: CapsuleKind): 'capsuleNoTasks' | 'capsuleNoAttention' | 'capsuleAllSensesOk' {
  switch (kind) {
    case 'tasks': return 'capsuleNoTasks'
    case 'attention': return 'capsuleNoAttention'
    case 'activity': return 'capsuleAllSensesOk'
  }
}

/** The panel view a summary row opens. */
function viewForKind(kind: CapsuleKind): QunoPanelView {
  switch (kind) {
    case 'tasks': return 'task'
    case 'attention': return 'attention'
    case 'activity': return 'sense'
  }
}

const styles = {
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 9px',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 999, cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    font: 'inherit', fontSize: 12, userSelect: 'none',
  },
  metric: { display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--dsw-alias-label-secondary)' },
  metricAlarm: { color: 'var(--dsw-alias-state-warn-primary)' },
  count: { fontWeight: 600, fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
  notice: {
    marginTop: 6, maxWidth: 240, padding: '4px 8px', borderRadius: 8,
    border: '1px solid var(--dsw-alias-state-error-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, lineHeight: 1.5,
  },
} as const
