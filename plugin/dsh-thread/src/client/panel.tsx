import {
  IconBranchOutline16,
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconCodeOutline16,
  IconFolderOpenOutline16,
  IconLinkOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import React from 'react'
import { projectThreadPanel } from '../panel.ts'
import { pageOfIndex, paginateList } from '../pagination.ts'
import type { StateResult, ThreadArtifact } from '../thread-types.ts'

export interface ThreadPanelFace {
  isPanelOpen(): boolean
  loadState(): Promise<StateResult>
  openSession(sessionId: SessionId): void
  subscribePanel(listener: () => void): () => void
}

export interface ThreadPanelProps {
  placement: React.CSSProperties
  sessionId: SessionId
  threadFace: ThreadPanelFace
  useSessions: PropsRuntime<'shell.overlay'>['useSessions']
}

/** Session rows per page inside the capsule; the rest page over. */
export const THREAD_SESSION_PAGE_SIZE = 8
/** Artifact cards per page inside the capsule; the rest page over. */
export const THREAD_ARTIFACT_PAGE_SIZE = 5

const styles = {
  root: {
    position: 'fixed', zIndex: 40, boxSizing: 'border-box', pointerEvents: 'auto',
    display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden',
    border: 0, borderRadius: 24,
    background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
    boxShadow: 'var(--dsw-shadow-lv3)',
    fontSize: 12, lineHeight: 1.5, transformOrigin: 'top right',
  },
  body: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' },
  identity: { padding: '12px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  idLine: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontFamily: 'ui-monospace, monospace' },
  rootTitle: { marginTop: 3, overflowWrap: 'anywhere', fontSize: 14, fontWeight: 600, lineHeight: 1.5 },
  meta: { marginTop: 2, color: 'var(--dsw-alias-label-secondary)', fontSize: 11 },
  section: { padding: '10px 18px', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
  sectionLast: { padding: '10px 18px' },
  sectionHeading: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6,
    color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontWeight: 600,
  },
  sessionList: { display: 'flex', flexDirection: 'column', gap: 2 },
  sessionButton: {
    display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr) auto', alignItems: 'center',
    width: '100%', minHeight: 36, padding: '5px 9px', border: 0, borderRadius: 10,
    background: 'transparent', color: 'inherit', textAlign: 'left', cursor: 'pointer', font: 'inherit',
  },
  sessionButtonCurrent: { background: 'var(--dsw-alias-bg-layer-1)' },
  stage: {
    display: 'grid', placeItems: 'center', width: 20, height: 20, borderRadius: '50%',
    border: '1px solid var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', fontSize: 10,
  },
  stageCurrent: {
    borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-bg-base)',
  },
  sessionText: { display: 'flex', flexDirection: 'column', minWidth: 0, padding: '0 8px' },
  sessionTitle: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 },
  sessionId: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)', fontSize: 10 },
  status: { color: 'var(--dsw-alias-label-secondary)', fontSize: 10 },
  artifactList: { display: 'flex', flexDirection: 'column', gap: 5 },
  artifact: {
    display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', gap: 9,
    padding: 8, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  artifactIcon: { color: 'var(--dsw-alias-label-secondary)', paddingTop: 1 },
  artifactLabel: { overflowWrap: 'anywhere', fontWeight: 500, lineHeight: 1.45 },
  artifactMeta: { marginTop: 2, overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-secondary)', fontSize: 10, lineHeight: 1.45 },
  emptyWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '12px 24px 14px', textAlign: 'center',
  },
  emptyIcon: {
    display: 'grid', placeItems: 'center', width: 40, height: 40, marginBottom: 8,
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '50%',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)',
  },
  emptyTitle: { color: 'var(--dsw-alias-label-primary)', fontSize: 13, fontWeight: 600 },
  emptyDesc: { marginTop: 5, maxWidth: 300, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.7 },
  error: { padding: 18, color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
  pager: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginTop: 6 },
  pagerButton: {
    display: 'grid', placeItems: 'center', width: 22, height: 22, padding: 0,
    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
  },
  pagerButtonDisabled: { opacity: 0.4, cursor: 'default' },
  pagerText: {
    minWidth: 40, textAlign: 'center',
    color: 'var(--dsw-alias-label-secondary)', fontSize: 11, fontVariantNumeric: 'tabular-nums',
  },
} as const

