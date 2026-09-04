import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { StoreWatcher, type WatchBatch } from '../src/watch.ts'
import { delay, scratchRoot } from './helpers/scratch.ts'

const MEM = 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'
const TOMB = 'tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0'

function recorder(): { batches: WatchBatch[]; watcher: (batch: WatchBatch) => void } {
  const batches: WatchBatch[] = []
  return { batches, watcher: (batch: WatchBatch) => { batches.push(batch) } }
}

test('watcher filters to relevant paths and debounces into one batch', async () => {
  const root = scratchRoot()
  const { batches, watcher } = recorder()
  const storeWatcher = new StoreWatcher(root, watcher, { debounceMs: 20 })
  storeWatcher.ingest([
    `scopes/user/semantic/${MEM}.md`,
    `scopes/user/semantic/${MEM}.md`,
    'journal/2026/09.jsonl',
    '.state/locks/writer.lock/info.json',
    `tombstones/${TOMB}.yaml`,
    `scopes/user/semantic/.tmp-1-${MEM}.md`,
  ])
  await delay(45)
  storeWatcher.flush()
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0]!.changed.sort(), [`scopes/user/semantic/${MEM}.md`, `tombstones/${TOMB}.yaml`])
  storeWatcher.stop()
})

test('watcher separates bursts outside the debounce window', async () => {
  const root = scratchRoot()
  const { batches, watcher } = recorder()
  const storeWatcher = new StoreWatcher(root, watcher, { debounceMs: 25 })
  storeWatcher.ingest([`scopes/user/semantic/${MEM}.md`])
  await delay(60)
  storeWatcher.ingest([`scopes/user/procedural/${MEM}.md`])
  await delay(60)
  assert.equal(batches.length, 2)
  storeWatcher.stop()
})

test('stop() drops pending events and is idempotent', async () => {
  const root = scratchRoot()
  const { batches, watcher } = recorder()
  const storeWatcher = new StoreWatcher(root, watcher, { debounceMs: 10 })
  storeWatcher.ingest([`scopes/user/semantic/${MEM}.md`])
  storeWatcher.stop()
  await delay(30)
  assert.deepEqual(batches, [])
  storeWatcher.stop()
})

test('a real recursive fs.watch sees an external write on macOS', { timeout: 10_000 }, async () => {
  const root = scratchRoot()
  mkdirSync(root, { recursive: true })
  const { batches, watcher } = recorder()
  const storeWatcher = new StoreWatcher(root, watcher, { debounceMs: 50 })
  storeWatcher.start()
  assert.equal(storeWatcher.active, true, `recursive fs.watch must work on this platform for the happy path (degraded: ${storeWatcher.degraded ?? 'n/a'})`)
  const target = join(root, 'scopes', 'user', 'semantic')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, `${MEM}.md`), 'x')
  const startedAt = Date.now()
  while (batches.length === 0 && Date.now() - startedAt < 5_000) {
    await delay(50)
  }
  storeWatcher.stop()
  assert.equal(batches.length > 0, true, 'watcher delivered the external write')
  const changed = batches.flatMap((batch) => batch.changed)
  assert.ok(changed.some((path) => path.includes(MEM)))
})
