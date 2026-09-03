/**
 * The stop-while-running stylesheet, browser half.
 *
 * The Stop button mirrors ui-conversation's composer `.primary` circle (34px,
 * white glyph, -2px optical lift out of the row's top pad) in the same toned
 * danger-red as the global Stop recolor below. Positioning uses only
 * documented seams:
 *
 * - `[data-slot="conversation.input.right"]` — the render machinery's
 *   addressable anchor for this slot (every render site exposes it).
 * - `button:last-of-type` — the stock primary button, which is always the
 *   last direct button child of the trailing row (the model seat and the
 *   context meter render inside their own wrappers; a subagent's separate
 *   Stop never coexists with this button's visibility terms).
 *
 * Rules:
 * - Ordering (`order: 1` / `:has()`-scoped `order: 2`) lands the pair as
 *   [model][meter][stop][send] and only applies while this button is
 *   mounted; every other state keeps the shipped layout untouched.
 * - The button is danger-red in EVERY state it renders (it IS a stop):
 *   light theme red-500 (coral) base / red-400 hover; dark theme red-400
 *   base with a brightness-step hover — the same shades as the global
 *   recolor below, so the two stops never read differently.
 * - The global Stop recolor (below) is UNCHANGED from 0.1.1: every
 *   stop-shaped button in the trailing row is danger-red in every state,
 *   anchored on the glyph (`svg > rect`) so it follows the stock machine
 *   for free. This button is NOT matched by it (it renders inside the slot
 *   wrapper, not as a direct button child of the trailing row), so it
 *   carries its own explicit red.
 *
 * Semantic tokens only, with deliberate exceptions documented inline.
 * @returns the stylesheet text.
 */
export function stopWhileRunningCss(): string {
  return [
    '.dsh-stop-while-running {',
    '  display: grid;',
    '  place-items: center;',
    '  flex: none;',
    '  width: 34px;',
    '  height: 34px;',
    '  border: none;',
    '  border-radius: 999px;',
    '  background: var(--dsw-static-red-500);',
    '  /* Static white, not the foreground token: mirrors the stock primary —',
    '     the glyph stays white on the red fill in both themes. */',
    '  color: #fff;',
    '  cursor: pointer;',
    '  transition: background-color 100ms ease;',
    '  /* Opts out of the row\'s 2px downward shift, like the stock primary. */',
    '  transform: translateY(-2px);',
    '  order: 1;',
    '}',
    // Light theme: red-500 base, hover steps one shade lighter (red-400) like
    // the stock info button steps.
    '.dsh-stop-while-running:hover {',
    '  background: var(--dsw-static-red-400);',
    '}',
    // Dark theme: red-400 base (softer than red-500 on dark surfaces); hover
    // lightens via a brightness step instead of another token (the static red
    // scale has no shade between 400 and the near-white 100).
    'body[data-ds-dark-theme] .dsh-stop-while-running {',
    '  background: var(--dsw-static-red-400);',
    '}',
    'body[data-ds-dark-theme] .dsh-stop-while-running:hover {',
    '  background: var(--dsw-static-red-500);',
    '  filter: brightness(1.08);',
    '}',
    // Push the stock primary (Send) to the right only while this button is
    // mounted; the anchor chain is the slot seam plus our own class.
    'div:has(> [data-slot="conversation.input.right"] .dsh-stop-while-running) > button:last-of-type {',
    '  order: 2;',
    '}',
    // Stop = danger-red in EVERY state, anchored on the stop glyph (<rect>;
    // the send glyph is a <path> so the blue Send state never matches). The
    // selector is scoped to the composer trailing row through the slot seam.
    // Unchanged from 0.1.1 — this is the user preference that makes every
    // stock stop (primary flip, subagent's separate Stop) read as red.
    'div:has(> [data-slot="conversation.input.right"]) > button:has(> svg > rect) {',
    '  background: var(--dsw-static-red-500);',
    '  color: #fff;',
    '}',
    'div:has(> [data-slot="conversation.input.right"]) > button:has(> svg > rect):hover:not(:disabled) {',
    '  background: var(--dsw-static-red-400);',
    '}',
    'body[data-ds-dark-theme] div:has(> [data-slot="conversation.input.right"]) > button:has(> svg > rect) {',
    '  background: var(--dsw-static-red-400);',
    '}',
    'body[data-ds-dark-theme] div:has(> [data-slot="conversation.input.right"]) > button:has(> svg > rect):hover:not(:disabled) {',
    '  background: var(--dsw-static-red-500);',
    '  filter: brightness(1.08);',
    '}',
    '',
  ].join('\n')
}

/** Structural slice of a style element the installer touches (test-friendly). */
export interface InstalledStyle {
  setAttribute(name: string, value: string): void
  textContent: string | null
  remove(): void
}

/** Structural slice of Document the installer touches (test-friendly). */
export interface StylesheetHost {
  createElement(tagName: string): InstalledStyle
  head: { append(...nodes: unknown[]): void }
}

/**
 * Append the stop-while-running stylesheet to a document head.
 * @param doc - the document to style (injected for tests).
 * @returns the disposer removing the style element.
 */
export function installStopWhileRunningCss(doc: StylesheetHost): () => void {
  const style = doc.createElement('style')
  style.setAttribute('data-dsh-stop-while-running', '')
  style.textContent = stopWhileRunningCss()
  doc.head.append(style)
  return () => { style.remove() }
}
