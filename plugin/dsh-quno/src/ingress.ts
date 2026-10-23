/**
 * The durable ingress boundary: validate → deduplicate → commit the event
 * batch, its receipt and the collector checkpoint in ONE SQLite transaction,
 * and only then ACK.
 *
 * Rules implemented here (design §6.6, §7.2):
 * - stable `(sourceId, eventKey)` identity; retries return the original id;
 * - same key with different content is an explicit conflict, never an overwrite;
 * - a whole batch is accepted or rejected as a unit (no partial checkpoint);
 * - an ACK is returned only after the commit; a lost ACK replayed with the same
 *   `batchKey` returns the stored receipt;
 * - the checkpoint uses a revision CAS, and a stale Sense generation may not
 *   write at all.
 *
 * @module dsh-quno/ingress
 */

import { contentHashOf, newId, sha256, stableStringify, toMillis } from './util.ts'
import { parseIngestBatch } from './contracts.ts'
import type { QunoStore } from './store.ts'
import type {
  BatchId,
  EventEnvelope,
  EventRecord,
  IngestAck,
  IngestAckItem,
  IngestBatch,
  QunoErrorShape,
  SenseInstanceRecord,
  SourceId,
  SourceRecord,
} from './types.ts'

/** A classified refusal that a Sense may log and retry. */
export class QunoIngressError extends Error {
  constructor(readonly shape: QunoErrorShape) {
    super(shape.message)
    this.name = 'QunoIngressError'
  }
}

/** The restricted write capability one Sense generation holds. */
export interface IngressBinding {
  readonly instance: SenseInstanceRecord
  readonly source: SourceRecord
  readonly generation: number
  readonly configRevision: number
}

/** Hooks the ingress fires after a durable commit (outside the transaction). */
export interface IngressHooks {
  /** A batch committed: route promptly and wake the scheduler. */
  onCommitted?(ack: IngestAck, sourceId: SourceId, accepted: number): void
  /** A detectable upstream gap was reported. */
  onGap?(sourceId: SourceId, reason: string): void
}

/** Restricted ingress implementation shared by every Sense runtime. */
export class QunoIngress {
  constructor(
    private readonly store: QunoStore,
    private readonly qunoId: string,
    private readonly hooks: IngressHooks = {},
  ) {}

  /**
   * Validate and durably accept one batch.
   * @param binding - generation-scoped capability handed to the Sense.
   * @param input - untrusted batch payload.
   * @param now - injectable clock (tests).
   * @returns the durable ACK.
   * @throws {QunoIngressError} for a classified refusal; nothing was committed.
   */
  ingest(binding: IngressBinding, input: unknown, now = Date.now()): IngestAck {
    const parsed = parseIngestBatch(input)
    if (!parsed.ok) {
      throw new QunoIngressError({ ...parsed.error, retryable: false })
    }
    const batch = parsed.value
    const batchHash = sha256(stableStringify({ batch }))
    let fresh: SenseInstanceRecord
    let existing: ReturnType<QunoStore['findBatch']>
    try {
      fresh = this.assertWritable(binding)
      existing = this.store.findBatch(binding.source.id, batch.batchKey)
    } catch (error) {
      if (error instanceof QunoIngressError) throw error
      // The Host could not read its own durable state: refuse to ACK.
      throw new QunoIngressError({
        code: 'temporarily-unavailable',
        message: `event batch could not be accepted: ${(error as Error).message}`,
        retryable: true,
      })
    }
    if (existing !== undefined) {
      if (existing.contentHash !== batchHash) {
        throw new QunoIngressError({
          code: 'identity-conflict',
          message: `batch "${batch.batchKey}" was already committed with different content`,
          retryable: false,
        })
      }
      return this.ackFromStored(batch, existing)
    }

    const current = fresh.checkpoint
    if (batch.checkpointAfter != null && batch.checkpointAfter.revision !== current.revision) {
      throw new QunoIngressError({
        code: 'checkpoint-conflict',
        message: `checkpoint revision ${String(batch.checkpointAfter.revision)} is stale; current is ${String(current.revision)}`,
        retryable: true,
      })
    }

    const statuses: { eventId: string; eventKey: string; status: 'accepted' | 'duplicate' }[] = []
    let acceptedCount = 0
    let duplicateCount = 0
    let batchId: BatchId = ''
    let checkpointRevision = current.revision

    try {
      this.store.transaction(() => {
        batchId = newId('bat')
        let seq = this.store.maxIngestSeq()
        for (const [index, envelope] of batch.events.entries()) {
          const hash = contentHashOf({
            eventKey: envelope.eventKey,
            type: envelope.type,
            eventSchema: envelope.schema,
            summary: envelope.summary,
            data: envelope.data,
            subject: envelope.subject,
            operation: envelope.operation,
            occurredAt: envelope.occurredAt,
            provenance: envelope.provenance,
            deadline: envelope.deadline,
            priority: envelope.priority,
          })
          const priorId = this.store.dbFindEventId(binding.source.id, envelope.eventKey)
          if (priorId !== undefined) {
            const prior = this.store.getEvent(priorId)
            if (prior === undefined || prior.contentHash !== hash) {
              throw new QunoIngressError({
                code: 'identity-conflict',
                message: `event "${envelope.eventKey}" already exists with different content`,
                retryable: false,
                index,
              })
            }
            statuses.push({ eventId: prior.id, eventKey: envelope.eventKey, status: 'duplicate' })
            duplicateCount += 1
            continue
          }
          seq += 1
          const id = newId('evt')
          this.insertEvent(id, binding, envelope, hash, seq, now)
          statuses.push({ eventId: id, eventKey: envelope.eventKey, status: 'accepted' })
          acceptedCount += 1
        }

        if (batch.checkpointAfter != null) {
          checkpointRevision = batch.checkpointAfter.revision + 1
          this.store.updateSenseInstance(binding.instance.id, {
            checkpoint: { value: batch.checkpointAfter.value, revision: checkpointRevision },
            now,
          })
        }
        if (acceptedCount > 0) {
          this.store.updateSenseInstance(binding.instance.id, { lastEventAt: now, now })
        }
        if (batch.gap != null) {
          this.store.setMeta(`gap:${binding.source.id}`, stableStringify({
            at: now,
            reason: batch.gap.reason,
            from: batch.gap.from ?? null,
            to: batch.gap.to ?? null,
          }))
        }
        this.store.dbInsertBatch({
          id: batchId,
          sourceId: binding.source.id,
          generation: binding.generation,
          batchKey: batch.batchKey,
          contentHash: batchHash,
          eventCount: batch.events.length,
          acceptedCount,
          duplicateCount,
          checkpointRevision,
          statuses,
          now,
        })
      })
    } catch (error) {
      if (error instanceof QunoIngressError) throw error
      throw new QunoIngressError({
        code: 'temporarily-unavailable',
        message: `event batch could not be committed: ${(error as Error).message}`,
        retryable: true,
      })
    }

    const ack: IngestAck = {
      batchId,
      batchKey: batch.batchKey,
      accepted: statuses.map((item, index) => ({ index, ...item })),
      eventCount: batch.events.length,
      acceptedCount,
      duplicateCount,
      checkpointRevision,
      gapReported: batch.gap != null,
    }
    if (acceptedCount > 0) this.hooks.onCommitted?.(ack, binding.source.id, acceptedCount)
    if (batch.gap != null) this.hooks.onGap?.(binding.source.id, batch.gap.reason)
    return ack
  }

