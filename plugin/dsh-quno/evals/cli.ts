/**
 * The Eval CLI (design §4): one command per workflow — scripted/replay/live,
 * one case, one suite, repeat, and the evidence bundle under
 * `plugin/dsh-quno/eval-results/<runId>/`.
 *
 * @module dsh-quno/evals/cli
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { allCases, isRunnable } from './case.ts'
import type { BlockedCase, EvalCase, ModelMode } from './case.ts'
import { allLiveCases, isLiveCase } from './live.ts'
import type { LiveEvalCase } from './live.ts'
import { classifyLiveFailure } from './classify.ts'
import { renderProtocolChecks, runProtocolChecks } from './protocol.ts'
import { ModelGateway } from './models/gateway.ts'
import type { ModelRequestRecord } from './models/gateway.ts'
import { createProductionAdapter } from './models/production.ts'
import { resolveModelPlan, requireLiveCredential, resolveRoute } from './plan.ts'
import type { ModelPlan } from './plan.ts'
import { aggregateUsage } from './usage.ts'
import { virtualClock, EvalRuntime, writeEvidence } from './runtime.ts'
import { JsonlSessionPersistence } from './persistence.ts'
import { ScenarioDriver } from './driver.ts'
import { EvalCollector } from './fixtures/collector.ts'
import { TraceRecorder } from './trace.ts'
import { caseReport, writeReports } from './report.ts'
import type { CaseReport, RunReport } from './report.ts'
import { looksSensitive, redactJson } from './redact.ts'
import { resolveNodeContext } from './runtime.ts'
import type { CaseChecks } from './case.ts'

const RESULTS_DIR = resolve(import.meta.dirname, '..', 'eval-results')

interface CliArgs {
  readonly caseId?: string
  readonly suite?: 'p0' | 'p1' | 'live-p0' | 'all'
  readonly model?: ModelMode
  readonly repeat: number
  readonly run?: string
  readonly runDir?: string
  readonly keep: 'all' | 'failures' | 'none'
  readonly list: boolean
  readonly protocol: boolean
  readonly seed?: number
  readonly routerModel?: string
  readonly workerModel?: string
  readonly baseUrl?: string
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: { caseId?: string; suite?: CliArgs['suite']; model?: ModelMode; repeat: number; run?: string; runDir?: string; keep: 'all' | 'failures' | 'none'; list: boolean; protocol: boolean; seed?: number; routerModel?: string; workerModel?: string; baseUrl?: string } = {
    repeat: 1,
    keep: 'failures',
    list: false,
    protocol: false,
    routerModel: undefined,
    workerModel: undefined,
    baseUrl: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--case') args.caseId = argv[++index]
    else if (arg === '--suite') args.suite = argv[++index] as CliArgs['suite']
    else if (arg === '--model') args.model = argv[++index] as ModelMode
    else if (arg === '--repeat') args.repeat = Math.max(1, Number(argv[++index] ?? 1))
    else if (arg === '--run') args.run = argv[++index]
    else if (arg === '--run-dir') args.runDir = argv[++index]
    else if (arg === '--keep') args.keep = argv[++index] as CliArgs['keep']
    else if (arg === '--list') args.list = true
    else if (arg === '--protocol') args.protocol = true
    else if (arg === '--seed') args.seed = Number(argv[++index])
    else if (arg === '--router-model') args.routerModel = argv[++index]
    else if (arg === '--worker-model') args.workerModel = argv[++index]
    else if (arg === '--base-url') args.baseUrl = argv[++index]
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function latestRunDir(): string | null {
  if (!existsSync(RESULTS_DIR)) return null
  const entries = readdirSync(RESULTS_DIR).sort()
  const latest = entries.at(-1)
  return latest === undefined ? null : join(RESULTS_DIR, latest)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  // Protocol self-check (design §10 step 1): no credentials, no network.
  if (args.protocol) {
    const checks = runProtocolChecks()
    process.stdout.write(`\n${renderProtocolChecks(checks)}\n`)
    return checks.every(check => check.pass) ? 0 : 1
  }

  const entries = await allCases()
  const liveEntries = await allLiveCases()

  if (args.list) {
    for (const entry of entries) {
      const mode = isRunnable(entry) ? `runnable (model router=${entry.model.router}/worker=${entry.model.worker})` : `blocked: ${(entry as BlockedCase).reason}`
      process.stdout.write(`${entry.priority.toUpperCase()}  ${entry.id.padEnd(24)} ${entry.title} — ${mode}\n`)
    }
    process.stdout.write('\n-- Live E2E（真实模型，--model live 才可运行）--\n')
    for (const entry of liveEntries) {
      process.stdout.write(`${entry.priority.toUpperCase()}  ${entry.id.padEnd(24)} ${entry.title}\n`)
    }
    return 0
  }

  // Select cases: live registry for live-p0 / --model live, scripted otherwise.
  // `--model` keeps dual duty for backward compatibility with the eval:live
  // script: a mode token selects the mode, any other value overrides BOTH
  // roles' model (design §2.2) and implies live.
  const modeToken = args.model !== undefined && ['live', 'replay', 'scripted'].includes(args.model)
  const bothModel = !modeToken && args.model !== undefined ? args.model : undefined
  const liveRun = args.suite === 'live-p0' || args.model === 'live' || bothModel !== undefined
    || liveEntries.some(entry => entry.id === args.caseId)
  const model: ModelMode = modeToken ? (args.model as ModelMode) : bothModel !== undefined ? 'live' : 'scripted'
  if (liveRun && model === 'scripted') {
    throw new Error('live cases require a real model: use --model live (scripted would only re-act, not decide — design §2)')
  }

  // The ONE model-plan resolution point (design §2.2).
  const modelPlan = resolveModelPlan({
    ...(bothModel === undefined ? {} : { both: bothModel }),
    ...(args.routerModel === undefined ? {} : { router: args.routerModel }),
    ...(args.workerModel === undefined ? {} : { worker: args.workerModel }),
    ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
  })
  if (liveRun) requireLiveCredential(modelPlan)

  let selected: readonly (EvalCase | BlockedCase | LiveEvalCase)[] = entries
  if (args.caseId !== undefined) {
    const liveHit = liveEntries.find(entry => entry.id === args.caseId)
    selected = liveHit !== undefined ? [liveHit] : entries.filter(entry => entry.id === args.caseId)
    if (selected.length === 0) throw new Error(`unknown case: ${args.caseId}`)
  } else if (args.suite === 'live-p0') {
    selected = liveEntries
  } else if (args.suite === 'p0' || args.suite === 'p1') {
    selected = liveRun ? liveEntries.filter(entry => entry.priority === args.suite) : entries.filter(entry => entry.priority === args.suite)
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const runDir = args.runDir !== undefined ? resolve(args.runDir) : join(RESULTS_DIR, runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(RESULTS_DIR, 'LATEST'), `${runId}\n`, 'utf8')

  // run.json (design §4.3): immutable config BEFORE any case runs.
  const startedAt = Date.now()
  writeFileSync(join(runDir, 'run.json'), JSON.stringify({
    runId,
    startedAt,
    mode: model,
    modelPlan: { requested: modelPlan, resolved: { router: resolveRoute(modelPlan.router), worker: resolveRoute(modelPlan.worker) } },
    seed: args.seed,
    repeat: args.repeat,
    keep: args.keep,
    env: { node: process.version, platform: process.platform },
  }, null, 2) + '\n', 'utf8')

  // Run-level evidence sinks (design §4.3).
  const eventsSink = join(runDir, 'events.jsonl')
  const requestsSink = join(runDir, 'requests.jsonl')
  const allRecords: (ModelRequestRecord & { readonly caseId: string })[] = []

  const previousDir = args.runDir === undefined ? previousRun(runDir) : null
  const reports: CaseReport[] = []
  const globals: { name: string; pass: boolean; detail?: string }[] = []
  const unhandled: string[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason instanceof Error ? reason.message : String(reason))
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    for (const entry of selected) {
      if (isLiveCase(entry)) {
        reports.push(await runLiveCase(entry, { runId, runDir, args, model, modelPlan, eventsSink, requestsSink, allRecords }))
        continue
      }
      if (!isRunnable(entry)) {
        const trace = new TraceRecorder({ runId, caseId: entry.id, attempt: 1 }, join(runDir, 'cases', entry.id, 'attempt-1'), () => Date.now())
        mkdirSync(trace.directory, { recursive: true })
        trace.finalize((entry as BlockedCase).reason)
        reports.push(caseReport({
          entry, status: 'blocked', attempts: 0, trace, durationMs: 0, modelCalls: 0, firstFailedStage: null,
        }))
        continue
      }
      reports.push(await runCase(entry, { runId, runDir, args, model, modelPlan, eventsSink, requestsSink, allRecords }))
    }
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }

  // Global hard assertions (design §6.2).
  globals.push({ name: 'no-unhandled-rejection', pass: unhandled.length === 0, ...(unhandled.length > 0 ? { detail: unhandled.join('; ').slice(0, 300) } : {}) })
  globals.push(...credentialScan(runDir))

  const failed = reports.filter(report => report.status === 'fail' || report.status === 'error' || !report.budget.withinBudget)
  const globalFailed = globals.some(entry => !entry.pass)
  const verdict: RunReport['verdict'] = failed.length === 0 && !globalFailed ? 'pass' : 'fail'

  const usage = aggregateUsage(allRecords)
  const report: RunReport = {
    runId,
    startedAt,
    finishedAt: Date.now(),
    modelPlan,
    keep: args.keep,
    cases: reports,
    globals,
    usage,
    verdict,
  }
  writeReports(runDir, report, previousDir)
  const reportPath = join(runDir, 'report.md')
  process.stdout.write(`\n${readFileSync(reportPath, 'utf8')}\nreport: ${reportPath}\n`)
  return verdict === 'pass' ? 0 : 1
}

function previousRun(currentRunDir: string): string | null {
  if (!existsSync(RESULTS_DIR)) return null
  const entries = readdirSync(RESULTS_DIR)
    .filter(name => name.startsWith('run-'))
    .sort()
  const index = entries.indexOf(currentRunDir.split('/').at(-1) ?? '')
  if (index <= 0) return null
  return join(RESULTS_DIR, entries[index - 1] ?? '')
}

/** Scan every evidence file for credential-shaped strings. */
function credentialScan(runDir: string): { name: string; pass: boolean; detail?: string }[] {
  const findings: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const target = join(dir, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl') || entry.name.endsWith('.md')) {
        const text = readFileSync(target, 'utf8')
        if (looksSensitive(text)) findings.push(target)
      }
    }
  }
  visit(runDir)
  return [{
    name: 'no-credential-leak',
    pass: findings.length === 0,
    ...(findings.length > 0 ? { detail: findings.join(', ').slice(0, 300) } : {}),
  }]
}

