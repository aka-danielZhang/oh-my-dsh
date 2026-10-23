import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { definition, parseFeed, pollFeed, validateConfig } from '../src/index.ts'

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

test('declaration: poll, cursor checkpoint, sampled coverage', () => {
  assert.equal(definition.reliability.checkpoint, 'cursor')
  assert.equal(definition.reliability.changeCoverage, 'sampled')
  assert.equal(definition.runtime.modes.includes('poll'), true)
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
