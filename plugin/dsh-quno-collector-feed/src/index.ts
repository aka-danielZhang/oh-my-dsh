/**
 * dsh-quno-collector-feed — a REAL collector over RSS/Atom feeds.
 *
 * Conditional requests (ETag / If-Modified-Since). Identity is the feed's
 * GUID/entry id (falling back to the link), revision is a content hash, so a
 * retried poll reuses identities and a changed entry becomes a new immutable
 * event. Removals are not defined by feeds; coverage is honestly declared as
 * `sampled`. The Host owns the timer: `run` is one conditional poll.
 *
 * @module dsh-quno-collector-feed
 */

import type { Context } from '@deepseek-ai/cordis'
import type { EventEnvelope, CollectorDefinition } from '../../dsh-quno/src/types.ts'
import { QunoIngressError } from '../../dsh-quno/src/ingress.ts'
import type { CollectorFactory, CollectorRunContext, CollectorRunOutcome } from '../../dsh-quno/src/collectors.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-quno-collector-feed'

/** Waits for the Quno Host to expose the Collector registry. */
export const inject = ['qunoCollectors']

/** Minimal structural registry face. */
interface CollectorRegistryFace {
  register(definition: unknown, factory: unknown): () => Promise<void>
}

/** The declaration this Collector offers to Quno. */
export const definition: CollectorDefinition = {
  type: 'quno/feed',
  contractVersion: 'quno.collector/v2',
  implementationVersion: '0.1.0',
  displayName: '消息源（RSS/Atom）',
  description: '轮询一个 RSS/Atom 订阅源，用 ETag / Last-Modified 条件请求只取变化，按条目标识与内容修订提交观察。',
  eventTypes: [{ type: 'feed/item', summary: '订阅源条目新增或更新' }],
  configFields: [
    { key: 'url', label: '订阅源地址', type: 'url', required: true, placeholder: 'https://example.com/feed.xml' },
    { key: 'label', label: '显示名', type: 'string', placeholder: '团队动态' },
    { key: 'intervalSec', label: '轮询间隔（秒）', type: 'number', min: 60, step: 60, defaultValue: 300, help: '最小 60 秒' },
    { key: 'maxItems', label: '每次最多条目', type: 'number', min: 1, max: 200, step: 1, defaultValue: 50, advanced: true },
    { key: 'freshnessThresholdSec', label: '陈旧阈值（秒）', type: 'number', min: 60, step: 60, defaultValue: 900, advanced: true },
  ],
  permissions: {
    reads: ['the configured HTTP(S) feed URL'],
    network: ['configured feed URL'],
    requiresModel: false,
  },
  schedule: {
    defaultIntervalSec: 300,
    minIntervalSec: 60,
    maxRunMs: 20_000,
    quotas: { maxEventsPerRun: 100, maxBytesPerRun: 2 * 1024 * 1024 },
  },
  reliability: {
    checkpoint: 'cursor',
    replay: { kind: 'none' },
    changeCoverage: 'sampled',
    gapDetection: 'partial',
    readOriginal: true,
  },
  // The first poll emits everything currently visible in the page that was
  // never seen before; it is not "only what appears from now on".
  firstSync: 'current-window-events',
  defaults: { intervalSec: 300, maxItems: 50, freshnessThresholdSec: 900 },
}

/** Validated configuration. */
interface FeedConfig {
  readonly url: string
  readonly intervalSec: number
  readonly maxItems: number
  readonly label: string | null
}

/** One normalized feed entry. */
interface FeedEntry {
  readonly id: string
  readonly title: string
  readonly link: string | null
  readonly published: number | null
  readonly summary: string | null
  readonly revision: string
}

/** Opaque checkpoint state. */
interface CursorState {
  readonly etag: string | null
  readonly lastModified: string | null
  readonly seen: Record<string, string>
}

