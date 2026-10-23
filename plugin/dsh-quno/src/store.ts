/**
 * Quno's dedicated SQLite repository.
 *
 * Why a private database instead of the harness storage KV: the event inbox,
 * routing cursor, delivery settlement, attention revisions, run fence and the
 * notification outbox must commit in ONE transaction (design §11). The storage
 * seam offers no multi-record transaction contract.
 *
 * Driver: `node:sqlite` (`DatabaseSync`) — available in the pinned desktop
 * runtime (Node 24) and in Electron's Node mode. WAL + `synchronous=FULL`
 * keeps an ACK honest: a committed batch survives process loss.
 *
 * @module dsh-quno/store
 */

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import type {
  AttentionHistoryRecord,
  AttentionItemRecord,
  AttentionStatus,
  BatchId,
  DeliveryRecord,
  DeliveryStatus,
  EffectivePriority,
  EventId,
  EventRecord,
  NoticeAttemptRecord,
  NoticePayload,
  NoticeRecord,
  NoticeStatus,
  QunoConfig,
  QunoId,
  QunoRecord,
  RunCost,
  RunId,
  RunOutput,
  RunRecord,
  RunStatus,
  SenseCheckpoint,
  SenseDesiredState,
  SenseHealthDetail,
  SenseHealthState,
  SenseInstanceId,
  SenseInstanceRecord,
  SenseLifecycle,
  SenseTypeRecord,
  SourceId,
  SourceRecord,
  SubscriptionFilter,
  SubscriptionRecord,
  SuggestedPriority,
  TaskArtifact,
  TaskId,
  TaskRecord,
  TaskStatus,
} from './types.ts'
import { newId, safeJsonParse } from './util.ts'

/** Current schema version; bump with a migration entry when the shape changes. */
export const SCHEMA_VERSION = 1

/** One process's write ownership over a Quno data directory. */
const LOCK_FILE = 'quno.lock'

/** A lock whose heartbeat is older than this is stale (crash or abandoned test). */
const LOCK_STALE_MS = 10 * 60_000

class QunoLock {
  private held = false
  private readonly path: string

  constructor(private readonly root: string) {
    this.path = join(root, LOCK_FILE)
  }

  acquire(now: number): void {
    if (this.held) return
    try {
      const existing = readFileSync(this.path, 'utf8')
      const parsed = safeJsonParse(existing) as { pid?: number; at?: number } | undefined
      const pid = parsed?.pid
      const at = parsed?.at ?? 0
      const stale = now - at > LOCK_STALE_MS
      if (pid !== undefined && pid !== process.pid && isAlive(pid) && !stale) {
        throw new Error(
          `another Quno Host (pid ${String(pid)}) owns ${this.root}; stop it before starting a second one`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('owns')) throw error
      // Missing/unreadable lock is not an owner.
    }
    writeFileSync(this.path, JSON.stringify({ pid: process.pid, at: now }))
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // best effort on filesystems without POSIX modes
    }
    this.held = true
  }

  heartbeat(now: number): void {
    if (!this.held) return
    try {
      writeFileSync(this.path, JSON.stringify({ pid: process.pid, at: now }))
    } catch {
      // A heartbeat failure must not take down the assistant; the next open
      // will see a stale lock only after the grace window.
    }
  }

