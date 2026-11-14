/**
 * Presentational primitives shared by the right panel's four views and the
 * two detail pages. Token-only styling, no business state: every component
 * here takes already-decided copy and an already-decided tone.
 *
 * The split that matters:
 * - `PanelEmpty`    — the whole tab has nothing to show;
 * - `InlineEmpty`   — one section inside an otherwise populated page;
 * - `MissingState`  — a requested record does not exist;
 * - `Callout`       — a condition that needs explaining (auth, stale, failed);
 * - `LoadingRows`   — a first load only, never a background refresh.
 *
 * @module dsh-quno/client/panel-primitives
 */

import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Tone } from './panel-state.ts'

/** Neutral line icons; no new icon dependency and no per-source mascots. */
export type PanelIconKind = 'collectors' | 'attention' | 'task' | 'run' | 'event'

const ICONS: Record<PanelIconKind, React.ReactNode> = {
  collectors: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M3.2 8a4.8 4.8 0 0 1 4.8-4.8" />
      <path d="M12.8 8A4.8 4.8 0 0 1 8 12.8" />
    </>
  ),
  attention: (
    <>
      <path d="M8 2.6a4 4 0 0 0-4 4v2.6L2.9 11h10.2L12 9.2V6.6a4 4 0 0 0-4-4Z" />
      <path d="M6.4 13a1.7 1.7 0 0 0 3.2 0" />
    </>
  ),
  task: (
    <>
      <rect x="3" y="3" width="10" height="10" rx="2.4" />
      <path d="m5.7 8 1.6 1.6 3-3.2" />
    </>
  ),
  run: <path d="M2.5 8.5h2.6L7 4.6l2.4 7 1.6-3.1h2.5" />,
  event: (
    <>
      <path d="M4 3.2h6.4L13 5.8v7H4z" />
      <path d="M10 3.4V6h2.6" />
    </>
  ),
}

/** One 16px line icon in `currentColor`. */
export function PanelIcon(props: { readonly kind: PanelIconKind; readonly size?: number }): React.ReactElement {
  return (
    <svg
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={styles.icon}
    >
      {ICONS[props.kind]}
    </svg>
  )
}

const TONE_TOKEN: Record<Tone, string> = {
  ok: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  idle: 'var(--dsw-alias-label-tertiary)',
}

/** A small status chip whose tint comes from the theme's state token. */
export function StatusLabel(props: { readonly tone: Tone; readonly children: React.ReactNode }): React.ReactElement {
  const token = TONE_TOKEN[props.tone]
  return (
    <span
      style={{
        ...styles.chip,
        color: props.tone === 'idle' ? 'var(--dsw-alias-label-secondary)' : token,
        background: props.tone === 'idle'
          ? 'color-mix(in srgb, var(--dsw-alias-label-secondary) 12%, transparent)'
          : `color-mix(in srgb, ${token} 14%, transparent)`,
      }}
    >
      {props.children}
    </span>
  )
}

/** A status dot; the accessible label lives on the row, not on the dot. */
export function StatusDot(props: { readonly tone: Tone }): React.ReactElement {
  return <span style={{ ...styles.dot, background: TONE_TOKEN[props.tone] }} aria-hidden="true" />
}

/** Props of one list row. */
export interface PanelListRowProps {
  readonly title: string
  readonly subtitle?: string
  readonly meta?: React.ReactNode
  readonly icon?: PanelIconKind
  readonly tone?: Tone
  readonly onClick?: () => void
  readonly titleAttr?: string
}

/**
 * One list row: icon or status dot, a title that truncates, optional meta, and
 * a chevron only when the row actually drills down.
 */
export function PanelListRow(props: PanelListRowProps): React.ReactElement {
  const body = (
    <>
      {props.tone !== undefined ? <StatusDot tone={props.tone} /> : props.icon !== undefined ? <PanelIcon kind={props.icon} /> : null}
      <span style={styles.rowTitle}>
        <span style={styles.rowTitleText}>{props.title}</span>
        {props.subtitle !== undefined && <span style={styles.rowSubtitle}>{props.subtitle}</span>}
      </span>
      {props.meta !== undefined && <span style={styles.rowMeta}>{props.meta}</span>}
      {props.onClick !== undefined && <span style={styles.chevron} aria-hidden="true">›</span>}
    </>
  )
  if (props.onClick === undefined) {
    return <div className="dsh-quno-listrow" style={styles.rowStatic} {...(props.titleAttr === undefined ? {} : { title: props.titleAttr })}>{body}</div>
  }
  return (
    <button
      type="button"
      className="dsh-quno-listrow"
      data-interactive="true"
      style={styles.rowButton}
      onClick={props.onClick}
      {...(props.titleAttr === undefined ? {} : { title: props.titleAttr })}
    >
      {body}
    </button>
  )
}

