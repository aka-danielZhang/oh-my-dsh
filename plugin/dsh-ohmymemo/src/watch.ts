/**
 * Filesystem watcher over the store root. macOS/Windows get a recursive
 * `fs.watch`; where the platform refuses recursion the watcher degrades to
 * inactive and reports the failure (the catalog stays consistent — it is
 * rebuilt at open regardless).
 *
 * Events are debounced, filtered to scanner-relevant paths (records,
 * tombstones, scope files), and handed to the store as a set of changed
 * store-relative paths. The store performs hash-diffed refreshes, so
 * duplicate or spurious events are harmless.
 * @module dsh-ohmymemo/watch
 */

import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { isWatchRelevant, parseLocation } from './paths.ts'

/** Watcher options. */
export interface WatchOptions {
  debounceMs?: number
  /** Invoked when the watcher stops itself (platform refusal, error storm). */
  onDegraded?: (reason: string) => void
}

/** Platform events the watcher forwards (after filtering). */
export interface WatchBatch {
  /** Store-relative, `/`-separated paths that changed (files or dirs). */
  changed: string[]
}

export class StoreWatcher {
  readonly root: string
  private readonly debounceMs: number
  private readonly onDegraded?: (reason: string) => void
  private readonly handler: (batch: WatchBatch) => void
  private watcher: FSWatcher | undefined
  private pending = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private degradedReason: string | undefined

  constructor(root: string, handler: (batch: WatchBatch) => void, options: WatchOptions = {}) {
    this.root = root
    this.handler = handler
    this.debounceMs = options.debounceMs ?? 120
    this.onDegraded = options.onDegraded
  }

  get active(): boolean {
    return this.watcher !== undefined && this.degradedReason === undefined
  }

  get degraded(): string | undefined {
    return this.degradedReason
  }

  start(): void {
    if (this.watcher !== undefined || this.stopped) return
    try {
      this.watcher = watch(this.root, { recursive: true }, (event, filename) => {
        if (typeof filename !== 'string') return
        this.record(filename)
      })
    } catch (error) {
      this.degrade(`fs.watch(${this.root}, recursive) unavailable: ${(error as Error).message}`)
      return
    }
    this.watcher.on('error', (error: Error) => {
      this.degrade(`watch error: ${error.message}`)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.watcher?.close()
    this.watcher = undefined
  }

  /** Test hook: pretend the platform reported these raw filenames. */
  ingest(filenames: string[]): void {
    for (const filename of filenames) this.record(filename)
  }

  /** Test hook: flush the debounce window immediately. */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.emit()
  }

  private record(filename: string): void {
    if (this.stopped || this.degradedReason !== undefined) return
    const rel = filename.split(/[\\/]/).join('/')
    const location = parseLocation(rel)
    if (!isWatchRelevant(location)) return
    this.pending.add(rel)
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit()
    }, this.debounceMs)
  }

  private emit(): void {
    if (this.pending.size === 0) return
    const changed = [...this.pending]
    this.pending.clear()
    this.handler({ changed })
  }

  private degrade(reason: string): void {
    if (this.degradedReason !== undefined) return
    this.degradedReason = reason
    this.stop()
    this.onDegraded?.(reason)
  }

  /** Absolute path helper exposed for tests. */
  abs(rel: string): string {
    return join(this.root, ...rel.split('/'))
  }
}
