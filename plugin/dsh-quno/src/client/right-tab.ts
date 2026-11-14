import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** The tab kind this plugin owns in the right sidebar (what `openTab` names). */
export const QUNO_PANEL_KIND = 'qunoPanel'

/** The implementation identity its body and title register under (keyed seats). */
export const QUNO_PANEL_ID = 'dsh-quno/panel'

/** One panel view: Collector activity, attention items, tasks, or runs. */
export type QunoPanelView = 'collectors' | 'attention' | 'task' | 'runs'

/** Validated navigation parameters of the Quno panel. */
export interface QunoPanelParams {
  readonly taskId?: string
  readonly collectorId?: string
  readonly runId?: string
  readonly view?: QunoPanelView
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The Quno panel: optionally focused on one task or one Collector, optionally opening on one view. */
    qunoPanel: { taskId?: string; collectorId?: string; runId?: string; view?: QunoPanelView }
  }
}

/**
 * Narrow one tab's navigation parameters to this type's shape. Unknown or
 * malformed values are dropped rather than trusted (a stale URL cannot focus
 * a nonexistent record — the panel then shows its honest missing state).
 * @param params - the tab record's navigation parameters (untyped at runtime).
 * @returns the panel focus, or undefined for another type's parameters.
 */
export function narrowPanelParams(params: unknown): QunoPanelParams | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const record = params as Record<string, unknown>
  const taskId = typeof record['taskId'] === 'string' && record['taskId'] !== '' ? record['taskId'] : undefined
  const collectorId = typeof record['collectorId'] === 'string' && record['collectorId'] !== '' ? record['collectorId'] : undefined
  const runId = typeof record['runId'] === 'string' && record['runId'] !== '' ? record['runId'] : undefined
  const rawView = record['view']
  const view = rawView === 'collectors' || rawView === 'attention' || rawView === 'task' || rawView === 'runs' ? rawView : undefined
  if (taskId === undefined && collectorId === undefined && runId === undefined && view === undefined) return undefined
  return {
    ...(taskId === undefined ? {} : { taskId }),
    ...(collectorId === undefined ? {} : { collectorId }),
    ...(runId === undefined ? {} : { runId }),
    ...(view === undefined ? {} : { view }),
  }
}

export {}
