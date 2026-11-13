/**
 * The Executor: translates Assignment state into a live, read-only executor
 * session and back.
 *
 * Ownership rules implemented here:
 *
 * - a Ticket owns a stable executor Session id (`quno-exec-<ticketId>`); a
 *   retry creates a new Assignment but resumes the same Session;
 * - automatic Worker creation resolves the permanent Router Agent from its
 *   durable session id and passes it as the live parent. When that resolution
 *   fails the Effect is retried with backoff: no parent is ever fabricated;
 * - the WorkerSlot budget counts *active turns*, not resident sessions. A
 *   human follow-up may take one extra slot, and wake-ups beat new launches;
 * - every input is delivered with a stable message id, recorded as an attempt,
 *   and only marked delivered after the transport's durability barrier;
 * - a turn end closes the WorkerRun; the next input wakes the same session.
 *
 * @module dsh-quno/app/executor
 */

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { WORKER_BOUNDARY, registerWorkerTools, ticketIdFromExecutorSession } from './worker-tools.ts'
import type { WorkerCliFace } from './worker-tools.ts'
import { EffectRetryError } from './effects.ts'
import { SessionTransport } from './transport.ts'
import type { Engine } from '../core/engine.ts'
import type { DomainRepository } from '../core/repository.ts'
import type {
  AssignmentRecord,
  InputAttemptRecord,
  SessionEventLike,
  TicketId,
  TicketInputRecord,
} from '../core/model.ts'
import type { OrganEndpointView } from '../types.ts'

/** Child preset id registered by this plugin. */
export const EXECUTOR_PRESET = 'quno-task'

/** Suggestions per WorkerRun. */
export const DEFAULT_MAX_WORKERS = 4

/** What the executor needs from its composition root. */
export interface ExecutorDeps {
  readonly ctx: Context
  readonly engine: Engine
  readonly repo: DomainRepository
  readonly qunoId: string
  readonly logger: { warn(message: string): void; info?(message: string): void }
  readonly now: () => number
  readonly transport: SessionTransport
  /** Resolve the exact live permanent-conversation Agent (cold resume allowed). */
  readonly resolveRouter: () => Promise<Agent | undefined>
  /** Provider/model for the executor session; undefined = harness default. */
  readonly modelSelection?: () => { readonly provider: string; readonly model: string; readonly reasoningEffort?: string } | undefined
  readonly maxTokens?: () => number
  readonly defaultCwd: string
  readonly maxWorkers?: number
  /** Resolve one mounted Organ endpoint for worker-initiated exchanges. */
  readonly resolveExchangeResponder?: (endpoint: string, kind: 'request' | 'command') => boolean
  /** The exchange-facing endpoints for worker discovery and refusal directories. */
  readonly listOrgans?: () => readonly OrganEndpointView[]
  /** The structured read-only CLI surface (`quno_cli_call`). */
  readonly cli?: WorkerCliFace
  /** Called after a durable worker state change (UI refresh). */
  readonly onChange?: () => void
}

/** Structural face of the preset registry. */
interface PresetRegistryFace {
  mount(ctx: Context, id?: string): Promise<unknown>
}

/** Structural face of session persistence. */
interface SessionPersistenceFace {
  stat(id: SessionId): Promise<unknown | undefined>
}

/** One resident executor session. */
interface ResidentWorker {
  readonly agent: Agent
  readonly handle?: AgentHandle
}

/** Launch outcome for diagnostics. */
export interface LaunchResult {
  readonly launched: boolean
  readonly deliveredInputs: number
  readonly sentPrompt: boolean
  readonly reason: string | null
}

/** One retained live session plus the turn state the executor watches. */
export class Executor {
  private readonly residents = new Map<TicketId, ResidentWorker>()
  private readonly busy = new Set<TicketId>()
  private readonly controllers = new Map<TicketId, AbortController>()
  private stopped = false
  private readonly maxWorkers: number

