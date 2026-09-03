import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import React from 'react'
import { deriveThreadGroups } from '../grouping.ts'
import type { ThreadLink } from '../thread-types.ts'
import type { ThreadPanelFace } from './panel.tsx'
import type { UseSessions, UseWorkspaces } from './session-hooks.ts'

export interface ThreadSidebarViewInjected {
  threadFace: ThreadPanelFace
}

export type ThreadSidebarViewProps =
  Omit<PropsRuntime<'sidebar.workspaces.sessionListView'>, 'useSessions' | 'useWorkspaces'>
  & ThreadSidebarViewInjected
  & { useSessions: UseSessions; useWorkspaces: UseWorkspaces }

/** Injected hover stylesheet: token-based, installed once per client fiber. */
export const THREAD_SIDEBAR_CSS = `
.dsh-thread-sb-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-thread-sb-row[data-current="true"] { background: var(--dsw-alias-interactive-bg-hover); }
`

const styles = {
  list: { display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 0' },
  group: { display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 6 },
  groupHeader: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: 34, padding: '0 8px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', textAlign: 'left', userSelect: 'none',
  },
  groupIcon: { flex: 'none', display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' },
  groupTitle: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 13, fontWeight: 600,
  },
  groupCount: { flex: 'none', color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
  row: {
    display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: 32, padding: '0 8px',
    border: 0, borderRadius: 8, background: 'transparent', cursor: 'pointer',
    color: 'var(--dsw-alias-label-primary)', font: 'inherit', textAlign: 'left', userSelect: 'none',
    boxSizing: 'border-box',
  },
  rowTitle: {
    flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13,
  },
  rowStage: { flex: 'none', width: 16, color: 'var(--dsw-alias-label-secondary)', fontSize: 10, textAlign: 'center' },
  empty: { padding: '12px 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
} as const

function statusOf(summary: { pendingInteraction?: unknown; running: boolean; completed?: boolean }): StateDotState {
  if (summary.pendingInteraction !== undefined) return 'warning'
  if (summary.running) return 'ongoing'
  return 'done'
}

interface RowModel {
  sessionId: SessionId
  title: string
  status: StateDotState
  stage: number | null
}

function SessionRow(props: {
  current: boolean
  indent: boolean
  model: RowModel
  onOpen: (sessionId: SessionId) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      className="dsh-thread-sb-row"
      data-current={props.current ? 'true' : undefined}
      style={{ ...styles.row, ...(props.indent ? { paddingLeft: 30 } : {}) }}
      aria-current={props.current ? 'page' : undefined}
      onClick={() => props.onOpen(props.model.sessionId)}
    >
      {props.model.stage !== null && <span style={styles.rowStage}>{props.model.stage}</span>}
      <span style={styles.rowTitle}>{props.model.title}</span>
      <StateDot state={props.model.status} size={8} />
    </button>
  )
}

/**
 * The sidebar's Thread-grouped session list: one collapsible-free group per
 * connected Thread (root title as the heading, stage-ordered rows), then the
 * remaining Sessions flat by recency. Data rides the shared ThreadFace; the
 * entry only renders while the owning view mode elects it.
 */
export function ThreadSidebarView(props: ThreadSidebarViewProps): React.ReactElement {
  const [links, setLinks] = React.useState<readonly ThreadLink[] | null>(null)
  const byId = props.useSessions((state) => state.byId)
  const currentId = props.useSessions((state) => state.current)
  const archived = props.useWorkspaces((state) => state.archivedSessionIds)

  React.useEffect(() => {
    let active = true
    void props.threadFace.loadState().then((state) => {
      if (active) setLinks(state.links)
    }, () => {
      if (active) setLinks([])
    })
    return () => { active = false }
  }, [props.threadFace])

  const groups = React.useMemo(() => {
    if (links === null) return null
    const archivedSet = new Set<string>(archived)
    const visible = (sessionId: string): boolean => {
      const summary = byId[sessionId as SessionId]
      if (summary === undefined) return false
      if (summary.origin === 'subagent') return false
      if (archivedSet.has(sessionId)) return false
      return !summary.blank || sessionId === currentId
    }
    return deriveThreadGroups([...links])
      .map(group => ({ ...group, visibleIds: group.sessionIds.filter(visible) }))
      .filter(group => group.visibleIds.length > 0)
      .sort((left, right) => {
        const activity = (ids: readonly string[]): number => Math.max(
          ...ids.map(id => byId[id as SessionId]?.updatedAt ?? 0),
        )
        return activity(right.visibleIds) - activity(left.visibleIds)
      })
  }, [links, byId, currentId, archived])

  const ungrouped = React.useMemo(() => {
    if (groups === null) return null
    const groupedIds = new Set(groups.flatMap(group => group.visibleIds))
    return Object.values(byId)
      .filter(summary => !groupedIds.has(summary.id))
      .filter(summary => summary.origin !== 'subagent')
      .filter(summary => !archived.includes(summary.id))
      .filter(summary => !summary.blank || summary.id === currentId)
      .sort((left, right) => right.updatedAt - left.updatedAt)
  }, [groups, byId, currentId, archived])

  if (groups === null || ungrouped === null) {
    return <div style={styles.empty}>正在读取 Thread…</div>
  }

  const rowModel = (sessionId: string, stage: number | null): RowModel => {
    const summary = byId[sessionId as SessionId]!
    return {
      sessionId: summary.id,
      title: summary.blank ? '新会话' : summary.displayTitle,
      status: statusOf(summary),
      stage,
    }
  }

  return (
    <div style={styles.list}>
      {groups.map((group) => {
        const rootSummary = byId[group.rootSessionId as SessionId]
        const groupTitle = rootSummary === undefined || rootSummary.blank
          ? (group.threadId === null
            ? '旧版关系'
            : `Thread ${group.threadId.replace(/^thread-root-/, '').slice(0, 12)}`)
          : rootSummary.displayTitle
        return (
          <div style={styles.group} key={group.threadId ?? `legacy:${group.sessionIds.join(',')}`}>
            <button
              type="button"
              className="dsh-thread-sb-row"
              style={styles.groupHeader}
              disabled={rootSummary === undefined}
              onClick={() => props.threadFace.openSession(group.rootSessionId as SessionId)}
            >
              <span style={styles.groupIcon}><IconBranchOutline16 /></span>
              <span style={styles.groupTitle}>{groupTitle}</span>
              <span style={styles.groupCount}>{group.visibleIds.length}</span>
            </button>
            {group.visibleIds.map((sessionId, index) => (
              <SessionRow
                key={sessionId}
                current={sessionId === currentId}
                indent
                model={rowModel(sessionId, index + 1)}
                onOpen={props.threadFace.openSession}
              />
            ))}
          </div>
        )
      })}
      {ungrouped.map(summary => (
        <SessionRow
          key={summary.id}
          current={summary.id === currentId}
          indent={false}
          model={rowModel(summary.id, null)}
          onOpen={props.threadFace.openSession}
        />
      ))}
    </div>
  )
}
