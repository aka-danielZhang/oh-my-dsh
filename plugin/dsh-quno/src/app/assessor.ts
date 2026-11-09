/**
 * The Router-side delivery layer: Eval candidates and Worker Reports enter the
 * ONE permanent conversation as program-owned relay messages.
 *
 * Nothing here decides domain state. The assessor renders a bounded candidate/
 * report, delivers it with a stable identity through the SessionTransport, and
 * records delivery evidence. The Router answers with tools, and the Engine
 * commits the decision.
 *
 * @module dsh-quno/app/assessor
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { EffectRetryError } from './effects.ts'
import { qunoMessageId, SessionTransport } from './transport.ts'
import type { Engine } from '../core/engine.ts'
import type { DomainRepository } from '../core/repository.ts'
import type { AssignmentRecord, TicketRecord, TriggerRecord } from '../core/model.ts'

/** Dependencies of the assessor. */
export interface AssessorDeps {
  readonly engine: Engine
  readonly repo: DomainRepository
  readonly transport: SessionTransport
  readonly resolveRouter: () => Promise<Agent | undefined>
  readonly logger: { warn(message: string): void }
  readonly now: () => number
  readonly maxCandidateChars?: number
}

/** Delivers Eval candidates and Report relays into the main conversation. */
export class Assessor {
  constructor(private readonly deps: AssessorDeps) {}

  /**
   * Deliver one Eval candidate. Idempotent on the Eval id: the transport's
   * stable message identity makes a retry a no-op once accepted.
   */
  async deliverEval(evalId: string, signal?: AbortSignal): Promise<boolean> {
    const evalRecord = this.deps.repo.getEval(evalId)
    if (evalRecord === undefined) return false
    if (evalRecord.status !== 'delivering' && evalRecord.status !== 'waiting-decision') return false
    const agent = await this.deps.resolveRouter()
    if (agent === undefined) throw new EffectRetryError('the permanent conversation cannot be resolved', 30_000)
    const view = this.deps.engine.candidateView(evalId)
    if (view === null) return false
    const text = renderCandidate(view.thread?.label ?? null, view.triggers, view.eval.id)
    const mode = agent.status === 'running' ? 'steer' : 'queue'
    await this.deps.transport.send(agent, {
      requestId: `eval:${evalRecord.id}`,
      text,
      mode,
      source: {
        kind: 'quno-eval',
        form: 'relay',
        summary: `评估 ${String(view.triggers.length)} 条来源事件`,
        evalId: evalRecord.id,
        threadId: evalRecord.threadId,
      },
    }, () => {})
    void signal
    this.deps.engine.candidateDelivered({
      evalId: evalRecord.id,
      messageId: qunoMessageId(`eval:${evalRecord.id}`),
      now: this.deps.now(),
    })
    return true
  }

  /**
   * Relay one Worker Report. The report is rendered deterministically; the
   * Router only decides how to tell the user.
   */
  async relayReport(ticketId: string, assignmentId: string | null, signal?: AbortSignal): Promise<boolean> {
    const ticket = this.deps.repo.getTicket(ticketId)
    if (ticket === undefined) return false
    const assignment = assignmentId === null
      ? this.deps.repo.listAssignmentsByTicket(ticket.id).at(-1)
      : this.deps.repo.getAssignment(assignmentId)
    if (assignment === undefined || assignment.report === null) return false
    const agent = await this.deps.resolveRouter()
    if (agent === undefined) throw new EffectRetryError('the permanent conversation cannot be resolved', 30_000)
    const text = renderReport(ticket, assignment)
    const mode = agent.status === 'running' ? 'steer' : 'queue'
    await this.deps.transport.send(agent, {
      requestId: `report:${assignment.id}:${String(assignment.report.at)}:${String(assignment.report.nonce ?? 0)}`,
      text,
      mode,
      source: {
        kind: 'quno-report',
        form: 'relay',
        summary: `任务报告：${ticket.title}`,
        ticketId: ticket.id,
        assignmentId: assignment.id,
      },
    }, () => {})
    void signal
    return true
  }

