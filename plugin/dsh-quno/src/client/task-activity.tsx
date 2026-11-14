/**
 * The read-only execution record (design §6.3): one task's executor session
 * projected as a timeline — task inputs, Quno's public text, tool calls with
 * user-readable operation names and redacted summaries, and diagnostic turn
 * markers.
 *
 * Hard rules, enforced structurally:
 * - NO composer, no send/edit/steer surface of any kind — this is evidence,
 *   not a chat window;
 * - operations (stop / retry / answer) belong to the task detail above and go
 *   through task commands, never into the executor session;
 * - text is bounded by the Host (already redacted + clipped); `truncated`
 *   flags render an explicit ellipsis note instead of pretending completeness.
 *
 * @module dsh-quno/client/task-activity
 */

import React from 'react'
import type { QunoLocaleKey, QunoTranslate } from './locales.ts'
import type { QunoClientStore } from './store.ts'
import type { TaskActivityItemWire, TaskActivityWire } from '../api-types.ts'
import { formatClock } from './format.ts'
import { Callout, LoadingRows } from './panel-primitives.tsx'

/** Props of the read-only execution record. */
export interface TaskActivityProps {
  readonly taskId: string
  readonly store: QunoClientStore
  readonly t: QunoTranslate
}

/** One loaded page in the ascending accumulation. */
interface LoadedPage {
  readonly page: TaskActivityWire
}

/**
 * The cursor to fetch next: `'head'` first, then each page's `nextCursor`,
 * and `null` once the record is exhausted or a load failed.
 */
type NextCursor = 'head' | number | null

/** Render one task's read-only execution timeline (pages accumulate ascending). */
export function TaskActivity(props: TaskActivityProps): React.ReactElement {
  const { t, store, taskId } = props
  const [pages, setPages] = React.useState<LoadedPage[]>([])
  const [next, setNext] = React.useState<NextCursor>('head')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // A new task id resets the accumulation entirely.
  React.useEffect(() => {
    setPages([])
    setNext('head')
    setError(null)
    setBusy(false)
  }, [taskId])

  React.useEffect(() => {
    if (next === null) return
    let alive = true
    setBusy(true)
    void store.loadTaskActivity(taskId, next === 'head' ? undefined : next).then(
      (value) => {
        if (!alive) return
        setBusy(false)
        if (value.status === 'ready') {
          setPages(current => [...current, { page: value.data }])
          setNext(value.data.truncated ? (value.data.nextCursor ?? null) : null)
        } else if (value.status === 'missing') {
          setNext(null)
          setError(t('activityMissing'))
        } else if (value.status === 'error') {
          setNext(null)
          setError(value.message)
        }
      },
      (reason: unknown) => {
        if (!alive) return
        setBusy(false)
        setNext(null)
        setError((reason as Error).message)
      },
    )
    return () => { alive = false }
  }, [taskId, next, store, t])

  const items = pages.flatMap(page => page.page.items)
  const note = pages[0]?.page.note
  const exhausted = next === null

  if (exhausted && error === null && (note !== undefined || pages.length === 0)) {
    return (
      <Callout tone="info" title={t('activityEmptyTitle')}>
        {note === 'no-execution-session' ? t('activityNotStarted') : note === undefined ? t('activityUnavailable') : t('activityEmptyTitle')}
      </Callout>
    )
  }
  if (items.length === 0 && error !== null) {
    return (
      <Callout
        tone="error"
        title={t('activityLoadFailed')}
        action={{ label: t('retry'), onClick: () => { setPages([]); setNext('head'); setError(null) } }}
      >
        {error}
      </Callout>
    )
  }
  if (items.length === 0) {
    return <LoadingRows rows={3} />
  }

  const loadMore = (): void => {
    if (busy || exhausted || !(pages.at(-1)?.page.truncated === true)) return
    setNext(pages.at(-1)?.page.nextCursor ?? null)
  }

  return (
    <div style={styles.stack}>
      {items.map(item => <ActivityRow key={`${item.kind}:${String(item.seq)}`} item={item} t={t} />)}
      {error !== null && <p style={styles.error}>{t('activityLoadFailed')}：{error}</p>}
      {!exhausted && pages.at(-1)?.page.truncated === true && (
        <button type="button" style={styles.more} disabled={busy} onClick={loadMore}>
          {busy ? t('activityLoading') : t('activityMore')}
        </button>
      )}
      {exhausted && error === null && (
        <p style={styles.end}>{t('activityEnd')}</p>
      )}
    </div>
  )
}