interface RunCaseOptions {
  readonly runId: string
  readonly runDir: string
  readonly args: CliArgs
  readonly model: ModelMode
  readonly modelPlan: ModelPlan
  /** Run-level sinks (design §4.3). */
  readonly eventsSink: string
  readonly requestsSink: string
  /** All request records of the run (usage-ledger source). */
  readonly allRecords: (ModelRequestRecord & { readonly caseId: string })[]
}

/** Run one scripted case with `--repeat` attempts; the first pass stops. */
async function runCase(entry: EvalCase, options: RunCaseOptions): Promise<CaseReport> {
  const { runId, runDir } = options
  let lastReport: CaseReport | null = null
  for (let attempt = 1; attempt <= options.args.repeat; attempt += 1) {
    lastReport = await runAttempt(entry, { ...options, attempt })
    if (lastReport.status === 'pass') return lastReport
  }
  return lastReport as CaseReport
}

/**
 * Run one LIVE case. Every attempt draws a different hidden seed (design
 * §4.2); `--repeat N` is the stability gate — ALL attempts must pass (连续
 * N 次通过), there is no stop-on-first-pass for live runs. On failure the
 * FAILING attempt's report is returned (with the total attempts recorded).
 */
async function runLiveCase(entry: LiveEvalCase, options: RunCaseOptions): Promise<CaseReport> {
  const reports: CaseReport[] = []
  for (let attempt = 1; attempt <= options.args.repeat; attempt += 1) {
    const seed = options.args.seed !== undefined
      ? options.args.seed + attempt - 1
      : (Date.now() ^ (entry.id.length * 7919) ^ (attempt * 104_729)) >>> 0
    reports.push(await runAttemptShared({
      entry,
      attempt,
      seed,
      runId: options.runId,
      runDir: options.runDir,
      keep: options.args.keep,
      mode: options.model,
      modelPlan: options.modelPlan,
      eventsSink: options.eventsSink,
      requestsSink: options.requestsSink,
      allRecords: options.allRecords,
      liveSetup: async (rt, driver): Promise<CaseChecks> => {
        const facts = await entry.fixtures(seed, rt)
        driver.facts = facts
        await entry.policy?.(rt, facts)
        // Fixture evidence (design §9): keep a copy inside the attempt dir.
        cpSync(rt.fixtureDir, join(options.runDir, 'cases', entry.id, `attempt-${String(attempt)}`, 'fixture'), { recursive: true })
        writeEvidence(rt, 'fixture-seed.json', {
          seed,
          facts: {
            file: facts.file,
            owner: facts.owner,
            deadline: facts.deadline,
            errorCode: facts.errorCode,
            briefCode: facts.briefCode,
            distractorCounts: { owners: facts.distractorOwners.length, deadlines: facts.distractorDeadlines.length, errorCodes: facts.distractorErrorCodes.length },
          },
        })
        return { chain: [], semantics: [] }
      },
      oracle: async (rt, driver) => await entry.oracle({ rt, driver, facts: driver.facts }),
    }))
    if (reports.at(-1)?.status !== 'pass') break
  }
  const last = reports.at(-1)
  if (last === undefined) throw new Error(`live case ${entry.id} produced no report`)
  const allPass = reports.every(report => report.status === 'pass') && reports.length === options.args.repeat
  return allPass ? last : { ...last, status: last.status === 'pass' ? 'fail' : last.status, attempts: reports.length }
}

