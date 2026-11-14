import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { definition, factory, ingressRefusalOf, parseFeed, pollFeed, validateConfig } from '../src/index.ts'
import type { CollectorRunContext } from '../../dsh-quno/src/collectors.ts'
import type { IngestAck, IngestBatch } from '../../dsh-quno/src/types.ts'

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>团队动态</title>
<item><guid>m1</guid><title>评审改期到 10:00</title><link>https://example.com/m1</link><pubDate>Fri, 23 Oct 2026 01:00:00 GMT</pubDate><description>请确认时间</description></item>
<item><guid>m2</guid><title>材料周五截止</title><link>https://example.com/m2</link><pubDate>Thu, 22 Oct 2026 01:00:00 GMT</pubDate></item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 源</title>
<entry><id>urn:a1</id><title>新计划</title><link href="https://example.com/a1"/><updated>2026-10-23T01:00:00Z</updated><summary>摘要</summary></entry>
</feed>`

test('declaration: Host-scheduled, cursor checkpoint, sampled coverage', () => {
  assert.equal(definition.reliability.checkpoint, 'cursor')
  assert.equal(definition.reliability.changeCoverage, 'sampled')
  assert.equal(definition.schedule.defaultIntervalSec >= definition.schedule.minIntervalSec, true)
})

test('parseFeed: RSS entries keep guid identity and dates', () => {
  const parsed = parseFeed(RSS)
  assert.equal(parsed.title, '团队动态')
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0]?.id, 'm1')
  assert.equal(parsed.entries[0]?.title, '评审改期到 10:00')
  assert.equal(parsed.entries[0]?.link, 'https://example.com/m1')
  assert.equal(parsed.entries[0]?.published, Date.parse('Fri, 23 Oct 2026 01:00:00 GMT'))
})

test('parseFeed: Atom entries use id + href link', () => {
  const parsed = parseFeed(ATOM)
  assert.equal(parsed.title, 'Atom 源')
  assert.equal(parsed.entries.length, 1)
  assert.equal(parsed.entries[0]?.id, 'urn:a1')
  assert.equal(parsed.entries[0]?.link, 'https://example.com/a1')
})

test('validateConfig: URL and interval floor', () => {
  assert.equal(validateConfig({}).ok, false)
  assert.equal(validateConfig({ url: 'ftp://x' }).ok, false)
  assert.equal(validateConfig({ url: 'https://example.com/feed', intervalSec: 5 }).ok, false)
  assert.equal(validateConfig({ url: 'https://example.com/feed', intervalSec: 60 }).ok, true)
})

test('pollFeed: conditional request returns notModified on 304', async () => {
  const server = createServer((request, response) => {
    if (request.headers['if-none-match'] === '"v1"') {
      response.writeHead(304)
      response.end()
      return
    }
    response.writeHead(200, { etag: '"v1"' })
    response.end(RSS)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const config = validateConfig({ url: `http://127.0.0.1:${port}/feed`, intervalSec: 60 })
    assert.ok(config.ok)
    const first = await pollFeed(config.value, { etag: null, lastModified: null, seen: {} })
    assert.equal(first.notModified, false)
    assert.equal(first.entries.length, 2)
    assert.equal(first.state.etag, '"v1"')
    const second = await pollFeed(config.value, first.state)
    assert.equal(second.notModified, true)
  } finally {
    server.close()
  }
})

test('pollFeed: 429 is classified for the health reporter', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(429, { 'retry-after': '30' })
    response.end('slow down')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const config = validateConfig({ url: `http://127.0.0.1:${port}/feed`, intervalSec: 60 })
    assert.ok(config.ok)
    await assert.rejects(() => pollFeed(config.value, { etag: null, lastModified: null, seen: {} }), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 429)
      return true
    })
  } finally {
    server.close()
  }
})

test('parseFeed: entity decoding and CDATA', () => {
  const parsed = parseFeed(`<rss><channel><title>A &amp; B</title>
<item><guid>1</guid><title><![CDATA[Hello <b>world</b>]]></title><description>x &lt; y</description></item>
</channel></rss>`)
  assert.equal(parsed.title, 'A & B')
  assert.equal(parsed.entries[0]?.title, 'Hello world')
  assert.equal(parsed.entries[0]?.summary, 'x < y')
})

