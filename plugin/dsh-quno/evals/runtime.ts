/**
 * The Real Runtime Composer (design §3): mounts the production agent-loop
 * topology (testkit + production AgentLoop + a real JSONL session persistence
 * backend), the real QunoHost over a scratch SQLite home, the fixture FS/organ
 * surface and the model gateway — then hands the pieces to cases and checks.
 *
 * Every Quno write path here is the real one: Engine commands, the Effect
 * outbox, the SessionTransport, the Executor, the Assessor and the notification
 * outbox all run unmodified. Sessions are durably stored per JSONL file, so
 * crash/restart steps exercise the same resume paths production would.
 *
 * @module dsh-quno/evals/runtime
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ManualTimer } from '../src/scheduler.ts'
import { QunoHost } from '../src/service.ts'
import type { QunoPluginConfig } from '../src/service.ts'
import type { SessionEventLike } from '../src/core/model.ts'
import { apply as applyQunoPreset } from '../src/preset.ts'
import { apply as applyTaskGuard } from '../src/task-guard.ts'
import { ModelGateway } from './models/gateway.ts'
import type { ModelRole, NodeContext, NodeRefs } from './models/gateway.ts'
import type { ModelPlan } from './plan.ts'
import { EvalOrgan } from './fixtures/organ.ts'
import { registerFixtureTools } from './fixtures/fs.ts'
import { JsonlSessionPersistence } from './persistence.ts'

export interface VirtualClock {
  readonly timer: ManualTimer
  now(): number
  advance(ms: number): number
  fireDue(limit?: number): number
}

/** A virtual clock backed by the scheduler's ManualTimer. */
export function virtualClock(startAt = Date.parse('2026-11-06T09:00:00.000Z')): VirtualClock {
  const timer = new ManualTimer(startAt)
  return {
    timer,
    now: () => timer.now,
    advance: ms => (timer.advance(ms), timer.now),
    fireDue: (limit = 200) => timer.fireDue(limit),
  }
}

export interface ComposeOptions {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  /** Scratch DSH home (a fresh mkdtemp owned by the runner). */
  readonly home: string
  /** Attempt evidence directory. */
  readonly evidenceDir: string
  readonly gateway: ModelGateway
  readonly plan: ModelPlan
  readonly clock: VirtualClock
  readonly persistence: JsonlSessionPersistence
  readonly organ: EvalOrgan
  /** The organ instance/source created for this attempt (set by the runner). */
  organInstanceId: string
  organSourceId: string
  /** Restart bookkeeping, shared across the compositions of one attempt. */
  readonly restarts: { readonly at: number }[]
}

/** One live composition. Owns the Cordis context and the QunoHost. */
export class EvalRuntime {
  readonly qunoHome: string
  readonly fixtureDir: string
  /** Content successfully written through the eval-only memory_remember tool. */
  readonly memoryWrites: string[] = []
  host!: QunoHost
  mainAgent!: Agent
  private mainHandle: { dispose(): Promise<void> } | undefined
  private ctx: Context | undefined
  private readonly disposers: (() => void)[] = []
  private readonly timers: (() => void)[] = []

  constructor(readonly options: ComposeOptions) {
    this.qunoHome = join(options.home, 'quno')
    this.fixtureDir = join(options.home, 'fixture')
    mkdirSync(this.fixtureDir, { recursive: true })
  }

  get now(): () => number {
    return this.options.clock.now
  }