/** Shared attempt runner for scripted AND live cases. */
async function runAttemptShared(input: {
  readonly entry: EvalCase | LiveEvalCase
  readonly attempt: number
  readonly seed: number
  readonly runId: string
  readonly runDir: string
  readonly keep: 'all' | 'failures' | 'none'
  readonly mode: ModelMode
  readonly modelPlan: ModelPlan
  readonly eventsSink: string
  readonly requestsSink: string
  readonly allRecords: (ModelRequestRecord & { readonly caseId: string })[]
  readonly scripts?: { readonly router?: import('@deepseek-ai/dsh-llm').StreamChunk[][]; readonly worker?: import('@deepseek-ai/dsh-llm').StreamChunk[][] }
  readonly liveSetup?: (rt: EvalRuntime, driver: ScenarioDriver) => Promise<CaseChecks>
  readonly oracle?: (rt: EvalRuntime, driver: ScenarioDriver) => Promise<CaseChecks>
}): Promise<CaseReport> {
  const { entry, attempt, runId, runDir, mode } = input
  const isLive = input.oracle !== undefined
  const attemptDir = join(runDir, 'cases', entry.id, `attempt-${String(attempt)}`)
  mkdirSync(attemptDir, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), `quno-eval-${entry.id}-`))
  const clock = virtualClock()
  const persistence = new JsonlSessionPersistence(join(home, 'sessions'))
  const collector = new EvalCollector()
  const recordingFile = join(attemptDir, 'model-requests.jsonl')

  // Live mounts the PRODUCTION adapter (llm-pi-ai over the pi-ai catalog);
  // the gateway records and delegates — it never speaks the wire protocol.
  const live = mode === 'live'
    ? await createProductionAdapter({
      provider: input.modelPlan.router.provider,
      models: [...new Set([input.modelPlan.router.model, input.modelPlan.worker.model])],
      apiKey: () => process.env['QUNO_EVAL_LIVE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'],
      logger: { warn: () => {} },
    })
    : undefined
  const gateway = new ModelGateway({
    modes: { router: mode, worker: mode },
    recordingFile,
    ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
    ...(live === undefined ? {} : { inner: live }),
    plan: input.modelPlan,
    runContext: { runId, caseId: entry.id, attempt, seed: String(input.seed) },
    onRecord: record => {
      input.allRecords.push({ ...record, caseId: entry.id })
      appendFileSync(input.requestsSink, `${JSON.stringify(redactJson(record))}\n`, 'utf8')
    },
    now: clock.now,
  })
  if (mode === 'replay') {
    const source = join(RESULTS_DIR, readFileSync(join(RESULTS_DIR, 'LATEST'), 'utf8').trim())
    const sourceFile = existsSync(join(source, 'cases', entry.id, `attempt-1`, 'model-requests.jsonl'))
      ? join(source, 'cases', entry.id, 'attempt-1', 'model-requests.jsonl')
      : recordingFile
    gateway.useRecording(sourceFile)
  }

  const trace = new TraceRecorder({ runId, caseId: entry.id, attempt }, attemptDir, clock.now)
  const composeOptions = { runId, caseId: entry.id, attempt, home, evidenceDir: attemptDir, gateway, plan: input.modelPlan, clock, persistence, collector, collectorInstanceId: '', collectorSourceId: '', restarts: [] as { at: number }[] }
  const runtime = new EvalRuntime(composeOptions)
  let active: EvalRuntime = runtime
  const startedAt = Date.now()
  let checks: CaseChecks | undefined
  let error: string | undefined
  try {
    await runtime.start()
    gateway.setContextResolver((sessionId, role) => resolveNodeContext(active, sessionId, role))
    const instanceId = await collector.createInstance(rtCollectors(runtime), {}, () => runtime.options.clock.fireDue(10))
    composeOptions.collectorInstanceId = instanceId
    composeOptions.collectorSourceId = collector.sourceIdOf(instanceId)
    const driver = new ScenarioDriver(
      runtime,
      async () => {
        const fresh = new EvalRuntime(composeOptions)
        await fresh.start()
        active = fresh
        return fresh
      },
      collector,
      instanceId,
    )
    if (isLive) {
      checks = await input.liveSetup?.(runtime, driver) ?? { chain: [], semantics: [] }
      for (const step of entry.steps) {
        await driver.run(step)
      }
      await driver.settle()
      const oracleChecks = await input.oracle?.(active, driver) ?? { chain: [], semantics: [] }
      checks = { chain: [...(checks?.chain ?? []), ...oracleChecks.chain], semantics: [...(checks?.semantics ?? []), ...oracleChecks.semantics] }
    } else {
      const scripted = entry as EvalCase
      await scripted.setup?.(runtime)
      for (const step of scripted.steps) {
        await driver.run(step)
      }
      await driver.settle()
      checks = await scripted.checks(active, driver)
    }
  } catch (caught) {
    error = (caught as Error).message
    writeEvidence(active, 'failure.json', {
      caseId: entry.id,
      attempt,
      error,
      stack: (caught as Error).stack ?? null,
      modelCalls: gateway.record().map(record => ({ role: record.role, seq: record.seq, mode: record.mode, error: record.error ?? null })),
    })
  } finally {
    await active.stop().catch(() => {})
    gateway.saveRecording()
  }

  const durationMs = Date.now() - startedAt
  const modelCalls = gateway.calls()
  traceStageOutcomes(trace, checks ?? { chain: [], semantics: [] })
  const firstFailedStage = trace.finalize(error === undefined
    ? 'case does not assert this stage (exercised without a structural check)'
    : `failed before reaching this stage: ${error.slice(0, 160)}`)

  const chainFailed = (checks?.chain ?? []).some(item => !item.pass)
  const semanticsFailed = (checks?.semantics ?? []).some(item => !item.pass)
  const budgetExceeded = durationMs > entry.budget.maxDurationMs || modelCalls > entry.budget.maxModelCalls
  const status: 'pass' | 'fail' | 'error' = error !== undefined
    ? 'error'
    : chainFailed || semanticsFailed || budgetExceeded ? 'fail' : 'pass'

  const classification = isLive
    ? classifyLiveFailure({ error, checks, gateway, modelCallsHappened: gateway.calls() > 0, budgetExceeded })
    : undefined
  if (classification !== undefined && classification.cls !== 'NONE' && status !== 'pass') {
    writeEvidence(active, 'classification.json', classification)
  }

  // Run-level events.jsonl (design §4.3): the attempt's trace joins the run stream.
  for (const event of trace.all()) {
    appendFileSync(input.eventsSink, `${JSON.stringify(redactJson(event))}\n`, 'utf8')
  }

  // Session evidence (design §4.3): redacted per-session copy + real index.
  const sessionsDir = join(attemptDir, 'sessions')
  mkdirSync(sessionsDir, { recursive: true })
  const sessionIndex: { sessionId: string; role: string; ticketId?: string; eventCount: number }[] = []
  for (const sessionId of persistence.sessionIds()) {
    const events = persistence.readAll(sessionId).map(event => redactJson(event))
    writeFileSync(join(sessionsDir, `${encodeURIComponent(sessionId)}.jsonl`), events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8')
    const isWorker = sessionId.startsWith('quno-exec-')
    sessionIndex.push({
      sessionId,
      role: isWorker ? 'worker' : 'router',
      ...(isWorker ? { ticketId: sessionId.slice('quno-exec-'.length) } : {}),
      eventCount: events.length,
    })
  }
  writeFileSync(join(sessionsDir, 'index.json'), JSON.stringify(sessionIndex, null, 2) + '\n', 'utf8')

  EvalRuntime.destroy(home, input.keep, status !== 'pass')

  return caseReport({
    entry: isLive ? liveAsReportEntry(entry as LiveEvalCase, status, classification) : entry as EvalCase,
    status,
    attempts: attempt,
    trace,
    checks,
    durationMs,
    modelCalls,
    ...(error === undefined ? {} : { error }),
    firstFailedStage,
    ...(classification === undefined ? {} : { classification }),
  })
}

