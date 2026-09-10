/**
 * Collector row: fold `assistant/message` usage into the store, live and
 * from history.
 *
 * - Live: `ctx.on('session/event', …)` on this bundle-layer row (root scope —
 *   every session, subagent sessions included) folds each appended event as
 *   it commits. Interrupted messages count: the tokens were really spent.
 * - History: on every start a background walk re-reads each session log the
 *   bookkeeping has not settled (`sessionQuery.listSessions()` →
 *   `readSession`), folding events past the per-session seq watermark. First
 *   run is the full backfill (old data enters the stats immediately); later
 *   runs only catch the gap a dead process missed. Message-id dedup absorbs
 *   every overlap — fork seed messages, live/backfill races, watermark races
 *   between desktop and terminal sharing one `$DSH_HOME`.
 *
 * Both channels call the same pure fold (src/fold.ts) and one store
 * (src/store.ts), so the persisted numbers cannot diverge by origin.
 *
 * @module dsh-usage-stats/collector
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import { homedir } from 'node:os'
import { usageStatsDir, validateConfig } from './config.ts'
import { SessionUsageFolder, type SessionEventView } from './fold.ts'
import { UsageStatsStore } from './store.ts'
import { publishStore, retractStore } from './shared-store.ts'

/**
 * Structural view of the query engine's history reads (instance-agnostic —
 * the runtime owns the real `dsh-session-query` types; importing them here
 * would drag their deep peer chain into devDependencies for type-only use).
 */
interface SessionQueryView {
  listSessions(): Promise<Array<{ header: { id: string } }>>
  readSession(id: string): Promise<{ events: ReadonlyArray<SessionEventView> }>
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-usage-stats/collector'

/** Hard dependency: the backfill reads history through the query engine. */
export const inject = ['sessionQuery']

/** How many sessions the backfill walks between intermediate state flushes. */
const BACKFILL_FLUSH_EVERY = 25

/** Narrow one live session argument to its id. */
function sessionIdOf(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | null | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Walk the corpus once, folding every session the bookkeeping has not
 * settled. Failures are per-session and logged: statistics are advisory and
 * one broken log must not stop the walk.
 */
async function runBackfill(query: SessionQueryView, folder: SessionUsageFolder, ctx: Context, store: UsageStatsStore, isDisposed: () => boolean): Promise<void> {
  let sessions: Awaited<ReturnType<SessionQueryView['listSessions']>>
  try {
    sessions = await query.listSessions()
  } catch (error) {
    ctx.logger.warn(`usage-stats: backfill could not list sessions: ${String(error)}`)
    return
  }
  let walked = 0
  for (const record of sessions) {
    if (isDisposed()) return
    const sid = record.header.id
    // Already-walked sessions that no watermark tracks cannot have grown
    // (no process saw them live); their records sit in the store files and
    // arrive through rescan. Everything else gets an incremental read.
    if (store.isBackfilled(sid) && store.sessionWatermark(sid) === 0) continue
    try {
      const log = await query.readSession(sid)
      for (const event of log.events) {
        const usage = folder.fold(sid, event)
        if (usage !== undefined) store.record(usage)
        store.setSessionWatermark(sid, event.seq)
      }
      store.markBackfilled(sid)
      walked += 1
      if (walked % BACKFILL_FLUSH_EVERY === 0) store.flush()
    } catch (error) {
      ctx.logger.warn(`usage-stats: backfill skipped session ${sid}: ${String(error)}`)
    }
  }
  store.flush()
  if (walked > 0) {
    ctx.logger.info(`usage-stats: backfill walked ${walked} session(s), ${store.seenCount} message(s) tracked`)
  }
}

/**
 * Collector plugin body.
 * @param ctx - host root context (bundle layer ⇒ root scope for session events).
 * @param rawConfig - the composition config row.
 * @returns a disposer retracting the shared store and unwiring listeners.
 */
export function apply(ctx: Context, rawConfig: unknown): () => void {
  const config = validateConfig(rawConfig)
  const store = new UsageStatsStore(config, usageStatsDir(process.env.DSH_HOME, homedir()))
  const folder = new SessionUsageFolder()
  const disposers: Array<() => void> = []
  let disposed = false

  const onEvent = (session: unknown, event: unknown): void => {
    const sid = sessionIdOf(session)
    if (sid === undefined || event === null || typeof event !== 'object') return
    // The runtime owns the real SessionEvent union; the folder re-validates
    // every field it reads, so this structural cast is the whole bridge.
    const usage = folder.fold(sid, event as SessionEventView)
    if (usage !== undefined) store.record(usage)
    const seq = (event as { seq?: unknown } | null | undefined)?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) store.setSessionWatermark(sid, seq)
  }

  void (async () => {
    try {
      await store.open()
    } catch (error) {
      ctx.logger.warn(`usage-stats: store failed to open: ${String(error)}`)
      return
    }
    if (disposed) return
    publishStore(store)
    // Listeners mount only after the initial records rebuild: folding before
    // the dedup set exists could double-count a message another process (or
    // this one, before a crash) already persisted. Events appended in the
    // meantime stay in the session logs and enter through the backfill walk.
    disposers.push(ctx.on('session/event', onEvent))
    const query = (ctx as unknown as { sessionQuery: SessionQueryView }).sessionQuery
    await runBackfill(query, folder, ctx, store, () => disposed)
  })()

  return () => {
    disposed = true
    retractStore(store)
    for (const dispose of disposers) dispose()
    store.dispose()
  }
}