/** A section heading inside a page, with an optional trailing aside. */
export function PanelSection(props: {
  readonly title: string
  readonly aside?: React.ReactNode
  readonly children?: React.ReactNode
}): React.ReactElement {
  return (
    <section style={styles.section}>
      <div style={styles.sectionHead}>
        <h3 style={styles.sectionTitle}>{props.title}</h3>
        {props.aside}
      </div>
      {props.children}
    </section>
  )
}

/** Header of one detail page: back link, identity, status, primary actions. */
export function DetailHeader(props: {
  readonly title: string
  readonly subtitle?: string
  readonly icon?: PanelIconKind
  readonly status?: React.ReactNode
  readonly backLabel: string
  readonly onBack?: () => void
  readonly actions?: React.ReactNode
}): React.ReactElement {
  return (
    <header style={styles.detailHead}>
      {props.onBack !== undefined && (
        <button type="button" style={styles.back} onClick={props.onBack}>‹ {props.backLabel}</button>
      )}
      <div style={styles.detailIdentity}>
        {props.icon !== undefined && <span style={styles.detailIcon}><PanelIcon kind={props.icon} size={18} /></span>}
        <span style={styles.detailTitleWrap}>
          <span style={styles.detailTitle}>{props.title}</span>
          {props.subtitle !== undefined && <span style={styles.detailSubtitle}>{props.subtitle}</span>}
        </span>
        {props.status}
      </div>
      {props.actions !== undefined && <div style={styles.detailActions}>{props.actions}</div>}
    </header>
  )
}

/** One titled block on a detail page. */
export function DetailSection(props: {
  readonly title: string
  readonly hint?: string
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <section style={styles.detailSection}>
      <h4 style={styles.detailSectionTitle}>{props.title}</h4>
      {props.children}
      {props.hint !== undefined && <p style={styles.hint}>{props.hint}</p>}
    </section>
  )
}

/** An explanatory block for a condition the user must understand. */
export function Callout(props: {
  readonly tone: 'info' | 'warn' | 'error' | 'success'
  readonly title: string
  readonly children?: React.ReactNode
  readonly action?: { readonly label: string; readonly onClick: () => void }
}): React.ReactElement {
  const token = props.tone === 'info'
    ? 'var(--dsw-alias-label-tertiary)'
    : props.tone === 'success'
      ? 'var(--dsw-alias-state-success-primary)'
      : props.tone === 'warn'
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-state-error-primary)'
  // The neutral note uses the system's layer stroke/fill; a branded white tint
  // in dark mode would read as a warning.
  const surface = props.tone === 'info'
    ? { borderColor: 'var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)' }
    : {
        borderColor: `color-mix(in srgb, ${token} 40%, transparent)`,
        background: `color-mix(in srgb, ${token} 8%, transparent)`,
      }
  return (
    <div style={{ ...styles.callout, ...surface }}>
      <div style={styles.calloutTitleRow}>
        <span style={{ ...styles.dot, background: token }} aria-hidden="true" />
        <strong style={styles.calloutTitle}>{props.title}</strong>
      </div>
      {props.children !== undefined && <div style={styles.calloutBody}>{props.children}</div>}
      {props.action !== undefined && (
        <div>
          <Button size="sm" variant="outline" onClick={props.action.onClick}>{props.action.label}</Button>
        </div>
      )}
    </div>
  )
}

/** The whole tab has nothing to show: name the state and the next step. */
export function PanelEmpty(props: {
  readonly icon?: PanelIconKind
  readonly title: string
  readonly description: string
  readonly action?: { readonly label: string; readonly onClick: () => void }
}): React.ReactElement {
  return (
    <div style={styles.empty} role="status">
      <span style={styles.emptyMark} aria-hidden="true">
        {props.icon === undefined ? 'Q' : <PanelIcon kind={props.icon} size={15} />}
      </span>
      <strong style={styles.emptyTitle}>{props.title}</strong>
      <p style={styles.emptyDescription}>{props.description}</p>
      {props.action !== undefined && (
        <Button size="sm" variant="outline" onClick={props.action.onClick}>{props.action.label}</Button>
      )}
    </div>
  )
}

/** One section is empty while the rest of the page is not. */
export function InlineEmpty(props: { readonly children: React.ReactNode }): React.ReactElement {
  return <p style={styles.inlineEmpty}>{props.children}</p>
}

