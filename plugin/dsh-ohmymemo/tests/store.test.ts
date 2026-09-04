import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { LockBusyError } from '../src/errors.ts'
import { readJournal } from '../src/journal.ts'
import { OhMyMemoStore } from '../src/store.ts'
import { parseRecord, serializeRecord } from '../src/schema.ts'
import { baseRecord } from './helpers/records.ts'
import { delay, scratchRoot, waitFor } from './helpers/scratch.ts'

const FIXED_NOW = (): Date => new Date('2026-09-03T10:00:00.000Z')
const DANGLING = `mem_${'01J5G0'}${'Z0'.repeat(9)}Z9`
const FIXED_ID = (): number => 1_800_000_000_000

function makeStore(root: string, options: Partial<ConstructorParameters<typeof OhMyMemoStore>[0]> = {}): OhMyMemoStore {
  return new OhMyMemoStore({ root, lockTimeoutMs: 400, watchDebounceMs: 40, now: FIXED_NOW, idNow: FIXED_ID, ...options })
}

async function openStore(root: string, options: Partial<ConstructorParameters<typeof OhMyMemoStore>[0]> = {}): Promise<OhMyMemoStore> {
  const store = makeStore(root, options)
  await store.open()
  return store
}

test('open initializes manifest/config, scans clean, and doctor stays quiet', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  assert.ok(store.manifest !== undefined)
  assert.match(store.manifest.store_id, /^oms_/)
  assert.equal(store.manifest.format_version, 1)
  assert.equal(existsSync(join(root, 'manifest.yaml')), true)
  assert.equal(existsSync(join(root, 'config.yaml')), true)
  assert.equal(store.storeConfig.max_record_bytes, 16384)
  assert.deepEqual(store.doctor().filter((diagnostic) => diagnostic.severity === 'error'), [])
  store.close()
})

test('open fails loud on a newer store format version (no downgrade reads)', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  store.close()
  const manifestPath = join(root, 'manifest.yaml')
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('format_version: 1', 'format_version: 9'))
  await assert.rejects(() => openStore(root), (error: unknown) => {
    assert.match((error as Error).message, /format_version 9/)
    return true
  })
})

test('create writes canonical Markdown + journal, readRecord re-reads from disk', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const result = await store.create({
    content: '用户更喜欢使用中文交流。',
    kind: 'semantic',
    scope: 'user',
    key: 'Preference.Package Manager',
    pinned: true,
    confirmed: true,
    tags: ['Language', 'communication'],
    sources: [{ type: 'user_command', session_id: 'session-123', event_seq: 42, observed_at: '2026-09-03T10:00:00.000Z' }],
  })
  assert.equal(result.revision, 1)
  assert.equal(result.status, 'active')
  assert.equal(result.path, `scopes/user/semantic/${result.id}.md`)
  const text = readFileSync(join(root, ...result.path.split('/')), 'utf8')
  const parsed = parseRecord(text)
  assert.equal(parsed.record?.key, 'preference.package-manager', 'key is normalized')
  assert.deepEqual(parsed.record?.tags, ['language', 'communication'])
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'))

  const read = store.readRecord(result.id)
  assert.ok(read !== undefined)
  assert.equal(read.record.body, '用户更喜欢使用中文交流。')
  assert.equal(read.record.revision, 1)

  const journal = readJournal(root)
  assert.ok(journal.some((entry) => entry.action === 'created' && entry.id === result.id))
  assert.ok(journal.every((entry) => !JSON.stringify(entry).includes('中文')), 'journal never carries bodies')
  assert.equal(store.catalogStats().active, 1)
  store.close()
})

test('episodic records nest under YYYY/MM derived from created_at', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const result = await store.create({
    content: 'runtime 升级事故的摘要。',
    kind: 'episodic',
    scope: 'user',
    key: 'episode.runtime-upgrade',
  })
  assert.equal(result.path.startsWith('scopes/user/episodic/2026/09/'), true)
  store.close()
})

