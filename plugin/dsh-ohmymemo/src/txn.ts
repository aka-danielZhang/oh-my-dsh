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

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, posix } from 'node:path'
import { parse, stringify } from 'yaml'
import { ensureDir, hashFile, hashText, removeFileIfExists, writeFileAtomic } from './atomic.ts'
import { newTransactionId, TXN_ID_RE } from './ids.ts'
import { appendJournal, type JournalEntry } from './journal.ts'
import { journalPath, parseLocation } from './paths.ts'
import { deriveRecord, parseRecord, serializeRecord, type RecordDerive } from './schema.ts'
import type { Diagnostic } from './types.ts'

/** Transaction kinds the store issues. */
export type TxnAction = 'create' | 'candidate-create' | 'config-update' | 'update' | 'supersede' | 'promote' | 'forget' | 'candidate-expire' | 'memory-expire' | 'memory-merge'

/** Durable op shapes (as persisted in the marker — content-free). */
export type TxnOp =
  | { op: 'write'; path: string; before_hash?: string; after_hash: string }
  | { op: 'write-derived'; from: string; to: string; before_hash: string; after_hash: string; derive: RecordDerive }
  | { op: 'delete'; path: string; hash: string }
  | { op: 'journal'; entry: JournalEntry }

/** Live op shapes: the single in-memory `write` carries its content. */
export type LiveTxnOp =
  | { op: 'write'; path: string; content: string; before_hash?: string; after_hash: string }
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
  if (!isNormalizedRelativePath(relPath)) throw new Error(`unsafe transaction path: ${relPath}`)
  if (!existsSync(root)) ensureDir(root)
  const realRoot = realpathSync(root)
  const segments = relPath.split('/')
  let parent = realRoot
  for (const segment of segments) {
    parent = join(parent, segment)
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
      throw new Error(`transaction path crosses a symbolic link: ${relPath}`)
    }
  }
  return join(realRoot, ...segments)
}

/** Persist a marker (atomic, content-free). */
export function writeTxnMarker(root: string, marker: TransactionMarker): void {
  assertValidMarker(marker, `${marker.id}.yaml`)
  writeFileAtomic(toAbs(root, `.state/transactions/${marker.id}.yaml`), `${stringify(marker, { lineWidth: 0 })}`)
}

/** Remove a marker once the transaction is complete/rolled back. */
export function removeTxnMarker(root: string, id: string): void {
  if (!TXN_ID_RE.test(id)) throw new Error(`invalid transaction id: ${id}`)
  removeFileIfExists(toAbs(root, `.state/transactions/${id}.yaml`))
}

/** Read all markers present; damaged files stay put and surface as conflicts. */
export function readTxnMarkers(root: string): { markers: TransactionMarker[]; damaged: string[] } {
  const dir = toAbs(root, '.state/transactions')
  const markers: TransactionMarker[] = []
  const damaged: string[] = []
  if (!existsSync(dir)) return { markers, damaged }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue
    const abs = join(dir, entry.name)
    try {
      const raw = parse(readFileSync(abs, 'utf8')) as unknown
      assertValidMarker(raw, entry.name)
      markers.push(raw)
    } catch {
      damaged.push(entry.name)
    }
  }
  return { markers, damaged }
}

/** Strip live content from ops for persistence. */
function sanitizeOps(ops: LiveTxnOp[]): TxnOp[] {
  return ops.map((op) => {
    if (op.op === 'write') {
      return { op: 'write', path: op.path, ...(op.before_hash === undefined ? {} : { before_hash: op.before_hash }), after_hash: op.after_hash }
    }
    return op
  })
}

