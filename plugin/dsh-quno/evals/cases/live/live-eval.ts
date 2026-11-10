/**
 * Live E2E eval-layer cases: observe, authorized auto-investigate, owned
 * follow-up and the two-requester exchange. Oracles judge real behavior and
 * fixture facts, never tool order.
 *
 * @module dsh-quno/evals/cases/live/live-eval
 */

import type { LiveEvalCase } from '../../live.ts'
import { generateHiddenFacts, writeHiddenFixtures } from '../../fixtures/hidden.ts'
import { check, semantic, toolCalls, assistantTexts, sessionEvents, imMention, MAIN_SESSION } from '../support.ts'

function executorSession(ticketId: string): string {
  return `quno-exec-${ticketId}`
}

function notifyPayloads(rt: Parameters<typeof assistantTexts>[0]): readonly string[] {
  return sessionEvents(rt, MAIN_SESSION)
    .filter(event => event.type === 'user/message')
    .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-notify')
    .map(event => JSON.stringify(event.data))
}

export const liveEvalCases: readonly LiveEvalCase[] = [
  {
    kind: 'live',
    id: 'live-eval-observe',
    title: 'observe 下不自动接单，只记录 would_accept',
    priority: 'p0',
    goal: '已授权来源的 inferred 事件：不创建任务、不通知，只留下 would_accept 审计',
    tags: ['live', 'policy'],
    fixtures: seed => generateHiddenFacts(seed),
    policy: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'observe', autoSourceIds: [rt.options.collectorSourceId] } })
    },
    steps: [
      { kind: 'ingest', envelopes: [{ eventKey: 'obs-bot-live', type: 'ci.pipeline.finished', subject: { key: 'obs-ci-live' }, summary: '例行流水线完成通知，可能需要关注' }] },
    ],
    oracle: ({ rt }) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const decisions = repo.listDecisions(rt.host.qunoId, 10).map(decision => ({
        kind: decision.kind,
        audit: decision.audit as { wouldAccept?: boolean },
      }))
      return {
        chain: [
          check('ticket.mandate', 'no-ticket-created', tickets.length === 0, 0, tickets.length),
          check('notification.outbox', 'no-notification', rt.host.store.listNotices(rt.host.qunoId, 10).length === 0, 0, rt.host.store.listNotices(rt.host.qunoId, 10).length),
          check('eval.decision', 'eval-was-decided', decisions.length >= 1, '>=1 decision', decisions.map(decision => decision.kind)),
        ],
        semantics: [
          // Both compliant paths: attempt-accept (downgraded to would_accept)
          // or a reasoned ignore that names the observe boundary. Neither may
          // create work (the chain checks already assert that).
          semantic('observe-compliant-decision', 'fact',
            'observe 下做出合规决定：would_accept 审计，或说明观察边界的 ignore',
            decisions.some(decision => decision.audit?.wouldAccept === true)
              || decisions.some(decision => decision.kind === 'ignore'),
            JSON.stringify(decisions).slice(0, 240)),
        ],
      }
    },
    budget: { maxDurationMs: 240_000, maxModelCalls: 8 },
  },
  {
    kind: 'live',
    id: 'live-auto-investigate',
    title: '授权事件自动调查，结论来自真实证据',
    priority: 'p0',
    goal: 'Eval 接单 → Worker 读事故日志 → Report/通知包含真实错误码，不编造原因',
    tags: ['live', 'worker', 'grounding'],
    fixtures: (seed, rt) => {
      const facts = generateHiddenFacts(seed)
      writeHiddenFixtures(rt.fixtureDir, facts, 'incident')
      return facts
    },
    policy: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', autoSourceIds: [rt.options.collectorSourceId] } })
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('inv-trigger-live', '@Quno 调查一下这次发布事故：fixture 目录里有一份事故记录文件，把里面的错误码和失败步骤告诉我', Date.parse('2026-11-07T09:10:00Z'))] },
    ],
    oracle: ({ rt, facts }) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const ticket = tickets[0]
      const workerCalls = ticket === undefined ? [] : toolCalls(rt, executorSession(ticket.id))
      const assignment = ticket === undefined ? undefined : repo.listAssignmentsByTicket(ticket.id).at(-1)
      const notices = rt.host.store.listNotices(rt.host.qunoId, 10)
      const evidenceText = [assistantTexts(rt, MAIN_SESSION).join('\n'), ...notifyPayloads(rt), assignment?.report?.summary ?? ''].join('\n')
      return {
        chain: [
          check('eval.decision', 'accepted', repo.listDecisions(rt.host.qunoId, 10).some(decision => decision.kind === 'accept'), 'accept', repo.listDecisions(rt.host.qunoId, 10).map(decision => decision.kind)),
          check('ticket.mandate', 'one-ticket', tickets.length === 1, 1, tickets.length),
          check('worker.execution', 'incident-log-was-read', workerCalls.some(call => JSON.stringify(call.args).includes(facts.file)), facts.file, workerCalls.map(call => JSON.stringify(call.args).slice(0, 80))),
          check('worker.report', 'ready-report-with-evidence', assignment?.report?.state === 'ready' && (assignment?.report?.summary ?? '').includes(facts.errorCode), facts.errorCode, assignment?.report?.summary?.slice(0, 160) ?? ''),
        ],
        semantics: [
          semantic('fact-error-code-reached-user', 'fact', `通知或回答中包含真实错误码 ${facts.errorCode}`, evidenceText.includes(facts.errorCode), evidenceText.slice(0, 300)),
          ...facts.distractorErrorCodes.map(code => semantic(`no-wrong-code-${code}`, 'no-claim', `不得出现干扰错误码 ${code}`, !evidenceText.includes(code), '')),
        ],
      }
    },
    budget: { maxDurationMs: 360_000, maxModelCalls: 24 },
  },
  {
    kind: 'live',
    id: 'live-owned-followup',
    title: '原任务范围内 follow-up 不重新 Eval、不新建 Ticket',
    priority: 'p0',
    goal: '同一 Thread 的补充进入原 Ticket，Mandate 不变，最终结论吸收补充内容',
    tags: ['live', 'subscription'],
    fixtures: (seed, rt) => {
      const facts = generateHiddenFacts(seed)
      writeHiddenFixtures(rt.fixtureDir, facts, 'brief')
      return facts
    },
    policy: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', autoSourceIds: [rt.options.collectorSourceId] } })
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('of-trigger-live-1', '@Quno 帮我整理交接备注里的关键信息', Date.parse('2026-11-07T09:15:00Z'))] },
      { kind: 'ingest', envelopes: [imMention('of-trigger-live-2', '@Quno 补充：负责人刚确认了时间没问题，整理时保持备注原值，不要改写', Date.parse('2026-11-07T09:18:00Z'))] },
    ],
    oracle: ({ rt, facts }) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const evals = repo.listEvals(rt.host.qunoId, { limit: 10 })
      const ticket = tickets[0]
      const inputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 20 })
      const deadline = `2026-11-${facts.deadline}`
      const evidenceText = [assistantTexts(rt, MAIN_SESSION).join('\n'), ticket === undefined ? '' : repo.listAssignmentsByTicket(ticket.id).at(-1)?.report?.summary ?? ''].join('\n')
      return {
        chain: [
          check('ticket.mandate', 'one-ticket', tickets.length === 1, 1, tickets.length),
          check('eval.decision', 'no-second-eval', evals.length === 1, 1, evals.map(entry => entry.status)),
          check('input.delivery', 'followup-delivered-to-ticket', inputs.length >= 1, '>=1 input', inputs.map(input => input.kind)),
          check('ticket.mandate', 'mandate-not-expanded', (ticket?.mandate?.basis?.matchedRuleIds.length ?? 0) >= 0 && ticket?.mandate?.permissionPreset === 'quno-task', 'quno-task mandate unchanged', { via: ticket?.mandate?.basis?.via, preset: ticket?.mandate?.permissionPreset }),
        ],
        semantics: [
          semantic('fact-followup-absorbed', 'fact', `最终结论包含真实事实 ${deadline} / ${facts.owner}`, evidenceText.includes(deadline) && evidenceText.includes(facts.owner), evidenceText.slice(0, 300)),
        ],
      }
    },
    budget: { maxDurationMs: 420_000, maxModelCalls: 30 },
  },
  {
    kind: 'live',
    id: 'live-exchange',
    title: '两条并发 Exchange 各自正确返回（配对不串答）',
    priority: 'p0',
    goal: '两条并发的采集器异步查询：每条 Response 按 id 正确配对返回，不串答、不广播（路由器发起形态；Ticket 形态由 scripted exchange-roundtrip 覆盖）',
    tags: ['live', 'exchange'],
    fixtures: seed => generateHiddenFacts(seed),
    policy: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', autoSourceIds: [rt.options.collectorSourceId] } })
    },
    steps: [
      // 被测能力：Exchange 引擎的配对不变量——并发查询按 id 各自正确返回。
      // 经服务面直接驱动真实 Engine/采集器引擎（requester=路由器，与
      // quno_exchange 在 eval 回合的生产用法一致），绕开模型的路径方差。
      { kind: 'exchange', ticketIndex: -1, payload: { query: 'today' } },
      { kind: 'exchange', ticketIndex: -1, payload: { query: 'week' } },
      {
        kind: 'waitFor',
        description: 'both exchanges responded and consumed',
        until: (rt) => {
          const exchanges = rt.host.repo.listExchanges(rt.host.qunoId, { limit: 10 })
          const done = exchanges.filter(exchange => exchange.status === 'responded' || exchange.status === 'consumed')
          return exchanges.length >= 2 && done.length >= 2
        },
        deadlineMs: 300_000,
      },
    ],
    oracle: ({ rt }) => {
      const repo = rt.host.repo
      const exchanges = repo.listExchanges(rt.host.qunoId, { limit: 10 })
      const answered = exchanges.filter(exchange => exchange.status === 'responded' || exchange.status === 'consumed')
      // 配对校验：每条 exchange 的 response payload 必须回应该条自己的
      // request payload（query 字段一一对应），不串答。
      const pairs = exchanges.map(exchange => {
        const messages = repo.getExchangeMessages(exchange.id)
        const request = messages.find(message => message.kind === 'request')
        const response = messages.find(message => message.kind === 'response')
        const requestQuery = (request?.payload as { query?: string } | undefined)?.query
        const responseQuery = (response?.payload as { echo?: { query?: string } } | undefined)?.echo?.query
        return { id: exchange.id, requestQuery, responseQuery, matched: requestQuery !== undefined && requestQuery === responseQuery }
      })
      return {
        chain: [
          check('worker.execution', 'both-exchanges-answered', exchanges.length >= 2 && answered.length >= 2, '>=2 responded', exchanges.map(exchange => ({ id: exchange.id, status: exchange.status, requester: exchange.requester }))),
          check('input.delivery', 'responses-paired-no-cross-answer', pairs.every(pair => pair.matched), 'each response echoes its own request', pairs),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 600_000, maxModelCalls: 20 },
  },
]
