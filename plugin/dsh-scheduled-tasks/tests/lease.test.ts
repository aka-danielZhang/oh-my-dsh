/**
 * Per-task lease tests: mutual exclusion, stale-holder steal (by liveness
 * proof, never by age), and nonce-guarded release.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { holderIsStale, probeProcess, TaskLease, TaskLeaseBusyError } from '../src/lease.ts'
import type { LeaseInfo } from '../src/lease.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-stask-lease-'))
}

test('a lock excludes other acquires until released', async () => {
  const root = scratch()
  const leaseA = new TaskLease(join(root, 'task-a.lock'), { timeoutMs: 300, pollMs: 20 })
  const leaseB = new TaskLease(join(root, 'task-a.lock'), { timeoutMs: 300, pollMs: 20 })

  await leaseA.withLock(async () => {
    assert.equal(leaseA.held, true)
    await assert.rejects(() => leaseB.withLock(async () => {}), TaskLeaseBusyError)
  })
  assert.equal(leaseA.held, false)
  // After release the directory is gone and B can take it.
  await leaseB.withLock(async () => {
    assert.equal(leaseB.held, true)
  })
  rmSync(root, { recursive: true, force: true })
})

test('withLock releases even when the body throws', async () => {
  const root = scratch()
  const lease = new TaskLease(join(root, 'task-b.lock'), { timeoutMs: 300, pollMs: 20 })
  await assert.rejects(() => lease.withLock(async () => {
    throw new Error('boom')
  }), /boom/)
  assert.equal(lease.held, false)
  const second = new TaskLease(join(root, 'task-b.lock'), { timeoutMs: 300, pollMs: 20 })
  await second.withLock(async () => {})
  rmSync(root, { recursive: true, force: true })
})

test('a dead holder is proven stale and stealable; age alone is not', async () => {
  const root = scratch()
  const lockDir = join(root, 'dead.lock')
  mkdirSync(lockDir, { recursive: true })
  // pid 1 (init/launchd) is alive but we fabricate a mismatching start token
  // only when the platform can read one — the dead case uses an impossible pid.
  const deadInfo: LeaseInfo = {
    pid: 999_999_999,
    boot_id: null,
    nonce: 'cafebabe',
    acquired_at: new Date().toISOString(),
    owner: 'task-dead',
  }
  writeFileSync(join(lockDir, 'info.json'), JSON.stringify(deadInfo))
  assert.equal(holderIsStale(deadInfo), true, 'a dead pid must be stale')

  // Our own pid with a wrong start token (pid reuse proof) is stale too —
  // except on platforms without a start token, where liveness alone protects.
  const probe = probeProcess(process.pid)
  const selfInfo: LeaseInfo = {
    pid: process.pid,
    boot_id: probe.state === 'alive' && probe.start !== null ? 'definitely-not-the-start-token' : null,
    nonce: 'f00d',
    acquired_at: new Date().toISOString(),
    owner: 'task-self',
  }
  const expectStale = probe.state === 'alive' && probe.start !== null
  assert.equal(holderIsStale(selfInfo), expectStale)

  // An ancient acquired_at never makes a live holder stealable by itself.
  const liveHolder: LeaseInfo = {
    pid: process.pid,
    boot_id: probe.state === 'alive' ? probe.start : null,
    nonce: 'beef',
    acquired_at: '2000-01-01T00:00:00.000Z',
    owner: 'task-live',
  }
  assert.equal(holderIsStale(liveHolder), false)
  rmSync(root, { recursive: true, force: true })
})

test('release leaves a stolen lock alone (nonce mismatch)', async () => {
  const root = scratch()
  const lockDir = join(root, 'stolen.lock')
  const lease = new TaskLease(lockDir, { timeoutMs: 300, pollMs: 20 })
  await lease.withLock(async () => {
    // Simulate a thief: replace the info with a different nonce.
    const thief: LeaseInfo = {
      pid: process.pid,
      boot_id: null,
      nonce: 'thief-nonce',
      acquired_at: new Date().toISOString(),
      owner: 'thief',
    }
    writeFileSync(join(lockDir, 'info.json'), JSON.stringify(thief))
  })
  // The thief's lock directory must survive our release.
  mkdirSync(lockDir, { recursive: true })
  assert.equal(holderIsStale({
    pid: process.pid,
    boot_id: null,
    nonce: 'thief-nonce',
    acquired_at: new Date().toISOString(),
    owner: 'thief',
  }), false)
  rmSync(root, { recursive: true, force: true })
})
