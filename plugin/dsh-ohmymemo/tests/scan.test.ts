import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { hashText, writeFileAtomic } from '../src/atomic.ts'
import { refreshSubtree, scanFile, scanStore, expectedPathFor } from '../src/scan.ts'
import { serializeRecord, serializeScopeFile, serializeTombstone } from '../src/schema.ts'
import { baseRecord } from './helpers/records.ts'
import { scratchRoot } from './helpers/scratch.ts'

const MEM_A = `mem_${'01J5G0'}${'Z0'.repeat(10)}`
const MEM_B = `mem_${'01J5G0'}${'Z0'.repeat(9)}Z1`
const MEM_C = `mem_${'01J5G0'}${'Z0'.repeat(9)}Z2`
const MEM_D = `mem_${'01J5G0'}${'Z0'.repeat(9)}Z3`
const MEM_E = `mem_${'01J5G0'}${'Z0'.repeat(9)}Z4`
const WS = `ws_${'01J5G0'}${'Z0'.repeat(10)}`

function absOf(root: string, rel: string): string {
  return join(root, ...rel.split('/'))
}

function seedValid(root: string): string {
  const record = baseRecord({ id: MEM_A })
  const rel = `scopes/user/semantic/${MEM_A}.md`
  writeFileAtomic(absOf(root, rel), serializeRecord(record))
  return rel
}

test('scanStore builds the catalog, scope registry and tombstones from a valid tree', () => {
  const root = scratchRoot()
  seedValid(root)
  const episodic = baseRecord({ id: MEM_B, kind: 'episodic', key: 'episode.upgrade', cardinality: 'multiple' })
  writeFileAtomic(absOf(root, `scopes/user/episodic/2026/09/${MEM_B}.md`), serializeRecord(episodic))
  writeFileAtomic(
    absOf(root, `scopes/workspaces/${WS}/scope.yaml`),
    serializeScopeFile({
      schema: 'ohmymemo-scope/v1',
      id: WS,
      dsh_workspace_id: null,
      canonical_path: '/tmp/project-a',
      created_at: '2026-09-03T00:00:00.000Z',
      updated_at: '2026-09-03T00:00:00.000Z',
    }),
  )
  writeFileAtomic(
    absOf(root, 'tombstones/tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0.yaml'),
    serializeTombstone({
      schema: 'ohmymemo-tombstone/v1',
      id: 'tomb_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
      scope: 'user',
      key: 'preference.old-thing',
      memory_ids: [MEM_B],
      forgotten_at: '2026-09-03T00:00:00.000Z',
      reason: 'user-request',
    }),
  )

  const result = scanStore(root, { maxRecordBytes: 16384 })
  assert.deepEqual([...result.catalog.entries().keys()].sort(), [MEM_A, MEM_B])
  assert.equal(result.catalog.scopes().get(WS)?.scope.canonical_path, '/tmp/project-a')
  assert.equal(result.catalog.tombstones().size, 1)
  assert.equal(result.catalog.tombstoneFor('user', 'preference.old-thing')?.memory_ids[0], MEM_B)
  assert.equal(result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length, 0)
  const stats = result.catalog.stats()
  assert.equal(stats.active, 2)
  // normalized body index present for recall
  assert.ok(result.catalog.get(MEM_A)!.normalizedBody.includes('中文'))
})

test('scanStore fail-closes broken records with precise diagnostics', () => {
  const root = scratchRoot()
  seedValid(root)
  // broken frontmatter
  writeFileAtomic(absOf(root, `scopes/user/semantic/${MEM_B}.md`), '---\nnot: [valid\n---\n\nbody\n')
  // path mismatch: an active record parked in the archive area
  const misplaced = baseRecord({ id: MEM_C })
  writeFileAtomic(absOf(root, `archive/user/semantic/${MEM_C}.md`), serializeRecord(misplaced))
  // oversize
  const huge = baseRecord({ id: MEM_E, body: 'x'.repeat(20_000) })
  writeFileAtomic(absOf(root, `scopes/user/semantic/${MEM_E}.md`), serializeRecord(huge))
  // future schema
  const future = baseRecord({ id: MEM_D })
  writeFileAtomic(
    absOf(root, `scopes/user/semantic/${MEM_D}.md`),
    serializeRecord(future).replace('ohmymemo/v1', 'ohmymemo/v9'),
  )

  const result = scanStore(root, { maxRecordBytes: 16384 })
  const codes = result.diagnostics.map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('record-invalid'))
  assert.ok(codes.includes('path-mismatch'))
  assert.ok(codes.includes('record-too-large'))
  assert.ok(codes.includes('record-schema-version'))
  assert.deepEqual(result.catalog.activeEntries().map((entry) => entry.record.id), [MEM_A], 'only the clean record is recallable')
  assert.equal(result.catalog.get(MEM_C)?.quarantine, 'path-mismatch', 'misplaced record stays catalogued for doctor but quarantined')
})

