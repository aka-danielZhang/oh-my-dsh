import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OhMyMemoManager, type Config } from '../src/manager.ts'
import { dreamRuntimeStateSchema, updateDreamSettingsRequestSchema } from '../src/manager-contract.ts'
import TYPERT_HOST from '../src/typert.host.ts'
import TYPERT_REMOTE from '../src/typert.remote-client.ts'

test('manager config owns bounded defaults and rejects invalid tunables', () => {
  const config = OhMyMemoManager.Config({} as Config)
  assert.equal(config.maxSessionsPerRun, 12)
  assert.equal(config.maxTranscriptBytes, 96_000)
  assert.equal(config.catchUpWindowHours, 36)
  assert.throws(() => OhMyMemoManager.Config({ maxSessionsPerRun: 0 } as Config))
  assert.throws(() => OhMyMemoManager.Config({ runTimeoutMs: 1000 } as Config))
  assert.equal(dreamRuntimeStateSchema.shape.activeTrigger.parse(undefined), null)
})

test('Typert contributions cover every Memory Remote operation', () => {
  const methods = ['cancelRun', 'models', 'overview', 'read', 'runNow', 'tree', 'updateDreamSettings']
  assert.deepEqual(TYPERT_REMOTE.descriptors.map(descriptor => descriptor.method).sort(), methods)
  assert.deepEqual(TYPERT_HOST.invocations.map(descriptor => descriptor.method).sort(), methods)
  assert.equal(TYPERT_HOST.face, 'host')
})

test('active dream-memory cancellation targets the mirrored Job', async () => {
  const kills: Array<{ jobId: string; reason: string | undefined }> = []
  type CancellationHarness = Pick<OhMyMemoManager, 'cancelRun'> & {
    accepting: boolean
    operationTail: Promise<void>
    currentRun?: { jobId: string }
    ctx: {
      jobs: {
        kill(jobId: string, owner: undefined, reason: string | undefined): void
      }
    }
  }
  const manager = Object.create(OhMyMemoManager.prototype) as CancellationHarness
  manager.accepting = true
  manager.operationTail = Promise.resolve()
  manager.currentRun = { jobId: 'job-active' }
  manager.ctx = {
    jobs: {
      kill(jobId, _owner, reason) {
        kills.push({ jobId, reason })
      },
    },
  }

  assert.deepEqual(await manager.cancelRun(), { cancelled: true })
  assert.deepEqual(kills, [{ jobId: 'job-active', reason: 'cancelled from Memory settings' }])
  manager.currentRun = undefined
  assert.deepEqual(await manager.cancelRun(), { cancelled: false })
})

test('manager teardown aborts and drains an active run before closing its domain', async () => {
  type Outcome = { status: 'completed' | 'failed' | 'killed'; detail?: string }
  type TeardownHarness = {
    accepting: boolean
    scheduledTimer?: () => void
    currentRun?: { jobId: string; runId: string; abort: AbortController; done: Promise<Outcome> }
    operationTail: Promise<void>
    closeDomain(): Promise<void>
    teardown(): Promise<void>
  }
  const done = Promise.withResolvers<Outcome>()
  const operations = Promise.withResolvers<void>()
  const abort = new AbortController()
  let timerCleared = 0
  let domainClosed = 0
  const manager = Object.create(OhMyMemoManager.prototype) as unknown as TeardownHarness
  manager.accepting = true
  manager.scheduledTimer = () => { timerCleared += 1 }
  manager.currentRun = { jobId: 'job-active', runId: 'dream-active', abort, done: done.promise }
  manager.operationTail = operations.promise
  manager.closeDomain = async () => { domainClosed += 1 }

  const teardown = manager.teardown()
  assert.equal(manager.accepting, false)
  assert.equal(abort.signal.aborted, true)
  assert.equal(timerCleared, 1)
  assert.equal(domainClosed, 0)
  done.resolve({ status: 'killed' })
  await Promise.resolve()
  assert.equal(domainClosed, 0)
  operations.resolve()
  await teardown
  assert.equal(domainClosed, 1)
})

