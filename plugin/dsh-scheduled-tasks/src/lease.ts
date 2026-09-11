/**
 * Per-task cross-process lease (design §8.3): desktop and terminal may share
 * one `$DSH_HOME`, so exactly one host may claim a task's boundary.
 *
 * Same shape as dsh-ohmymemo's store lock, restated locally (cross-plugin
 * symbol imports are forbidden): an atomic `mkdir` of a lock directory
 * carrying holder identity (pid + process-start token + nonce). A stale
 * holder is proven gone by liveness/start-token — never by wall-clock age.
 * The wait is bounded; exhaustion throws `TaskLeaseBusyError` with a
 * redacted holder view. Release compares the nonce so a stolen lock is
 * never removed on our behalf.
 * @module dsh-scheduled-tasks/lease
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ensureDir } from './atomic.ts'

/** Lock directory contents. */
export interface LeaseInfo {
  pid: number
  /** Process start token (best-effort per platform) or null. */
  boot_id: string | null
  nonce: string
  acquired_at: string
  /** Redacted owner label, e.g. the task id — never instruction content. */
  owner: string
}

/** Identity of some pid: dead, or alive with an optional start token. */
type ProcessProbe = { state: 'dead' } | { state: 'alive', start: string | null }

const probeCache = new Map<number, { probe: ProcessProbe, at: number }>()
/** Short TTL: quick steal after death, no `ps` hammering under contention. */
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
      const start = fields[19] // field 22 overall (1-based) minus comm/pid/state
      if (start !== undefined) return { state: 'alive', start: `linux:${start}` }
    } catch {
      return { state: 'dead' }
    }
  }
  // macOS/BSD: ps prints the start time; a failed lookup means dead.
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2_000 })
    const out = (result.stdout ?? '').trim()
    if (result.status === 0 && out.length > 0) return { state: 'alive', start: out }
    return { state: 'dead' }
  }
  // Elsewhere (Windows): signal-0 liveness only, no stable start token.
  try {
    process.kill(pid, 0)
    return { state: 'alive', start: null }
  } catch {
    return { state: 'dead' }
  }
}

/** Whether a recorded holder may be declared stale (never by age alone). */
export function holderIsStale(info: LeaseInfo): boolean {
  const probe = probeProcess(info.pid)
  if (probe.state === 'dead') return true
  if (info.boot_id !== null && probe.start !== null && info.boot_id !== probe.start) return true
  return false
}

/** Lease exhaustion after the bounded wait. */
export class TaskLeaseBusyError extends Error {
  readonly code = 'TASK_LEASE_BUSY'
  readonly holder: Record<string, unknown>
  readonly waitedMs: number

  constructor(holder: Record<string, unknown>, waitedMs: number) {
    super(`scheduled task lease is held elsewhere (waited ${waitedMs}ms)`)
    this.name = 'TaskLeaseBusyError'
    this.holder = holder
    this.waitedMs = waitedMs
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

function newLeaseInfo(owner: string): LeaseInfo {
  const probe = probeProcess(process.pid, true)
  return {
    pid: process.pid,
    boot_id: probe.state === 'alive' ? probe.start : null,
    nonce: randomBytes(8).toString('hex'),
    acquired_at: new Date().toISOString(),
    owner,
  }
}

function readLeaseInfo(lockDir: string): LeaseInfo | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf8')) as Record<string, unknown>
    if (typeof raw.pid !== 'number' || typeof raw.nonce !== 'string') return undefined
    return {
      pid: raw.pid,
      boot_id: typeof raw.boot_id === 'string' ? raw.boot_id : null,
      nonce: raw.nonce,
      acquired_at: typeof raw.acquired_at === 'string' ? raw.acquired_at : '',
      owner: typeof raw.owner === 'string' ? raw.owner : '',
    }
  } catch {
    return undefined
  }
}

/** Holder view safe for errors/logs (no filesystem paths, no bodies). */
function redactedHolder(info: LeaseInfo | undefined): Record<string, unknown> {
  if (info === undefined) return { known: false }
  return { pid: info.pid, owner: info.owner, acquired_at: info.acquired_at, known: true }
}

/**
 * One reentrant-within-instance lock directory. Create per task and reuse
 * for the claim → settle lifetime of the owning service.
 */
export class TaskLease {
  private info: LeaseInfo | undefined
  private depth = 0

  constructor(
    readonly lockDir: string,
    private readonly options: { timeoutMs?: number, pollMs?: number } = {},
  ) {}

  get held(): boolean {
    return this.depth > 0
  }

  /** Run `fn` under the lease; released even when `fn` throws. */
  async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private async acquire(): Promise<void> {
    if (this.depth > 0) {
      this.depth += 1
      return
    }
    const startedAt = Date.now()
    for (;;) {
      if (this.tryAcquireFresh()) {
        this.depth = 1
        return
      }
      if (Date.now() - startedAt >= (this.options.timeoutMs ?? 5_000)) {
        throw new TaskLeaseBusyError(redactedHolder(readLeaseInfo(this.lockDir)), Date.now() - startedAt)
      }
      await delay(this.options.pollMs ?? 50)
    }
  }

  private release(): void {
    if (this.depth === 0) return
    this.depth -= 1
    if (this.depth > 0) return
    const info = this.info
    this.info = undefined
    if (info === undefined) return
    try {
      const current = readLeaseInfo(this.lockDir)
      if (current !== undefined && current.nonce === info.nonce) {
        rmSync(this.lockDir, { recursive: true, force: true })
      }
      // A different nonce means our hold was stolen — their lock, not ours.
    } catch {
      // Best-effort: a leftover dir is stealable once our pid is gone.
    }
  }

  /** One acquisition attempt: fresh mkdir, or steal a provably-stale holder. */
  private tryAcquireFresh(): boolean {
    const info = newLeaseInfo(this.taskOwner())
    ensureDir(dirname(this.lockDir))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(this.lockDir, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = readLeaseInfo(this.lockDir)
        if (existing === undefined) {
          if (!existsSync(this.lockDir)) continue
          return false
        }
        if (!holderIsStale(existing)) return false
        // Steal: atomically rename the stale dir aside, drop it, re-mkdir.
        const aside = `${this.lockDir}.stale-${randomUUID()}`
        try {
          renameSync(this.lockDir, aside)
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
        writeFileSync(join(this.lockDir, 'info.json'), `${JSON.stringify(info)}\n`, { mode: 0o600 })
      } catch (error) {
        try {
          rmSync(this.lockDir, { recursive: true, force: true })
        } catch {
          // Leave it; our pid is alive so nobody may steal it — retry below.
        }
        throw error
      }
      this.info = info
      return true
    }
    return false
  }

  /** Redacted owner label carried inside the lock for diagnostics. */
  private taskOwner(): string {
    return this.lockDir.split('/').at(-2) ?? 'task'
  }
}
