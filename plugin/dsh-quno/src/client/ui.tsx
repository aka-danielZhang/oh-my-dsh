/**
 * Small presentational primitives shared by the Quno sidebar, settings page
 * and message cards. Token-only styling; no business state.
 *
 * @module dsh-quno/client/ui
 */

import React from 'react'

/** One bordered surface. */
export function Card(props: { readonly children: React.ReactNode; readonly title?: string; readonly aside?: React.ReactNode }): React.ReactElement {
  return (
    <section style={styles.card}>
      {(props.title !== undefined || props.aside !== undefined) && (
        <header style={styles.cardHeader}>
          <span style={styles.cardTitle}>{props.title}</span>
          <span style={styles.cardAside}>{props.aside}</span>
        </header>
      )}
      {props.children}
    </section>
  )
}

/** A label/value row. */
export function Field(props: {
  readonly label: string
  readonly hint?: string
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span style={styles.fieldHint}>{props.hint}</span>}
    </label>
  )
}

/** A compact status dot + text. */
export function Status(props: { readonly tone: 'ok' | 'warn' | 'error' | 'idle'; readonly text: string }): React.ReactElement {
  return (
    <span style={styles.status}>
      <span style={{ ...styles.dot, background: toneColor(props.tone) }} />
      {props.text}
    </span>
  )
}

function toneColor(tone: 'ok' | 'warn' | 'error' | 'idle'): string {
  switch (tone) {
    case 'ok': return 'var(--dsw-alias-state-success-primary)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary)'
    case 'error': return 'var(--dsw-alias-state-error-primary)'
    case 'idle': return 'var(--dsw-alias-label-tertiary)'
  }
}

/** Section heading inside a tab. */
export function SectionTitle(props: { readonly children: React.ReactNode; readonly aside?: React.ReactNode }): React.ReactElement {
  return (
    <div style={styles.sectionTitle}>
      <h3 style={styles.h3}>{props.children}</h3>
      {props.aside}
    </div>
  )
}

/** Token-styled text input. */
export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return <input {...props} style={{ ...styles.input, ...props.style }} />
}

/** Token-styled textarea. */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  return <textarea {...props} style={{ ...styles.textarea, ...props.style }} />
}

/** Token-styled select. */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return <select {...props} style={{ ...styles.input, ...props.style }} />
}

/** Empty-state paragraph. */
export function Empty(props: { readonly children: React.ReactNode }): React.ReactElement {
  return <p style={styles.empty}>{props.children}</p>
}

/** Inline error banner. */
export function ErrorBanner(props: { readonly children: React.ReactNode }): React.ReactElement {
  return <div style={styles.error}>{props.children}</div>
}

/** Stylesheet for pseudo-state affordances (installed once, plugin-tagged). */
export const QUNO_CSS = `
.dsh-quno-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-quno-action:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-quno-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-quno-tab:hover { color: var(--dsw-alias-label-primary); }
`

const styles = {
  card: {
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderRadius: 12,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  cardAside: { display: 'inline-flex', gap: 6, alignItems: 'center' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
  fieldLabel: { color: 'var(--dsw-alias-label-secondary)' },
  fieldHint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  status: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  dot: { width: 7, height: 7, borderRadius: 4, display: 'inline-block' },
  sectionTitle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  h3: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '6px 8px',
    font: 'inherit',
    fontSize: 12,
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 70,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '6px 8px',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1.5,
    resize: 'vertical',
  },
  empty: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
  error: {
    border: '1px solid var(--dsw-alias-state-error-primary)',
    color: 'var(--dsw-alias-state-error-primary)',
    borderRadius: 8,
    padding: '6px 8px',
    fontSize: 12,
  },
} as const