/** Adapt a live case into the report entry shape (with its classification). */
function liveAsReportEntry(entry: LiveEvalCase, status: 'pass' | 'fail' | 'error', classification: ReturnType<typeof classifyLiveFailure> | undefined): EvalCase {
  return {
    id: entry.id,
    title: entry.title,
    priority: entry.priority,
    requirement: entry.goal,
    tags: entry.tags,
    model: { router: 'live', worker: 'live' },
    steps: [],
    checks: () => ({ chain: [], semantics: [] }),
    budget: entry.budget,
  }
}

async function runAttempt(entry: EvalCase, options: RunCaseOptions & { readonly attempt: number }): Promise<CaseReport> {
  return await runAttemptShared({
    entry,
    attempt: options.attempt,
    seed: 0,
    runId: options.runId,
    runDir: options.runDir,
    keep: options.args.keep,
    mode: options.model,
    modelPlan: options.modelPlan,
    eventsSink: options.eventsSink,
    requestsSink: options.requestsSink,
    allRecords: options.allRecords,
    scripts: {
      router: [...(entry.scripts?.router ?? [])],
      worker: [...(entry.scripts?.worker ?? [])],
    },
  })
}

/** Get the collectors service face the eval collector needs (typed narrowly). */
function rtCollectors(rt: EvalRuntime): { createInstance(input: { type: string; config: Record<string, unknown> }): { readonly ok: boolean; readonly instance?: { readonly id: string }; readonly error?: unknown } } {
  return rt.host.collectors
}

/** Record each check as its stage's terminal trace event. */
function traceStageOutcomes(trace: TraceRecorder, checks: CaseChecks): void {
  for (const item of checks.chain) {
    if (item.pass) {
      trace.pass(item.stage, { check: item.name }, item.evidence ?? [], { expected: item.expected, actual: item.actual })
    } else {
      trace.fail(item.stage, { check: item.name }, { code: 'assertion', message: item.name }, { expected: item.expected, actual: item.actual }, item.evidence ?? [])
    }
  }
  const failedSemantics = checks.semantics.filter(item => !item.pass)
  if (failedSemantics.length > 0) {
    trace.fail('router.relay', { check: 'semantic-expectations' }, {
      code: 'semantic',
      message: failedSemantics.map(item => `${item.id}:${item.description}`).join('; ').slice(0, 400),
    })
  } else if (checks.semantics.length > 0) {
    trace.pass('router.relay', { check: 'semantic-expectations' }, [], { expected: `${checks.semantics.length} items pass` })
  }
}

const exit = await main()
process.exit(exit)
