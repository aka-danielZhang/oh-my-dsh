import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { LockBusyError } from '../src/errors.ts'
import { WriterLock, holderIsStale, plantLockDir, readLockInfo } from '../src/lock.ts'
import { delay, scratchRoot } from './helpers/scratch.ts'

const LOCK_REL = '.state/locks/writer.lock'

function lockDir(root: string): string {
  return join(root, ...LOCK_REL.split('/'))
}

test('acquire/release is reentrant within one instance', async () => {
  const root = scratchRoot()
  const lock = new WriterLock(lockDir(root), { timeoutMs: 200 })
  await lock.acquire()
  await lock.acquire()
  assert.equal(lock.held, true)
  lock.release()
  assert.equal(lock.held, true)
  lock.release()
  assert.equal(lock.held, false)
  assert.equal(existsSync(lockDir(root)), false)
})

test('a second instance in the same process sees BUSY (bounded wait, no steal)', async () => {
  const root = scratchRoot()
  const first = new WriterLock(lockDir(root), { timeoutMs: 200 })
  await first.acquire()
  const second = new WriterLock(lockDir(root), { timeoutMs: 150, pollMs: 25 })
  await assert.rejects(() => second.acquire(), (error: unknown) => {
    assert.ok(error instanceof LockBusyError)
    assert.equal(error.code, 'OHMYMEMO_BUSY')
    const holder = error.detail.holder as { pid: number; known: boolean }
    assert.equal(holder.pid, process.pid)
    assert.equal(holder.known, true)
    return true
  })
  first.release()
  await second.acquire()
  second.release()
})

test('a live holder process in ANOTHER process blocks, and its death frees the lock (stale steal)', async () => {
  const root = scratchRoot()
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'helpers', 'lock-holder.mts'), lockDir(root)], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let held = ''
  child.stdout.on('data', (chunk: Buffer) => {
    held += chunk.toString('utf8')
  })
  const startedAt = Date.now()
  while (!held.includes('held\n') && Date.now() - startedAt < 15_000) {
    await delay(50)
  }
  assert.ok(held.includes('held\n'), `lock holder did not signal (got: ${held!})`)

  const parent = new WriterLock(lockDir(root), { timeoutMs: 800, pollMs: 25 })
  await assert.rejects(() => parent.acquire(), (error: unknown) => error instanceof LockBusyError)
  const holder = readLockInfo(lockDir(root))
  assert.ok(holder !== undefined)
  assert.equal(holder.pid, child.pid)
  assert.equal(holderIsStale(holder), false, 'a live holder is never stale')

  // Kill without release: the lock dir survives, the holder is dead.
  child.kill('SIGKILL')
  const exited = new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve()
    })
  })
  await exited
  assert.equal(existsSync(lockDir(root)), true)
  // The liveness probe caches for 300ms; let a dead pid's cache entry expire
  // before asserting staleness (production acquires retry until their own
  // bounded timeout, so the cache never blocks a steal in practice).
  await delay(400)
  assert.equal(holderIsStale(readLockInfo(lockDir(root))!), true)

  // Next acquire proves staleness (dead pid) and steals.
  await parent.acquire()
  assert.equal(lockDir(root) !== undefined, true)
  const fresh = readLockInfo(lockDir(root))
  assert.ok(fresh !== undefined)
  assert.equal(fresh.pid, process.pid)
  parent.release()
})

test('pid reuse protection: a live pid with a foreign start token is stale', async () => {
  const root = scratchRoot()
  const probe = spawnSync('true')
  assert.equal(probe.status, 0)
  plantLockDir(lockDir(root), {
    pid: process.pid,
    boot_id: 'some-other-boot-identity',
    nonce: 'cafe',
    acquired_at: new Date().toISOString(),
  })
  const lock = new WriterLock(lockDir(root), { timeoutMs: 200, pollMs: 20 })
  await lock.acquire()
  assert.equal(readLockInfo(lockDir(root))!.pid, process.pid)
  lock.release()
})

test('release only removes our own lock (foreign nonce survives)', async () => {
  const root = scratchRoot()
  const lock = new WriterLock(lockDir(root), { timeoutMs: 200 })
  await lock.acquire()
  plantLockDir(lockDir(root), {
    pid: process.pid,
    boot_id: null,
    nonce: 'notours',
    acquired_at: new Date().toISOString(),
  })
  lock.release()
  assert.equal(existsSync(lockDir(root)), true, 'foreign holder keeps the lock')
})
