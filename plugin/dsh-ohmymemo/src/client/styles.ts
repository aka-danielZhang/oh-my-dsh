/** Dynamic stylesheet for the Memory settings section. */

export const MEMORY_SETTINGS_CSS = `
.omm-root{container-type:inline-size;display:flex;min-width:0;min-height:480px;max-height:min(680px,calc(100vh - 168px));height:calc(100vh - 208px);flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;letter-spacing:0;}
.omm-header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px;margin-bottom:10px;}
.omm-title{margin:0;font-size:18px;font-weight:600;line-height:26px;letter-spacing:0;}
.omm-header-actions{display:flex;align-items:center;gap:8px;}
.omm-icon-button{width:28px;min-width:28px;padding:0;}
.omm-tabs{display:inline-flex;align-self:flex-start;gap:2px;padding:2px;margin-bottom:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);}
.omm-tab{min-width:92px;height:28px;padding:0 12px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;}
.omm-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}
.omm-tab:focus-visible,.omm-tree-row:focus-visible,.omm-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.omm-body{min-height:0;flex:1;overflow:auto;padding-right:4px;}
.omm-loading,.omm-empty{display:flex;min-height:220px;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--dsw-alias-label-tertiary);text-align:center;}
.omm-spin{animation:omm-spin 900ms linear infinite;}
@keyframes omm-spin{to{transform:rotate(360deg);}}
.omm-error{display:flex;align-items:flex-start;gap:8px;margin:0 0 12px;padding:9px 10px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;}
.omm-notice{margin:0 7px;color:var(--dsw-alias-label-secondary);font-size:12px;}
.omm-band{padding:15px 0;border-top:1px solid var(--dsw-alias-border-l2);}
.omm-band:last-child{border-bottom:1px solid var(--dsw-alias-border-l2);}
.omm-band-head{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:13px;}
.omm-band-title{display:flex;align-items:center;gap:8px;margin:0;}
.omm-band-title strong{font-size:14px;font-weight:600;}
.omm-state-label{font-size:12px;color:var(--dsw-alias-label-tertiary);}
.omm-switch{position:relative;width:36px;height:20px;flex:none;padding:0;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer;transition:background 120ms ease;}
.omm-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease;}
.omm-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary);}
.omm-switch[aria-checked=true]::after{transform:translateX(16px);}
.omm-switch:disabled{cursor:wait;opacity:.55;}
.omm-controls{display:grid;grid-template-columns:minmax(160px,220px) minmax(0,1fr);align-items:end;gap:16px;margin-bottom:14px;}
.omm-field{display:flex;min-width:0;flex-direction:column;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:12px;}
.omm-time{box-sizing:border-box;width:100%;height:34px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;color-scheme:light dark;}
.omm-select{box-sizing:border-box;width:100%;height:34px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;color-scheme:light dark;}
.omm-select:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.omm-select:disabled{opacity:.55;}
.omm-time:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.omm-time:disabled{opacity:.55;}
.omm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-height:34px;}
.omm-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;background:var(--dsw-alias-border-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden;}
.omm-fact{display:flex;min-width:0;min-height:61px;flex-direction:column;justify-content:center;gap:3px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);}
.omm-fact-label{font-size:11px;color:var(--dsw-alias-label-tertiary);}
.omm-fact-value{overflow-wrap:anywhere;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);}
.omm-last-result{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2);}
.omm-result-metric{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;}
.omm-result-metric b{color:var(--dsw-alias-label-primary);font-size:14px;}
.omm-diagnostic{margin-top:10px;color:var(--dsw-alias-state-error-primary);font-size:12px;overflow-wrap:anywhere;white-space:pre-wrap;}
.omm-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border-top:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);}
.omm-count{display:flex;min-width:0;flex-direction:column;gap:2px;padding:11px 10px;border-right:1px solid var(--dsw-alias-border-l2);}
.omm-count:last-child{border-right:0;}
.omm-count b{font-size:16px;font-weight:600;}
.omm-count span{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}
.omm-health{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:12px;}
.omm-health-state{display:inline-flex;align-items:center;gap:6px;}
.omm-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
.omm-dot[data-state=active]{background:var(--dsw-alias-state-success-primary);}
.omm-dot[data-state=warning]{background:var(--dsw-alias-state-error-primary);}
.omm-space{display:grid;min-height:0;height:100%;grid-template-columns:214px minmax(0,1fr);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);}
.omm-tree-pane{min-width:0;overflow:auto;border-right:1px solid var(--dsw-alias-border-l2);padding:7px 5px;}
.omm-tree-head{padding:5px 8px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;}
.omm-tree-row{display:flex;box-sizing:border-box;width:100%;height:28px;align-items:center;gap:6px;padding:0 7px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.omm-tree-row:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.omm-tree-row[data-selected=true]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}
.omm-tree-row svg{flex:none;}
.omm-disclosure,.omm-disclosure-spacer{display:inline-flex;width:14px;flex:none;align-items:center;justify-content:center;transition:transform 120ms ease;}
.omm-disclosure[data-open=true]{transform:rotate(90deg);}
.omm-tree-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.omm-tree-indent{display:inline-block;width:14px;flex:none;}
.omm-file-icon{display:inline-flex;width:16px;flex:none;align-items:center;justify-content:center;}
.omm-file-dot{width:6px;height:6px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary);}
.omm-file-dot[data-status=active]{background:var(--dsw-alias-state-success-primary);}
.omm-file-dot[data-status=candidate]{background:var(--dsw-alias-state-business-primary);}
.omm-file-dot[data-status=disputed],.omm-file-dot[data-status=quarantined]{background:var(--dsw-alias-state-error-primary);}
.omm-viewer{display:flex;min-width:0;min-height:0;flex-direction:column;overflow:hidden;}
.omm-viewer-head{display:flex;min-height:42px;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l2);}
.omm-viewer-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;}
.omm-mobile-back{display:none;}
.omm-document{min-width:0;flex:1;overflow:auto;padding:16px 18px;}
.omm-meta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);font-size:11px;}
.omm-meta code{color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;}
.omm-redacted{display:flex;min-height:180px;align-items:center;justify-content:center;flex-direction:column;gap:7px;color:var(--dsw-alias-label-tertiary);text-align:center;}
@media (max-width:600px){nav:has(+ div .omm-root){display:none;}nav:has(+ div .omm-root)+div{min-width:0;}}
@container (max-width:520px){.omm-controls{grid-template-columns:1fr;}.omm-actions{justify-content:flex-start;}.omm-grid{grid-template-columns:1fr;}.omm-counts{grid-template-columns:repeat(2,minmax(0,1fr));}.omm-count:nth-child(2){border-right:0;}.omm-count:nth-child(-n+2){border-bottom:1px solid var(--dsw-alias-border-l2);}.omm-space{grid-template-columns:1fr;}.omm-tree-pane{border-right:0;}.omm-space[data-mobile-view=viewer] .omm-tree-pane{display:none;}.omm-space[data-mobile-view=tree] .omm-viewer{display:none;}.omm-mobile-back{display:inline-flex;}.omm-last-result{grid-template-columns:1fr;}}
@media (prefers-reduced-motion:reduce){.omm-spin{animation:none;}.omm-switch,.omm-switch::after{transition:none;}}
`
