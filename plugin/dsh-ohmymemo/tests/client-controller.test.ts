import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import { MemorySettingsController } from '../src/client/controller.ts'
import type { MemoryDocument, MemoryOverview, MemoryTreeSnapshot } from '../src/manager-contract.ts'

const overview: MemoryOverview = {
  configRevision: 'sha256:config',
  dream: {
    enabled: true,
    scheduleLocalTime: '02:00',
    modelProvider: 'p',
    model: 'm',
    effort: '',
    timeZone: 'Asia/Shanghai',
    status: 'idle',
    activeJobId: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    nextRunAt: 1_800_000_000_000,
    lastResult: null,
  },
  counts: { active: 1, candidate: 2, disputed: 0, superseded: 3, expired: 0, quarantined: 0, tombstones: 0, scopes: 1 },
  files: { count: 1, truncated: false },
  watch: { active: true, degradedReason: null },
}

const tree: MemoryTreeSnapshot = {
  generation: 'sha256:tree',
  files: [{ path: 'views/user-profile.md', name: 'user-profile.md', label: 'user-profile', kind: 'view', bytes: 10, mtimeMs: 1, hash: 'sha256:file' }],
  truncated: false,
}

const document: MemoryDocument = {
  path: 'views/user-profile.md',
  title: 'User profile',
  hash: 'sha256:file',
  mtimeMs: 1,
  redacted: false,
  markdown: '# User profile',
  meta: {},
}

const modelsCatalog = {
  defaultRoute: { provider: 'p', model: 'm' },
  options: [{ key: 'default', label: '跟随默认模型（p / m）' }],
  efforts: [{ key: 'default', label: '跟随默认' }],
  currentModelKey: 'default',
  currentEffortKey: 'default',
}

function remote(overrides: Partial<TypertRemoteNamespaceMap['ohMyMemoUi']> = {}): TypertRemoteNamespaceMap['ohMyMemoUi'] {
  return {
    overview: async () => ({ ok: true, value: overview }),
    tree: async () => ({ ok: true, value: tree }),
    read: async () => ({ ok: true, value: document }),
    models: async () => ({ ok: true, value: modelsCatalog }),
    updateDreamSettings: async () => ({ ok: true, value: { ...overview, configRevision: 'sha256:next' } }),
    runNow: async () => ({ ok: true, value: { started: true, jobId: 'job-dream-run' } }),
    cancelRun: async () => ({ ok: true, value: { cancelled: true } }),
    ...overrides,
  } as TypertRemoteNamespaceMap['ohMyMemoUi']
}

test('controller loads one coherent overview/tree snapshot and reads fenced files', async () => {
  let readRequest: { path: string; generation: string } | undefined
  let treeSnapshot = tree
  const controller = new MemorySettingsController(remote({
    tree: async () => ({ ok: true, value: treeSnapshot }),
    read: async request => {
      readRequest = request
      return { ok: true, value: document }
    },
  }))
  await controller.load()
  assert.equal(controller.store.getSnapshot().status, 'ready')
  assert.equal(controller.store.getSnapshot().overview?.configRevision, 'sha256:config')
  assert.equal(controller.store.getSnapshot().tree?.generation, 'sha256:tree')
  await controller.read('views/user-profile.md')
  assert.deepEqual(readRequest, { path: 'views/user-profile.md', generation: 'sha256:tree' })
  assert.equal(controller.store.getSnapshot().document?.markdown, '# User profile')
  treeSnapshot = {
    ...tree,
    generation: 'sha256:changed-tree',
    files: tree.files.map(file => ({ ...file, hash: 'sha256:changed-file' })),
  }
  await controller.load()
  assert.equal(controller.store.getSnapshot().document, null)
  assert.equal(controller.store.getSnapshot().documentPath, null)
  controller.dispose()
})

