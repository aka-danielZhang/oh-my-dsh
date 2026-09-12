import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LockBusyError } from '../src/errors.ts'
import { readJournal } from '../src/journal.ts'
import { OhMyMemoStore } from '../src/store.ts'
import { parseRecord, serializeRecord, serializeStoreConfig } from '../src/schema.ts'
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
  const createdHash = store.readRecord(created.id)!.hash

  await assert.rejects(
    () => store.update({ id: created.id, ifRevision: 99, ifHash: createdHash, content: 'v2', reason: 'stale' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CAS_REVISION')
      return true
    },
  )
  await assert.rejects(
    () => store.update({ id: created.id, ifRevision: 1, ifHash: 'sha256:' + '0'.repeat(64), content: 'v2', reason: 'stale' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CAS_HASH')
      return true
    },
  )
  const updated = await store.update({ id: created.id, ifRevision: 1, ifHash: createdHash, content: 'v2', confirm: true, reason: 'user correction' })
  assert.equal(updated.id, created.id, 'in-place revision keeps the id')
  assert.equal(updated.revision, 2)
  assert.equal(store.readRecord(created.id)?.record.confirmed, true)
  assert.ok(readJournal(root).some((entry) => entry.action === 'updated' && entry.revision === 2))
  store.close()
})

test('hash-less update: ifHash omitted anchors on the freshly re-read disk revision (index-first)', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const created = await store.create({ content: 'v1', kind: 'semantic', scope: 'user', key: 'preference.nohash' })
  // memory_get retired: the model only knows the frontmatter revision.
  const updated = await store.update({ id: created.id, ifRevision: 1, content: 'v2', confirm: true, reason: 'frontmatter revision only' })
  assert.equal(updated.revision, 2)
  assert.equal(updated.id, created.id)
  // A stale revision is still refused with no hash involved.
  await assert.rejects(
    () => store.update({ id: created.id, ifRevision: 1, content: 'v3', reason: 'stale' }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, 'OHMYMEMO_CAS_REVISION')
      return true
    },
  )
  // The supersede path shares the optional hash.
  const superseded = await store.supersede({ id: created.id, ifRevision: 2, content: 'v3 meaning change', reason: 'successor' })
  assert.notEqual(superseded.id, created.id)
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
  const result = await store.supersede({ id: created.id, ifRevision: 1, ifHash: store.readRecord(created.id)!.hash, content: '新事实。', reason: 'user correction' })
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
  const promoted = await store.promote({ id: candidate.id, ifRevision: 1, ifHash: store.readRecord(candidate.id)!.hash, confirm: true, reason: 'user confirmed' })
  assert.equal(promoted.id, candidate.id)
  assert.equal(promoted.revision, 2)
  assert.equal(promoted.path, `scopes/user/semantic/${candidate.id}.md`)
  assert.equal(existsSync(join(root, ...rel.split('/'))), false)
  assert.equal(store.readRecord(candidate.id)?.record.confirmed, true)
  assert.ok(readJournal(root).some((entry) => entry.action === 'promoted'))
  store.close()
})

