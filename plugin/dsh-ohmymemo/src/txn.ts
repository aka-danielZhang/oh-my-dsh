/**
 * Multi-file mutation transactions with crash recovery.
 *
 * A mutation that touches more than one file (forget, supersede, promote)
 * first writes a durable marker into `.state/transactions/`, then executes
 * an ordered list of primitive ops. Recovery classifies each op by comparing
 * current disk hashes against the marker — never by wall clock:
 *
 * - all ops done → the marker is removed (commit was complete),
 * - no op done   → rollback: nothing reached disk, remove the marker,
 * - partially    → resume forward from the first incomplete op; every
 *   remaining op is executable from disk state alone (moves/deletes/derived
 *   writes), except an incomplete in-memory `write` that follows completed
 *   work — that is a conflict the store reports and refuses to guess at.
 *
 * Markers never carry record bodies; `write` ops persist only hashes, and
 * the body is re-derivable from disk for every other op kind.
 * @module dsh-ohmymemo/txn
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { ensureDir, hashFile, hashText, removeFileIfExists, writeFileAtomic } from './atomic.ts'
import { newTransactionId } from './ids.ts'
import { appendJournal, type JournalEntry } from './journal.ts'
import { journalPath } from './paths.ts'
import { deriveRecord, parseRecord, serializeRecord, type RecordDerive } from './schema.ts'
import type { Diagnostic } from './types.ts'

/** Transaction kinds the store issues. */
export type TxnAction = 'create' | 'update' | 'supersede' | 'promote' | 'forget'

/** Durable op shapes (as persisted in the marker — content-free). */
export type TxnOp =
  | { op: 'write'; path: string; after_hash: string }
  | { op: 'write-derived'; from: string; to: string; before_hash: string; after_hash: string; derive: RecordDerive }
  | { op: 'delete'; path: string; hash: string }
  | { op: 'journal'; entry: JournalEntry }

/** Live op shapes: the single in-memory `write` carries its content. */
export type LiveTxnOp =
  | { op: 'write'; path: string; content: string; after_hash: string }
  | Extract<TxnOp, { op: 'write-derived' }>
  | Extract<TxnOp, { op: 'delete' }>
  | Extract<TxnOp, { op: 'journal' }>

/** Marker as persisted. */
export interface TransactionMarker {
  schema: 'ohmymemo-transaction/v1'
  id: string
  action: TxnAction
  phase: 'prepared' | 'canonical-written' | 'journaled'
  targets: Array<{ path: string; before_hash?: string; after_hash?: string }>
  ops: TxnOp[]
  created_at: string
}

/** Per-op progress against current disk state. */
type OpStatus = 'done' | 'not-done' | 'conflict'

/** Outcome of recovering every marker found on disk. */
export interface RecoveryReport {
  finalized: string[]
  aborted: string[]
  recovered: string[]
  conflicts: Array<{ id: string; message: string }>
}

const MARKER_SCHEMA = 'ohmymemo-transaction/v1'

export function toAbs(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'))
}

/** Persist a marker (atomic, content-free). */
export function writeTxnMarker(root: string, marker: TransactionMarker): void {
  writeFileAtomic(toAbs(root, `.state/transactions/${marker.id}.yaml`), `${stringify(marker, { lineWidth: 0 })}`)
}

/** Remove a marker once the transaction is complete/rolled back. */
export function removeTxnMarker(root: string, id: string): void {
  removeFileIfExists(toAbs(root, `.state/transactions/${id}.yaml`))
}

/** Read all markers present; damaged files stay put and surface as conflicts. */
export function readTxnMarkers(root: string): { markers: TransactionMarker[]; damaged: string[] } {
  const dir = join(root, '.state', 'transactions')
  const markers: TransactionMarker[] = []
  const damaged: string[] = []
  if (!existsSync(dir)) return { markers, damaged }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
    const abs = join(dir, entry.name)
    try {
      const raw = parse(readFileSync(abs, 'utf8')) as Record<string, unknown>
      if (raw.schema !== MARKER_SCHEMA || !Array.isArray(raw.ops)) {
        damaged.push(entry.name)
        continue
      }
      markers.push(raw as unknown as TransactionMarker)
    } catch {
      damaged.push(entry.name)
    }
  }
  return { markers, damaged }
}

