/**
 * Full-text search over the in-process catalog: locate candidate Markdown
 * files, never a second source of truth. Hits carry id/scope/key/revision/
 * snippet only — callers must re-read the file (`memory_get` / service.get)
 * before trusting content.
 *
 * Matching: NFKC + case-folded; exact id/key/tag beats phrase beats token
 * coverage; Chinese works through direct substring matching (no external
 * tokenizer). Ranking follows the design doc's ordering dimensions —
 * workspace-scope first, exact identity, coverage, active-over-disputed,
 * source authority + confirmed, importance, freshness, confidence. Scores
 * decide "which to look at first" and never promote a disputed record to an
 * established fact.
 * @module dsh-ohmymemo/search
 */

import type { CatalogEntry } from './types.ts'
import { normalizeText } from './schema.ts'

/** Search request (the tool surface shape). */
export interface MemorySearchRequest {
  query: string
  /** 'current' = user + resolved workspace (default); 'all' still stays inside this store. */
  scope?: 'current' | 'user' | 'workspace' | 'all'
  kinds?: Array<'semantic' | 'episodic' | 'procedural'>
  limit?: number
  includeDisputed?: boolean
}

/** Resolved inputs the pure matcher needs beyond the request. */
export interface SearchContext {
  /** Scope values eligible for recall (e.g. ['user', 'workspace:ws_x']). */
  scopes: string[]
  /** The workspace scope of the current session, if resolved (ranking boost). */
  workspaceScope?: string
  now: Date
  limit: number
}

/** One search hit — metadata and a bounded snippet, never the full body. */
export interface MemorySearchHit {
  id: string
  scope: string
  kind: string
  key: string
  revision: number
  status: string
  snippet: string
  score: number
}

export interface MemorySearchResult {
  hits: MemorySearchHit[]
  truncated: boolean
}

/** Source-type authority rank for scoring (higher wins). */
const AUTHORITY: Readonly<Record<string, number>> = {
  user_command: 6,
  user_correction: 6,
  user_statement: 5,
  tool_observation: 3,
  cross_session_inference: 2,
  model_inference: 1,
  subagent: 1,
  automation: 1,
  webhook: 0,
  external_content: 0,
}

/** Hard filters: recall eligibility per the design doc. */
export function isRecallable(entry: CatalogEntry, context: SearchContext, includeDisputed: boolean): boolean {
  if (entry.quarantine !== undefined) return false
  if (entry.record.status !== 'active' && !(includeDisputed && entry.record.status === 'disputed')) return false
  if (entry.record.privacy !== 'normal') return false
  if (!context.scopes.includes(entry.record.scope)) return false
  const nowMs = context.now.getTime()
  if (entry.record.valid_from !== undefined && entry.record.valid_from !== null && Date.parse(entry.record.valid_from) > nowMs) return false
  if (entry.record.valid_until !== undefined && entry.record.valid_until !== null && Date.parse(entry.record.valid_until) < nowMs) return false
  return true
}

/** Score one entry against the normalized query; 0 = no match. */
export function scoreEntry(entry: CatalogEntry, tokens: string[], phrase: string, context: SearchContext): number {
  const record = entry.record
  const idHit = tokens.includes(normalizeText(record.id))
  const keyHit = tokens.includes(normalizeText(record.key))
  const tagHit = record.tags.some((tag) => tokens.includes(normalizeText(tag)))
  const normalizedBody = entry.normalizedBody
  const phraseHit = phrase.length > 0 && normalizedBody.includes(phrase)
  const covered = tokens.filter((token) => normalizedBody.includes(token) || normalizeText(record.key).includes(token) || record.tags.some((tag) => normalizeText(tag).includes(token)))
  if (!idHit && !keyHit && !tagHit && !phraseHit && covered.length === 0) return 0

  let score = 0
  if (context.workspaceScope !== undefined && record.scope === context.workspaceScope) score += 100
  if (idHit) score += 80
  if (keyHit) score += 60
  if (tagHit) score += 40
  if (phraseHit) score += 25
  score += (covered.length / Math.max(tokens.length, 1)) * 15
  const authority = Math.max(...record.sources.map((source) => AUTHORITY[source.type] ?? 0), 0)
  score += authority
  if (record.confirmed) score += 8
  if (record.status === 'disputed') score -= 20
  score += record.importance * 5
  const ageDays = Math.max(0, (context.now.getTime() - Date.parse(record.updated_at)) / 86_400_000)
  score += Math.max(0, 2 - ageDays / 30)
  score += record.confidence
  return score
}

/** Build a bounded snippet around the first match (CJK-safe, no line breaks). */
export function makeSnippet(body: string, tokens: string[], phrase: string, maxChars = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  const normalized = normalizeText(flat)
  let index = -1
  if (phrase.length > 0) index = normalized.indexOf(phrase)
  if (index === -1) {
    for (const token of tokens) {
      const at = normalized.indexOf(token)
      if (at !== -1 && (index === -1 || at < index)) index = at
    }
  }
  if (index === -1) return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
  const start = Math.max(0, index - Math.floor(maxChars / 3))
  const end = Math.min(flat.length, start + maxChars)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < flat.length ? '…' : ''
  return `${prefix}${flat.slice(start, end)}${suffix}`
}

/** Tokenize a raw query for matching. */
export function tokenizeQuery(query: string): { tokens: string[]; phrase: string } {
  const phrase = normalizeText(query.trim())
  const tokens = phrase.split(/\s+/).filter((token) => token.length > 0)
  return { tokens, phrase }
}

/** Run one search over catalog entries (pure). */
export function searchEntries(entries: CatalogEntry[], request: MemorySearchRequest, context: SearchContext): MemorySearchResult {
  const { tokens, phrase } = tokenizeQuery(request.query)
  if (tokens.length === 0) return { hits: [], truncated: false }
  const kinds = request.kinds !== undefined ? new Set(request.kinds) : undefined
  const scored: MemorySearchHit[] = []
  for (const entry of entries) {
    if (kinds !== undefined && !kinds.has(entry.record.kind)) continue
    if (!isRecallable(entry, context, request.includeDisputed ?? false)) continue
    const score = scoreEntry(entry, tokens, phrase, context)
    if (score <= 0) continue
    scored.push({
      id: entry.record.id,
      scope: entry.record.scope,
      kind: entry.record.kind,
      key: entry.record.key,
      revision: entry.record.revision,
      status: entry.record.status,
      snippet: makeSnippet(entry.record.body, tokens, phrase),
      score: Math.round(score * 100) / 100,
    })
  }
  scored.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1))
  const limit = Math.max(1, Math.min(request.limit ?? context.limit, context.limit * 2))
  const hits = scored.slice(0, limit)
  return { hits, truncated: scored.length > hits.length }
}