/** A requested record does not exist: back plus the honest copy. */
export function MissingState(props: {
  readonly title: string
  readonly description: string
  readonly backLabel: string
  readonly onBack: () => void
  readonly icon?: PanelIconKind
}): React.ReactElement {
  return (
    <div style={styles.missing}>
      <button type="button" style={styles.back} onClick={props.onBack}>‹ {props.backLabel}</button>
      <div style={styles.empty} role="status">
        <span style={styles.emptyMark} aria-hidden="true">
          {props.icon === undefined ? '?' : <PanelIcon kind={props.icon} size={15} />}
        </span>
        <strong style={styles.emptyTitle}>{props.title}</strong>
        <p style={styles.emptyDescription}>{props.description}</p>
      </div>
    </div>
  )
}

/** First-load skeleton rows; never shown for a background refresh. */
export function LoadingRows(props: { readonly rows?: number }): React.ReactElement {
  const rows = props.rows ?? 3
  return (
    <div style={styles.loading} role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="dsh-quno-skeleton" style={styles.skeletonRow} />
      ))}
    </div>
  )
}

/** The panel's view switch. */
export function SegmentedTabs<T extends string>(props: {
  readonly tabs: readonly { readonly key: T; readonly label: string }[]
  readonly active: T
  readonly onChange: (key: T) => void
}): React.ReactElement {
  return (
    <div style={styles.tabs} role="tablist">
      {props.tabs.map(tab => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={props.active === tab.key}
          className="dsh-quno-tab"
          data-active={props.active === tab.key ? 'true' : 'false'}
          style={styles.tab}
          onClick={() => { props.onChange(tab.key) }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

const styles = {
  icon: { flex: 'none', display: 'block' },
  dot: { flex: 'none', width: 7, height: 7, borderRadius: 999, display: 'inline-block' },
  chip: { flex: 'none', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, borderRadius: 6, padding: '1px 7px', lineHeight: '16px' },
  rowButton: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 34, padding: '3px 6px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer', font: 'inherit',
    textAlign: 'left', color: 'var(--dsw-alias-label-primary)', boxSizing: 'border-box', minWidth: 0,
  },
  rowStatic: {
    display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 30, padding: '3px 6px',
    boxSizing: 'border-box', minWidth: 0, color: 'var(--dsw-alias-label-primary)',
  },
  rowTitle: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 },
  rowTitleText: { fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSubtitle: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowMeta: { flex: 'none', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
  chevron: { flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  section: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 10, minWidth: 0 },
  sectionHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '0 6px' },
  sectionTitle: { margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', letterSpacing: 0.2 },
  detailHead: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  back: {
    alignSelf: 'flex-start', border: 0, background: 'transparent', cursor: 'pointer', padding: 0,
    font: 'inherit', fontSize: 12, color: 'var(--dsw-alias-label-secondary)',
  },
  detailIdentity: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 },
  detailIcon: { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-tertiary)' },
  detailTitleWrap: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  detailTitle: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  detailSubtitle: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  detailActions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  detailSection: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2, minWidth: 0 },
  detailSectionTitle: { margin: '8px 0 2px', fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)' },
  hint: { margin: '4px 0 0', fontSize: 11, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' },
  callout: { display: 'flex', flexDirection: 'column', gap: 5, border: '1px solid', borderRadius: 10, padding: '8px 10px', minWidth: 0 },
  calloutTitleRow: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  calloutTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' },
  calloutBody: { fontSize: 11.5, lineHeight: 1.55, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  empty: {
    minHeight: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 8, padding: 24, textAlign: 'center',
  },
  emptyMark: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30,
    borderRadius: 10, color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-2)', fontSize: 13,
  },
  emptyTitle: { fontSize: 13, lineHeight: '20px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
  emptyDescription: { maxWidth: 250, margin: 0, fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' },
  inlineEmpty: { margin: 0, padding: '2px 6px', fontSize: 11.5, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
  missing: { display: 'flex', flexDirection: 'column', gap: 8 },
  loading: { display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 6px' },
  skeletonRow: { height: 34, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)' },
  tabs: { display: 'flex', gap: 4 },
  // Colour and background stay in QUNO_CSS: an inline value here would win over
  // the `[data-active]`/`:hover` rules and hide the selected state.
  tab: {
    flex: 1, height: 26, border: 0, borderRadius: 8, cursor: 'pointer',
    font: 'inherit', fontSize: 12,
  },
} as const
