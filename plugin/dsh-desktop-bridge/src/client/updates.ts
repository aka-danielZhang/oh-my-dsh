/** Shared updater protocol types and pure decoding/formatting helpers. */

/** Release metadata returned by the updater check. */
export interface DesktopUpdateInfo {
  version: string
  notes: string
}

/** Process-wide updater snapshot exposed by the shell. */
export type DesktopUpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current' }
  | { phase: 'available'; version: string; notes: string }
  | { phase: 'preparing'; version?: string }
  | { phase: 'downloading'; version: string; downloaded: number; total?: number }
  | { phase: 'ready'; version: string; notes: string }
  | { phase: 'installing'; version: string }
  | { phase: 'restarting'; version: string }
  | { phase: 'failed'; version?: string; message: string }

/** IPC face consumed by the title-band updater control. */
export interface DesktopUpdaterInjected {
  /** Check the release endpoint; force bypasses the client single-flight memo. */
  checkUpdate: (force?: boolean) => Promise<DesktopUpdateInfo | null>
  /** Read the shell's process-wide progress snapshot. */
  getUpdateStatus: () => Promise<DesktopUpdateStatus>
  /** Shared browser generation used to discard stale replies. */
  updateGeneration: () => number
  /** Recheck, download, and verify the newest signed package. */
  downloadUpdate: () => Promise<void>
  /** Cancel the in-flight download; the shell status returns to available. */
  cancelUpdate: () => Promise<void>
  /** Install the verified package and restart the desktop process. */
  installUpdate: () => Promise<never>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Decode the narrow JSON snapshot without trusting arbitrary shell values. */
export function decodeUpdateStatus(value: unknown): DesktopUpdateStatus {
  const raw = record(value)
  if (raw === undefined) return { phase: 'failed', message: 'Unknown updater status' }
  const phase = raw.phase
  switch (phase) {
    case 'idle':
    case 'checking':
    case 'current':
      return { phase }
    case 'available':
      return { phase, version: text(raw.version, '?'), notes: text(raw.notes) }
    case 'preparing': {
      const version = typeof raw.version === 'string' ? raw.version : undefined
      return version === undefined ? { phase } : { phase, version }
    }
    case 'downloading': {
      const total = typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total > 0 ? raw.total : undefined
      return {
        phase,
        version: text(raw.version, '?'),
        downloaded: count(raw.downloaded),
        ...(total === undefined ? {} : { total }),
      }
    }
    case 'ready':
      return { phase, version: text(raw.version, '?'), notes: text(raw.notes) }
    case 'installing':
    case 'restarting':
      return { phase, version: text(raw.version, '?') }
    case 'failed': {
      const version = typeof raw.version === 'string' ? raw.version : undefined
      return {
        phase,
        ...(version === undefined ? {} : { version }),
        message: text(raw.message, 'Updater operation failed'),
      }
    }
    default:
      return { phase: 'failed', message: 'Unknown updater status' }
  }
}

/** Convert a check result into the same status shape used by progress polling. */
export function statusFromCheck(update: DesktopUpdateInfo | null): DesktopUpdateStatus {
  return update === null
    ? { phase: 'current' }
    : { phase: 'available', version: update.version, notes: update.notes }
}

/** Whether a check/download/install/restart currently owns the updater. */
export function isUpdateBusy(status: DesktopUpdateStatus): boolean {
  return status.phase === 'checking'
    || status.phase === 'preparing'
    || status.phase === 'downloading'
    || status.phase === 'installing'
    || status.phase === 'restarting'
}

/** Drop empty or historical placeholder copy so the dialog can stay quiet. */
export function visibleUpdateNotes(notes: string): string {
  const trimmed = notes.trim()
  if (trimmed.length === 0) return ''
  if (/^see the release page for notes\.?$/i.test(trimmed)) return ''
  return trimmed
}

/** Notes carried by available/ready snapshots; other phases have none. */
export function notesFromStatus(status: DesktopUpdateStatus): string {
  if (status.phase === 'available' || status.phase === 'ready') return status.notes
  return ''
}

/** Quiet title-band visibility: background failures remain silent. */
export function isUpdateIndicatorVisible(status: DesktopUpdateStatus): boolean {
  return status.phase === 'available' || status.phase === 'ready' || isUpdateBusy(status)
}

/** Integer percentage when the server reports a usable content length. */
export function updatePercent(status: DesktopUpdateStatus): number | undefined {
  if (status.phase !== 'downloading' || status.total === undefined) return undefined
  return Math.min(100, Math.round((status.downloaded / status.total) * 100))
}

/** Compact binary byte count for live progress copy. */
export function formatBytes(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (safe < 1024) return `${Math.round(safe)} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = safe / 1024
  let unit: typeof units[number] = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    const nextUnit = units[index]
    if (nextUnit === undefined) break
    value /= 1024
    unit = nextUnit
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`
}
