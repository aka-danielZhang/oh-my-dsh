// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { UpdateControl } from '../src/client/update-indicator.tsx'
import { en, type DesktopBridgeKey } from '../src/client/locales.ts'
import type { DesktopUpdateStatus } from '../src/client/updates.ts'

afterEach(() => { cleanup() })

const t = (key: DesktopBridgeKey, params?: Record<string, unknown>): string => {
  let text = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

test('click opens the available dialog; downloading starts from the dialog only', async () => {
  const initial = deferred<unknown>()
  const install = deferred<never>()
  const downloadGate = deferred<void>()
  let generation = 0
  const notes = '### Fixed\n- titlebar drift'
  let snapshot: DesktopUpdateStatus = { phase: 'available', version: '0.3.0', notes }
  const update = {
    checkUpdate: vi.fn(() => initial.promise),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => snapshot),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(() => {
      generation += 1
      snapshot = { phase: 'downloading', version: '0.3.0', downloaded: 25, total: 100 }
      return downloadGate.promise
    }),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(() => install.promise),
    t,
  }
  render(<UpdateControl {...update} />)

  // Discovery alone never downloads.
  const availableTitle = en['update.available'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('button', { name: availableTitle })).toBeTruthy() })
  expect(update.downloadUpdate).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: availableTitle }))
  // The dialog presents version and notes first; the fetch needs its button.
  const foundTitle = en['update.dialog.available'].replace('{version}', '0.3.0')
  const found = await screen.findByRole('dialog', { name: foundTitle })
  expect(within(found).getByText('titlebar drift')).toBeTruthy()
  expect(update.downloadUpdate).not.toHaveBeenCalled()

  fireEvent.click(within(found).getByText(en['update.dialog.download']))
  const downloadingTitle = en['update.dialog.downloading'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('dialog', { name: downloadingTitle })).toBeTruthy() })
  expect(update.downloadUpdate).toHaveBeenCalledTimes(1)

  // The 120ms busy poll picks up the shell's byte progress.
  await waitFor(() => {
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  })
  expect(screen.getByText('25 B / 100 B')).toBeTruthy()

  snapshot = { phase: 'ready', version: '0.3.0', notes }
  downloadGate.resolve()
  const readyTitle = en['update.dialog.ready'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('dialog', { name: readyTitle })).toBeTruthy() })
  const dialog = screen.getByRole('dialog', { name: readyTitle })
  expect(within(dialog).getByText(en['update.confirm.notes'])).toBeTruthy()
  expect(within(dialog).getByText('titlebar drift')).toBeTruthy()
  expect(update.installUpdate).not.toHaveBeenCalled()

  fireEvent.click(within(dialog).getByText(en['update.dialog.restart']))
  expect(update.installUpdate).toHaveBeenCalledTimes(1)
})

test('cancel download closes the dialog and returns to the downloadable state', async () => {
  const initial = deferred<unknown>()
  const downloadGate = deferred<void>()
  let generation = 0
  let snapshot: DesktopUpdateStatus = { phase: 'available', version: '0.3.0', notes: '' }
  const update = {
    checkUpdate: vi.fn(() => initial.promise),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => snapshot),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(() => {
      generation += 1
      snapshot = { phase: 'downloading', version: '0.3.0', downloaded: 25, total: 100 }
      return downloadGate.promise
    }),
    cancelUpdate: vi.fn(async () => {
      // The shell restores the available phase and lets the download resolve.
      snapshot = { phase: 'available', version: '0.3.0', notes: '' }
      downloadGate.resolve()
    }),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  const availableTitle = en['update.available'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('button', { name: availableTitle })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: availableTitle }))
  fireEvent.click(await screen.findByText(en['update.dialog.download']))
  const downloadingTitle = en['update.dialog.downloading'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('dialog', { name: downloadingTitle })).toBeTruthy() })

  fireEvent.click(screen.getByText(en['update.dialog.cancel']))
  expect(update.cancelUpdate).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  await waitFor(() => { expect(screen.getByRole('button', { name: availableTitle })).toBeTruthy() })
  expect(update.installUpdate).not.toHaveBeenCalled()
})