  /** Relay one Exchange response that was requested by the Router itself. */
  async relayExchange(exchangeId: string, signal?: AbortSignal): Promise<boolean> {
    const exchange = this.deps.repo.getExchange(exchangeId)
    if (exchange === undefined || exchange.status !== 'responded') return false
    const messages = this.deps.repo.getExchangeMessages(exchangeId)
    const response = messages.find(message => message.kind === 'response')
    if (response === undefined) return false
    const agent = await this.deps.resolveRouter()
    if (agent === undefined) throw new EffectRetryError('the permanent conversation cannot be resolved', 30_000)
    const text = `【Quno 异步读取结果】\n${boundedJson(response.payload)}`
    await this.deps.transport.send(agent, {
      requestId: `exchange:${exchange.id}`,
      text,
      mode: agent.status === 'running' ? 'steer' : 'queue',
      source: {
        kind: 'quno-report',
        form: 'relay',
        summary: '异步读取结果',
        ticketId: exchange.id,
        assignmentId: exchange.id,
      },
    }, () => {})
    void signal
    return true
  }
}

/** Render one bounded Eval candidate for the permanent conversation. */
export function renderCandidate(threadLabel: string | null, triggers: readonly TriggerRecord[], evalId: string): string {
  const lines: string[] = []
  lines.push('【Quno 评估候选】')
  lines.push(`Thread：${threadLabel ?? '（未命名来源线程）'}；本轮 ${String(triggers.length)} 条来源事件。`)
  for (const trigger of triggers.slice(0, 20)) {
    const when = trigger.occurredAt === null ? '' : ` · ${new Date(trigger.occurredAt).toISOString()}`
    const author = trigger.human ? (trigger.addressed === null ? '人类消息' : '人类点名') : '程序来源'
    lines.push(`- [${author}${when}] ${trigger.type}`)
    if (trigger.summary !== null) lines.push(`  ${clip(trigger.summary, 600)}`)
    const data = boundedData(trigger.data)
    if (data !== null) lines.push(`  结构化内容：${data}`)
    lines.push(`  triggerId=${trigger.id}`)
  }
  lines.push('')
  lines.push(`评估 id：${evalId}`)
  lines.push('请先调用 quno_eval 读取候选，再用 quno_eval_decide 提交 accept/ignore/stop/unavailable。accept 需要 title 与 goal；不要在没有明确价值时创建任务。')
  return lines.join('\n')
}

/** Render one Worker Report relay. */
export function renderReport(ticket: TicketRecord, assignment: AssignmentRecord): string {
  const report = assignment.report
  if (report === null) return `【Quno 任务报告】${ticket.title}`
  const stateLabel: Record<string, string> = {
    progress: '进行中',
    waiting: '等待输入',
    ready: '结果待验收',
    blocked: '受阻',
    failed: '失败',
    dropped: '无事可交付',
  }
  const lines: string[] = []
  lines.push(`【Quno 任务报告】${ticket.title}`)
  lines.push(`状态：${stateLabel[report.state] ?? report.state}${ticket.ended === null ? '' : '（Ticket 已结束）'}`)
  lines.push(report.summary)
  if (report.question !== undefined) lines.push(`需要用户回答：${report.question.question}`)
  if (report.artifacts.length > 0) {
    lines.push('产物：')
    for (const artifact of report.artifacts.slice(0, 10)) lines.push(`- [${artifact.kind}] ${artifact.label} — ${artifact.uri}`)
  }
  lines.push(`ticketId=${ticket.id}`)
  lines.push('请用自然语言向用户转述结果、影响和下一步；不要重新执行工作。')
  return lines.join('\n')
}

function boundedJson(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? '（空）' : clip(text, 4000)
  } catch {
    return '（无法序列化）'
  }
}

function boundedData(value: unknown): string | null {
  if (value === null || value === undefined) return null
  try {
    const text = JSON.stringify(value)
    return text === undefined ? null : clip(text, 1200)
  } catch {
    return null
  }
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