test('createCandidate writes a retained inference outside active recall', async (t) => {
  const root = scratchRoot()
  const store = await openStore(root, { watch: false })
  const staleStore = await openStore(root, { watch: false })
  t.after(() => {
    staleStore.close()
    store.close()
  })
  const normal = await store.create({ content: 'cross-process fact', kind: 'semantic', scope: 'user', key: 'cross.normal' })
  await assert.rejects(
    () => staleStore.create({ content: 'duplicate fact', kind: 'semantic', scope: 'user', key: 'cross.normal' }),
    (error: unknown) => (error as { code?: string }).code === 'OHMYMEMO_SINGLE_KEY_CONFLICT',
  )
  await store.forget({ id: normal.id, reason: 'cross-process conflict test cleanup' })

  const request = {
    content: '用户偏好在项目中使用 pnpm。',
    kind: 'semantic' as const,
    scope: 'user' as const,
    key: 'dream.package-manager.pnpm',
    confirmed: false,
    pinned: false,
    confidence: 0.8,
    sources: [{ type: 'cross_session_inference' as const, session_id: 'session-source', event_seq: 12 }],
    reason: 'bounded dream extraction',
  }
  const created = await store.createCandidate(request)
  assert.equal(created.status, 'candidate')
  assert.equal(created.path, `inbox/candidates/${created.id}.md`)
  const record = store.readRecord(created.id)?.record
  assert.equal(record?.candidate_reason, 'bounded dream extraction')
  assert.equal(record?.candidate_expires_at, '2026-10-03T10:00:00.000Z')
  assert.equal(store.catalogStats().active, 0)
  assert.equal(store.catalogStats().candidate, 1)
  assert.ok(readJournal(root).some(entry => entry.action === 'candidate-created' && entry.id === created.id))
  await assert.rejects(
    () => staleStore.createCandidate(request),
    (error: unknown) => (error as { code?: string }).code === 'OHMYMEMO_SINGLE_KEY_CONFLICT',
  )
  await store.forget({ id: created.id, reason: 'cross-process tombstone test' })
  await assert.rejects(
    () => staleStore.createCandidate(request),
    (error: unknown) => (error as { code?: string }).code === 'OHMYMEMO_TOMBSTONE_BARRIER',
  )
})

test('config updates use hash CAS and external edits hot-reload', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const seen: Array<{ hash: string; external: boolean }> = []
  const dispose = store.subscribe((change) => {
    if (change.type === 'config-updated') seen.push({ hash: change.hash, external: change.external })
  })
  const initial = store.configSnapshot()
  assert.equal(initial.config.allow_inference_candidates, false)
  assert.equal(initial.config.dream_schedule_local_time, '02:00')
  const updated = await store.updateConfig({
    ifHash: initial.hash,
    patch: { allow_inference_candidates: true, dream_schedule_local_time: '04:15' },
  })
  assert.equal(updated.config.allow_inference_candidates, true)
  assert.equal(updated.config.dream_schedule_local_time, '04:15')
  await assert.rejects(
    () => store.updateConfig({ ifHash: initial.hash, patch: { dream_schedule_local_time: '05:00' } }),
    (error: unknown) => (error as { code?: string }).code === 'OHMYMEMO_CONFIG_CAS_MISMATCH',
  )
  assert.ok(seen.some(change => change.hash === updated.hash && !change.external))
  assert.ok(readJournal(root).some(entry => entry.action === 'config-updated'))

  writeFileSync(join(root, 'config.yaml'), serializeStoreConfig({
    ...updated.config,
    dream_schedule_local_time: '06:30',
  }))
  await waitFor(() => store.storeConfig.dream_schedule_local_time === '06:30' ? true : undefined, 4_000)
  assert.ok(seen.some(change => change.external))

  const validExternal = readFileSync(join(root, 'config.yaml'), 'utf8')
  const eventsBeforeUnknown = seen.length
  writeFileSync(join(root, 'config.yaml'), `${validExternal}future_policy: retain-me\n`)
  await waitFor(() => seen.length > eventsBeforeUnknown ? true : undefined, 4_000)
  const unknownSnapshot = store.configSnapshot()
  await assert.rejects(
    () => store.updateConfig({ ifHash: unknownSnapshot.hash, patch: { dream_schedule_local_time: '07:00' } }),
    (error: unknown) => (error as { code?: string }).code === 'OHMYMEMO_CONFIG_INVALID',
  )
  assert.match(readFileSync(join(root, 'config.yaml'), 'utf8'), /future_policy: retain-me/u)
  writeFileSync(join(root, 'config.yaml'), validExternal)
  await waitFor(() => store.configSnapshot().hash !== unknownSnapshot.hash ? true : undefined, 4_000)

  rmSync(join(root, 'config.yaml'))
  await waitFor(() => store.storeConfig.allow_inference_candidates ? undefined : true, 4_000)
  assert.deepEqual(store.configSnapshot(), { config: store.storeConfig, hash: '' })
  const restored = await store.updateConfig({ ifHash: '', patch: { dream_schedule_local_time: '07:45' } })
  assert.equal(restored.config.dream_schedule_local_time, '07:45')
  assert.equal(existsSync(join(root, 'config.yaml')), true)
  writeFileSync(join(root, 'config.yaml'), serializeStoreConfig({ ...restored.config, watch: false }))
  await waitFor(() => store.watchActive ? undefined : true, 4_000)
  dispose()
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

test('validUntil write path: bare dates expand to end-of-day; garbage is refused', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  const created = await store.create({
    content: '备考 2026 年 11 月的系统架构师考试。',
    kind: 'semantic',
    scope: 'user',
    key: 'plan.architect-exam',
    pinned: true,
    validUntil: '2026-11-15',
  })
  const record = store.readRecord(created.id)!.record
  assert.equal(record.valid_until, '2026-11-15T23:59:59.999Z')
  // The serialized file round-trips through the strict schema.
  const reparsed = parseRecord(readFileSync(join(root, ...created.path.split('/')), 'utf8'))
  assert.equal(reparsed.record?.valid_until, '2026-11-15T23:59:59.999Z')
  await assert.rejects(
    () => store.create({ content: '无效期限。', kind: 'semantic', scope: 'user', key: 'plan.bad', validUntil: 'next Monday' }),
    (error: unknown) => {
      assert.match((error as Error).message, /validUntil/)
      return true
    },
  )
  store.close()
})

