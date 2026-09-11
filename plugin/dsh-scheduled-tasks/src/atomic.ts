/**
 * Small filesystem helpers shared by the lease and the domain recovery path.
 * @module dsh-scheduled-tasks/atomic
 */

import { mkdirSync } from 'node:fs'

/** Recursively create a directory; existing directories are fine. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}
