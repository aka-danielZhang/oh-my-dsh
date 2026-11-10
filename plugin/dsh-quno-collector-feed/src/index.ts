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
  implementationVersion: '0.2.0',
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

/** Host refusals after which retrying this run is pointless: the instance moved on. */
const FATAL_REFUSALS: ReadonlySet<string> = new Set(['stale-generation', 'checkpoint-conflict'])

/**
 * Structurally read a Host ingest refusal. This plugin never value-imports
 * the Host's `QunoIngressError`: an installed tarball bundles its own copy, so
 * `instanceof` against it would always be false. The commit face rejects with
 * an Error named `QunoIngressError` carrying `shape.{code,retryable}`.
 */
export function ingressRefusalOf(error: unknown): { readonly code: string; readonly message: string; readonly retryable: boolean } | null {
  if (!(error instanceof Error) || error.name !== 'QunoIngressError') return null
  const shape = (error as { shape?: { code?: unknown; retryable?: unknown } }).shape
  if (typeof shape?.code !== 'string') return null
  return { code: shape.code, message: error.message, retryable: shape.retryable === true }
}

/** A backlog that did not fit one run resumes this soon (the Host floor is 1s). */
const CONTINUATION_MS = 5_000

/** Per-batch headroom for the envelope wrapper beyond the events and the checkpoint. */
const BATCH_OVERHEAD_BYTES = 4 * 1024

/**
 * One conditional poll of the configured feed.
 *
 * New or changed entries are committed in batches that fit the Host's
 * per-batch limits, up to the run's own budget. The conditional-request
 * validators (ETag / Last-Modified) advance ONLY with the last batch of a
 * fully committed change set: if they advanced earlier, the next poll would
 * be answered 304 and the entries this run could not commit would be lost.
 * Intermediate batches record the committed entries in `seen` and keep the
 * previous validators, so the next poll re-downloads and resumes.
 */
async function runOnce(ctx: CollectorRunContext<FeedConfig>): Promise<CollectorRunOutcome> {
  const config = ctx.config
  const startedAt = Date.now()
  const runKey = `feed-${String(startedAt)}-${Math.random().toString(36).slice(2, 8)}`
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
  const pending = result.entries.flatMap((entry) => {
    const previous = state.seen[entry.id]
    if (previous === entry.revision) return []
    const envelope = toEnvelope(entry, config.label ?? feedTitle, previous === undefined)
    return [{ entry, envelope, bytes: Buffer.byteLength(JSON.stringify(envelope), 'utf8') }]
  })
  const limits = ctx.limits
  const seen: Record<string, string> = { ...state.seen }
  // Upper bound of every checkpoint this run can write.
  const reserve = Buffer.byteLength(JSON.stringify({ ...result.state, seen: { ...state.seen, ...result.state.seen } }), 'utf8') + BATCH_OVERHEAD_BYTES
  let revision = ctx.checkpoint.revision
  let emitted = 0
  let runBytes = 0
  let batch = 0
  while (emitted < pending.length && emitted < limits.maxEventsPerRun) {
    const chunk: typeof pending = []
    let chunkBytes = 0
    for (const candidate of pending.slice(emitted)) {
      if (emitted + chunk.length >= limits.maxEventsPerRun || chunk.length >= limits.maxEventsPerBatch) break
      if (reserve + chunkBytes + candidate.bytes > limits.maxBytesPerBatch) break
      if (runBytes + chunkBytes + candidate.bytes > limits.maxBytesPerRun) break
      chunk.push(candidate)
      chunkBytes += candidate.bytes
    }
    if (chunk.length === 0) {
      if (emitted > 0) break // the run's byte budget is spent; the rest waits
      return {
        ok: false,
        failure: {
          state: 'degraded',
          code: 'batch-too-large',
          message: `单个条目（${String(pending[0]?.bytes ?? 0)} 字节）放不进一个批次（上限 ${String(limits.maxBytesPerBatch)} 字节，含检查点 ${String(reserve)} 字节）`,
        },
      }
    }
    for (const item of chunk) seen[item.entry.id] = item.entry.revision
    const complete = emitted + chunk.length === pending.length
    const cursor: CursorState = complete ? result.state : { etag: state.etag, lastModified: state.lastModified, seen }
    const ack = await ctx.commit({
      batchKey: `${runKey}-${String(batch)}`,
      events: chunk.map(item => item.envelope),
      checkpointAfter: { value: JSON.stringify(cursor), revision },
      gap: batch === 0 && result.gap !== null ? { reason: result.gap } : null,
    })
    revision = ack.checkpointRevision
    emitted += chunk.length
    runBytes += chunkBytes
    batch += 1
  }
  if (pending.length === 0 && (result.state.etag !== state.etag || result.state.lastModified !== state.lastModified)) {
    // Nothing new: still persist the conditional-request validators so the
    // next poll can 304 instead of re-downloading the document.
    await ctx.commit({
      batchKey: `${runKey}-cursor`,
      events: [],
      checkpointAfter: { value: JSON.stringify(result.state), revision },
    })
  }
  const deferred = pending.length - emitted
  const newest = result.entries.reduce<number | null>((latest, entry) => {
    if (entry.published === null) return latest
    return latest === null || entry.published > latest ? entry.published : latest
  }, null)
  const detail = [
    ...(result.gap === null ? [] : [result.gap]),
    ...(deferred > 0 ? [`${String(deferred)} 个条目超出单次运行上限，下一次运行继续`] : []),
  ]
  return {
    ok: true,
    nextRunAtMs: Date.now() + (deferred > 0 ? CONTINUATION_MS : config.intervalSec * 1000),
    health: {
      coveredThrough: deferred > 0 ? state.etag : result.state.etag,
      ...(detail.length === 0 ? {} : { detail: detail.join('；') }),
      ...(result.gap === null ? {} : { issues: [{ code: 'feed-gap', detail: result.gap }] }),
      ...(newest === null ? {} : { sourceLagSec: Math.max(0, Math.round((Date.now() - newest) / 1000)) }),
      // Queued entries are progress, not a fault.
      ...(deferred > 0 ? { progress: { pendingEntries: deferred } } : {}),
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
      const refusal = ingressRefusalOf(error)
      if (refusal !== null) {
        // The generation/lease moved under us: retrying this run can never
        // succeed — stop scheduling until the instance is reconfigured.
        if (FATAL_REFUSALS.has(refusal.code)) {
          return { ok: false, failure: { state: 'degraded', code: refusal.code, message: refusal.message, fatal: true } }
        }
        return {
          ok: false,
          failure: { state: refusal.retryable ? 'unavailable' : 'degraded', code: refusal.code, message: refusal.message },
        }
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
