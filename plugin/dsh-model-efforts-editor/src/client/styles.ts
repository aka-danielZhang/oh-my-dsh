/**
 * One style element for the effort editor's UI, inserted on mount and
 * removed on unmount. Everything is `.mee-` scoped; colors come only from
 * the `--dsw-alias-*` / `--dsw-shadow-*` semantic tokens so dark/light
 * themes ride along. Native form controls are restyled or hidden — the
 * previous `--dsw-text-*` / `--dsw-bg-elevated` names were not real tokens
 * and fell back to OS checkboxes on a hard-coded dark card.
 */

/** Popup width, shared with the placement math in inject. */
export const POP_WIDTH = 280

/** The injected stylesheet text. */
export const SECTION_CSS = [
  // The stock model row is a fixed 4-column grid; every injected button is an
  // extra child no hardcoded column count can foresee (this plugin and the
  // image-input plugin decorate the same row). Flex fits any button count:
  // inputs keep the stock 1.4:1 share of the leftover width and shrink first,
  // so the trailing buttons never overflow the card and the trash never wraps
  // onto an implicit second grid row.
  '.mee-grid { display: flex !important; align-items: center; gap: 6px; }',
  '.mee-grid > input { flex: 1 1 0; min-width: 0; }',
  '.mee-grid > input:first-child { flex-grow: 1.4; }',
  'button.mee-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }',
  'button.mee-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
  'button.mee-btn[data-on="1"] { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-hover); }',
  '.mee-pop { position: fixed; z-index: 1000; width: ' + String(POP_WIDTH) + 'px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto; box-sizing: border-box; padding: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; box-shadow: var(--dsw-shadow-lv3); font: inherit; font-size: 12px; line-height: 16px; }',
  '.mee-pop, .mee-pop * { box-sizing: border-box; }',
  '.mee-pop button { appearance: none; font: inherit; }',
  '.mee-pop-head { display: flex; flex-direction: column; gap: 1px; padding: 6px 8px 8px; min-width: 0; }',
  '.mee-pop-title { overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 16px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }',
  '.mee-pop-sub { overflow: hidden; color: var(--dsw-alias-label-dimmed); font-size: 10px; line-height: 14px; text-overflow: ellipsis; white-space: nowrap; }',
  '.mee-pop-note { margin: 0; padding: 5px 8px 8px; color: var(--dsw-alias-label-dimmed); font-size: 11px; line-height: 16px; }',
  '.mee-modes { display: flex; gap: 0; margin: 0 2px 8px; padding: 2px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }',
  '.mee-modes button { flex: 1; height: 26px; padding: 0 4px; border: 0; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 16px; cursor: pointer; }',
  '.mee-modes button:hover:not([data-on="1"]) { color: var(--dsw-alias-label-primary); }',
  '.mee-modes button[data-on="1"] { background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-shadow-lv1); font-weight: 600; }',
  '.mee-levels { display: flex; flex-direction: column; gap: 2px; margin: 0 0 4px; }',
  '.mee-level { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-radius: 7px; }',
  '.mee-level:hover { background: var(--dsw-alias-interactive-bg-hover); }',
  '.mee-level-hit { position: relative; display: inline-flex; flex: none; align-items: center; gap: 8px; min-width: 0; cursor: pointer; }',
  '.mee-level-hit input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }',
  '.mee-tick-box { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 4px; background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary-inverted); }',
  '.mee-level-hit input:checked + .mee-tick-box { background: var(--dsw-alias-state-business-primary); box-shadow: none; }',
  '.mee-level-hit input:focus-visible + .mee-tick-box { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }',
  '.mee-tick-box svg { display: block; width: 10px; height: 10px; opacity: 0; }',
  '.mee-level-hit input:checked + .mee-tick-box svg { opacity: 1; }',
  '.mee-level-name { min-width: 56px; color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; }',
  '.mee-level input[type="text"] { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 16px; outline: none; }',
  '.mee-level input[type="text"]::placeholder { color: var(--dsw-alias-label-dimmed); }',
  '.mee-level input[type="text"]:hover:not(:disabled) { border-color: var(--dsw-alias-border-l3); }',
  '.mee-level input[type="text"]:focus { border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent); }',
  '.mee-level input[type="text"]:disabled { opacity: 0.4; }',
  '.mee-compat { display: flex; align-items: center; gap: 10px; margin: 2px 2px 4px; padding: 8px 8px 6px; border-top: 1px solid var(--dsw-alias-border-l2); cursor: pointer; -webkit-user-select: none; user-select: none; }',
  '.mee-compat-copy { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }',
  '.mee-compat-title { color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 16px; }',
  '.mee-compat-hint { color: var(--dsw-alias-label-tertiary); font-size: 10px; line-height: 14px; }',
  '.mee-switch { position: relative; display: inline-flex; flex: none; width: 32px; height: 18px; }',
  '.mee-switch input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; }',
  '.mee-switch span { display: block; width: 100%; height: 100%; border-radius: 10px; background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1); transition: background 120ms ease; }',
  '.mee-switch span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-alias-label-primary); transition: transform 120ms ease; }',
  '.mee-switch input:checked + span { background: var(--dsw-alias-state-business-primary); }',
  '.mee-switch input:checked + span::after { transform: translateX(14px); }',
  '.mee-switch input:focus-visible + span { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 2px; }',
  '.mee-foot { display: flex; align-items: center; gap: 8px; margin: 0 2px; padding: 8px 6px 4px; border-top: 1px solid var(--dsw-alias-border-l2); }',
  '.mee-err { flex: 1; min-width: 0; color: var(--dsw-alias-state-error-primary); font-size: 11px; line-height: 16px; }',
  '.mee-foot button { margin-left: auto; height: 26px; padding: 0 12px; border: 0; border-radius: 7px; background: var(--dsw-alias-state-business-primary); color: var(--dsw-alias-label-primary-inverted); font-size: 12px; font-weight: 600; line-height: 16px; cursor: pointer; }',
  '.mee-foot button:disabled { opacity: 0.55; cursor: default; }',
  '@media (prefers-reduced-motion: reduce) { .mee-switch span, .mee-switch span::after { transition: none; } }',
].join('\n')

/**
 * Insert the style element once and return its disposer.
 *
 * Pre-claimed with `data-plugin`/`data-plugin-css` (the stock build-time CSS
 * emission convention) and dedup-guarded: the client module system's
 * `claimStyles` attributes every UNTAGGED `<style>` to whichever plugin
 * materializes next, and that plugin's next HMR reload deletes the claimed
 * sheet (the 2026-09-08 bridge incident). A claimed tag is only touched by
 * a rebuild of THIS plugin, whose reload re-inserts the sheet anyway.
 * @returns the disposer removing the style element (no-op when deduped).
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const tagId = 'dsh-model-efforts-editor'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
  const el = document.createElement('style')
  el.dataset.plugin = tagId
  el.dataset.pluginCss = tagId
  el.textContent = SECTION_CSS
  document.head.appendChild(el)
  return () => {
    el.remove()
  }
}