  release(): void {
    if (!this.held) return
    this.held = false
    try {
      const parsed = safeJsonParse(readFileSync(this.path, 'utf8')) as { pid?: number } | undefined
      if (parsed?.pid === process.pid) unlinkSync(this.path)
    } catch {
      // already gone
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Options for opening the repository. */
export interface QunoStoreOptions {
  /** Directory holding `quno.sqlite` (and later attachments). */
  readonly root: string
  /** Logger sink for recovery diagnostics. */
  readonly logger?: { warn: (message: string) => void; info?: (message: string) => void }
  /** Override the lock behaviour (tests that simulate a hostile second writer). */
  readonly lock?: boolean
}

/** A ready delivery joined with its event's source (selection needs fairness key). */
export interface ReadyDelivery extends DeliveryRecord {
  readonly sourceId: string
}

/** One stored event identity result during append. */
export interface AppendedEvent {
  readonly id: EventId
  readonly eventKey: string
  readonly status: 'accepted' | 'duplicate'
}

/** One batch row plus its outcome. */
export interface StoredBatch {
  readonly batchId: BatchId
  readonly contentHash: string
  readonly acceptedCount: number
  readonly duplicateCount: number
  readonly checkpointRevision: number
}

const EVENT_COLUMNS = `id, source_id, event_key, subject_key, subject_revision, type, schema, operation,
  occurred_at, observed_at, received_at, ingest_seq, summary, data_json, priority, deadline,
  provenance_json, correlation_keys_json, supersedes_json, parents_json, content_hash,
  sense_config_revision, expires_at, pruned_at`

const ATTENTION_COLUMNS = `id, quno_id, topic_key, title, summary, status, revision, material_revision,
  subject_refs_json, evidence_json, next_review_at, snoozed_until, created_at, updated_at`

const NOTICE_COLUMNS = `id, quno_id, topic_key, material_revision, reminder_stage, kind, payload_json,
  message_id, message_version, status, reason, eligible_at, expires_at, attempts, created_at, updated_at`

const TASK_COLUMNS = `id, quno_id, child_session_id, parent_session_id, job_id, title, prompt, plan, status,
  result_digest, result, artifacts_json, error_json, created_at, updated_at, settled_at`

function json(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  const parsed = safeJsonParse(value)
  return (parsed === undefined ? fallback : parsed) as T
}

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function asNumberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : asNumber(value)
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** One open Quno database with typed repositories over plain SQL. */
export class QunoStore {
  readonly root: string
  readonly dbPath: string
  private db: DatabaseSync | undefined
  private txDepth = 0
  private readonly lock: QunoLock | undefined
  private readonly logger: QunoStoreOptions['logger']

  constructor(options: QunoStoreOptions) {
    this.root = options.root
    this.dbPath = join(options.root, 'quno.sqlite')
    this.logger = options.logger
    this.lock = options.lock === false ? undefined : new QunoLock(options.root)
  }

  /** Open (creating directories, schema and the write lock as needed). */
  open(now = Date.now()): void {
    if (this.db !== undefined) return
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    this.lock?.acquire(now)
    const db = new DatabaseSync(this.dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    this.db = db
    this.migrate(now)
  }

  /** Close the connection and release write ownership. */
  close(): void {
    if (this.db === undefined) return
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // a failed checkpoint still closes
    }
    this.db.close()
    this.db = undefined
    this.lock?.release()
  }

  /** Whether the store is open. */
  get opened(): boolean {
    return this.db !== undefined
  }

  /** Refresh the ownership heartbeat (called by the scheduler on every tick). */
  heartbeat(now = Date.now()): void {
    this.lock?.heartbeat(now)
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new Error('quno store is not open')
    return this.db
  }

  /** Run `work` inside one immediate transaction (nested calls join the outer transaction). */
  transaction<T>(work: () => T): T {
    const db = this.requireDb()
    if (this.txDepth > 0) return work()
    db.exec('BEGIN IMMEDIATE')
    this.txDepth += 1
    try {
      const value = work()
      db.exec('COMMIT')
      return value
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // the original error is the useful one
      }
      throw error
    } finally {
      this.txDepth -= 1
    }
  }

  private migrate(now: number): void {
    const db = this.requireDb()
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const version = asNumber(row?.user_version ?? 0)
    if (version >= SCHEMA_VERSION) return
    db.exec('BEGIN IMMEDIATE')
    try {
      if (version < 1) this.createV1(now)
      db.exec(`PRAGMA user_version = ${String(SCHEMA_VERSION)}`)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // ignore
      }
      throw error
    }
  }

  private createV1(now: number): void {
    const db = this.requireDb()
    db.exec(`
      CREATE TABLE qunos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        persona TEXT NOT NULL,
        instructions TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        reasoning_effort TEXT,
        main_session_id TEXT,
        main_session_state TEXT NOT NULL DEFAULT 'unbound',
        muted_until INTEGER,
        config_json TEXT NOT NULL,
        config_revision INTEGER NOT NULL DEFAULT 1,
        next_check_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE sense_types (
        type TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL,
        implementation_version TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        registered_at INTEGER NOT NULL
      );

      CREATE TABLE sense_instances (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        type TEXT NOT NULL,
        label TEXT NOT NULL,
        config_json TEXT NOT NULL,
        config_revision INTEGER NOT NULL DEFAULT 1,
        desired_state TEXT NOT NULL DEFAULT 'disabled',
        lifecycle TEXT NOT NULL DEFAULT 'stopped',
        health TEXT NOT NULL DEFAULT 'unknown',
        health_json TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        checkpoint_json TEXT,
        checkpoint_revision INTEGER NOT NULL DEFAULT 0,
        last_attempt_at INTEGER,
        last_success_at INTEGER,
        last_event_at INTEGER,
        next_retry_at INTEGER,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (quno_id) REFERENCES qunos(id)
      );
      CREATE INDEX sense_instances_quno ON sense_instances(quno_id, type);

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (instance_id)
      );

      CREATE TABLE sense_batches (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        batch_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        accepted_count INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL,
        checkpoint_revision INTEGER NOT NULL,
        statuses_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (source_id, batch_key)
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        subject_key TEXT,
        subject_revision TEXT,
        type TEXT NOT NULL,
        schema TEXT NOT NULL,
        operation TEXT NOT NULL,
        occurred_at INTEGER,
        observed_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        ingest_seq INTEGER NOT NULL UNIQUE,
        summary TEXT,
        data_json TEXT,
        priority TEXT NOT NULL,
        deadline INTEGER,
        provenance_json TEXT NOT NULL,
        correlation_keys_json TEXT,
        supersedes_json TEXT,
        parents_json TEXT,
        content_hash TEXT NOT NULL,
        sense_config_revision INTEGER NOT NULL,
        expires_at INTEGER,
        pruned_at INTEGER,
        UNIQUE (source_id, event_key)
      );
      CREATE INDEX events_subject ON events(subject_key, occurred_at);
      CREATE INDEX events_time ON events(occurred_at, ingest_seq);
      CREATE INDEX events_type ON events(type, ingest_seq);
      CREATE INDEX events_source ON events(source_id, ingest_seq);

      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        filter_json TEXT NOT NULL,
        start_ingest_seq INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        UNIQUE (quno_id, source_id)
      );

      CREATE TABLE routing_cursors (
        quno_id TEXT PRIMARY KEY,
        through_ingest_seq INTEGER NOT NULL
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'p2',
        eligible_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        run_id TEXT,
        reason TEXT,
        claimed_at INTEGER,
        settled_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (quno_id, event_id)
      );
      CREATE INDEX deliveries_ready ON deliveries(quno_id, status, eligible_at);
      CREATE INDEX deliveries_run ON deliveries(run_id);

      CREATE TABLE attention_items (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        material_revision INTEGER NOT NULL DEFAULT 1,
        subject_refs_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        next_review_at INTEGER,
        snoozed_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (quno_id, topic_key)
      );
      CREATE INDEX attention_due ON attention_items(quno_id, status, next_review_at);

      CREATE TABLE attention_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        quno_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        material INTEGER NOT NULL,
        cause TEXT NOT NULL,
        run_id TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX attention_history_item ON attention_history(item_id, seq);

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        trigger TEXT NOT NULL,
        config_revision INTEGER NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        fence INTEGER NOT NULL,
        claim_expires_at INTEGER,
        input_event_ids_json TEXT NOT NULL,
        input_attention_ids_json TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        result_json TEXT,
        error_json TEXT,
        provider TEXT,
        model TEXT,
        cost_json TEXT
      );
      CREATE INDEX runs_status ON runs(quno_id, status, started_at);
      CREATE INDEX runs_started ON runs(started_at);

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        child_session_id TEXT,
        parent_session_id TEXT,
        job_id TEXT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        plan TEXT,
        status TEXT NOT NULL,
        result_digest TEXT,
        result TEXT,
        artifacts_json TEXT NOT NULL,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE INDEX tasks_status ON tasks(quno_id, status, created_at);

      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        material_revision INTEGER NOT NULL,
        reminder_stage INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        message_id TEXT,
        message_version INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        reason TEXT,
        eligible_at INTEGER NOT NULL,
        expires_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (quno_id, topic_key, material_revision, reminder_stage)
      );
      CREATE INDEX outbox_ready ON notification_outbox(status, eligible_at);
      CREATE INDEX outbox_quno ON notification_outbox(quno_id, created_at);

      CREATE TABLE notification_attempts (
        id TEXT PRIMARY KEY,
        notification_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        message_id TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX attempts_notice ON notification_attempts(notification_id, attempt);

      CREATE TABLE feedback (
        id TEXT PRIMARY KEY,
        quno_id TEXT NOT NULL,
        item_id TEXT,
        topic_key TEXT,
        action TEXT NOT NULL,
        note TEXT,
        revision INTEGER,
        channel TEXT NOT NULL,
        at INTEGER NOT NULL
      );

      CREATE TABLE meta_rows (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO meta_rows (key, value) VALUES ('created_at', '${String(now)}');
    `)
  }

  // ------------------------------------------------------------------ quno

  /** Ensure the single v1 Quno row exists. */
  ensureQuno(input: {
    readonly id: QunoId
    readonly name: string
    readonly persona: string
    readonly instructions: string
    readonly config: QunoConfig
    readonly now: number
  }): QunoRecord {
    return this.transaction(() => {
      const db = this.requireDb()
      const existing = this.getQuno(input.id, { required: false })
      if (existing !== undefined) return existing
      db.prepare(`INSERT INTO qunos (id, name, persona, instructions, config_json, config_revision,
        created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(
        input.id, input.name, input.persona, input.instructions, json(input.config), input.now, input.now,
      )
      return this.requireQuno(input.id)
    })
  }

  private requireQuno(id: QunoId): QunoRecord {
    const row = this.getQuno(id)
    if (row === undefined) throw new Error(`quno "${id}" is not provisioned`)
    return row
  }

  /** Read one Quno row. */
  getQuno(id: QunoId = 'quno', options: { required?: boolean } = {}): QunoRecord | undefined {
    const row = this.requireDb().prepare('SELECT * FROM qunos WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row === undefined) {
      if (options.required === false) return undefined
      throw new Error(`quno "${id}" is not provisioned`)
    }
    return {
      id: String(row['id']),
      name: String(row['name']),
      persona: String(row['persona']),
      instructions: String(row['instructions']),
      modelProvider: String(row['model_provider']),
      model: String(row['model']),
      reasoningEffort: asStringOrNull(row['reasoning_effort']),
      mainSessionId: asStringOrNull(row['main_session_id']),
      mainSessionState: String(row['main_session_state']) as QunoRecord['mainSessionState'],
      mutedUntil: asNumberOrNull(row['muted_until']),
      config: parseJson(row['config_json'], {} as QunoConfig),
      configRevision: asNumber(row['config_revision']),
      nextCheckAt: asNumberOrNull(row['next_check_at']),
      createdAt: asNumber(row['created_at']),
      updatedAt: asNumber(row['updated_at']),
    }
  }

  /** Update persona/instructions/model routing and bump the config revision. */
  updateQunoProfile(id: QunoId, patch: {
    readonly name?: string
    readonly persona?: string
    readonly instructions?: string
    readonly modelProvider?: string
    readonly model?: string
    readonly reasoningEffort?: string | null
  }, now: number): QunoRecord {
    const current = this.requireQuno(id)
    const next = {
      name: patch.name ?? current.name,
      persona: patch.persona ?? current.persona,
      instructions: patch.instructions ?? current.instructions,
      modelProvider: patch.modelProvider ?? current.modelProvider,
      model: patch.model ?? current.model,
      reasoningEffort: patch.reasoningEffort === undefined ? current.reasoningEffort : patch.reasoningEffort,
    }
    this.requireDb().prepare(`UPDATE qunos SET name = ?, persona = ?, instructions = ?, model_provider = ?,
      model = ?, reasoning_effort = ?, config_revision = config_revision + 1, updated_at = ? WHERE id = ?`).run(
      next.name, next.persona, next.instructions, next.modelProvider, next.model, next.reasoningEffort, now, id,
    )
    return this.requireQuno(id)
  }

  /** Replace the Quno config (validated by the caller) and bump its revision. */
  updateQunoConfig(id: QunoId, config: QunoConfig, now: number): QunoRecord {
    this.requireDb().prepare(`UPDATE qunos SET config_json = ?, config_revision = config_revision + 1,
      updated_at = ? WHERE id = ?`).run(json(config), now, id)
    return this.requireQuno(id)
  }

  /** Bind (or detach) the main conversation. */
  setMainSession(id: QunoId, sessionId: string | null, state: QunoRecord['mainSessionState'], now: number): void {
    this.requireDb().prepare(`UPDATE qunos SET main_session_id = ?, main_session_state = ?,
      updated_at = ? WHERE id = ?`).run(sessionId, state, now, id)
  }

  /** Persist the earliest due instant (the timer is only an acceleration hint). */
  setNextCheckAt(id: QunoId, at: number | null): void {
    this.requireDb().prepare('UPDATE qunos SET next_check_at = ? WHERE id = ?').run(at, id)
  }

  /** Set or clear the short-term mute instant. */
  setMutedUntil(id: QunoId, until: number | null, now: number): void {
    this.requireDb().prepare('UPDATE qunos SET muted_until = ?, updated_at = ? WHERE id = ?').run(until, now, id)
  }

  // ---------------------------------------------------------------- senses

  /** Register (or refresh) a Sense type declaration. */
  upsertSenseType(record: SenseTypeRecord): void {
    this.requireDb().prepare(`INSERT INTO sense_types (type, contract_version, implementation_version,
      definition_json, registered_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(type) DO UPDATE SET contract_version = excluded.contract_version,
        implementation_version = excluded.implementation_version,
        definition_json = excluded.definition_json, registered_at = excluded.registered_at`).run(
      record.type, record.contractVersion, record.implementationVersion, json(record.definition), record.registeredAt,
    )
  }

  /** Remove a Sense type when its plugin unregisters. Instances stay for history. */
  deleteSenseType(type: string): void {
    this.requireDb().prepare('DELETE FROM sense_types WHERE type = ?').run(type)
  }

  /** All registered Sense types. */
  listSenseTypes(): SenseTypeRecord[] {
    const rows = this.requireDb().prepare('SELECT * FROM sense_types ORDER BY type').all() as Record<string, unknown>[]
    return rows.map(row => ({
      type: String(row['type']),
      contractVersion: asNumber(row['contract_version']),
      implementationVersion: String(row['implementation_version']),
      definition: parseJson(row['definition_json'], null),
      registeredAt: asNumber(row['registered_at']),
    }))
  }

  /** Insert one Sense instance configuration. */
  insertSenseInstance(input: {
    readonly id: SenseInstanceId
    readonly qunoId: QunoId
    readonly type: string
    readonly label: string
    readonly config: Record<string, unknown>
    readonly desiredState: SenseDesiredState
    readonly now: number
  }): SenseInstanceRecord {
    this.requireDb().prepare(`INSERT INTO sense_instances (id, quno_id, type, label, config_json,
      desired_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.qunoId, input.type, input.label, json(input.config), input.desiredState, input.now, input.now,
    )
    return this.getSenseInstance(input.id)
  }

  /** Read one Sense instance. */
  getSenseInstance(id: SenseInstanceId): SenseInstanceRecord {
    const row = this.requireDb().prepare('SELECT * FROM sense_instances WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row === undefined) throw new Error(`sense instance "${id}" does not exist`)
    return mapSenseInstance(row)
  }

  /** All Sense instances for one Quno. */
  listSenseInstances(qunoId: QunoId): SenseInstanceRecord[] {
    const rows = this.requireDb().prepare('SELECT * FROM sense_instances WHERE quno_id = ? ORDER BY created_at').all(qunoId) as Record<string, unknown>[]
    return rows.map(mapSenseInstance)
  }

  /** Patch an instance row. Generation changes are explicit ({@link bumpGeneration}). */
  updateSenseInstance(id: SenseInstanceId, patch: {
    readonly label?: string
    readonly config?: Record<string, unknown>
    readonly configRevision?: number
    readonly desiredState?: SenseDesiredState
    readonly lifecycle?: SenseLifecycle
    readonly health?: SenseHealthState
    readonly healthDetail?: SenseHealthDetail | null
    readonly checkpoint?: SenseCheckpoint
    readonly lastAttemptAt?: number | null
    readonly lastSuccessAt?: number | null
    readonly lastEventAt?: number | null
    readonly nextRetryAt?: number | null
    readonly consecutiveFailures?: number
    readonly errorCode?: string | null
    readonly now: number
  }): SenseInstanceRecord {
    const current = this.getSenseInstance(id)
    const next = {
      label: patch.label ?? current.label,
      config: patch.config ?? current.config,
      configRevision: patch.configRevision ?? current.configRevision,
      desiredState: patch.desiredState ?? current.desiredState,
      lifecycle: patch.lifecycle ?? current.lifecycle,
      health: patch.health ?? current.health,
      healthDetail: patch.healthDetail === undefined ? current.healthDetail : patch.healthDetail,
      checkpoint: patch.checkpoint ?? current.checkpoint,
      lastAttemptAt: patch.lastAttemptAt === undefined ? current.lastAttemptAt : patch.lastAttemptAt,
      lastSuccessAt: patch.lastSuccessAt === undefined ? current.lastSuccessAt : patch.lastSuccessAt,
      lastEventAt: patch.lastEventAt === undefined ? current.lastEventAt : patch.lastEventAt,
      nextRetryAt: patch.nextRetryAt === undefined ? current.nextRetryAt : patch.nextRetryAt,
      consecutiveFailures: patch.consecutiveFailures ?? current.consecutiveFailures,
      errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
    }
    this.requireDb().prepare(`UPDATE sense_instances SET label = ?, config_json = ?, config_revision = ?,
      desired_state = ?, lifecycle = ?, health = ?, health_json = ?, checkpoint_json = ?,
      checkpoint_revision = ?, last_attempt_at = ?, last_success_at = ?, last_event_at = ?,
      next_retry_at = ?, consecutive_failures = ?, error_code = ?, updated_at = ? WHERE id = ?`).run(
      next.label, json(next.config), next.configRevision, next.desiredState, next.lifecycle, next.health,
      next.healthDetail === null ? null : json(next.healthDetail), json(next.checkpoint),
      next.checkpoint.revision, next.lastAttemptAt, next.lastSuccessAt, next.lastEventAt, next.nextRetryAt,
      next.consecutiveFailures, next.errorCode, patch.now, id,
    )
    return this.getSenseInstance(id)
  }

  /** Start a new writable generation for one instance and return it. */
  bumpGeneration(id: SenseInstanceId, now: number): number {
    const db = this.requireDb()
    db.prepare('UPDATE sense_instances SET generation = generation + 1, updated_at = ? WHERE id = ?').run(now, id)
    const row = db.prepare('SELECT generation FROM sense_instances WHERE id = ?').get(id) as { generation?: number } | undefined
    return asNumber(row?.generation ?? 1)
  }

  /** Delete an instance (history of other Qunos is untouched). */
  deleteSenseInstance(id: SenseInstanceId): void {
    this.requireDb().prepare('DELETE FROM sense_instances WHERE id = ?').run(id)
  }

  /** Stable source identity for one instance (created once, never rotated). */
  ensureSource(instance: SenseInstanceRecord, scope: string | null, now: number): SourceRecord {
    return this.transaction(() => {
      const db = this.requireDb()
      const existing = db.prepare('SELECT * FROM sources WHERE instance_id = ?').get(instance.id) as Record<string, unknown> | undefined
      if (existing !== undefined) return mapSource(existing)
      const id = newId('src')
      db.prepare('INSERT INTO sources (id, quno_id, instance_id, type, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        id, instance.qunoId, instance.id, instance.type, scope, now,
      )
      return { id, qunoId: instance.qunoId, instanceId: instance.id, type: instance.type, scope, createdAt: now }
    })
  }

  /** Sources belonging to one Quno. */
  listSources(qunoId: QunoId): SourceRecord[] {
    const rows = this.requireDb().prepare('SELECT * FROM sources WHERE quno_id = ? ORDER BY created_at').all(qunoId) as Record<string, unknown>[]
    return rows.map(mapSource)
  }

  // -------------------------------------------------------- events/batches

  /** Find a previously committed batch receipt. */
  findBatch(sourceId: SourceId, batchKey: string): {
    batchId: BatchId
    contentHash: string
    acceptedCount: number
    duplicateCount: number
    checkpointRevision: number
    statuses: readonly { readonly eventId: string; readonly eventKey: string; readonly status: 'accepted' | 'duplicate' }[]
  } | undefined {
    const row = this.requireDb().prepare(
      'SELECT * FROM sense_batches WHERE source_id = ? AND batch_key = ?',
    ).get(sourceId, batchKey) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    return {
      batchId: String(row['id']),
      contentHash: String(row['content_hash']),
      acceptedCount: asNumber(row['accepted_count']),
      duplicateCount: asNumber(row['duplicate_count']),
      checkpointRevision: asNumber(row['checkpoint_revision']),
      statuses: parseJson(row['statuses_json'], []),
    }
  }

  /** Low-level event lookup used by the ingress transaction (id only). */
  dbFindEventId(sourceId: SourceId, eventKey: string): string | undefined {
    const row = this.requireDb().prepare(
      'SELECT id FROM events WHERE source_id = ? AND event_key = ?',
    ).get(sourceId, eventKey) as { id?: string } | undefined
    return row?.id === undefined ? undefined : String(row.id)
  }

  /** Low-level event insert used inside the ingress transaction. */
  dbInsertEvent(input: {
    readonly id: EventId
    readonly sourceId: SourceId
    readonly eventKey: string
    readonly subjectKey: string | null
    readonly subjectRevision: string | null
    readonly type: string
    readonly schema: string
    readonly operation: string
    readonly occurredAt: number | null
    readonly observedAt: number
    readonly receivedAt: number
    readonly ingestSeq: number
    readonly summary: string | null
    readonly data: unknown
    readonly priority: SuggestedPriority
    readonly deadline: number | null
    readonly provenance: unknown
    readonly correlationKeys: readonly string[]
    readonly supersedesEventIds: readonly string[]
    readonly parentEventIds: readonly string[]
    readonly contentHash: string
    readonly senseConfigRevision: number
    readonly expiresAt: number | null
  }): void {
    this.requireDb().prepare(`INSERT INTO events (id, source_id, event_key, subject_key, subject_revision,
      type, schema, operation, occurred_at, observed_at, received_at, ingest_seq, summary, data_json,
      priority, deadline, provenance_json, correlation_keys_json, supersedes_json, parents_json,
      content_hash, sense_config_revision, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.sourceId, input.eventKey, input.subjectKey, input.subjectRevision,
      input.type, input.schema, input.operation, input.occurredAt, input.observedAt, input.receivedAt,
      input.ingestSeq, input.summary, input.data === undefined ? null : json(input.data),
      input.priority, input.deadline, json(input.provenance), json(input.correlationKeys),
      json(input.supersedesEventIds), json(input.parentEventIds), input.contentHash,
      input.senseConfigRevision, input.expiresAt,
    )
  }

  /** Low-level batch receipt insert used inside the ingress transaction. */
  dbInsertBatch(input: {
    readonly id: BatchId
    readonly sourceId: SourceId
    readonly generation: number
    readonly batchKey: string
    readonly contentHash: string
    readonly eventCount: number
    readonly acceptedCount: number
    readonly duplicateCount: number
    readonly checkpointRevision: number
    readonly statuses: readonly { readonly eventId: string; readonly eventKey: string; readonly status: string }[]
    readonly now: number
  }): void {
    this.requireDb().prepare(`INSERT INTO sense_batches (id, source_id, generation, batch_key, content_hash,
      event_count, accepted_count, duplicate_count, checkpoint_revision, statuses_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.sourceId, input.generation, input.batchKey, input.contentHash, input.eventCount,
      input.acceptedCount, input.duplicateCount, input.checkpointRevision, json(input.statuses), input.now,
    )
  }

  /** Highest ingest sequence currently stored. */
  maxIngestSeq(): number {
    const row = this.requireDb().prepare('SELECT COALESCE(MAX(ingest_seq), -1) AS seq FROM events').get() as { seq?: number } | undefined
    return asNumber(row?.seq ?? -1)
  }

  /** Read one event. */
  getEvent(id: EventId): EventRecord | undefined {
    const row = this.requireDb().prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapEvent(row)
  }

  /** Read events by id, preserving input order and skipping unknown ids. */
  getEvents(ids: readonly EventId[]): EventRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.requireDb().prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[]
    const byId = new Map(rows.map(row => [String(row['id']), mapEvent(row)]))
    return ids.flatMap((id) => {
      const found = byId.get(id)
      return found === undefined ? [] : [found]
    })
  }

  /** Events after `afterSeq` in ingest order. */
  listEventsAfter(afterSeq: number, limit: number): EventRecord[] {
    const rows = this.requireDb().prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`,
    ).all(afterSeq, limit) as Record<string, unknown>[]
    return rows.map(mapEvent)
  }

  /** The newest events for one subject (used by material-change comparison). */
  listEventsBySubject(sourceId: SourceId, subjectKey: string, limit = 20): EventRecord[] {
    const rows = this.requireDb().prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE source_id = ? AND subject_key = ? ORDER BY ingest_seq DESC LIMIT ?`,
    ).all(sourceId, subjectKey, limit) as Record<string, unknown>[]
    return rows.map(mapEvent)
  }

  /** The newest events across every source, newest first (panel summary; bodies may be pruned). */
  listRecentEvents(limit = 20): EventRecord[] {
    const rows = this.requireDb().prepare(
      `SELECT ${EVENT_COLUMNS} FROM events ORDER BY ingest_seq DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[]
    return rows.map(mapEvent)
  }

  /** Delete or blank expired event bodies that no open work still needs. */
  pruneExpiredEvents(now: number, bodyDays: number): number {
    const cutoff = now - bodyDays * 24 * 60 * 60 * 1000
    const db = this.requireDb()
    const candidates = db.prepare(`SELECT e.id FROM events e
      WHERE e.received_at < ? AND e.pruned_at IS NULL
        AND e.id NOT IN (SELECT event_id FROM deliveries WHERE status IN ('pending','claimed','deferred'))
      LIMIT 500`).all(cutoff) as { id?: string }[]
    if (candidates.length === 0) return 0
    const mark = db.prepare('UPDATE events SET data_json = NULL, pruned_at = ? WHERE id = ?')
    for (const row of candidates) mark.run(now, String(row.id))
    return candidates.length
  }

  // -------------------------------------------------------------- routing

  /** Current routing watermark for one Quno. */
  routingCursor(qunoId: QunoId): number {
    const row = this.requireDb().prepare('SELECT through_ingest_seq FROM routing_cursors WHERE quno_id = ?').get(qunoId) as { through_ingest_seq?: number } | undefined
    return asNumber(row?.through_ingest_seq ?? -1)
  }

  /** Atomically advance the routing watermark (never backwards). */
  advanceRouting(qunoId: QunoId, seq: number): void {
    this.requireDb().prepare(`INSERT INTO routing_cursors (quno_id, through_ingest_seq) VALUES (?, ?)
      ON CONFLICT(quno_id) DO UPDATE SET through_ingest_seq = MAX(routing_cursors.through_ingest_seq, excluded.through_ingest_seq)`).run(
      qunoId, seq,
    )
  }

  /** Subscriptions for one Quno. */
  listSubscriptions(qunoId: QunoId): SubscriptionRecord[] {
    const rows = this.requireDb().prepare('SELECT * FROM subscriptions WHERE quno_id = ?').all(qunoId) as Record<string, unknown>[]
    return rows.map((row) => ({
      id: String(row['id']),
      qunoId: String(row['quno_id']),
      sourceId: String(row['source_id']),
      filter: parseJson(row['filter_json'], {} as SubscriptionFilter),
      startIngestSeq: asNumber(row['start_ingest_seq']),
      revision: asNumber(row['revision']),
      createdAt: asNumber(row['created_at']),
    }))
  }

  /** Ensure a subscription exists for every source of one Quno (default: from now). */
  ensureSubscriptions(qunoId: QunoId, sources: readonly SourceRecord[], now: number): void {
    this.transaction(() => {
      const db = this.requireDb()
      const insert = db.prepare(`INSERT INTO subscriptions (id, quno_id, source_id, filter_json,
        start_ingest_seq, revision, created_at) VALUES (?, ?, ?, '{}', ?, 1, ?)
        ON CONFLICT(quno_id, source_id) DO NOTHING`)
      const current = this.maxIngestSeq()
      for (const source of sources) insert.run(newId('sub'), qunoId, source.id, current, now)
    })
  }

  /** Insert one delivery unless this Quno already has it. */
  insertDelivery(input: {
    readonly qunoId: QunoId
    readonly eventId: EventId
    readonly priority: EffectivePriority
    readonly eligibleAt: number
    readonly now: number
  }): boolean {
    const result = this.requireDb().prepare(`INSERT INTO deliveries (id, quno_id, event_id, status,
      priority, eligible_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(quno_id, event_id) DO NOTHING`).run(
      newId('dlv'), input.qunoId, input.eventId, input.priority, input.eligibleAt, input.now,
    )
    return Number(result.changes) > 0
  }

  /** Count ready deliveries for the preflight (no model involved). */
  countReadyDeliveries(qunoId: QunoId, now: number): number {
    const row = this.requireDb().prepare(`SELECT COUNT(*) AS n FROM deliveries
      WHERE quno_id = ? AND status IN ('pending','deferred') AND eligible_at <= ?`).get(qunoId, now) as { n?: number } | undefined
    return asNumber(row?.n ?? 0)
  }

  /** Oldest ready delivery timestamp (starvation visibility). */
  oldestReadyDeliveryAt(qunoId: QunoId, now: number): number | null {
    const row = this.requireDb().prepare(`SELECT MIN(created_at) AS at FROM deliveries
      WHERE quno_id = ? AND status IN ('pending','deferred') AND eligible_at <= ?`).get(qunoId, now) as { at?: number | null } | undefined
    return row?.at === null || row?.at === undefined ? null : asNumber(row.at)
  }

  /** Ready deliveries for batch selection, priority-first then oldest. */
  listReadyDeliveries(qunoId: QunoId, now: number, limit: number): ReadyDelivery[] {
    const rows = this.requireDb().prepare(`SELECT d.*, e.source_id AS e_source_id
      FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.quno_id = ? AND d.status IN ('pending','deferred') AND d.eligible_at <= ?
      ORDER BY CASE d.priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END,
               d.created_at ASC, d.id ASC
      LIMIT ?`).all(qunoId, now, limit) as Record<string, unknown>[]
    return rows.map(row => ({ ...mapDelivery(row), sourceId: String(row['e_source_id']) }))
  }

  /** Next durable claim fence for one Quno (monotone). */
  nextFence(qunoId: QunoId): number {
    const row = this.requireDb().prepare('SELECT COALESCE(MAX(fence), 0) AS fence FROM runs WHERE quno_id = ?').get(qunoId) as { fence?: number } | undefined
    return asNumber(row?.fence ?? 0) + 1
  }

  /** Claim a chosen set of deliveries for one run (fenced by the run row). */
  claimDeliveries(qunoId: QunoId, runId: RunId, eventIds: readonly EventId[], now: number): void {
    if (eventIds.length === 0) return
    const db = this.requireDb()
    const stmt = db.prepare(`UPDATE deliveries SET status = 'claimed', run_id = ?, claimed_at = ?
      WHERE quno_id = ? AND event_id = ? AND status IN ('pending','deferred')`)
    for (const id of eventIds) stmt.run(runId, now, qunoId, id)
  }

  /** Settle one delivery inside the run commit transaction. */
  settleDelivery(runId: RunId, eventId: EventId, status: DeliveryStatus, reason: string | null, now: number): void {
    this.requireDb().prepare(`UPDATE deliveries SET status = ?, reason = ?, settled_at = ?
      WHERE run_id = ? AND event_id = ?`).run(status, reason, now, runId, eventId)
  }

  /** Defer one delivery to a later eligible instant (time is itself a trigger). */
  deferDelivery(runId: RunId, eventId: EventId, eligibleAt: number, reason: string | null, now: number): void {
    this.requireDb().prepare(`UPDATE deliveries SET status = 'deferred', eligible_at = ?, reason = ?,
      settled_at = ? WHERE run_id = ? AND event_id = ?`).run(eligibleAt, reason, now, runId, eventId)
  }

  /** Return unsettled deliveries of a failed/interrupted run to the ready queue. */
  releaseDeliveries(runId: RunId, retryAt: number): number {
    const result = this.requireDb().prepare(`UPDATE deliveries SET status = 'pending', run_id = NULL,
      eligible_at = ?, attempts = attempts + 1, claimed_at = NULL
      WHERE run_id = ? AND status = 'claimed'`).run(retryAt, runId)
    return Number(result.changes)
  }

  /** Settle one delivery without owning the original run (admin recovery / tests). */
  settleDeliveryDirect(
    qunoId: QunoId,
    eventId: EventId,
    status: DeliveryStatus,
    reason: string | null,
    now: number,
  ): boolean {
    const result = this.requireDb().prepare(`UPDATE deliveries SET status = ?, reason = ?, settled_at = ?
      WHERE quno_id = ? AND event_id = ? AND status IN ('pending','claimed')`).run(status, reason, now, qunoId, eventId)
    return Number(result.changes) > 0
  }

  /** Move poisoned deliveries to dead-letter after bounded attempts. */
  deadLetterExhausted(qunoId: QunoId, now: number, maxAttempts: number): number {
    const result = this.requireDb().prepare(`UPDATE deliveries SET status = 'dead-letter', settled_at = ?,
      reason = COALESCE(reason, 'bounded retries exhausted')
      WHERE quno_id = ? AND status = 'pending' AND attempts >= ?`).run(now, qunoId, maxAttempts)
    return Number(result.changes)
  }

  /** Deliveries for one run (diagnostics). */
  listDeliveriesForRun(runId: RunId): DeliveryRecord[] {
    const rows = this.requireDb().prepare('SELECT * FROM deliveries WHERE run_id = ?').all(runId) as Record<string, unknown>[]
    return rows.map(mapDelivery)
  }

  /** Recent delivery rows for the UI. */
  listDeliveries(qunoId: QunoId, limit = 50): DeliveryRecord[] {
    const rows = this.requireDb().prepare(
      'SELECT * FROM deliveries WHERE quno_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(qunoId, limit) as Record<string, unknown>[]
    return rows.map(mapDelivery)
  }

  /** Count deliveries by status (metrics and UI). */
  countDeliveries(qunoId: QunoId): Record<string, number> {
    const rows = this.requireDb().prepare(
      'SELECT status, COUNT(*) AS n FROM deliveries WHERE quno_id = ? GROUP BY status',
    ).all(qunoId) as { status?: string; n?: number }[]
    const out: Record<string, number> = {}
    for (const row of rows) out[String(row.status)] = asNumber(row.n ?? 0)
    return out
  }

  // ------------------------------------------------------------ attention

  /** Read one attention item. */
  getAttentionItem(id: string): AttentionItemRecord | undefined {
    const row = this.requireDb().prepare(
      `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapAttention(row)
  }

  /** Find an item by its stable topic key. */
  getAttentionByTopic(qunoId: QunoId, topicKey: string): AttentionItemRecord | undefined {
    const row = this.requireDb().prepare(
      `SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE quno_id = ? AND topic_key = ?`,
    ).get(qunoId, topicKey) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapAttention(row)
  }

  /** Items by status, newest material change first. */
  listAttention(qunoId: QunoId, statuses?: readonly AttentionStatus[], limit = 100): AttentionItemRecord[] {
    const rows = statuses === undefined || statuses.length === 0
      ? this.requireDb().prepare(`SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE quno_id = ?
          ORDER BY material_revision DESC, updated_at DESC LIMIT ?`).all(qunoId, limit)
      : this.requireDb().prepare(`SELECT ${ATTENTION_COLUMNS} FROM attention_items WHERE quno_id = ?
          AND status IN (${statuses.map(() => '?').join(',')})
          ORDER BY material_revision DESC, updated_at DESC LIMIT ?`).all(qunoId, ...statuses, limit)
    return (rows as Record<string, unknown>[]).map(mapAttention)
  }

  /** Items whose review instant has arrived (including snoozes). */
  listAttentionDue(qunoId: QunoId, now: number, limit = 50): AttentionItemRecord[] {
    const rows = this.requireDb().prepare(`SELECT ${ATTENTION_COLUMNS} FROM attention_items
      WHERE quno_id = ? AND status IN ('open','waiting','snoozed')
        AND next_review_at IS NOT NULL AND next_review_at <= ?
      ORDER BY next_review_at ASC LIMIT ?`).all(qunoId, now, limit) as Record<string, unknown>[]
    return rows.map(mapAttention)
  }

  /** Count due items for the model-free preflight. */
  countAttentionDue(qunoId: QunoId, now: number): number {
    const row = this.requireDb().prepare(`SELECT COUNT(*) AS n FROM attention_items
      WHERE quno_id = ? AND status IN ('open','waiting','snoozed')
        AND next_review_at IS NOT NULL AND next_review_at <= ?`).get(qunoId, now) as { n?: number } | undefined
    return asNumber(row?.n ?? 0)
  }

  /** Insert a new item (revision 1). */
  insertAttention(input: {
    readonly qunoId: QunoId
    readonly topicKey: string
    readonly title: string
    readonly summary: string
    readonly status: AttentionStatus
    readonly subjectRefs: readonly string[]
    readonly evidence: readonly AttentionItemRecord['evidence'][number][]
    readonly nextReviewAt: number | null
    readonly snoozedUntil: number | null
    readonly material: boolean
    readonly cause: string
    readonly runId: RunId | null
    readonly now: number
  }): AttentionItemRecord {
    const id = newId('att')
    this.requireDb().prepare(`INSERT INTO attention_items (id, quno_id, topic_key, title, summary,
      status, revision, material_revision, subject_refs_json, evidence_json, next_review_at,
      snoozed_until, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`).run(
      id, input.qunoId, input.topicKey, input.title, input.summary, input.status,
      json(input.subjectRefs), json(input.evidence),
      input.nextReviewAt, input.snoozedUntil, input.now, input.now,
    )
    const created = this.getAttentionItem(id)
    if (created === undefined) throw new Error('attention insert vanished')
    this.appendAttentionHistory({
      qunoId: input.qunoId,
      itemId: id,
      revision: 1,
      fromStatus: null,
      toStatus: input.status,
      material: input.material,
      cause: input.cause,
      runId: input.runId,
      at: input.now,
    })
    return created
  }

  /** Update an item with an expected-revision compare-and-swap. */
  updateAttentionCas(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly patch: {
      readonly title?: string
      readonly summary?: string
      readonly status?: AttentionStatus
      readonly material?: boolean
      readonly subjectRefs?: readonly string[]
      readonly evidence?: AttentionItemRecord['evidence']
      readonly nextReviewAt?: number | null
      readonly snoozedUntil?: number | null
    }
    readonly cause: string
    readonly runId: RunId | null
    readonly now: number
  }): AttentionItemRecord | undefined {
    const current = this.getAttentionItem(input.id)
    if (current === undefined || current.revision !== input.expectedRevision) return undefined
    const next = {
      title: input.patch.title ?? current.title,
      summary: input.patch.summary ?? current.summary,
      status: input.patch.status ?? current.status,
      materialRevision: current.materialRevision + (input.patch.material === true ? 1 : 0),
      subjectRefs: input.patch.subjectRefs ?? current.subjectRefs,
      evidence: input.patch.evidence ?? current.evidence,
      nextReviewAt: input.patch.nextReviewAt === undefined ? current.nextReviewAt : input.patch.nextReviewAt,
      snoozedUntil: input.patch.snoozedUntil === undefined ? current.snoozedUntil : input.patch.snoozedUntil,
    }
    const result = this.requireDb().prepare(`UPDATE attention_items SET title = ?, summary = ?, status = ?,
      revision = revision + 1, material_revision = ?, subject_refs_json = ?, evidence_json = ?,
      next_review_at = ?, snoozed_until = ?, updated_at = ?
      WHERE id = ? AND revision = ?`).run(
      next.title, next.summary, next.status, next.materialRevision, json(next.subjectRefs), json(next.evidence),
      next.nextReviewAt, next.snoozedUntil, input.now, input.id, input.expectedRevision,
    )
    if (Number(result.changes) === 0) return undefined
    this.appendAttentionHistory({
      qunoId: current.qunoId,
      itemId: current.id,
      revision: current.revision + 1,
      fromStatus: current.status,
      toStatus: next.status,
      material: input.patch.material === true,
      cause: input.cause,
      runId: input.runId,
      at: input.now,
    })
    return this.getAttentionItem(input.id)
  }

  /** Append one history row (inside the caller's transaction). */
  appendAttentionHistory(entry: Omit<AttentionHistoryRecord, 'seq'>): void {
    this.requireDb().prepare(`INSERT INTO attention_history (quno_id, item_id, revision, from_status,
      to_status, material, cause, run_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.qunoId, entry.itemId, entry.revision, entry.fromStatus, entry.toStatus,
      entry.material ? 1 : 0, entry.cause, entry.runId, entry.at,
    )
  }

  /** Recent history for one item. */
  listAttentionHistory(itemId: string, limit = 50): AttentionHistoryRecord[] {
    const rows = this.requireDb().prepare(
      'SELECT * FROM attention_history WHERE item_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(itemId, limit) as Record<string, unknown>[]
    return rows.map(row => ({
      seq: asNumber(row['seq']),
      qunoId: String(row['quno_id']),
      itemId: String(row['item_id']),
      revision: asNumber(row['revision']),
      fromStatus: (row['from_status'] === null ? null : String(row['from_status'])) as AttentionStatus | null,
      toStatus: String(row['to_status']) as AttentionStatus,
      material: asNumber(row['material']) === 1,
      cause: String(row['cause']),
      runId: asStringOrNull(row['run_id']),
      at: asNumber(row['at']),
    }))
  }

  // ----------------------------------------------------------------- runs

  /** Insert a claimed run row. */
  insertRun(input: {
    readonly id: RunId
    readonly qunoId: QunoId
    readonly kind: 'think' | 'task'
    readonly trigger: string
    readonly configRevision: number
    readonly fence: number
    readonly claimExpiresAt: number | null
    readonly inputEventIds: readonly string[]
    readonly inputAttentionIds: readonly string[]
    readonly now: number
  }): RunRecord {
    this.requireDb().prepare(`INSERT INTO runs (id, quno_id, kind, trigger, config_revision, status,
      fence, claim_expires_at, input_event_ids_json, input_attention_ids_json, started_at)
      VALUES (?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)`).run(
      input.id, input.qunoId, input.kind, input.trigger, input.configRevision, input.fence,
      input.claimExpiresAt, json(input.inputEventIds), json(input.inputAttentionIds), input.now,
    )
    return this.getRun(input.id)
  }

  /** Read one run. */
  getRun(id: RunId): RunRecord {
    const row = this.requireDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (row === undefined) throw new Error(`run "${id}" does not exist`)
    return mapRun(row)
  }

  /** Live or fenced run for one Quno (the single-flight guard). */
  activeRun(qunoId: QunoId): RunRecord | undefined {
    const row = this.requireDb().prepare(
      `SELECT * FROM runs WHERE quno_id = ? AND status IN ('claimed','running') ORDER BY started_at DESC LIMIT 1`,
    ).get(qunoId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapRun(row)
  }

  /** Mark a run's lifecycle phase. */
  updateRunStatus(id: RunId, status: RunStatus, patch: {
    readonly sessionId?: string | null
    readonly provider?: string | null
    readonly model?: string | null
    readonly finishedAt?: number | null
  } = {}): void {
    this.requireDb().prepare(`UPDATE runs SET status = ?, session_id = COALESCE(?, session_id),
      provider = COALESCE(?, provider), model = COALESCE(?, model), finished_at = COALESCE(?, finished_at)
      WHERE id = ?`).run(
      status, patch.sessionId ?? null, patch.provider ?? null, patch.model ?? null, patch.finishedAt ?? null, id,
    )
  }

  /** Commit a run result (caller wraps in the attention/outbox transaction). */
  commitRun(id: RunId, result: RunOutput, cost: RunCost | null, now: number): void {
    this.requireDb().prepare(`UPDATE runs SET status = 'committed', result_json = ?, cost_json = ?,
      finished_at = ? WHERE id = ?`).run(json(result), cost === null ? null : json(cost), now, id)
  }

  /** Mark a run failed with a classified error. */
  failRun(id: RunId, error: { readonly code: string; readonly message: string; readonly retryable?: boolean }, now: number): void {
    this.requireDb().prepare(`UPDATE runs SET status = 'failed', error_json = ?, finished_at = ? WHERE id = ?`).run(
      json(error), now, id,
    )
  }

  /** Interrupt runs whose lease expired (called at boot). */
  expireStaleRuns(now: number): RunRecord[] {
    const rows = this.requireDb().prepare(`SELECT * FROM runs WHERE status IN ('claimed','running')
      AND claim_expires_at IS NOT NULL AND claim_expires_at < ?`).all(now) as Record<string, unknown>[]
    const runs = rows.map(mapRun)
    const settled = runs.map((run) => {
      this.requireDb().prepare(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE id = ?`).run(now, run.id)
      this.releaseDeliveries(run.id, now)
      return { ...run, status: 'interrupted' as const, finishedAt: now }
    })
    return settled
  }

  /** Runs started at or after `since` (daily budget). */
  countRunsSince(qunoId: QunoId, since: number): number {
    const row = this.requireDb().prepare(
      'SELECT COUNT(*) AS n FROM runs WHERE quno_id = ? AND started_at >= ?',
    ).get(qunoId, since) as { n?: number } | undefined
    return asNumber(row?.n ?? 0)
  }

  /** Recent runs for the runs view. */
  listRuns(qunoId: QunoId, limit = 50): RunRecord[] {
    const rows = this.requireDb().prepare(
      'SELECT * FROM runs WHERE quno_id = ? ORDER BY started_at DESC LIMIT ?',
    ).all(qunoId, limit) as Record<string, unknown>[]
    return rows.map(mapRun)
  }

  /** Delete old terminal run diagnostics. */
  pruneRuns(now: number, days: number): number {
    const cutoff = now - days * 24 * 60 * 60 * 1000
    const result = this.requireDb().prepare(
      `DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < ? AND status IN ('committed','failed','interrupted')`,
    ).run(cutoff)
    return Number(result.changes)
  }

  // ---------------------------------------------------------------- tasks

  /** Insert one delegated task. */
  insertTask(input: {
    readonly id: TaskId
    readonly qunoId: QunoId
    readonly childSessionId: string | null
    readonly parentSessionId: string | null
    readonly jobId: string | null
    readonly title: string
    readonly prompt: string
    readonly status: TaskStatus
    readonly now: number
  }): TaskRecord {
    this.requireDb().prepare(`INSERT INTO tasks (id, quno_id, child_session_id, parent_session_id, job_id,
      title, prompt, status, artifacts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`).run(
      input.id, input.qunoId, input.childSessionId, input.parentSessionId, input.jobId,
      input.title, input.prompt, input.status, input.now, input.now,
    )
    return this.getTask(input.id)
  }

  /** Read one task. */
  getTask(id: TaskId): TaskRecord {
    const row = this.requireDb().prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as Record<string, unknown> | undefined
    if (row === undefined) throw new Error(`task "${id}" does not exist`)
    return mapTask(row)
  }

  /** Patch a task row. */
  updateTask(id: TaskId, patch: {
    readonly status?: TaskStatus
    readonly childSessionId?: string | null
    readonly jobId?: string | null
    readonly plan?: string | null
    readonly resultDigest?: string | null
    readonly result?: string | null
    readonly artifacts?: readonly TaskArtifact[]
    readonly error?: TaskRecord['error']
    readonly now: number
  }): TaskRecord {
    const current = this.getTask(id)
    this.requireDb().prepare(`UPDATE tasks SET status = ?, child_session_id = ?, job_id = ?, plan = ?,
      result_digest = ?, result = ?, artifacts_json = ?, error_json = ?, updated_at = ?,
      settled_at = CASE WHEN ? IN ('done','failed','cancelled') THEN COALESCE(settled_at, ?) ELSE settled_at END
      WHERE id = ?`).run(
      patch.status ?? current.status,
      patch.childSessionId === undefined ? current.childSessionId : patch.childSessionId,
      patch.jobId === undefined ? current.jobId : patch.jobId,
      patch.plan === undefined ? current.plan : patch.plan,
      patch.resultDigest === undefined ? current.resultDigest : patch.resultDigest,
      patch.result === undefined ? current.result : patch.result,
      json(patch.artifacts ?? current.artifacts),
      patch.error === undefined ? (current.error === null ? null : json(current.error)) : (patch.error === null ? null : json(patch.error)),
      patch.now,
      patch.status ?? current.status,
      patch.now,
      id,
    )
    return this.getTask(id)
  }

  /** Tasks by status, newest first. */
  listTasks(qunoId: QunoId, statuses?: readonly TaskStatus[], limit = 100): TaskRecord[] {
    const rows = statuses === undefined || statuses.length === 0
      ? this.requireDb().prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE quno_id = ?
          ORDER BY created_at DESC LIMIT ?`).all(qunoId, limit)
      : this.requireDb().prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE quno_id = ?
          AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT ?`).all(qunoId, ...statuses, limit)
    return (rows as Record<string, unknown>[]).map(mapTask)
  }

  // --------------------------------------------------------------- outbox

  /** Enqueue one notice; returns null when the same material revision/stage already exists. */
  enqueueNotice(input: {
    readonly qunoId: QunoId
    readonly topicKey: string
    readonly materialRevision: number
    readonly reminderStage: number
    readonly kind: 'report' | 'task'
    readonly payload: NoticePayload
    readonly eligibleAt: number
    readonly expiresAt: number | null
    readonly now: number
  }): NoticeRecord | null {
    const id = newId('ntf')
    const result = this.requireDb().prepare(`INSERT INTO notification_outbox (id, quno_id, topic_key,
      material_revision, reminder_stage, kind, payload_json, status, eligible_at, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      ON CONFLICT(quno_id, topic_key, material_revision, reminder_stage) DO NOTHING`).run(
      id, input.qunoId, input.topicKey, input.materialRevision, input.reminderStage, input.kind,
      json(input.payload), input.eligibleAt, input.expiresAt, input.now, input.now,
    )
    return Number(result.changes) === 0 ? null : this.getNotice(id)
  }

  /** Read one notice. */
  getNotice(id: string): NoticeRecord {
    const row = this.requireDb().prepare(
      `SELECT ${NOTICE_COLUMNS} FROM notification_outbox WHERE id = ?`,
    ).get(id) as Record<string, unknown> | undefined
    if (row === undefined) throw new Error(`notice "${id}" does not exist`)
    return mapNotice(row)
  }

  /** Ready notices, oldest first. */
  listReadyNotices(now: number, limit = 20): NoticeRecord[] {
    const rows = this.requireDb().prepare(`SELECT ${NOTICE_COLUMNS} FROM notification_outbox
      WHERE status IN ('pending','retryable-failure') AND eligible_at <= ?
      ORDER BY eligible_at ASC, created_at ASC LIMIT ?`).all(now, limit) as Record<string, unknown>[]
    return rows.map(mapNotice)
  }

  /** Find the notice that carries one inbox message id (reconciliation). */
  findNoticeByMessageId(messageId: string): NoticeRecord | undefined {
    const row = this.requireDb().prepare(
      `SELECT ${NOTICE_COLUMNS} FROM notification_outbox WHERE message_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).get(messageId) as Record<string, unknown> | undefined
    return row === undefined ? undefined : mapNotice(row)
  }

  /** Notices in non-terminal states (boot reconciliation). */
  listUnsettledNotices(qunoId: QunoId, limit = 100): NoticeRecord[] {
    const rows = this.requireDb().prepare(`SELECT ${NOTICE_COLUMNS} FROM notification_outbox
      WHERE quno_id = ? AND status IN ('prepared','inbox-durable','uncertain','retryable-failure','pending')
      ORDER BY created_at ASC LIMIT ?`).all(qunoId, limit) as Record<string, unknown>[]
    return rows.map(mapNotice)
  }

  /** Compare-and-swap one notice status (prevents duplicate delivery races). */
  transitionNotice(id: string, from: readonly NoticeStatus[], patch: {
    readonly status?: NoticeStatus
    readonly reason?: string | null
    readonly messageId?: string | null
    readonly eligibleAt?: number
    readonly attempts?: number
    readonly now: number
  }): boolean {
    const current = this.getNotice(id)
    if (!from.includes(current.status)) return false
    const sets = ['status = ?', 'reason = ?', 'updated_at = ?']
    const args: (string | number | null)[] = [
      patch.status ?? current.status,
      patch.reason === undefined ? current.reason : patch.reason,
      patch.now,
    ]
    if (patch.messageId !== undefined) {
      sets.push('message_id = ?')
      args.push(patch.messageId)
    }
    if (patch.eligibleAt !== undefined) {
      sets.push('eligible_at = ?')
      args.push(patch.eligibleAt)
    }
    if (patch.attempts !== undefined) {
      sets.push('attempts = ?')
      args.push(patch.attempts)
    }
    const result = this.requireDb().prepare(
      `UPDATE notification_outbox SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
    ).run(...args, id, current.status)
    return Number(result.changes) > 0
  }

  /** Bump the rendered message version when re-sending a failed expression. */
  bumpNoticeMessageVersion(id: string, now: number): number {
    this.requireDb().prepare('UPDATE notification_outbox SET message_version = message_version + 1, updated_at = ? WHERE id = ?').run(now, id)
    return this.getNotice(id).messageVersion
  }

  /** Append a delivery attempt row. */
  appendNoticeAttempt(entry: {
    readonly notificationId: string
    readonly attempt: number
    readonly status: NoticeStatus
    readonly reason: string | null
    readonly messageId: string | null
    readonly now: number
  }): void {
    this.requireDb().prepare(`INSERT INTO notification_attempts (id, notification_id, attempt, status,
      reason, message_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      newId('attm'), entry.notificationId, entry.attempt, entry.status, entry.reason, entry.messageId, entry.now,
    )
  }

  /** Attempt history for one notice. */
  listNoticeAttempts(notificationId: string): NoticeAttemptRecord[] {
    const rows = this.requireDb().prepare(
      'SELECT * FROM notification_attempts WHERE notification_id = ? ORDER BY attempt',
    ).all(notificationId) as Record<string, unknown>[]
    return rows.map(row => ({
      id: String(row['id']),
      notificationId: String(row['notification_id']),
      attempt: asNumber(row['attempt']),
      status: String(row['status']) as NoticeStatus,
      reason: asStringOrNull(row['reason']),
      messageId: asStringOrNull(row['message_id']),
      at: asNumber(row['at']),
    }))
  }

  /** Notices created since `since` (hourly ceiling and UI). */
  countNoticesSince(qunoId: QunoId, since: number): number {
    const row = this.requireDb().prepare(`SELECT COUNT(*) AS n FROM notification_outbox
      WHERE quno_id = ? AND created_at >= ? AND status NOT IN ('suppressed','superseded','expired')`).get(qunoId, since) as { n?: number } | undefined
    return asNumber(row?.n ?? 0)
  }

  /** Delivered/possibly-delivered notices since an instant (rate ceiling input). */
  countDeliveredNoticesSince(qunoId: QunoId, since: number): number {
    const row = this.requireDb().prepare(`SELECT COUNT(*) AS n FROM notification_outbox
      WHERE quno_id = ? AND created_at >= ?
        AND status IN ('inbox-durable','presented','uncertain','retryable-failure','prepared')`).get(qunoId, since) as { n?: number } | undefined
    return asNumber(row?.n ?? 0)
  }

  /** Most recent successfully delivered notice instant. */
  lastNoticeAt(qunoId: QunoId): number | null {
    const row = this.requireDb().prepare(`SELECT MAX(updated_at) AS at FROM notification_outbox
      WHERE quno_id = ? AND status IN ('inbox-durable','presented')`).get(qunoId) as { at?: number | null } | undefined
    return row?.at === null || row?.at === undefined ? null : asNumber(row.at)
  }

  /** Recent notices for the "why did you tell me" view. */
  listNotices(qunoId: QunoId, limit = 50): NoticeRecord[] {
    const rows = this.requireDb().prepare(
      `SELECT ${NOTICE_COLUMNS} FROM notification_outbox WHERE quno_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(qunoId, limit) as Record<string, unknown>[]
    return rows.map(mapNotice)
  }

  /** Supersede older pending notices of the same topic (quiet-hour merge). */
  mergePendingNotices(qunoId: QunoId, topicKey: string, keepId: string, now: number): number {
    const result = this.requireDb().prepare(`UPDATE notification_outbox SET status = 'superseded',
      reason = 'merged while holding notices', updated_at = ?
      WHERE quno_id = ? AND topic_key = ? AND id <> ? AND status = 'pending'`).run(now, qunoId, topicKey, keepId)
    return Number(result.changes)
  }

  /** Suppress every still-pending notice for one topic (user acted, item resolved). */
  suppressPendingNoticesForTopic(qunoId: QunoId, topicKey: string, reason: string, now: number): number {
    const result = this.requireDb().prepare(`UPDATE notification_outbox SET status = 'suppressed',
      reason = ?, updated_at = ? WHERE quno_id = ? AND topic_key = ? AND status = 'pending'`).run(
      reason, now, qunoId, topicKey,
    )
    return Number(result.changes)
  }

  /** Expire notices whose freshness window closed. */
  expireNotices(now: number): number {
    const result = this.requireDb().prepare(`UPDATE notification_outbox SET status = 'expired',
      updated_at = ? WHERE status IN ('pending','retryable-failure') AND expires_at IS NOT NULL AND expires_at < ?`).run(now, now)
    return Number(result.changes)
  }

  // -------------------------------------------------------------- feedback

  /** Record a user decision (button or natural language). */
  insertFeedback(entry: {
    readonly qunoId: QunoId
    readonly itemId: string | null
    readonly topicKey: string | null
    readonly action: string
    readonly note: string | null
    readonly revision: number | null
    readonly channel: 'button' | 'natural'
    readonly now: number
  }): void {
    this.requireDb().prepare(`INSERT INTO feedback (id, quno_id, item_id, topic_key, action, note, revision,
      channel, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newId('fb'), entry.qunoId, entry.itemId, entry.topicKey, entry.action, entry.note, entry.revision, entry.channel, entry.now,
    )
  }

  /** Whether the user gave feedback on a topic after `since` (freshness guard). */
  hasRecentFeedback(qunoId: QunoId, topicKey: string, since: number): boolean {
    const row = this.requireDb().prepare(`SELECT 1 AS hit FROM feedback
      WHERE quno_id = ? AND topic_key = ? AND at >= ? LIMIT 1`).get(qunoId, topicKey, since) as { hit?: number } | undefined
    return row !== undefined
  }

  /** Recent feedback rows (tuning inspection). */
  listFeedback(qunoId: QunoId, limit = 50): { action: string; itemId: string | null; at: number }[] {
    const rows = this.requireDb().prepare(
      'SELECT action, item_id, at FROM feedback WHERE quno_id = ? ORDER BY at DESC LIMIT ?',
    ).all(qunoId, limit) as Record<string, unknown>[]
    return rows.map(row => ({ action: String(row['action']), itemId: asStringOrNull(row['item_id']), at: asNumber(row['at']) }))
  }

  /** Write an arbitrary meta value (diagnostics, counters). */
  setMeta(key: string, value: string): void {
    this.requireDb().prepare(`INSERT INTO meta_rows (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
  }

  /** Read a meta value. */
  getMeta(key: string): string | undefined {
    const row = this.requireDb().prepare('SELECT value FROM meta_rows WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value
  }
}

function mapQuno(row: Record<string, unknown>): QunoRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    persona: String(row['persona']),
    instructions: String(row['instructions']),
    modelProvider: String(row['model_provider']),
    model: String(row['model']),
    reasoningEffort: asStringOrNull(row['reasoning_effort']),
    mainSessionId: asStringOrNull(row['main_session_id']),
    mainSessionState: String(row['main_session_state']) as QunoRecord['mainSessionState'],
    mutedUntil: asNumberOrNull(row['muted_until']),
    config: parseJson(row['config_json'], {} as QunoConfig),
    configRevision: asNumber(row['config_revision']),
    nextCheckAt: asNumberOrNull(row['next_check_at']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at']),
  }
}

function mapSenseInstance(row: Record<string, unknown>): SenseInstanceRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    type: String(row['type']),
    label: String(row['label']),
    config: parseJson(row['config_json'], {}),
    configRevision: asNumber(row['config_revision']),
    desiredState: String(row['desired_state']) as SenseDesiredState,
    lifecycle: String(row['lifecycle']) as SenseLifecycle,
    health: String(row['health']) as SenseHealthState,
    healthDetail: row['health_json'] === null ? null : parseJson(row['health_json'], null),
    generation: asNumber(row['generation']),
    checkpoint: row['checkpoint_json'] === null
      ? { value: null, revision: asNumber(row['checkpoint_revision']) }
      : parseJson(row['checkpoint_json'], { value: null, revision: 0 }),
    lastAttemptAt: asNumberOrNull(row['last_attempt_at']),
    lastSuccessAt: asNumberOrNull(row['last_success_at']),
    lastEventAt: asNumberOrNull(row['last_event_at']),
    nextRetryAt: asNumberOrNull(row['next_retry_at']),
    consecutiveFailures: asNumber(row['consecutive_failures']),
    errorCode: asStringOrNull(row['error_code']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at']),
  }
}

function mapSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    instanceId: String(row['instance_id']),
    type: String(row['type']),
    scope: asStringOrNull(row['scope']),
    createdAt: asNumber(row['created_at']),
  }
}

function mapEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: String(row['id']),
    sourceId: String(row['source_id']),
    eventKey: String(row['event_key']),
    subjectKey: asStringOrNull(row['subject_key']),
    subjectRevision: asStringOrNull(row['subject_revision']),
    type: String(row['type']),
    schema: String(row['schema']),
    operation: String(row['operation']) as EventRecord['operation'],
    occurredAt: asNumberOrNull(row['occurred_at']),
    observedAt: asNumber(row['observed_at']),
    receivedAt: asNumber(row['received_at']),
    ingestSeq: asNumber(row['ingest_seq']),
    summary: asStringOrNull(row['summary']),
    data: row['data_json'] === null ? null : parseJson(row['data_json'], null),
    priority: String(row['priority']) as SuggestedPriority,
    deadline: asNumberOrNull(row['deadline']),
    provenance: parseJson(row['provenance_json'], { kind: 'observed' }) as EventRecord['provenance'],
    correlationKeys: parseJson(row['correlation_keys_json'], [] as string[]),
    supersedesEventIds: parseJson(row['supersedes_json'], [] as string[]),
    parentEventIds: parseJson(row['parents_json'], [] as string[]),
    contentHash: String(row['content_hash']),
    senseConfigRevision: asNumber(row['sense_config_revision']),
    expiresAt: asNumberOrNull(row['expires_at']),
    prunedAt: asNumberOrNull(row['pruned_at']),
  }
}

function mapDelivery(row: Record<string, unknown>): DeliveryRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    eventId: String(row['event_id']),
    status: String(row['status']) as DeliveryStatus,
    priority: String(row['priority']) as EffectivePriority,
    eligibleAt: asNumber(row['eligible_at']),
    attempts: asNumber(row['attempts']),
    runId: asStringOrNull(row['run_id']),
    reason: asStringOrNull(row['reason']),
    claimedAt: asNumberOrNull(row['claimed_at']),
    settledAt: asNumberOrNull(row['settled_at']),
    createdAt: asNumber(row['created_at']),
  }
}

