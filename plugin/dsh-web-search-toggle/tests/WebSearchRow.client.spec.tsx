// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { WebSearchRow } from '../src/client/WebSearchRow.tsx'
import type { WebSearchRowComponentProps, WebSearchRowState } from '../src/client/WebSearchRow.tsx'
import { en, type WebSearchLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const t = ((key: WebSearchLocaleKey, params?: Record<string, unknown>) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
  return text
}) as WebSearchRowComponentProps['t']

const READY: WebSearchRowState = {
  status: 'ready',
  snapshot: { enabled: true, keyConfigured: true, keyRef: 'env:DEEPSEEK_API_KEY' },
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

test('fast commits never flash the applying label', async () => {
  vi.useFakeTimers()
  const setEnabled = vi.fn(async (): Promise<WebSearchRowState> => READY)
  render(<WebSearchRow t={t} refresh={async () => READY} setEnabled={setEnabled} />)
  await act(async () => { await Promise.resolve() })

  const knob = screen.getByRole('switch', { name: en['toggle.label'] }) as HTMLInputElement
  knob.click()
  expect(setEnabled).toHaveBeenCalledWith(false)
  expect(knob.disabled).toBe(true)
  expect(knob.checked).toBe(false)
  await act(async () => { await Promise.resolve() })
  expect(knob.disabled).toBe(false)
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(screen.queryByText(en['state.pending'])).toBeNull()
  expect(screen.getByText(en['toggle.on'])).toBeTruthy()
})

test('slow commits show Applying only after the grace window', async () => {
  vi.useFakeTimers()
  const write = deferred<WebSearchRowState>()
  const setEnabled = vi.fn(() => write.promise)
  render(<WebSearchRow t={t} refresh={async () => READY} setEnabled={setEnabled} />)
  await act(async () => { await Promise.resolve() })

  const knob = screen.getByRole('switch', { name: en['toggle.label'] })
  knob.click()
  await act(async () => { await vi.advanceTimersByTimeAsync(299) })
  expect(screen.queryByText(en['state.pending'])).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(screen.getByText(en['state.pending'])).toBeTruthy()

  await act(async () => { write.resolve({ ...READY, pending: undefined }); await Promise.resolve() })
  expect(screen.queryByText(en['state.pending'])).toBeNull()
  expect(screen.getByRole('switch', { name: en['toggle.label'] })).toHaveProperty('disabled', false)
})

test('failed commits settle to the error and re-enable the switch', async () => {
  vi.useFakeTimers()
  const setEnabled = vi.fn(async (): Promise<WebSearchRowState> => ({
    status: 'error',
    error: 'WRITE_DENIED: unavailable',
  }))
  render(<WebSearchRow t={t} refresh={async () => READY} setEnabled={setEnabled} />)
  await act(async () => { await Promise.resolve() })

  screen.getByRole('switch', { name: en['toggle.label'] }).click()
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('alert').textContent).toContain('WRITE_DENIED: unavailable')
  expect(screen.queryByRole('switch', { name: en['toggle.label'] })).toBeNull()
})
