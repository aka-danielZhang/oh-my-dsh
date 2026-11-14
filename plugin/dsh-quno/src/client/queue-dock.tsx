/**
 * The internal-aware queue strip (design §7.1): a generic, faithful clone of
 * the stock conversation queue dock whose ONLY behavioral delta is the
 * internal-source display filter (`queue-internal.ts`).
 *
 * It shadows the stock `conversation.input.dock` entry (same entry id
 * `queue`, lower priority — the documented same-id shadowing precedent) so
 * program-injected inputs queued behind a busy Router never surface to the
 * user, in any session, while real human rows keep every stock behavior:
 * inline editing, removal and steer-now, including the in-flight local echo.
 *
 * Deliberate trade-off (same-id shadowing is global): the clone cannot import
 * the stock component (client purity gate), so the JSX structure and the CSS
 * are maintained side-by-side against the pinned runtime. When the fork seam
 * lands in the harness conversation layer, this entry retires.
 *
 * @module dsh-quno/client/queue-dock
 */

import React, { useEffect, useId, useMemo, useState } from 'react'
import {
  FileTypeIcon, fileSizeText, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconChevronUpOutlineRegular,
  IconCloseOutlineRegular, IconEditOutlineRegular, IconQueueOutlineRegular, IconSendOutlineRegular,
  InlineEditor, IconTrashOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import { isInternalQueueSource, type QueueSourceLike } from './queue-internal.ts'

/** Structural face of one queued durable row (wire data). */
interface QueueRow {
  readonly id: string
  readonly content: readonly { readonly type: string }[]
  readonly source: QueueSourceLike
}

/** Structural face of one local in-flight submission echo. */
interface PendingSubmission {
  readonly requestId: string
  readonly placement: 'transcript' | 'queued'
  readonly text: string
  readonly attachments: readonly (
    | { readonly type: 'image'; readonly value: { readonly previewUrl: string } }
    | { readonly type: 'file'; readonly value: { readonly attachmentId: string; readonly name: string; readonly bytes?: number } }
  )[]
}

/** Structural face of the inbox projection the dock reads. */
interface QueueInboxState {
  readonly 'next-turn'?: readonly QueueRow[]
}

/** Queue operations injected by the session-scoped registration. */
export interface QunoQueueDockInjected {
  updateQueue: (itemId: string, action: QueueAction) => Promise<void>
  notify: (level: 'info' | 'error', text: string) => void
  loadImage: (attachment: { readonly attachmentId: string }) => Promise<string>
}

/** Full props of the shadow entry — the stock dock's prop shape. */
export type QunoQueueDockProps = PropsRuntime<'conversation.input.dock'> & QunoQueueDockInjected
  & PropsLocale<'conversation'> & PropsRenderFactories

const EMPTY_QUEUE: readonly QueueRow[] = []
const QUEUE_TEXT_FACTS = { collapseWhitespace: true, trimWhitespace: true } as const

function textOf(content: QueueRow['content']): string | null {
  if (!content.every(block => block.type === 'text')) return null
  return content.map(block => (block as { readonly text?: string }).text ?? '').join('')
}

/** Durable image/file references of one row, in block order. */
function queueAttachments(content: QueueRow['content']): Array<
  | { readonly type: 'image'; readonly attachment: { readonly attachmentId: string } }
  | { readonly type: 'file'; readonly attachment: { readonly attachmentId: string; readonly name: string; readonly bytes?: number } }
> {
  const attachments: Array<
    | { readonly type: 'image'; readonly attachment: { readonly attachmentId: string } }
    | { readonly type: 'file'; readonly attachment: { readonly attachmentId: string; readonly name: string; readonly bytes?: number } }
  > = []
  for (const block of content) {
    if (block.type === 'image') {
      const attachment = (block as { attachment?: { attachmentId?: string } }).attachment
      if (attachment?.attachmentId !== undefined) attachments.push({ type: 'image', attachment: { attachmentId: attachment.attachmentId } })
    }
    if (block.type === 'file') {
      const attachment = (block as { attachment?: { attachmentId?: string; name?: string; bytes?: number } }).attachment
      if (attachment?.attachmentId !== undefined && attachment.name !== undefined) {
        attachments.push({ type: 'file', attachment: { attachmentId: attachment.attachmentId, name: attachment.name, ...(attachment.bytes === undefined ? {} : { bytes: attachment.bytes }) } })
      }
    }
  }
  return attachments
}

function QueueFile({ attachment, label }: { attachment: { readonly attachmentId: string; readonly name: string; readonly bytes?: number }; label: string }): React.ReactElement {
  return (
    <span className="qnq-file" aria-label={label} title={attachment.name}>
      <span className="qnq-fileIcon" aria-hidden><FileTypeIcon path={attachment.name} size={16} /></span>
      <span className="qnq-fileName">{attachment.name}</span>
      <span className="qnq-fileSize">{fileSizeText(attachment.bytes ?? 0)}</span>
    </span>
  )
}

function QueueThumb({ attachment, loadImage, label }: {
  attachment: { readonly attachmentId: string }
  loadImage: QunoQueueDockInjected['loadImage']
  label: string
}): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    loadImage(attachment).then(
      (resolved) => { if (alive) setUrl(resolved) },
      () => { /* placeholder retained; the durable transcript surfaces read errors */ },
    )
    return () => { alive = false }
  }, [attachment, loadImage])
  return url === null
    ? <span className="qnq-thumb" aria-hidden />
    : <img className="qnq-thumb" src={url} alt={label} />
}

