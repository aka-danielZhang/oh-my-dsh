/**
 * Store-level cross-process writer lock. One writer at a time per store root,
 * acquired via an atomic `mkdir` of a lock directory carrying holder
 * identity (pid + process-start token + nonce).
 *
 * Stealing a stale lock must prove the holder is gone: the pid no longer
 * exists, or its process-start token differs from the recorded one (pid
 * reuse). Wall-clock age alone never justifies a steal.
 *
 * The wait is bounded; on timeout callers get `OHMYMEMO_BUSY`. There is no
 * last-writer-wins path anywhere in the store.
 * @module dsh-ohmymemo/lock
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ulid } from './ids.ts'
import { LockBusyError } from './errors.ts'
import { ensureDir, FILE_MODE, writeFileAtomic } from './atomic.ts'

/** Lock directory contents. */
export interface LockInfo {
  pid: number
  /** Process start token (e.g. lstart output) or null when unavailable. */
  boot_id: string | null
  nonce: string
  acquired_at: string
}

/** Identity of some pid: 'dead' or alive with an optional start token. */
type ProcessProbe = { state: 'dead' } | { state: 'alive'; start: string | null }

const probeCache = new Map<number, { probe: ProcessProbe; at: number }>()
// Short TTL: a steal decision must re-verify the holder quickly after a
// process dies, while contention loops still avoid hammering `ps`.
const PROBE_TTL_MS = 300

/** Probe a pid's liveness and (where available) its start token. */
export function probeProcess(pid: number, fresh = false): ProcessProbe {
  const now = Date.now()
  if (!fresh) {
    const cached = probeCache.get(pid)
    if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.probe
  }
  const probe = probeProcessUncached(pid)
  probeCache.set(pid, { probe, at: now })
  return probe
}

function probeProcessUncached(pid: number): ProcessProbe {
  // Linux: /proc/<pid>/stat field 22 is the start time in clock ticks.
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      const start = fields[19] // field 22 overall (1-based), minus comm/pid/state prefix
      if (start !== undefined) return { state: 'alive', start: `linux:${start}` }
    } catch {
      return { state: 'dead' }
    }
  }
  // macOS/BSD: ps gives the process start time; a failed lookup means dead.
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000 })
    const out = (result.stdout ?? '').trim()
    if (result.status === 0 && out.length > 0) return { state: 'alive', start: out }
    return { state: 'dead' }
  }
  // Elsewhere: signal-0 liveness only (Windows has no stable start token).
  try {
    process.kill(pid, 0)
    return { state: 'alive', start: null }
  } catch {
    return { state: 'dead' }
  }
}

/** Whether a recorded holder may be declared stale (never by age alone). */
export function holderIsStale(info: LockInfo): boolean {
  const probe = probeProcess(info.pid)
  if (probe.state === 'dead') return true
  if (info.boot_id !== null && probe.start !== null && info.boot_id !== probe.start) return true
  return false
}

/**
 * The single-writer lock. One instance per store root per process; reentrant
 * within the instance (nested `withLock` calls share one hold).
 */
export class WriterLock {
  readonly lockDir: string
  private readonly timeoutMs: number
  private readonly pollMs: number
  private info: LockInfo | undefined
  private depth = 0

  constructor(lockDir: string, options: { timeoutMs?: number; pollMs?: number } = {}) {
    this.lockDir = lockDir
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.pollMs = options.pollMs ?? 50
  }

  get held(): boolean {
    return this.depth > 0
  }

  holderInfo(): LockInfo | undefined {
    return readLockInfo(this.lockDir)
  }

  async acquire(): Promise<void> {
    if (this.depth > 0) {
      this.depth += 1
      return
    }
    const startedAt = Date.now()
    for (;;) {
      const info = this.tryAcquireFresh()
      if (info !== undefined) {
        this.info = info
        this.depth = 1
        return
      }
      if (Date.now() - startedAt >= this.timeoutMs) {
        throw new LockBusyError(redactHolder(readLockInfo(this.lockDir)), Date.now() - startedAt)
      }
      await delay(this.pollMs)
    }
  }