test('single-key creation refuses duplicates; multiple cardinality allows them', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const first = await store.create({ content: '用 pnpm。', kind: 'semantic', scope: 'user', key: 'preference.package-manager' })
  await assert.rejects(
    () => store.create({ content: '用 npm。', kind: 'semantic', scope: 'user', key: 'preference.package-manager' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_SINGLE_KEY_CONFLICT')
      return true
    },
  )
  const stack = await store.create({ content: 'Java。', kind: 'semantic', scope: 'user', key: 'profile.stack', cardinality: 'multiple' })
  await store.create({ content: 'TypeScript。', kind: 'semantic', scope: 'user', key: 'profile.stack', cardinality: 'multiple' })
  assert.notEqual(first.id, stack.id)
  store.close()
})

test('update enforces revision and hash CAS; success bumps revision in place', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const created = await store.create({ content: 'v1', kind: 'semantic', scope: 'user', key: 'preference.x' })

  await assert.rejects(
    () => store.update({ id: created.id, ifRevision: 99, content: 'v2', reason: 'stale' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CAS_REVISION')
      return true
    },
  )
  await assert.rejects(
    () => store.update({ id: created.id, ifRevision: 1, ifHash: 'sha256:not-the-hash', content: 'v2', reason: 'stale' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CAS_HASH')
      return true
    },
  )
  const updated = await store.update({ id: created.id, ifRevision: 1, content: 'v2', confirm: true, reason: 'user correction' })
  assert.equal(updated.id, created.id, 'in-place revision keeps the id')
  assert.equal(updated.revision, 2)
  assert.equal(store.readRecord(created.id)?.record.confirmed, true)
  assert.ok(readJournal(root).some((entry) => entry.action === 'updated' && entry.revision === 2))
  store.close()
})

test('external hand edits win: journaled as external-edit-detected and CAS blocks stale writers', async () => {
  const root = scratchRoot()
  const store = await openStore(root, { watch: true })
  const created = await store.create({ content: 'v1', kind: 'semantic', scope: 'user', key: 'preference.y' })
  const abs = join(root, ...created.path.split('/'))
  const staleHash = store.readRecord(created.id)!.hash

  // hand edit without touching revision
  const editedText = serializeRecord({ ...baseRecord({ id: created.id, key: 'preference.y', body: 'hand-edited body' }) })
  writeFileSync(abs, editedText)

  await waitFor(() => (store.catalog.get(created.id)?.hash !== staleHash ? true : undefined), 4_000)
  await waitFor(() => (readJournal(root).some((entry) => entry.action === 'external-edit-detected' && entry.id === created.id) ? true : undefined), 4_000)
  assert.equal(store.catalog.get(created.id)?.hash !== staleHash, true)

  // a tool write armed with the pre-edit hash loses (no silent overwrite)
  await assert.rejects(
    () => store.update({ id: created.id, ifRevision: 1, ifHash: staleHash, content: 'tool overwrite', reason: 'stale' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CAS_HASH')
      return true
    },
  )
  store.close()
})

test('supersede archives the old record and chains supersedes on the successor', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const created = await store.create({ content: '旧事实。', kind: 'semantic', scope: 'user', key: 'preference.z' })
  const result = await store.supersede({ id: created.id, ifRevision: 1, content: '新事实。', reason: 'user correction' })
  assert.notEqual(result.id, created.id)
  assert.equal((result as unknown as { supersededId: string }).supersededId, created.id)

  assert.equal(existsSync(join(root, ...created.path.split('/'))), false, 'old canonical file is gone')
  const archivePath = `archive/user/semantic/${created.id}.md`
  assert.equal(existsSync(join(root, ...archivePath.split('/'))), true)
  const archived = parseRecord(readFileSync(join(root, ...archivePath.split('/')), 'utf8'))
  assert.equal(archived.record?.status, 'superseded')
  const successor = store.readRecord(result.id)
  assert.deepEqual(successor?.record.supersedes, [created.id])
  assert.ok(readJournal(root).some((entry) => entry.action === 'superseded' && entry.id === result.id))
  store.close()
})

test('forget writes the tombstone first, deletes bodies, and blocks re-creation until an explicit override', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const created = await store.create({ content: '验证饮料是 lapsang souchong。', kind: 'semantic', scope: 'user', key: 'preference.validation-drink' })

  const forgotten = await store.forget({ id: created.id, reason: 'user-request' })
  assert.deepEqual(forgotten.forgottenIds, [created.id])
  const tombAbs = join(root, ...forgotten.tombstonePath.split('/'))
  assert.equal(existsSync(tombAbs), true)
  const tombText = readFileSync(tombAbs, 'utf8')
  assert.ok(!tombText.includes('lapsang'), 'tombstone carries no value')
  assert.equal(existsSync(join(root, ...created.path.split('/'))), false)
  assert.equal(store.readRecord(created.id), undefined)
  assert.ok(readJournal(root).some((entry) => entry.action === 'forgotten'))

  await assert.rejects(
    () => store.create({ content: '再次记住同一偏好。', kind: 'semantic', scope: 'user', key: 'preference.validation-drink' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_TOMBSTONE_BARRIER')
      return true
    },
  )
  const explicit = await store.create({
    content: '用户明确要求重新记住。',
    kind: 'semantic',
    scope: 'user',
    key: 'preference.validation-drink',
    overrideTombstone: true,
  })
  assert.equal(explicit.status, 'active')
  // doctor surfaces the re-import as informational, not an error
  const codes = store.doctor().map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('tombstone-key-reimport'))
  store.close()
})

