/**
 * SQLite implementation of the domain persistence port.
 *
 * The domain Engine never sees SQL. This adapter is the only place that maps
 * domain records to rows, and it keeps every command inside the enclosing
 * transaction owned by the caller (`QunoStore.transaction`). Two invariants
 * are load-bearing here:
 *
 * - identity is the fact: `(source_id, event_key)`, `(ticket_id, thread_id)`,
 *   `(kind, key)` for effects and `(exchange_id, kind, content_hash)` for
 *   exchange messages are unique keys, never "latest wins";
 * - stale writes are refused: effect completion and failure compare
 *   `(seq, generation)`, so an old execution can never overwrite newer intent.
 *
 * @module dsh-quno/app/store
 */

import type { DatabaseSync } from 'node:sqlite'
import type { QunoStore } from '../store.ts'
import { threadRowId } from '../core/model.ts'
import type {
  AssignmentRecord,
  AttentionLink,
  DecisionId,
  DecisionRecord,
  EffectKind,
  EffectRecord,
  EvalRecord,
  EvalStatus,
  ExchangeId,
  ExchangeMessageRecord,
  ExchangeRecord,
  ExchangeStatus,
  InputAttemptRecord,
  InputId,
  SubscriptionRecord,
  ThreadId,
  ThreadRecord,
  TicketId,
  TicketInputRecord,
  TicketRecord,
  TriggerId,
  TriggerRecord,
  WorkerRunRecord,
  WorkerRunStatus,
} from '../core/model.ts'
import type {
  DomainRepository,
  EffectInput,
  EvalFilter,
  InputFilter,
  TicketFilter,
} from '../core/repository.ts'

/** One row as node:sqlite returns it. */
type Row = Record<string, unknown>

function toJson(value: unknown): string {
  if (value === undefined) return 'null'
  try {
    return JSON.stringify(value)
  } catch {
    return 'null'
  }
}

function fromJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asBool(value: unknown): boolean {
  return value === 1 || value === true
}

/** SQLite-backed DomainRepository over one open QunoStore. */
export class SqliteRepository implements DomainRepository {
  constructor(private readonly store: QunoStore) {}

  private get db(): DatabaseSync {
    return this.store.handle()
  }

  transaction<T>(work: () => T): T {
    return this.store.transaction(work)
  }

  // ------------------------------------------------------------- triggers

  private triggerSelect(): string {
    return `SELECT id, quno_id AS qunoId, source_id AS sourceId, event_key AS eventKey, type, schema,
      operation, occurred_at AS occurredAt, observed_at AS observedAt, received_at AS receivedAt,
      summary, data_json AS dataJson, priority, deadline,
      correlation_keys_json AS correlationKeysJson, supersedes_json AS supersedesJson,
      parents_json AS parentsJson, provenance_json AS provenanceJson, content_hash AS contentHash,
      sense_config_revision AS configRevision, expires_at AS expiresAt, pruned_at AS prunedAt,
      actor_json AS actorJson, human, addressed, channel_json AS channelJson,
      content_ref_json AS contentRefJson, threads_json AS threadsJson
      FROM events`
  }