test('closing the dialog hides it while the download continues; ready reopens it', async () => {
  const initial = deferred<unknown>()
  const downloadGate = deferred<void>()
  let generation = 0
  let snapshot: DesktopUpdateStatus = { phase: 'available', version: '0.3.0', notes: '' }
  const update = {
    checkUpdate: vi.fn(() => initial.promise),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => snapshot),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(() => {
      generation += 1
      snapshot = { phase: 'downloading', version: '0.3.0', downloaded: 25, total: 100 }
      return downloadGate.promise
    }),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  const availableTitle = en['update.available'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('button', { name: availableTitle })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: availableTitle }))
  fireEvent.click(await screen.findByText(en['update.dialog.download']))
  await waitFor(() => { expect(screen.getByRole('progressbar')).toBeTruthy() })

  // Escape only hides the dialog; the download keeps running in place.
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(update.cancelUpdate).not.toHaveBeenCalled()
  const progressTitle = en['update.progress'].replace('{percent}', '25')
  await waitFor(() => { expect(screen.getByRole('button', { name: progressTitle })).toBeTruthy() })

  // Clicking the busy button reopens the live progress.
  fireEvent.click(screen.getByRole('button', { name: progressTitle }))
  await waitFor(() => { expect(screen.getByRole('progressbar')).toBeTruthy() })
  expect(update.downloadUpdate).toHaveBeenCalledTimes(1)

  // Hiding again and letting the download finish reopens the restart prompt.
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  snapshot = { phase: 'ready', version: '0.3.0', notes: '' }
  downloadGate.resolve()
  const readyTitle = en['update.dialog.ready'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('dialog', { name: readyTitle })).toBeTruthy() })
})

test('a failed download offers retry inside the dialog', async () => {
  const initial = deferred<unknown>()
  let generation = 0
  let snapshot: DesktopUpdateStatus = { phase: 'available', version: '0.3.0', notes: '' }
  let downloads = 0
  const update = {
    checkUpdate: vi.fn((force?: boolean) => force === true
      ? Promise.resolve({ version: '0.3.0', notes: '' })
      : initial.promise),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => {
      if (snapshot.phase === 'failed') throw new Error('status unavailable')
      return snapshot
    }),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(() => {
      downloads += 1
      generation += 1
      if (downloads === 1) {
        snapshot = { phase: 'failed', version: '0.3.0', message: 'network' }
        return Promise.reject(new Error('network'))
      }
      snapshot = { phase: 'ready', version: '0.3.0', notes: '' }
      return Promise.resolve()
    }),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  const availableTitle = en['update.available'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('button', { name: availableTitle })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: availableTitle }))
  fireEvent.click(await screen.findByText(en['update.dialog.download']))

  const dialog = await screen.findByRole('dialog', { name: en['update.dialog.failed'] })
  expect(within(dialog).getByText('Update download failed')).toBeTruthy()

  fireEvent.click(within(dialog).getByText(en['update.dialog.retry']))
  await waitFor(() => { expect(update.checkUpdate).toHaveBeenCalledWith(true) })
  const readyTitle = en['update.dialog.ready'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('dialog', { name: readyTitle })).toBeTruthy() })
  expect(update.downloadUpdate).toHaveBeenCalledTimes(2)
  expect(update.installUpdate).not.toHaveBeenCalled()
})