  private assertWritable(binding: IngressBinding): SenseInstanceRecord {
    const current = this.store.getSenseInstance(binding.instance.id)
    if (current.generation !== binding.generation) {
      throw new QunoIngressError({
        code: 'stale-generation',
        message: `Sense generation ${String(binding.generation)} was superseded by ${String(current.generation)}`,
        retryable: false,
      })
    }
    if (current.desiredState === 'disabled' || current.desiredState === 'paused') {
      throw new QunoIngressError({
        code: 'stale-generation',
        message: `Sense instance is ${current.desiredState}`,
        retryable: false,
      })
    }
    if (current.configRevision !== binding.configRevision) {
      throw new QunoIngressError({
        code: 'stale-generation',
        message: 'Sense configuration changed while a check was running',
        retryable: true,
      })
    }
    return current
  }

  private insertEvent(
    id: string,
    binding: IngressBinding,
    envelope: EventEnvelope,
    hash: string,
    seq: number,
    receivedAt: number,
  ): void {
    this.store.dbInsertEvent({
      id,
      sourceId: binding.source.id,
      eventKey: envelope.eventKey,
      subjectKey: envelope.subject?.key ?? null,
      subjectRevision: envelope.subject?.revision ?? null,
      type: envelope.type,
      schema: envelope.schema ?? 'quno.event/v1',
      operation: envelope.operation ?? 'upsert',
      occurredAt: toMillis(envelope.occurredAt),
      observedAt: toMillis(envelope.observedAt) ?? receivedAt,
      receivedAt,
      ingestSeq: seq,
      summary: envelope.summary ?? null,
      data: envelope.data ?? null,
      priority: envelope.priority ?? 'p2',
      deadline: toMillis(envelope.deadline),
      provenance: envelope.provenance ?? { kind: 'observed' },
      correlationKeys: envelope.correlationKeys ?? [],
      supersedesEventIds: envelope.supersedesEventIds ?? [],
      parentEventIds: envelope.parentEventIds ?? [],
      contentHash: hash,
      senseConfigRevision: binding.configRevision,
      expiresAt: toMillis(envelope.expiresAt),
    })
  }

  private ackFromStored(
    batch: IngestBatch,
    stored: {
      batchId: BatchId
      acceptedCount: number
      duplicateCount: number
      checkpointRevision: number
      statuses: readonly { readonly eventId: string; readonly eventKey: string; readonly status: 'accepted' | 'duplicate' }[]
    },
  ): IngestAck {
    const byKey = new Map(stored.statuses.map(item => [item.eventKey, item]))
    const accepted: IngestAckItem[] = []
    for (const [index, envelope] of batch.events.entries()) {
      const item = byKey.get(envelope.eventKey)
      if (item === undefined) {
        // The receipt says committed but this envelope is not part of it.
        throw new QunoIngressError({
          code: 'identity-conflict',
          message: `batch receipt does not cover event "${envelope.eventKey}"`,
          retryable: false,
          index,
        })
      }
      accepted.push({ index, eventId: item.eventId, eventKey: item.eventKey, status: item.status })
    }
    return {
      batchId: stored.batchId,
      batchKey: batch.batchKey,
      accepted,
      eventCount: batch.events.length,
      acceptedCount: stored.acceptedCount,
      duplicateCount: stored.duplicateCount,
      checkpointRevision: stored.checkpointRevision,
      gapReported: batch.gap != null,
    }
  }
}

/** Read the last recorded gap for one source (health view). */
export function readGapReport(store: QunoStore, sourceId: SourceId): {
  at: number
  reason: string
  from: string | null
  to: string | null
} | undefined {
  const raw = store.getMeta(`gap:${sourceId}`)
  if (raw === undefined) return undefined
  return JSON.parse(raw) as { at: number; reason: string; from: string | null; to: string | null }
}

/** Export for tests that need the event lookup without opening a private field. */
export type IngressRecord = EventRecord
