/**
 * Schema v3 → v4 (the Collector rename) against a faithful v3 database.
 *
 * The v3 fixture is built by DOWNGRADING a database the real code paths wrote:
 * v4 is v3 plus pure renames (four tables, one events column, one index), so
 * reversing exactly those renames yields the v3 shape column for column —
 * more faithful than a hand-copied DDL. The migration must then rename
 * everything back, keep every row byte-for-byte, and be idempotent.
 *
 * @module dsh-quno/tests/store-migration
 */

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { DEFAULT_QUNO_CONFIG } from '../src/contracts.ts'
import { QunoIngress } from '../src/ingress.ts'
import { QunoStore, SCHEMA_VERSION } from '../src/store.ts'

const NOW = Date.parse('2026-11-09T09:00:00.000Z')
const LEGACY_ID = 'sense-1793000000000-abc123'

const RENAMES: readonly (readonly [legacy: string, current: string])[] = [
  ['sense_types', 'collector_types'],
  ['sense_instances', 'collector_instances'],
  ['sense_batches', 'collector_batches'],
  ['sense_checkpoint_entries', 'collector_checkpoint_entries'],
]

/** Names of the tables and indexes in one database. */
function schemaNames(path: string): { readonly tables: Set<string>; readonly indexes: Set<string>; readonly version: number } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all() as { type: string; name: string }[]
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
    return {
      tables: new Set(rows.filter(row => row.type === 'table').map(row => row.name)),
      indexes: new Set(rows.filter(row => row.type === 'index').map(row => row.name)),
      version,
    }
  } finally {
    db.close()
  }
}

/** Write real data through the real code paths, then reverse the v4 renames. */
function seedLegacyV3(root: string): { readonly sourceId: string; readonly batchKey: string; readonly eventId: string } {
  const store = new QunoStore({ root, lock: false })
  store.open(NOW)
  store.ensureQuno({ id: 'quno', name: 'Quno', persona: 'p', instructions: 'i', config: DEFAULT_QUNO_CONFIG, now: NOW })
  store.upsertCollectorType({ type: 'quno/yzj-im', contractVersion: 1, implementationVersion: '0.3.0', definition: { type: 'quno/yzj-im' }, registeredAt: NOW })
  const instance = store.insertCollectorInstance({
    id: LEGACY_ID,
    qunoId: 'quno',
    type: 'quno/yzj-im',
    label: '云之家（存量）',
    config: { yzjProfile: 'default' },
    desiredState: 'enabled',
    now: NOW,
  })
  const source = store.ensureSource(instance, null, NOW)
  const ingress = new QunoIngress(store, 'quno')
  const ack = ingress.ingest({ instance, source, generation: instance.generation, configRevision: instance.configRevision }, {
    batchKey: 'legacy-batch-1',
    events: [{ eventKey: 'yzj:g1:m1', type: 'im.message.created', observedAt: new Date(NOW).toISOString(), summary: '存量事件' }],
    checkpointAfter: { value: 'cursor-legacy', revision: 0 },
  }, NOW)
  store.transaction(() => {
    store.applyCheckpointPatch(LEGACY_ID, { upserts: [{ key: 'c:g1', value: '{"cursor":"m1"}' }] }, NOW, QunoStore.CHECKPOINT_ENTRIES_CAPACITY)
  })
  store.close()

  const db = new DatabaseSync(join(root, 'quno.sqlite'))
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const [legacy, current] of RENAMES) db.exec(`ALTER TABLE ${current} RENAME TO ${legacy}`)
    db.exec('ALTER TABLE events RENAME COLUMN collector_config_revision TO sense_config_revision')
    db.exec('DROP INDEX collector_instances_quno')
    db.exec('CREATE INDEX sense_instances_quno ON sense_instances(quno_id, type)')
    db.exec('PRAGMA user_version = 3')
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return { sourceId: source.id, batchKey: 'legacy-batch-1', eventId: ack.accepted[0]!.eventId }
}

