/**
 * Settings-nav glyph injection engine.
 *
 * Why DOM work at all: the stock settings shell picks a nav glyph from a
 * hard-coded id table (`models`/`agent-presets`/`plugins`) and falls back to
 * the same generic gear for every other section — so 使用统计, MCP 和 记忆 all
 * render the same glyph, and `settings.section` carries no icon option to
 * register instead. Decorating the mounted row is the only lever a plugin has,
 * and it stays removable: everything this module writes is recorded and undone
 * on teardown.
 *
 * Robustness stance (the dsh-provider-balance / dsh-model-image-input
 * posture, fail-invisible and never fail-hostile): a row is identified by its
 * *live registered label* — read from the same `settings.section` ledger the
 * shell projects its nav from — matched against the nav row's own text. A
 * shell change that moves or renames any of that silences the decoration
 * instead of painting the wrong row, and a section that is not mounted is
 * skipped.
 *
 * @module dsh-settings-icons/inject
 */

/** One target row: its `settings.section` id and the mask to paint. */
export interface NavIconTarget {
  /** `settings.section` registration id. */
  id: string
  /** CSS `mask-image` value for the glyph. */
  mask: string
}

/** One projected nav row (the fields this package reads out of the ledger). */
export interface NavRow {
  /** Section id. */
  id: string
  /** The label the shell renders in the nav, already resolved to text. */
  label: string
}

/** Attribute marking a glyph element as painted by this package. */
const MARK = 'data-dsh-sicons'

/** Mask placement — the glyph box the shell already reserves (16x16). */
const MASK_LAYOUT: readonly (readonly [string, string])[] = [
  ['mask-repeat', 'no-repeat'],
  ['mask-position', 'center'],
  ['mask-size', '16px 16px'],
]

/**
 * Resolve one ledger label slot to text.
 * @param label - the registration's `label` option (string, thunk, or absent).
 * @returns the label text, or `''` when the slot carries none.
 */
function resolveLabel(label: unknown): string {
  if (typeof label === 'string') return label
  if (typeof label !== 'function') return ''
  try {
    const text = (label as () => unknown)()
    return typeof text === 'string' ? text : ''
  } catch {
    // A registrant's thunk is not ours to police: an unreadable label only
    // costs that row its glyph.
    return ''
  }
}

/**
 * Project raw `settings.section` registration options into nav rows.
 *
 * Only leaf fields are read (`id`, `label`): the options object belongs to the
 * live slot ledger, not to this package.
 * @param options - the ledger entries' `options` objects, in any order.
 * @returns the rows this engine can match, malformed entries dropped.
 */
export function projectRows(options: readonly unknown[]): readonly NavRow[] {
  const rows: NavRow[] = []
  for (const candidate of options) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as { id?: unknown, label?: unknown }
    if (typeof record.id !== 'string' || record.id === '') continue
    rows.push({ id: record.id, label: resolveLabel(record.label) })
  }
  return rows
}

/** What the engine needs from the apply world. */
export interface InjectionDeps {
  /** Live nav rows (re-read on every scan). */
  rows(): readonly NavRow[]
  /**
   * Coalesce a rescan (the caller owns the timer service).
   * @param fn - the rescan.
   * @returns a canceller for the pending call.
   */
  defer(fn: () => void): () => void
}

/**
 * Find the settings shell's nav rail.
 *
 * The stock modal is the one dialog declaring `role="dialog"` +
 * `aria-modal="true"` that owns a nav element with section buttons; anything
 * else is not our surface.
 * @returns the nav element, or `null` while the settings panel is closed.
 */
function findSettingsNav(): Element | null {
  for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
    const nav = dialog.querySelector('nav')
    if (nav !== null && nav.querySelector('button') !== null) return nav
  }
  return null
}

/**
 * Paint one glyph element with a target's mask.
 * @param svg - the shell's mounted glyph element.
 * @param target - the row's target.
 * @returns the undo record restoring the element exactly.
 */
function paint(svg: Element, target: NavIconTarget): () => void {
  const style = svg.getAttribute('style')
  const children = [...svg.children].map(child => [child, child.getAttribute('display')] as const)

  const declarations = ['background-color:currentColor']
  // Both spellings: the unprefixed mask properties are recent, and the
  // desktop shell may still be on a Chromium/WebKit build that only honours
  // -webkit-mask-*.
  for (const [property, value] of [['mask-image', target.mask], ...MASK_LAYOUT]) {
    declarations.push('-webkit-' + property + ':' + value)
    declarations.push(property + ':' + value)
  }
  // The element's own children are the stock glyph; they stay in the DOM (this
  // is a React-rendered node) and are hidden by presentation attribute instead.
  svg.setAttribute('style', declarations.join(';'))
  for (const child of svg.children) child.setAttribute('display', 'none')
  svg.setAttribute(MARK, target.id)

  return () => {
    svg.removeAttribute(MARK)
    if (style === null) svg.removeAttribute('style')
    else svg.setAttribute('style', style)
    for (const [child, display] of children) {
      if (display === null) child.removeAttribute('display')
      else child.setAttribute('display', display)
    }
  }
}

/**
 * Start the injection and return its disposer.
 * @param deps - the live row projection and the rescan scheduler.
 * @param targets - the rows to paint (defaults to the package's target table).
 * @returns the disposer: stops the observer and restores every painted row.
 */
export function startInjection(
  deps: InjectionDeps,
  targets: readonly NavIconTarget[],
): () => void {
  const painted = new Map<Element, () => void>()
  let nav: Element | null = null
  let cancelDeferred: (() => void) | undefined
  let stopped = false

  /** The nav rails survive their own re-renders, so only a detached one re-queries. */
  function currentNav(): Element | null {
    if (nav !== null && nav.isConnected) return nav
    nav = findSettingsNav()
    return nav
  }

  function scan(): void {
    // Drop records whose element React already replaced; their undo only
    // touches a detached node.
    for (const [svg, undo] of painted) {
      if (svg.isConnected) continue
      undo()
      painted.delete(svg)
    }
    const rail = currentNav()
    if (rail === null) return
    const buttons = [...rail.querySelectorAll('button')]
    const claimed = new Set<Element>()
    for (const target of targets) {
      const row = deps.rows().find(candidate => candidate.id === target.id)
      const label = row?.label.trim() ?? ''
      if (label === '') continue
      const button = buttons.find(candidate =>
        !claimed.has(candidate) && (candidate.textContent ?? '').trim() === label)
      if (button === undefined) continue
      claimed.add(button)
      const svg = button.querySelector('svg')
      if (svg === null || svg.getAttribute(MARK) === target.id) continue
      const previous = painted.get(svg)
      if (previous !== undefined) {
        previous()
        painted.delete(svg)
      }
      painted.set(svg, paint(svg, target))
    }
  }

  function schedule(): void {
    if (stopped) return
    cancelDeferred?.()
    cancelDeferred = deps.defer(scan)
  }

  scan()
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    stopped = true
    observer.disconnect()
    cancelDeferred?.()
    cancelDeferred = undefined
    for (const undo of painted.values()) undo()
    painted.clear()
    nav = null
  }
}
