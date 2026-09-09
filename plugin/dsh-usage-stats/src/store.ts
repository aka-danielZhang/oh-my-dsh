/**
 * Usage-statistics store: one append-only JSONL file per local day under
 * `<DSH_HOME>/usage-stats/records/`, an in-memory aggregate rebuilt from those
 * files at open, and a `state.json` carrying the backfill bookkeeping
 * (per-session seq watermarks + backfilled set).
 *
 * Design stances (see docs/notes/2026-09-09-usage-stats.md and the
 * implementation note):
 *
 * - Records are the single source of truth. Every open rescans them fully to
 *   rebuild the dedup set and the aggregates; `aggregates.json` is only a
 *   published snapshot for debugging/future fast-start, never an authority.
 * - Dedup key is the assistant message id, so fork seed messages (same id in a
 *   new session log) and live/backfill races collapse naturally.
 * - Cross-process: desktop and terminal share `$DSH_HOME` and both append
 *   without locks (fs-observation-log posture). O_APPEND line writes interleave
 *   safely; partial trailing lines are skipped until they complete;
 *   `rescan()` folds whatever other processes appended.
 *
 * Framework-free (plain node:fs) so it is unit-testable without a Cordis
 * context; src/collector.ts wires it to events.
 *
 * @module dsh-usage-stats/store
 */