test('forget by (scope, key) removes every matching record under one tombstone', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  await store.create({ content: 'a', kind: 'semantic', scope: 'user', key: 'profile.tags', cardinality: 'multiple' })
  await store.create({ content: 'b', kind: 'semantic', scope: 'user', key: 'profile.tags', cardinality: 'multiple' })
  const result = await store.forget({ scope: 'user', key: 'profile.tags' })
  assert.equal(result.forgottenIds.length, 2)
  assert.equal(store.catalogStats().active, 0)
  await assert.rejects(() => store.forget({ id: 'mem_missing' }), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'OHMYMEMO_RECORD_NOT_FOUND')
    return true
  })
  store.close()
})

test('workspace scope creation binds a cwd to a stable ws id and reuses it', async () => {
  const root = scratchRoot()
  const project = join(root, '..', 'project-dir')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(project, { recursive: true })
  const store = await openStore(root)
  const first = await store.create({ content: '本项目使用 pnpm。', kind: 'procedural', scope: 'workspace', cwd: project, key: 'workflow.package-manager' })
  assert.match(first.scope, /^workspace:ws_/)
  const second = await store.create({ content: '发布前先跑 typecheck。', kind: 'procedural', scope: 'workspace', cwd: project, key: 'workflow.release-checks' })
  assert.equal(second.scope, first.scope, 'same cwd reuses the workspace scope')
  assert.ok(existsSync(join(root, 'scopes', 'workspaces', first.scope.slice('workspace:'.length), 'scope.yaml')))
  store.close()
})

test('write gates: empty content, credential-like content, oversize content all refuse', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  await assert.rejects(() => store.create({ content: '   ', kind: 'semantic', scope: 'user', key: 'x.y' }), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'OHMYMEMO_EMPTY_CONTENT')
    return true
  })
  await assert.rejects(
    () => store.create({ content: '我的 key 是 AKIAIOSFODNN7EXAMPLE', kind: 'semantic', scope: 'user', key: 'secret.x' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_SECRET_REFUSED')
      return true
    },
  )
  await assert.rejects(
    () => store.create({ content: 'x'.repeat(20_000), kind: 'semantic', scope: 'user', key: 'big.x' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CONTENT_TOO_LARGE')
      return true
    },
  )
  store.close()
})