/** Strip live content from ops for persistence. */
function sanitizeOps(ops: LiveTxnOp[]): TxnOp[] {
  return ops.map((op) => {
    if (op.op === 'write') return { op: 'write', path: op.path, after_hash: op.after_hash }
    return op
  })
}

/** Derive the marker's audit targets from live ops. */
function deriveTargets(ops: LiveTxnOp[]): TransactionMarker['targets'] {
  const targets: TransactionMarker['targets'] = []
  for (const op of ops) {
    if (op.op === 'write') targets.push({ path: op.path, after_hash: op.after_hash })
    else if (op.op === 'write-derived') targets.push({ path: op.to, before_hash: op.before_hash, after_hash: op.after_hash })
    else if (op.op === 'delete') targets.push({ path: op.path, before_hash: op.hash })
  }
  return targets
}

/** Options for one transaction run. */
export interface RunTxnOptions {
  action: TxnAction
  ops: LiveTxnOp[]
  /** Content gate applied to published canonical text (parse-back validation). */
  validateWrite?: (content: string) => void
}

/**
 * Run one transaction: durable marker → ordered ops (with phase updates) →
 * marker removal. Throws on any execution failure; the marker stays behind
 * for the next recovery pass.
 */
export function runTransaction(root: string, options: RunTxnOptions, now = (): Date => new Date()): string {
  const id = newTransactionId()
  const marker: TransactionMarker = {
    schema: MARKER_SCHEMA,
    id,
    action: options.action,
    phase: 'prepared',
    targets: deriveTargets(options.ops),
    ops: sanitizeOps(options.ops),
    created_at: now().toISOString(),
  }
  ensureDir(join(root, '.state', 'transactions'))
  writeTxnMarker(root, marker)

  const physical = options.ops.filter((op) => op.op !== 'journal')
  const journals = options.ops.filter((op): op is Extract<LiveTxnOp, { op: 'journal' }> => op.op === 'journal')
  for (const op of physical) executeLiveOp(root, op, options.validateWrite)
  marker.phase = 'canonical-written'
  writeTxnMarker(root, marker)
  for (const op of journals) executeJournalOp(root, op.entry)
  marker.phase = 'journaled'
  writeTxnMarker(root, marker)
  removeTxnMarker(root, id)
  return id
}

function executeLiveOp(root: string, op: LiveTxnOp, validate?: (content: string) => void): void {
  if (op.op === 'write') {
    writeFileAtomic(toAbs(root, op.path), op.content, { validate })
    return
  }
  if (op.op === 'write-derived') {
    executeWriteDerived(root, op)
    return
  }
  if (op.op === 'delete') {
    const current = hashFile(toAbs(root, op.path))
    if (current !== undefined && current !== op.hash) {
      throw new Error(`transaction delete target ${op.path} changed on disk (${current} ≠ ${op.hash}) — refusing`)
    }
    removeFileIfExists(toAbs(root, op.path))
    return
  }
}

/** Read `from`, apply the deterministic derive, publish at `to` (used live and in recovery). */
export function executeWriteDerived(root: string, op: Extract<TxnOp, { op: 'write-derived' }>): void {
  const fromAbs = toAbs(root, op.from)
  const text = readFileSync(fromAbs, 'utf8')
  const { record } = parseRecord(text)
  if (record === undefined) {
    throw new Error(`transaction derived-write source ${op.from} is not a valid record`)
  }
  if (hashText(text) !== op.before_hash) {
    throw new Error(`transaction derived-write source ${op.from} hash mismatch — disk changed`)
  }
  const derived = deriveRecord(record, op.derive)
  const content = serializeRecord(derived)
  if (hashText(content) !== op.after_hash) {
    throw new Error(`transaction derived-write for ${op.to} produced unexpected content`)
  }
  writeFileAtomic(toAbs(root, op.to), content)
}

/** Append a journal entry exactly once per transaction (dedupe by line). */
function executeJournalOp(root: string, entry: JournalEntry): void {
  if (journalHasLine(root, entry)) return
  appendJournal(root, entry)
}

function journalHasLine(root: string, entry: JournalEntry): boolean {
  const rel = journalPath(entry.at)
  if (rel === undefined) return false
  const abs = toAbs(root, rel)
  if (!existsSync(abs)) return false
  const line = `${JSON.stringify(entry)}`
  return readFileSync(abs, 'utf8').split('\n').includes(line)
}

