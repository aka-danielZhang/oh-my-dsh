/**
 * dsh-ohmymemo, host half — Phase 1: the Markdown store medium contract.
 *
 * This plugin mounts the OhMyMemo store (`$DSH_HOME/ohmymemo/`, one memory =
 * one Markdown file with YAML frontmatter) as a cross-session host
 * capability: on mount it opens the store (layout, manifest/config,
 * transaction recovery, full scan) and keeps an in-process catalog refreshed
 * by a filesystem watcher; unmount closes both. Diagnostics surface through
 * the logger — files with broken frontmatter stay on disk untouched and are
 * excluded from recall (fail closed).
 *
 * Phase 1 deliberately registers no model tools and no `ctx.ohMyMemo`
 * service — those are the Phase 2 explicit-memory loop built on this exact
 * seam (`src/store.ts`). Every harness import is type-only so the built
 * bundle cannot drag a second module instance into the process.
 *
 * Composition note (the design doc): the store is shared across sessions and
 * therefore rides the host composition via the bundle patch — never an agent
 * preset isolate realm and never a dynamic (non-persistent) plugin.
 * @module dsh-ohmymemo
 */

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { validatePluginConfig } from './config.ts'
import { defaultStoreRoot } from './paths.ts'
import { OhMyMemoStore } from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-ohmymemo'

/**
 * Host plugin body: open the store and keep it fresh; fully reversible.
 * @param ctx - host root context.
 * @param rawConfig - the cordis row config (see `src/config.ts`).
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  const config = validatePluginConfig(rawConfig)
  const root = config.root ?? defaultStoreRoot(process.env.DSH_HOME, homedir())
  const store = new OhMyMemoStore({
    root,
    watch: config.watch,
    lockTimeoutMs: config.lockTimeoutMs,
    watchDebounceMs: config.watchDebounceMs,
    logger: ctx.logger,
  })
  let disposed = false
  ctx.effect(() => {
    void store.open().then(() => {
      if (disposed) {
        store.close()
        return
      }
      const errors = store.doctor().filter((diagnostic) => diagnostic.severity === 'error')
      for (const diagnostic of errors) {
        ctx.logger.warn(`dsh-ohmymemo: ${diagnostic.message}`)
      }
    }).catch((error: unknown) => {
      // Async fatal (recovery conflict, unreadable layout): visible in logs
      // and through store.openError; mutations refuse until a clean open.
      ctx.logger.error(`dsh-ohmymemo: store failed to open at ${root}: ${(error as Error).message}`)
    })
    return () => {
      disposed = true
      store.close()
    }
  })
}