test('claim persistence failure settles the Job, releases the lease, and permits retry', async () => {
  type Outcome = { status: 'completed' | 'failed' | 'killed'; detail?: string }
  type Hooks = { done: Promise<Outcome>; cancel(reason?: string): void }
  type StartHarness = {
    accepting: boolean
    currentRun?: { jobId: string; runId: string; abort: AbortController; done: Promise<Outcome> }
    operationTail: Promise<void>
    ctx: {
      jobs: { start(input: { run(): Hooks }): string }
      agents: { withoutInitiator<T>(run: () => Promise<T>): Promise<T> }
      logger: { warn(): void }
    }
    memo: {
      withMaintenanceLease<T>(run: () => Promise<T>): Promise<T>
      configSnapshot(): { config: { allow_inference_candidates: boolean } }
    }
    refreshDomain(): Promise<void>
    recoverInterruptedRun(): Promise<void>
    replaceState(): Promise<void>
    executeRun(): Promise<unknown>
    finishRun(): Promise<Outcome>
    startRun(input: { trigger: 'manual'; scheduledFor: null }): Promise<string>
  }
  const manager = Object.create(OhMyMemoManager.prototype) as unknown as StartHarness
  let hooks: Hooks | undefined
  let releases = 0
  let failClaim = true
  manager.accepting = true
  manager.operationTail = Promise.resolve()
  manager.ctx = {
    jobs: {
      start(input) {
        hooks = input.run()
        return 'job-test'
      },
    },
    agents: { withoutInitiator: run => run() },
    logger: { warn() {} },
  }
  Object.defineProperty(manager, 'memo', { value: {
    async withMaintenanceLease<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run()
      } finally {
        releases += 1
      }
    },
    configSnapshot: () => ({ config: { allow_inference_candidates: true } }),
  } })
  manager.refreshDomain = async () => {}
  manager.recoverInterruptedRun = async () => {}
  manager.replaceState = async () => {
    if (failClaim) throw new Error('state medium unavailable')
  }
  manager.executeRun = async () => ({})
  manager.finishRun = async () => ({ status: 'completed' })

  await assert.rejects(() => manager.startRun({ trigger: 'manual', scheduledFor: null }), /state medium unavailable/)
  assert.equal((await hooks?.done)?.status, 'failed')
  assert.equal(manager.currentRun, undefined)
  assert.equal(releases, 1)

  failClaim = false
  const jobId = await manager.startRun({ trigger: 'manual', scheduledFor: null })
  assert.equal(jobId, 'job-test')
  assert.equal((await hooks?.done)?.status, 'completed')
  assert.equal(manager.currentRun, undefined)
  assert.equal(releases, 2)
})

test('finishRun honouring a late cancellation never advances cursors or the boundary', async () => {
  type FinishHarness = {
    state: { cursors: Record<string, number>; lastScheduledFor: number | null; [key: string]: unknown }
    config: { auditRetentionRuns: number }
    finishRun(request: unknown, result: unknown, signal: AbortSignal): Promise<{ status: string; detail: string }>
    persistAudit(audit: { status: string }): Promise<void>
    commitState(next: Record<string, unknown>): Promise<void>
  }
  const manager = Object.create(OhMyMemoManager.prototype) as unknown as FinishHarness
  manager.state = { cursors: { 's-prior': 11 }, lastScheduledFor: 1_000 }
  manager.config = { auditRetentionRuns: 10 }
  const committed: Array<Record<string, unknown>> = []
  const audits: Array<{ status: string }> = []
  manager.persistAudit = async audit => { audits.push({ status: audit.status }) }
  manager.commitState = async next => { committed.push(next) }

  const request = { runId: 'dream-late', trigger: 'scheduled', scheduledFor: 2_000, startedAt: 1_500 }
  const result = {
    progress: {
      provider: null,
      model: null,
      agentSessionId: null,
      promptHash: null,
      sourceSessions: [{ sessionId: 's-new', capturedThroughSeq: 5, messageCount: 2 }],
      memoriesCreated: ['mem_new1'],
      memoriesRejected: 0,
      cursors: { 's-new': 5 },
    },
    sourceMessages: 2,
  }
  const controller = new AbortController()
  controller.abort(new Error('cancel raced the commit'))

  const outcome = await manager.finishRun(request, result, controller.signal)
  assert.equal(outcome.status, 'killed')
  assert.match(outcome.detail, /cancelled before commit/)
  assert.equal(audits[0]?.status, 'cancelled')
  const next = committed[0] as { status: string; cursors: Record<string, number>; lastScheduledFor: number | null; lastSuccessAt?: number }
  assert.equal(next.status, 'cancelled')
  assert.deepEqual(next.cursors, { 's-prior': 11 }, 'the cancelled run must not advance any cursor')
  assert.equal(next.lastScheduledFor, 1_000, 'the missed boundary stays due for catch-up')
  assert.equal(next.lastSuccessAt, undefined)
})

test('legacy persisted run state without items migrates to an empty list', () => {
  const legacy = {
    version: 1,
    status: 'error',
    activeRunId: null,
    activeJobId: null,
    activeTrigger: null,
    lastAttemptAt: 1,
    lastSuccessAt: null,
    lastScheduledFor: null,
    nextRunAt: null,
    lastResult: {
      runId: 'dream-old',
      trigger: 'scheduled',
      startedAt: 1,
      finishedAt: 2,
      status: 'error',
      sourceSessions: 0,
      sourceMessages: 0,
      memoriesCreated: 0,
      memoriesRejected: 1,
      detail: 'written before items existed',
    },
    cursors: {},
  }
  const parsed = dreamRuntimeStateSchema.parse(legacy)
  assert.deepEqual(parsed.lastResult?.items, [], 'old record boots with an empty item list')
})

