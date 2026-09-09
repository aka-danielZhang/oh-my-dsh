/**
 * Atomic publish primitives for the store medium: same-directory temp file,
 * fsync, atomic rename, parent-directory fsync. Canonical files are never
 * truncated in place.
 *
 * Permissions: directories 0700, files 0600 — these isolate the store from
 * other local accounts only; they are not a defense against the current
 * account.
 * @module dsh-ohmymemo/atomic
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ulid } from './ids.ts'

/** Directory permission: owner-only. */
export const DIR_MODE = 0o700

/** File permission: owner-only. */
export const FILE_MODE = 0o600

/** Ensure a directory exists (recursive), created owner-only when missing. */
export function ensureDir(path: string, mode: number = DIR_MODE): void {
  mkdirSync(path, { recursive: true, mode })
}

/** fsync a directory so a rename inside it is durable (POSIX; best-effort elsewhere). */
export function fsyncDir(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Directory fsync is unavailable on some platforms/filesystems; the
    // rename itself is still atomic. Best-effort by design.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** sha256 of file bytes, `sha256:<hex>` form (the store's content hash). */
export function hashFile(path: string): string | undefined {
  try {
    return hashBytes(readFileSync(path))
  } catch {
    return undefined
  }
}

/** sha256 of in-memory bytes, `sha256:<hex>` form. */
export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** sha256 of a string's UTF-8 bytes. */
export function hashText(text: string): string {
  return hashBytes(Buffer.from(text, 'utf8'))
}

/**
 * Atomically publish `content` at `absPath`:
 *
 * 1. create a unique temp file in the same directory (0600, `wx`),
 * 2. write, fsync, close,
 * 3. run `validate` (must throw on content the store refuses to publish),
 * 4. atomic rename over the target,
 * 5. fsync the directory.
 *
 * Temp files are removed on failure. `mode` applies to the published file.
 */
export function writeFileAtomic(absPath: string, content: string, options: { mode?: number; validate?: (content: string) => void } = {}): void {
  const dir = dirname(absPath)
  ensureDir(dir)
  const temp = join(dir, `.tmp-${process.pid}-${ulid()}`)
  const fd = openSync(temp, 'wx', options.mode ?? FILE_MODE)
  try {
    writeSync(fd, Buffer.from(content, 'utf8'))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    options.validate?.(content)
    renameSync(temp, absPath)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // The rename either happened or the temp is already gone.
    }
    throw error
  }
  fsyncDir(dir)
}

/** Remove a file if present; other errors propagate. */
export function removeFileIfExists(path: string): boolean {
  try {
    unlinkSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Stat a file when it exists and is a regular file. */
export function statFile(path: string): { bytes: number; mtimeMs: number; mode: number } | undefined {
  try {
    const info = statSync(path)
    if (!info.isFile()) return undefined
    return { bytes: info.size, mtimeMs: info.mtimeMs, mode: info.mode }
  } catch {
    return undefined
  }
}
