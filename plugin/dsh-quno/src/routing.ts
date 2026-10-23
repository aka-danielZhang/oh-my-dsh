/**
 * Routing: turn the immutable event log into per-Quno deliveries.
 *
 * The log is written once; each subscription gets its own delivery row, and
 * the routing watermark advances in the SAME transaction as those inserts.
 * A crash between receipt and routing therefore replays the scan instead of
 * losing the event (design §7.3).
 *
 * @module dsh-quno/routing
 */

import { effectivePriority } from './selection.ts'
import type { QunoStore } from './store.ts'
import type { EventRecord, SubscriptionFilter, SubscriptionRecord } from './types.ts'

const SCAN_PAGE = 500

/** One routing pass result. */
export interface RouteResult {
  readonly scanned: number
  readonly inserted: number
}

/** Advance one Quno's routing cursor over newly received events. */
export class Router {
  constructor(
    private readonly store: QunoStore,
    private readonly qunoId: string,
    private readonly logger?: { warn: (message: string) => void },
  ) {}

  /**
   * Route every event after the stored cursor.
   * @param now - injectable clock (delivery eligibility).
   * @returns how many events were scanned and how many deliveries inserted.
   */
  route(now = Date.now()): RouteResult {
    const subscriptions = this.store.listSubscriptions(this.qunoId)
    if (subscriptions.length === 0) return { scanned: 0, inserted: 0 }
    const maxSeq = this.store.maxIngestSeq()
    let cursor = this.store.routingCursor(this.qunoId)
    if (maxSeq <= cursor) return { scanned: 0, inserted: 0 }
    let scanned = 0
    let inserted = 0
    while (cursor < maxSeq) {
      const events = this.store.listEventsAfter(cursor, SCAN_PAGE)
      if (events.length === 0) break
      const lastSeq = events[events.length - 1]?.ingestSeq ?? cursor
      inserted += this.store.transaction(() => {
        let count = 0
        for (const event of events) {
          for (const subscription of subscriptions) {
            if (!matches(subscription, event)) continue
            const ok = this.store.insertDelivery({
              qunoId: this.qunoId,
              eventId: event.id,
              priority: effectivePriority(event, now),
              eligibleAt: now,
              now,
            })
            if (ok) count += 1
          }
        }
        this.store.advanceRouting(this.qunoId, lastSeq)
        return count
      })
      scanned += events.length
      cursor = lastSeq
    }
    return { scanned, inserted }
  }
}

/** Whether one subscription accepts one event. */
export function matches(subscription: SubscriptionRecord, event: EventRecord): boolean {
  if (subscription.sourceId !== event.sourceId) return false
  // A subscription created "from now" never backfills.
  if (event.ingestSeq <= subscription.startIngestSeq) return false
  return matchesFilter(subscription.filter, event, subscription.startIngestSeq)
}

/** Apply the deterministic filter vocabulary. */
export function matchesFilter(filter: SubscriptionFilter, event: EventRecord, startIngestSeq: number): boolean {
  void startIngestSeq
  if (filter.types !== undefined && filter.types.length > 0 && !filter.types.includes(event.type)) return false
  if (filter.operations !== undefined && filter.operations.length > 0 && !filter.operations.includes(event.operation)) return false
  if (filter.subjectKeys !== undefined && filter.subjectKeys.length > 0) {
    if (event.subjectKey === null || !filter.subjectKeys.includes(event.subjectKey)) return false
  }
  if (filter.correlationKeys !== undefined && filter.correlationKeys.length > 0) {
    const wanted = new Set(filter.correlationKeys)
    if (!event.correlationKeys.some(key => wanted.has(key))) return false
  }
  if (filter.summaryIncludes !== undefined && filter.summaryIncludes.length > 0) {
    const summary = (event.summary ?? '').toLowerCase()
    if (!filter.summaryIncludes.some(needle => summary.includes(needle.toLowerCase()))) return false
  }
  if (filter.priorityAtLeast !== undefined) {
    const rank = { p0: 0, p1: 1, p2: 2, p3: 3 } as const
    if (rank[event.priority] > rank[filter.priorityAtLeast]) return false
  }
  if (filter.sourceIds !== undefined && filter.sourceIds.length > 0 && !filter.sourceIds.includes(event.sourceId)) {
    return false
  }
  return true
}