test('controller coalesces overlapping initial loads', async () => {
  const overviewGate = Promise.withResolvers<{ ok: true; value: MemoryOverview }>()
  const treeGate = Promise.withResolvers<{ ok: true; value: MemoryTreeSnapshot }>()
  let overviewCalls = 0
  let treeCalls = 0
  const controller = new MemorySettingsController(remote({
    overview: async () => {
      overviewCalls += 1
      return overviewGate.promise
    },
    tree: async () => {
      treeCalls += 1
      return treeGate.promise
    },
  }))

  const first = controller.load()
  const overlapping = controller.load()
  assert.equal(overviewCalls, 1)
  assert.equal(treeCalls, 1)
  overviewGate.resolve({ ok: true, value: overview })
  treeGate.resolve({ ok: true, value: tree })
  await Promise.all([first, overlapping])
  assert.equal(controller.store.getSnapshot().status, 'ready')
  controller.dispose()
})

test('controller forwards config CAS and reflects manual-run/cancel outcomes', async () => {
  let settingsRequest: unknown
  let runOverview = overview
  let overviewCalls = 0
  let pendingPoll: PromiseWithResolvers<{ ok: true; value: MemoryOverview }> | undefined
  const controller = new MemorySettingsController(remote({
    overview: async () => {
      overviewCalls += 1
      return pendingPoll === undefined ? { ok: true, value: runOverview } : pendingPoll.promise
    },
    updateDreamSettings: async request => {
      settingsRequest = request
      runOverview = { ...overview, configRevision: 'sha256:next', dream: { ...overview.dream, scheduleLocalTime: '03:15' } }
      return { ok: true, value: runOverview }
    },
  }))
  const unmount = controller.mount()
  await controller.load()
  runOverview = { ...overview, dream: { ...overview.dream, lastAttemptAt: 1_700_000_000_000 } }
  await controller.tick()
  assert.equal(controller.store.getSnapshot().overview?.dream.lastAttemptAt, 1_700_000_000_000)
  const stalePollOverview: MemoryOverview = { ...overview, dream: { ...overview.dream, status: 'running' } }
  controller.store.update((state) => { state.overview = stalePollOverview })
  pendingPoll = Promise.withResolvers()
  const tick = controller.tick()
  const overlappingTick = controller.tick()
  assert.equal(overviewCalls, 3)
  await controller.updateSettings({ scheduleLocalTime: '03:15' })
  pendingPoll.resolve({ ok: true, value: stalePollOverview })
  await Promise.all([tick, overlappingTick])
  pendingPoll = undefined
  assert.deepEqual(settingsRequest, { ifRevision: 'sha256:config', scheduleLocalTime: '03:15' })
  assert.equal(controller.store.getSnapshot().overview?.configRevision, 'sha256:next')
  await controller.runNow()
  assert.equal(controller.store.getSnapshot().notice, null)
  await controller.cancelRun()
  assert.equal(controller.store.getSnapshot().notice, 'cancelled')
  unmount()
  controller.dispose()
})

test('updateSettings refetches the models snapshot so effort/model pickers reflect the write', async () => {
  let modelsSnapshot = modelsCatalog
  let modelsCalls = 0
  const controller = new MemorySettingsController(remote({
    models: async () => {
      modelsCalls += 1
      return { ok: true, value: modelsSnapshot }
    },
    updateDreamSettings: async () => {
      // The host commits the write before responding, so a models() call
      // racing it could read stale state; the controller must call models()
      // AFTER updateDreamSettings resolves. Simulate the fresh snapshot.
      modelsSnapshot = { ...modelsCatalog, currentEffortKey: 'high' }
      return { ok: true, value: { ...overview, configRevision: 'sha256:next' } }
    },
  }))
  await controller.load()
  assert.equal(modelsCalls, 1)
  assert.equal(controller.store.getSnapshot().models?.currentEffortKey, 'default')
  await controller.updateSettings({ effort: 'high' })
  assert.equal(modelsCalls, 2)
  assert.equal(controller.store.getSnapshot().models?.currentEffortKey, 'high')
  assert.equal(controller.store.getSnapshot().overview?.configRevision, 'sha256:next')
  controller.dispose()
})
