/**
 * Cross-process observation evidence store: one JSONL sidecar per session
 * under `<dshHome>/fs-observation-log/`, plus an in-memory mirror. Evidence
 * is advisory only — a healed observation is re-verified against the live
 * provider before it is re-emitted, so a lost, stale, or corrupt sidecar can
 * never authorize anything the stock fs-observation-policy would not.
 *
 * Sidecar filenames hash the full opaque session id (two ids that differ
 * only in separator spelling can never collide), and the first line of each
 * sidecar is a header record whose `id` is verified against the requested
 * session on load — a file whose header names another session is treated as
 * absent.
 *
 * Deliberately framework-free (plain node:fs) so it is unit-testable without
 * a Cordis context; the plugin wires it to events in src/index.ts.
 * @module dsh-fs-observation-log/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ObservationLogConfig } from './config.ts'

/** Header record: the sidecar's first line, carrying fork lineage (format v1). */
export interface HeaderRecord {
  hdr: 1
  /** The owning session id (verified against the requested session on load). */
  id: string
  /** The session this one was forked from; reserved for a future cut-bound healing scheme. */
  parent?: string
}

/** One persisted present-observation record (JSONL line payload, format v1). */
export interface EvidenceRecord {
  /** Sidecar format version; a reader skips unknown versions instead of guessing. */
  v: 1
  /** The provider's opaque stable target key (local backend: the realpath). */
  targetKey: string
  /** Model/UI-facing path kept for human inspection of the sidecar only. */
  displayPath: string
  /** The provider's opaque freshness token observed with the target. */
  version: string
  /** Epoch milliseconds when the observation was recorded. */
  at: number
}

/** Result of a lineage lookup: the evidence found and which session held it. */
export interface EvidenceHit {
  version: string
  sessionId: string
}

/** Parsed contents of one session sidecar. */
interface SidecarContents {
  header: HeaderRecord | undefined
  records: Map<string, EvidenceRecord>
  /** Data records physically present in the file (duplicates included); drives compaction. */
  physical: number
  /** A loaded file whose header named another session: append is forbidden, the next write rewrites. */
  orphaned: boolean
}

/**
 * Collision-free filename stem for a session id: the SHA-256 of the full
 * opaque id, hex-encoded. Session ids from different identity spaces can
 * differ only in characters a filesystem-safe sanitizer would fold together
 * (`a/b` vs `a_b`), so the hash is taken over the raw id, always.
 * @param id - the opaque session id.
 * @returns the fixed-length filename stem (`.jsonl` appended by the caller).
 */
export function sidecarFileId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex')
}

function isRecord(value: object): value is EvidenceRecord {
  const record = value as Partial<EvidenceRecord>
  return record.v === 1
    && typeof record.targetKey === 'string' && record.targetKey.length > 0
    && typeof record.version === 'string' && record.version.length > 0
}

/**
 * Parse one JSONL line into an {@link EvidenceRecord} or {@link HeaderRecord};
 * anything malformed or of an unknown format version yields `undefined`.
 * @param line - one raw line without the trailing newline.
 */
