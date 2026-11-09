/**
 * The Worker tool surface: what a read-only executor session may say back to
 * the domain.
 *
 * These tools are registered on the agent scope, so they exist only for one
 * executor session and never leak into the permanent conversation. Every tool
 * resolves its Ticket from the session identity (`quno-exec-<ticketId>`), then
 * the current Assignment from the durable store: the model cannot name another
 * Ticket by argument, and a Report after the Ticket ended is refused.
 *
 * @module dsh-quno/app/worker-tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { QunoStateError } from '../core/model.ts'
import type {
  ReportState,
  TaskArtifact,
  TicketId,
  WorkerReport,
} from '../core/model.ts'
import type { Engine } from '../core/engine.ts'
import type { DomainRepository } from '../core/repository.ts'
import type { CollectorEndpointView } from '../types.ts'

/** Names a worker session may call (also allowed by the preset guard). */
export const WORKER_TOOL_NAMES: readonly string[] = [
  'quno_worker_report',
  'quno_thread_handback',
  'quno_thread_follow',
  'quno_thread_unrelated',
  'quno_read',
  'quno_recall',
  'quno_exchange',
]

/** Per-agent worker identity. */
export interface WorkerIdentity {
  readonly ticketId: TicketId
  readonly executorSessionId: string
}

/** Resolve the Ticket owned by one executor session id. */
export function ticketIdFromExecutorSession(sessionId: string): TicketId | null {
  return sessionId.startsWith('quno-exec-') ? sessionId.slice('quno-exec-'.length) : null
}

/** Dependencies of the worker tools. */
export interface WorkerToolDeps {
  readonly repo: DomainRepository
  readonly engine: Engine
  readonly qunoId: string
  readonly now: () => number
  /** Resolve one organ endpoint for a bounded asynchronous read. */
  readonly resolveExchangeResponder?: (endpoint: string, kind: 'request' | 'command') => boolean
  /** The exchange-facing endpoints for `quno_read.collectors` and refusal directories. */
  readonly listCollectors?: () => readonly CollectorEndpointView[]
}

/** Prompt section that teaches the report protocol. */
export const WORKER_BOUNDARY = `# You are a Quno worker

You execute one delegated, read-only assignment. The user does not see this
session; the permanent conversation receives your structured Report.

- Do not modify files, send external messages, place orders, or perform any
  outward action. If the work needs a write, report \`blocked\` and say what you
  would do.
- When the assignment is finished, call \`quno_worker_report\` exactly once with
  a \`ready\` state and a short, evidence-based summary. If there is nothing
  worth delivering, report \`dropped\`.
- If information the goal REQUIRES is missing from the materials, do NOT report
  ready with a "missing" annotation — report \`waiting\` (or \`blocked\`) and put
  one concrete question in \`question.question\`. The user's answer will be
  routed back to you in this same session to continue the task.
- A follow-up message on a Thread owned by this Ticket is yours to judge. If it
  is out of scope, call \`quno_thread_handback\` so it can be re-evaluated.
- Never invent ids, artifacts, or progress. Only report what you actually did.`

