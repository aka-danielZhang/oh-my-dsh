// @vitest-environment jsdom
/**
 * Regression spec for the 0.3.0-rc.45 incident: bridge 0.2.0-rc.14 registered
 * `shell.toolbar` unguarded, and on a runtime whose ui-layout predates the
 * unified toolbar the slot is not declared — cordis rejects the entry loudly
 * and the WHOLE bridge client fiber dies (links, downloads, notifications,
 * updates all gone, and the update affordance dies with it). The fix guards
 * the registration: on an old runtime the bridge must keep every other
 * capability, register no toolbar, and never set the data-shell-toolbar-on
 * marker (so titlebar.ts's legacy band rules stay active).
 */
import { afterEach, expect, test, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__DSH_DESKTOP__
  delete (window as unknown as Record<string, unknown>).__DSH_DESKTOP_IPC__
  document.documentElement.removeAttribute('data-shell-toolbar-on')
})

function installGate(): void {
  ;(window as unknown as Record<string, unknown>).__DSH_DESKTOP__ = { version: 1, shell: 'dsh-desktop', platform: 'macos' }
  ;(window as unknown as Record<string, unknown>).__DSH_DESKTOP_IPC__ = { invoke: vi.fn(async () => ({})) }
}

interface SlotEntry { name: string; id?: string }

/** A cordis-shaped ctx double: effects run immediately, slot registrations recorded. */
function makeCtx(options: { rejectToolbarSlot: boolean }) {
  const registered: SlotEntry[] = []
  const warns: string[] = []
  const register = (entry: { name: string, id?: string }): (() => void) => {
    if (entry.name === 'shell.toolbar' && options.rejectToolbarSlot) {
      throw new Error('slot "shell.toolbar" is not declared (a parent entry\'s children table must declare it)')
    }
    registered.push({ name: entry.name, id: entry.id })
    return () => {}
  }
  const ctx = {
    logger: { warn: (message: string) => { warns.push(message) } },
    effect: (callback: () => (() => void) | void): (() => void) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key,
    },
    sessions: {
      list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) },
      open: () => {},
    },
    uiWorkspace: { startSession: () => {} },
    slots: {
      inject: (_name: string, callback: () => (() => void) | void): (() => void) => {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register,
    },
    get: (_name: string) => undefined,
  }
  return { ctx, registered, warns }
}

test('an old runtime without shell.toolbar keeps the bridge alive and degrades', () => {
  installGate()
  const { ctx, registered, warns } = makeCtx({ rejectToolbarSlot: true })
  expect(() => { apply(ctx as never) }).not.toThrow()
  // The badge (and every non-toolbar capability) survives the failed toolbar entry.
  expect(registered.some(entry => entry.name === 'shell.overlay' && entry.id === 'desktop-badge')).toBe(true)
  expect(registered.some(entry => entry.name === 'shell.toolbar')).toBe(false)
  // The marker is only set by a successfully mounted toolbar — the legacy
  // band rules in titlebar.ts must stay active on an old runtime.
  expect(document.documentElement.hasAttribute('data-shell-toolbar-on')).toBe(false)
  expect(warns.some(message => message.includes('shell.toolbar') && message.includes('legacy band rules'))).toBe(true)
})

test('a runtime WITH shell.toolbar mounts the toolbar and sets the marker', () => {
  installGate()
  const { ctx, registered } = makeCtx({ rejectToolbarSlot: false })
  expect(() => { apply(ctx as never) }).not.toThrow()
  expect(registered.some(entry => entry.name === 'shell.toolbar' && entry.id === 'desktop-toolbar')).toBe(true)
  expect(document.documentElement.hasAttribute('data-shell-toolbar-on')).toBe(true)
})