/** Classify one durable op against current disk state. */
function opStatus(root: string, op: TxnOp): OpStatus {
  if (op.op === 'write') {
    const current = hashFile(toAbs(root, op.path))
    if (current === op.after_hash) return 'done'
    if (current === undefined) return 'not-done'
    return 'conflict'
  }
  if (op.op === 'write-derived') {
    if (hashFile(toAbs(root, op.to)) === op.after_hash) return 'done'
    if (hashFile(toAbs(root, op.from)) === op.before_hash) return 'not-done'
    return 'conflict'
  }
  if (op.op === 'delete') {
    const current = hashFile(toAbs(root, op.path))
    if (current === undefined) return 'done'
    if (current === op.hash) return 'not-done'
    return 'conflict'
  }
  // journal: done exactly when its line already exists.
  return journalHasLine(root, op.entry) ? 'done' : 'not-done'
}

/**
 * Recover every marker present on disk. Must run under the writer lock.
 * Damaged markers and hash conflicts stay in place and are reported — the
 * store never guesses over unexplained disk state.
 */
export function recoverTransactions(root: string, now = (): Date => new Date()): RecoveryReport {
  const report: RecoveryReport = { finalized: [], aborted: [], recovered: [], conflicts: [] }
  const { markers, damaged } = readTxnMarkers(root)
  for (const name of damaged) {
    report.conflicts.push({ id: name, message: 'unreadable transaction marker left in place' })
  }
  for (const marker of markers) {
    try {
      recoverOne(root, marker, report, now)
    } catch (error) {
      report.conflicts.push({ id: marker.id, message: `recovery failed: ${(error as Error).message}` })
    }
  }
  return report
}

function recoverOne(root: string, marker: TransactionMarker, report: RecoveryReport, now: () => Date): void {
  const statuses = marker.ops.map((op) => opStatus(root, op))
  const conflictIndex = statuses.indexOf('conflict')
  if (conflictIndex !== -1) {
    report.conflicts.push({ id: marker.id, message: `op ${conflictIndex} (${marker.ops[conflictIndex]?.op}) disagrees with disk hashes` })
    return
  }
  const firstIncomplete = statuses.indexOf('not-done')
  if (firstIncomplete === -1) {
    removeTxnMarker(root, marker.id)
    report.finalized.push(marker.id)
    return
  }
  const anyDone = statuses.some((status) => status === 'done')
  if (!anyDone) {
    removeTxnMarker(root, marker.id)
    appendJournal(root, { at: now().toISOString(), action: 'transaction-aborted', txn_id: marker.id, reason: `nothing written before interruption (${marker.action})` })
    report.aborted.push(marker.id)
    return
  }
  if (statuses.slice(firstIncomplete + 1).some((status) => status === 'done')) {
    report.conflicts.push({ id: marker.id, message: 'completed op follows an incomplete op — unexpected ordering' })
    return
  }
  const incomplete = marker.ops[firstIncomplete]
  if (incomplete === undefined || incomplete.op === 'write') {
    report.conflicts.push({ id: marker.id, message: 'in-memory write op lost its content across the crash' })
    return
  }
  for (const op of marker.ops.slice(firstIncomplete)) {
    if (op.op === 'write') {
      report.conflicts.push({ id: marker.id, message: 'in-memory write op lost its content across the crash' })
      return
    }
    if (op.op === 'write-derived') executeWriteDerived(root, op)
    else if (op.op === 'delete') executeLiveOp(root, op)
    else executeJournalOp(root, op.entry)
  }
  appendJournal(root, { at: now().toISOString(), action: 'transaction-recovered', txn_id: marker.id, reason: marker.action })
  removeTxnMarker(root, marker.id)
  report.recovered.push(marker.id)
}

/** Diagnostics for markers still present (surfaced by doctor). */
export function transactionDiagnostics(root: string): Diagnostic[] {
  const { markers, damaged } = readTxnMarkers(root)
  const diagnostics: Diagnostic[] = damaged.map((name) => ({
    code: 'transaction-unfinished',
    severity: 'error',
    message: `unreadable transaction marker ${name} needs manual attention`,
    path: `.state/transactions/${name}`,
  }))
  for (const marker of markers) {
    diagnostics.push({
      code: 'transaction-unfinished',
      severity: 'error',
      message: `transaction ${marker.id} (${marker.action}) not recovered — writer lock or doctor required`,
      path: `.state/transactions/${marker.id}.yaml`,
    })
  }
  return diagnostics
}