/** Validate the instance configuration. */
export function validateConfig(raw: unknown): { readonly ok: true; readonly value: FeedConfig } | { readonly ok: false; readonly message: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, message: '配置必须是对象' }
  const record = raw as Record<string, unknown>
  const url = typeof record['url'] === 'string' ? record['url'].trim() : ''
  if (url === '') return { ok: false, message: '需要配置 url' }
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, message: 'url 必须是 http(s)' }
  } catch {
    return { ok: false, message: 'url 不是合法地址' }
  }
  const intervalSec = numberOr(record['intervalSec'], 300)
  if (intervalSec < 60) return { ok: false, message: 'intervalSec 不能小于 60' }
  const maxItems = Math.min(200, Math.max(1, numberOr(record['maxItems'], 50)))
  return {
    ok: true,
    value: {
      url,
      intervalSec,
      maxItems,
      label: typeof record['label'] === 'string' && record['label'].trim() !== '' ? record['label'].trim() : null,
    },
  }
}

/** Fetch one feed conditionally and normalize it. */
export async function pollFeed(
  config: FeedConfig,
  state: CursorState,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{
  readonly notModified: boolean
  readonly entries: readonly FeedEntry[]
  readonly state: CursorState
  readonly feedTitle: string | null
  readonly gap: string | null
  readonly status: number
}> {
  const headers: Record<string, string> = {
    accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
    'user-agent': 'dsh-quno-collector-feed/0.1 (+https://github.com/aka-danielZhang/oh-my-dsh)',
  }
  if (state.etag !== null) headers['if-none-match'] = state.etag
  if (state.lastModified !== null) headers['if-modified-since'] = state.lastModified
  const response = await fetchImpl(config.url, { headers, signal, redirect: 'follow' })
  if (response.status === 304) {
    return {
      notModified: true,
      entries: [],
      state,
      feedTitle: null,
      gap: null,
      status: 304,
    }
  }
  if (!response.ok) {
    const error = new Error(`feed responded ${String(response.status)}`) as Error & { status?: number; retryAfter?: number }
    error.status = response.status
    const retryAfter = Number(response.headers.get('retry-after') ?? '')
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfter = retryAfter * 1000
    throw error
  }
  const text = await response.text()
  if (text.length > 2 * 1024 * 1024) throw new Error('feed document exceeds 2 MiB')
  const parsed = parseFeed(text)
  const etag = response.headers.get('etag')
  const lastModified = response.headers.get('last-modified')
  const entries = parsed.entries.slice(0, config.maxItems)
  const seen: Record<string, string> = {}
  for (const entry of entries) seen[entry.id] = entry.revision
  return {
    notModified: false,
    entries,
    state: { etag, lastModified, seen },
    feedTitle: parsed.title,
    gap: parsed.total > config.maxItems ? `订阅源共有 ${String(parsed.total)} 条，仅取最近 ${String(config.maxItems)} 条` : null,
    status: response.status,
  }
}

/** Parse RSS 2.0 or Atom into normalized entries. */
export function parseFeed(xml: string): { readonly title: string | null; readonly entries: FeedEntry[]; readonly total: number } {
  const isAtom = /<feed[\s>]/i.test(xml)
  const title = decodeText(firstTag(xml, 'title'))
  const rawEntries = isAtom ? allTags(xml, 'entry') : allTags(xml, 'item')
  const entries = rawEntries.flatMap((block) => {
    const entryTitle = decodeText(firstTag(block, 'title')) ?? '(无标题)'
    const link = isAtom ? attrOfFirstTag(block, 'link', 'href') : decodeText(firstTag(block, 'link'))
    const id = decodeText(firstTag(block, 'id')) ?? decodeText(firstTag(block, 'guid')) ?? link ?? hash(entryTitle)
    const published = parseDate(
      decodeText(firstTag(block, 'published'))
      ?? decodeText(firstTag(block, 'updated'))
      ?? decodeText(firstTag(block, 'pubDate'))
      ?? decodeText(firstTag(block, 'dc:date')),
    )
    const summary = decodeText(firstTag(block, 'summary')) ?? decodeText(firstTag(block, 'description')) ?? decodeText(firstTag(block, 'content'))
    const revision = hash(`${entryTitle}\u0000${link ?? ''}\u0000${String(published)}\u0000${summary ?? ''}`)
    return [{
      id,
      title: entryTitle.slice(0, 300),
      link,
      published,
      summary: summary === null ? null : summary.slice(0, 4000),
      revision,
    }]
  })
  return { title, entries, total: entries.length }
}

function firstTag(xml: string, tag: string): string | null {
  const raw = firstTagRaw(xml, tag)
  return raw === null ? null : stripCdata(raw)
}

function firstTagRaw(xml: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')
  const match = pattern.exec(xml)
  return match?.[1] ?? null
}

function allTags(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi')
  const out: string[] = []
  for (let match = pattern.exec(xml); match !== null && out.length < 500; match = pattern.exec(xml)) {
    out.push(match[1] ?? '')
  }
  return out
}

function attrOfFirstTag(xml: string, tag: string, name: string): string | null {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>`, 'i')
  const match = pattern.exec(xml)
  return match?.[1] === undefined ? null : attrOf(match[1], name)
}

function attrOf(html: string | null, name: string): string | null {
  if (html === null) return null
  const pattern = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')
  const match = pattern.exec(html)
  return match?.[1] === undefined ? null : decodeEntities(match[1])
}

function stripCdata(value: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(value)
  return match?.[1] ?? value
}

function decodeText(value: string | null): string | null {
  if (value === null) return null
  const withoutTags = value.replace(/<[^>]*>/g, ' ')
  const decoded = decodeEntities(withoutTags).replace(/\s+/g, ' ').trim()
  return decoded === '' ? null : decoded
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number(decimal)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

function parseDate(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function hash(value: string): string {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(16)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
}

function parseState(value: string | null): CursorState {
  if (value === null) return { etag: null, lastModified: null, seen: {} }
  try {
    const parsed = JSON.parse(value) as Partial<CursorState>
    return {
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified : null,
      seen: typeof parsed.seen === 'object' && parsed.seen !== null ? parsed.seen : {},
    }
  } catch {
    return { etag: null, lastModified: null, seen: {} }
  }
}

function classify(error: unknown): { readonly state: 'unavailable' | 'auth-required' | 'rate-limited' | 'degraded'; readonly code: string; readonly retryAfterMs: number | null } {
  const status = (error as { status?: number }).status
  if (status === 401 || status === 403) return { state: 'auth-required', code: 'auth-required', retryAfterMs: null }
  if (status === 429) return { state: 'rate-limited', code: 'rate-limited', retryAfterMs: (error as { retryAfter?: number }).retryAfter ?? null }
  if (status !== undefined && status >= 500) return { state: 'unavailable', code: `http-${String(status)}`, retryAfterMs: null }
  return { state: 'degraded', code: 'fetch-failed', retryAfterMs: null }
}

/** One conditional poll of the configured feed. */
async function runOnce(ctx: CollectorRunContext<FeedConfig>): Promise<CollectorRunOutcome> {
  const config = ctx.config
  const startedAt = Date.now()
  const state = parseState(ctx.checkpoint.value)
  const result = await pollFeed(config, state, fetch, ctx.signal)
  if (result.notModified) {
    return {
      ok: true,
      nextRunAtMs: Date.now() + config.intervalSec * 1000,
      health: { coveredThrough: result.state.etag },
    }
  }
  const feedTitle = result.feedTitle
  const envelopes: EventEnvelope[] = result.entries.flatMap((entry) => {
    const previous = state.seen[entry.id]
    if (previous === entry.revision) return []
    return [toEnvelope(entry, config.label ?? feedTitle, previous === undefined)]
  })
  if (envelopes.length > 0) {
    await ctx.commit({
      batchKey: `feed-${String(startedAt)}-${Math.random().toString(36).slice(2, 8)}`,
      events: envelopes,
      checkpointAfter: { value: JSON.stringify(result.state), revision: ctx.checkpoint.revision },
      gap: result.gap === null ? null : { reason: result.gap },
    })
  } else if (result.state.etag !== state.etag || result.state.lastModified !== state.lastModified) {
    // Nothing new: still persist the conditional-request validators so the
    // next poll can 304 instead of re-downloading the document.
    await ctx.commit({
      batchKey: `feed-cursor-${String(startedAt)}-${Math.random().toString(36).slice(2, 8)}`,
      events: [],
      checkpointAfter: { value: JSON.stringify(result.state), revision: ctx.checkpoint.revision },
    })
  }
  const newest = result.entries.reduce<number | null>((latest, entry) => {
    if (entry.published === null) return latest
    return latest === null || entry.published > latest ? entry.published : latest
  }, null)
  return {
    ok: true,
    nextRunAtMs: Date.now() + config.intervalSec * 1000,
    health: {
      coveredThrough: result.state.etag,
      ...(result.gap === null ? {} : { detail: result.gap, issues: [{ code: 'feed-gap', detail: result.gap }] }),
      ...(newest === null ? {} : { sourceLagSec: Math.max(0, Math.round((Date.now() - newest) / 1000)) }),
    },
  }
}

function toEnvelope(entry: FeedEntry, feedName: string | null, isNew: boolean): EventEnvelope {
  const name = feedName ?? '订阅源'
  return {
    eventKey: `${entry.id}:${entry.revision}`,
    type: 'feed/item',
    subject: { key: entry.id, revision: entry.revision, label: entry.title },
    operation: 'upsert',
    occurredAt: entry.published === null ? null : new Date(entry.published).toISOString(),
    observedAt: new Date().toISOString(),
    summary: `${name}${isNew ? '新条目' : '更新'}：${entry.title}`,
    data: {
      feed: name,
      id: entry.id,
      title: entry.title,
      link: entry.link,
      published: entry.published === null ? null : new Date(entry.published).toISOString(),
      summary: entry.summary,
      isNew,
    },
    priority: 'p2',
    deadline: null,
    provenance: { kind: 'observed', collector: 'dsh-quno-collector-feed' },
    correlationKeys: [`feed:${name}`],
  }
}

/** Register the Collector while the plugin is mounted. */
export function apply(ctx: Context): void {
  const registry = ctx.get('qunoCollectors') as unknown as CollectorRegistryFace | undefined
  if (registry === undefined) throw new Error('dsh-quno-collector-feed: qunoCollectors service is not mounted')
  ctx.effect(() => registry.register(definition, factory), 'dsh-quno-collector-feed: registration')
}

/** The collector factory: one run is one conditional poll. */
export const factory: CollectorFactory<FeedConfig> = {
  validateConfig,
  async probe(config) {
    try {
      const response = await fetch(config.url, { method: 'HEAD', redirect: 'follow' })
      if (response.status >= 400 && response.status !== 405) return { ok: false, detail: `订阅源返回 ${String(response.status)}` }
      return { ok: true }
    } catch (error) {
      return { ok: false, detail: (error as Error).message }
    }
  },
  async run(ctx): Promise<CollectorRunOutcome> {
    try {
      return await runOnce(ctx)
    } catch (error) {
      // The generation/lease moved under us: retrying this run can never
      // succeed — stop scheduling until the instance is reconfigured.
      if (error instanceof QunoIngressError
        && (error.shape.code === 'stale-generation' || error.shape.code === 'checkpoint-conflict')) {
        return { ok: false, failure: { state: 'degraded', code: error.shape.code, message: error.message, fatal: true } }
      }
      const classified = classify(error)
      return {
        ok: false,
        failure: {
          state: classified.state,
          code: classified.code,
          message: (error as Error).message,
          retryAfterMs: classified.retryAfterMs,
        },
      }
    }
  },
}

export default { name, inject, apply, definition, factory }
