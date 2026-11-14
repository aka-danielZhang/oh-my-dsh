import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { EventDetailWire, EventWire, NoticeDetailWire, QunoWireState } from '../src/api-types.ts'
import { QunoClientStore, type QunoRemoteFace } from '../src/client/store.ts'

const ok = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })
/** A carrier failure; only the shape the store reads is meaningful here. */
const failed = <T,>(message: string): RemoteResult<T> =>
  ({ ok: false, error: { code: 'unavailable', message } }) as unknown as RemoteResult<T>

const wireState = {} as QunoWireState

function remote(overrides: Partial<QunoRemoteFace>): QunoRemoteFace {
  const base: QunoRemoteFace = {
    state: async () => ok(wireState),
    ensureMain: async () => ok({ sessionId: 'main-1', state: 'ok', created: false }),
    updateConfig: async () => ok(wireState),
    updateProfile: async () => ok(wireState),
    actAttention: async () => ok(wireState),
    checkNow: async () => ok({ kind: 'idle', at: 0 }),
    createCollector: async () => ok(wireState),
    collectorCommand: async () => ok(wireState),
    probeCollector: async () => ok({ ok: true, code: 'ok', message: '', at: 0, durationMs: 1 }),
    collectorOptions: async () => ok({ ok: true, options: [], more: false }),
    noticeDetail: async () => ok(null),
    eventDetail: async () => ok(null),
    taskCommand: async () => ok(wireState),
    workerDetail: async () => ok({ ticketId: 't1', title: 'T', status: 'done', executorSessionId: null, canStop: false, canRetry: false }),
    mute: async () => ok(wireState),
    eventsRecent: async () => ok({ events: [] }),
  }
  return { ...base, ...overrides }
}

const event = (id: string): EventWire => ({
  id,
  sourceId: 'source-1',
  type: 'feed/item',
  operation: 'upsert',
  subjectKey: null,
  summary: id,
  occurredAt: null,
  receivedAt: 0,
  ingestSeq: 1,
  pruned: false,
})

const eventDetail = (id: string): EventDetailWire => ({
  id,
  sourceId: 'source-1',
  instanceId: 'instance-1',
  type: 'feed/item',
  operation: 'upsert',
  subjectKey: null,
  subjectRevision: null,
  summary: id,
  occurredAt: null,
  receivedAt: 0,
  ingestSeq: 1,
  pruned: false,
  provenance: 'test',
  data: null,
  dataTruncated: false,
  attachments: [],
})

const noticeDetail = (id: string): NoticeDetailWire => ({
  id,
  topicKey: 'k',
  kind: 'report',
  status: 'delivered',
  reason: null,
  title: id,
  summary: '',
  body: '',
  why: '',
  itemIds: [],
  items: [],
  eligibleAt: 0,
  createdAt: 0,
  messageId: null,
  attempts: 1,
  expired: false,
})

test('a failed events read marks the list stale but never empties it', async () => {
  let fail = false
  const store = new QunoClientStore(remote({
    eventsRecent: async () => fail ? failed('offline') : ok({ events: [event('e1')] }),
  }))
  await store.refresh()
  assert.equal(store.getSnapshot().eventsStatus, 'ready')
  assert.equal(store.getSnapshot().events.length, 1)

  fail = true
  await store.refresh()
  const stale = store.getSnapshot()
  assert.equal(stale.eventsStatus, 'error')
  assert.equal(stale.events.length, 1, 'the previous list survives a failed read')
  assert.match(stale.eventsError ?? '', /offline/)
})

test('a failed detail read is an error, a null answer is missing', async () => {
  const store = new QunoClientStore(remote({
    eventDetail: async ({ eventId }) => {
      if (eventId === 'bad') return failed('boom')
      if (eventId === 'gone') return ok(null)
      return ok(eventDetail(eventId))
    },
  }))

  const bad = await store.loadEventDetail('bad')
  assert.equal(bad.status, 'error')
  assert.match(bad.status === 'error' ? bad.message : '', /boom/)

  const gone = await store.loadEventDetail('gone')
  assert.equal(gone.status, 'missing')

  const good = await store.loadEventDetail('fine')
  assert.equal(good.status, 'ready')
  assert.equal(good.status === 'ready' ? good.data.id : '', 'fine')
})

test('a stale detail answer never overwrites a newer one', async () => {
  let releaseFirst: ((value: RemoteResult<NoticeDetailWire | null>) => void) | undefined
  let calls = 0
  const store = new QunoClientStore(remote({
    noticeDetail: async ({ notificationId }) => {
      if (notificationId !== 'target') return ok(noticeDetail(notificationId))
      calls += 1
      if (calls === 1) {
        // The first read hangs until after the cache has been evicted and the
        // record has been requested again.
        return await new Promise<RemoteResult<NoticeDetailWire | null>>((resolve) => {
          releaseFirst = resolve
        })
      }
      return ok(noticeDetail('fresh'))
    },
  }))

  const first = store.loadNoticeDetail('target')
  // Push the first entry out of the 40-entry bounded cache.
  for (let index = 0; index < 41; index += 1) await store.loadNoticeDetail(`filler-${String(index)}`)
  assert.equal(store.getSnapshot().noticeDetails['target'], undefined, 'the first entry was evicted')

  const second = await store.loadNoticeDetail('target')
  assert.equal(second.status, 'ready')
  releaseFirst?.(ok(noticeDetail('stale')))
  await first

  const settled = store.getSnapshot().noticeDetails['target']
  assert.equal(settled?.status, 'ready')
  assert.equal(settled?.status === 'ready' ? settled.data.title : '', 'fresh')
})

test('the polled state survives a failed refresh and reports the error', async () => {
  let fail = false
  const store = new QunoClientStore(remote({
    state: async () => fail ? failed('state down') : ok(wireState),
  }))
  await store.refresh()
  assert.equal(store.getSnapshot().phase, 'ready')

  fail = true
  await store.refresh()
  const snap = store.getSnapshot()
  assert.equal(snap.phase, 'ready', 'a loaded state keeps the panel usable')
  assert.equal(snap.state, wireState)
  assert.match(snap.error ?? '', /state down/)
})