test('mutations before open refuse; state survives process restart via a fresh store', async () => {
  const root = scratchRoot()
  const cold = makeStore(root)
  await assert.rejects(() => cold.create({ content: 'x', kind: 'semantic', scope: 'user', key: 'a.b' }), (error: unknown) => {
    assert.equal((error as { code: string }).code, 'OHMYMEMO_NOT_OPEN')
    return true
  })

  const store = await openStore(root)
  const created = await store.create({ content: '跨进程存活的事实。', kind: 'semantic', scope: 'user', key: 'persist.x' })
  store.close()

  const reopened = await openStore(root)
  assert.equal(reopened.catalogStats().active, 1)
  assert.equal(reopened.readRecord(created.id)?.record.body, '跨进程存活的事实。')
  reopened.close()
})

test('candidate promotion keeps the id, moves inbox to canonical, bumps revision', async () => {
  const root = scratchRoot()
  const candidate = baseRecord({
    id: 'mem_01J5G0Z0Z0Z0Z0Z0Z0Z0Z0Z0Z0',
    status: 'candidate',
    key: 'preference.inferred-pm',
    confirmed: false,
    candidate_reason: '三个项目都主动选择 pnpm',
    candidate_expires_at: '2026-10-03T00:00:00.000Z',
  })
  const rel = `inbox/candidates/${candidate.id}.md`
  const { writeFileAtomic } = await import('../src/atomic.ts')
  writeFileAtomic(join(root, ...rel.split('/')), serializeRecord(candidate))

  const store = await openStore(root)
  assert.equal(store.catalogStats().candidate, 1)
  const promoted = await store.promote({ id: candidate.id, ifRevision: 1, confirm: true, reason: 'user confirmed' })
  assert.equal(promoted.id, candidate.id)
  assert.equal(promoted.revision, 2)
  assert.equal(promoted.path, `scopes/user/semantic/${candidate.id}.md`)
  assert.equal(existsSync(join(root, ...rel.split('/'))), false)
  assert.equal(store.readRecord(candidate.id)?.record.confirmed, true)
  assert.ok(readJournal(root).some((entry) => entry.action === 'promoted'))
  store.close()
})

test('a live writer in another process makes mutations BUSY, never last-writer-wins', async () => {
  const root = scratchRoot()
  const store = await openStore(root, { lockTimeoutMs: 1_200 })
  const lockDir = join(root, '.state', 'locks', 'writer.lock')
  const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'helpers', 'lock-holder.mts'), lockDir], {
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  let held = ''
  child.stdout.on('data', (chunk: Buffer) => {
    held += chunk.toString('utf8')
  })
  const startedAt = Date.now()
  while (!held.includes('held\n') && Date.now() - startedAt < 15_000) {
    await delay(50)
  }
  assert.ok(held.includes('held\n'))
  await assert.rejects(
    () => store.create({ content: '并发写入。', kind: 'semantic', scope: 'user', key: 'race.x' }),
    (error: unknown) => {
      assert.ok(error instanceof LockBusyError)
      return true
    },
  )
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => {
    child.on('exit', () => {
      resolve()
    })
  })
  // dead holder ⇒ next mutation steals the stale lock and succeeds
  const recovered = await store.create({ content: '锁恢复后写入。', kind: 'semantic', scope: 'user', key: 'race.x' })
  assert.equal(recovered.status, 'active')
  store.close()
})

test('doctor warns on loosened file permissions and reports dangling supersedes', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const created = await store.create({ content: 'x', kind: 'semantic', scope: 'user', key: 'perm.x' })
  chmodSync(join(root, ...created.path.split('/')), 0o644)
  const dangling = await store.create({ content: 'y', kind: 'semantic', scope: 'user', key: 'perm.y' })
  // forge a dangling reference by hand-editing the file's supersedes list
  const abs = join(root, ...dangling.path.split('/'))
  const record = store.readRecord(dangling.id)!.record
  writeFileSync(abs, serializeRecord({ ...record, supersedes: [DANGLING] }))
  await waitFor(() => (store.doctor().some((diagnostic) => diagnostic.code === 'dangling-supersedes') ? true : undefined), 4_000)
  const diagnostics = store.doctor()
  assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 'permissions-loose' && diagnostic.path === created.path))
  store.close()
})
