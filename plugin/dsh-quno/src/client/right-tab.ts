import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** The tab kind this plugin owns in the right sidebar (what `openTab` names). */
export const QUNO_PANEL_KIND = 'qunoPanel'

/** The implementation identity its body and title register under (keyed seats). */
export const QUNO_PANEL_ID = 'dsh-quno/panel'

/** One panel view: Sense activity, attention items, or tasks. */
export type QunoPanelView = 'sense' | 'attention' | 'task'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** The Quno panel: optionally focused on one task, optionally opening on one view. */
    qunoPanel: { taskId?: string; view?: QunoPanelView }
  }
}

/**
 * Narrow one tab's navigation parameters to this type's shape.
 * @param params - the tab record's navigation parameters (untyped at runtime).
 * @returns the panel focus, or undefined for another type's parameters.
 */
export function narrowPanelParams(
  params: unknown,
): { readonly taskId?: string; readonly view?: QunoPanelView } | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const record = params as Record<string, unknown>
  const taskId = typeof record['taskId'] === 'string' && record['taskId'] !== '' ? record['taskId'] : undefined
  const rawView = record['view']
  const view = rawView === 'sense' || rawView === 'attention' || rawView === 'task' ? rawView : undefined
  if (taskId === undefined && view === undefined) return undefined
  return { ...(taskId === undefined ? {} : { taskId }), ...(view === undefined ? {} : { view }) }
}

export {}
