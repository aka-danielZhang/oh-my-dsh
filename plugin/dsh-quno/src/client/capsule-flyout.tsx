/**
 * The capsule's summary flyout: one row per non-zero category, each naming a
 * real record so the list is useful before the panel opens.
 *
 * Rendered inside the portaled capsule root (never in the header slot), so its
 * positioning is relative to the pill, not the window.
 *
 * @module dsh-quno/client/capsule-flyout
 */

import React from 'react'
import type { QunoTranslate } from './locales.ts'
import type { QunoPanelView } from './right-tab.ts'
import type { CapsuleKind } from './view-model.ts'
import { PanelIcon, type PanelIconKind } from './panel-primitives.tsx'
import { QunoMark } from './quno-mark.tsx'

/** One prepared flyout row. */
export interface CapsuleRow {
  readonly kind: CapsuleKind
  /** "任务 · 1" / "动态 · 1 个异常". */
  readonly title: string
  /** The representative record's title or source name. */
  readonly detail: string
  readonly tone: 'ok' | 'warn'
  readonly view: QunoPanelView
}

/** Props of the flyout. */
export interface CapsuleFlyoutProps {
  readonly id: string
  readonly t: QunoTranslate
  readonly rows: readonly CapsuleRow[]
  readonly onSelect: (view: QunoPanelView) => void
  readonly onClose: () => void
}

/** The icon a summary row uses. */
export function capsuleIcon(kind: CapsuleKind): PanelIconKind {
  switch (kind) {
    case 'tasks': return 'task'
    case 'attention': return 'attention'
    case 'activity': return 'collectors'
  }
}

/** Render the non-modal summary dialog. */
export function CapsuleFlyout(props: CapsuleFlyoutProps): React.ReactElement {
  return (
    <div
      id={props.id}
      role="dialog"
      aria-label={props.t('capsuleTitle')}
      data-quno-capsule-flyout=""
      style={styles.flyout}
    >
      <div style={styles.head}>
        <QunoMark size={16} />
        <span style={styles.headTitle}>{props.t('capsuleTitle')}</span>
        <button type="button" style={styles.close} aria-label={props.t('onboardingClose')} onClick={props.onClose}>
          ×
        </button>
      </div>
      {props.rows.map(row => (
        <button
          key={row.kind}
          type="button"
          className="dsh-quno-capsule-row"
          style={styles.row}
          onClick={() => { props.onSelect(row.view) }}
        >
          <span style={styles.rowHead}>
            <span style={row.tone === 'warn' ? styles.rowIconWarn : styles.rowIcon} aria-hidden="true">
              <PanelIcon kind={capsuleIcon(row.kind)} size={13} />
            </span>
            <span style={styles.rowTitle}>{row.title}</span>
            <span style={styles.chevron} aria-hidden="true">›</span>
          </span>
          <span style={styles.rowDetail}>{row.detail}</span>
        </button>
      ))}
    </div>
  )
}

const styles = {
  flyout: {
    display: 'flex', flexDirection: 'column',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
    background: 'var(--dsw-alias-bg-layer-2)', boxShadow: 'var(--quno-elevation)',
  },
  head: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px 8px',
    fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
  },
  headTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  close: {
    flex: 'none', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer', fontSize: 14, lineHeight: 1, width: 22, height: 22, borderRadius: 6,
  },
  row: {
    display: 'flex', flexDirection: 'column', gap: 2, width: '100%', padding: '8px 12px',
    border: 0, borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
    font: 'inherit', textAlign: 'left', cursor: 'pointer', minWidth: 0,
  },
  rowHead: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  rowIcon: { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' },
  rowIconWarn: { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-state-warn-primary)' },
  rowTitle: {
    flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  chevron: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  rowDetail: {
    paddingLeft: 20, fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
} as const