/** Derive the marker's audit targets from live ops. */
function deriveTargets(ops: Array<LiveTxnOp | TxnOp>): TransactionMarker['targets'] {
  const targets: TransactionMarker['targets'] = []
  for (const op of ops) {
    if (op.op === 'write') targets.push({ path: op.path, ...(op.before_hash === undefined ? {} : { before_hash: op.before_hash }), after_hash: op.after_hash })
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
  assertValidMarker(marker, `${id}.yaml`)
  for (const op of options.ops) {
    if (op.op === 'write') options.validateWrite?.(op.content)
  }
  // Preflight under the writer lock: every physical op must be strictly
  // 'not-done' before its marker exists. A stale before_hash or an unexpected
  // existing target then aborts with ZERO durable writes — no marker is left
  // behind, so a racing hand edit can never poison later mutations.
  for (const op of marker.ops.filter(op => op.op !== 'journal')) {
    if (opStatus(root, op) !== 'not-done') {
      throw new Error(`transaction target precondition failed before prepare (${op.op})`)
    }
  }

  ensureDir(toAbs(root, '.state/transactions'))
  writeTxnMarker(root, marker)

  const physical = options.ops.filter((op) => op.op !== 'journal')
  const journals = options.ops.filter((op): op is Extract<LiveTxnOp, { op: 'journal' }> => op.op === 'journal')
  let completedPhysical = 0
  try {
    for (const op of physical) {
      executeLiveOp(root, op, options.validateWrite)
      completedPhysical += 1
    }
  } catch (error) {
    if (completedPhysical === 0) removeTxnMarker(root, id)
    throw error
  }
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
    const current = hashFile(toAbs(root, op.path))
    if (op.before_hash !== undefined && current !== op.before_hash) {
      throw new Error(`transaction write target ${op.path} changed on disk (${String(current)} ≠ ${op.before_hash}) — refusing`)
    }
    if (op.before_hash === undefined && current !== undefined && current !== op.after_hash) {
      throw new Error(`transaction write target ${op.path} unexpectedly exists (${current}) — refusing`)
    }
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
  const toAbsPath = toAbs(root, op.to)
  const targetHash = hashFile(toAbsPath)
  if (targetHash === op.after_hash) return
  if (targetHash !== undefined) {
    throw new Error(`transaction derived-write target ${op.to} unexpectedly exists (${targetHash})`)
  }
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
  writeFileAtomic(toAbsPath, content)
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
    if (current === op.before_hash || (current === undefined && op.before_hash === undefined)) return 'not-done'
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

function assertValidMarker(raw: unknown, fileName: string): asserts raw is TransactionMarker {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ['schema', 'id', 'action', 'phase', 'targets', 'ops', 'created_at'])) {
    throw new Error('transaction marker must be a strict mapping')
  }
  const fileId = fileName.endsWith('.yaml') ? fileName.slice(0, -'.yaml'.length) : ''
  if (raw.schema !== MARKER_SCHEMA || typeof raw.id !== 'string' || !TXN_ID_RE.test(raw.id) || raw.id !== fileId) {
    throw new Error('transaction marker id must match its txn_<ulid>.yaml filename')
  }
  if (!['create', 'candidate-create', 'config-update', 'update', 'supersede', 'promote', 'forget', 'candidate-expire', 'memory-expire', 'memory-merge'].includes(String(raw.action))) {
    throw new Error('transaction marker has an invalid action')
  }
  if (raw.phase !== 'prepared' && raw.phase !== 'canonical-written' && raw.phase !== 'journaled') {
    throw new Error('transaction marker has an invalid phase')
  }
  if (!isIsoTimestamp(raw.created_at) || !Array.isArray(raw.ops) || raw.ops.length === 0 || !Array.isArray(raw.targets)) {
    throw new Error('transaction marker has invalid timestamp, ops, or targets')
  }
  for (const op of raw.ops) assertValidTxnOp(op)
  const expectedTargets = deriveTargets(raw.ops as TxnOp[])
  if (JSON.stringify(raw.targets) !== JSON.stringify(expectedTargets)) {
    throw new Error('transaction marker targets do not match its operations')
  }
}