  release(): void {
    if (this.depth === 0) return
    this.depth -= 1
    if (this.depth > 0) return
    const info = this.info
    this.info = undefined
    if (info === undefined) return
    try {
      const current = readLockInfo(this.lockDir)
      if (current !== undefined && current.nonce === info.nonce) {
        rmSync(this.lockDir, { recursive: true, force: true })
      }
      // A different nonce means someone stole/replaced our expired hold —
      // their lock, not ours to remove.
    } catch {
      // Releasing is best-effort; a leftover lock dir is stealable once its
      // holder (us) is gone.
    }
  }

  /** Run `fn` under the lock; released even when fn throws. */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  /** One acquisition attempt: fresh mkdir, or steal a provably-stale holder. */
  private tryAcquireFresh(): LockInfo | undefined {
    const info = newLockInfo()
    // The parent must exist; the lock directory itself is created atomically.
    ensureDir(dirname(this.lockDir))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(this.lockDir, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = readLockInfo(this.lockDir)
        if (existing === undefined) {
          // Unreadable holder: retry the mkdir (it may be a half-written
          // steal from another process); do not guess it away.
          if (!existsSync(this.lockDir)) continue
          return undefined
        }
        if (!holderIsStale(existing)) return undefined
        // Steal: atomically rename the stale dir aside, drop it, re-mkdir.
        const aside = `${this.lockDir}.stale-${ulid()}`
        try {
          renameDir(this.lockDir, aside)
        } catch {
          continue // someone else stole first — loop and re-examine
        }
        try {
          rmSync(aside, { recursive: true, force: true })
        } catch {
          // Forensic leftovers are harmless (dot-dir outside the lock name).
        }
        continue
      }
      // Fresh directory is ours; publish holder identity.
      try {
        writeFileSync(join(this.lockDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`, { mode: FILE_MODE })
      } catch (error) {
        try {
          rmSync(this.lockDir, { recursive: true, force: true })
        } catch {
          // Leave it; our pid is alive so nobody may steal it — retry below.
        }
        throw error
      }
      return info
    }
    return undefined
  }
}

/** Rename helper kept separate so tests can observe steal side effects. */
function renameDir(from: string, to: string): void {
  renameSync(from, to)
}

function newLockInfo(): LockInfo {
  const probe = probeProcess(process.pid, true)
  return {
    pid: process.pid,
    boot_id: probe.state === 'alive' ? probe.start : null,
    nonce: randomBytes(8).toString('hex'),
    acquired_at: new Date().toISOString(),
  }
}

/** Read holder identity from a lock directory. */
export function readLockInfo(lockDir: string): LockInfo | undefined {
  try {
    const text = readFileSync(join(lockDir, 'info.json'), 'utf8')
    const raw = JSON.parse(text) as Record<string, unknown>
    if (typeof raw.pid !== 'number' || typeof raw.nonce !== 'string') return undefined
    return {
      pid: raw.pid,
      boot_id: typeof raw.boot_id === 'string' ? raw.boot_id : null,
      nonce: raw.nonce,
      acquired_at: typeof raw.acquired_at === 'string' ? raw.acquired_at : '',
    }
  } catch {
    return undefined
  }
}

/** Holder view safe for errors/logs (no filesystem paths, no bodies). */
function redactHolder(info: LockInfo | undefined): Record<string, unknown> {
  if (info === undefined) return { known: false }
  return { pid: info.pid, boot_id: info.boot_id, acquired_at: info.acquired_at, known: true }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Write a lock directory that looks like a holder (test/forensics helper). */
export function plantLockDir(lockDir: string, info: LockInfo): void {
  writeFileAtomic(join(lockDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`)
}