test('v3 → v4 renames tables, column and index, keeps every row, and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'quno-migrate-v4-'))
  const dbPath = join(root, 'quno.sqlite')
  const seeded = seedLegacyV3(root)

  const legacy = schemaNames(dbPath)
  assert.equal(legacy.version, 3, 'the fixture is a v3 database')
  for (const [name] of RENAMES) assert.ok(legacy.tables.has(name), `fixture has ${name}`)
  assert.ok(legacy.indexes.has('sense_instances_quno'))
  const before = new DatabaseSync(dbPath, { readOnly: true })
  const instanceBefore = before.prepare('SELECT * FROM sense_instances WHERE id = ?').get(LEGACY_ID)
  const eventBefore = before.prepare('SELECT * FROM events WHERE id = ?').get(seeded.eventId) as Record<string, unknown>
  const countsBefore = RENAMES.map(([legacyName]) => (before.prepare(`SELECT COUNT(*) AS n FROM ${legacyName}`).get() as { n: number }).n)
  before.close()

  const store = new QunoStore({ root, lock: false })
  store.open(NOW + 1)
  try {
    const migrated = schemaNames(dbPath)
    assert.equal(migrated.version, SCHEMA_VERSION)
    assert.equal(SCHEMA_VERSION, 4)
    for (const [legacyName, current] of RENAMES) {
      assert.ok(!migrated.tables.has(legacyName), `${legacyName} is gone`)
      assert.ok(migrated.tables.has(current), `${current} exists`)
    }
    assert.ok(migrated.indexes.has('collector_instances_quno'), 'the legacy index takes the fresh-database name')
    assert.ok(!migrated.indexes.has('sense_instances_quno'))

    const handle = store.handle()
    const columns = (handle.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map(row => row.name)
    assert.ok(columns.includes('collector_config_revision') && !columns.includes('sense_config_revision'))
    const countsAfter = RENAMES.map(([, current]) => (handle.prepare(`SELECT COUNT(*) AS n FROM ${current}`).get() as { n: number }).n)
    assert.deepEqual(countsAfter, countsBefore, 'no row is lost or added')
    assert.deepEqual(handle.prepare('SELECT * FROM collector_instances WHERE id = ?').get(LEGACY_ID), instanceBefore, 'the instance row is untouched')
    const eventAfter = handle.prepare('SELECT * FROM events WHERE id = ?').get(seeded.eventId) as Record<string, unknown>
    assert.equal(eventAfter['collector_config_revision'], eventBefore['sense_config_revision'])

    // The typed API reads the migrated rows: legacy id, checkpoint, receipt, entries.
    const instance = store.getCollectorInstance(LEGACY_ID)
    assert.equal(instance.id, LEGACY_ID, 'a sense-* id is never rewritten')
    assert.deepEqual(instance.checkpoint, { value: 'cursor-legacy', revision: 1 })
    assert.equal(store.findBatch(seeded.sourceId, seeded.batchKey)?.acceptedCount, 1)
    assert.equal(store.countCheckpointEntries(LEGACY_ID), 1)
    assert.equal(store.getEvent(seeded.eventId)?.collectorConfigRevision, instance.configRevision)
  } finally {
    store.close()
  }

  // Idempotent: a second open neither re-migrates nor fails.
  const again = new QunoStore({ root, lock: false })
  again.open(NOW + 2)
  try {
    assert.equal(schemaNames(dbPath).version, 4)
    assert.equal(again.getCollectorInstance(LEGACY_ID).id, LEGACY_ID)
  } finally {
    again.close()
  }
})

test('a fresh database is born at v4 with the collector names', () => {
  const root = mkdtempSync(join(tmpdir(), 'quno-fresh-v4-'))
  const store = new QunoStore({ root, lock: false })
  store.open(NOW)
  store.close()
  const fresh = schemaNames(join(root, 'quno.sqlite'))
  assert.equal(fresh.version, 4)
  for (const [legacyName, current] of RENAMES) {
    assert.ok(fresh.tables.has(current))
    assert.ok(!fresh.tables.has(legacyName))
  }
  assert.ok(fresh.indexes.has('collector_instances_quno'))
})
