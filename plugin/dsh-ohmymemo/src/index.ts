/**
 * dsh-ohmymemo, host half — the `ohmymemo-store` row.
 *
 * Phase 1 opened the Markdown store medium contract (`$DSH_HOME/ohmymemo/`,
 * one memory = one Markdown file with YAML frontmatter) as a cross-session
 * host capability: layout, manifest/config, transaction recovery, full scan
 * and a filesystem watcher. Phase 2 layers the explicit memory loop on the
 * same row: after open it provides the `ctx.ohMyMemo` service (consumed by
 * the `ohmymemo-tools` and `ohmymemo-context` rows from this same package)
 * and keeps the bounded views rebuilt from canonical records.
 *
 * Unmount closes store and watcher; every effect is reversible. Files with
 * broken frontmatter stay on disk untouched and are excluded from recall
 * (fail closed). Every harness import stays type-only so this entry keeps
 * zero `@deepseek-ai/*` runtime imports.
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
import { createOhMyMemoService, provideOhMyMemo } from './service.ts'
import { OhMyMemoStore } from './store.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-ohmymemo'

/**
 * Host plugin body: open the store, provide the service, keep views fresh.
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
  const service = createOhMyMemoService(store)
  let disposed = false
  let unsubscribe: (() => void) | undefined

  const rebuildViewsQuietly = (): void => {
    void service.rebuildViews().catch((error: unknown) => {
      ctx.logger.warn(`dsh-ohmymemo: view rebuild failed: ${(error as Error).message}`)
    })
  }

  ctx.effect(() => {
    void store.open().then(() => {
      if (disposed) {
        store.close()
        return
      }
      provideOhMyMemo(ctx, service)
      // Views are derived artifacts: rebuilt at open and after every change.
      unsubscribe = store.subscribe(rebuildViewsQuietly)
      rebuildViewsQuietly()
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
      unsubscribe?.()
      store.close()
    }
  })
}
