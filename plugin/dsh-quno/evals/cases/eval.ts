/**
 * Eval/Decision-layer cases: eval-observe, auto-investigate, status-result.
 *
 * @module dsh-quno/evals/cases/eval
 */

import type { EvalCase } from '../case.ts'
import { textTurn, toolTurn } from '../models/scripted.ts'
import { check, replyContainsFact, replyMustNotClaim, toolCalls, MAIN_SESSION, sessionEvents, imMention, assistantTexts } from './support.ts'
import { writeFixtureFiles } from '../fixtures/fs.ts'
function executorSession(ticketId: string): string {
  return `quno-exec-${ticketId}`
}

export const evalCases: readonly EvalCase[] = [
  {
    id: 'eval-observe',
    title: 'observe 模式只记录 would_accept，不创建任务',
    priority: 'p0',
    requirement: '已授权来源的 inferred Trigger → Eval → decide accept 被降级：审计记录 would_accept；无 Ticket/Worker/通知',
    tags: ['eval', 'policy'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      // authorize the synthetic source; observe mode turns accepts into would_accept
      await rt.host.updateConfig({ patch: { acceptMode: 'observe', autoSourceIds: [rt.options.organSourceId] } })
    },
    steps: [
      // Scripts are queued before the ingest settles, or the eval turn races
      // the queue and exhausts it.
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval', {}, 'obs-eval-1') },
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval_decide', { kind: 'accept', title: '跟进 CI 结果', goal: '确认 CI 结果是否需要行动。' }, 'obs-decide-1') },
      { kind: 'script', role: 'router', build: () => textTurn('当前是观察模式：这条已记录为 would_accept，不会创建任务。') },
      { kind: 'ingest', envelopes: [{ eventKey: 'obs-bot-1', type: 'ci.pipeline.finished', subject: { key: 'obs-ci-1' }, summary: 'CI 流水线完成，可能需要关注' }] },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const evals = repo.listEvals(rt.host.qunoId, { limit: 10 })
      const decisions = repo.listDecisions(rt.host.qunoId, 10).map(decision => ({
        kind: decision.kind,
        audit: decision.audit as { wouldAccept?: boolean },
      }))
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      return {
        chain: [
          check('source.ingest', 'trigger-acked', true, 'accepted', 'see trace refs'),
          check('eval.candidate', 'candidate-delivered', evals.length === 1 && evals[0]?.status === 'decided', 'decided', evals.map(entry => entry.status)),
          check('eval.decision', 'downgraded-to-would-accept', decisions.length === 1 && decisions[0]?.audit?.wouldAccept === true, { kind: 'accept', wouldAccept: true }, decisions),
          check('ticket.mandate', 'no-ticket-created', tickets.length === 0, 0, tickets.length),
          check('notification.outbox', 'no-notification', rt.host.store.listNotices(rt.host.qunoId, 10).length === 0, 0, rt.host.store.listNotices(rt.host.qunoId, 10).map(notice => notice.status)),
        ],
        semantics: [
          replyContainsFact('mentions-observe', '观察模式', rt),
        ],
      }
    },
    budget: { maxDurationMs: 60_000, maxModelCalls: 6 },
  },
  {
    id: 'auto-investigate',
    title: '授权事件完整走完自动调查与通知',
    priority: 'p0',
    requirement: 'accept → Mandate → 只读 Worker → Report → Router relay → quno_notify → 通知 presented，一次完成，证据正确',
    tags: ['eval', 'worker', 'notification', 'e2e'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
      writeFixtureFiles(rt.fixtureDir, [
        { path: 'report.json', content: '{"state": "FAILED", "pipeline": "eval-pipeline", "failedStep": "deploy"}\n' },
      ])
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'ai-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '调查 CI 失败', goal: '读取 fixture 里的 report.json，给出失败原因摘要。' }, 'ai-decide-1'),
        textTurn('已受理，我来调查。'),
        toolTurn('quno_notify', {
          title: 'CI 失败已查明',
          summary: 'eval-pipeline 的 deploy 步骤失败',
          body: '调查完成：report.json 显示 eval-pipeline 的 deploy 步骤失败。',
          why: '授权的自动调查有了结果，值得告诉你。',
        }, 'ai-notify-1'),
        textTurn('调查完成，结果已经通过通知发给你。'),
        textTurn('「CI 失败已查明」：deploy 步骤失败，详见通知。'),
      ],
      worker: [
        toolTurn('read', { path: 'report.json' }, 'ai-worker-read-1'),
        toolTurn('quno_worker_report', { state: 'ready', summary: 'report.json：eval-pipeline 的 deploy 步骤失败（state FAILED）。' }, 'ai-worker-report-1'),
        textTurn('调查完成。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('ai-trigger-1', '@Quno 帮我调查一下 CI 为什么失败', Date.parse('2026-11-06T09:10:00Z'))] },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const ticket = tickets[0]
      const assignment = ticket === undefined ? undefined : repo.listAssignmentsByTicket(ticket.id).at(-1)
      const decisions = repo.listDecisions(rt.host.qunoId, 10)
      const notices = rt.host.store.listNotices(rt.host.qunoId, 10)
      const notifyCalls = toolCalls(rt, MAIN_SESSION).filter(call => call.name === 'quno_notify')
      const noticeMessage = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .some(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-notify')
      const presentedReply = notices.every(notice => notice.status === 'presented')
      return {
        chain: [
          check('eval.decision', 'accept-committed', decisions[0]?.kind === 'accept', 'accept', decisions.map(decision => decision.kind)),
          check('ticket.mandate', 'mandate-strength-explicit', ticket?.mandate?.strength === 'explicit', 'explicit', ticket?.mandate?.strength ?? 'none'),
          check('assignment.launch', 'worker-launched-once', repo.listAssignmentsByTicket(ticket?.id ?? '').length === 1, 1, repo.listAssignmentsByTicket(ticket?.id ?? '').length),
          check('worker.execution', 'worker-read-fixture', ticket !== undefined && toolCalls(rt, executorSession(ticket.id)).some(call => call.name === 'read'), ['read'], ticket === undefined ? [] : toolCalls(rt, executorSession(ticket.id)).map(call => call.name)),
          check('worker.report', 'report-ready-with-fact', (assignment?.report?.summary ?? '').includes('deploy'), 'deploy', assignment?.report?.summary ?? ''),
          check('router.relay', 'relay-happened', notifyCalls.length === 1, 1, notifyCalls.length),
          check('notification.outbox', 'notice-durable', noticeMessage, 'quno-notify message in main log', noticeMessage),
          check('notification.presented', 'notice-presented-once', notices.length === 1 && presentedReply, 'presented', notices.map(notice => notice.status)),
        ],
        semantics: [
          replyContainsFact('fact-pipeline', 'deploy', rt),
          replyMustNotClaim('no-unverified-cause', '原因是代码回滚', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 14 },
  },
  {
    id: 'status-result',
    title: '追问进度/结果读取持久 Ticket，不重复轮询',
    priority: 'p0',
    requirement: 'direct-read 完成后，status/result 查询读取持久记录：quno_task 调用一次，回复包含持久结果，不进入子会话',
    tags: ['conversation', 'persistence'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      writeFixtureFiles(rt.fixtureDir, [
        { path: 'notes.md', content: '截止日期：2026-11-20\n负责人：张伟\n' },
      ])
    },
    steps: [
      { kind: 'script', role: 'router', build: () => toolTurn('quno_task', { title: '读取 notes.md', prompt: '读取 notes.md 并报告截止日期与负责人。' }, 'sr-delegate-1') },
      { kind: 'script', role: 'router', build: () => textTurn('好，我来读取这份文件，整理好后告诉你。') },
      { kind: 'script', role: 'worker', build: () => toolTurn('read', { path: 'notes.md' }, 'sr-worker-read-1') },
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_worker_report', { state: 'ready', summary: 'notes.md：截止日期 2026-11-20，负责人张伟。' }, 'sr-worker-report-1') },
      { kind: 'script', role: 'worker', build: () => textTurn('已完成。') },
      { kind: 'script', role: 'router', build: () => textTurn('读好了：截止日期 2026-11-20，负责人是张伟。') },
      { kind: 'human', text: '帮我读一下 notes.md，告诉我截止日期和负责人。' },
      { kind: 'script', role: 'router', build: (_rt, drv) => toolTurn('quno_task', { action: 'status', taskId: drv.activeTicketId ?? '' }, 'sr-status-1') },
      { kind: 'script', role: 'router', build: () => textTurn('任务已完成，结果已经回流。') },
      { kind: 'human', text: '那个任务现在什么状态？' },
      { kind: 'script', role: 'router', build: (_rt, drv) => toolTurn('quno_task', { action: 'result', taskId: drv.activeTicketId ?? '' }, 'sr-result-1') },
      { kind: 'script', role: 'router', build: () => textTurn('持久记录里的结果是：截止日期 2026-11-20，负责人张伟。') },
      { kind: 'human', text: '结果给我一下。' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const ticket = tickets[0]
      const calls = toolCalls(rt, MAIN_SESSION)
      const qunoTaskCalls = calls.filter(call => call.name === 'quno_task')
      const statusCall = qunoTaskCalls.find(call => (call.args as { action?: string })?.action === 'status')
      const resultCall = qunoTaskCalls.find(call => (call.args as { action?: string })?.action === 'result')
      const texts = assistantTexts(rt, MAIN_SESSION)
      const finalText = texts.at(-1) ?? ''
      const readCallsAfterResult = ticket === undefined ? 0 : toolCalls(rt, executorSession(ticket.id)).filter(call => call.name === 'read').length
      return {
        chain: [
          check('ticket.mandate', 'one-ticket', tickets.length === 1, 1, tickets.length),
          check('input.delivery', 'status-reads-durable-record', statusCall !== undefined && (statusCall.args as { taskId?: string })?.taskId === ticket?.id, ticket?.id ?? '', statusCall?.args ?? {}),
          check('input.delivery', 'result-reads-durable-record', resultCall !== undefined && (resultCall.args as { taskId?: string })?.taskId === ticket?.id, ticket?.id ?? '', resultCall?.args ?? {}),
          check('worker.report', 'no-re-execution', readCallsAfterResult === 1, 1, readCallsAfterResult),
          check('router.relay', 'answer-from-persistent-record', finalText.includes('2026-11-20'), '2026-11-20', finalText.slice(0, 200)),
        ],
        semantics: [
          replyContainsFact('fact-result', '2026-11-20', rt),
          replyMustNotClaim('no-polling-claim', '正在重新读取文件', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 12 },
  },
]