  constructor(private readonly deps: ExecutorDeps) {
    this.maxWorkers = deps.maxWorkers ?? DEFAULT_MAX_WORKERS
  }

  /** Number of executor turns currently occupying a slot. */
  get activeSlots(): number {
    return this.busy.size
  }

  /** Stop in-flight work; durable state remains for the next boot. */
  stop(): void {
    this.stopped = true
    for (const controller of this.controllers.values()) controller.abort(new Error('quno executor stopped'))
    this.controllers.clear()
    for (const resident of this.residents.values()) {
      void resident.handle?.dispose().catch(() => {})
    }
    this.residents.clear()
    this.busy.clear()
  }

  /**
   * Ensure the Assignment's executor session is live and the assignment prompt
   * (once) plus every undelivered input (each time) has been delivered. A
   * delivered-but-unread input never re-sends its message (the transport's
   * stable identity keeps the log deduplicated); when nothing else wakes the
   * session, a bounded resume note brings the unread input back to attention.
   */
  async launch(assignmentId: string, signal?: AbortSignal): Promise<LaunchResult> {
    if (this.stopped) return { launched: false, deliveredInputs: 0, sentPrompt: false, reason: 'executor stopped' }
    const assignment = this.deps.repo.getAssignment(assignmentId)
    if (assignment === undefined) return { launched: false, deliveredInputs: 0, sentPrompt: false, reason: 'unknown assignment' }
    const ticket = this.deps.repo.getTicket(assignment.ticketId)
    if (ticket === undefined || ticket.ended !== null) {
      this.release(assignment.ticketId)
      return { launched: false, deliveredInputs: 0, sentPrompt: false, reason: 'ticket ended' }
    }
    const deliverable = this.pendingInputs(ticket.id).filter(input => input.deliveredAt === null)
    const unread = this.pendingInputs(ticket.id).filter(input => input.deliveredAt !== null && input.readAt === null)
    const firstTurn = assignment.deliveredAt === null
    const needsWake = !firstTurn
      && deliverable.length === 0
      && unread.length === 0
      && assignment.report !== null
      && (assignment.report.state === 'waiting' || assignment.report.state === 'blocked' || assignment.report.state === 'failed')
    if (!firstTurn && deliverable.length === 0 && unread.length === 0 && !needsWake) {
      // Nothing to deliver. An active turn keeps its slot; an idle resident
      // (or an absent one) frees it.
      const resident = this.residents.get(ticket.id)
      if (resident === undefined || resident.agent.status !== 'running') this.release(ticket.id)
      return { launched: false, deliveredInputs: 0, sentPrompt: false, reason: 'no pending work' }
    }
    this.reserveSlot(ticket.id, deliverable)
    const controller = new AbortController()
    const composedSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    this.controllers.set(ticket.id, controller)
    let agent: Agent
    try {
      agent = await this.ensureAgent(ticket.id, assignment, composedSignal)
    } catch (error) {
      this.release(ticket.id)
      throw error
    }
    const now = this.deps.now()
    const run = this.deps.engine.assignmentStarted({ assignmentId: assignment.id, now })
    const delivered: string[] = []
    let sentPrompt = false
    try {
      if (firstTurn) {
        sentPrompt = true
        const prompt = buildAssignmentPrompt(ticket, assignment)
        await this.deps.transport.send(agent, {
          requestId: `assignment:${assignment.id}:prompt`,
          text: prompt,
          mode: 'queue',
          source: {
            kind: 'quno-worker-prompt',
            form: 'relay',
            summary: ticket.title,
            ...(run === null ? {} : { runId: run.id }),
          },
        }, () => {})
        this.deps.engine.inputsDelivered({ ticketId: ticket.id, inputIds: [], assignmentId: assignment.id, now: this.deps.now() })
      } else if (needsWake) {
        // An explicit retry of a waiting/blocked/failed report wakes the same
        // executor session without pretending a new input exists.
        await this.deps.transport.send(agent, {
          requestId: `assignment:${assignment.id}:resume:${String(assignment.report?.at ?? 0)}`,
          text: `【Quno 续跑】上一轮报告状态为 ${assignment.report?.state ?? 'unknown'}。请根据当前状态继续推进；如果已经无法继续，直接用 quno_worker_report 说明阻塞原因。`,
          mode: 'queue',
          source: {
            kind: 'quno-worker-prompt',
            form: 'relay',
            summary: ticket.title,
            ...(run === null ? {} : { runId: run.id }),
          },
        }, () => {})
      } else if (deliverable.length === 0 && unread.length > 0 && agent.status !== 'running') {
        // Delivered-but-unread input after a crash/restart: the message is
        // already in the durable log, so re-sending would duplicate it. Wake
        // the resumed session with a bounded note pointing back at it.
        await this.deps.transport.send(agent, {
          requestId: `assignment:${assignment.id}:wake:${String(now)}`,
          text: `【Quno 输入补投】会话记录中已有 ${String(unread.length)} 条尚未处理的输入，请继续处理：\n${unread.map(input => `- ${input.text ?? input.id}`).join('\n')}`,
          mode: 'queue',
          source: {
            kind: 'quno-input',
            form: 'notice',
            summary: '补投提醒',
            ticketId: ticket.id,
            ...(run === null ? {} : { runId: run.id }),
          } as never,
        }, () => {})
      }
      for (const input of deliverable) {
        const attempt = this.nextAttempt(input.id)
        const messageId = `quno:input:${input.id}`
        this.deps.repo.insertInputAttempt({
          id: `attempt_${input.id}_${String(attempt)}`,
          inputId: input.id,
          attempt,
          messageId,
          mode: agent.status === 'running' ? 'steer' : 'queue',
          status: 'prepared',
          reason: null,
          createdAt: this.deps.now(),
          finishedAt: null,
        })
        try {
          await this.deps.transport.send(agent, {
            requestId: `input:${input.id}`,
            text: renderInput(input),
            mode: agent.status === 'running' ? 'steer' : 'queue',
            source: {
              kind: 'quno-input',
              form: input.context ? 'notice' : 'relay',
              summary: input.text ?? 'Quno input',
              ticketId: ticket.id,
              ...(run === null ? {} : { runId: run.id }),
            } as never,
          }, () => {})
        } catch (error) {
          this.deps.repo.updateInputAttempt(`attempt_${input.id}_${String(attempt)}`, {
            status: 'failed',
            reason: (error as Error).message,
            finishedAt: this.deps.now(),
          })
          throw error
        }
        this.deps.repo.updateInputAttempt(`attempt_${input.id}_${String(attempt)}`, {
          status: 'delivered',
          finishedAt: this.deps.now(),
        })
        delivered.push(input.id)
      }
      if (delivered.length > 0) {
        this.deps.engine.inputsDelivered({ ticketId: ticket.id, inputIds: delivered, assignmentId: assignment.id, now: this.deps.now() })
      }
      this.deps.onChange?.()
      return { launched: true, deliveredInputs: delivered.length, sentPrompt, reason: null }
    } catch (error) {
      this.release(ticket.id)
      const reason = (error as Error).message
      try {
        this.deps.engine.deliveryFailed({
          ticketId: ticket.id,
          inputIds: delivered,
          reason,
          retryAt: this.deps.now() + 30_000,
          now: this.deps.now(),
        })
      } catch {
        // The durable delivery-failure marker is best effort; the Effect retry
        // below is the recovery path.
      }
      if (error instanceof EffectRetryError) throw error
      throw new EffectRetryError(`worker delivery failed: ${reason}`, 30_000)
    }
  }