/** The internal-aware queue strip; renders nothing when nothing is visible. */
export function QunoQueueDock(props: QunoQueueDockProps): React.ReactElement | null {
  const { useSession, useProjection, updateQueue, notify, loadImage, renderFactorySlot, t } = props
  const inbox = useProjection('inbox') as unknown as QueueInboxState | undefined
  const pendingSubmissions = useSession(s => s.pendingSubmissions) as readonly PendingSubmission[]
  const queue = useMemo(() => {
    const rows = inbox?.['next-turn'] ?? EMPTY_QUEUE
    const inChat = new Set(pendingSubmissions.filter(item => item.placement === 'transcript').map(item => item.requestId))
    return rows.filter(row => {
      // Stock in-flight echo dedup: a submission already rendered in the
      // transcript must not also show as a queue row.
      if (row.source.kind === 'user' && 'rpcId' in row.source && inChat.has((row.source as { rpcId?: string }).rpcId ?? '')) return false
      // The one behavioral delta: display-internal program rows never show.
      return !isInternalQueueSource(row.source)
    })
  }, [inbox, pendingSubmissions])
  const pendingQueue = useMemo(() => {
    const admitted = new Set(queue.flatMap(row => (
      row.source.kind === 'user' && 'rpcId' in row.source ? [(row.source as { rpcId?: string }).rpcId ?? ''] : []
    )))
    return pendingSubmissions.filter(submission => (
      submission.placement === 'queued' && !admitted.has(submission.requestId)
    ))
  }, [pendingSubmissions, queue])
  const rowCount = queue.length + pendingQueue.length
  const running = useSession(s => s.running) as boolean
  const queueMutable = useSession(s => s.subagent === null || s.subagent.address.mode === 'continuable') as boolean
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(true)
  const listId = useId()

  useEffect(() => {
    if (rowCount === 0 && !collapsed) setCollapsed(true)
    if (editing !== null && (!queueMutable || !queue.some(row => row.id === editing.id))) setEditing(null)
  }, [collapsed, editing, queue, queueMutable, rowCount])

  if (rowCount === 0) return null

  const interactionActive = queueMutable && (editing !== null || busy !== null)
  const expanded = !collapsed || interactionActive
  const listVisible = rowCount === 1 || expanded

  const applyAction = async (itemId: string, action: QueueAction, failure: string): Promise<boolean> => {
    setBusy(itemId)
    try {
      await updateQueue(itemId, action)
      return true
    } catch {
      notify('error', failure)
      return false
    } finally {
      setBusy(current => current === itemId ? null : current)
    }
  }

  const saveEdit = async (): Promise<void> => {
    if (editing === null || editing.text.trim() === '') return
    if (await applyAction(editing.id, { kind: 'edit', content: [{ type: 'text', text: editing.text }] }, t('queue.editFailed'))) {
      setEditing(null)
    }
  }

  return (
    <div className="qnq-dock" data-quno-queue-dock="">
      <div className="qnq-panel">
        {rowCount > 1 && (
          <button
            type="button"
            className="qnq-header"
            aria-controls={listId}
            aria-expanded={expanded}
            disabled={interactionActive}
            onClick={() => { setCollapsed(value => !value) }}
          >
            <span className="qnq-lead" aria-hidden><IconQueueOutlineRegular /></span>
            <span className="qnq-count">{t('queue.count', { n: rowCount })}</span>
            {!listVisible && pendingQueue.length > 0 && (
              <span className="qnq-status" role="status">{t('queue.sending')}</span>
            )}
            <span className="qnq-chevron" aria-hidden>
              {expanded ? <IconChevronDownOutlineRegular /> : <IconChevronUpOutlineRegular />}
            </span>
          </button>
        )}
        <ul id={listId} className="qnq-list" hidden={!listVisible}>
          {listVisible && queue.map((row) => {
            const attachments = queueAttachments(row.content)
            const text = textOf(row.content)
            return (
              <li key={row.id} className="qnq-row">
                {/* Single-item strip has no count header, so the row carries the glyph. */}
                {rowCount === 1 && <span className="qnq-lead" aria-hidden><IconQueueOutlineRegular /></span>}
                {editing?.id === row.id
                  ? (
                    <InlineEditor
                      value={editing.text}
                      label={t('queue.edit')}
                      onChange={(next: string) => { setEditing({ id: row.id, text: next }) }}
                      onSave={() => { void saveEdit() }}
                      onCancel={() => { setEditing(null) }}
                    />
                  )
                  : (
                    <>
                      {attachments.length > 0 && (
                        <span className="qnq-attachments">
                          {attachments.map((item, index) => item.type === 'image'
                            ? (
                              <QueueThumb
                                key={`${item.attachment.attachmentId}:${index}`}
                                attachment={item.attachment}
                                loadImage={loadImage}
                                label={t('queue.image')}
                              />
                            )
                            : (
                              <QueueFile
                                key={`${item.attachment.attachmentId}:${item.attachment.name}:${index}`}
                                attachment={item.attachment}
                                label={t('queue.file', { name: item.attachment.name })}
                              />
                            ))}
                        </span>
                      )}
                      <span className="qnq-preview">{renderFactorySlot('conversation.user.text', {
                        text: row.content.filter(block => block.type === 'text').map(block => (block as { readonly text?: string }).text ?? '').join(''),
                        facts: QUEUE_TEXT_FACTS, interactive: false, ellipsis: true,
                      })}</span>
                    </>
                  )}
                {queueMutable && <div className="qnq-actions">
                  {editing?.id === row.id
                    ? (
                      <>
                        <Tooltip portal label={t('queue.save')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className="qnq-action"
                            aria-label={t('queue.save')}
                            disabled={busy !== null || editing.text.trim() === ''}
                            onClick={() => { void saveEdit() }}
                          >
                            <IconCheckOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip portal label={t('queue.cancelEdit')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className="qnq-action"
                            aria-label={t('queue.cancelEdit')}
                            disabled={busy !== null}
                            onClick={() => { setEditing(null) }}
                          >
                            <IconCloseOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                      </>
                    )
                    : (
                      <>
                        <Tooltip portal label={t('queue.edit')} side="bottom" delayMs={500} disabled={text === null}>
                          <button
                            type="button"
                            className="qnq-action"
                            aria-label={t('queue.edit')}
                            // Disabled buttons fire no hover events, so the
                            // unsupported hint stays a native title.
                            title={text === null ? t('queue.edit.unsupported') : undefined}
                            disabled={busy !== null || text === null}
                            onClick={() => {
                              if (text !== null) setEditing({ id: row.id, text })
                            }}
                          >
                            <IconEditOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip portal label={t('queue.remove')} side="bottom" delayMs={500}>
                          <button
                            type="button"
                            className="qnq-action"
                            aria-label={t('queue.remove')}
                            disabled={busy !== null}
                            onClick={() => {
                              void applyAction(row.id, { kind: 'remove' }, t('queue.removeFailed'))
                            }}
                          >
                            <IconTrashOutlineRegular size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip portal label={t('queue.steer')} side="bottom" delayMs={500} disabled={!running}>
                          <button
                            type="button"
                            className="qnq-action"
                            aria-label={t('queue.steer')}
                            title={running ? undefined : t('queue.steer.unavailable')}
                            disabled={busy !== null || !running}
                            onClick={() => {
                              void applyAction(row.id, { kind: 'steer' }, t('queue.steerFailed'))
                            }}
                          >
                            <IconSendOutlineRegular />
                          </button>
                        </Tooltip>
                      </>
                    )}
                </div>}
              </li>
            )
          })}
          {listVisible && pendingQueue.map((submission) => (
            <li key={submission.requestId} className="qnq-row qnq-pendingRow" data-submission-echo="">
              {rowCount === 1 && <span className="qnq-lead" aria-hidden><IconQueueOutlineRegular /></span>}
              {submission.attachments.length > 0 && (
                <span className="qnq-attachments">
                  {submission.attachments.map((attachment, index) => attachment.type === 'image'
                    ? (
                      <img
                        key={`${attachment.value.previewUrl}:${index}`}
                        className="qnq-thumb"
                        src={attachment.value.previewUrl}
                        alt={t('queue.image')}
                      />
                    )
                    : (
                      <QueueFile
                        key={`${attachment.value.attachmentId}:${attachment.value.name}:${index}`}
                        attachment={attachment.value}
                        label={t('queue.file', { name: attachment.value.name })}
                      />
                    ))}
                </span>
              )}
              <span className="qnq-preview">{renderFactorySlot('conversation.user.text', {
                text: submission.text, facts: QUEUE_TEXT_FACTS, interactive: false, ellipsis: true,
              })}</span>
              <span className="qnq-status" role="status">{t('queue.sending')}</span>
              {queueMutable && <div className="qnq-actions">
                <button type="button" className="qnq-action" aria-label={t('queue.edit')} title={t('queue.sending')} disabled>
                  <IconEditOutlineRegular size={14} />
                </button>
                <button type="button" className="qnq-action" aria-label={t('queue.remove')} title={t('queue.sending')} disabled>
                  <IconTrashOutlineRegular size={14} />
                </button>
                <button type="button" className="qnq-action" aria-label={t('queue.steer')} title={t('queue.sending')} disabled>
                  <IconSendOutlineRegular />
                </button>
              </div>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/**
 * The shadow entry's stylesheet: the pinned stock queue-dock CSS module,
 * renamed under the `qnq-` namespace. Token-only colors keep dark mode.
 */
export const QUNO_QUEUE_CSS = `
.qnq-dock { box-sizing: border-box; flex: none; width: calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)); max-width: calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)); margin: 0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px); padding: 0 var(--dsh-composer-dock-inset); }
.qnq-panel { position: relative; isolation: isolate; overflow: hidden; width: 100%; padding: 2px 0; border-radius: var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0; --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2); --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }
.qnq-panel::before { position: absolute; z-index: -1; inset: 0; border-radius: inherit; background: var(--dsw-specific-menu); backdrop-filter: var(--dsw-menu-backdrop-filter); content: ''; pointer-events: none; }
.qnq-panel::after { position: absolute; inset: 0; border: 0.5px solid var(--dsw-alias-border-l1); border-bottom: none; border-radius: inherit; content: ''; pointer-events: none; }
.qnq-header { box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 4px 12px; border: none; border-radius: var(--dsw-radius-md); background: transparent; color: var(--dsw-alias-label-primary); text-align: left; cursor: pointer; }
.qnq-header:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.qnq-header:disabled { cursor: default; }
.qnq-lead { display: grid; flex: none; place-items: center; color: var(--dsw-alias-label-tertiary); }
.qnq-count { flex: 1 1 auto; min-width: 0; font-family: Inter, var(--dsw-font-family); font-size: 13px; font-weight: 500; line-height: 24px; }
.qnq-chevron { display: grid; flex: none; place-items: center; width: 14px; height: 14px; color: var(--dsw-alias-label-tertiary); }
.qnq-list { max-height: 180px; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.qnq-row { box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 4px 5px 4px 12px; border-radius: var(--dsw-radius-md); }
.qnq-row + .qnq-row { box-shadow: inset 0 1px 0 var(--dsw-alias-border-l1); }
.qnq-attachments { display: flex; flex: none; gap: 4px; min-width: 0; max-width: 55%; overflow: hidden; }
.qnq-pendingRow .qnq-attachments { flex-shrink: 1; }
.qnq-file { display: inline-flex; flex: 0 1 180px; align-items: center; gap: 4px; min-width: 74px; height: 24px; padding: 0 6px; overflow: hidden; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-base); box-sizing: border-box; }
.qnq-fileIcon { display: inline-flex; flex: none; width: 16px; height: 16px; }
.qnq-fileName { min-width: 0; overflow: hidden; color: var(--dsw-alias-label-primary-dimmed); font: var(--dsw-font-xs-13); text-overflow: ellipsis; white-space: nowrap; }
.qnq-fileSize { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 10px; white-space: nowrap; }
.qnq-thumb { width: 24px; height: 24px; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-xs); background: var(--dsw-alias-bg-base); object-fit: cover; }
.qnq-preview { flex: 1 1 auto; min-width: 0; font: var(--dsw-font-xs-13); font-family: Inter, var(--dsw-font-family); color: var(--dsw-alias-label-primary-dimmed); }
.qnq-actions { display: flex; flex: none; align-items: center; gap: 10px; }
.qnq-status { flex: none; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xs-13); white-space: nowrap; }
.qnq-action { display: grid; flex: none; place-items: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: 999px; background: transparent; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.qnq-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.qnq-action:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.qnq-action:disabled { cursor: default; opacity: 0.45; }
`