test('placeholder updater notes fall back to the empty copy', async () => {
  const initial = deferred<unknown>()
  let generation = 0
  const snapshot: DesktopUpdateStatus = {
    phase: 'ready',
    version: '0.3.0',
    notes: 'See the release page for notes.',
  }
  const update = {
    checkUpdate: vi.fn(() => initial.promise),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => snapshot),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(async () => undefined),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  const readyTitle = en['update.ready'].replace('{version}', '0.3.0')
  await waitFor(() => { expect(screen.getByRole('button', { name: readyTitle })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: readyTitle }))
  const dialogTitle = en['update.dialog.ready'].replace('{version}', '0.3.0')
  const dialog = screen.getByRole('dialog', { name: dialogTitle })
  expect(within(dialog).getByText(en['update.confirm.empty'])).toBeTruthy()
  expect(within(dialog).queryByText('See the release page for notes.')).toBeNull()
})

test('the busy button stays a compact spinner; the progress bar lives in the dialog', async () => {
  const initial = deferred<unknown>()
  let generation = 0
  const snapshot: DesktopUpdateStatus = {
    phase: 'downloading',
    version: '0.3.0',
    downloaded: 25,
    total: 100,
  }
  const update = {
    checkUpdate: vi.fn(() => initial.promise),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => snapshot),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(async () => undefined),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  const progressTitle = en['update.progress'].replace('{percent}', '25')
  await waitFor(() => { expect(screen.getByRole('button', { name: progressTitle })).toBeTruthy() })
  const button = screen.getByRole('button', { name: progressTitle })
  expect(button.style.width).toBe('22px')
  expect(button.querySelector('[data-desktop-update-spinner]')).toBeTruthy()
  expect(within(button).queryByRole('progressbar')).toBeNull()
  // A mount that finds an in-flight download never starts a second one.
  expect(update.downloadUpdate).not.toHaveBeenCalled()

  fireEvent.click(button)
  await waitFor(() => {
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  })
  expect(update.downloadUpdate).not.toHaveBeenCalled()
})

test('the control is always present; a manual check reports the current state', async () => {
  let generation = 0
  const update = {
    checkUpdate: vi.fn((force?: boolean) => {
      if (force === true) generation += 1
      return Promise.resolve(null)
    }),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => ({ phase: 'current' })),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(async () => undefined),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  // Even with no update pending the control stays mounted as the entry point.
  await waitFor(() => { expect(screen.getByRole('button', { name: en['update.check'] })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en['update.check'] }))
  await waitFor(() => { expect(update.checkUpdate).toHaveBeenCalledWith(true) })

  // Nothing new: transient confirmation on the control itself, no dialog.
  await waitFor(() => { expect(screen.getByRole('button', { name: en['update.current'] })).toBeTruthy() })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(update.downloadUpdate).not.toHaveBeenCalled()
  expect(update.installUpdate).not.toHaveBeenCalled()
})

test('a manual check that finds an update opens the available dialog without downloading', async () => {
  let generation = 0
  const update = {
    checkUpdate: vi.fn((force?: boolean) => {
      if (force === true) generation += 1
      return Promise.resolve({ version: '0.3.0', notes: '### Added\n- thing' })
    }),
    getUpdateStatus: vi.fn(async (): Promise<DesktopUpdateStatus> => ({ phase: 'current' })),
    updateGeneration: () => generation,
    downloadUpdate: vi.fn(async () => undefined),
    cancelUpdate: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => {
      throw new Error('unreachable')
    }),
    t,
  }
  render(<UpdateControl {...update} />)

  await waitFor(() => { expect(screen.getByRole('button', { name: en['update.check'] })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: en['update.check'] }))
  const foundTitle = en['update.dialog.available'].replace('{version}', '0.3.0')
  const found = await screen.findByRole('dialog', { name: foundTitle })
  expect(within(found).getByText('thing')).toBeTruthy()
  expect(update.downloadUpdate).not.toHaveBeenCalled()

  fireEvent.click(within(found).getByText(en['update.dialog.download']))
  expect(update.downloadUpdate).toHaveBeenCalledTimes(1)
  expect(update.installUpdate).not.toHaveBeenCalled()
})