  /** Deliver new input to an already-running executor (wake priority). */
  async deliverInputs(ticketId: TicketId, signal?: AbortSignal): Promise<LaunchResult> {
    const assignment = this.deps.repo.findActiveAssignment(ticketId)
    if (assignment === undefined) return { launched: false, deliveredInputs: 0, sentPrompt: false, reason: 'no active assignment' }
    return await this.launch(assignment.id, signal)
  }

  /**
   * Watch one session event. Called for every session on the host, so unknown
   * sessions are ignored cheaply.
   */
  observe(sessionId: string, event: SessionEventLike): void {
    const ticketId = ticketIdFromExecutorSession(sessionId)
    if (ticketId === null) return
    if (event.type === 'user/message') {
      const data = event.data as { id?: unknown } | undefined
      const id = typeof data?.id === 'string' ? data.id : ''
      if (id.startsWith('quno:input:')) {
        const inputId = id.slice('quno:input:'.length)
        const record = this.deps.repo.getInput(inputId)
        if (record !== undefined && record.readAt === null) {
          this.deps.engine.inputsRead({ ticketId, inputIds: [inputId], now: this.deps.now() })
        }
      }
      return
    }
    if (event.type !== 'turn/end') return
    const assignment = this.deps.repo.findActiveAssignment(ticketId)
    if (assignment !== undefined) {
      this.deps.engine.turnEnded({ assignmentId: assignment.id, now: this.deps.now() })
    }
    this.release(ticketId)
    this.deps.onChange?.()
  }

