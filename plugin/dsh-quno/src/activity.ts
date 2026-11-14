/**
 * The read-only execution record projection (design §9.3): one pure function
 * from raw executor-session events to the bounded, redacted timeline the
 * product shows inside the task detail.
 *
 * Hard rules enforced here:
 * - a WHITELIST of event types is projected; everything else (system prompt,
 *   developer messages, provider streams, request headers) never leaves the
 *   Host;
 * - reasoning blocks are dropped from assistant text — private thinking is
 *   not part of the record;
 * - tool arguments and results pass a credential denylist and a hard length
 *   bound, always flagged with `truncated` when clipped;
 * - pages are stable: the cursor is a seq lower bound, so appended events
 *   never shift an already-served page.
 *
 * @module dsh-quno/activity
 */

import type { TaskActivityItemWire, TaskActivityWire } from './api-types.ts'
import { activityKindForTool, type TaskActivityKind } from './presentation.ts'

/** Raw session-event face the projector reads (structural, replay-shaped). */
export interface RawSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
}

/** Projection bounds. */
const TEXT_CLIP = 600
const ARGS_CLIP = 400
const RESULT_CLIP = 600
/** Hard cap on one page regardless of the requested limit. */
export const ACTIVITY_PAGE_MAX = 100
export const ACTIVITY_PAGE_DEFAULT = 50

/** Keys whose values never leave the Host, at any depth. */
const DENIED_KEY = /token|secret|password|passwd|credential|apikey|api[_-]?key|authorization|cookie|env(ironment)?|private[_-]?key/i

/** Credential-shaped assignments inside free text (`token=…`, `Authorization: …`). */
const CREDENTIAL_TEXT = /([\w.-]*(?:token|secret|password|passwd|apikey|api[_-]?key|authorization|credentials?|cookie)[\w.-]*)(\s*[:=]\s*)(\S+)/gi

/**
 * Scrub credential-shaped assignments out of free text. Applied to every
 * projected text (arguments, results, worker text) so a credential echoed by
 * a tool never reaches the record.
 */
function scrubText(text: string): string {
  return text.replace(CREDENTIAL_TEXT, (_match, key: string) => `${key}=<已脱敏>`)
}

/**
 * Project the raw executor-session log into the read-only record.
 * @param events - the full raw log (ascending seq).
 * @param cursor - exclusive lower seq bound; `null` starts from the beginning.
 * @param limit - requested page size (clamped).
 * @returns one stable page plus the cursor for the next one.
 */
export function projectTaskActivity(
  events: readonly RawSessionEvent[],
  cursor: number | null,
  limit: number | undefined,
): TaskActivityWire {
  const pageLimit = Math.min(ACTIVITY_PAGE_MAX, Math.max(1, limit ?? ACTIVITY_PAGE_DEFAULT))
  const floor = cursor ?? Number.NEGATIVE_INFINITY
  const all = mergePairs(events.filter(event => event.seq > floor))
  const items = all.slice(0, pageLimit)
  const lastSeq = items.length === 0 ? null : items[items.length - 1]!.seq
  return {
    items,
    nextCursor: all.length > items.length && lastSeq !== null ? lastSeq : null,
    truncated: all.length > items.length,
    sessionIdentity: sessionIdentity(events),
  }
}

/** The diagnostic session identity: id plus first-event time. */
function sessionIdentity(events: readonly RawSessionEvent[]): TaskActivityWire['sessionIdentity'] {
  const first = events[0]
  return first === undefined
    ? null
    : { startedAt: first.time, sessionId: '' }
}