  private triggerFromRow(row: Row): TriggerRecord {
    let threads = fromJson<{ source: string; id: string }[]>(row['threadsJson'], [])
    if (threads.length === 0) {
      threads = this.db
        .prepare(`SELECT t.source_id AS source, t.thread_key AS id
          FROM trigger_threads tt JOIN threads t ON t.id = tt.thread_id
          WHERE tt.trigger_id = ? ORDER BY tt.ordinal`)
        .all(String(row['id'])) as { source: string; id: string }[]
    }
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      sourceId: String(row['sourceId']),
      eventKey: String(row['eventKey']),
      type: String(row['type']),
      schema: String(row['schema']),
      threads,
      actor: fromJson(row['actorJson'], { source: 'unknown', id: '' }),
      human: asBool(row['human']),
      addressed: row['addressed'] === 'mention' || row['addressed'] === 'direct' ? row['addressed'] : null,
      occurredAt: asNumber(row['occurredAt']),
      observedAt: Number(row['observedAt']),
      receivedAt: Number(row['receivedAt']),
      summary: asString(row['summary']),
      data: fromJson<unknown>(row['dataJson'], null),
      contentRef: fromJson(row['contentRefJson'], null),
      channel: fromJson(row['channelJson'], null),
      operation: String(row['operation']) as TriggerRecord['operation'],
      priority: String(row['priority']) as TriggerRecord['priority'],
      deadline: asNumber(row['deadline']),
      correlationKeys: fromJson<string[]>(row['correlationKeysJson'], []),
      supersedesTriggerIds: fromJson<string[]>(row['supersedesJson'], []),
      parentTriggerIds: fromJson<string[]>(row['parentsJson'], []),
      provenance: fromJson(row['provenanceJson'], { kind: 'observed' }),
      contentHash: String(row['contentHash']),
      configRevision: Number(row['configRevision']),
      expiresAt: asNumber(row['expiresAt']),
      prunedAt: asNumber(row['prunedAt']),
    }
  }

  findTrigger(sourceId: string, eventKey: string): TriggerRecord | undefined {
    const row = this.db.prepare(`${this.triggerSelect()} WHERE source_id = ? AND event_key = ?`).get(sourceId, eventKey) as Row | undefined
    return row === undefined ? undefined : this.triggerFromRow(row)
  }

  getTrigger(id: TriggerId): TriggerRecord | undefined {
    const row = this.db.prepare(`${this.triggerSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.triggerFromRow(row)
  }

  getTriggers(ids: readonly TriggerId[]): readonly TriggerRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`${this.triggerSelect()} WHERE id IN (${placeholders})`).all(...ids) as Row[]
    const byId = new Map(rows.map(row => [String(row['id']), this.triggerFromRow(row)]))
    return ids.flatMap(id => {
      const record = byId.get(id)
      return record === undefined ? [] : [record]
    })
  }

  insertTrigger(trigger: TriggerRecord): void {
    this.db.prepare(`INSERT INTO events (
      id, source_id, event_key, subject_key, subject_revision, type, schema, operation,
      occurred_at, observed_at, received_at, ingest_seq, summary, data_json, priority, deadline,
      provenance_json, correlation_keys_json, supersedes_json, parents_json, content_hash,
      sense_config_revision, expires_at, pruned_at,
      quno_id, actor_json, human, addressed, channel_json, content_ref_json, threads_json
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`).run(
      trigger.id,
      trigger.sourceId,
      trigger.eventKey,
      trigger.type,
      trigger.schema,
      trigger.operation,
      trigger.occurredAt,
      trigger.observedAt,
      trigger.receivedAt,
      this.nextIngestSeq(),
      trigger.summary,
      toJson(trigger.data),
      trigger.priority,
      trigger.deadline,
      toJson(trigger.provenance),
      toJson(trigger.correlationKeys),
      toJson(trigger.supersedesTriggerIds),
      toJson(trigger.parentTriggerIds),
      trigger.contentHash,
      trigger.configRevision,
      trigger.expiresAt,
      trigger.prunedAt,
      toJson(trigger.actor),
      trigger.human ? 1 : 0,
      trigger.addressed,
      trigger.channel === null ? null : toJson(trigger.channel),
      trigger.contentRef === null ? null : toJson(trigger.contentRef),
      toJson(trigger.threads),
    )
    trigger.threads.forEach((ref, ordinal) => {
      const threadId = this.ensureThreadRow(trigger.qunoId, ref.source, ref.id, trigger.observedAt, trigger.receivedAt)
      this.db.prepare('INSERT OR IGNORE INTO trigger_threads (trigger_id, thread_id, ordinal, at) VALUES (?, ?, ?, ?)')
        .run(trigger.id, threadId, ordinal, trigger.receivedAt)
    })
  }

  private nextIngestSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(ingest_seq), 0) + 1 AS next FROM events').get() as { next?: number } | undefined
    return row?.next ?? 1
  }

  private ensureThreadRow(qunoId: string, sourceId: string, threadKey: string, at: number, createdAt: number): ThreadId {
    const existing = this.db.prepare('SELECT id FROM threads WHERE quno_id = ? AND source_id = ? AND thread_key = ?')
      .get(qunoId, sourceId, threadKey) as { id?: string } | undefined
    if (existing?.id !== undefined) return existing.id
    const id = threadRowId(sourceId, threadKey)
    this.db.prepare(`INSERT OR IGNORE INTO threads (id, quno_id, source_id, thread_key, label, last_at,
      correlated_json, active_eval_id, expired_count, meta_json, closed_at, closed_outcome, created_at)
      VALUES (?, ?, ?, ?, NULL, ?, '[]', NULL, 0, '{}', NULL, NULL, ?)`).run(id, qunoId, sourceId, threadKey, at, createdAt)
    return id
  }

  listTriggerIdsByThread(threadId: ThreadId, limit: number): readonly TriggerId[] {
    return (this.db.prepare('SELECT trigger_id AS id FROM trigger_threads WHERE thread_id = ? ORDER BY at, rowid LIMIT ?')
      .all(threadId, limit) as { id: string }[]).map(row => row.id)
  }

  markTriggerPruned(id: TriggerId, prunedAt: number): void {
    this.db.prepare('UPDATE events SET pruned_at = ?, data_json = NULL WHERE id = ? AND pruned_at IS NULL').run(prunedAt, id)
  }

  recordFiltered(triggerId: TriggerId, reason: string): void {
    this.db.prepare(`INSERT INTO trigger_dispositions (trigger_id, filtered_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(trigger_id) DO UPDATE SET filtered_json = excluded.filtered_json, updated_at = excluded.updated_at`)
      .run(triggerId, toJson({ filtered: true, reason }), Date.now())
  }

  filteredReason(triggerId: TriggerId): string | null {
    const row = this.db.prepare('SELECT filtered_json AS filtered FROM trigger_dispositions WHERE trigger_id = ?')
      .get(triggerId) as { filtered?: string } | undefined
    if (row?.filtered === undefined) return null
    const parsed = fromJson<{ reason?: string }>(row.filtered, {})
    return typeof parsed.reason === 'string' ? parsed.reason : 'filtered'
  }

  // -------------------------------------------------------------- threads

  private threadSelect(): string {
    return `SELECT id, quno_id AS qunoId, source_id AS sourceId, thread_key AS threadKey, label,
      last_at AS lastAt, correlated_json AS correlatedJson, active_eval_id AS activeEvalId,
      expired_count AS expiredCount, meta_json AS metaJson, closed_at AS closedAt,
      closed_outcome AS closedOutcome
      FROM threads`
  }

  private threadFromRow(row: Row, pendingTriggerIds: readonly TriggerId[] = []): ThreadRecord {
    const closedAt = asNumber(row['closedAt'])
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      sourceId: String(row['sourceId']),
      threadKey: String(row['threadKey']),
      label: asString(row['label']),
      lastAt: asNumber(row['lastAt']),
      correlatedThreadIds: fromJson<string[]>(row['correlatedJson'], []),
      pendingTriggerIds,
      activeEvalId: asString(row['activeEvalId']),
      expiredCount: Number(row['expiredCount'] ?? 0),
      meta: fromJson<Record<string, unknown>>(row['metaJson'], {}),
      closed: closedAt === null ? null : { at: closedAt, outcome: String(row['closedOutcome'] ?? 'closed') },
    }
  }

  getThread(id: ThreadId): ThreadRecord | undefined {
    const row = this.db.prepare(`${this.threadSelect()} WHERE id = ?`).get(id) as Row | undefined
    if (row === undefined) return undefined
    return this.threadFromRow(row, this.listPendingTriggerIds(id, 500))
  }

  getThreadByKey(qunoId: string, sourceId: string, threadKey: string): ThreadRecord | undefined {
    const row = this.db.prepare(`${this.threadSelect()} WHERE quno_id = ? AND source_id = ? AND thread_key = ?`)
      .get(qunoId, sourceId, threadKey) as Row | undefined
    if (row === undefined) return undefined
    return this.threadFromRow(row, this.listPendingTriggerIds(String(row['id']), 500))
  }

  listThreads(
    qunoId: string,
    filter: { readonly limit?: number; readonly withPending?: boolean; readonly sourceId?: string } = {},
  ): readonly ThreadRecord[] {
    const limit = filter.limit ?? 200
    const clauses = ['quno_id = ?']
    const params: (string | number)[] = [qunoId]
    if (filter.sourceId !== undefined) {
      clauses.push('source_id = ?')
      params.push(filter.sourceId)
    }
    if (filter.withPending === true) {
      clauses.push('EXISTS (SELECT 1 FROM thread_pending p WHERE p.thread_id = threads.id)')
    }
    params.push(limit)
    const rows = this.db.prepare(`${this.threadSelect()} WHERE ${clauses.join(' AND ')} ORDER BY COALESCE(last_at, 0) DESC, rowid DESC LIMIT ?`)
      .all(...params) as Row[]
    if (rows.length === 0) return []
    return this.withPending(rows)
  }

  /** Attach each row's pending Trigger ids with one extra query (not N). */
  private withPending(rows: readonly Row[]): readonly ThreadRecord[] {
    const ids = rows.map(row => String(row['id']))
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const pending = this.db.prepare(`SELECT thread_id AS threadId, trigger_id AS triggerId
      FROM thread_pending WHERE thread_id IN (${placeholders}) ORDER BY at, rowid`).all(...ids) as { threadId: string; triggerId: string }[]
    const byThread = new Map<string, string[]>()
    for (const row of pending) {
      const list = byThread.get(row.threadId) ?? []
      list.push(row.triggerId)
      byThread.set(row.threadId, list)
    }
    return rows.map(row => this.threadFromRow(row, byThread.get(String(row['id'])) ?? []))
  }

  insertThread(thread: ThreadRecord): void {
    this.db.prepare(`INSERT OR IGNORE INTO threads (id, quno_id, source_id, thread_key, label, last_at,
      correlated_json, active_eval_id, expired_count, meta_json, closed_at, closed_outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      thread.id,
      thread.qunoId,
      thread.sourceId,
      thread.threadKey,
      thread.label,
      thread.lastAt,
      toJson(thread.correlatedThreadIds),
      thread.activeEvalId,
      thread.expiredCount,
      toJson(thread.meta),
      thread.closed?.at ?? null,
      thread.closed?.outcome ?? null,
      thread.lastAt ?? Date.now(),
    )
  }

  updateThread(
    id: ThreadId,
    patch: Partial<Pick<ThreadRecord, 'label' | 'lastAt' | 'correlatedThreadIds' | 'activeEvalId' | 'expiredCount' | 'meta' | 'closed'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.label !== undefined) { sets.push('label = ?'); params.push(patch.label) }
    if (patch.lastAt !== undefined) { sets.push('last_at = ?'); params.push(patch.lastAt) }
    if (patch.correlatedThreadIds !== undefined) { sets.push('correlated_json = ?'); params.push(toJson(patch.correlatedThreadIds)) }
    if (patch.activeEvalId !== undefined) { sets.push('active_eval_id = ?'); params.push(patch.activeEvalId) }
    if (patch.expiredCount !== undefined) { sets.push('expired_count = ?'); params.push(patch.expiredCount) }
    if (patch.meta !== undefined) { sets.push('meta_json = ?'); params.push(toJson(patch.meta)) }
    if (patch.closed !== undefined) {
      sets.push('closed_at = ?', 'closed_outcome = ?')
      params.push(patch.closed?.at ?? null, patch.closed?.outcome ?? null)
    }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  listPendingTriggerIds(threadId: ThreadId, limit = 1000): readonly TriggerId[] {
    return (this.db.prepare('SELECT trigger_id AS id FROM thread_pending WHERE thread_id = ? ORDER BY at, rowid LIMIT ?')
      .all(threadId, limit) as { id: string }[]).map(row => row.id)
  }

  addPending(threadId: ThreadId, triggerId: TriggerId, at: number): void {
    this.db.prepare('INSERT OR IGNORE INTO thread_pending (thread_id, trigger_id, at) VALUES (?, ?, ?)')
      .run(threadId, triggerId, at)
  }

  removePending(threadId: ThreadId, triggerId: TriggerId): void {
    this.db.prepare('DELETE FROM thread_pending WHERE thread_id = ? AND trigger_id = ?').run(threadId, triggerId)
  }

  countPending(threadId: ThreadId): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM thread_pending WHERE thread_id = ?').get(threadId) as { n?: number } | undefined
    return row?.n ?? 0
  }

  // ---------------------------------------------------------------- evals

  private evalSelect(): string {
    return `SELECT id, quno_id AS qunoId, thread_id AS threadId, trigger_ids_json AS triggerIdsJson,
      primary_trigger_id AS primaryTriggerId, strength, basis_json AS basisJson, policy_version AS policyVersion,
      status, candidate_message_id AS candidateMessageId, started_at AS startedAt, delivered_at AS deliveredAt,
      deadline, paused_at AS pausedAt, expiry_count AS expiryCount
      FROM evals`
  }

  private evalFromRow(row: Row): EvalRecord {
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      threadId: String(row['threadId']),
      triggerIds: fromJson<string[]>(row['triggerIdsJson'], []),
      primaryTriggerId: String(row['primaryTriggerId']),
      strength: String(row['strength']) as EvalRecord['strength'],
      basis: fromJson(row['basisJson'], { via: 'admission', sourceId: null, scope: {}, matchedRuleIds: [] }),
      policyVersion: String(row['policyVersion']),
      status: String(row['status']) as EvalStatus,
      candidateMessageId: asString(row['candidateMessageId']),
      startedAt: Number(row['startedAt']),
      deliveredAt: asNumber(row['deliveredAt']),
      deadline: Number(row['deadline']),
      pausedAt: asNumber(row['pausedAt']),
      expiryCount: Number(row['expiryCount'] ?? 0),
    }
  }

  insertEval(evalRecord: EvalRecord): void {
    this.db.prepare(`INSERT INTO evals (id, quno_id, thread_id, trigger_ids_json, primary_trigger_id,
      strength, basis_json, policy_version, status, candidate_message_id, started_at, delivered_at,
      deadline, paused_at, expiry_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      evalRecord.id,
      evalRecord.qunoId,
      evalRecord.threadId,
      toJson(evalRecord.triggerIds),
      evalRecord.primaryTriggerId,
      evalRecord.strength,
      toJson(evalRecord.basis),
      evalRecord.policyVersion,
      evalRecord.status,
      evalRecord.candidateMessageId,
      evalRecord.startedAt,
      evalRecord.deliveredAt,
      evalRecord.deadline,
      evalRecord.pausedAt,
      evalRecord.expiryCount,
    )
  }

  getEval(id: string): EvalRecord | undefined {
    const row = this.db.prepare(`${this.evalSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.evalFromRow(row)
  }

  updateEval(
    id: string,
    patch: Partial<Pick<EvalRecord, 'status' | 'candidateMessageId' | 'deliveredAt' | 'deadline' | 'pausedAt' | 'expiryCount'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (patch.candidateMessageId !== undefined) { sets.push('candidate_message_id = ?'); params.push(patch.candidateMessageId) }
    if (patch.deliveredAt !== undefined) { sets.push('delivered_at = ?'); params.push(patch.deliveredAt) }
    if (patch.deadline !== undefined) { sets.push('deadline = ?'); params.push(patch.deadline) }
    if (patch.pausedAt !== undefined) { sets.push('paused_at = ?'); params.push(patch.pausedAt) }
    if (patch.expiryCount !== undefined) { sets.push('expiry_count = ?'); params.push(patch.expiryCount) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE evals SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  findActiveEval(threadId: ThreadId): EvalRecord | undefined {
    const row = this.db.prepare(`${this.evalSelect()} WHERE thread_id = ? AND status IN ('delivering', 'waiting-decision') ORDER BY rowid DESC LIMIT 1`)
      .get(threadId) as Row | undefined
    return row === undefined ? undefined : this.evalFromRow(row)
  }

  findEvalByCandidateMessage(messageId: string): EvalRecord | undefined {
    const row = this.db.prepare(`${this.evalSelect()} WHERE candidate_message_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(messageId) as Row | undefined
    return row === undefined ? undefined : this.evalFromRow(row)
  }

  listEvals(qunoId: string, filter: EvalFilter = {}): readonly EvalRecord[] {
    const clauses = ['quno_id = ?']
    const params: (string | number)[] = [qunoId]
    if (filter.threadId !== undefined) { clauses.push('thread_id = ?'); params.push(filter.threadId) }
    if (filter.status !== undefined && filter.status.length > 0) {
      clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`)
      params.push(...filter.status)
    }
    params.push(filter.limit ?? 100)
    const rows = this.db.prepare(`${this.evalSelect()} WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...params) as Row[]
    return rows.map(row => this.evalFromRow(row))
  }

  listTimedOutEvals(now: number, limit: number): readonly EvalRecord[] {
    const rows = this.db.prepare(`${this.evalSelect()} WHERE status IN ('delivering', 'waiting-decision')
      AND delivered_at IS NOT NULL AND paused_at IS NULL AND deadline < ?
      ORDER BY deadline, rowid LIMIT ?`).all(now, limit) as Row[]
    return rows.map(row => this.evalFromRow(row))
  }

  // ------------------------------------------------------------ decisions

  private decisionFromRow(row: Row): DecisionRecord {
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      evalId: asString(row['evalId']),
      threadId: asString(row['threadId']),
      triggerIds: fromJson<string[]>(row['triggerIdsJson'], []),
      kind: String(row['kind']) as DecisionRecord['kind'],
      strength: String(row['strength']) as DecisionRecord['strength'],
      reason: asString(row['reason']),
      policyVersion: String(row['policyVersion']),
      ticketId: asString(row['ticketId']),
      mandate: fromJson(row['mandateJson'], null),
      audit: fromJson<Record<string, unknown>>(row['auditJson'], {}),
      createdAt: Number(row['createdAt']),
    }
  }

  private decisionSelect(): string {
    return `SELECT id, quno_id AS qunoId, eval_id AS evalId, thread_id AS threadId,
      trigger_ids_json AS triggerIdsJson, kind, strength, reason, policy_version AS policyVersion,
      ticket_id AS ticketId, mandate_json AS mandateJson, audit_json AS auditJson, created_at AS createdAt
      FROM decisions`
  }

  insertDecision(decision: DecisionRecord): void {
    this.db.prepare(`INSERT INTO decisions (id, quno_id, eval_id, thread_id, trigger_ids_json, kind,
      strength, reason, policy_version, ticket_id, mandate_json, audit_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      decision.id,
      decision.qunoId,
      decision.evalId,
      decision.threadId,
      toJson(decision.triggerIds),
      decision.kind,
      decision.strength,
      decision.reason,
      decision.policyVersion,
      decision.ticketId,
      decision.mandate === null ? null : toJson(decision.mandate),
      toJson(decision.audit),
      decision.createdAt,
    )
  }

  getDecision(id: DecisionId): DecisionRecord | undefined {
    const row = this.db.prepare(`${this.decisionSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.decisionFromRow(row)
  }

  findDecisionByEval(evalId: string): DecisionRecord | undefined {
    const row = this.db.prepare(`${this.decisionSelect()} WHERE eval_id = ? ORDER BY rowid DESC LIMIT 1`).get(evalId) as Row | undefined
    return row === undefined ? undefined : this.decisionFromRow(row)
  }

  findDecisionByTicket(ticketId: string): DecisionRecord | undefined {
    const row = this.db.prepare(`${this.decisionSelect()} WHERE ticket_id = ? ORDER BY rowid DESC LIMIT 1`).get(ticketId) as Row | undefined
    return row === undefined ? undefined : this.decisionFromRow(row)
  }

  listDecisions(qunoId: string, limit: number): readonly DecisionRecord[] {
    const rows = this.db.prepare(`${this.decisionSelect()} WHERE quno_id = ? ORDER BY rowid DESC LIMIT ?`).all(qunoId, limit) as Row[]
    return rows.map(row => this.decisionFromRow(row))
  }

  // -------------------------------------------------------------- tickets

  private ticketFromRow(row: Row): TicketRecord {
    const endedAt = asNumber(row['endedAt'])
    const question = fromJson(row['questionJson'], null)
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      title: String(row['title']),
      goal: String(row['goal']),
      decisionId: asString(row['decisionId']),
      mandate: fromJson(row['mandateJson'], {
        strength: 'explicit',
        policyVersion: 'legacy',
        scope: 'ticket',
        actor: { source: 'legacy', id: '' },
        basis: { via: 'direct', sourceId: null, scope: {}, matchedRuleIds: [] },
        permissionPreset: 'quno-task',
      }),
      origin: fromJson(row['originJson'], { triggerId: null, triggerIds: [] }),
      channels: fromJson(row['channelsJson'], []),
      mode: String(row['mode']) as TicketRecord['mode'],
      ended: endedAt === null
        ? null
        : {
          at: endedAt,
          by: String(row['endedBy'] ?? 'host') as NonNullable<TicketRecord['ended']>['by'],
          outcome: String(row['endedOutcome'] ?? 'closed') as NonNullable<TicketRecord['ended']>['outcome'],
          reason: asString(row['endedReason']),
        },
      question,
      createdAt: Number(row['createdAt']),
      updatedAt: Number(row['updatedAt']),
    }
  }

  private ticketSelect(): string {
    return `SELECT id, quno_id AS qunoId, title, goal, decision_id AS decisionId,
      mandate_json AS mandateJson, origin_json AS originJson, channels_json AS channelsJson, mode,
      ended_at AS endedAt, ended_by AS endedBy, ended_outcome AS endedOutcome, ended_reason AS endedReason,
      question_json AS questionJson, created_at AS createdAt, updated_at AS updatedAt
      FROM tickets`
  }

  insertTicket(ticket: TicketRecord): void {
    this.db.prepare(`INSERT INTO tickets (id, quno_id, title, goal, decision_id, mandate_json, origin_json,
      channels_json, mode, ended_at, ended_by, ended_outcome, ended_reason, question_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ticket.id,
      ticket.qunoId,
      ticket.title,
      ticket.goal,
      ticket.decisionId,
      toJson(ticket.mandate),
      toJson(ticket.origin),
      toJson(ticket.channels),
      ticket.mode,
      ticket.ended?.at ?? null,
      ticket.ended?.by ?? null,
      ticket.ended?.outcome ?? null,
      ticket.ended?.reason ?? null,
      ticket.question === null ? null : toJson(ticket.question),
      ticket.createdAt,
      ticket.updatedAt,
    )
  }

  getTicket(id: TicketId): TicketRecord | undefined {
    const row = this.db.prepare(`${this.ticketSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.ticketFromRow(row)
  }

  updateTicket(
    id: TicketId,
    patch: Partial<Pick<TicketRecord, 'title' | 'goal' | 'ended' | 'question' | 'channels' | 'mode' | 'updatedAt'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title) }
    if (patch.goal !== undefined) { sets.push('goal = ?'); params.push(patch.goal) }
    if (patch.channels !== undefined) { sets.push('channels_json = ?'); params.push(toJson(patch.channels)) }
    if (patch.mode !== undefined) { sets.push('mode = ?'); params.push(patch.mode) }
    if (patch.updatedAt !== undefined) { sets.push('updated_at = ?'); params.push(patch.updatedAt) }
    if (patch.ended !== undefined) {
      sets.push('ended_at = ?', 'ended_by = ?', 'ended_outcome = ?', 'ended_reason = ?')
      params.push(patch.ended?.at ?? null, patch.ended?.by ?? null, patch.ended?.outcome ?? null, patch.ended?.reason ?? null)
    }
    if (patch.question !== undefined) {
      sets.push('question_json = ?')
      params.push(patch.question === null ? null : toJson(patch.question))
    }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  listTickets(qunoId: string, filter: TicketFilter = {}): readonly TicketRecord[] {
    const clauses = ['quno_id = ?']
    const params: (string | number)[] = [qunoId]
    if (filter.open === true) clauses.push('ended_at IS NULL')
    if (filter.triggerId !== undefined) {
      clauses.push(`(json_extract(origin_json, '$.triggerId') = ? OR EXISTS (
        SELECT 1 FROM json_each(json_extract(origin_json, '$.triggerIds')) WHERE json_each.value = ?))`)
      params.push(filter.triggerId, filter.triggerId)
    }
    params.push(filter.limit ?? 200)
    const rows = this.db.prepare(`${this.ticketSelect()} WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...params) as Row[]
    return rows.map(row => this.ticketFromRow(row))
  }

  findTicketByDecision(decisionId: DecisionId): TicketRecord | undefined {
    const row = this.db.prepare(`${this.ticketSelect()} WHERE decision_id = ?`).get(decisionId) as Row | undefined
    return row === undefined ? undefined : this.ticketFromRow(row)
  }

  // -------------------------------------------------------- subscriptions

  private subscriptionSelect(): string {
    return `SELECT id, quno_id AS qunoId, ticket_id AS ticketId, thread_id AS threadId, mode, origin,
      start_ingest_seq AS startIngestSeq, revision, cancelled_at AS cancelledAt, created_at AS createdAt
      FROM subscriptions`
  }

  private subscriptionFromRow(row: Row): SubscriptionRecord {
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      ticketId: String(row['ticketId']),
      threadId: String(row['threadId']),
      mode: String(row['mode']) as SubscriptionRecord['mode'],
      origin: String(row['origin']) as SubscriptionRecord['origin'],
      startIngestSeq: Number(row['startIngestSeq'] ?? 0),
      revision: Number(row['revision'] ?? 1),
      cancelledAt: asNumber(row['cancelledAt']),
      createdAt: Number(row['createdAt']),
    }
  }

  insertSubscription(subscription: SubscriptionRecord): void {
    this.db.prepare(`INSERT INTO subscriptions (id, quno_id, ticket_id, thread_id, mode, origin,
      start_ingest_seq, revision, cancelled_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticket_id, thread_id) DO NOTHING`).run(
      subscription.id,
      subscription.qunoId,
      subscription.ticketId,
      subscription.threadId,
      subscription.mode,
      subscription.origin,
      subscription.startIngestSeq,
      subscription.revision,
      subscription.cancelledAt,
      subscription.createdAt,
    )
  }

  getSubscription(ticketId: TicketId, threadId: ThreadId): SubscriptionRecord | undefined {
    const row = this.db.prepare(`${this.subscriptionSelect()} WHERE ticket_id = ? AND thread_id = ?`)
      .get(ticketId, threadId) as Row | undefined
    return row === undefined ? undefined : this.subscriptionFromRow(row)
  }

  listSubscriptionsByTicket(ticketId: TicketId): readonly SubscriptionRecord[] {
    const rows = this.db.prepare(`${this.subscriptionSelect()} WHERE ticket_id = ? ORDER BY rowid`).all(ticketId) as Row[]
    return rows.map(row => this.subscriptionFromRow(row))
  }

  listSubscriptionsByThread(threadId: ThreadId): readonly SubscriptionRecord[] {
    const rows = this.db.prepare(`${this.subscriptionSelect()} WHERE thread_id = ? ORDER BY rowid`).all(threadId) as Row[]
    return rows.map(row => this.subscriptionFromRow(row))
  }

  updateSubscription(id: string, patch: Partial<Pick<SubscriptionRecord, 'mode' | 'revision' | 'cancelledAt'>>): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.mode !== undefined) { sets.push('mode = ?'); params.push(patch.mode) }
    if (patch.revision !== undefined) { sets.push('revision = ?'); params.push(patch.revision) }
    if (patch.cancelledAt !== undefined) { sets.push('cancelled_at = ?'); params.push(patch.cancelledAt) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  // ---------------------------------------------------------- assignments

  private assignmentSelect(): string {
    return `SELECT id, ticket_id AS ticketId, state, executor_session_id AS executorSessionId,
      directory, report_json AS reportJson, delivered_at AS deliveredAt, idle_at AS idleAt,
      ended_reason AS endedReason, created_at AS createdAt
      FROM assignments`
  }

  private assignmentFromRow(row: Row): AssignmentRecord {
    return {
      id: String(row['id']),
      ticketId: String(row['ticketId']),
      state: String(row['state']) as AssignmentRecord['state'],
      executorSessionId: String(row['executorSessionId']),
      directory: String(row['directory'] ?? ''),
      report: fromJson(row['reportJson'], null),
      deliveredAt: asNumber(row['deliveredAt']),
      idleAt: asNumber(row['idleAt']),
      endedReason: asString(row['endedReason']),
      createdAt: Number(row['createdAt']),
    }
  }

  insertAssignment(assignment: AssignmentRecord): void {
    this.db.prepare(`INSERT INTO assignments (id, ticket_id, state, executor_session_id, directory,
      report_json, delivered_at, idle_at, ended_reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      assignment.id,
      assignment.ticketId,
      assignment.state,
      assignment.executorSessionId,
      assignment.directory,
      assignment.report === null ? null : toJson(assignment.report),
      assignment.deliveredAt,
      assignment.idleAt,
      assignment.endedReason,
      assignment.createdAt,
    )
  }

  getAssignment(id: string): AssignmentRecord | undefined {
    const row = this.db.prepare(`${this.assignmentSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.assignmentFromRow(row)
  }

  updateAssignment(
    id: string,
    patch: Partial<Pick<AssignmentRecord, 'state' | 'report' | 'deliveredAt' | 'idleAt' | 'endedReason' | 'directory'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.state !== undefined) { sets.push('state = ?'); params.push(patch.state) }
    if (patch.report !== undefined) { sets.push('report_json = ?'); params.push(patch.report === null ? null : toJson(patch.report)) }
    if (patch.deliveredAt !== undefined) { sets.push('delivered_at = ?'); params.push(patch.deliveredAt) }
    if (patch.idleAt !== undefined) { sets.push('idle_at = ?'); params.push(patch.idleAt) }
    if (patch.endedReason !== undefined) { sets.push('ended_reason = ?'); params.push(patch.endedReason) }
    if (patch.directory !== undefined) { sets.push('directory = ?'); params.push(patch.directory) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE assignments SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  listAssignmentsByTicket(ticketId: TicketId): readonly AssignmentRecord[] {
    const rows = this.db.prepare(`${this.assignmentSelect()} WHERE ticket_id = ? ORDER BY rowid`).all(ticketId) as Row[]
    return rows.map(row => this.assignmentFromRow(row))
  }

  findActiveAssignment(ticketId: TicketId): AssignmentRecord | undefined {
    const row = this.db.prepare(`${this.assignmentSelect()} WHERE ticket_id = ? AND state <> 'ended' ORDER BY rowid DESC LIMIT 1`)
      .get(ticketId) as Row | undefined
    return row === undefined ? undefined : this.assignmentFromRow(row)
  }

  listAssignmentsByState(state: AssignmentRecord['state'], limit: number): readonly AssignmentRecord[] {
    const rows = this.db.prepare(`${this.assignmentSelect()} WHERE state = ? ORDER BY rowid LIMIT ?`).all(state, limit) as Row[]
    return rows.map(row => this.assignmentFromRow(row))
  }

  // ----------------------------------------------------------- worker runs

  private runFromRow(row: Row): WorkerRunRecord {
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      ticketId: String(row['ticketId']),
      assignmentId: String(row['assignmentId']),
      status: String(row['status']) as WorkerRunStatus,
      inputIds: fromJson<string[]>(row['inputIdsJson'], []),
      fence: Number(row['fence'] ?? 0),
      leaseUntil: asNumber(row['leaseUntil']),
      turnId: asString(row['turnId']),
      result: fromJson(row['resultJson'], null),
      error: fromJson(row['errorJson'], null),
      cost: fromJson(row['costJson'], null),
      startedAt: Number(row['startedAt']),
      finishedAt: asNumber(row['finishedAt']),
    }
  }

  private runSelect(): string {
    return `SELECT id, quno_id AS qunoId, ticket_id AS ticketId, assignment_id AS assignmentId, status,
      input_ids_json AS inputIdsJson, fence, lease_until AS leaseUntil, turn_id AS turnId,
      result_json AS resultJson, error_json AS errorJson, cost_json AS costJson,
      started_at AS startedAt, finished_at AS finishedAt
      FROM worker_runs`
  }

  insertWorkerRun(run: WorkerRunRecord): void {
    this.db.prepare(`INSERT INTO worker_runs (id, quno_id, ticket_id, assignment_id, status,
      input_ids_json, fence, lease_until, turn_id, result_json, error_json, cost_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.id,
      run.qunoId,
      run.ticketId,
      run.assignmentId,
      run.status,
      toJson(run.inputIds),
      run.fence,
      run.leaseUntil,
      run.turnId,
      run.result === null ? null : toJson(run.result),
      run.error === null ? null : toJson(run.error),
      run.cost === null ? null : toJson(run.cost),
      run.startedAt,
      run.finishedAt,
    )
  }

  getWorkerRun(id: string): WorkerRunRecord | undefined {
    const row = this.db.prepare(`${this.runSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.runFromRow(row)
  }

  updateWorkerRun(
    id: string,
    patch: Partial<Pick<WorkerRunRecord, 'status' | 'leaseUntil' | 'turnId' | 'result' | 'error' | 'cost' | 'finishedAt' | 'inputIds'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (patch.leaseUntil !== undefined) { sets.push('lease_until = ?'); params.push(patch.leaseUntil) }
    if (patch.turnId !== undefined) { sets.push('turn_id = ?'); params.push(patch.turnId) }
    if (patch.result !== undefined) { sets.push('result_json = ?'); params.push(patch.result === null ? null : toJson(patch.result)) }
    if (patch.error !== undefined) { sets.push('error_json = ?'); params.push(patch.error === null ? null : toJson(patch.error)) }
    if (patch.cost !== undefined) { sets.push('cost_json = ?'); params.push(patch.cost === null ? null : toJson(patch.cost)) }
    if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt) }
    if (patch.inputIds !== undefined) { sets.push('input_ids_json = ?'); params.push(toJson(patch.inputIds)) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE worker_runs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  findRunningWorkerRun(assignmentId: string): WorkerRunRecord | undefined {
    const row = this.db.prepare(`${this.runSelect()} WHERE assignment_id = ? AND status IN ('prepared', 'running') ORDER BY rowid DESC LIMIT 1`)
      .get(assignmentId) as Row | undefined
    return row === undefined ? undefined : this.runFromRow(row)
  }

  listWorkerRunsByAssignment(assignmentId: string): readonly WorkerRunRecord[] {
    const rows = this.db.prepare(`${this.runSelect()} WHERE assignment_id = ? ORDER BY rowid`).all(assignmentId) as Row[]
    return rows.map(row => this.runFromRow(row))
  }

  listOpenWorkerRuns(limit: number): readonly WorkerRunRecord[] {
    const rows = this.db.prepare(`${this.runSelect()} WHERE status IN ('prepared', 'running') ORDER BY rowid LIMIT ?`).all(limit) as Row[]
    return rows.map(row => this.runFromRow(row))
  }

  countWorkerRuns(status: readonly WorkerRunStatus[]): number {
    if (status.length === 0) return 0
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM worker_runs WHERE status IN (${status.map(() => '?').join(', ')})`)
      .get(...status) as { n?: number } | undefined
    return row?.n ?? 0
  }

  // ---------------------------------------------------------------- inputs

  private inputSelect(): string {
    return `SELECT id, quno_id AS qunoId, ticket_id AS ticketId, kind, trigger_id AS triggerId,
      exchange_id AS exchangeId, human, context, text, created_at AS createdAt, delivered_to AS deliveredTo,
      delivered_at AS deliveredAt, read_at AS readAt, acknowledged_at AS acknowledgedAt,
      handed_back_at AS handedBackAt
      FROM ticket_inputs`
  }

  private inputFromRow(row: Row): TicketInputRecord {
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      ticketId: String(row['ticketId']),
      kind: String(row['kind']) as TicketInputRecord['kind'],
      triggerId: asString(row['triggerId']),
      exchangeId: asString(row['exchangeId']),
      human: asBool(row['human']),
      context: asBool(row['context']),
      text: asString(row['text']),
      createdAt: Number(row['createdAt']),
      deliveredTo: asString(row['deliveredTo']),
      deliveredAt: asNumber(row['deliveredAt']),
      readAt: asNumber(row['readAt']),
      acknowledgedAt: asNumber(row['acknowledgedAt']),
      handedBackAt: asNumber(row['handedBackAt']),
    }
  }

  insertInput(input: TicketInputRecord): void {
    this.db.prepare(`INSERT INTO ticket_inputs (id, quno_id, ticket_id, kind, trigger_id, exchange_id,
      human, context, text, created_at, delivered_to, delivered_at, read_at, acknowledged_at, handed_back_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(
      input.id,
      input.qunoId,
      input.ticketId,
      input.kind,
      input.triggerId,
      input.exchangeId,
      input.human ? 1 : 0,
      input.context ? 1 : 0,
      input.text,
      input.createdAt,
      input.deliveredTo,
      input.deliveredAt,
      input.readAt,
      input.acknowledgedAt,
      input.handedBackAt,
    )
  }

  getInput(id: InputId): TicketInputRecord | undefined {
    const row = this.db.prepare(`${this.inputSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.inputFromRow(row)
  }

  updateInput(
    id: InputId,
    patch: Partial<Pick<TicketInputRecord, 'deliveredTo' | 'deliveredAt' | 'readAt' | 'acknowledgedAt' | 'handedBackAt'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.deliveredTo !== undefined) { sets.push('delivered_to = ?'); params.push(patch.deliveredTo) }
    if (patch.deliveredAt !== undefined) { sets.push('delivered_at = ?'); params.push(patch.deliveredAt) }
    if (patch.readAt !== undefined) { sets.push('read_at = ?'); params.push(patch.readAt) }
    if (patch.acknowledgedAt !== undefined) { sets.push('acknowledged_at = ?'); params.push(patch.acknowledgedAt) }
    if (patch.handedBackAt !== undefined) { sets.push('handed_back_at = ?'); params.push(patch.handedBackAt) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE ticket_inputs SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  listInputsByTicket(ticketId: TicketId, filter: InputFilter = {}): readonly TicketInputRecord[] {
    const clauses = ['ticket_id = ?']
    const params: (string | number)[] = [ticketId]
    if (filter.undelivered === true) clauses.push('delivered_at IS NULL')
    if (filter.unread === true) clauses.push('read_at IS NULL')
    if (filter.humanOnly === true) clauses.push('human = 1')
    if (filter.unacknowledged === true) clauses.push('acknowledged_at IS NULL')
    params.push(filter.limit ?? 200)
    const rows = this.db.prepare(`${this.inputSelect()} WHERE ${clauses.join(' AND ')} ORDER BY rowid LIMIT ?`)
      .all(...params) as Row[]
    return rows.map(row => this.inputFromRow(row))
  }

  listInputs(ids: readonly InputId[]): readonly TicketInputRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`${this.inputSelect()} WHERE id IN (${placeholders})`).all(...ids) as Row[]
    const byId = new Map(rows.map(row => [String(row['id']), this.inputFromRow(row)]))
    return ids.flatMap(id => {
      const record = byId.get(id)
      return record === undefined ? [] : [record]
    })
  }

  findInputByTrigger(ticketId: TicketId, triggerId: TriggerId): TicketInputRecord | undefined {
    const row = this.db.prepare(`${this.inputSelect()} WHERE ticket_id = ? AND trigger_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(ticketId, triggerId) as Row | undefined
    return row === undefined ? undefined : this.inputFromRow(row)
  }

  // -------------------------------------------------------------- attempts

  insertInputAttempt(attempt: InputAttemptRecord): void {
    this.db.prepare(`INSERT INTO input_attempts (id, input_id, attempt, message_id, mode, status, reason,
      created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(input_id, attempt) DO NOTHING`).run(
      attempt.id,
      attempt.inputId,
      attempt.attempt,
      attempt.messageId,
      attempt.mode,
      attempt.status,
      attempt.reason,
      attempt.createdAt,
      attempt.finishedAt,
    )
  }

  updateInputAttempt(
    id: string,
    patch: Partial<Pick<InputAttemptRecord, 'status' | 'reason' | 'finishedAt' | 'messageId'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (patch.reason !== undefined) { sets.push('reason = ?'); params.push(patch.reason) }
    if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt) }
    if (patch.messageId !== undefined) { sets.push('message_id = ?'); params.push(patch.messageId) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE input_attempts SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  findInputAttempt(inputId: InputId, attempt: number): InputAttemptRecord | undefined {
    const row = this.db.prepare(`SELECT id, input_id AS inputId, attempt, message_id AS messageId, mode,
      status, reason, created_at AS createdAt, finished_at AS finishedAt
      FROM input_attempts WHERE input_id = ? AND attempt = ?`).get(inputId, attempt) as Row | undefined
    if (row === undefined) return undefined
    return {
      id: String(row['id']),
      inputId: String(row['inputId']),
      attempt: Number(row['attempt']),
      messageId: asString(row['messageId']),
      mode: String(row['mode']) as InputAttemptRecord['mode'],
      status: String(row['status']) as InputAttemptRecord['status'],
      reason: asString(row['reason']),
      createdAt: Number(row['createdAt']),
      finishedAt: asNumber(row['finishedAt']),
    }
  }

  // ------------------------------------------------------------- exchanges

  private exchangeSelect(): string {
    return `SELECT id, quno_id AS qunoId, kind, requester, responder, status, deadline,
      request_message_id AS requestMessageId, response_message_id AS responseMessageId,
      attempts, created_at AS createdAt, updated_at AS updatedAt
      FROM exchanges`
  }

  private exchangeFromRow(row: Row): ExchangeRecord {
    return {
      id: String(row['id']),
      qunoId: String(row['qunoId']),
      kind: String(row['kind']) as ExchangeRecord['kind'],
      requester: String(row['requester']),
      responder: String(row['responder']),
      status: String(row['status']) as ExchangeStatus,
      deadline: Number(row['deadline']),
      requestMessageId: String(row['requestMessageId']),
      responseMessageId: asString(row['responseMessageId']),
      attempts: Number(row['attempts'] ?? 0),
      createdAt: Number(row['createdAt']),
      updatedAt: Number(row['updatedAt']),
    }
  }

  insertExchange(exchange: ExchangeRecord): void {
    this.db.prepare(`INSERT INTO exchanges (id, quno_id, kind, requester, responder, status, deadline,
      request_message_id, response_message_id, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      exchange.id,
      exchange.qunoId,
      exchange.kind,
      exchange.requester,
      exchange.responder,
      exchange.status,
      exchange.deadline,
      exchange.requestMessageId,
      exchange.responseMessageId,
      exchange.attempts,
      exchange.createdAt,
      exchange.updatedAt,
    )
  }

  getExchange(id: ExchangeId): ExchangeRecord | undefined {
    const row = this.db.prepare(`${this.exchangeSelect()} WHERE id = ?`).get(id) as Row | undefined
    return row === undefined ? undefined : this.exchangeFromRow(row)
  }

  updateExchange(
    id: ExchangeId,
    patch: Partial<Pick<ExchangeRecord, 'status' | 'responseMessageId' | 'attempts' | 'updatedAt'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status) }
    if (patch.responseMessageId !== undefined) { sets.push('response_message_id = ?'); params.push(patch.responseMessageId) }
    if (patch.attempts !== undefined) { sets.push('attempts = ?'); params.push(patch.attempts) }
    if (patch.updatedAt !== undefined) { sets.push('updated_at = ?'); params.push(patch.updatedAt) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE exchanges SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  listExchanges(qunoId: string, filter: { readonly status?: readonly ExchangeStatus[]; readonly limit?: number } = {}): readonly ExchangeRecord[] {
    const clauses = ['quno_id = ?']
    const params: (string | number)[] = [qunoId]
    if (filter.status !== undefined && filter.status.length > 0) {
      clauses.push(`status IN (${filter.status.map(() => '?').join(', ')})`)
      params.push(...filter.status)
    }
    params.push(filter.limit ?? 100)
    const rows = this.db.prepare(`${this.exchangeSelect()} WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...params) as Row[]
    return rows.map(row => this.exchangeFromRow(row))
  }

  listExchangesDue(now: number, limit: number): readonly ExchangeRecord[] {
    const rows = this.db.prepare(`${this.exchangeSelect()} WHERE status IN ('pending', 'delivered') AND deadline < ?
      ORDER BY deadline, rowid LIMIT ?`).all(now, limit) as Row[]
    return rows.map(row => this.exchangeFromRow(row))
  }

  insertExchangeMessage(message: ExchangeMessageRecord): void {
    this.db.prepare(`INSERT INTO exchange_messages (id, exchange_id, kind, producer_endpoint, payload_json,
      content_ref_json, content_hash, response_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(exchange_id, kind, content_hash) DO NOTHING`).run(
      message.id,
      message.exchangeId,
      message.kind,
      message.producerEndpoint,
      message.payload === undefined ? null : toJson(message.payload),
      message.contentRef === null ? null : toJson(message.contentRef),
      message.contentHash,
      message.responseTo,
      message.createdAt,
    )
  }

  private exchangeMessageFromRow(row: Row): ExchangeMessageRecord {
    return {
      id: String(row['id']),
      exchangeId: String(row['exchangeId']),
      kind: String(row['kind']) as ExchangeMessageRecord['kind'],
      producerEndpoint: String(row['producerEndpoint']),
      payload: fromJson(row['payloadJson'], null),
      contentRef: fromJson(row['contentRefJson'], null),
      contentHash: String(row['contentHash']),
      responseTo: asString(row['responseTo']),
      createdAt: Number(row['createdAt']),
    }
  }

  getExchangeMessages(exchangeId: ExchangeId): readonly ExchangeMessageRecord[] {
    const rows = this.db.prepare(`SELECT id, exchange_id AS exchangeId, kind, producer_endpoint AS producerEndpoint,
      payload_json AS payloadJson, content_ref_json AS contentRefJson, content_hash AS contentHash,
      response_to AS responseTo, created_at AS createdAt
      FROM exchange_messages WHERE exchange_id = ? ORDER BY rowid`).all(exchangeId) as Row[]
    return rows.map(row => this.exchangeMessageFromRow(row))
  }

  findExchangeMessageByHash(exchangeId: ExchangeId, kind: ExchangeMessageRecord['kind'], contentHash: string): ExchangeMessageRecord | undefined {
    const row = this.db.prepare(`SELECT id, exchange_id AS exchangeId, kind, producer_endpoint AS producerEndpoint,
      payload_json AS payloadJson, content_ref_json AS contentRefJson, content_hash AS contentHash,
      response_to AS responseTo, created_at AS createdAt
      FROM exchange_messages WHERE exchange_id = ? AND kind = ? AND content_hash = ?`).get(exchangeId, kind, contentHash) as Row | undefined
    return row === undefined ? undefined : this.exchangeMessageFromRow(row)
  }

  updateExchangeFields(
    id: ExchangeId,
    patch: Partial<Pick<ExchangeRecord, 'requester' | 'responder' | 'deadline'>>,
  ): void {
    const sets: string[] = []
    const params: (string | number)[] = []
    if (patch.requester !== undefined) { sets.push('requester = ?'); params.push(patch.requester) }
    if (patch.responder !== undefined) { sets.push('responder = ?'); params.push(patch.responder) }
    if (patch.deadline !== undefined) { sets.push('deadline = ?'); params.push(patch.deadline) }
    if (sets.length === 0) return
    params.push(id)
    this.db.prepare(`UPDATE exchanges SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }

  // --------------------------------------------------------------- effects

  private effectSelect(): string {
    return `SELECT kind, key, payload_json AS payloadJson, seq, generation, attempts,
      due_at AS dueAt, since, last_error AS lastError FROM effects`
  }

  private effectFromRow(row: Row): EffectRecord {
    return {
      kind: String(row['kind']) as EffectKind,
      key: String(row['key']),
      payload: fromJson(row['payloadJson'], null),
      seq: Number(row['seq']),
      generation: Number(row['generation']),
      attempts: Number(row['attempts'] ?? 0),
      dueAt: Number(row['dueAt']),
      since: Number(row['since']),
      lastError: asString(row['lastError']),
    }
  }

  enqueueEffect(input: EffectInput): EffectRecord {
    const existing = this.getEffect(input.kind, input.key)
    const record: EffectRecord = {
      kind: input.kind,
      key: input.key,
      payload: input.payload,
      seq: (existing?.seq ?? 0) + 1,
      generation: (existing?.generation ?? 0) + 1,
      attempts: 0,
      dueAt: input.dueAt ?? input.now,
      since: existing?.since ?? input.now,
      lastError: null,
    }
    this.db.prepare(`INSERT INTO effects (kind, key, payload_json, seq, generation, attempts, due_at, since, last_error)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)
      ON CONFLICT(kind, key) DO UPDATE SET payload_json = excluded.payload_json, seq = excluded.seq,
        generation = excluded.generation, attempts = 0, due_at = excluded.due_at, last_error = NULL`)
      .run(record.kind, record.key, toJson(record.payload), record.seq, record.generation, record.dueAt, record.since)
    return record
  }

  listDueEffects(now: number, limit: number): readonly EffectRecord[] {
    const rows = this.db.prepare(`${this.effectSelect()} WHERE due_at <= ? ORDER BY due_at, seq LIMIT ?`).all(now, limit) as Row[]
    return rows.map(row => this.effectFromRow(row))
  }

  getEffect(kind: EffectKind, key: string): EffectRecord | undefined {
    const row = this.db.prepare(`${this.effectSelect()} WHERE kind = ? AND key = ?`).get(kind, key) as Row | undefined
    return row === undefined ? undefined : this.effectFromRow(row)
  }

  completeEffect(kind: EffectKind, key: string, seq: number, generation: number): boolean {
    const result = this.db.prepare('DELETE FROM effects WHERE kind = ? AND key = ? AND seq = ? AND generation = ?')
      .run(kind, key, seq, generation)
    return Number(result.changes) > 0
  }

  failEffect(kind: EffectKind, key: string, seq: number, generation: number, error: string, nextDueAt: number): boolean {
    const result = this.db.prepare(`UPDATE effects SET attempts = attempts + 1, last_error = ?, due_at = ?
      WHERE kind = ? AND key = ? AND seq = ? AND generation = ?`).run(error, nextDueAt, kind, key, seq, generation)
    return Number(result.changes) > 0
  }

  // ------------------------------------------------------------- attention

  linkAttention(link: AttentionLink & { readonly qunoId: string }): void {
    this.db.prepare(`INSERT INTO attention_links (quno_id, item_id, target_type, target_id) VALUES (?, ?, ?, ?)
      ON CONFLICT(item_id, target_type, target_id) DO NOTHING`)
      .run(link.qunoId, link.itemId, link.targetType, link.targetId)
  }

  listAttentionLinks(itemId: string): readonly AttentionLink[] {
    return (this.db.prepare(`SELECT item_id AS itemId, target_type AS targetType, target_id AS targetId
      FROM attention_links WHERE item_id = ? ORDER BY rowid`).all(itemId) as Row[]).map(row => ({
      itemId: String(row['itemId']),
      targetType: String(row['targetType']) as AttentionLink['targetType'],
      targetId: String(row['targetId']),
    }))
  }

  listAttentionLinksByTarget(targetType: AttentionLink['targetType'], targetId: string): readonly AttentionLink[] {
    return (this.db.prepare(`SELECT item_id AS itemId, target_type AS targetType, target_id AS targetId
      FROM attention_links WHERE target_type = ? AND target_id = ? ORDER BY rowid`).all(targetType, targetId) as Row[]).map(row => ({
      itemId: String(row['itemId']),
      targetType: String(row['targetType']) as AttentionLink['targetType'],
      targetId: String(row['targetId']),
    }))
  }

  // --------------------------------------------------------------- helpers

  bumpCounter(name: string): number {
    const row = this.db.prepare('SELECT value FROM meta_rows WHERE key = ?').get(`counter:${name}`) as { value?: string } | undefined
    const next = (row?.value === undefined ? 0 : Number(row.value) || 0) + 1
    this.db.prepare(`INSERT INTO meta_rows (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`counter:${name}`, String(next))
    return next
  }
}