/** Register the worker surface on one executor agent's scope. */
export function registerWorkerTools(ctx: Context, deps: WorkerToolDeps, identity: WorkerIdentity): void {
  const resolveAssignment = () => {
    const assignment = deps.repo.findActiveAssignment(identity.ticketId)
    if (assignment === undefined) throw new QunoStateError('no-assignment', 'this worker session has no active Assignment')
    const ticket = deps.repo.getTicket(identity.ticketId)
    if (ticket === undefined) throw new QunoStateError('unknown-ticket', 'this worker session has no Ticket')
    if (ticket.ended !== null) throw new QunoStateError('ticket-ended', 'this Ticket has already ended; worker actions are closed')
    return { assignment, ticket }
  }

  ctx.tools.register(defineTool({
    name: 'quno_worker_report',
    description: '提交本轮委派工作的结构化报告。完成、等待输入、阻塞、失败或无事可做时都必须调用一次。',
    parameters: {
      state: { type: 'string', enum: ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'], required: true, description: '报告状态' },
      summary: { type: 'string', required: true, description: '结论与依据的精简摘要（不要贴原始 JSON）' },
      artifacts: {
        type: 'array',
        description: '可打开的产物（文件/目录/链接/笔记）；没有就不传',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            label: { type: 'string', required: true },
            uri: { type: 'string', required: true },
          },
        },
      },
      question: {
        type: 'object',
        description: '需要用户回答的具体问题时提供',
        additionalProperties: false,
        properties: {
          question: { type: 'string', required: true },
          triggerId: { type: 'string' },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          ticketId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const { assignment, ticket } = resolveAssignment()
      const state = String(args.state) as ReportState
      const artifacts = readArtifacts(args.artifacts)
      const question = readQuestion(args.question)
      const report: WorkerReport = {
        state,
        summary: String(args.summary).slice(0, 8000),
        at: deps.now(),
        artifacts,
        ...(question === undefined ? {} : { question }),
      }
      // Tool-layer constraint: a waiting/blocked report without a concrete
      // question leaves the user nothing to answer — the ask-path is the
      // designed resume mechanism (found by live-worker-blocked: the model
      // self-completed with a "missing" annotation instead of asking).
      if ((state === 'waiting' || state === 'blocked') && question === undefined) {
        throw new QunoStateError('question-required', 'waiting/blocked 报告必须携带 question.question（要让用户回答的具体问题）；若确实无法提问，请改用 ready 并在 summary 中逐字标注缺失字段')
      }
      const outcome = deps.engine.report({ assignmentId: assignment.id, report, now: deps.now() })
      return {
        accepted: true,
        ticketId: ticket.id,
        state: outcome.ticket.ended === null ? state : 'ended',
        message: outcome.ended
          ? `已提交报告，Ticket「${ticket.title}」已结束。`
          : `已提交报告（${state}），Ticket「${ticket.title}」保持打开。`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'quno_thread_handback',
    description: '把一条超出本 Ticket 范围的人类消息交回 Quno 重新判断。同一条消息每个 Ticket 只能交回一次。',
    parameters: {
      triggerId: { type: 'string', required: true, description: '要交回的 Trigger id' },
      reason: { type: 'string', description: '为什么不属于本 Ticket' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          handedBack: { type: 'boolean', required: true },
          returnedToEval: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const { assignment, ticket } = resolveAssignment()
      const outcome = deps.engine.handback({
        ticketId: ticket.id,
        triggerId: String(args.triggerId),
        assignmentId: assignment.id,
        reason: args.reason === undefined ? null : String(args.reason),
        now: deps.now(),
      })
      return {
        handedBack: outcome.handedBack,
        returnedToEval: outcome.returnedToEval,
        message: outcome.handedBack
          ? outcome.returnedToEval
            ? '已交回 Quno 重新判断。'
            : '已交回；仍有其他 Ticket 负责这条消息。'
          : '这条消息已经交回过，不会重复处理。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'quno_thread_follow',
    description: '为本 Ticket 增加一个只读的 context Thread 订阅；只提供输入，不扩大授权。',
    parameters: {
      threadIds: { type: 'array', items: { type: 'string' }, required: true, description: '要跟随的 Thread id（从 quno_read 获得）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attached: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const { ticket } = resolveAssignment()
      const ids = readStringArray(args.threadIds)
      const subscriptions = deps.engine.followForContext({ ticketId: ticket.id, threadIds: ids, now: deps.now() })
      return {
        attached: subscriptions.map(subscription => subscription.threadId),
        message: `已跟随 ${String(subscriptions.length)} 个 Thread。`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'quno_thread_unrelated',
    description: '退订一个由本 Worker 自己添加的 context Thread。',
    parameters: {
      subscriptionId: { type: 'string', required: true, description: '订阅 id（从 quno_read 获得）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { removed: { type: 'boolean', required: true }, message: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const removed = deps.engine.markUnrelated({ subscriptionId: String(args.subscriptionId), now: deps.now() })
      return {
        removed,
        message: removed ? '已退订该 Thread。' : '没有找到可退订的订阅。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'quno_read',
    description: '读取本 Ticket 的对象图：Ticket、Assignment、订阅、最近 Trigger 摘要（只读、有界）。',
    parameters: {
      triggerId: { type: 'string', description: '读取某条授权 Trigger 的摘要与引用' },
      limit: { type: 'integer', description: '最近 Trigger 条数（1-20）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ticket: { type: 'json', required: true },
          assignment: { type: 'json' },
          subscriptions: { type: 'array', items: { type: 'json' }, required: true },
          triggers: { type: 'array', items: { type: 'json' }, required: true },
          collectors: { type: 'array', items: { type: 'json' }, required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const { assignment, ticket } = resolveAssignment()
      const subscriptions = deps.repo.listSubscriptionsByTicket(ticket.id)
      const threadIds = new Set(subscriptions.map(subscription => subscription.threadId))
      const recent = deps.repo.listThreads(deps.qunoId, { limit: 50 })
        .filter(thread => threadIds.has(thread.id))
        .flatMap(thread => deps.repo.listTriggerIdsByThread(thread.id, 20))
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 5)))
      const triggers = deps.repo.getTriggers([...new Set(recent)].slice(-limit)).map(renderTrigger)
      const explicit = args.triggerId === undefined ? undefined : deps.repo.getTrigger(String(args.triggerId))
      if (explicit !== undefined) {
        const authorized = explicit.threads.some((ref) => {
          const thread = deps.repo.getThreadByKey(deps.qunoId, ref.source, ref.id)
          return thread !== undefined && threadIds.has(thread.id)
        })
        if (authorized) triggers.push(renderTrigger(explicit))
      }
      return {
        ticket: {
          id: ticket.id,
          title: ticket.title,
          goal: ticket.goal,
          mode: ticket.mode,
          question: ticket.question,
          channels: ticket.channels,
        } as unknown as JsonValue,
        ...(assignment === undefined ? {} : { assignment: { id: assignment.id, state: assignment.state } as unknown as JsonValue }),
        subscriptions: subscriptions.map(subscription => ({
          id: subscription.id,
          threadId: subscription.threadId,
          mode: subscription.mode,
          origin: subscription.origin,
        })) as unknown as JsonValue[],
        triggers: triggers as unknown as JsonValue[],
        collectors: (deps.listCollectors?.() ?? []) as unknown as JsonValue[],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'quno_exchange',
    description: '向一个已注册的 Source/Organ 发起受限异步读取。立即返回 requestId，结果稍后成为本 Ticket 的输入。端点从 quno_read 的 collectors 列表获取，不要猜端点名。',
    parameters: {
      responder: { type: 'string', required: true, description: '目标 organ 端点（collector:<instanceId>，来自 quno_read 的 collectors 列表）' },
      kind: { type: 'string', enum: ['request', 'command'], description: '显式请求或受限命令，默认 request' },
      payload: { type: 'json', description: '请求负载（只能是读取）', required: true },
      timeoutMs: { type: 'integer', description: '超时毫秒（1000-600000，默认 60000）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          requestId: { type: 'string', required: true },
          deadline: { type: 'integer', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      const { ticket } = resolveAssignment()
      const responder = String(args.responder)
      const kind = args.kind === 'command' ? 'command' : 'request'
      if (deps.resolveExchangeResponder !== undefined && !deps.resolveExchangeResponder(responder, kind)) {
        const collectors = deps.listCollectors?.() ?? []
        const directory = collectors.length === 0
          ? 'no organ endpoints are available right now (quno_read.collectors is empty)'
          : `available: ${collectors.map(organ => `${organ.endpoint} (${organ.label})`).join(', ')}`
        throw new QunoStateError('unknown-responder', `no mounted Organ answers ${responder}; ${directory}. Discover endpoints via quno_read.collectors — never guess one.`)
      }
      const exchange = deps.engine.requestExchange({
        kind,
        requester: `ticket:${ticket.id}`,
        responder,
        payload: args.payload,
        deadlineMs: Math.min(600_000, Math.max(1000, Number(args.timeoutMs ?? 60_000))),
        ticketId: ticket.id,
        now: deps.now(),
      })
      return {
        requestId: exchange.id,
        deadline: exchange.deadline,
        message: `已发起读取请求 ${exchange.id}，结果返回后会作为本 Ticket 的输入。`,
      }
    },
  }))
}

function renderTrigger(trigger: import('../core/model.ts').TriggerRecord): Record<string, unknown> {
  return {
    id: trigger.id,
    type: trigger.type,
    human: trigger.human,
    summary: trigger.summary,
    occurredAt: trigger.occurredAt,
    contentRef: trigger.contentRef,
    threads: trigger.threads,
  }
}

function readArtifacts(value: unknown): readonly TaskArtifact[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const record = entry as Record<string, unknown>
    const kind = record['kind']
    if (kind !== 'file' && kind !== 'directory' && kind !== 'url' && kind !== 'note') return []
    const label = typeof record['label'] === 'string' ? record['label'] : ''
    const uri = typeof record['uri'] === 'string' ? record['uri'] : ''
    if (label === '' || uri === '') return []
    return [{ kind: kind as TaskArtifact['kind'], label: label.slice(0, 200), uri: uri.slice(0, 2000) }]
  }).slice(0, 20)
}

function readQuestion(value: unknown): WorkerReport['question'] | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const question = typeof record['question'] === 'string' ? record['question'].trim() : ''
  if (question === '') return undefined
  return {
    question: question.slice(0, 2000),
    ...(typeof record['triggerId'] === 'string' ? { triggerId: record['triggerId'] } : {}),
  }
}

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
}
