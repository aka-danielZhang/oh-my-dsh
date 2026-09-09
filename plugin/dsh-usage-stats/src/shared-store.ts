/**
 * Module-level store singleton shared by the collector and gateway rows.
 *
 * Both rows live in this one package, so the loader resolves them to the same
 * module instance (the cross-instance registry split in AGENTS.md's "已知残
 * 留" concerns different node_modules copies of one package, not two rows of
 * one package). The collector owns the store's lifecycle; the gateway awaits
 * publication because activation order between rows is unconstrained.
 *
 * @module dsh-usage-stats/shared-store
 */

import type { UsageStatsStore } from './store.ts'

let shared: UsageStatsStore | undefined
let waiters: Array<(store: UsageStatsStore) => void> = []

/**
 * Publish the shared store (collector applies; HMR re-applies overwrite).
 * @param store - the store instance the collector created and opened.
 */
export function publishStore(store: UsageStatsStore): void {
  shared = store
  const pending = waiters
  waiters = []
  for (const resolve of pending) resolve(store)
}

/**
 * Retract the shared store (collector fiber disposed; gateway queries fail
 * loud until a new collector publishes).
 */
export function retractStore(store: UsageStatsStore): void {
  if (shared === store) shared = undefined
}

/**
 * The shared store when the collector already published it.
 * @returns the store, or undefined while the collector fiber is still opening.
 */
export function peekStore(): UsageStatsStore | undefined {
  return shared
}

/**
 * Await the shared store. Resolves immediately when already published; the
 * gateway's Remote methods use this so early queries wait for the collector
 * instead of failing.
 */
export function awaitStore(): Promise<UsageStatsStore> {
  if (shared !== undefined) return Promise.resolve(shared)
  return new Promise(resolve => {
    waiters.push(resolve)
  })
}