test('lifecycle maintenance: expired candidates are deleted deterministically', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
    const stale = await store.createCandidate({
      content: '从未被证实的推断候选。',
      kind: 'semantic',
      scope: 'user',
      key: 'dream.stale-candidate',
      reason: 'unattended extraction',
      expiresAt: '2026-09-02T00:00:00.000Z',
    })
    const fresh = await store.createCandidate({
      content: '仍在保留期内的候选。',
      kind: 'semantic',
      scope: 'user',
      key: 'dream.fresh-candidate',
      reason: 'unattended extraction',
      expiresAt: '2026-12-01T00:00:00.000Z',
    })
    const report = await store.runLifecycleMaintenance()
    assert.deepEqual(report.candidatesExpired, [stale.id])
    assert.equal(store.readRecord(stale.id), undefined, 'expired candidate body is gone')
    assert.ok(store.readRecord(fresh.id) !== undefined, 'retention window keeps the fresh candidate')
    const actions = readJournal(root).map((entry) => entry.action)
    assert.ok(actions.includes('candidate-expired'))
  } finally {
    store.close()
  }
})

test('lifecycle maintenance: valid_until and silence archive as expired; confirmed/sensitive never expire', async () => {
  const root = scratchRoot()
  const clock = { date: new Date('2026-09-03T10:00:00.000Z') }
  const store = makeStore(root, { now: (): Date => clock.date })
  await store.open()
  try {
    const timed = await store.create({
      content: '在职项目约束：三个月内只维护 A 服务。',
      kind: 'semantic', scope: 'user', key: 'constraint.job-a', pinned: true,
      validUntil: '2026-09-10',
    })
    const silent = await store.create({
      content: '很久没有再被证实的偏好。',
      kind: 'semantic', scope: 'user', key: 'preference.silent', pinned: true,
    })
    const evidenced = await store.create({
      content: '最近被证据再证实的偏好。',
      kind: 'semantic', scope: 'user', key: 'preference.evidenced', pinned: true,
    })
    // Simulate a curator refresh on `evidenced`: last_evidenced_at moves far
    // into the future relative to the sweep clock (external hand edit).
    const evidencedRead = store.readRecord(evidenced.id)!
    writeFileSync(evidencedRead.absPath, serializeRecord({ ...evidencedRead.record, last_evidenced_at: '2027-06-01T00:00:00.000Z' }))
    const confirmed = await store.create({
      content: '用户确认过的持久偏好。',
      kind: 'semantic', scope: 'user', key: 'preference.confirmed', pinned: true, confirmed: true,
    })
    const sensitive = await store.create({
      content: '敏感但长期沉默的健康状况备注。',
      kind: 'semantic', scope: 'user', key: 'health.notes', pinned: false, privacy: 'sensitive',
    })

    clock.date = new Date('2028-09-03T10:00:00.000Z') // 2+ years: past 2×365d horizon; past valid_until
    const report = await store.runLifecycleMaintenance()
    assert.deepEqual([...report.memoriesExpired].sort(), [timed.id, silent.id].sort())

    const timedAfter = store.readRecord(timed.id)
    assert.equal(timedAfter?.record.status, 'expired', 'get by id still reads the archived body')
    assert.match(timedAfter?.record.updated_at ?? '', /^2028-09-03T10:00:00/)
    assert.match(store.catalog.get(timed.id)?.relPath ?? '', /^archive\//, 'expired records live under archive/')

    assert.ok(store.readRecord(silent.id)?.record.status === 'expired')
    assert.ok(store.readRecord(confirmed.id)?.record.status === 'active', 'confirmed never expires')
    assert.ok(store.readRecord(sensitive.id)?.record.status === 'active', 'sensitive never expires')
    // `evidenced` was refreshed mid-way — its silence clock restarts from
    // last_evidenced_at (2027-06-01 → 2028-09-03 < 2×365d), so it survives.
    assert.ok(store.readRecord(evidenced.id)?.record.status === 'active', 'recent evidence survives the sweep')

    const actions = readJournal(root).map((entry) => entry.action)
    assert.ok(actions.includes('memory-expired'))
    assert.equal(store.catalogStats().expired, 2)
  } finally {
    store.close()
  }
})

test('expired archive never blocks re-remembering the same key', async () => {
  const root = scratchRoot()
  const clock = { date: new Date('2026-09-03T10:00:00.000Z') }
  const store = makeStore(root, { now: (): Date => clock.date })
  await store.open()
  try {
    const first = await store.create({
      content: '备考 9 月的考试。',
      kind: 'semantic', scope: 'user', key: 'plan.september-exam', pinned: true,
      validUntil: '2026-09-03T10:00:00.001Z',
    })
    clock.date = new Date('2026-09-03T10:00:00.002Z')
    const report = await store.runLifecycleMaintenance()
    assert.deepEqual(report.memoriesExpired, [first.id])

    // The user mentions the next exam season: same key re-enters cleanly.
    const recreated = await store.create({
      content: '备考 2027 年 3 月的考试。',
      kind: 'semantic', scope: 'user', key: 'plan.september-exam', pinned: true,
    })
    assert.equal(recreated.status, 'active')
    await assert.rejects(
      () => store.createCandidate({
        content: '候选重复提案。',
        kind: 'semantic', scope: 'user', key: 'plan.september-exam',
        reason: 'unattended extraction',
      }),
      (error: unknown) => {
        // Blocked by the LIVE holder — the archive alone never blocks.
        assert.match((error as Error).message, /plan\.september-exam/)
        return true
      },
    )
  } finally {
    store.close()
  }
})

test('refreshEvidence stamps last_evidenced_at with revision++ and journal memory-refreshed', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
    const created = await store.create({
      content: '用户偏好深色主题。', kind: 'semantic', scope: 'user', key: 'preference.theme', pinned: true,
    })
    const refreshed = await store.refreshEvidence({
      id: created.id,
      evidencedAt: '2026-09-04T08:00:00.000Z',
      source: { type: 'cross_session_inference', session_id: 'sess-9', event_seq: 4, quote_hash: 'sha256:' + 'a'.repeat(64), quote_preview: '我还是喜欢深色主题', observed_at: '2026-09-04T08:00:00.000Z' },
      reason: 'curator refresh: evidence window restates the fact',
    })
    assert.equal(refreshed.revision, 2)
    const record = store.readRecord(created.id)!.record
    assert.equal(record.last_evidenced_at, '2026-09-04T08:00:00.000Z')
    assert.equal(record.sources.length, 2, 'provenance gains the re-attestation source')
    // Idempotent duplicate source: same locator is not appended twice.
    await store.refreshEvidence({
      id: created.id, evidencedAt: '2026-09-05T08:00:00.000Z',
      source: { type: 'cross_session_inference', session_id: 'sess-9', event_seq: 4, quote_hash: 'sha256:' + 'a'.repeat(64), quote_preview: '我还是喜欢深色主题', observed_at: '2026-09-04T08:00:00.000Z' },
      reason: 'curator refresh: evidence window restates the fact',
    })
    assert.equal(store.readRecord(created.id)!.record.sources.length, 2)
    assert.ok(readJournal(root).some((entry) => entry.action === 'memory-refreshed'))

    // Confirmed records are untouchable by the curator.
    const confirmed = await store.create({
      content: '用户确认的偏好。', kind: 'semantic', scope: 'user', key: 'preference.confirmed2', pinned: true, confirmed: true,
    })
    await assert.rejects(
      () => store.refreshEvidence({ id: confirmed.id, evidencedAt: '2026-09-04T08:00:00.000Z', source: { type: 'cross_session_inference', observed_at: '2026-09-04T08:00:00.000Z' }, reason: 'x' }),
      /confirmed/,
    )
  } finally {
    store.close()
  }
})