function assertValidTxnOp(raw: unknown): asserts raw is TxnOp {
  if (!isPlainObject(raw) || typeof raw.op !== 'string') throw new Error('transaction op must be a mapping')
  if (raw.op === 'write') {
    if (!hasOnlyKeys(raw, ['op', 'path', 'before_hash', 'after_hash']) || !isTransactionTarget(raw.path, ['record', 'tombstone', 'store-config']) || !isHash(raw.after_hash) || !isOptionalHash(raw.before_hash)) {
      throw new Error('invalid transaction write op')
    }
    return
  }
  if (raw.op === 'write-derived') {
    if (!hasOnlyKeys(raw, ['op', 'from', 'to', 'before_hash', 'after_hash', 'derive']) || !isTransactionTarget(raw.from, ['record']) || !isTransactionTarget(raw.to, ['record']) || !isHash(raw.before_hash) || !isHash(raw.after_hash) || !isRecordDerive(raw.derive)) {
      throw new Error('invalid transaction derived-write op')
    }
    return
  }
  if (raw.op === 'delete') {
    if (!hasOnlyKeys(raw, ['op', 'path', 'hash']) || !isTransactionTarget(raw.path, ['record']) || !isHash(raw.hash)) {
      throw new Error('invalid transaction delete op')
    }
    return
  }
  if (raw.op === 'journal') {
    if (!hasOnlyKeys(raw, ['op', 'entry']) || !isJournalEntry(raw.entry)) throw new Error('invalid transaction journal op')
    return
  }
  throw new Error(`unknown transaction op: ${raw.op}`)
}

function isTransactionTarget(value: unknown, allowed: Array<'record' | 'tombstone' | 'store-config'>): value is string {
  if (typeof value !== 'string' || !isNormalizedRelativePath(value)) return false
  return allowed.includes(parseLocation(value).type as 'record' | 'tombstone' | 'store-config')
}

function isNormalizedRelativePath(value: string): boolean {
  return value.length > 0
    && !value.includes('\\')
    && !value.includes('\0')
    && !posix.isAbsolute(value)
    && posix.normalize(value) === value
    && value !== '..'
    && !value.startsWith('../')
}

function isRecordDerive(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['status', 'revision', 'updated_at', 'last_confirmed_at', 'confirmed'])) return false
  if (!isIsoTimestamp(value.updated_at)) return false
  if (value.status !== undefined && !['candidate', 'active', 'disputed', 'superseded', 'expired'].includes(String(value.status))) return false
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) return false
  if (value.last_confirmed_at !== undefined && !isIsoTimestamp(value.last_confirmed_at)) return false
  return value.confirmed === undefined || typeof value.confirmed === 'boolean'
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['at', 'action', 'txn_id', 'id', 'revision', 'scope', 'key', 'content_hash', 'old_hash', 'new_hash', 'path', 'source', 'reason'])) return false
  if (!isIsoTimestamp(value.at) || !['created', 'candidate-created', 'config-updated', 'updated', 'superseded', 'promoted', 'forgotten', 'candidate-rejected', 'candidate-expired', 'memory-expired', 'memory-refreshed', 'memory-merged', 'scope-created', 'external-edit-detected', 'external-removal', 'transaction-recovered', 'transaction-aborted'].includes(String(value.action))) return false
  if (value.txn_id !== undefined && (typeof value.txn_id !== 'string' || !TXN_ID_RE.test(value.txn_id))) return false
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) return false
  for (const field of ['id', 'scope', 'key', 'path', 'reason'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return false
  }
  for (const field of ['content_hash', 'old_hash', 'new_hash'] as const) {
    if (value[field] !== undefined && !isHash(value[field])) return false
  }
  if (value.source !== undefined) {
    if (!isPlainObject(value.source) || !hasOnlyKeys(value.source, ['session_id', 'event_seq'])) return false
    if (value.source.session_id !== undefined && typeof value.source.session_id !== 'string') return false
    if (value.source.event_seq !== undefined && !Number.isSafeInteger(value.source.event_seq)) return false
  }
  return true
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)
}

function isOptionalHash(value: unknown): boolean {
  return value === undefined || isHash(value)
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
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
