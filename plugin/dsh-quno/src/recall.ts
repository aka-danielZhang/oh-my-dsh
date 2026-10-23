/**
 * `quno_recall`: search the permanent conversation and its background
 * sessions, returning bounded excerpts WITH pointers instead of dumping full
 * history.
 *
 * Compaction replaces surface messages but never rewrites the raw log, so a
 * hit inside a compacted range resolves through `traceEvent`'s replacement
 * chain to the original event (design §4.4).
 *
 * @module dsh-quno/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-query'
import type { QunoStore } from './store.ts'
import { toIso, truncateText } from './util.ts'

/** One recalled excerpt. */
export interface RecallMatch {
  readonly sessionId: string
  readonly seq: number
  readonly kind: 'main' | 'task' | 'analysis'
  readonly at: string | null
  readonly excerpt: string
  /** Compaction replacements that shadowed this event, when any. */
  readonly replacedBy: number[]
}

/** Recall request accepted from the model-facing tool and the UI. */
export interface RecallRequest {
  readonly query: string
  readonly scope?: 'main' | 'tasks' | 'all'
  readonly limit?: number
  readonly timeRange?: { readonly from?: string; readonly to?: string }
}

/** Recall response. */
export interface RecallResult {
  readonly matches: RecallMatch[]
  readonly truncated: boolean
  readonly note?: string
}

/** Recall dependencies. */
export interface RecallDeps {
  readonly ctx: Context
  readonly store: QunoStore
  readonly qunoId: string
  readonly mainSessionId: () => string | null
  readonly logger?: { warn: (message: string) => void }
}

/** Run one recall query. */
export async function recall(deps: RecallDeps, request: RecallRequest): Promise<RecallResult> {
  const query = request.query.trim()
  if (query === '') return { matches: [], truncated: false, note: '查询为空' }
  const sessionQuery = deps.ctx.get('sessionQuery')
  if (sessionQuery === undefined) return { matches: [], truncated: false, note: 'sessionQuery 未挂载，无法检索历史' }
  const limit = Math.min(20, Math.max(1, request.limit ?? 8))
  const scope = request.scope ?? 'main'
  const targets = collectTargets(deps, scope)
  const from = request.timeRange?.from === undefined ? null : Date.parse(request.timeRange.from)
  const to = request.timeRange?.to === undefined ? null : Date.parse(request.timeRange.to)
  const matches: RecallMatch[] = []

  for (const target of targets) {
    if (matches.length >= limit) break
    let page: Awaited<ReturnType<typeof sessionQuery.searchEvents>>
    try {
      page = await sessionQuery.searchEvents({ sessionId: target.sessionId as never, query, limit: limit })
    } catch (error) {
      deps.logger?.warn(`dsh-quno: recall search failed for ${target.sessionId}: ${(error as Error).message}`)
      continue
    }
    for (const hit of page.items) {
      if (matches.length >= limit) break
      const at = readEventTime(hit)
      if (from !== null && Number.isFinite(from) && (at === null || at < from)) continue
      if (to !== null && Number.isFinite(to) && (at === null || at > to)) continue
      let excerpt = hit.snippet
      let replacedBy: number[] = []
      try {
        const trace = await sessionQuery.traceEvent({ sessionId: target.sessionId as never, seq: hit.seq as never })
        replacedBy = trace.replacementChain
        if (replacedBy.length > 0) {
          const original = await sessionQuery.readEvent({
            sessionId: target.sessionId as never,
            seq: hit.seq as never,
            before: 0,
            after: 0,
          })
          excerpt = extractText(original.target) || excerpt
        }
      } catch {
        // trace is advisory; the hit itself is still useful
      }
      matches.push({
        sessionId: target.sessionId,
        seq: hit.seq,
        kind: target.kind,
        at: toIso(at),
        excerpt: truncateText(excerpt.replace(/\s+/g, ' ').trim(), 600),
        replacedBy,
      })
    }
  }
  return {
    matches,
    truncated: matches.length >= limit,
    ...(matches.length === 0 ? { note: '没有匹配的历史。可以换一个更具体的关键词，或放宽范围。' } : {}),
  }
}

function collectTargets(
  deps: RecallDeps,
  scope: 'main' | 'tasks' | 'all',
): readonly { readonly sessionId: string; readonly kind: 'main' | 'task' | 'analysis' }[] {
  const targets: { sessionId: string; kind: 'main' | 'task' | 'analysis' }[] = []
  const main = deps.mainSessionId()
  if (main !== null && (scope === 'main' || scope === 'all')) targets.push({ sessionId: main, kind: 'main' })
  if (scope === 'tasks' || scope === 'all') {
    for (const task of deps.store.listTasks(deps.qunoId, undefined, 20)) {
      if (task.childSessionId !== null) targets.push({ sessionId: task.childSessionId, kind: 'task' })
    }
    for (const run of deps.store.listRuns(deps.qunoId, 20)) {
      if (run.sessionId !== null) targets.push({ sessionId: run.sessionId, kind: 'analysis' })
    }
  }
  const seen = new Set<string>()
  return targets.filter((target) => {
    if (seen.has(target.sessionId)) return false
    seen.add(target.sessionId)
    return true
  }).slice(0, 24)
}

function readEventTime(hit: { readonly time?: number | null; readonly at?: number | null }): number | null {
  if (typeof hit.time === 'number') return hit.time
  if (typeof hit.at === 'number') return hit.at
  return null
}

function extractText(event: { readonly type: string; readonly data?: unknown }): string {
  const data = event.data as Record<string, unknown> | undefined
  if (data === undefined) return ''
  if (event.type === 'user/message' || event.type === 'developer/message') {
    return contentText(data['content'])
  }
  if (event.type === 'assistant/message') {
    const message = data['message'] as { content?: unknown } | undefined
    return contentText(message?.content)
  }
  if (event.type === 'tool/result') {
    const message = data['message'] as { content?: unknown } | undefined
    return contentText(message?.content)
  }
  return ''
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    return record['type'] === 'text' && typeof record['text'] === 'string' ? [record['text']] : []
  }).join('\n')
}