function ArtifactIcon({ artifact }: { artifact: ThreadArtifact }): React.ReactElement {
  if (artifact.kind === 'directory') return <IconFolderOpenOutline16 />
  if (artifact.kind === 'url') return <IconLinkOutline16 />
  return <IconCodeOutline16 />
}

function artifactOriginText(origin: 'produced' | 'carried' | 'none'): string {
  if (origin === 'produced') return '本阶段产物'
  if (origin === 'carried') return '承接产物'
  return '当前会话产物'
}

/** Compact ‹ page / pages › row shared by the session list and artifact list. */
function Pager(props: {
  label: string
  onChange(page: number): void
  page: number
  pageCount: number
}): React.ReactElement | null {
  if (props.pageCount <= 1) return null
  const goTo = (page: number): void => props.onChange(page)
  return (
    <div style={styles.pager} role="navigation" aria-label={`${props.label}分页`}>
      <button
        type="button"
        style={{ ...styles.pagerButton, ...(props.page <= 1 ? styles.pagerButtonDisabled : {}) }}
        disabled={props.page <= 1}
        aria-label="上一页"
        onClick={() => goTo(props.page - 1)}
      >
        <IconChevronLeftOutline14 />
      </button>
      <span style={styles.pagerText} aria-live="polite">{props.page} / {props.pageCount}</span>
      <button
        type="button"
        style={{ ...styles.pagerButton, ...(props.page >= props.pageCount ? styles.pagerButtonDisabled : {}) }}
        disabled={props.page >= props.pageCount}
        aria-label="下一页"
        onClick={() => goTo(props.page + 1)}
      >
        <IconChevronRightOutline14 />
      </button>
    </div>
  )
}

