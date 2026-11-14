/**
 * A real JSONL session persistence backend for the eval harness: the exact
 * `sessionPersistence` seam the AgentLoop expects (create/open/stat + handles
 * with append/read/flush/close), backed by one JSONL file per session under
 * the scratch home.
 *
 * With this mounted, sessions are DURABLE across eval crash/restart steps:
 * transport dedupe, executor reconcile, outbox reconciliation and resume all
 * read the same log a production backend would serve. Each append writes
 * synchronously, so the flush barrier is honestly satisfied.
 *
 * @module dsh-quno/evals/persistence
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface StoredEvent {
  readonly seq: number
  readonly time?: number
  readonly type: string
  readonly data: unknown
}

/** One open channel onto a stored session (SessionHandle shape). */
class JsonlHandle {
  readonly id: string
  readonly header: unknown
  readonly inheritedEventCount = 0
  readonly access: 'read' | 'write'
  private closed = false

  constructor(private readonly file: string, header: unknown, id: string, access: 'read' | 'write') {
    this.header = structuredClone(header)
    this.id = id
    this.access = access
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`session handle ${this.id} is closed`)
  }

  async read(offset = 0, length?: number): Promise<{ eventState: 'shared-frozen'; events: readonly StoredEvent[] }> {
    this.assertOpen()
    const events = loadEvents(this.file)
    const start = Math.max(0, offset)
    const slice = length === undefined ? events.slice(start) : events.slice(start, start + length)
    return { eventState: 'shared-frozen', events: structuredClone(slice) }
  }

  async append(events: readonly StoredEvent[]): Promise<void> {
    this.assertOpen()
    if (this.access !== 'write') throw new Error('session handle is read-only')
    if (events.length === 0) return
    appendFileSync(this.file, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
  }

  /** Appends persist synchronously; the barrier only materializes the file. */
  async flush(): Promise<void> {
    this.assertOpen()
    if (!existsSync(this.file)) writeFileSync(this.file, '', 'utf8')
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** The persistence service (SessionPersistence shape). */
export class JsonlSessionPersistence {
  private readonly dir: string
  /** Sessions whose write handle exists in this process (single-writer). */
  private readonly writers = new Set<string>()

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  private fileOf(id: string): string {
    return join(this.dir, `${encodeURIComponent(String(id))}.jsonl`)
  }

  async stat(id: string): Promise<{ header: unknown; revision: string; sizeBytes: number } | undefined> {
    const file = this.fileOf(id)
    if (!existsSync(file)) return undefined
    const lines = readLines(file)
    const header = (lines[0] as HeaderLine | undefined)?.header
    return {
      header,
      revision: `jsonl:${String(lines.length - 1)}`,
      sizeBytes: statSync(file).size,
    }
  }

  async create(id: string, header: unknown): Promise<JsonlHandle> {
    const file = this.fileOf(id)
    if (existsSync(file)) throw new Error(`session "${String(id)}" already exists`)
    writeFileSync(file, `${JSON.stringify({ kind: 'header', header })}\n`, 'utf8')
    this.writers.add(String(id))
    return new JsonlHandle(file, header, String(id), 'write')
  }

  async open(id: string, access: 'read' | 'write'): Promise<JsonlHandle> {
    const file = this.fileOf(id)
    if (!existsSync(file)) {
      // Write access auto-materializes a fresh session: the executor's
      // create-failure fallback resumes by identity, and a missing log must
      // not wedge the launch Effect behind 'is not stored' (found by
      // live-status-result: the launch died on this error).
      if (access === 'write') return await this.create(id, { id })
      throw new Error(`session "${String(id)}" is not stored`)
    }
    const lines = readLines(file)
    const header = (lines[0] as HeaderLine | undefined)?.header ?? {}
    if (access === 'write' && this.writers.has(String(id))) {
      throw new Error(`session "${String(id)}" is already owned by this backend instance`)
    }
    if (access === 'write') this.writers.add(String(id))
    return new JsonlHandle(file, header, String(id), access)
  }

  /**
   * Live-event write path: the persistence backend owns live storage (the loop
   * only stores the pre-publication suffix through the handle). Disjoint from
   * handle appends — constructor seed and resume closers never re-emit here.
   */
  appendEvent(id: string, event: StoredEvent): void {
    const file = this.fileOf(id)
    if (!existsSync(file)) {
      writeFileSync(file, `${JSON.stringify({ kind: 'header', header: { id } })}\n`, 'utf8')
    }
    appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8')
  }

  /**
   * Release this process's write ownership (crash/restart steps). The eval
   * harness stops the whole composition before a restart, so re-opening is
   * always safe here — unlike a production backend, where ownership follows
   * the live handle.
   */
  releaseWriters(): void {
    this.writers.clear()
  }

  /** Every session id stored under this backend (evidence export). */
  sessionIds(): string[] {
    return readdirSync(this.dir)
      .filter(file => file.endsWith('.jsonl'))
      .map(file => decodeURIComponent(file.slice(0, -'.jsonl'.length)))
  }

  /** Full read face for `sessionQuery.readSession`. */
  readAll(id: string): readonly StoredEvent[] {
    const file = this.fileOf(id)
    if (!existsSync(file)) return []
    return loadEvents(file)
  }
}

interface HeaderLine {
  readonly kind: 'header'
  readonly header: unknown
}

function readLines(file: string): (HeaderLine | StoredEvent)[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as HeaderLine | StoredEvent)
}

function loadEvents(file: string): readonly StoredEvent[] {
  return readLines(file).filter((line): line is StoredEvent => (line as StoredEvent).seq !== undefined)
}