/** One timeline row; diagnostic ids stay visually secondary. */
function ActivityRow(props: { readonly item: TaskActivityItemWire; readonly t: QunoTranslate }): React.ReactElement {
  const { item, t } = props
  switch (item.kind) {
    case 'task-input':
      return (
        <div style={styles.row}>
          <span style={styles.badge}>{inputLabel(item.source, t)}</span>
          <span style={styles.inputText}>{item.text}{item.textTruncated ? '…' : ''}</span>
          <span style={styles.when}>{formatClock(item.at)}</span>
        </div>
      )
    case 'worker-say':
      return (
        <div style={styles.row}>
          <span style={styles.badge}>{t('activityWorkerSays')}</span>
          {item.text === ''
            ? <span style={styles.muted}>{t('activityInterrupted')}</span>
            : <span style={styles.sayText}>{item.text}{item.textTruncated ? '…' : ''}</span>}
          <span style={styles.when}>{formatClock(item.at)}</span>
        </div>
      )
    case 'tool':
      return (
        <div style={styles.row}>
          <span style={{ ...styles.badge, ...(item.isError === true ? styles.badgeError : {}) }}>
            {t(activityDisplayKey(item.display))}
          </span>
          <span style={styles.toolBody}>
            <details>
              <summary style={styles.summary}>
                {t('activityToolCall', { tool: item.tool })}
                {item.resultSummary !== undefined && item.resultSummary !== null
                  ? <span style={item.isError === true ? styles.errorText : styles.okText}> · {item.isError === true ? t('activityToolFailed') : t('activityToolDone')}</span>
                  : <span> · {t('activityToolRunning')}</span>}
              </summary>
              {item.argsSummary !== null && (
                <p style={styles.mono}>{t('activityToolArgs')}：{item.argsSummary}{item.argsTruncated ? '…' : ''}</p>
              )}
              {item.resultSummary !== undefined && item.resultSummary !== null && (
                <p style={styles.mono}>{t('activityToolResult')}：{item.resultSummary}{item.resultTruncated === true ? '…' : ''}</p>
              )}
            </details>
          </span>
          <span style={styles.when}>{formatClock(item.at)}</span>
        </div>
      )
    case 'tool-result':
      return (
        <div style={styles.row}>
          <span style={{ ...styles.badge, ...(item.isError ? styles.badgeError : {}) }}>{t('activityToolResultShort')}</span>
          <span style={styles.toolBody}>
            <details>
              <summary style={styles.summary}>{t('activityToolLateResult')}</summary>
              {item.resultSummary !== null && <p style={styles.mono}>{item.resultSummary}{item.resultTruncated ? '…' : ''}</p>}
            </details>
          </span>
          <span style={styles.when}>{formatClock(item.at)}</span>
        </div>
      )
    case 'turn':
      return (
        <div style={styles.turnRow}>
          {t('activityTurn', { turn: String(item.turn) })}
          {item.phase === 'end' && typeof item.reason === 'string' && item.reason !== '' ? ` · ${item.reason}` : ''}
        </div>
      )
    default:
      return <></>
  }
}

function inputLabel(source: string | null, t: QunoTranslate): string {
  if (source === 'quno-worker-prompt') return t('activityInputPrompt')
  if (source === 'quno-input') return t('activityInputFollowup')
  if (source === null) return t('activityInputUser')
  return t('activityInputProgram')
}

function activityDisplayKey(display: string): QunoLocaleKey {
  switch (display) {
    case 'recent-groups': return 'taskActivityRecentGroups'
    case 'read-messages': return 'taskActivityReadMessages'
    case 'read-file': return 'taskActivityReadFile'
    case 'read-web': return 'taskActivityReadWeb'
    case 'summarize': return 'taskActivitySummarize'
    case 'waiting-user': return 'taskActivityWaitingUser'
    case 'waiting-event': return 'taskActivityWaitingEvent'
    default: return 'taskActivityWorking'
  }
}

const styles = {
  stack: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 },
  row: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
  badge: {
    flex: 'none', fontSize: 10.5, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)',
    background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 6, padding: '2px 8px', marginTop: 1,
    maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  badgeError: { color: 'var(--dsw-alias-state-error-primary)', background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)' },
  inputText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  sayText: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' },
  toolBody: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  summary: { cursor: 'pointer', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  mono: { margin: '4px 0 0', fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, monospace', overflowWrap: 'anywhere' },
  muted: { flex: 1, minWidth: 0, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
  okText: { color: 'var(--dsw-alias-state-success-primary)' },
  errorText: { color: 'var(--dsw-alias-state-error-primary)' },
  error: { margin: '4px 0 0', fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' },
  when: { flex: 'none', fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', marginTop: 2 },
  turnRow: {
    fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, monospace',
    borderTop: '1px dashed var(--dsw-alias-border-l2)', paddingTop: 4,
  },
  more: {
    alignSelf: 'center', border: 0, background: 'transparent', cursor: 'pointer', padding: '2px 8px',
    font: 'inherit', fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)',
  },
  end: { alignSelf: 'center', margin: 0, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary)' },
} as const
