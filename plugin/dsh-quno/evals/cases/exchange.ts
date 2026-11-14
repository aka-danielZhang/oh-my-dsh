/**
 * Source/Worker interaction cases (first P1 batch): irrelevant-ignore,
 * explicit-source-accept, worker-blocked-answer, worker-handback,
 * worker-stop-late, policy-change, exchange-roundtrip,
 * third-party-tool-unavailable, memory-isolation.
 *
 * @module dsh-quno/evals/cases/exchange
 */

import type { EvalCase } from '../case.ts'
import { textTurn, toolTurn } from '../models/scripted.ts'
import { check, replyContainsFact, toolCalls, toolResults, sessionEvents, imMention, MAIN_SESSION } from './support.ts'

function executorSession(ticketId: string): string {
  return `quno-exec-${ticketId}`
}

export const exchangeCases: readonly EvalCase[] = [
  {
    id: 'irrelevant-ignore',
    title: '无关消息只 ignore，无 Ticket、无通知',
    priority: 'p1',
    requirement: 'inferred 无关事件被 ignore：无 Ticket、无 Assignment、无通知',
    tags: ['eval', 'policy'],
    model: { router: 'scripted', worker: 'scripted' },
    steps: [
      { kind: 'ingest', envelopes: [{ eventKey: 'ii-bot-1', type: 'ci.pipeline.finished', subject: { key: 'ii-ci' }, summary: '例行的 CI 通过通知' }] },
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval', {}, 'ii-eval-1') },
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval_decide', { kind: 'ignore', reason: '例行通知，无需行动' }, 'ii-decide-1') },
      { kind: 'script', role: 'router', build: () => textTurn('例行通知，已忽略。') },
    ],
    checks: (rt) => {
      const tickets = rt.host.repo.listTickets(rt.host.qunoId, { limit: 10 })
      const decisions = rt.host.repo.listDecisions(rt.host.qunoId, 10)
      return {
        chain: [
          check('eval.decision', 'ignore-committed', decisions.at(-1)?.kind === 'ignore', 'ignore', decisions.map(decision => decision.kind)),
          check('ticket.mandate', 'no-ticket', tickets.length === 0, 0, tickets.length),
          check('notification.outbox', 'no-notification', rt.host.store.listNotices(rt.host.qunoId, 10).length === 0, 0, rt.host.store.listNotices(rt.host.qunoId, 10).length),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 60_000, maxModelCalls: 6 },
  },
  {
    id: 'explicit-source-accept',
    title: 'Source 中人类点名直接接单',
    priority: 'p1',
    requirement: 'explicit 强度（human+addressed）的 Trigger 在 acceptMode auto 下直接 accept，Mandate 记录 explicit',
    tags: ['eval', 'mandate'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'es-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '处理点名请求', goal: '完成点名请求并汇报。' }, 'es-decide-1'),
        textTurn('已受理。'),
        textTurn('点名请求已处理完成。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'ready', summary: '点名请求处理完成。' }, 'es-worker-report-1'),
        textTurn('已提交。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('es-trigger-1', '@Quno 请处理这个请求', Date.parse('2026-11-06T09:25:00Z'))] },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      return {
        chain: [
          check('eval.candidate', 'strength-explicit', rt.host.repo.listEvals(rt.host.qunoId, { limit: 5 }).at(-1)?.strength === 'explicit', 'explicit', rt.host.repo.listEvals(rt.host.qunoId, { limit: 5 }).map(entry => entry.strength)),
          check('ticket.mandate', 'mandate-explicit', ticket?.mandate?.strength === 'explicit', 'explicit', ticket?.mandate?.strength ?? 'none'),
          check('worker.report', 'completed', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 90_000, maxModelCalls: 8 },
  },
  {
    id: 'worker-blocked-answer',
    title: 'blocked 提问 → 用户回答 → 同 Mandate 恢复 → ready',
    priority: 'p1',
    requirement: 'worker waiting/blocked 提问后，人类回答经 note 进入同一 Executor 会话，同 Mandate 恢复并 ready',
    tags: ['worker', 'exchange'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'wb-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '整理周报', goal: '整理周报；缺少信息时提问。' }, 'wb-decide-1'),
        textTurn('已受理。'),
        textTurn('周报正在整理，需要你确认使用哪个账号。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'blocked', summary: '缺少账号信息。', question: { question: '用哪个账号？' } }, 'wb-worker-blocked-1'),
        textTurn('已提问。'),
        // After the note arrives, the SAME session resumes and reports ready.
        toolTurn('quno_worker_report', { state: 'ready', summary: '已用账号 B 完成周报整理。' }, 'wb-worker-ready-1'),
        textTurn('已提交。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('wb-trigger-1', '@Quno 整理本周周报', Date.parse('2026-11-06T09:30:00Z'))] },
      { kind: 'waitFor', description: 'ticket question recorded', until: (rt) => rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)?.question !== undefined && rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)?.question !== null, deadlineMs: 30_000 },
      // The answer routes through quno_task note with the REAL ticket id; all
      // three turns (note, ack, final relay) queue BEFORE the human settles.
      { kind: 'script', role: 'router', build: (_rt, drv) => toolTurn('quno_task', { action: 'note', taskId: drv.activeTicketId ?? '', note: '用账号 B。' }, 'wb-note-1') },
      { kind: 'script', role: 'router', build: () => textTurn('已把你的回答转给这个任务。') },
      { kind: 'script', role: 'router', build: () => textTurn('周报整理完成：已用账号 B 完成。') },
      { kind: 'human', text: '用账号 B。' },
      { kind: 'settle' },
    ],
    checks: (rt, drv) => {
      void drv
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const assignments = ticket === undefined ? [] : repo.listAssignmentsByTicket(ticket.id)
      const noteInputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 }).filter(input => input.kind === 'note')
      // The blocked report's own tool call is the durable question evidence
      // (the later ready report clears ticket.question by design).
      const blockedCall = ticket === undefined ? [] : toolCalls(rt, executorSession(ticket.id)).filter(call => call.name === 'quno_worker_report' && (call.args as { state?: string })?.state === 'blocked')
      const questionArg = (blockedCall[0]?.args as { question?: { question?: string } } | undefined)?.question?.question
      return {
        chain: [
          check('worker.report', 'blocked-question-recorded', questionArg === '用哪个账号？', '用哪个账号？', questionArg ?? 'none'),
          check('ticket.mandate', 'same-mandate-resumed', assignments.length === 1, 1, assignments.length),
          check('input.delivery', 'note-delivered', noteInputs.length === 1 && noteInputs[0]?.deliveredAt !== null, 1, noteInputs.map(input => ({ kind: input.kind, deliveredAt: input.deliveredAt }))),
          check('worker.report', 'ready-after-answer', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
          check('worker.report', 'question-cleared-after-answer', ticket?.ended !== null, 'ended ticket has no open question', ticket?.question ?? null),
        ],
        semantics: [
          replyContainsFact('fact-account', '账号 B', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 12 },
  },
  {
    id: 'worker-handback',
    title: '超范围 follow-up 交回，重新 Eval',
    priority: 'p1',
    requirement: 'owned Thread 上的超范围消息被 quno_thread_handback 交回：原 Ticket 不变，Trigger 回到 primary Thread 重新 Eval',
    tags: ['worker', 'subscription'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'wh-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '整理需求', goal: '整理客户需求。' }, 'wh-decide-1'),
        textTurn('已受理，我来整理。'),
        // NOTE: the progress report no longer relays (design §8.5).
        toolTurn('quno_eval', {}, 'wh-eval-2'),
        toolTurn('quno_eval_decide', { kind: 'ignore', reason: '超范围消息，交回后判断为无关' }, 'wh-decide-2'),
        textTurn('交回的消息重新判断过，与本任务无关，已忽略。'),
      ],
      worker: [
        // Keep the ticket OPEN (progress): the follow-up must reach the same
        // ticket as a live follow-up input, not the ended-ticket resume path.
        toolTurn('quno_worker_report', { state: 'progress', summary: '需求初稿整理完成，继续跟进。' }, 'wh-worker-progress-1'),
        textTurn('初稿已提交。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('wh-trigger-1', '@Quno 整理需求', Date.parse('2026-11-06T09:35:00Z'))] },
      // The follow-up must not settle yet: the handback script needs the input
      // row (created in the ingest transaction) to exist when it is BUILT,
      // and must be QUEUED before the settle that wakes the worker.
      { kind: 'ingest', envelopes: [imMention('wh-trigger-2', '@Quno 顺便帮我把服务器重启一下', Date.parse('2026-11-06T09:37:00Z'))], settle: false },
      { kind: 'script', role: 'worker', build: (rtv) => {
        const ticket = rtv.host.repo.listTickets(rtv.host.qunoId, { limit: 5 }).at(-1)
        const inputs = ticket === undefined ? [] : rtv.host.repo.listInputsByTicket(ticket.id, { limit: 10 }).filter(input => input.kind === 'trigger')
        const triggerId = inputs.at(-1)?.triggerId ?? ''
        return toolTurn('quno_thread_handback', { triggerId, reason: '重启服务器超出本任务范围' }, 'wh-handback-1')
      } },
      { kind: 'script', role: 'worker', build: () => textTurn('已交回。') },
      { kind: 'settle' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const evals = repo.listEvals(rt.host.qunoId, { limit: 10 })
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      return {
        chain: [
          check('ticket.mandate', 'original-ticket-unchanged', tickets.length === 1 && tickets[0]?.ended === null, 'one open ticket', tickets.map(entry => ({ ended: entry.ended?.outcome ?? 'open' }))),
          check('input.delivery', 'handback-created-second-eval', evals.length === 2, 2, evals.map(entry => entry.status)),
          check('eval.decision', 'second-eval-decided', repo.listDecisions(rt.host.qunoId, 10).length === 2, 2, repo.listDecisions(rt.host.qunoId, 10).map(decision => decision.kind)),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 14 },
  },
  {
    id: 'worker-stop-late',
    title: '人类 stop 后晚到结果不改状态、不通知',
    priority: 'p1',
    requirement: 'stopTicket 之后到达的 Worker 结束不改变 Ticket 状态，也不产生通知',
    tags: ['worker', 'stop'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', quietHours: null } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'wl-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '调查任务', goal: '调查并汇报。' }, 'wl-decide-1'),
        textTurn('已受理。'),
        textTurn('任务已按你的要求停止。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'progress', summary: '调查进行中。' }, 'wl-worker-progress-1'),
        textTurn('继续调查中。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('wl-trigger-1', '@Quno 调查这个', Date.parse('2026-11-06T09:40:00Z'))] },
      { kind: 'waitFor', description: 'assignment launched', until: (rt) => {
        const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
        return ticket !== undefined && rt.host.repo.findActiveAssignment(ticket.id) !== undefined
      }, deadlineMs: 30_000 },
      { kind: 'stopTicket', ticketIdRef: 'active' },
      // The worker "finishes" after the stop: the engine must refuse it.
      { kind: 'lateReport', state: 'ready', summary: '调查完成（晚到）。' },
    ],
    checks: (rt, drv) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      return {
        chain: [
          check('ticket.mandate', 'stopped-by-human', ticket?.ended?.by === 'human' && ticket?.ended?.outcome === 'stopped', 'stopped/human', ticket?.ended ?? {}),
          check('worker.report', 'late-report-refused', drv.lastLateReport?.refused === true && (drv.lastLateReport.error ?? '').includes('ended'), 'ticket-ended refusal', drv.lastLateReport),
          check('ticket.mandate', 'state-not-regressed', ticket?.ended?.outcome === 'stopped', 'still stopped', ticket?.ended?.outcome ?? 'open'),
          check('worker.report', 'no-report-recorded', repo.listAssignmentsByTicket(ticket?.id ?? '').at(-1)?.report?.state !== 'ready', 'no ready report', repo.listAssignmentsByTicket(ticket?.id ?? '').at(-1)?.report?.state ?? 'none'),
          check('notification.presented', 'no-notice-after-stop', rt.host.store.listNotices(rt.host.qunoId, 10).length === 0, 0, rt.host.store.listNotices(rt.host.qunoId, 10).length),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 90_000, maxModelCalls: 8 },
  },
  {
    id: 'policy-change',
    title: 'in-flight Eval 重排，旧 Policy 不提交',
    priority: 'p1',
    requirement: 'waiting-decision 的 Eval 在 Policy 变化后 unavailable；pending 重排为新 Policy 版本的 Eval',
    tags: ['eval', 'policy'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'observe', autoSourceIds: [rt.options.collectorSourceId] } })
    },
    steps: [
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval', {}, 'pc-eval-1') },
      { kind: 'ingest', envelopes: [{ eventKey: 'pc-bot-1', type: 'ci.pipeline.finished', subject: { key: 'pc-ci' }, summary: 'CI 事件（旧策略期）' }] },
      { kind: 'waitFor', description: 'eval delivered and waiting', until: (rt) => rt.host.repo.listEvals(rt.host.qunoId, { limit: 5 }).some(entry => entry.status === 'waiting-decision'), deadlineMs: 30_000 },
      { kind: 'config', patch: { acceptMode: 'off' } },
    ],
    checks: (rt) => {
      const evals = rt.host.repo.listEvals(rt.host.qunoId, { limit: 10 })
      const oldEval = evals.find(entry => entry.status === 'unavailable')
      const newEval = evals.find(entry => entry.status !== 'unavailable' && oldEval !== undefined && entry.policyVersion !== oldEval.policyVersion)
      return {
        chain: [
          check('eval.candidate', 'old-eval-unavailable', oldEval !== undefined, 'unavailable', evals.map(entry => entry.status)),
          check('eval.candidate', 're-ranked-under-new-policy', newEval !== undefined, 'new policyVersion eval', evals.map(entry => ({ status: entry.status, policyVersion: entry.policyVersion }))),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 60_000, maxModelCalls: 6 },
  },
  {
    id: 'exchange-roundtrip',
    title: 'Worker 经 Exchange 向采集器读取，结果回流',
    priority: 'p1',
    requirement: 'quno_exchange → 采集器响应 → 结果作为 TicketInput 回到 worker → report 引用结果',
    tags: ['exchange', 'worker'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'er-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '查询日历数据', goal: '通过异步读取查询日历数据并汇报。' }, 'er-decide-1'),
        textTurn('已受理。'),
        textTurn('日历数据查询完成：今天有 2 个事件。'),
      ],
      worker: [],
    },
    steps: [
      { kind: 'script', role: 'worker', build: (_rt, drv) => toolTurn('quno_exchange', { responder: `collector:${drv.collectorInstanceId}`, payload: { query: 'today' } }, 'er-worker-exchange-1') },
      { kind: 'script', role: 'worker', build: () => textTurn('已发起异步读取。') },
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_worker_report', { state: 'ready', summary: '日历数据：今天有 2 个事件。' }, 'er-worker-ready-1') },
      { kind: 'script', role: 'worker', build: () => textTurn('已提交。') },
      { kind: 'ingest', envelopes: [imMention('er-trigger-1', '@Quno 查一下今天的日历数据', Date.parse('2026-11-06T09:45:00Z'))] },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const exchanges = repo.listExchanges(rt.host.qunoId, { limit: 10 })
      const exchange = exchanges.at(-1)
      const workerCalls = ticket === undefined ? [] : toolCalls(rt, executorSession(ticket.id))
      const reportInputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 }).filter(input => input.kind === 'response')
      return {
        chain: [
          check('worker.execution', 'exchange-requested', workerCalls.some(call => call.name === 'quno_exchange'), ['quno_exchange'], workerCalls.map(call => call.name)),
          check('worker.execution', 'organ-answered', exchange?.status === 'responded' || exchange?.status === 'consumed', 'responded/consumed', exchange?.status ?? 'none'),
          check('input.delivery', 'response-became-input', reportInputs.length >= 1, '>=1 response input', reportInputs.length),
          check('worker.report', 'report-uses-exchange-fact', ticket !== undefined && repo.listAssignmentsByTicket(ticket.id).at(-1)?.report?.summary.includes('2') === true, '2', repo.listAssignmentsByTicket(ticket?.id ?? '').at(-1)?.report?.summary ?? ''),
        ],
        semantics: [
          replyContainsFact('fact-exchange', '2', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 10 },
  },
  {
    id: 'organ-discovery',
    title: 'Worker 经 quno_read.collectors 发现端点并成功交换',
    priority: 'p1',
    requirement: 'Worker 先 quno_read 发现真实挂载的采集器端点（发现链路为真），quno_exchange 命中该端点，结果回流进报告；不再靠猜端点名',
    tags: ['exchange', 'worker', 'discovery'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'od-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '读取采集器数据', goal: '通过采集器异步读取数据并汇报。' }, 'od-decide-1'),
        textTurn('已受理。'),
        textTurn('采集器数据读取完成。'),
      ],
      worker: [],
    },
    steps: [
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_read', {}, 'od-read-1') },
      { kind: 'script', role: 'worker', build: (rtv) => {
        // The endpoint comes from the SAME discovery face the tool exposes —
        // the scripted worker does not hardcode it.
        const endpoint = rtv.host.collectorEndpoints().at(-1)
        return toolTurn('quno_exchange', { responder: endpoint?.endpoint ?? 'collector:none', payload: { op: 'im.group.recent' } }, 'od-exchange-1')
      } },
      { kind: 'script', role: 'worker', build: () => textTurn('已发起异步读取。') },
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_worker_report', { state: 'ready', summary: '采集器返回数据 1 条。' }, 'od-ready-1') },
      { kind: 'script', role: 'worker', build: () => textTurn('已提交。') },
      { kind: 'ingest', envelopes: [imMention('od-trigger-1', '@Quno 用采集器查一下数据', Date.parse('2026-11-06T09:50:00Z'))] },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const sessionId = ticket === undefined ? '' : executorSession(ticket.id)
      const calls = toolCalls(rt, sessionId)
      const results = toolResults(rt, sessionId)
      const exchanges = repo.listExchanges(rt.host.qunoId, { limit: 10 })
      const collectorViews = rt.host.collectorEndpoints()
      const readIndex = calls.findIndex(call => call.name === 'quno_read')
      const exchangeIndex = calls.findIndex(call => call.name === 'quno_exchange')
      return {
        chain: [
          check('worker.execution', 'discovered-before-exchange', readIndex >= 0 && exchangeIndex > readIndex, 'quno_read precedes quno_exchange', calls.map(call => call.name)),
          check('worker.execution', 'collectors-carry-mounted-endpoint', results.some(text => text.includes('"collectors"') && collectorViews.length > 0 && collectorViews.every(view => text.includes(view.endpoint))), 'collectors list the mounted endpoint', { views: collectorViews.map(organ => organ.endpoint) }),
          check('worker.execution', 'endpoint-from-discovery', exchanges.length === 1 && collectorViews.some(view => exchanges[0]?.responder === view.endpoint), 'responder is a listed endpoint', exchanges.map(exchange => exchange.responder)),
          check('worker.execution', 'organ-answered', exchanges[0]?.status === 'responded' || exchanges[0]?.status === 'consumed', 'responded/consumed', exchanges[0]?.status ?? 'none'),
          check('worker.report', 'report-completed', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 10 },
  },
  {
    id: 'organ-whitelist-reject',
    title: '白名单外 payload 被采集器拒绝且原因回流',
    priority: 'p1',
    requirement: '未知 op、越界 limit、写意图 payload 均被 failExchange（unsupported-op/invalid-args），原因作为 response Input 回流且无成功交换；白名单矩阵本体由 dsh-quno-collector-yzj 包内测试钉死，此处验证拒绝链路',
    tags: ['exchange', 'worker', 'third-party', 'whitelist'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
      rt.options.collector.setWhitelist(true)
    },
    scripts: {
      router: [
        toolTurn('quno_task', {
          title: '整理云之家会话',
          prompt: '通过只读云之家采集器查询最近会话并整理。',
        }, 'ow-delegate-1'),
        textTurn('好，我来整理会话，完成后告诉你。'),
        textTurn('三条查询都被采集器以白名单理由拒绝，无法整理会话。'),
      ],
      worker: [],
    },
    steps: [
      { kind: 'script', role: 'worker', build: (_rt, drv) => toolTurn('quno_exchange', { responder: `collector:${drv.collectorInstanceId}`, payload: { op: 'im.message.send', params: { groupId: 'g1', text: 'hi' } } }, 'ow-exchange-send') },
      { kind: 'script', role: 'worker', build: (_rt, drv) => toolTurn('quno_exchange', { responder: `collector:${drv.collectorInstanceId}`, payload: { op: 'im.group.recent', params: { limit: 99 } } }, 'ow-exchange-overbound') },
      { kind: 'script', role: 'worker', build: (_rt, drv) => toolTurn('quno_exchange', { responder: `collector:${drv.collectorInstanceId}`, payload: { op: 'im.status.post' } }, 'ow-exchange-unknown') },
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_worker_report', { state: 'blocked', summary: '三条查询均被采集器白名单拒绝（unsupported-op/invalid-args）。', question: { question: '是否调整查询范围后重试？' } }, 'ow-blocked-1') },
      { kind: 'script', role: 'worker', build: () => textTurn('已如实报告。') },
      // A Human turn is what carries quno_task delegation (the routing guard
      // refuses quno_task on Eval turns); no ingest is needed for this case.
      { kind: 'human', text: '查一下云之家最近会话，整理给我。' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const sessionId = ticket === undefined ? '' : executorSession(ticket.id)
      const results = toolResults(rt, sessionId)
      const exchanges = repo.listExchanges(rt.host.qunoId, { limit: 10 })
      const inputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 }).filter(input => input.kind === 'response')
      const report = ticket === undefined ? undefined : repo.listAssignmentsByTicket(ticket.id).at(-1)?.report
      return {
        chain: [
          check('worker.execution', 'three-exchanges-attempted', exchanges.length === 3, 3, exchanges.map(exchange => exchange.responder)),
          check('worker.execution', 'all-refused-never-responded', exchanges.length > 0 && exchanges.every(exchange => exchange.status === 'failed'), 'all failed', exchanges.map(exchange => exchange.status)),
          check('input.delivery', 'reasons-relayed', inputs.length === 3 && inputs.every(input => /异步读取失败：(unsupported-op|invalid-args)：/.test(input.text ?? '')), 'refusal reasons as response inputs', inputs.map(input => (input.text ?? '').slice(0, 80))),
          // The collector refusal is asynchronous: it reaches the worker as a
          // response Input turn, not as a quno_exchange tool result.
          check('worker.execution', 'refusal-visible-to-worker', sessionEvents(rt, sessionId).some(event => JSON.stringify(event).includes('异步读取失败')), 'refusal reasons reach the worker session', sessionEvents(rt, sessionId).filter(event => JSON.stringify(event).includes('异步读取失败')).slice(0, 3).map(event => JSON.stringify(event).slice(0, 120))),
          check('worker.report', 'blocked-not-ready', report?.state === 'blocked', 'blocked', report?.state ?? 'none'),
        ],
        semantics: [
          replyContainsFact('honest-refusal', '拒绝', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 12 },
  },
  {
    id: 'third-party-tool-unavailable',
    title: '第三方 CLI 通道未接入时明确失败，不伪造查询结果',
    priority: 'p1',
    requirement: 'Worker 无 shell 且猜测的采集器端点不存在：工具拒绝可观测、无 Exchange 假成功、blocked 如实回流',
    tags: ['exchange', 'worker', 'third-party', 'capability'],
    model: { router: 'scripted', worker: 'scripted' },
    scripts: {
      router: [
        toolTurn('quno_task', {
          title: '整理云之家最近会话',
          prompt: '通过只读云之家通道查询最近 20 个会话并整理；通道不可用时明确报告，不要编造结果。',
        }, 'tu-delegate-1'),
        textTurn('好，我来整理会话，完成后告诉你。'),
        textTurn('当前没有已接入的云之家按需查询通道，无法查询最近会话；需要先接入该能力或由你提供命令输出。'),
      ],
      worker: [
        toolTurn('quno_exchange', { responder: 'collector:shell', payload: { command: 'yzj-cli im group recent --limit 20 --page 1' } }, 'tu-worker-exchange-1'),
        toolTurn('quno_worker_report', {
          state: 'blocked',
          summary: 'Worker 没有 shell，collector:shell 也未挂载，无法查询云之家最近会话。',
          question: { question: '是否先接入云之家只读查询能力，或提供命令输出？' },
        }, 'tu-worker-blocked-1'),
        textTurn('已如实报告能力缺失。'),
      ],
    },
    steps: [
      { kind: 'human', text: '用 yzj-cli 查询最近 20 个会话，按会话整理后告诉我。' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const workerCalls = ticket === undefined ? [] : toolCalls(rt, executorSession(ticket.id))
      const workerResults = ticket === undefined ? [] : toolResults(rt, executorSession(ticket.id))
      const exchanges = repo.listExchanges(rt.host.qunoId, { limit: 10 })
      const report = ticket === undefined ? undefined : repo.listAssignmentsByTicket(ticket.id).at(-1)?.report
      return {
        chain: [
          check('worker.execution', 'missing-organ-refused', workerResults.some(text => /no mounted collector|没有挂载|unknown-responder/.test(text)), 'unknown-responder refusal', workerResults),
          check('worker.execution', 'no-shell-or-fake-exchange', workerCalls.every(call => call.name !== 'bash') && exchanges.length === 0, 'no bash and no persisted exchange', { calls: workerCalls.map(call => call.name), exchanges: exchanges.map(exchange => exchange.status) }),
          check('worker.report', 'blocked-not-ready', report?.state === 'blocked', 'blocked', report?.state ?? 'none'),
        ],
        semantics: [
          replyContainsFact('honest-capability-gap', '无法查询', rt),
        ],
      }
    },
    budget: { maxDurationMs: 90_000, maxModelCalls: 10 },
  },
  {
    id: 'memory-isolation',
    title: '自动回合不产生长期记忆写入',
    priority: 'p1',
    requirement: 'Eval/Notification 回合尝试 memory 写入被拒；评测记忆存储保持为空；Worker 会话请求不含 memory 工具',
    tags: ['guard', 'memory'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      // authorize the source so the eval turn actually runs (observe mode).
      await rt.host.updateConfig({ patch: { acceptMode: 'observe', autoSourceIds: [rt.options.collectorSourceId] } })
    },
    steps: [
      { kind: 'script', role: 'router', build: () => toolTurn('memory_remember', { content: '不该被写入的记忆' }, 'mi-mem-1') },
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval', {}, 'mi-eval-1') },
      { kind: 'script', role: 'router', build: () => toolTurn('quno_eval_decide', { kind: 'ignore', reason: '无关' }, 'mi-decide-1') },
      { kind: 'script', role: 'router', build: () => textTurn('已忽略。') },
      { kind: 'ingest', envelopes: [{ eventKey: 'mi-bot-1', type: 'ci.pipeline.finished', subject: { key: 'mi-ci' }, summary: 'CI 事件' }] },
    ],
    checks: (rt) => {
      const workerRequests = rt.options.gateway.record().filter(record => record.role === 'worker')
      const results = toolResults(rt, MAIN_SESSION)
      return {
        chain: [
          check('eval.decision', 'memory-write-refused', results.some(text => text.includes('不能写入长期记忆')), 'refusal', results.slice(0, 4)),
          check('eval.decision', 'eval-memory-store-empty', rt.memoryWrites.length === 0, [], rt.memoryWrites),
          check('worker.execution', 'worker-no-memory-tools', workerRequests.every(record => record.request.toolNames.every(name => !name.startsWith('memory_'))), [], workerRequests.flatMap(record => record.request.toolNames).filter(name => name.startsWith('memory_'))),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 60_000, maxModelCalls: 6 },
  },
]