test('mergeMemories retires absorbed via supersede machinery; guards cross-kind and confirmed', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
    const survivor = await store.create({
      content: 'JS 包管理用 pnpm。', kind: 'semantic', scope: 'user', key: 'preference.pm.a', pinned: true,
    })
    const duplicate = await store.create({
      content: '前端项目统一用 pnpm。', kind: 'semantic', scope: 'user', key: 'preference.pm.b', pinned: true,
    })
    const otherKind = await store.create({
      content: '构建流程记录。', kind: 'procedural', scope: 'user', key: 'workflow.build', pinned: true,
    })
    const confirmed = await store.create({
      content: '已确认的重复表述。', kind: 'semantic', scope: 'user', key: 'preference.pm.c', pinned: true, confirmed: true,
    })

    await assert.rejects(
      () => store.mergeMemories({ survivorId: survivor.id, absorbedId: otherKind.id, reason: 'x' }),
      /same scope \+ kind/,
    )
    await assert.rejects(
      () => store.mergeMemories({ survivorId: survivor.id, absorbedId: confirmed.id, reason: 'x' }),
      /confirmed/,
    )
    await assert.rejects(
      () => store.mergeMemories({ survivorId: survivor.id, absorbedId: survivor.id, reason: 'x' }),
      /distinct/,
    )

    const merged = await store.mergeMemories({
      survivorId: survivor.id, absorbedId: duplicate.id, reason: 'curator merge: near-duplicate of the survivor',
    })
    assert.equal(merged.id, survivor.id)
    assert.equal(merged.revision, 2)
    const survivorRecord = store.readRecord(survivor.id)!.record
    assert.deepEqual(survivorRecord.supersedes, [duplicate.id], 'supersedes backlink on the survivor')
    const absorbedEntry = store.catalog.get(duplicate.id)
    assert.equal(absorbedEntry?.record.status, 'superseded')
    assert.match(absorbedEntry?.relPath ?? '', /^archive\//)
    const actions = readJournal(root).map((entry) => entry.action)
    assert.ok(actions.includes('memory-merged'))
    assert.ok(store.readRecord(confirmed.id) !== undefined, 'the confirmed record is untouched')
  } finally {
    store.close()
  }
})