/* ------------------------------------------------- run(ctx) (Host-scheduled) */

type FeedConfig = Extract<ReturnType<typeof validateConfig>, { ok: true }>['value']

function ack(batch: IngestBatch, revision: number): IngestAck {
  return {
    batchId: `bat-${String(revision)}`,
    batchKey: batch.batchKey,
    accepted: [],
    eventCount: batch.events.length,
    acceptedCount: batch.events.length,
    duplicateCount: 0,
    checkpointRevision: revision,
    gapReported: batch.gap != null,
  }
}

type RunLimits = CollectorRunContext<FeedConfig>['limits']

/** The Host's real per-batch limits (contracts LIMITS) plus the declared per-run quota. */
const HOST_LIMITS: RunLimits = { maxEventsPerRun: 100, maxBytesPerRun: 2 * 1024 * 1024, maxEventsPerBatch: 100, maxBytesPerBatch: 1024 * 1024 }

function runCtx(
  config: FeedConfig,
  commit: (batch: IngestBatch) => Promise<IngestAck>,
  checkpoint: { readonly value: string | null; readonly revision: number } = { value: null, revision: 0 },
  limits: Partial<RunLimits> = {},
): CollectorRunContext<FeedConfig> {
  return {
    instanceId: 'col-feed',
    sourceId: 'src-feed',
    type: 'quno/feed',
    config,
    runId: 1,
    checkpoint,
    limits: { ...HOST_LIMITS, ...limits },
    logger: { info: () => {}, warn: () => {} },
    signal: new AbortController().signal,
    commit,
  }
}

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ readonly url: string; close(): void }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${String(port)}/feed`, close: () => { server.close() } }
}

test('run: 200 commits entries; a changed validator alone commits an empty cursor batch; 304 commits nothing', async () => {
  // v1 → full document; v1 revalidation → same entries under a new ETag; v2 → 304.
  const feed = await serve((request, response) => {
    const tag = request.headers['if-none-match']
    if (tag === '"v2"') {
      response.writeHead(304)
      response.end()
      return
    }
    response.writeHead(200, { etag: tag === '"v1"' ? '"v2"' : '"v1"' })
    response.end(RSS)
  })
  try {
    const config = validateConfig({ url: feed.url, intervalSec: 60 })
    assert.ok(config.ok)
    const batches: IngestBatch[] = []
    const commit = async (batch: IngestBatch): Promise<IngestAck> => {
      batches.push(batch)
      return ack(batch, batches.length)
    }
    const first = await factory.run(runCtx(config.value, commit))
    assert.equal(first.ok, true)
    assert.equal(batches.length, 1)
    assert.equal(batches[0]?.events.length, 2)
    assert.equal(first.ok && first.health?.coveredThrough, '"v1"')

    const second = await factory.run(runCtx(config.value, commit, { value: batches[0]?.checkpointAfter?.value ?? null, revision: 1 }))
    assert.equal(second.ok, true)
    assert.equal(batches.length, 2, 'a new validator is persisted even with nothing new')
    assert.equal(batches[1]?.events.length, 0)
    const cursor = JSON.parse(String(batches[1]?.checkpointAfter?.value)) as { etag?: string }
    assert.equal(cursor.etag, '"v2"', 'the cursor batch carries the new ETag so the next poll can 304')

    const third = await factory.run(runCtx(config.value, commit, { value: batches[1]?.checkpointAfter?.value ?? null, revision: 2 }))
    assert.equal(third.ok, true)
    assert.equal(batches.length, 2, 'a 304 commits nothing')
    assert.equal(third.ok && third.health?.coveredThrough, '"v2"')
  } finally {
    feed.close()
  }
})

test('run: a 429 Retry-After becomes the Host retry delay', async () => {
  const feed = await serve((_request, response) => {
    response.writeHead(429, { 'retry-after': '30' })
    response.end('slow down')
  })
  try {
    const config = validateConfig({ url: feed.url, intervalSec: 60 })
    assert.ok(config.ok)
    const outcome = await factory.run(runCtx(config.value, async () => assert.fail('nothing to commit')))
    assert.ok(!outcome.ok)
    assert.equal(outcome.failure.state, 'rate-limited')
    assert.equal(outcome.failure.retryAfterMs, 30_000)
    assert.equal(outcome.failure.fatal, undefined)
  } finally {
    feed.close()
  }
})

test('run: a fenced commit is read structurally and stops scheduling', async () => {
  const feed = await serve((_request, response) => {
    response.writeHead(200, { etag: '"v1"' })
    response.end(RSS)
  })
  try {
    const config = validateConfig({ url: feed.url, intervalSec: 60 })
    assert.ok(config.ok)
    const fenced = Object.assign(new Error('fenced'), { name: 'QunoIngressError', shape: { code: 'stale-generation', message: 'fenced', retryable: false } })
    const outcome = await factory.run(runCtx(config.value, async () => { throw fenced }))
    assert.ok(!outcome.ok)
    assert.equal(outcome.failure.fatal, true)
    assert.equal(outcome.failure.code, 'stale-generation')
    assert.equal(ingressRefusalOf(new Error('fetch failed')), null)
  } finally {
    feed.close()
  }
})

/** An RSS document with one item per id. */
function rssWith(ids: readonly string[]): string {
  const items = ids.map((id, index) => `<item><guid>${id}</guid><title>条目 ${id}</title><link>https://example.com/${id}</link><pubDate>${new Date(Date.UTC(2026, 10, 1 + index)).toUTCString()}</pubDate></item>`).join('')
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>预算源</title>${items}</channel></rss>`
}

test('run: entries beyond the run budget keep the old validators, so the next poll resumes instead of a 304', async () => {
  const requests: (string | undefined)[] = []
  const feed = await serve((request, response) => {
    const tag = request.headers['if-none-match']
    requests.push(typeof tag === 'string' ? tag : undefined)
    if (tag === '"v1"') {
      response.writeHead(304)
      response.end()
      return
    }
    response.writeHead(200, { etag: '"v1"' })
    response.end(rssWith(['m1', 'm2', 'm3', 'm4', 'm5']))
  })
  try {
    const config = validateConfig({ url: feed.url, intervalSec: 60 })
    assert.ok(config.ok)
    const batches: IngestBatch[] = []
    const commit = async (batch: IngestBatch): Promise<IngestAck> => {
      batches.push(batch)
      return ack(batch, batches.length)
    }
    const checkpoint = (): { value: string | null; revision: number } => ({ value: batches.at(-1)?.checkpointAfter?.value ?? null, revision: batches.length })
    const committedIds = (): string[] => batches.flatMap(batch => batch.events.map(event => (event.data as { id: string }).id))
    const budget = { maxEventsPerRun: 3, maxEventsPerBatch: 2 }

    const first = await factory.run(runCtx(config.value, commit, checkpoint(), budget))
    assert.ok(first.ok)
    assert.deepEqual(batches.map(batch => batch.events.length), [2, 1])
    const partial = JSON.parse(checkpoint().value ?? '{}') as { etag: string | null; seen: Record<string, string> }
    assert.equal(partial.etag, null, 'an incomplete change set must not advance the ETag')
    assert.deepEqual(Object.keys(partial.seen).sort(), committedIds().sort())
    assert.equal((first.health?.progress as { pendingEntries?: number } | undefined)?.pendingEntries, 2)
    assert.ok(first.nextRunAtMs !== undefined && first.nextRunAtMs - Date.now() < 10_000)

    const second = await factory.run(runCtx(config.value, commit, checkpoint(), budget))
    assert.ok(second.ok)
    assert.equal(requests[1], undefined, 'the resumed poll is unconditional, so the server cannot answer 304')
    assert.equal((JSON.parse(checkpoint().value ?? '{}') as { etag: string | null }).etag, '"v1"', 'the completing batch advances the ETag')
    assert.deepEqual(committedIds().sort(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'every entry is committed exactly once')

    const third = await factory.run(runCtx(config.value, commit, checkpoint(), budget))
    assert.ok(third.ok)
    assert.equal(requests[2], '"v1"')
    assert.equal(batches.length, 3, 'only now does the feed answer 304 and commit nothing')
  } finally {
    feed.close()
  }
})
