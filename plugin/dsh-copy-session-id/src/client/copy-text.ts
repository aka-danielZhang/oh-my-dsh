/**
 * Clipboard copy for the Copy Session ID menu item.
 *
 * Two carriers, best-effort in order:
 * 1. `navigator.clipboard.writeText` — the modern async API (available on the
 *    secure-context origins DSH is served from);
 * 2. a hidden-textarea `document.execCommand('copy')` fallback for hosts
 *    where the async API is missing or rejects.
 *
 * Both hosts are injected structural slices so the resolution order is unit
 * testable without a browser.
 */

/** Structural slice of the async clipboard this module uses. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>
}

/** Structural slice of the textarea the legacy fallback drives. */
export interface LegacyTextarea {
  value: string
  style: { position: string; left: string }
  setAttribute(name: string, value: string): void
  select(): void
}

/** Structural slice of the document the legacy fallback drives. */
export interface LegacyDocument {
  createElement(tagName: string): LegacyTextarea
  body: { appendChild(node: LegacyTextarea): unknown; removeChild(node: LegacyTextarea): unknown }
  execCommand(commandId: string): boolean
}

/** Injected carriers for one copy gesture. */
export interface CopyDeps {
  readonly clipboard?: ClipboardWriter
  readonly document?: LegacyDocument
}

/**
 * The legacy execCommand carrier: select an offscreen textarea and copy.
 * @param text - the text to place on the clipboard.
 * @param doc - the document to drive (undefined = carrier unavailable).
 * @returns whether the command reported success.
 */
export function legacyCopyText(text: string, doc: LegacyDocument | undefined): boolean {
  if (doc === undefined) return false
  try {
    const textarea = doc.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    doc.body.appendChild(textarea)
    textarea.select()
    let ok = false
    try {
      ok = doc.execCommand('copy')
    } catch {
      ok = false
    }
    doc.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}

/**
 * Copy text through the best available carrier.
 * @param text - the text to copy.
 * @param deps - the carriers probed for this page.
 * @returns resolved when a carrier reported success; rejected otherwise.
 */
export function copyText(text: string, deps: CopyDeps): Promise<void> {
  if (deps.clipboard !== undefined) {
    return deps.clipboard.writeText(text).catch((error: unknown) => {
      if (!legacyCopyText(text, deps.document)) throw error
    })
  }
  if (legacyCopyText(text, deps.document)) return Promise.resolve()
  return Promise.reject(new Error('copy-session-id: no clipboard carrier'))
}

/**
 * Probe the browser carriers for this page (defensive: both globals are
 * optional so a non-DOM evaluation degrades to a rejected copy, not a crash).
 * @returns the carriers to hand {@link copyText}.
 */
export function browserCopyDeps(): CopyDeps {
  const clipboard =
    typeof navigator === 'undefined' || navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function'
      ? undefined
      : navigator.clipboard
  const doc = typeof document === 'undefined' ? undefined : (document as unknown as LegacyDocument)
  return { clipboard, document: doc }
}