function mapAttention(row: Record<string, unknown>): AttentionItemRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    topicKey: String(row['topic_key']),
    title: String(row['title']),
    summary: String(row['summary']),
    status: String(row['status']) as AttentionStatus,
    revision: asNumber(row['revision']),
    materialRevision: asNumber(row['material_revision']),
    subjectRefs: parseJson(row['subject_refs_json'], [] as string[]),
    evidence: parseJson(row['evidence_json'], [] as AttentionItemRecord['evidence']),
    nextReviewAt: asNumberOrNull(row['next_review_at']),
    snoozedUntil: asNumberOrNull(row['snoozed_until']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at']),
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    kind: String(row['kind']) as RunRecord['kind'],
    trigger: String(row['trigger']),
    configRevision: asNumber(row['config_revision']),
    sessionId: asStringOrNull(row['session_id']),
    status: String(row['status']) as RunStatus,
    fence: asNumber(row['fence']),
    claimExpiresAt: asNumberOrNull(row['claim_expires_at']),
    inputEventIds: parseJson(row['input_event_ids_json'], [] as string[]),
    inputAttentionIds: parseJson(row['input_attention_ids_json'], [] as string[]),
    startedAt: asNumber(row['started_at']),
    finishedAt: asNumberOrNull(row['finished_at']),
    result: row['result_json'] === null ? null : parseJson(row['result_json'], null),
    error: row['error_json'] === null ? null : parseJson(row['error_json'], null),
    provider: asStringOrNull(row['provider']),
    model: asStringOrNull(row['model']),
    cost: row['cost_json'] === null ? null : parseJson(row['cost_json'], null),
  }
}

function mapTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    childSessionId: asStringOrNull(row['child_session_id']),
    parentSessionId: asStringOrNull(row['parent_session_id']),
    jobId: asStringOrNull(row['job_id']),
    title: String(row['title']),
    prompt: String(row['prompt']),
    plan: asStringOrNull(row['plan']),
    status: String(row['status']) as TaskStatus,
    resultDigest: asStringOrNull(row['result_digest']),
    result: asStringOrNull(row['result']),
    artifacts: parseJson(row['artifacts_json'], [] as TaskArtifact[]),
    error: row['error_json'] === null ? null : parseJson(row['error_json'], null),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at']),
    settledAt: asNumberOrNull(row['settled_at']),
  }
}

function mapNotice(row: Record<string, unknown>): NoticeRecord {
  return {
    id: String(row['id']),
    qunoId: String(row['quno_id']),
    topicKey: String(row['topic_key']),
    materialRevision: asNumber(row['material_revision']),
    reminderStage: asNumber(row['reminder_stage']),
    kind: String(row['kind']) as NoticeRecord['kind'],
    payload: parseJson(row['payload_json'], {} as NoticePayload),
    messageId: asStringOrNull(row['message_id']),
    messageVersion: asNumber(row['message_version']),
    status: String(row['status']) as NoticeStatus,
    reason: asStringOrNull(row['reason']),
    eligibleAt: asNumber(row['eligible_at']),
    expiresAt: asNumberOrNull(row['expires_at']),
    attempts: asNumber(row['attempts']),
    createdAt: asNumber(row['created_at']),
    updatedAt: asNumber(row['updated_at']),
  }
}

/** Export row mappers for focused store tests. */
export const __test = {
  mapQuno,
  mapEvent,
  mapDelivery,
  mapAttention,
  mapRun,
  mapTask,
  mapNotice,
  mapSenseInstance,
}
