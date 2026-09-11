/**
 * Page styles for the scheduled-tasks panel — a single hand written style tag,
 * marked `data-plugin`/`data-plugin-css` and inserted idempotently so
 * client-modules `claimStyles` cannot mis-own it across HMR rebuilds
 * (2026-09-08 rail/titlebar lesson). Colors come only from `--dsw-*` tokens.
 *
 * The instruction composer and the toolbar chips mirror the shipped
 * conversation composer's geometry (`InputBar.module.css`, the permission and
 * model triggers, the shared Menu card) so the page reads as the same
 * material: 22px capsule + `--dsw-specific-input-major` + `--dsw-elevation-soft`
 * for the card, 28px/24px-radius chips, `--dsw-specific-menu` + r20 +
 * `--dsw-elevation-prominent` for every dropdown.
 * @module dsh-scheduled-tasks/client/styles
 */

const CSS = `
.dsh-stask-page {
  display: flex; flex-direction: column; gap: 0; height: 100%; min-width: 0;
  box-sizing: border-box; padding: 28px 34px 40px; overflow-y: auto;
  container-type: inline-size;
  color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.5;
}
.dsh-stask-hero { margin-bottom: 18px; }
.dsh-stask-hero-title { margin: 0; font-size: 26px; line-height: 34px; font-weight: 600; }
.dsh-stask-hero-sub { margin: 6px 0 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }

.dsh-stask-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.dsh-stask-header-actions { display: flex; align-items: center; gap: 8px; }
.dsh-stask-spin { animation: dsh-stask-spin 0.9s linear infinite; }
@keyframes dsh-stask-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-stask-spin { animation: none; } }

.dsh-stask-info {
  display: flex; align-items: center; gap: 10px; margin-bottom: 18px; padding: 11px 14px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-size: 12px;
}
.dsh-stask-info-icon { flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-stask-section { margin: 4px 0 10px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-tertiary); }
.dsh-stask-section-gap { margin-top: 26px; }
.dsh-stask-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }

.dsh-stask-card {
  box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1); padding: 16px 18px;
}
.dsh-stask-task { display: flex; flex-direction: column; gap: 8px; }
.dsh-stask-task-click { cursor: pointer; transition: border-color 100ms ease; }
.dsh-stask-task-click:hover { border-color: var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-2); }
.dsh-stask-task-click:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsh-stask-task-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-stask-more-wrap { position: relative; display: flex; flex: none; margin-left: auto; }
.dsh-stask-more {
  display: inline-flex; width: 28px; height: 28px; padding: 0; align-items: center; justify-content: center;
  border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer;
}
.dsh-stask-more:hover, .dsh-stask-more[aria-expanded="true"] {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
}
.dsh-stask-task-title { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.dsh-stask-task-desc {
  margin: 0; font-size: 12px; line-height: 19px; color: var(--dsw-alias-label-secondary);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere;
}
.dsh-stask-task-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
.dsh-stask-when {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; min-width: 0;
  font-size: 11px; font-weight: 500; color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-stask-when svg { flex: none; }
.dsh-stask-when-off { color: var(--dsw-alias-label-tertiary); background: var(--dsw-alias-bg-layer-2); }
.dsh-stask-tpl { display: flex; flex-direction: column; gap: 8px; text-align: left; font: inherit; color: inherit; cursor: pointer; }
.dsh-stask-tpl:hover { border-color: var(--dsw-alias-border-l3); }
.dsh-stask-tpl-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.dsh-stask-tpl-icon { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dsh-stask-tpl-time { font-size: 12px; color: var(--dsw-alias-label-tertiary); }

.dsh-stask-form-header { margin-bottom: 16px; }
.dsh-stask-form-title { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; }
.dsh-stask-panel { display: flex; flex-direction: column; gap: 16px; padding: 18px 20px; }
.dsh-stask-field { display: flex; min-width: 0; flex-direction: column; gap: 5px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-stask-field-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-stask-input {
  box-sizing: border-box; width: 100%; padding: 9px 11px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; color-scheme: light dark;
}
.dsh-stask-input:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-stask-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-height: 34px; margin-top: 4px; }
.dsh-stask-state-strong { font-size: 13px; color: var(--dsw-alias-label-primary); }

.dsh-stask-sched-row { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.dsh-stask-sched-kind { width: 120px; flex: none; }
.dsh-stask-sched-num { width: 84px; flex: none; }
.dsh-stask-sched-time { width: 110px; flex: none; }
.dsh-stask-sched-seg { flex: none; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-stask-sched-summary { margin-left: auto; flex: none; color: var(--dsw-alias-label-tertiary); font-size: 12px; }

.dsh-stask-instr {
  box-sizing: border-box; position: relative; display: flex; flex-direction: column; gap: 12px; width: 100%;
  padding-top: 8px; border: 0; border-radius: 22px; background: var(--dsw-specific-input-major);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
  box-shadow: var(--dsw-elevation-soft);
  font-size: var(--dsh-content-font-size, 14px); line-height: calc(24px + var(--dsh-content-font-delta, 0px));
}
.dsh-stask-instr-text {
  box-sizing: border-box; display: block; width: 100%; min-height: 36px; max-height: 340px; margin: 0;
  padding: 4px 12px 0 14px; border: 0; outline: none; resize: none; overflow-y: auto; background: transparent;
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: inherit; line-height: inherit;
  white-space: pre-wrap; word-break: break-word;
  caret-color: var(--dsw-alias-state-business-primary); color-scheme: light dark;
}
.dsh-stask-instr-text::placeholder { color: var(--dsw-alias-label-caption); }
.dsh-stask-instr-toolbar {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
  padding: 2px 8px 6px; min-width: 0;
}
.dsh-stask-tools, .dsh-stask-trailing { display: flex; align-items: center; min-width: 0; gap: 12px; }
.dsh-stask-trailing { flex: none; margin-left: auto; }

.dsh-stask-chipwrap { position: relative; display: flex; min-width: 0; }
.dsh-stask-chip {
  display: flex; align-items: center; gap: 4px; min-width: 0; max-width: 220px; height: 28px; padding: 0 4px 0 8px;
  border: none; border-radius: 24px; outline: none; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer;
}
.dsh-stask-chip:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stask-chip:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.dsh-stask-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-stask-chip-effort {
  flex-shrink: 1000; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-caption);
}
.dsh-stask-chip-caret { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-caption); transition: transform 120ms ease; }
.dsh-stask-chip-caret.dsh-stask-chip-open { transform: rotate(180deg); }
.dsh-stask-chip-icon { display: inline-flex; flex: 0 0 auto; }
.dsh-stask-chip-icon svg { width: 14px; height: 14px; }

.dsh-stask-ws {
  display: inline-flex; align-items: center; gap: 4px; max-width: min(100%, 360px); min-height: 28px; padding: 0 8px;
  border: none; border-radius: 16px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer;
}
.dsh-stask-ws:hover, .dsh-stask-ws-open { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stask-ws:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.dsh-stask-ws-folder { display: inline-flex; flex: none; color: var(--dsw-alias-label-primary); }
.dsh-stask-ws-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dsh-stask-menu {
  position: absolute; z-index: 100; top: calc(100% + 4px); left: 0; box-sizing: border-box;
  display: flex; flex-direction: column; min-width: 218px; max-width: 360px;
  max-height: min(360px, calc(100vh - 96px)); overflow: hidden; padding: 4px; border: 0; border-radius: 20px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
}
.dsh-stask-menu-right { left: auto; right: 0; }
.dsh-stask-menu-wide { width: max-content; min-width: 240px; max-width: min(420px, calc(100vw - 32px)); }
.dsh-stask-menu-scroll { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
.dsh-stask-menu-footer {
  display: flex; flex: none; flex-direction: column; margin-top: 4px; padding-top: 4px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-stask-menu-item {
  display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 8px 10px;
  border: none; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer;
}
.dsh-stask-menu-item:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stask-menu-item:disabled { opacity: 0.4; cursor: not-allowed; }
.dsh-stask-menu-item-icon {
  display: inline-flex; flex: none; width: 16px; height: 16px; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-stask-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-stask-menu-item-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-stask-menu-item-danger .dsh-stask-menu-item-icon { color: inherit; }
.dsh-stask-menu-item-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsh-stask-menu-item-check { display: inline-flex; flex: none; color: var(--dsw-alias-label-primary); }
.dsh-stask-menu-empty { padding: 8px 10px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.dsh-stask-menu-cell {
  box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: auto; min-width: 100%; height: 40px;
  padding: 0 10px; border: none; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer;
}
.dsh-stask-menu-cell:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stask-menu-cell-label { flex: 0 0 auto; white-space: nowrap; }
.dsh-stask-menu-cell-value {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: right; color: var(--dsw-alias-label-tertiary);
}
.dsh-stask-menu-cell-chevron { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); transform: rotate(-90deg); }
.dsh-stask-menu-option {
  box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: auto; min-width: 100%;
  min-height: 38px; padding: 6px 8px; border: none; border-radius: 10px; background: transparent;
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer;
}
.dsh-stask-menu-option:hover, .dsh-stask-menu-option.dsh-stask-menu-active { background: var(--dsw-alias-interactive-bg-hover); }

.dsh-stask-tp-trigger { justify-content: center; }
.dsh-stask-tp-menu {
  position: absolute; z-index: 100; top: calc(100% + 4px); left: 0; right: 0; box-sizing: border-box;
  display: flex; gap: 2px; padding: 4px; border: 0; border-radius: 20px;
  background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
}
.dsh-stask-tp-col {
  position: relative; flex: 1 1 0; min-width: 0; max-height: 224px; overflow-y: auto;
  scrollbar-width: none; -ms-overflow-style: none;
}
.dsh-stask-tp-col::-webkit-scrollbar { display: none; width: 0; height: 0; }
.dsh-stask-tp-cell {
  display: flex; align-items: center; justify-content: center; width: 100%; height: 34px; padding: 0;
  border: none; border-radius: 10px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; line-height: 20px; cursor: pointer; font-variant-numeric: tabular-nums;
}
.dsh-stask-tp-cell:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-stask-tp-cell.dsh-stask-tp-active {
  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); font-weight: 600;
}

.dsh-stask-field-select {
  box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%;
  height: 34px; padding: 0 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; text-align: left; cursor: pointer;
}
.dsh-stask-field-select:hover, .dsh-stask-field-select.dsh-stask-field-select-open { border-color: var(--dsw-alias-border-l3); }
.dsh-stask-field-select:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-stask-field-caret { display: inline-flex; flex: none; color: var(--dsw-alias-label-tertiary); }
.dsh-stask-field-menu {
  position: absolute; z-index: 100; top: calc(100% + 4px); left: 0; right: 0; max-height: 220px; overflow: auto;
  padding: 4px; border-radius: 20px; background: var(--dsw-specific-menu);
  --dsw-elevation-stroke-color: var(--dsw-alias-border-l1);
  box-shadow: var(--dsw-elevation-prominent);
}
.dsh-stask-field-option {
  display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 5px 8px; border-radius: 10px;
  color: var(--dsw-alias-label-primary); font-size: 13px; cursor: pointer; overflow-wrap: anywhere;
}
.dsh-stask-field-option:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stask-field-option.dsh-stask-field-option-active { background: var(--dsw-alias-interactive-bg-hover); font-weight: 600; }
.dsh-stask-field-option.dsh-stask-field-option-active::after { content: "✓"; margin-left: auto; color: var(--dsw-alias-label-primary); font-weight: 400; }
.dsh-stask-dd { position: relative; min-width: 0; }

.dsh-stask-switch-line { display: flex; align-items: center; gap: 10px; height: 34px; }

.dsh-stask-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 32px; padding: 0 16px;
  border: none; border-radius: 16px; background: transparent; color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; line-height: 20px; font-weight: 500; cursor: pointer;
}
.dsh-stask-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-stask-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dsh-stask-btn-primary { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-stask-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-stask-icon-btn {
  height: 28px; padding: 0 10px; border: 0; border-radius: 14px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
}
.dsh-stask-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-stask-icon-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.dsh-stask-icon-btn.dsh-stask-danger { color: var(--dsw-alias-state-error-primary); }

.dsh-stask-tag {
  display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; white-space: nowrap;
  font-size: 11px; line-height: 17px; font-weight: 500;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
}
.dsh-stask-pill {
  display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border-radius: 12px;
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
}
.dsh-stask-muted { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }

.dsh-stask-empty {
  display: flex; min-height: 120px; align-items: center; justify-content: center;
  color: var(--dsw-alias-label-tertiary); text-align: center;
}
.dsh-stask-banner {
  display: flex; align-items: flex-start; gap: 8px; margin: 0 0 12px; padding: 9px 10px; border-radius: 6px;
  border: 1px solid var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere;
}
.dsh-stask-announce {
  position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}

/* Sidebar entry: the clock button beside the session browser's search control.
   Absolutely positioned inside the (React-owned) header row so no foreign child
   lands in that subtree's reconciliation; geometry is measured and reapplied by
   ./entry.ts. */
.dsh-stask-entry {
  position: absolute; display: inline-flex; width: 28px; height: 28px; padding: 0;
  align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); cursor: pointer; z-index: 5;
}
.dsh-stask-entry:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-stask-entry[aria-pressed="true"] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-stask-entry svg { display: block; }

@container (max-width: 760px) {
  .dsh-stask-grid { grid-template-columns: minmax(0, 1fr); }
  .dsh-stask-page { padding: 20px 18px 32px; }
}
`

/**
 * Idempotently insert the page stylesheet; returns the disposer that removes
 * exactly the tag this plugin inserted.
 */
export function injectStyles(pluginId: string): () => undefined {
  const marker = `dsh-stask-css:${pluginId}`
  let tag = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${marker}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = pluginId
    tag.dataset.pluginCss = marker
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  return () => {
    tag?.remove()
    return undefined
  }
}