// ---------------------------------------------------------------- stage 1:
// Dream-memory writes: fixed product metadata, writer-lock exact replay,
// tombstone priority, retired barriers, and the legacy-key upgrade window.

import { createHash } from 'node:crypto'
import { normalizeKey, normalizeText } from '../src/schema.ts'
import type { DreamMemoryWriteRequest } from '../src/store.ts'

function dreamRequest(overrides: Partial<DreamMemoryWriteRequest> = {}): DreamMemoryWriteRequest {
  return {
    content: '用户偏好使用 pnpm 作为包管理器。',
    kind: 'semantic',
    scopeHint: 'user',
    keyHint: 'preference.package-manager',
    importance: 0.6,
    tags: ['package-manager'],
    confidence: 0.82,
    source: { sessionId: 'sess-1', eventSeq: 7, messageId: 'msg-7', time: '2026-09-09T22:10:00.000Z' },
    quote: 'pnpm 作为包管理器',
    quoteHash: 'sha256:quote-7',
    ...overrides,
  }
}

/** The pre-tool (legacy-json) write key: normalized content text in the hash. */
function legacyDreamKey(request: DreamMemoryWriteRequest): string {
  const hint = normalizeKey(request.keyHint) ?? 'fact'
  const textHash = createHash('sha256')
    .update(`${request.source.sessionId}\0${request.source.eventSeq}\0${normalizeText(request.content)}`)
    .digest('hex')
  return `dream.${hint.slice(0, 48)}.${textHash.slice(0, 12)}`
}

