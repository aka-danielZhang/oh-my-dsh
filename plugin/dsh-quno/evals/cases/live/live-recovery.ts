/**
 * Live E2E recovery/notification cases: worker asks when information is
 * missing, crash/restart recovery, and quiet-hours notification. Oracles are
 * behavior + state-machine constraints only.
 *
 * @module dsh-quno/evals/cases/live/live-recovery
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LiveEvalCase } from '../../live.ts'
import { generateHiddenFacts, writeHiddenFixtures } from '../../fixtures/hidden.ts'
import { check, semantic, toolCalls, assistantTexts, sessionEvents, imMention, MAIN_SESSION } from '../support.ts'

function executorSession(ticketId: string): string {
  return `quno-exec-${ticketId}`
}

function hhmm(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}


/** Report relays on the main conversation and whether each was answered. */
function relayPresentation(rt: Parameters<typeof toolCalls>[0]): { readonly relays: number; readonly answered: number } {
  const events = sessionEvents(rt, MAIN_SESSION)
  let relays = 0
  let answered = 0
  let relaySeen = false
  for (const event of events) {
    if (event.type === 'user/message' && (event.data as { source?: { kind?: string } }).source?.kind === 'quno-report') {
      relays += 1
      relaySeen = true
    } else if (event.type === 'assistant/message' && relaySeen) {
      answered += 1
      relaySeen = false
    }
  }
  return { relays, answered }
}