export function ThreadPanel(props: ThreadPanelProps): React.ReactElement {
  const [state, setState] = React.useState<StateResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [sessionPage, setSessionPage] = React.useState(1)
  const [artifactPage, setArtifactPage] = React.useState(1)
  const sessions = props.useSessions((snapshot) => snapshot.byId)

  React.useEffect(() => {
    let active = true
    setError(null)
    void props.threadFace.loadState().then((next) => {
      if (active) setState(next)
    }, (reason) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [props.sessionId, props.threadFace])

  const projection = state === null ? null : projectThreadPanel(String(props.sessionId), state.links)
  const currentNode = projection?.sessions.find(item => item.sessionId === String(props.sessionId))
  const currentIndex = projection?.sessions.findIndex(item => item.sessionId === String(props.sessionId)) ?? -1
  const rootTitle = projection === null
    ? ''
    : sessions[projection.rootSessionId as SessionId]?.displayTitle ?? projection.rootSessionId
  const threadLabel = projection?.threadId === null || projection?.threadId === undefined
    ? '旧版关系'
    : projection.threadId.replace(/^thread-root-/, '').slice(0, 12)

  // Keep the page holding the current Session visible after navigation.
  React.useEffect(() => {
    if (currentIndex >= 0) setSessionPage(pageOfIndex(currentIndex, THREAD_SESSION_PAGE_SIZE))
  }, [currentIndex])

  // The artifact view is scoped to the current Session; restart from page one.
  React.useEffect(() => {
    setArtifactPage(1)
  }, [props.sessionId])

  const sessionSlice = paginateList(projection?.sessions ?? [], THREAD_SESSION_PAGE_SIZE, sessionPage)
  const artifactSlice = paginateList(currentNode?.artifacts ?? [], THREAD_ARTIFACT_PAGE_SIZE, artifactPage)

  return (
    <aside id="dsh-thread-capsule" style={{ ...styles.root, ...props.placement }} aria-label="Thread 面板">
      <div style={styles.body}>
        {error !== null && <div style={styles.error}>{error}</div>}
        {state === null && error === null && (
          <div style={styles.emptyWrap}>
            <div style={styles.emptyDesc}>正在读取 Thread…</div>
          </div>
        )}
        {state !== null && projection === null && (
          <div style={styles.emptyWrap}>
            <div style={styles.emptyIcon}><IconBranchOutline16 /></div>
            <div style={styles.emptyTitle}>尚未加入 Thread</div>
            <div style={styles.emptyDesc}>完成一个独立阶段后，Thread 模式会在合适的边界提出新会话交接。</div>
          </div>
        )}
        {projection !== null && (
          <>
            <section style={styles.identity}>
              <div style={styles.idLine}>Thread · {threadLabel}</div>
              <div style={styles.rootTitle}>{rootTitle}</div>
              <div style={styles.meta}>{projection.sessions.length} 个关联会话</div>
            </section>
            <section style={styles.section}>
              <div style={styles.sectionHeading}><span>会话</span><span>{projection.sessions.length}</span></div>
              <div style={styles.sessionList}>
                {sessionSlice.items.map((item, index) => {
                  const summary = sessions[item.sessionId as SessionId]
                  const current = item.sessionId === String(props.sessionId)
                  return (
                    <button
                      type="button"
                      key={item.sessionId}
                      style={{ ...styles.sessionButton, ...(current ? styles.sessionButtonCurrent : {}) }}
                      disabled={summary === undefined}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => props.threadFace.openSession(item.sessionId as SessionId)}
                    >
                      <span style={{ ...styles.stage, ...(current ? styles.stageCurrent : {}) }}>
                        {(sessionSlice.page - 1) * THREAD_SESSION_PAGE_SIZE + index + 1}
                      </span>
                      <span style={styles.sessionText}>
                        <span style={styles.sessionTitle}>{summary?.displayTitle ?? item.sessionId}</span>
                        <span style={styles.sessionId}>{item.sessionId.slice(-12)}</span>
                      </span>
                      <span style={styles.status}>{current ? '当前' : summary?.running ? '进行中' : ''}</span>
                    </button>
                  )
                })}
              </div>
              <Pager
                label="会话"
                page={sessionSlice.page}
                pageCount={sessionSlice.pageCount}
                onChange={setSessionPage}
              />
            </section>
            <section style={styles.sectionLast}>
              <div style={styles.sectionHeading}>
                <span>{artifactOriginText(currentNode?.artifactOrigin ?? 'none')}</span>
                <span>{currentNode?.artifacts.length ?? 0}</span>
              </div>
              {currentNode === undefined || currentNode.artifacts.length === 0
                ? <div style={styles.meta}>这个阶段还没有通过 Thread Handoff 记录产物。</div>
                : (
                  <>
                    <div style={styles.artifactList}>
                      {artifactSlice.items.map((artifact, index) => (
                        <div style={styles.artifact} key={`${artifact.kind}:${artifact.label}:${artifact.uri ?? ''}:${index}`}>
                          <span style={styles.artifactIcon}><ArtifactIcon artifact={artifact} /></span>
                          <span>
                            <div style={styles.artifactLabel}>{artifact.label}</div>
                            {artifact.uri !== null && <div style={styles.artifactMeta}>{artifact.uri}</div>}
                            {artifact.summary !== null && <div style={styles.artifactMeta}>{artifact.summary}</div>}
                          </span>
                        </div>
                      ))}
                    </div>
                    <Pager
                      label="产物"
                      page={artifactSlice.page}
                      pageCount={artifactSlice.pageCount}
                      onChange={setArtifactPage}
                    />
                  </>
                )}
            </section>
          </>
        )}
      </div>
    </aside>
  )
}