  /** Mount everything and bind the permanent conversation. */
  async start(): Promise<void> {
    const ctx = new Context()
    this.ctx = ctx
    const clock = this.options.clock

    await mountAgentLoopTestDependencies(ctx)
    // The production loop: agents.create/resume below go through its factory.
    await mountAgentLoopTestHarness(ctx)

    // Virtual timer service (scheduler + collectors retries use it).
    ctx.provide('timer', {
      timeout: (callback: () => void, delayMs: number): (() => void) => {
        const dispose = clock.timer.setTimeout(callback, delayMs)
        this.timers.push(dispose)
        return () => dispose()
      },
      interval: (callback: () => void, delayMs: number): (() => void) => {
        let cancelled = false
        let lastDispose: (() => void) | undefined
        const arm = (): void => {
          if (cancelled) return
          lastDispose = clock.timer.setTimeout(() => {
            if (cancelled) return
            callback()
            arm()
          }, delayMs)
        }
        arm()
        return () => {
          cancelled = true
          lastDispose?.()
        }
      },
    })

    // Durable sessions: the real persistence seam + read face + flush barrier.
    const persistence = this.options.persistence
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => await persistence.stat(String(id)),
      create: async (header: { readonly id: SessionId }) => await persistence.create(String(header.id), header),
      open: async (id: SessionId, access: 'read' | 'write') => await persistence.open(String(id), access),
    })
    ctx.provide('sessionQuery', {
      readSession: async (id: SessionId) => ({ events: persistence.readAll(String(id)) }),
    })
    this.disposers.push(ctx.on('session/event', (session: { id: unknown }, event: SessionEventLike) => {
      persistence.appendEvent(String(session.id), event)
    }))
    this.disposers.push(ctx.on('session/flush', () => {
      // Appends persist synchronously; the barrier only materializes files.
      // (Returning a value would change the callback type; persistence is
      // already durable at this point.)
    }))

    // The eval gateway answers the plan's route for BOTH roles; the session
    // identity selects the role (quno-exec-* = worker, else router).
    ctx.llm.registerAdapter([this.options.plan.router.provider], this.options.gateway.llmAdapter())

    // The preset seam the executor resolves: mount applies the REAL quno-task
    // guard module (restrict + monotonic guard + boundary prompt) so the
    // worker boundary in the eval composition is production code, not a stub.
    // Without this the executor skips preset mounting entirely (found by
    // live-direct-read: the worker saw the host's bash/memory tools).
    ctx.provide('agentPresets', {
      mount: async (agentCtx: Context, id?: string): Promise<unknown> => {
        if (id === 'quno-task') {
          try {
            applyTaskGuard(agentCtx)
          } catch (error) {
            process.stderr.write(`[eval-seam] quno-task guard FAILED: ${(error as Error).message}\n`)
            throw error
          }
          return { id }
        }
        // The main conversation's preset face is applied directly at agent
        // creation; nothing further to mount here.
        return { id: id ?? '(none)' }
      },
    })

    // Fixture surface: read-only FS tools scoped to the fixture directory and
    // a real-but-harmless `bash` (hidden from the quno preset; invoked
    // attempts must be refused).
    registerFixtureTools(ctx, this.fixtureDir)

    // The global memory write the guard tests probe: real registry entry, eval
    // storage. The quno preset hides it on its sessions and refuses it on
    // automatic turns — exactly the production mechanics.
    const memoryWrites = this.memoryWrites
    ctx.tools.register(defineTool({
      name: 'memory_remember',
      description: '写入长期记忆（评测环境：记入评测存储，永不外发）。',
      parameters: { content: { type: 'string', required: true } },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'stored' }],
      },
      async execute(args) {
        const content = String(args.content)
        memoryWrites.push(content)
        return { ok: true }
      },
    }))

    const config: QunoPluginConfig = { root: this.qunoHome, name: 'Quno' }
    const host = new QunoHost(ctx, config, {
      info: () => {},
      warn: () => {},
    }, { now: this.options.clock.now })
    this.host = host
    // The quno service must be provided before the main agent mounts its
    // preset (the preset setup resolves it).
    ctx.provide('quno', host)
    ctx.provide('qunoCollectors', host.collectors)

    // The permanent conversation must be resident BEFORE host.start(): the
    // startup recovery (reconcile + effects kick) resolves the Router as the
    // live parent for worker launches.
    const setup = (agentCtx: Context): void => {
      agentCtx.tools.presentAs('native')
      applyQunoPreset(agentCtx)
    }
    const agentOptions = { provider: this.options.plan.router.provider, model: this.options.plan.router.model }
    const existed = await this.options.persistence.stat('quno-main') !== undefined
    const handle = existed
      ? await ctx.agents.resume({
        resumeSessionId: 'quno-main' as SessionId,
        agentOptions,
        setup,
      } as never) as unknown as { agent: Agent; dispose(): Promise<void> }
      : await ctx.agents.create({
        sessionId: 'quno-main' as SessionId,
        meta: { cwd: this.options.home, agentPreset: 'quno' },
        agentOptions,
        setup,
      }) as unknown as { agent: Agent; dispose(): Promise<void> }
    this.mainHandle = handle
    this.mainAgent = handle.agent
    this.disposers.push(ctx.on('session/event', (session: { id: unknown }, event: SessionEventLike) => {
      host.observeSession(String(session.id), event)
    }))

    await host.start()

    // The synthetic organ registers on the real collectors service (provided above).
    this.options.organ.mountOn(ctx)

    host.store.setMainSession(host.qunoId, 'quno-main', 'ok', this.now())
    // The delegated worker resolves its model through the Quno profile.
    host.store.updateQunoProfile(host.qunoId, {
      modelProvider: this.options.plan.router.provider,
      model: this.options.plan.worker.model,
    }, this.now())
    writeFileSync(join(this.options.evidenceDir, 'session-index.json'), JSON.stringify({
      main: 'quno-main',
      executorPrefix: 'quno-exec-',
      persistence: 'JSONL per session under the scratch home',
    }, null, 2) + '\n', 'utf8')
  }

  /** Graceful stop (between cases and for the restart step). */
  async stop(): Promise<void> {
    await this.host?.stop().catch(() => {})
    for (const dispose of this.disposers.splice(0)) dispose()
    this.timers.splice(0).forEach(dispose => dispose())
    await this.mainHandle?.dispose().catch(() => {})
    await this.ctx?.fiber.dispose().catch(() => {})
    this.ctx = undefined
    // The composition is fully stopped: release session write ownership so the
    // restart can re-open the same logs (single-process eval harness).
    this.options.persistence.releaseWriters()
  }

  /**
   * Crash: stop the composition without settling in-flight work. Durable state
   * (SQLite + session JSONL) is kept for the restart.
   */
  async crash(): Promise<void> {
    await this.stop()
  }

  /** Remove the scratch home (runner-side cleanup). */
  static destroy(home: string, keep: 'all' | 'failures' | 'none', failed: boolean): void {
    if (keep === 'all' || (keep === 'failures' && failed)) return
    rmSync(home, { recursive: true, force: true })
  }
}