  /**
   * Startup reconciliation: a run whose turn already ended is closed without
   * re-prompting; a run that died mid-turn (or holds delivered-but-unread
   * input) is closed as a zombie and its launch Effect is re-armed, so the
   * unread input is re-delivered exactly once under a fresh WorkerRun. A
   * pending assignment re-arms its launch Effect directly.
   */
  async reconcile(now: number): Promise<{ closed: number; rearmed: number }> {
    let closed = 0
    let rearmed = 0
    const agents = this.agentsService()
    for (const assignment of this.deps.repo.listAssignmentsByState('running', 100)) {
      const ticket = this.deps.repo.getTicket(assignment.ticketId)
      if (ticket === undefined || ticket.ended !== null) continue
      const live = agents?.get(assignment.executorSessionId as SessionId)
      if (live !== undefined) continue
      const ended = await this.sessionTurnEnded(assignment.executorSessionId, assignment.createdAt)
      if (ended) {
        this.deps.engine.turnEnded({ assignmentId: assignment.id, now })
        this.release(assignment.ticketId)
        closed += 1
      } else {
        // The old process died mid-turn: close the zombie run (launch inserts a
        // fresh one) and re-arm the durable launch Effect instead of leaving the
        // assignment stranded with delivered-but-unread input.
        this.deps.engine.turnEnded({ assignmentId: assignment.id, now })
        this.release(assignment.ticketId)
        this.deps.repo.enqueueEffect({
          kind: 'assignment-launch',
          key: assignment.id,
          payload: { assignmentId: assignment.id, ticketId: ticket.id, reconcile: true },
          now,
        })
        rearmed += 1
      }
    }
    for (const assignment of this.deps.repo.listAssignmentsByState('pending', 100)) {
      const ticket = this.deps.repo.getTicket(assignment.ticketId)
      if (ticket === undefined || ticket.ended !== null) continue
      this.deps.repo.enqueueEffect({
        kind: 'assignment-launch',
        key: assignment.id,
        payload: { assignmentId: assignment.id, ticketId: ticket.id, reconcile: true },
        now,
      })
      rearmed += 1
    }
    return { closed, rearmed }
  }

