/**
 * Store error taxonomy. Every failure carries a stable `OHMYMEMO_*` code so
 * callers (Phase 2 tools) can distinguish busy/CAS/refusal outcomes without
 * parsing messages.
 * @module dsh-ohmymemo/errors
 */

/** Store-level failure with a stable code. */
export class StoreError extends Error {
  readonly code: string
  /** Extra structured context (ids, revisions, holder identity — never bodies). */
  readonly detail: Record<string, unknown>

  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.detail = detail
  }
}

/** Bounded lock wait expired; never last-writer-wins. */
export class LockBusyError extends StoreError {
  constructor(holder: Record<string, unknown>, waitedMs: number) {
    super('OHMYMEMO_BUSY', `writer lock held by another process after ${waitedMs}ms wait`, { holder, waitedMs })
    this.name = 'LockBusyError'
  }
}
