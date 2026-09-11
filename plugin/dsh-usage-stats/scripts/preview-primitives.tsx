/**
 * Preview-only local stand-ins for the four ui-primitives the settings page
 * uses (Button / Pill / Tooltip / IconRefreshOutline16). Geometry and tokens
 * mirror the real components closely enough for the dynamic-plugin preview;
 * the SHIPPED plugin keeps importing the real primitives (see charts/section).
 * This module exists only so the preview bundle stays a few dozen KB instead
 * of dragging in the whole primitives index.
 */

import * as React from 'react'
import type { CSSProperties, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

const BUTTON_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  border: 'none',
  borderRadius: 14,
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-primary)',
  background: 'transparent',
  height: 28,
  padding: '0 10px',
  width: 28,
}

export function Button({ variant, size, icon, className, children, ...rest }: {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  className?: string
  children?: ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  const style: CSSProperties = { ...BUTTON_BASE }
  if (variant === 'toolbar') style.background = 'var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2))'
  return React.createElement('button', {
    type: 'button',
    className,
    style,
    ...rest,
  }, icon, children)
}

export function Pill({ active, className, children, onClick, ...rest }: {
  active?: boolean
  className?: string
  children?: ReactNode
  onClick?: () => void
} & React.ButtonHTMLAttributes<HTMLButtonElement>): ReactNode {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    height: 24,
    padding: '0 8px',
    border: 'none',
    borderRadius: 12,
    fontSize: 12,
    lineHeight: '18px',
    cursor: onClick === undefined ? undefined : 'pointer',
    color: active === true ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
    background: active === true ? 'var(--dsw-alias-button-ghost-active-fill)' : 'var(--dsw-alias-bg-layer-2)',
    boxShadow: active === true ? 'inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)' : undefined,
    fontFamily: 'inherit',
  }
  return React.createElement('button', {
    type: 'button',
    className,
    style,
    onClick,
    ...rest,
  }, children)
}

export function Tooltip({ label, side, children }: {
  label: string | (() => string)
  side?: 'right' | 'bottom' | 'top'
  children: React.ReactElement
}): ReactNode {
  const [open, setOpen] = React.useState(false)
  const anchor = React.cloneElement(children, {
    onMouseEnter: (event: unknown) => {
      const original = (children.props as { onMouseEnter?: () => void }).onMouseEnter
      if (typeof original === 'function') original()
      setOpen(true)
    },
    onMouseLeave: () => { setOpen(false) },
    onFocus: () => { setOpen(true) },
    onBlur: () => { setOpen(false) },
  })
  const text = typeof label === 'function' ? label() : label
  return React.createElement('span', { style: { position: 'relative', display: 'inline-flex' } },
    anchor,
    open && React.createElement('span', {
      style: {
        position: 'fixed',
        zIndex: 60,
        pointerEvents: 'none',
        background: 'var(--dsw-alias-tooltip-bg, var(--dsw-alias-bg-layer-3))',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12,
        lineHeight: '18px',
        padding: '4px 8px',
        borderRadius: 6,
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
      },
    }, text),
  )
}

export function IconRefreshOutline16({ size, className }: { size?: number, className?: string }): ReactNode {
  return React.createElement('svg', {
    width: size ?? 16,
    height: size ?? 16,
    viewBox: '0 0 16 16',
    className,
    'aria-hidden': true,
  }, React.createElement('path', {
    d: 'M13.65 2.35A7.95 7.95 0 0 0 8 0a8 8 0 1 0 8 8h-2.01a6 6 0 1 1-1.75-4.24L9.5 6.5H16V0l-2.35 2.35z',
    fill: 'currentColor',
    transform: 'scale(0.875) translate(1, 1)',
  }))
}