test('duplicate ids quarantine every copy; single-key conflicts quarantine actives', () => {
  const root = scratchRoot()
  // duplicate id: one id in two files (kinds differ so both parse as valid)
  writeFileAtomic(absOf(root, `scopes/user/semantic/${MEM_A}.md`), serializeRecord(baseRecord({ id: MEM_A })))
  writeFileAtomic(absOf(root, `scopes/user/procedural/${MEM_A}.md`), serializeRecord(baseRecord({ id: MEM_A, kind: 'procedural' })))
  // single-key conflict: two ids, same scope/kind/key, cardinality single
  writeFileAtomic(absOf(root, `scopes/user/episodic/2026/09/${MEM_B}.md`), serializeRecord(baseRecord({ id: MEM_B, kind: 'episodic', key: 'episode.same', cardinality: 'single' })))
  writeFileAtomic(absOf(root, `scopes/user/episodic/2026/09/${MEM_C}.md`), serializeRecord(baseRecord({ id: MEM_C, kind: 'episodic', key: 'episode.same', cardinality: 'single' })))
  // healthy record under a different scope/key
  writeFileAtomic(absOf(root, `scopes/workspaces/${WS}/semantic/${MEM_D}.md`), serializeRecord(baseRecord({ id: MEM_D, scope: `workspace:${WS}` })))
  const result = scanStore(root, { maxRecordBytes: 16384 })
  assert.equal(result.catalog.activeEntries().length, 1, 'only the untouched workspace record stays recallable')
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-id'))
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'single-key-conflict'))
  assert.equal(result.catalog.stats().quarantined, 4)
})

test('refreshSubtree picks up additions, edits and deletions incrementally', () => {
  const root = scratchRoot()
  const rel = seedValid(root)
  const result = scanStore(root, { maxRecordBytes: 16384 })
  const catalog = result.catalog

  // addition
  const addedRel = `scopes/user/procedural/${MEM_B}.md`
  writeFileAtomic(absOf(root, addedRel), serializeRecord(baseRecord({ id: MEM_B, kind: 'procedural', key: 'workflow.checks' })))
  let refresh = refreshSubtree(root, 'scopes/user/procedural', catalog, { maxRecordBytes: 16384 })
  assert.deepEqual(refresh.added, [MEM_B])
  assert.equal(catalog.get(MEM_B)?.relPath, addedRel)

  // edit
  const edited = baseRecord({ id: MEM_A, body: '用户更喜欢使用中文交流！（更新）' })
  const editedText = serializeRecord(edited)
  writeFileAtomic(absOf(root, rel), editedText)
  refresh = refreshSubtree(root, rel, catalog, { maxRecordBytes: 16384 })
  assert.deepEqual(refresh.updated, [MEM_A])
  assert.equal(catalog.get(MEM_A)?.hash, hashText(editedText))

  // deletion
  mkdirSync(absOf(root, 'archive'), { recursive: true })
  rmSync(absOf(root, rel))
  refresh = refreshSubtree(root, rel, catalog, { maxRecordBytes: 16384 })
  assert.deepEqual(refresh.removed, [MEM_A])
  assert.equal(catalog.get(MEM_A), undefined)
})

test('scanFile + expectedPathFor agree on where a record belongs', () => {
  assert.equal(expectedPathFor(baseRecord({ id: MEM_A })), `scopes/user/semantic/${MEM_A}.md`)
  assert.equal(expectedPathFor(baseRecord({ id: MEM_A, status: 'candidate', candidate_reason: 'r', candidate_expires_at: '2026-10-03T00:00:00.000Z' })), `inbox/candidates/${MEM_A}.md`)
  assert.equal(expectedPathFor(baseRecord({ id: MEM_A, status: 'superseded' })), `archive/user/semantic/${MEM_A}.md`)
})

test('scanFile reads a single file with hash facts', () => {
  const root = scratchRoot()
  const rel = seedValid(root)
  const scan = scanFile(root, rel, { maxRecordBytes: 16384 })
  assert.ok(scan.entry !== undefined)
  assert.equal(scan.entry.record.id, MEM_A)
  assert.equal(scan.entry.hash, hashText(readFileSync(absOf(root, rel), 'utf8')))
})