export function parseSidecarLine(line: string): EvidenceRecord | HeaderRecord | undefined {
  if (line.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  if ((parsed as Partial<HeaderRecord>).hdr === 1) {
    const header = parsed as Partial<HeaderRecord>
    if (typeof header.id !== 'string' || header.id.length === 0) return undefined
    return {
      hdr: 1,
      id: header.id,
      ...typeof header.parent === 'string' && header.parent.length > 0 ? { parent: header.parent } : {},
    }
  }
  if (!isRecord(parsed)) return undefined
  const record = parsed as EvidenceRecord
  return {
    v: 1,
    targetKey: record.targetKey,
    displayPath: typeof record.displayPath === 'string' ? record.displayPath : record.targetKey,
    version: record.version,
    at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
  }
}

/** Serialize a header or evidence record as one JSONL line (newline included). */
export function serializeSidecarLine(record: EvidenceRecord | HeaderRecord): string {
  return `${JSON.stringify(record)}\n`
}

/**
 * Session-keyed evidence store. One instance lives in the plugin's apply
 * closure; disposal just drops the mirror (the sidecars persist).
 */
export class ObservationStore {
  private readonly config: ObservationLogConfig
  private readonly dir: string
  /** sessionId → sidecar mirror; the authoritative copy of what the file holds. */
  private readonly mirrors = new Map<string, SidecarContents>()
  /** Sessions already loaded (or whose absence was established). */
  private readonly loaded = new Set<string>()
  private consecutiveWriteFailures = 0
  private disabled = false
  /** Per-session last record timestamp; bumped past Date.now() so same-millisecond records stay strictly ordered. */
  private readonly lastAt = new Map<string, number>()

  constructor(config: ObservationLogConfig, dir: string) {
    this.config = config
    this.dir = dir
  }

  private fileFor(sessionId: string): string {
    return join(this.dir, `${sidecarFileId(sessionId)}.jsonl`)
  }

  /** Idempotent lazy load of one session's sidecar into its mirror. */
  private ensureLoaded(sessionId: string): SidecarContents {
    let mirror = this.mirrors.get(sessionId)
    if (mirror !== undefined || this.loaded.has(sessionId)) {
      return mirror ?? { header: undefined, records: new Map(), physical: 0, orphaned: false }
    }
    this.loaded.add(sessionId)
    mirror = { header: undefined, records: new Map(), physical: 0, orphaned: false }
    try {
      const text = readFileSync(this.fileFor(sessionId), 'utf8')
      for (const line of text.split('\n')) {
        const parsed = parseSidecarLine(line)
        if (parsed === undefined) continue
        if ('hdr' in parsed) {
          if (mirror.header === undefined) mirror.header = parsed
        } else {
          mirror.records.set(parsed.targetKey, parsed)
          mirror.physical += 1
        }
      }
    } catch {
      // Absent sidecar (first observation for this session) or unreadable —
      // either way the mirror starts empty; evidence is advisory.
    }
    // Identity check: a file whose header names another session (wrong or
    // tampered filename) contributes nothing — the store treats it as absent.
    if (mirror.header !== undefined && mirror.header.id !== sessionId) {
      mirror = { header: undefined, records: new Map(), physical: 0, orphaned: true }
    }
    this.mirrors.set(sessionId, mirror)
    return mirror
  }

  /**
   * Look up one target in a session's own sidecar.
   * @param lineage - the acting session's lineage: the session itself.
   * @param targetKey - the opaque stable target key to look up.
   * @returns the hit, or undefined when the session never recorded the target.
   */
  lookup(lineage: readonly string[], targetKey: string): EvidenceHit | undefined {
    for (const sessionId of lineage) {
      const record = this.lookupIn(sessionId, targetKey)
      if (record !== undefined) return { version: record.version, sessionId }
    }
    return undefined
  }

  /** The in-memory mirror state for one target, if this session's sidecar holds it. */
  private lookupIn(sessionId: string, targetKey: string): EvidenceRecord | undefined {
    return this.ensureLoaded(sessionId).records.get(targetKey)
  }

  /**
   * Record one present observation: update the mirror and append one JSONL
   * line, writing the sidecar header first when the file is new. On physical
   * overflow (data lines, duplicates included, exceeding the cap) the file is
   * rewritten keeping the newest half by record time. Writes are fail-soft:
   * after `maxWriteFailures` consecutive failures the store disables itself
   * (the mirror keeps serving this process's healing).
   * @param sessionId - the observing session.
   * @param parentSessionId - the observing session's fork parent, when known;
   *   persisted in the header (reserved for a future cut-bound healing scheme).
   */
  record(sessionId: string, targetKey: string, displayPath: string, version: string, parentSessionId?: string): void {
    const mirror = this.ensureLoaded(sessionId)
    const previous = mirror.records.get(targetKey)
    // Strictly monotonic per session: same-millisecond records must not tie in
    // the compaction sort (a tie would fall back to insertion order and keep
    // the OLDEST half instead of the newest).
    const at = Math.max(Date.now(), (this.lastAt.get(sessionId) ?? 0) + 1)
    this.lastAt.set(sessionId, at)
    const record: EvidenceRecord = { v: 1, targetKey, displayPath, version, at }
    mirror.records.set(targetKey, record)
    const headerChanged = mirror.header === undefined || (mirror.header.parent === undefined && parentSessionId !== undefined)
    if (mirror.header === undefined) {
      mirror.header = {
        hdr: 1,
        id: sessionId,
        ...parentSessionId !== undefined ? { parent: parentSessionId } : {},
      }
    } else if (headerChanged && parentSessionId !== undefined) {
      mirror.header = { hdr: 1, id: sessionId, parent: parentSessionId }
    }
    if (this.disabled) return
    if (previous !== undefined && previous.version === record.version && !headerChanged) return
    const physicalAfterAppend = mirror.physical + 1
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.fileFor(sessionId)
      if (mirror.orphaned
        || physicalAfterAppend > this.config.maxEntriesPerSession
        || mirror.records.size > this.config.maxEntriesPerSession
        || (headerChanged && existsSync(file))) {
        // Full rewrite (physical or distinct-key compaction, or a late header
        // fix): keep the newest half by record time, header first; a temp-file
        // rename keeps it atomic.
        const kept = [...mirror.records.values()]
          .sort((a, b) => b.at - a.at)
          .slice(0, Math.max(1, Math.floor(this.config.maxEntriesPerSession / 2)))
        mirror.records = new Map(kept.map((entry) => [entry.targetKey, entry]))
        mirror.physical = kept.length
        const temp = `${file}.tmp`
        const body = kept.map(serializeSidecarLine).join('')
        writeFileSync(temp, mirror.header === undefined ? body : `${serializeSidecarLine(mirror.header)}${body}`, 'utf8')
        renameSync(temp, file)
      } else {
        appendFileSync(
          file,
          `${headerChanged && mirror.header !== undefined ? serializeSidecarLine(mirror.header) : ''}${serializeSidecarLine(record)}`,
          'utf8',
        )
        mirror.physical = physicalAfterAppend
      }
      this.consecutiveWriteFailures = 0
    } catch {
      this.consecutiveWriteFailures += 1
      if (this.consecutiveWriteFailures >= this.config.maxWriteFailures) this.disabled = true
    }
  }

  /** Test/diagnostic access to the fail-soft state. */
  get writeDisabled(): boolean {
    return this.disabled
  }
}