export const liveRecoveryCases: readonly LiveEvalCase[] = [
  {
    kind: 'live',
    id: 'live-worker-blocked',
    title: 'Worker 缺信息先提问，回答后继续到 ready',
    priority: 'p0',
    goal: '证据里缺少主持人时不得编造：先提出具体问题，用户回答后在同一 Mandate 下继续',
    tags: ['live', 'worker', 'decision'],
    fixtures: (seed, rt) => {
      const facts = generateHiddenFacts(seed)
      // The fixture deliberately contains the date but NOT the owner: the
      // missing fact is what the worker must ask about (the user answers with
      // facts.owner in the second turn).
      writeFileSync(join(rt.fixtureDir, facts.file), `# 会议纪要素材\n\n会议日期：2026-11-${facts.deadline}\n议题：迁移窗口确认\n（素材里没有主持人信息）\n`, 'utf8')
      return facts
    },
    policy: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', autoSourceIds: [rt.options.organSourceId] } })
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('wb-trigger-live', '@Quno 整理一份会议纪要：fixture 目录里有素材文件，纪要必须写明主持人和会议日期', Date.parse('2026-11-07T09:30:00Z'))] },
      {
        kind: 'settleUntil',
        description: 'worker asked the missing-info question',
        until: (rt) => {
          const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
          return ticket !== undefined && ticket.question !== undefined && ticket.question !== null
        },
        stopWhen: (rt) => rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)?.ended !== null,
        deadlineMs: 900_000,
      },
      // The user's answer routes through the OWNED THREAD (production path):
      // the follow-up ingest becomes a TicketInput on the live ticket. (The
      // earlier quno_task-note script step never executed in live mode —
      // script queues only serve the stand-in adapters; rounds 9-11 实测.)
      { kind: 'human', text: (facts) => `主持人是${facts.owner}，其他信息以素材为准。` },
      {
        kind: 'waitFor',
        description: 'the answer reached the worker',
        until: (rt) => {
          const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
          return ticket !== undefined && rt.host.repo.listInputsByTicket(ticket.id, { limit: 10 }).some(input => input.kind === 'note' && input.readAt !== null)
        },
        stopWhen: (rt) => rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)?.ended !== null,
        deadlineMs: 900_000,
      },
    ],
    oracle: ({ rt, facts }) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const ticket = tickets[0]
      const assignments = ticket === undefined ? [] : repo.listAssignmentsByTicket(ticket.id)
      const workerCalls = ticket === undefined ? [] : toolCalls(rt, executorSession(ticket.id))
      const noteInputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 }).filter(input => input.kind === 'note')
      const followupInputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 }).filter(input => input.kind === 'trigger' && (input.text ?? '').includes('补充'))
      // Durable question evidence: the blocked report call itself carried a
      // question (the later ready report clears ticket.question by design).
      const blockedCall = workerCalls.find(call => call.name === 'quno_worker_report' && ['blocked', 'waiting'].includes((call.args as { state?: string })?.state ?? ''))
      const questionArg = (blockedCall?.args as { question?: { question?: string } } | undefined)?.question?.question
      const replies = assistantTexts(rt, MAIN_SESSION).join('\n')
      return {
        chain: [
          check('ticket.mandate', 'one-ticket-one-assignment', tickets.length === 1 && assignments.length === 1, '1/1', { tickets: tickets.length, assignments: assignments.length }),
          check('worker.report', 'asked-instead-of-inventing', typeof questionArg === 'string' && questionArg.length >= 4, 'a concrete question', questionArg ?? 'none'),
          // The answer reaches the worker as a follow-up TicketInput (the
          // owned-human path); note-kind is the UI affordance, trigger-kind is
          // the Thread path — either proves the answer was routed.
          check('input.delivery', 'answer-routed-to-worker', noteInputs.length >= 1 || followupInputs.length >= 1, 'answer input delivered', { notes: noteInputs.length, followups: followupInputs.map(input => ({ delivered: input.deliveredAt !== null, read: input.readAt !== null })) }),
          check('worker.report', 'finished-after-answer', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
        ],
        semantics: [
          semantic('fact-owner-from-user', 'fact', `最终纪要包含用户回答的主持人 ${facts.owner}`, replies.includes(facts.owner), replies.slice(0, 300)),
        ],
      }
    },
    budget: { maxDurationMs: 600_000, maxModelCalls: 36 },
  },
  {
    kind: 'live',
    id: 'live-worker-restart',
    title: '交付 Effect 挂起时崩溃，重启恢复',
    priority: 'p0',
    goal: 'follow-up 输入已入库、Effect 未执行时 crash：不丢、不重、结果只展示一次',
    tags: ['live', 'recovery'],
    fixtures: (seed, rt) => {
      const facts = generateHiddenFacts(seed)
      // The case name says the worker reads a real file: WRITE it (the
      // round-6 forensics caught the fixture never writing one — the worker
      // correctly blocked twice on an empty directory).
      writeHiddenFixtures(rt.fixtureDir, facts, 'brief')
      return facts
    },
    policy: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', autoSourceIds: [rt.options.organSourceId] } })
    },
    steps: [
      // Crash window: the eval accepted and enqueued the launch, but the whole
      // execution happens POST-restart — the recovery path under test.
      { kind: 'ingest', envelopes: [imMention('wr-trigger-live-1', '@Quno 帮我跟进这个客户请求：读取 fixture 目录里的客户备注文件，整理其中的截止日期与负责人，完成后汇报', Date.parse('2026-11-07T09:35:00Z'))], settle: false },
      {
        kind: 'settleUntil',
        description: 'the eval accepted and the assignment exists',
        until: (rt) => {
          const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
          return ticket !== undefined && rt.host.repo.listAssignmentsByTicket(ticket.id).length >= 1
        },
        deadlineMs: 120_000,
      },
      { kind: 'crash' },
      { kind: 'restart' },
      // The re-armed launch runs the WHOLE task after the restart.
      { kind: 'waitFor', description: 'ticket ended with a completed outcome', until: (rt) => {
        const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
        return ticket !== undefined && ticket.ended !== null && ticket.ended.outcome === 'completed'
      }, deadlineMs: 900_000 },
      // The follow-up arrives on the completed ticket: the owned-human resume
      // path may legitimately reopen it under the same Mandate (round-7 实测).
      { kind: 'ingest', envelopes: [imMention('wr-trigger-live-2', '补充：以上信息以 fixture 备注文件里的记录为准，把整理结果最终确定并汇报', Date.parse('2026-11-07T09:37:00Z'))] },
      { kind: 'waitFor', description: 'the follow-up result is relayed and answered', until: (rt) => {
        const ticket = rt.host.repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
        // The result reaches the user through the report-relay path (the
        // model may answer directly instead of calling quno_notify — both
        // are legitimate presentations; round-7 实测).
        const answered = relayPresentation(rt)
        return ticket !== undefined && ticket.ended !== null && ticket.ended.outcome === 'completed' && answered.relays >= 1 && answered.answered >= 1
      }, deadlineMs: 900_000 },
    ],
    oracle: ({ rt }) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 10 })
      const ticket = tickets.at(-1)
      const assignments = ticket === undefined ? [] : repo.listAssignmentsByTicket(ticket.id)
      const inputs = ticket === undefined ? [] : repo.listInputsByTicket(ticket.id, { limit: 10 })
      const input = inputs[0]
      const attempts = input === undefined ? [] : [1, 2, 3].map(n => repo.findInputAttempt(input.id, n)).filter(Boolean)
      const runs = ticket === undefined ? [] : assignments.flatMap(assignment => repo.listWorkerRunsByAssignment(assignment.id))
      const concurrent = ((): boolean => {
        // 不双跑：同一 Assignment 的 runs 按时间不重叠（恢复重 arm 允许产生
        // 后续 Assignment/run——owned 人类消息恢复已完成 Ticket 是设计语义——
        // 但绝不允许并发执行）。
        for (const assignment of assignments) {
          const ordered = repo.listWorkerRunsByAssignment(assignment.id)
            .slice()
            .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
          for (let index = 1; index < ordered.length; index += 1) {
            if ((ordered[index]?.startedAt ?? 0) < (ordered[index - 1]?.finishedAt ?? 0)) return true
          }
        }
        return false
      })()
      const notifyMessages = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-notify')
      return {
        chain: [
          check('recovery.restart', 'restart-happened', rt.options.restarts.length >= 1, '>=1 restart', rt.options.restarts.length),
          check('ticket.mandate', 'one-ticket', tickets.length === 1, 1, tickets.length),
          check('assignment.launch', 'no-concurrent-worker-runs', !concurrent, 'worker runs never overlap', runs.map(run => ({ started: run.startedAt, finished: run.finishedAt }))),
          check('input.delivery', 'input-not-lost-not-duplicated', input?.deliveredAt !== null && attempts.length === 1, 'delivered once', attempts.map(attempt => ({ attempt: (attempt as { attempt?: number }).attempt, status: (attempt as { status?: string }).status }))),
          check('notification.presented', 'every-relay-answered-once', ((): boolean => {
            // This case presents through the REPORT-RELAY path (no outbox
            // notice): the evidence is every report relay getting answered.
            const presentation = relayPresentation(rt)
            return presentation.relays >= 1 && presentation.answered === presentation.relays
          })(), 'each report relay answered exactly once', relayPresentation(rt)),
          check('notification.presented', 'no-state-regression', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
        ],
        semantics: [],
      }
    },
    budget: { maxDurationMs: 1_200_000, maxModelCalls: 60 },
  },
  {
    kind: 'live',
    id: 'live-notification-quiet',
    title: '安静时段不打扰，解禁后只展示一份有效通知',
    priority: 'p0',
    goal: 'quiet hours 内结果只暂存；解禁后一份 presented，无重复投递',
    tags: ['live', 'notification'],
    fixtures: seed => generateHiddenFacts(seed),
    policy: async (rt) => {
      const now = rt.now()
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', quietHours: { start: hhmm(now - 30 * 60_000), end: hhmm(now + 30 * 60_000) } } })
    },
    steps: [
      // The capability under test here is the OUTBOX state machine (quiet hold
      // → release → one presentation), not the model's notify judgment — so
      // the notice enters through the SAME service face the quno_notify tool
      // wraps, deterministically.
      { kind: 'notify', input: { title: '发布窗口确认', summary: '发布窗口确认完成', body: '发布窗口确认：明天 10:00-12:00 可以发布。', why: '结论已确认，值得汇报。', topicKey: 'release-window-live' } },
      { kind: 'waitFor', description: 'notice is quiet-held', until: (rt) => rt.host.store.listNotices(rt.host.qunoId, 10).some(notice => notice.status === 'pending' && (notice.reason ?? '').includes('quiet')), deadlineMs: 300_000 },
      { kind: 'config', patch: { quietHours: null } },
      { kind: 'advanceMs', ms: 31 * 60_000 },
      { kind: 'waitFor', description: 'notice presented', until: (rt) => rt.host.store.listNotices(rt.host.qunoId, 10).every(notice => notice.status === 'presented') && rt.host.store.listNotices(rt.host.qunoId, 10).length >= 1, deadlineMs: 600_000 },
    ],
    oracle: ({ rt }) => {
      const notices = rt.host.store.listNotices(rt.host.qunoId, 10)
      const attempts = notices.flatMap(notice => rt.host.store.listNoticeAttempts(notice.id))
      const notifyMessages = sessionEvents(rt, MAIN_SESSION)
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-notify')
      return {
        chain: [
          check('notification.outbox', 'one-merged-notice', notices.length === 1, 1, notices.map(notice => ({ status: notice.status, topicKey: notice.topicKey }))),
          check('notification.presented', 'outbox-presented-exactly-once', ((): boolean => {
            // The notify path's presentation evidence is the OUTBOX state
            // itself: exactly one notice, presented (its turn answered).
            const notices = rt.host.store.listNotices(rt.host.qunoId, 10)
            return notices.length === 1 && notices.every(notice => notice.status === 'presented')
          })(), 'one notice, presented', rt.host.store.listNotices(rt.host.qunoId, 10).map(notice => ({ status: notice.status, topicKey: notice.topicKey }))),
          check('notification.presented', 'no-retry-storm', attempts.every(attempt => attempt.status !== 'retryable-failure') && attempts.filter(attempt => attempt.status === 'prepared').length === 1, 'one delivery pass', attempts.map(attempt => ({ attempt: attempt.attempt, status: attempt.status }))),
        ],
        semantics: [
          semantic('quiet-then-presented', 'provide', '安静时段先暂存、解禁后展示（waitFor 步骤已证明）', true, 'quiet-held wait passed, then presented'),
        ],
      }
    },
    budget: { maxDurationMs: 1_200_000, maxModelCalls: 40 },
  },
]
