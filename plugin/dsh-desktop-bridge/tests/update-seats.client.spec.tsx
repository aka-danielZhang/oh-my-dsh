// @vitest-environment jsdom
import { expect, test, vi } from 'vitest'
import { installUpdateSeats, pickUpdateSeat } from '../src/client/update-seats.ts'
import type { SeatRegistry } from '../src/client/update-seats.ts'
import { HeaderUpdateControl, UpdateBadge, UpdateControl } from '../src/client/update-indicator.tsx'
import type { DesktopUpdateStatus, DesktopUpdaterInjected } from '../src/client/updates.ts'

const updater: DesktopUpdaterInjected = {
  checkUpdate: async () => null,
  getUpdateStatus: async (): Promise<DesktopUpdateStatus> => ({ phase: 'idle' }),
  updateGeneration: () => 0,
  downloadUpdate: async () => {},
  cancelUpdate: async () => {},
  installUpdate: () => new Promise<never>(() => {}),
}

const injected = (): DesktopUpdaterInjected => updater

interface Calls {
  names: string[]
  priorityOf: (name: string) => number | undefined
  componentOf: (name: string) => unknown
}

/** Slot registry double: declares the given keys and records registrations. */
function makeRegistry(declared: readonly string[], refuse: readonly string[] = []): {
  registry: SeatRegistry
  calls: () => Calls
  disposers: () => number
} {
  const names: string[] = []
  const components = new Map<string, unknown>()
  const priorities = new Map<string, number | undefined>()
  let disposers = 0
  const registry = {
    spec: (key: string) => (declared.includes(key) ? { kind: 'single', scope: 'root' } : undefined),
    register: (options: { name: string; priority?: number }, component: unknown) => {
      if (refuse.includes(options.name)) throw new Error(`${options.name} refused`)
      names.push(options.name)
      components.set(options.name, component)
      priorities.set(options.name, options.priority)
      disposers += 1
      return () => { disposers -= 1 }
    },
  } as unknown as SeatRegistry
  return {
    registry,
    calls: () => ({
      names: [...names],
      priorityOf: name => priorities.get(name),
      componentOf: name => components.get(name),
    }),
    disposers: () => disposers,
  }
}

test('a header-declaring runtime seats the updater left of the toggle', () => {
  const bench = makeRegistry(['sidebar.header.action', 'sidebar.toggle.badge'])
  const logger = { warn: vi.fn() }
  installUpdateSeats(bench.registry, injected, logger)
  const calls = bench.calls()
  expect(calls.names).toEqual(['sidebar.header.action', 'sidebar.toggle.badge'])
  expect(calls.componentOf('sidebar.header.action')).toBe(HeaderUpdateControl)
  expect(calls.componentOf('sidebar.toggle.badge')).toBe(UpdateBadge)
  // Lowest priority renders: the badge shadows ui-settings-general's inert
  // official occupant at priority 0 instead of clashing with it.
  expect(calls.priorityOf('sidebar.toggle.badge')).toBe(-1)
  expect(bench.disposers()).toBe(2)
  expect(logger.warn).not.toHaveBeenCalled()
})

test('a runtime without the header slot keeps the stock footer seat and warns once', () => {
  const bench = makeRegistry(['sidebar.footer.action', 'sidebar.toggle.badge'])
  const logger = { warn: vi.fn() }
  installUpdateSeats(bench.registry, injected, logger)
  const calls = bench.calls()
  expect(calls.names).toEqual(['sidebar.footer.action', 'sidebar.toggle.badge'])
  expect(calls.componentOf('sidebar.footer.action')).toBe(UpdateControl)
  expect(logger.warn).toHaveBeenCalledTimes(1)
  expect(String(logger.warn.mock.calls[0]?.[0])).toContain('sidebar.header.action')
  expect(pickUpdateSeat(bench.registry)).toBe('footer')
})

test('a refused header seat falls back to the footer instead of dropping the updater', () => {
  const bench = makeRegistry(
    ['sidebar.header.action', 'sidebar.footer.action', 'sidebar.toggle.badge'],
    ['sidebar.header.action'],
  )
  const logger = { warn: vi.fn() }
  installUpdateSeats(bench.registry, injected, logger)
  const calls = bench.calls()
  expect(calls.names).toEqual(['sidebar.footer.action', 'sidebar.toggle.badge'])
  expect(calls.componentOf('sidebar.footer.action')).toBe(UpdateControl)
  expect(logger.warn.mock.calls.some(([message]) => String(message).includes('header'))).toBe(true)
})

test('a refused badge leaves the updater seat intact', () => {
  const bench = makeRegistry(
    ['sidebar.header.action', 'sidebar.toggle.badge'],
    ['sidebar.toggle.badge'],
  )
  const logger = { warn: vi.fn() }
  const disposers = installUpdateSeats(bench.registry, injected, logger)
  expect(bench.calls().names).toEqual(['sidebar.header.action'])
  expect(disposers).toHaveLength(1)
  expect(logger.warn.mock.calls.some(([message]) => String(message).includes('badge'))).toBe(true)
})