test('maintenance agent is created with a validated cwd so prompt assembly resolves', async () => {
  type CreateHarness = {
    accepting: boolean
    currentRun?: { jobId: string; runId: string; abort: AbortController; done: Promise<{ status: string }> }
    operationTail: Promise<void>
    config: Record<string, unknown>
    ctx: {
      jobs: { start(input: { run(): { done: Promise<unknown> } }): string }
      agents: {
        withoutInitiator<T>(run: () => T): T
        create(options: Record<string, unknown>): Promise<unknown>
      }
      sessionQuery: Record<string, unknown>
      agentDefaultModel: Record<string, unknown>
      llm: Record<string, unknown>
      logger: { warn(): void }
    }
    memo: Record<string, unknown>
    refreshDomain(): Promise<void>
    recoverInterruptedRun(): Promise<void>
    replaceState(patch: unknown): Promise<void>
    failRun(request: unknown, error: unknown, signal: AbortSignal): Promise<unknown>
    maintenanceCwd(source: unknown): string
    collectSources(signal: AbortSignal): Promise<unknown>
    startRun(input: { trigger: 'manual'; scheduledFor: null }): Promise<string>
  }
  const manager = Object.create(OhMyMemoManager.prototype) as unknown as CreateHarness
  manager.accepting = true
  manager.operationTail = Promise.resolve()
  manager.config = {
    runTimeoutMs: 60_000,
    agentMaxTokens: 2048,
    maxMemoriesPerRun: 6,
    maxCandidateContentChars: 500,
    candidateConfidence: 0.6,
    maxTranscriptBytes: 12_000,
    lookbackHours: 72,
  }
  let captured: Record<string, unknown> | undefined
  let hooks: { done: Promise<unknown> } | undefined
  manager.ctx = {
    jobs: {
      start(input: { run(): { done: Promise<unknown> } }) {
        hooks = input.run()
        return 'job-cwd'
      },
    },
    agents: {
      withoutInitiator: <T,>(run: () => T): T => run(),
      async create(options: Record<string, unknown>) {
        captured = options
        throw new Error('stop-after-create')
      },
    },
    sessionQuery: {},
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    llm: { listProviders: () => [], resolveModelInfo: async () => { throw new Error('none') } },
    logger: { warn() {} },
  }
  Object.defineProperty(manager, 'memo', { value: {
    configSnapshot: () => ({ config: { allow_inference_candidates: true, dream_model_provider: '', dream_model: '', dream_effort: '' } }),
    withMaintenanceLease: async (run: () => Promise<unknown>) => run(),
    hasMemoryKey: () => false,
    scopeForCwd: () => undefined,
  } })
  manager.refreshDomain = async () => {}
  manager.recoverInterruptedRun = async () => {}
  manager.replaceState = async () => {}
  manager.failRun = async () => ({ status: 'failed' })
  manager.maintenanceCwd = () => '/tmp/fix-verify-ws'
  manager.collectSources = async () => ({
    sessions: [{
      sessionId: 'sess-x',
      capturedThroughSeq: 3,
      lastEventAt: Date.now(),
      messages: [{ sessionId: 'sess-x', seq: 3, messageId: 'mx', cwd: '/tmp/fix-verify-ws', time: Date.now(), text: '用户说喜欢深色主题' }],
    }],
    emptyCursors: {},
  })

  await manager.startRun({ trigger: 'manual', scheduledFor: null })
  if (hooks !== undefined) await hooks.done.catch(() => undefined)
  // create runs behind the claim resolution — poll briefly for it.
  for (let waited = 0; captured === undefined && waited < 2_000; waited += 25) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  const meta = (captured?.meta ?? {}) as { cwd?: string }
  assert.equal(meta.cwd, '/tmp/fix-verify-ws', 'agents.create must carry meta.cwd so {{cwd}} resolves')
})

test('dream setting wire input is strict and requires at least one change', () => {
  assert.deepEqual(updateDreamSettingsRequestSchema.parse({ ifRevision: 'sha256:x', enabled: true }), {
    ifRevision: 'sha256:x',
    enabled: true,
  })
  assert.deepEqual(updateDreamSettingsRequestSchema.parse({ ifRevision: 'sha256:x', modelProvider: 'zai', model: 'glm-5.3-flash', effort: 'high' }), {
    ifRevision: 'sha256:x',
    modelProvider: 'zai',
    model: 'glm-5.3-flash',
    effort: 'high',
  })
  assert.throws(() => updateDreamSettingsRequestSchema.parse({ ifRevision: 'sha256:x' }))
  assert.throws(() => updateDreamSettingsRequestSchema.parse({ ifRevision: 'sha256:x', scheduleLocalTime: '27:00' }))
  // `''` clears the override — valid by design (the old min(1) made
  // "follow default" unpickable once any override was set).
  assert.deepEqual(updateDreamSettingsRequestSchema.parse({ ifRevision: 'sha256:x', effort: '' }), {
    ifRevision: 'sha256:x',
    effort: '',
  })
  assert.throws(() => updateDreamSettingsRequestSchema.parse({ ifRevision: 'sha256:x', enabled: true, extra: 1 }))
})
