/**
 * Store health checks. `doctor()` aggregates scan-time findings (schema,
 * path, duplicate, single-key) with live structural checks: permissions,
 * dangling revision links, tombstone residue, leftover transactions and lock
 * state. Diagnostics never carry record bodies.
 * @module dsh-ohmymemo/doctor
 */

import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryCatalog } from './catalog.ts'
import { holderIsStale, readLockInfo } from './lock.ts'
import { WRITER_LOCK_REL } from './paths.ts'
import { transactionDiagnostics } from './txn.ts'
import type { Diagnostic } from './types.ts'

/** Inputs doctor needs beyond the catalog. */
export interface DoctorInput {
  root: string
  catalog: MemoryCatalog
  /** Scan/config diagnostics to fold in. */
  baseDiagnostics: Diagnostic[]
  /** Whether watching was requested (a degraded watcher is a warning). */
  watchRequested: boolean
  watchActive: boolean
  watchDegradedReason?: string
  /** Lock view of the observer (held = this process owns the writer lock). */
  lockHeldByUs: boolean
}

/** Run all checks. */
export function runDoctor(input: DoctorInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = [...input.baseDiagnostics]
  diagnostics.push(...permissionDiagnostics(input))
  diagnostics.push(...referenceDiagnostics(input.catalog))
  diagnostics.push(...tombstoneDiagnostics(input))
  diagnostics.push(...transactionDiagnostics(input.root))
  diagnostics.push(...lockDiagnostics(input))
  diagnostics.push(...watchDiagnostics(input))
  return diagnostics
}

/** Permission checks: root 0700, canonical files 0600 (warnings when looser). */
function permissionDiagnostics(input: DoctorInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  try {
    const mode = statSync(input.root).mode & 0o777
    if ((mode & 0o077) !== 0) {
      diagnostics.push({
        code: 'permissions-loose',
        severity: 'warning',
        message: `store root permissions ${mode.toString(8)} are broader than 0700`,
        path: input.root,
      })
    }
  } catch {
    diagnostics.push({ code: 'store-missing', severity: 'error', message: `store root ${input.root} is not accessible` })
    return diagnostics
  }
  let checked = 0
  for (const entry of input.catalog.entries().values()) {
    if (checked >= 200) break // sample cap keeps doctor cheap on huge stores
    checked += 1
    try {
      const mode = statSync(entry.absPath).mode & 0o777
      if ((mode & 0o177) !== 0o600 && (mode & 0o077) !== 0) {
        diagnostics.push({
          code: 'permissions-loose',
          severity: 'warning',
          message: `record file permissions ${mode.toString(8)} are broader than 0600`,
          path: entry.relPath,
        })
      }
    } catch {
      // Vanished between scan and doctor — the watcher will reconcile.
    }
  }
  return diagnostics
}

/** supersedes/contradicts referential integrity (warnings for dangling ids). */
function referenceDiagnostics(catalog: MemoryCatalog): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const ids = new Set(catalog.entries().keys())
  for (const entry of catalog.entries().values()) {
    for (const ref of entry.record.supersedes) {
      if (!ids.has(ref)) {
        diagnostics.push({
          code: 'dangling-supersedes',
          severity: 'warning',
          message: `record ${entry.record.id} supersedes ${ref}, which is not present`,
          id: entry.record.id,
        })
      }
    }
    for (const ref of entry.record.contradicts) {
      if (!ids.has(ref)) {
        diagnostics.push({
          code: 'dangling-contradicts',
          severity: 'warning',
          message: `record ${entry.record.id} contradicts ${ref}, which is not present`,
          id: entry.record.id,
        })
      }
    }
  }
  return diagnostics
}

/** Tombstone checks: body residue is an error; key re-import is informational. */
function tombstoneDiagnostics(input: DoctorInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  for (const tomb of input.catalog.tombstones().values()) {
    for (const memoryId of tomb.tombstone.memory_ids) {
      const entry = input.catalog.get(memoryId)
      if (entry !== undefined) {
        diagnostics.push({
          code: 'tombstone-body-residue',
          severity: 'error',
          message: `memory ${memoryId} has a tombstone but its body still exists at ${entry.relPath}`,
          id: memoryId,
          path: entry.relPath,
        })
      }
    }
  }
  // Possible re-import under a tombstoned key (only an explicit re-remember
  // may lift a barrier — surfaced, not enforced, at read time).
  for (const tomb of input.catalog.tombstones().values()) {
    const covered = new Set(tomb.tombstone.memory_ids)
    for (const entry of input.catalog.activeEntries()) {
      if (entry.record.scope !== tomb.tombstone.scope || entry.record.key !== tomb.tombstone.key) continue
      if (covered.has(entry.record.id)) continue
      diagnostics.push({
        code: 'tombstone-key-reimport',
        severity: 'info',
        message: `active record ${entry.record.id} shares tombstoned key ${tomb.tombstone.scope}/${tomb.tombstone.key} — verify it was an explicit re-remember`,
        id: entry.record.id,
      })
    }
  }
  return diagnostics
}

/** Lock checks: a present holder is stale (error) or alive (informational). */
function lockDiagnostics(input: DoctorInput): Diagnostic[] {
  const lockDir = join(input.root, ...WRITER_LOCK_REL.split('/'))
  const info = readLockInfo(lockDir)
  if (info === undefined) return []
  if (input.lockHeldByUs) {
    return [{ code: 'lock-held', severity: 'info', message: 'writer lock is held by this process' }]
  }
  if (holderIsStale(info)) {
    return [{
      code: 'stale-lock',
      severity: 'error',
      message: `writer lock holds a dead holder (pid ${info.pid}) and will be stolen on next acquire`,
      path: WRITER_LOCK_REL,
    }]
  }
  return [{ code: 'lock-held-elsewhere', severity: 'info', message: `writer lock currently held by pid ${info.pid}` }]
}

/** Watch checks. */
function watchDiagnostics(input: DoctorInput): Diagnostic[] {
  if (!input.watchRequested) return []
  if (input.watchActive) return []
  return [{
    code: 'watch-degraded',
    severity: 'warning',
    message: `file watching is inactive${input.watchDegradedReason !== undefined ? `: ${input.watchDegradedReason}` : ''} — external edits surface on next open`,
  }]
}