/** Durable session events for checks (over the JSONL persistence). */
export function journalEvents(rt: EvalRuntime, sessionId: string): readonly SessionEventLike[] {
  return rt.options.persistence.readAll(sessionId)
}

/** Derive the main-session stage from the latest inbound message source. */
function stageForMain(events: readonly SessionEventLike[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'user/message') continue
    const kind = (event.data as { source?: { kind?: string } }).source?.kind
    if (kind === 'quno-eval') return 'eval.candidate'
    if (kind === 'quno-report') return 'router.relay'
    if (kind === 'quno-notify' || kind === 'quno-task') return 'notification.presented'
    return 'router.relay'
  }
  return 'router.relay'
}

/** Safe repo read: crash steps may have closed the store. */
function tryRepo<T>(rt: EvalRuntime, read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Resolve the node identity for one model call (design §3.2): turn/step come
 * from the REAL session events (their seq), stage from the inbound source,
 * refs from the session identity and the durable repo — never guessed.
 */
export function resolveNodeContext(rt: EvalRuntime, sessionId: string, role: ModelRole): NodeContext {
  const events = rt.options.persistence.readAll(sessionId)
  let turnId: string | undefined
  let stepId: string | undefined
  for (const event of events) {
    if (event.type === 'turn/start') turnId = `turn:${String(event.seq)}`
    else if (event.type === 'step/start') stepId = `step:${String(event.seq)}`
  }
  const refs: { -readonly [K in keyof NodeRefs]: NodeRefs[K] } = {}
  if (sessionId.startsWith('quno-exec-')) {
    refs.ticketId = sessionId.slice('quno-exec-'.length)
  } else {
    // Router refs from the latest program-originated message.
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event === undefined || event.type !== 'user/message') continue
      const source = (event.data as { source?: Record<string, unknown> }).source
      if (source === undefined || source === null) continue
      if (source['kind'] === 'quno-eval' && typeof source['evalId'] === 'string') {
        refs.evalId = source['evalId']
        const evalRecord = tryRepo(rt, () => rt.host.repo.getEval(refs.evalId!))
        if (evalRecord !== undefined) {
          refs.threadId = evalRecord.threadId
          refs.triggerIds = evalRecord.triggerIds
        }
        break
      }
      if (source['kind'] === 'quno-report' && typeof source['ticketId'] === 'string') {
        refs.ticketId = source['ticketId']
        break
      }
      if ((source['kind'] === 'quno-notify' || source['kind'] === 'quno-task') && typeof source['notificationId'] === 'string') {
        refs.notificationId = source['notificationId']
        break
      }
    }
  }
  if (refs.ticketId !== undefined) {
    const assignment = tryRepo(rt, () => rt.host.repo.findActiveAssignment(refs.ticketId!))
    if (assignment !== undefined) {
      refs.assignmentId = assignment.id
      const run = tryRepo(rt, () => rt.host.repo.findRunningWorkerRun(assignment.id))
      if (run !== undefined) refs.workerRunId = run.id
    }
  }
  const stage = role === 'worker' ? 'worker.execution' : stageForMain(events)
  return {
    stage,
    ...(turnId === undefined ? {} : { turnId }),
    ...(stepId === undefined ? {} : { stepId }),
    refs,
  }
}

/** Append one JSON evidence file inside the attempt dir; returns its run-relative path. */
export function writeEvidence(rt: EvalRuntime, name: string, value: unknown): string {
  const file = join(rt.options.evidenceDir, name)
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
  return join('cases', rt.options.caseId, `attempt-${String(rt.options.attempt)}`, name)
}
