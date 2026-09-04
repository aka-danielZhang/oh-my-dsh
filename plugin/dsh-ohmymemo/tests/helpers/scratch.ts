/**
 * Scratch-home helpers shared by every test file: all tests build stores in
 * `fs.mkdtemp` roots — the real `~/.dsh/ohmymemo` is never read or written.
 * @module dsh-ohmymemo/tests/helpers/scratch
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh scratch DSH home (caller passes it as the store root's parent). */
export function scratchDshHome(): string {
  return mkdtempSync(join(tmpdir(), 'ohmymemo-test-home-'))
}

/** A fresh scratch store root. */
export function scratchRoot(): string {
  return join(scratchDshHome(), 'ohmymemo')
}

/** Poll until `probe` returns a value (or timeout); surfaces the last error. */
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 4_000, intervalMs = 25): Promise<T> {
  const startedAt = Date.now()
  let lastError: unknown
  for (;;) {
    try {
      const value = probe()
      if (value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw lastError instanceof Error ? lastError : new Error(`waitFor timed out after ${timeoutMs}ms`)
    }
    await delay(intervalMs)
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
