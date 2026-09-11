/**
 * The session-actions stylesheet, browser half.
 *
 * The anchor button mirrors the stock session-log-export `.moreButton` it
 * replaces (28px circle, 15px glyph, label-secondary, interactive hover) so
 * the takeover is pixel-neutral; the menu and status dialog are plain
 * hand-rolled surfaces (no ui-primitives value import — the client bundle
 * stays a zero-@deepseek-ai-value-import artifact).
 *
 * Semantic tokens only, with two deliberate exceptions documented inline.
 * @returns the stylesheet text.
 */
export function sessionActionsCss(): string {
  return [
    // Anchor: the stock moreButton it replaces, verbatim.
    '.dsh-csid-anchor {',
    '  display: inline-flex;',
    '  flex: none;',
    '  align-items: center;',
    '  justify-content: center;',
    '  width: 28px;',
    '  height: 28px;',
    '  padding: 6px;',
    '  color: var(--dsw-alias-label-secondary);',
    '  background: transparent;',
    '  border: none;',
    '  border-radius: 28px;',
    '  cursor: pointer;',
    '}',
    '.dsh-csid-anchor svg { width: 15px; height: 15px; }',
    '.dsh-csid-anchor:hover { background: var(--dsw-alias-interactive-bg-hover); }',
    '.dsh-csid-anchor[aria-expanded="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
    '.dsh-csid-anchor:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }',
    // Positioning context for the popover menu.
    '.dsh-csid-wrap { position: relative; display: inline-flex; flex: none; }',
    // Click-away veil: a transparent fixed button (not a div) so it stays out
    // of the tab order semantics while still swallowing the next click.
    '.dsh-csid-veil { position: fixed; inset: 0; z-index: 900; background: transparent; border: none; padding: 0; cursor: default; }',
    // The menu: a raised overlay surface hugging the anchor\'s right edge.
    '.dsh-csid-menu {',
    '  position: absolute;',
    '  top: calc(100% + 6px);',
    '  right: 0;',
    '  z-index: 901;',
    '  min-width: 200px;',
    '  padding: 4px;',
    '  border-radius: 10px;',
    '  background: var(--dsw-alias-bg-overlay);',
    '  border: 0.5px solid var(--dsw-alias-border-l1);',
    '  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25);',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: 1px;',
    '}',
    '.dsh-csid-item {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: 8px;',
    '  width: 100%;',
    '  padding: 7px 10px;',
    '  border: none;',
    '  border-radius: 7px;',
    '  background: transparent;',
    '  color: var(--dsw-alias-label-primary);',
    '  font: inherit;',
    '  font-size: 13px;',
    '  line-height: 1.4;',
    '  text-align: left;',
    '  cursor: pointer;',
    '  white-space: nowrap;',
    '}',
    '.dsh-csid-item:hover { background: var(--dsw-alias-bg-layer-2); }',
    '.dsh-csid-item:focus-visible { outline: 1.5px solid var(--dsw-alias-brand-primary); outline-offset: -1.5px; }',
    '.dsh-csid-item[disabled] { opacity: 0.45; cursor: default; }',
    '.dsh-csid-item[disabled]:hover { background: transparent; }',
    '.dsh-csid-item-icon { display: inline-flex; flex: none; opacity: 0.85; }',
    '.dsh-csid-item-icon svg { width: 15px; height: 15px; }',
    // Status dialog backdrop + card (re-hosts the stock export dialog).
    '.dsh-csid-backdrop { position: fixed; inset: 0; z-index: 920; background: rgba(0, 0, 0, 0.35); border: none; padding: 0; cursor: default; }',
    '.dsh-csid-dialog {',
    '  position: fixed;',
    '  z-index: 921;',
    '  top: 50%;',
    '  left: 50%;',
    '  transform: translate(-50%, -50%);',
    '  width: min(360px, calc(100vw - 48px));',
    '  padding: 18px 18px 14px;',
    '  border-radius: 12px;',
    '  background: var(--dsw-alias-bg-overlay);',
    '  border: 0.5px solid var(--dsw-alias-border-l1);',
    '  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);',
    '  color: var(--dsw-alias-label-primary);',
    '  font: inherit;',
    '}',
    '.dsh-csid-dialog-title { margin: 0 0 6px; font-size: 14px; font-weight: 600; }',
    '.dsh-csid-dialog-desc { margin: 0 0 14px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); word-break: break-all; }',
    '.dsh-csid-dialog-foot { display: flex; justify-content: flex-end; }',
    '.dsh-csid-dialog-close {',
    '  padding: 5px 14px;',
    '  border: 0.5px solid var(--dsw-alias-border-l2);',
    '  border-radius: 8px;',
    '  background: transparent;',
    '  color: var(--dsw-alias-label-primary);',
    '  font: inherit;',
    '  font-size: 13px;',
    '  cursor: pointer;',
    '}',
    '.dsh-csid-dialog-close:hover { background: var(--dsw-alias-bg-layer-2); }',
    '',
  ].join('\n')
}

/** Structural slice of a style element the installer touches (test-friendly). */
export interface InstalledStyle {
  readonly dataset: Record<string, string>
  setAttribute(name: string, value: string): void
  textContent: string | null
  remove(): void
}

/** Structural slice of Document the installer touches (test-friendly). */
export interface StylesheetHost {
  querySelector(selectors: string): unknown
  createElement(tagName: string): InstalledStyle
  head: { append(...nodes: unknown[]): void }
}

/**
 * Append the session-actions stylesheet to a document head.
 *
 * Pre-claimed with `data-plugin`/`data-plugin-css` (the stock build-time CSS
 * emission convention) and dedup-guarded: the client module system's
 * `claimStyles` attributes every UNTAGGED `<style>` to whichever plugin
 * materializes next, and that plugin's next HMR reload deletes the claimed
 * sheet (the 2026-09-08 bridge incident). A claimed tag is only touched by a
 * rebuild of THIS plugin, whose reload re-inserts the sheet anyway.
 * @param doc - the document to style (injected for tests).
 * @returns the disposer removing the style element (no-op when deduped).
 */
export function installSessionActionsCss(doc: StylesheetHost): () => void {
  const tagId = 'dsh-copy-session-id/session-actions'
  if (doc.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
  const style = doc.createElement('style')
  style.setAttribute('data-dsh-copy-session-id', '')
  style.dataset.plugin = 'dsh-copy-session-id'
  style.dataset.pluginCss = tagId
  style.textContent = sessionActionsCss()
  doc.head.append(style)
  return () => { style.remove() }
}
