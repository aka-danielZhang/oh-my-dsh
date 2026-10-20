// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { UpdateBadge } from '../src/client/update-indicator.tsx'
import { en, type DesktopBridgeKey } from '../src/client/locales.ts'
import type { DesktopUpdateStatus } from '../src/client/updates.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = (key: DesktopBridgeKey, params?: Record<string, unknown>): string => {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

/** Settle the poll promise chain the badge schedules on mount. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function renderBadge(current: () => DesktopUpdateStatus): ReturnType<typeof vi.fn> {
  const getUpdateStatus = vi.fn(async () => current())
  render(<UpdateBadge
    checkUpdate={async () => null}
    getUpdateStatus={getUpdateStatus}
    updateGeneration={() => 0}
    downloadUpdate={async () => {}}
    cancelUpdate={async () => {}}
    installUpdate={() => new Promise<never>(() => {})}
    t={t}
  />)
  return getUpdateStatus
}

test('stays silent without news: idle, current, and a background check', async () => {
  vi.useFakeTimers()
  let status: DesktopUpdateStatus = { phase: 'idle' }
  const read = renderBadge(() => status)
  await flush()
  expect(screen.queryByRole('img')).toBeNull()
  status = { phase: 'checking' }
  await act(async () => { vi.advanceTimersByTime(1000) })
  await flush()
  expect(screen.queryByRole('img')).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
})

test('a waiting package and a failed download both show a dot', async () => {
  vi.useFakeTimers()
  let status: DesktopUpdateStatus = { phase: 'available', version: '0.4.0', notes: '' }
  renderBadge(() => status)
  await flush()
  const available = screen.getByRole('img')
  expect(available.getAttribute('aria-label')).toBe(en['update.available'].replace('{version}', '0.4.0'))
  expect(available.querySelector('[data-desktop-update-badge-dot]')).not.toBeNull()
  status = { phase: 'failed', message: 'Update download failed' }
  await act(async () => { vi.advanceTimersByTime(1000) })
  await flush()
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe(en['update.failed'])
})

test('a download with a known size draws a progress ring and never a second click target', async () => {
  vi.useFakeTimers()
  const status: DesktopUpdateStatus = { phase: 'downloading', version: '0.4.0', downloaded: 25, total: 100 }
  renderBadge(() => status)
  await flush()
  const badge = screen.getByRole('img')
  expect(badge.getAttribute('aria-label')).toBe(en['update.progress'].replace('{percent}', '25'))
  const ring = badge.querySelector('svg')
  expect(ring).not.toBeNull()
  // 25% of the 3px-radius circle stays drawn; the rest is offset away.
  const circumference = 2 * Math.PI * 3
  expect(Number(ring?.querySelectorAll('circle')[1]?.getAttribute('stroke-dashoffset')))
    .toBeCloseTo(circumference * 0.75, 5)
  expect(badge.querySelector('[data-desktop-update-badge-dot]')).toBeNull()
  // The badge lives inside the sidebar toggle and must not intercept clicks.
  expect(badge.getAttribute('role')).toBe('img')
})

test('an unknown total spins instead of guessing a percentage', async () => {
  vi.useFakeTimers()
  const status: DesktopUpdateStatus = { phase: 'downloading', version: '0.4.0', downloaded: 1024 }
  renderBadge(() => status)
  await flush()
  const badge = screen.getByRole('img')
  expect(badge.querySelector('[data-desktop-update-badge-spin]')).not.toBeNull()
  expect(badge.querySelector('svg')).toBeNull()
  expect(badge.getAttribute('aria-label')).toBe(en['update.preparing'])
})

test('polls tightly while the updater works and follows the phase change', async () => {
  vi.useFakeTimers()
  let status: DesktopUpdateStatus = { phase: 'available', version: '0.4.0', notes: '' }
  const read = renderBadge(() => status)
  await flush()
  expect(read).toHaveBeenCalledTimes(1)
  status = { phase: 'downloading', version: '0.4.0', downloaded: 50, total: 100 }
  await act(async () => { vi.advanceTimersByTime(1000) })
  await flush()
  expect(screen.getByRole('img').querySelector('svg')).not.toBeNull()
  // Busy phases poll every 150ms rather than every second.
  await act(async () => { vi.advanceTimersByTime(150) })
  await flush()
  expect(read).toHaveBeenCalledTimes(3)
})