  private async sessionTurnEnded(sessionId: string, after: number): Promise<boolean> {
    const history = this.deps.ctx.get('sessionQuery') as { readSession?(id: SessionId): Promise<{ events: readonly SessionEventLike[] }> } | undefined
    if (history?.readSession === undefined) return false
    try {
      const snapshot = await history.readSession(sessionId as SessionId)
      for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
        const event = snapshot.events[index]
        if (event === undefined) continue
        if (event.type !== 'turn/end') continue
        const at = readEventTime(event, after)
        return at >= after
      }
      return false
    } catch {
      return false
    }
  }

  private pendingInputs(ticketId: TicketId): readonly TicketInputRecord[] {
    return this.deps.repo.listInputsByTicket(ticketId, { limit: 50 })
      .filter(input => input.deliveredAt === null || input.readAt === null)
  }

  private nextAttempt(inputId: string): number {
    let attempt = 1
    while (this.deps.repo.findInputAttempt(inputId, attempt) !== undefined) attempt += 1
    return attempt
  }

  private reserveSlot(ticketId: TicketId, pending: readonly TicketInputRecord[]): void {
    if (this.busy.has(ticketId)) return
    const humanWake = pending.some(input => input.human)
    const limit = humanWake ? this.maxWorkers + 1 : this.maxWorkers
    if (this.busy.size >= limit) {
      throw new EffectRetryError('worker slots are busy', 5_000)
    }
    this.busy.add(ticketId)
  }

  private release(ticketId: TicketId): void {
    this.busy.delete(ticketId)
    const controller = this.controllers.get(ticketId)
    if (controller !== undefined) {
      controller.abort(new Error('quno worker turn settled'))
      this.controllers.delete(ticketId)
    }
  }

  private agentsService(): AgentRegistry | undefined {
    return this.deps.ctx.get('agents') as AgentRegistry | undefined
  }

  private async ensureAgent(ticketId: TicketId, assignment: AssignmentRecord, signal: AbortSignal): Promise<Agent> {
    const sessionId = assignment.executorSessionId as SessionId
    const agents = this.agentsService()
    if (agents === undefined) throw new EffectRetryError('the agent registry is not mounted', 30_000)
    const live = agents.get(sessionId)
    if (live !== undefined) {
      this.residents.set(ticketId, { agent: live })
      return live
    }
    const router = await this.deps.resolveRouter()
    if (router === undefined) {
      throw new EffectRetryError('the permanent conversation cannot be resolved; worker launch is deferred', 30_000)
    }
    const directory = assignment.directory === '' ? this.deps.defaultCwd : assignment.directory
    const setup = this.composeSetup(ticketId)
    const exists = await this.sessionExists(sessionId)
    if (exists) {
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        parentAgent: router,
        signal,
        setup,
      })
      this.residents.set(ticketId, { agent: handle.agent, handle })
      return handle.agent
    }
    let handle: AgentHandle
    try {
      handle = await agents.create({
        sessionId,
        parentAgent: router,
        meta: {
          cwd: directory,
          parentSession: router.session.id,
          origin: 'subagent',
          delegationDepth: 1,
        },
        ...(this.agentOptions() === undefined ? {} : { agentOptions: this.agentOptions() }),
        signal,
        setup,
      })
    } catch (error) {
      // A persisted session the persistence probe could not see (or a stale
      // registration) is recoverable by resuming under the same identity.
      handle = await agents.resume({ resumeSessionId: sessionId, parentAgent: router, signal, setup })
      void error
    }
    this.residents.set(ticketId, { agent: handle.agent, handle })
    try {
      const append = handle.agent.session.append as unknown as (type: string, data: unknown) => void
      append.call(handle.agent.session, 'agent-preset/selected', { agentPreset: EXECUTOR_PRESET })
    } catch {
      // The projection is a convenience for cold resume; the preset is mounted
      // explicitly by composeSetup either way.
    }
    return handle.agent
  }

  private composeSetup(ticketId: TicketId): (agentCtx: Context, agent: Agent) => Promise<void> {
    return async (agentCtx: Context): Promise<void> => {
      const selection = this.selectionRef()
      if (selection !== undefined) installModelSelection(agentCtx, selection)
      agentCtx.tools.presentAs('native')
      agentCtx.systemPrompt.section({ name: 'quno-worker-boundary', order: 5, text: WORKER_BOUNDARY })
      registerWorkerTools(agentCtx, {
        repo: this.deps.repo,
        engine: this.deps.engine,
        qunoId: this.deps.qunoId,
        now: this.deps.now,
        ...(this.deps.resolveExchangeResponder === undefined ? {} : { resolveExchangeResponder: this.deps.resolveExchangeResponder }),
        ...(this.deps.listOrgans === undefined ? {} : { listOrgans: this.deps.listOrgans }),
        ...(this.deps.cli === undefined ? {} : { cli: this.deps.cli }),
      }, { ticketId, executorSessionId: `quno-exec-${ticketId}` })
      const presets = this.deps.ctx.get('agentPresets') as unknown as PresetRegistryFace | undefined
      if (presets !== undefined) {
        try {
          await presets.mount(agentCtx, EXECUTOR_PRESET)
        } catch (error) {
          this.deps.logger.warn(`dsh-quno: worker preset could not be mounted: ${(error as Error).message}`)
        }
      }
    }
  }

  private selectionRef(): ModelSelectionRef | undefined {
    const selected = this.deps.modelSelection?.()
    if (selected === undefined || selected.provider === '' || selected.model === '') return undefined
    return {
      current: {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined || selected.reasoningEffort === ''
          ? {}
          : { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) }),
      },
      assembled: undefined,
    }
  }

  private agentOptions(): { provider: string; model: string; reasoningEffort?: ReturnType<typeof ReasoningEffortId>; maxTokens: number } | undefined {
    const selected = this.deps.modelSelection?.()
    if (selected === undefined || selected.provider === '' || selected.model === '') return undefined
    return {
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined || selected.reasoningEffort === ''
        ? {}
        : { reasoningEffort: ReasoningEffortId(selected.reasoningEffort) }),
      maxTokens: this.deps.maxTokens?.() ?? 8192,
    }
  }

  private async sessionExists(sessionId: SessionId): Promise<boolean> {
    const persistence = this.deps.ctx.get('sessionPersistence') as unknown as SessionPersistenceFace | undefined
    if (persistence === undefined) return false
    try {
      return await persistence.stat(sessionId) !== undefined
    } catch {
      return false
    }
  }
}