test('createDreamMemory writes the fixed dream product metadata', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const result = await store.createDreamMemory(dreamRequest())
  assert.equal(result.outcome, 'created')
  assert.match(result.key, /^dream\.preference\.package-manager\.[0-9a-f]{12}$/)
  const record = store.readRecord(result.id)!.record
  assert.equal(record.status, 'active')
  assert.equal(record.privacy, 'normal')
  assert.equal(record.pinned, true)
  assert.equal(record.confirmed, false)
  assert.equal(record.confidence, 0.82)
  assert.equal(record.cardinality, 'single')
  assert.equal(record.key, result.key)
  assert.deepEqual(record.sources[0], {
    type: 'cross_session_inference',
    session_id: 'sess-1',
    event_seq: 7,
    message_id: 'msg-7',
    quote_hash: 'sha256:quote-7',
    quote_preview: 'pnpm 作为包管理器',
    observed_at: '2026-09-09T22:10:00.000Z',
  })
  } finally {
    store.close()
  }
})

test('createDreamMemory exact replay returns the same id with zero new writes', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const first = await store.createDreamMemory(dreamRequest())
  const journalBefore = readJournal(root).length
  const statsBefore = store.catalogStats().active
  const replay = await store.createDreamMemory(dreamRequest())
  assert.equal(replay.outcome, 'already-present')
  assert.equal(replay.id, first.id)
  assert.equal(replay.key, first.key)
  assert.equal(readJournal(root).length, journalBefore, 'replay is zero-journal')
  assert.equal(store.catalogStats().active, statsBefore, 'replay is zero-write')
  } finally {
    store.close()
  }
})

test('createDreamMemory replay is digest-sensitive: changed content or importance conflicts', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  await store.createDreamMemory(dreamRequest())
  await assert.rejects(
    () => store.createDreamMemory(dreamRequest({ content: '用户偏好使用 npm 作为包管理器。' })),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_DREAM_IDEMPOTENCY_CONFLICT')
      return true
    },
  )
  await assert.rejects(
    () => store.createDreamMemory(dreamRequest({ importance: 0.9 })),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_DREAM_IDEMPOTENCY_CONFLICT')
      return true
    },
  )
  } finally {
    store.close()
  }
})

test('createDreamMemory key follows the source fingerprint: other sources create separate records', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const first = await store.createDreamMemory(dreamRequest())
  const other = await store.createDreamMemory(dreamRequest({
    source: { sessionId: 'sess-2', eventSeq: 3, messageId: 'msg-3b', time: '2026-09-09T23:00:00.000Z' },
  }))
  assert.equal(other.outcome, 'created')
  assert.notEqual(other.key, first.key, 'a different source fingerprint derives a new durable key')
  } finally {
    store.close()
  }
})

