// @vitest-environment jsdom
/**
 * Component spec for the slimmed DesktopToolbar (the layout-correction
 * rework, v2): the left controls cluster mirrors the pre-toolbar title band
 * (toggle / updater / bell / collapsed-only New Session), the main lane
 * holds the session-header portal hosts with a corner-only trailing cell —
 * and none of the removed affordances (session back/forward history,
 * workspace echo pill, surface-switch glyph) come back.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { DesktopToolbar } from '../src/client/toolbar.tsx'
import { createNotifyInbox } from '../src/client/notify-inbox.ts'
import { en, type DesktopBridgeKey } from '../src/client/locales.ts'
import type { DesktopUpdateStatus } from '../src/client/updates.ts'

afterEach(() => { cleanup() })

const t = (key: DesktopBridgeKey, params?: Record<string, unknown>): string => {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

/** Idle updater face: the control is always present as the manual-check entry. */
function updaterFace(status: DesktopUpdateStatus = { phase: 'idle' }) {
  return {
    checkUpdate: vi.fn(async () => null),
    getUpdateStatus: vi.fn(async () => status),
    updateGeneration: () => 0,
    downloadUpdate: vi.fn(async () => {}),
    cancelUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => { throw new Error('install not exercised') }),
  }
}

type Face = ReturnType<typeof updaterFace> & {
  inbox: ReturnType<typeof createNotifyInbox>
  openSession: ReturnType<typeof vi.fn>
  toggleSidebar: ReturnType<typeof vi.fn>
  startSession: ReturnType<typeof vi.fn>
  centerRef: ReturnType<typeof vi.fn>
  endRef: ReturnType<typeof vi.fn>
}

function fullFace(overrides: Partial<Face> = {}): Face {
  return {
    ...updaterFace(),
    inbox: createNotifyInbox(),
    openSession: vi.fn(),
    toggleSidebar: vi.fn(),
    startSession: vi.fn(),
    centerRef: vi.fn(),
    endRef: vi.fn(),
    ...overrides,
  }
}

test('renders exactly the left cluster (idle updater): toggle, check, bell, New Session', () => {
  const face = fullFace()
  render(<DesktopToolbar {...face} t={t} />)
  expect(screen.getByRole('toolbar', { name: en['toolbar.label'] })).toBeTruthy()
  // Toggle, updater (manual-check entry), notification bell, New Session.
  expect(screen.getAllByRole('button')).toHaveLength(4)
  expect(screen.getByTitle(en['rail.toggle'])).toBeTruthy()
  expect(screen.getByTitle(en['update.check'])).toBeTruthy()
  expect(screen.getByTitle(en['rail.newSession'])).toBeTruthy()
  expect(screen.getByTitle(en['notify.center'])).toBeTruthy()
})

test('carries none of the removed affordances', () => {
  render(<DesktopToolbar {...fullFace()} t={t} />)
  expect(screen.queryByTitle('Back')).toBeNull()
  expect(screen.queryByTitle('Forward')).toBeNull()
  expect(screen.queryByTitle('Switch surface')).toBeNull()
  expect(document.querySelector('[data-desktop-toolbar-workspace]')).toBeNull()
  expect(document.querySelector('[data-desktop-toolbar-nav]')).toBeNull()
})

test('keeps the two layout zones with the status cluster on the left and a corner-only trailing cell', () => {
  render(<DesktopToolbar {...fullFace()} t={t} />)
  const controls = document.querySelector('[data-desktop-toolbar-controls]')
  expect(controls).toBeTruthy()
  // Toggle button, updater control (style sheet + button), notify root, New
  // Session button.
  expect(controls!.querySelector('button[data-desktop-rail-button]')).toBeTruthy()
  expect(controls!.querySelector('[data-desktop-update-button]')).toBeTruthy()
  // The bell lives in the LEFT cluster, not the trailing cluster.
  expect(controls!.querySelector('[data-desktop-notify-root]')).toBeTruthy()
  expect(document.querySelector('[data-desktop-toolbar-main]')).toBeTruthy()
  expect(document.querySelector('[data-desktop-toolbar-center]')).toBeTruthy()
  expect(document.querySelector('[data-desktop-toolbar-trailing]')).toBeTruthy()
  const trailing = document.querySelector('[data-desktop-toolbar-trailing]')!
  expect(trailing.querySelector('[data-desktop-notify-root]')).toBeNull()
  expect(trailing.querySelector('[data-desktop-toolbar-end]')).toBeTruthy()
})

test('marks New Session collapsed-only for the sheet to reveal', () => {
  render(<DesktopToolbar {...fullFace()} t={t} />)
  expect(document.querySelector('button[data-desktop-toolbar-new]')).toBeTruthy()
})

test('fires toggle and new session once per click', () => {
  const face = fullFace()
  render(<DesktopToolbar {...face} t={t} />)
  fireEvent.click(screen.getByTitle(en['rail.toggle']))
  fireEvent.click(screen.getByTitle(en['rail.newSession']))
  expect(face.toggleSidebar).toHaveBeenCalledTimes(1)
  expect(face.startSession).toHaveBeenCalledTimes(1)
})

test('publishes both portal hosts on mount and releases them on unmount', () => {
  const face = fullFace()
  const view = render(<DesktopToolbar {...face} t={t} />)
  expect(face.centerRef).toHaveBeenCalledWith(expect.any(HTMLElement))
  expect(face.endRef).toHaveBeenCalledWith(expect.any(HTMLElement))
  const center = face.centerRef.mock.calls[0]![0] as HTMLElement
  expect(center.dataset.desktopToolbarCenter).toBe('')
  view.unmount()
  expect(face.centerRef).toHaveBeenLastCalledWith(null)
  expect(face.endRef).toHaveBeenLastCalledWith(null)
})

test('mounts the updater control in the left cluster once a version is available', async () => {
  const face = fullFace({
    ...updaterFace({ phase: 'available', version: '9.9.9', notes: '' }),
    inbox: createNotifyInbox(),
    openSession: vi.fn(),
    toggleSidebar: vi.fn(),
    startSession: vi.fn(),
    centerRef: vi.fn(),
    endRef: vi.fn(),
  } as Partial<Face>)
  render(<DesktopToolbar {...face} t={t} />)
  expect(await screen.findByTitle(t('update.available', { version: '9.9.9' }))).toBeTruthy()
  // Toggle, updater, bell, New Session — all in the left cluster.
  expect(screen.getAllByRole('button')).toHaveLength(4)
  const updateButton = screen.getByTitle(t('update.available', { version: '9.9.9' }))
  expect(updateButton.closest('[data-desktop-toolbar-controls]')).toBeTruthy()
})