import {
  appendFileSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { UsageRecord } from './types.ts'
import {
  applyRecord,
  dateKeyOf,
  dayIndexOf,
  localUtcOffsetMinutes,
  parseRecordLine,
  serializeRecordLine,
  type DayAggregates,
} from './fold.ts'
import type { UsageStatsConfig } from './config.ts'

/** Persisted backfill bookkeeping (`state.json`). */
export interface StoreState {
  v: 1
  /** session id → highest consumed event seq (crash-resume watermark). */
  sessions: Record<string, number>
  /** Sessions whose historical logs the backfill already walked. */
  backfilled: string[]
}

/** Snapshot published to `aggregates.json` (advisory, not authoritative). */
export interface PublishedAggregates {
  v: 1
  updatedAt: number
  days: DayAggregates
}

const RECORDS_DIR = 'records'
const STATE_FILE = 'state.json'
const AGGREGATES_FILE = 'aggregates.json'

function emptyState(): StoreState {
  return { v: 1, sessions: {}, backfilled: [] }
}

/**
 * Session-keyed usage store. One instance lives behind the module-level
 * singleton in ./shared-store.ts; disposal flushes pending state (the records
 * persist).
 */
export class UsageStatsStore {
  private readonly config: UsageStatsConfig
  private readonly dir: string
  private readonly utcOffsetMinutes: number
  /** message id → seen (dedup across sessions and channels). */
  private readonly seen = new Set<string>()
  private readonly days: DayAggregates = {}
  /** records file name → consumed byte offset (rescan cursor). */
  private readonly scanOffsets = new Map<string, number>()
  private state: StoreState = emptyState()
  private backfilledSet = new Set<string>()
  private opened = false
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private consecutiveWriteFailures = 0
  private writeDisabled = false

  constructor(config: UsageStatsConfig, dir: string, utcOffsetMinutes: number = localUtcOffsetMinutes()) {
    this.config = config
    this.dir = dir
    this.utcOffsetMinutes = utcOffsetMinutes
  }

  /** The store root (`…/usage-stats`). */
  get root(): string {
    return this.dir
  }

  private get recordsDir(): string {
    return join(this.dir, RECORDS_DIR)
  }

  private recordsFileFor(dateKey: string): string {
    return join(this.recordsDir, `${dateKey}.jsonl`)
  }

  /**
   * Open the store: enforce retention, load `state.json`, and rebuild the
   * dedup set + aggregates from every retained records file. Idempotent and
   * asynchronous — the initial full scan of a large history must not block
   * boot (the collector wires event listeners only after it settles).
   */
  async open(): Promise<void> {
    if (this.opened) return
    await mkdir(this.recordsDir, { recursive: true })
    await this.enforceRetention()
    this.state = await this.loadState()
    this.backfilledSet = new Set(this.state.backfilled)
    await this.rescanFully()
    this.opened = true
  }

  /** Delete records files older than `retentionDays` (aggregates follow at
   * rebuild: the in-memory days are folded from retained files only). */
  private async enforceRetention(): Promise<void> {
    const files = await this.listRecordsFiles()
    if (files.length === 0) return
    const todayIndex = dayIndexOf(dateKeyOf(Date.now(), this.utcOffsetMinutes))
    for (const file of files) {
      const dateKey = file.slice(0, -'.jsonl'.length)
      let index: number
      try {
        index = dayIndexOf(dateKey)
      } catch {
        continue
      }
      if (todayIndex - index > this.config.retentionDays) {
        try {
          await unlink(join(this.recordsDir, file))
        } catch {
          // Already gone or unreadable — retention is best-effort.
        }
      }
    }
  }

  private async listRecordsFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.recordsDir)
      return entries.filter(file => file.endsWith('.jsonl')).sort()
    } catch {
      return []
    }
  }

  private async loadState(): Promise<StoreState> {
    let text: string
    try {
      text = await readFile(join(this.dir, STATE_FILE), 'utf8')
    } catch {
      // Absent or unreadable: the backfill reruns from scratch; records and
      // their dedup ids rebuild from the files.
      return emptyState()
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null) return emptyState()
      const state = parsed as Partial<StoreState>
      if (state.v !== 1) return emptyState()
      const sessions: Record<string, number> = {}
      if (typeof state.sessions === 'object' && state.sessions !== null) {
        for (const [sid, seq] of Object.entries(state.sessions)) {
          if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) sessions[sid] = seq
        }
      }
      const backfilled = Array.isArray(state.backfilled)
        ? state.backfilled.filter((sid): sid is string => typeof sid === 'string' && sid.length > 0)
        : []
      return { v: 1, sessions, backfilled }
    } catch {
      return emptyState()
    }
  }

  /** Fold every retained file from byte zero (initial rebuild). */
  private async rescanFully(): Promise<void> {
    for (const file of await this.listRecordsFiles()) {
      const path = join(this.recordsDir, file)
      let size = 0
      try {
        size = (await stat(path)).size
      } catch {
        continue
      }
      await this.consumeFile(path, file, 0, size)
    }
  }

  /**
   * Read `offset..size` from one records file and fold every complete line.
   * The scan cursor advances to the byte after the last complete newline, so
   * a partial trailing line (another process mid-append) waits for its `\n`.
   */
  private async consumeFile(path: string, file: string, offset: number, size: number): Promise<void> {
    if (size <= offset) return
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return
    }
    const slice = text.slice(offset)
    const lastNewline = slice.lastIndexOf('\n')
    if (lastNewline < 0) return
    const body = slice.slice(0, lastNewline)
    for (const line of body.split('\n')) {
      const record = parseRecordLine(line)
      if (record === undefined) continue
      this.foldRecord(record)
    }
    this.scanOffsets.set(file, offset + lastNewline + 1)
  }

  /** Dedup-check and fold one record into memory (no disk write). */
  private foldRecord(record: UsageRecord): boolean {
    if (this.seen.has(record.mid)) return false
    this.seen.add(record.mid)
    applyRecord(this.days, record, dateKeyOf(record.t, this.utcOffsetMinutes))
    return true
  }

  /**
   * Incrementally fold records appended since the last scan (including lines
   * other processes wrote). Cheap when nothing changed: one `readdir` plus
   * per-file `stat`. Must not run before {@link open} settled.
   */
  async rescan(): Promise<void> {
    if (!this.opened) return
    for (const file of await this.listRecordsFiles()) {
      const path = join(this.recordsDir, file)
      const offset = this.scanOffsets.get(file) ?? 0
      let size = 0
      try {
        size = (await stat(path)).size
      } catch {
        continue
      }
      if (size > offset) await this.consumeFile(path, file, offset, size)
    }
  }

  /**
   * Record one usage record: dedup, append the day's JSONL line, fold into the
   * in-memory aggregates, and schedule a state/aggregates flush.
   *
   * Call only after {@link open} (the collector wires event listeners once the
   * initial rebuild finished). Fail-soft: after `maxWriteFailures` consecutive
   * write errors the disk side disables itself while the memory mirror keeps
   * serving this process's queries.
   * @returns whether the record was new (false = duplicate message id).
   */
  record(rec: UsageRecord): boolean {
    if (!this.opened) throw new Error('usage-stats: record() before open()')
    if (this.seen.has(rec.mid)) return false
    const dateKey = dateKeyOf(rec.t, this.utcOffsetMinutes)
    if (!this.writeDisabled) {
      try {
        appendFileSync(this.recordsFileFor(dateKey), serializeRecordLine(rec), 'utf8')
        this.consecutiveWriteFailures = 0
      } catch {
        this.consecutiveWriteFailures += 1
        if (this.consecutiveWriteFailures >= this.config.maxWriteFailures) this.writeDisabled = true
      }
    }
    this.foldRecord(rec)
    this.scheduleFlush()
    return true
  }

  /** Test/diagnostic access to the fail-soft state. */
  get diskWriteDisabled(): boolean {
    return this.writeDisabled
  }

  /** The live aggregate map (callers must not mutate). */
  get aggregates(): Readonly<DayAggregates> {
    return this.days
  }

  /** Highest consumed event seq for one session (0 = never seen). */
  sessionWatermark(sid: string): number {
    return this.state.sessions[sid] ?? 0
  }

  /** Advance one session's watermark (monotonic). */
  setSessionWatermark(sid: string, seq: number): void {
    const current = this.state.sessions[sid] ?? 0
    if (seq > current) {
      this.state.sessions[sid] = seq
      this.scheduleFlush()
    }
  }

  /** Whether the backfill already walked this session's history. */
  isBackfilled(sid: string): boolean {
    return this.backfilledSet.has(sid)
  }

  /** Mark one session's history as walked. */
  markBackfilled(sid: string): void {
    if (this.backfilledSet.has(sid)) return
    this.backfilledSet.add(sid)
    this.state.backfilled.push(sid)
    this.scheduleFlush()
  }

  /** Seen-message count (diagnostics). */
  get seenCount(): number {
    return this.seen.size
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, this.config.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  /** Write `state.json` and `aggregates.json` atomically (tmp + rename). */
  flush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    if (this.writeDisabled) return
    try {
      mkdirSync(this.dir, { recursive: true })
      this.writeAtomic(join(this.dir, STATE_FILE), JSON.stringify(this.state))
      const snapshot: PublishedAggregates = { v: 1, updatedAt: Date.now(), days: this.days }
      this.writeAtomic(join(this.dir, AGGREGATES_FILE), JSON.stringify(snapshot))
      this.consecutiveWriteFailures = 0
    } catch {
      this.consecutiveWriteFailures += 1
      if (this.consecutiveWriteFailures >= this.config.maxWriteFailures) this.writeDisabled = true
    }
  }

  /** Atomic file replace; the temp name embeds the pid (two processes share `$DSH_HOME`). */
  private writeAtomic(path: string, text: string): void {
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  }

  /** Flush pending state (dispose path). */
  dispose(): void {
    this.flush()
  }
}