test('createDreamMemory: episodic exact replay reuses the record despite multiple cardinality', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const first = await store.createDreamMemory(dreamRequest({ kind: 'episodic' }))
  assert.equal(first.outcome, 'created')
  const replay = await store.createDreamMemory(dreamRequest({ kind: 'episodic' }))
  assert.equal(replay.outcome, 'already-present')
  assert.equal(replay.id, first.id)
  } finally {
    store.close()
  }
})

test('createDreamMemory: tombstone outranks replay — forgotten evidence never resurrects', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const created = await store.createDreamMemory(dreamRequest())
  await store.forget({ id: created.id, reason: 'user asked' })
  await assert.rejects(
    () => store.createDreamMemory(dreamRequest()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_TOMBSTONE_BARRIER')
      return true
    },
  )
  } finally {
    store.close()
  }
})

test('createDreamMemory: superseded and expired records answer retired, never resurrect', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const created = await store.createDreamMemory(dreamRequest())
  const read = store.readRecord(created.id)!
  // Supersede WITH a new key: the successor takes the key away, leaving the
  // old key held only by the archived (superseded) record. (A same-key
  // supersede leaves the corrected successor on the key — old evidence
  // replaying onto it is a conflict, which the digest test already covers.)
  await store.supersede({
    id: created.id,
    ifRevision: read.record.revision,
    ifHash: read.hash,
    content: '用户偏好使用 bun 作为包管理器。',
    key: 'preference.package-manager-v2',
    reason: 'user corrected the fact',
  })
  await assert.rejects(
    () => store.createDreamMemory(dreamRequest()),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_DREAM_REPLAY_RETIRED')
      return true
    },
  )
  } finally {
    store.close()
  }
})

test('createDreamMemory recognizes the legacy v1 write key across the upgrade window', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  const request = dreamRequest()
  const legacyKey = legacyDreamKey(request)
  // A record the pre-tool protocol would have written via store.create().
  const legacy = await store.create({
    content: request.content,
    kind: request.kind,
    scope: 'user',
    key: legacyKey,
    cardinality: 'single',
    importance: request.importance,
    pinned: true,
    privacy: 'normal',
    confirmed: false,
    confidence: request.confidence,
    tags: request.tags,
    sources: [{
      type: 'cross_session_inference',
      session_id: request.source.sessionId,
      event_seq: request.source.eventSeq,
      message_id: request.source.messageId,
      quote_hash: request.quoteHash,
      quote_preview: request.quote,
      observed_at: request.source.time,
    }],
  })
  const replay = await store.createDreamMemory(request)
  assert.equal(replay.outcome, 'already-present', 'the v2 tool path replays onto the v1 record instead of duplicating it')
  assert.equal(replay.id, legacy.id)
  assert.equal(replay.key, legacyKey)
  } finally {
    store.close()
  }
})

test('createDreamMemory: workspace scope requires the resolved scope and enters the key', async () => {
  const root = scratchRoot()
  const store = await openStore(root)
  try {
  await assert.rejects(
    () => store.createDreamMemory(dreamRequest({ scopeHint: 'workspace' })),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'OHMYMEMO_INVALID_SCOPE')
      return true
    },
  )
  // Register a real workspace scope first: the dream write must target an
  // existing scope (the service resolves it from the evidence cwd).
  const project = mkdtempSync(join(tmpdir(), 'ohmymemo-dream-ws-'))
  const seeded = await store.create({
    content: '本仓库使用 pnpm 工作区。',
    kind: 'semantic',
    scope: 'workspace',
    cwd: project,
    key: 'workspace.package-manager',
  })
  const result = await store.createDreamMemory(dreamRequest({
    scopeHint: 'workspace',
    resolvedScope: seeded.scope,
    source: { sessionId: 'sess-1', eventSeq: 7, messageId: 'msg-7', time: '2026-09-09T22:10:00.000Z', cwd: project },
  }))
  assert.match(result.key, /^dream\.preference\.package-manager\./)
  assert.equal(store.readRecord(result.id)!.record.scope, seeded.scope)
  } finally {
    store.close()
  }
})
