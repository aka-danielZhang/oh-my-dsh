/**
 * Recovery cases: worker-restart — crash between "input delivered" and
 * "input read", then restart and prove no loss, no duplication, no double
 * worker and exactly one final presentation.
 *
 * @module dsh-quno/evals/cases/recovery
 */

import type { EvalCase } from '../case.ts'
import { textTurn, toolTurn } from '../models/scripted.ts'
import { check, replyContainsFact, toolCalls, sessionEvents, imMention, MAIN_SESSION } from './support.ts'

export const recoveryCases: readonly EvalCase[] = [
  {
    id: 'worker-restart',
    title: '交付 Effect 挂起时崩溃，重启恢复不丢、不重、不双跑',
    priority: 'p0',
    requirement: 'follow-up 输入已入库、交付 Effect 未执行时 crash → restart：输入恰好投递一次、无第二 Worker 并发、结果只展示一次',
    tags: ['recovery', 'crash', 'e2e'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'wr-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '跟进客户请求', goal: '基于授权 Trigger 完成客户请求。' }, 'wr-decide-1'),
        textTurn('已受理，后台开始处理。'),
        textTurn('第一批处理完成，任务继续。'),
        toolTurn('quno_notify', { title: '客户请求已处理', summary: '客户请求处理完成', body: '客户请求处理完成：报告已生成。', why: '后台工作有了结果。' }, 'wr-notify-1'),
        textTurn('结果稍后通知你。'),
        textTurn('客户请求已处理完成，结果已通知。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'progress', summary: '已读取第一批内容，继续处理。' }, 'wr-worker-progress-1'),
        textTurn('第一批完成。'),
        // After the restart the SAME worker script continues: the wake note
        // points at the unread input; the final report is submitted once.
        toolTurn('quno_worker_report', { state: 'ready', summary: '客户请求处理完成：报告已生成。' }, 'wr-worker-ready-1'),
        textTurn('已提交最终报告。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('wr-trigger-1', '@Quno 帮我跟进这个客户请求', Date.parse('2026-11-06T09:20:00Z'))] },
      // Crash window: the follow-up is durably enqueued (ingest transaction)
      // but its delivery Effect never ran — the crash must not lose it.
      { kind: 'ingest', envelopes: [imMention('wr-trigger-2', '补充：客户改了联系方式', Date.parse('2026-11-06T09:22:00Z'))], settle: false },
      { kind: 'crash' },
      { kind: 'restart' },
      // The restart replays the pending delivery Effect; the worker completes
      // under the same Mandate and the result is presented exactly once.
      { kind: 'waitFor', description: 'ticket ended with a ready report', until: (rt) => {
        const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
        return ticket !== undefined && ticket.ended !== null && ticket.ended.outcome === 'completed'
      }, deadlineMs: 90_000 },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const ticket = tickets.at(-1)
      const assignments = ticket === undefined ? [] : repo.listAssignmentsByTicket(ticket.id)
      const runs = ticket === undefined ? [] : assignments.flatMap(assignment => repo.listWorkerRunsByAssignment(assignment.id))
      const inputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 })
      const input = inputs[0]
      const attempts = input === undefined ? [] : [1, 2, 3].map(n => repo.findInputAttempt(input.id, n)).filter(Boolean)
      const executorSessions = [...new Set(assignments.map(assignment => assignment.executorSessionId))]
      const notifyMessages = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-notify')
      const reportCalls = executorSessions.flatMap(sessionId => toolCalls(rt, sessionId)).filter(call => call.name === 'quno_worker_report')
      return {
        chain: [
          check('recovery.restart', 'restart-happened', rt.options.restarts.length >= 1, '>=1 restart', rt.options.restarts.length),          check('ticket.mandate', 'one-ticket', tickets.length === 1, 1, tickets.length),
          check('assignment.launch', 're-armed-not-duplicated', assignments.length === 1, 1, assignments.length),
          check('recovery.restart', 'one-worker-run-at-a-time', runs.every(run => run.status === 'ended' || run.status === 'failed'), 'all runs closed', runs.map(run => run.status)),
          check('input.delivery', 'input-not-lost', input?.deliveredAt !== null && input?.acknowledgedAt !== null, 'delivered+acknowledged', input === undefined ? 'none' : { deliveredAt: input.deliveredAt, acknowledgedAt: input.acknowledgedAt }),
          check('input.delivery', 'input-not-duplicated', attempts.length === 1, 1, attempts.map(attempt => ({ attempt: (attempt as { attempt?: number }).attempt, status: (attempt as { status?: string }).status }))),
          check('worker.report', 'single-final-report', reportCalls.filter(call => (call.args as { state?: string })?.state === 'ready').length === 1, 1, reportCalls.map(call => (call.args as { state?: string })?.state)),
          check('notification.presented', 'presented-exactly-once', notifyMessages.length === 1, 1, notifyMessages.length),
          check('notification.presented', 'no-state-regression', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
        ],
        semantics: [
          replyContainsFact('fact-result', '已通知', rt),
        ],
      }
    },
    budget: { maxDurationMs: 180_000, maxModelCalls: 14 },
  },
]