/** Pair tool calls with their results, then project the merged stream. */
function mergePairs(events: readonly RawSessionEvent[]): readonly TaskActivityItemWire[] {
  const results = new Map<string, RawSessionEvent>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = toolCallIdOf(event.data)
    if (callId !== null) results.set(callId, event)
  }
  const consumed = new Set<string>()
  const items: TaskActivityItemWire[] = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        const turn = recordOf(event.data)['turn']
        if (typeof turn === 'number') {
          items.push({ kind: 'turn', seq: event.seq, at: event.time, turn, phase: 'start' })
        }
        break
      }
      case 'turn/end': {
        const record = recordOf(event.data)
        const turn = record['turn']
        const reason = record['reason']
        if (typeof turn === 'number') {
          items.push({
            kind: 'turn',
            seq: event.seq,
            at: event.time,
            turn,
            phase: 'end',
            ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
          })
        }
        break
      }
      case 'user/message': {
        const text = textOf(recordOf(event.data)['content'])
        if (text === '') break
        items.push({
          kind: 'task-input',
          seq: event.seq,
          at: event.time,
          text: clip(text, TEXT_CLIP),
          textTruncated: text.length > TEXT_CLIP,
          source: sourceKindOf(event.data),
        })
        break
      }
      case 'assistant/message': {
        const record = recordOf(event.data)
        const message = recordOf(record['message'])
        const text = visibleText(message['content'])
        const interrupted = record['interrupted'] === true
        if (text === '' && !interrupted) break
        items.push({
          kind: 'worker-say',
          seq: event.seq,
          at: event.time,
          text: text === '' ? '' : clip(text, TEXT_CLIP),
          textTruncated: text.length > TEXT_CLIP,
          interrupted,
        })
        break
      }
      case 'tool/call': {
        const record = recordOf(event.data)
        const callId = typeof record['callId'] === 'string' ? record['callId'] : ''
        const name = typeof record['name'] === 'string' ? record['name'] : 'tool'
        const result = callId === '' ? undefined : results.get(callId)
        if (result !== undefined) consumed.add(callId)
        items.push({
          kind: 'tool',
          seq: event.seq,
          at: event.time,
          tool: name,
          display: activityKindForTool(name, cliHint(name, record['arguments'])),
          argsSummary: argsSummary(record['arguments']),
          argsTruncated: argsTruncated(record['arguments']),
          ...(result === undefined
            ? {}
            : {
              resultSummary: resultSummary(result),
              resultTruncated: resultTruncated(result),
              isError: resultIsError(result),
              resultSeq: result.seq,
            }),
        })
        break
      }
      case 'tool/result': {
        // A result whose call was served on an earlier page becomes its own
        // continuation entry, so paging never silently swallows outcomes.
        const callId = toolCallIdOf(event.data)
        if (callId !== null && consumed.has(callId)) break
        items.push({
          kind: 'tool-result',
          seq: event.seq,
          at: event.time,
          ...(callId === null ? {} : { callId }),
          resultSummary: resultSummary(event),
          resultTruncated: resultTruncated(event),
          isError: resultIsError(event),
        })
        break
      }
      default:
        // Not on the whitelist: never projected.
        break
    }
  }
  return items
}

// --------------------------------------------------------------------- redaction

/** Join only the public text blocks; reasoning and binary blocks never leak. */
function visibleText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const text = content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    return record['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
  }).join('\n').trim()
  return scrubText(text)
}

function textOf(content: unknown): string {
  return visibleText(content)
}

/** Bounded, denylist-redacted summary of one raw tool-arguments string. */
function argsSummary(raw: unknown): string | null {
  const parsed = parseArgs(raw)
  if (parsed === null) return null
  return clip(scrubText(JSON.stringify(redact(parsed)) ?? ''), ARGS_CLIP)
}

function argsTruncated(raw: unknown): boolean {
  const parsed = parseArgs(raw)
  if (parsed === null) return false
  return (JSON.stringify(redact(parsed)) ?? '').length > ARGS_CLIP
}

/** Bounded summary of one tool result's public text. */
function resultSummary(event: { readonly data: unknown }): string | null {
  const message = recordOf(recordOf(event.data)['message'])
  const text = visibleText(message['content'])
  if (text === '') return null
  return clip(scrubText(text), RESULT_CLIP)
}

function resultTruncated(event: { readonly data: unknown }): boolean {
  const message = recordOf(recordOf(event.data)['message'])
  return visibleText(message['content']).length > RESULT_CLIP
}

function resultIsError(event: { readonly data: unknown }): boolean {
  const record = recordOf(event.data)
  return record['error'] !== undefined || recordOf(record['message'])['isError'] === true
}

function cliHint(tool: string, raw: unknown): { readonly capability?: string; readonly operation?: string } | null {
  if (tool !== 'quno_cli_call') return null
  const parsed = parseArgs(raw)
  if (parsed === null || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  return {
    ...(typeof record['capability'] === 'string' ? { capability: record['capability'] } : {}),
    ...(typeof record['operation'] === 'string' ? { operation: record['operation'] } : {}),
  }
}

/** Parse the raw arguments JSON string; unparsable args project as `null`. */
function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** Deep-copy a JSON value dropping every denied key's subtree. */
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (DENIED_KEY.test(key)) continue
      out[key] = redact(child)
    }
    return out
  }
  return value
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function recordOf(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
}

function toolCallIdOf(data: unknown): string | null {
  const callId = recordOf(recordOf(data)['message'])['toolCallId']
  return typeof callId === 'string' && callId !== '' ? callId : null
}

function sourceKindOf(data: unknown): string | null {
  const kind = recordOf(recordOf(data)['source'])['kind']
  return typeof kind === 'string' && kind !== '' ? kind : null
}

/** Re-export for the service wiring. */
export type { TaskActivityWire }