/** The bounded, read-only assignment prompt. */
export function buildAssignmentPrompt(
  ticket: { readonly id: string; readonly title: string; readonly goal: string },
  assignment: AssignmentRecord,
): string {
  return `你是 Quno 的只读执行 worker。用户看不到这条消息；结论通过结构化报告回流到永久主对话。

Ticket：${ticket.id}
标题：${ticket.title}
目标：
${ticket.goal}

工作目录：${assignment.directory === '' ? '（继承默认）' : assignment.directory}

要求：
- 只读执行：不要修改文件、发送外部消息或执行任何有外部副作用的操作。
- 先完成工作，再在本轮结束前调用一次 quno_worker_report 提交报告（state=ready/waiting/blocked/failed/dropped）。
- 需要用户回答才能继续时，用 state=waiting 或 blocked，并在 question.question 写出一个具体问题。
- 如果后续消息不属于本 Ticket 的范围，调用 quno_thread_handback 交回。`
}

/** Render one TicketInput for the executor prompt. */
export function renderInput(input: TicketInputRecord): string {
  const label = input.kind === 'trigger'
    ? '新的来源事件'
    : input.kind === 'policy'
      ? '策略变化（只影响后续判断，不代表新的工作）'
      : input.kind === 'response'
        ? '异步读取结果'
        : input.kind === 'note'
          ? 'Router 备注'
          : '补充输入'
  return `【${label}${input.human ? ' · 来自用户' : ''}】\n${input.text ?? '（无文本内容）'}`
}

function readEventTime(event: SessionEventLike, fallback: number): number {
  const top = (event as { time?: unknown }).time
  if (typeof top === 'number') return top
  const data = event.data as { at?: unknown; time?: unknown } | undefined
  if (typeof data?.at === 'number') return data.at
  if (typeof data?.time === 'number') return data.time
  return fallback
}

/** Export for tests: the input attempt row starts as `prepared`. */
export type { InputAttemptRecord }
