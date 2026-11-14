/**
 * Router/Worker interaction acceptance cases (design §13.4, P0 gate): the
 * main conversation stays quiet and first-person while the task projection
 * and the read-only record carry the process.
 *
 * - main-task-quiet-success: one acceptance, one result; no technical leak.
 * - main-task-internal-failure-hidden: two illegal async reads leave durable
 *   error evidence and INTERNAL relays only.
 * - task-report-progress-no-chat: progress reports move the projection only.
 * - task-activity-readonly-running: the record is readable while running.
 * - task-activity-redaction: credentials/env/reasoning never reach the record.
 *
 * @module dsh-quno/evals/cases/interaction
 */

import type { EvalCase } from '../case.ts'
import type { EvalRuntime } from '../runtime.ts'
import { textTurn, toolTurn } from '../models/scripted.ts'
import { check, replyContainsFact, replyMustNotClaim, assistantTexts, sessionEvents, MAIN_SESSION } from './support.ts'
import { writeFixtureFiles } from '../fixtures/fs.ts'

function executorSession(ticketId: string): string {
  return `quno-exec-${ticketId}`
}

/** user/message events in the main log whose source is a Quno relay. */
function relayMessages(rt: EvalRuntime): readonly { kind: string | undefined; presentation: string | undefined; summary: string | undefined; text: string | undefined }[] {
  return sessionEvents(rt, MAIN_SESSION)
    .filter(event => event.type === 'user/message')
    .map(event => event.data as { source?: { kind?: string; presentation?: string; summary?: string } })
    .filter(record => record.source?.kind !== undefined && record.source.kind.startsWith('quno-'))
    .map(record => ({
      kind: record.source?.kind,
      presentation: record.source?.presentation,
      summary: record.source?.summary,
      text: undefined,
    }))
}

/** The technical vocabulary that must never appear in visible replies. */
const LEAK_MARKERS = ['后台', 'Worker', 'worker', '子会话', 'requestId', 'taskId=', 'quno_', 'organ:', 'Exchange', 'Ticket', 'Assignment']

export const interactionCases: readonly EvalCase[] = [
  {
    id: 'main-task-quiet-success',
    title: '主对话安静闭环：一次接受、一次结果、零技术泄漏',
    priority: 'p0',
    requirement: '交办后只出现第一人称接受与结果；progress 不产生消息；可见回复无 Worker/后台/requestId/工具参数泄漏；结果只说一次',
    tags: ['interaction', 'quiet', 'delegation'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      writeFixtureFiles(rt.fixtureDir, [
        { path: 'digest.md', content: '# 会议纪要\n\n结论：下周五评审。\n' },
      ])
    },
    scripts: {
      router: [
        toolTurn('quno_task', {
          title: '整理会议纪要',
          prompt: '用 read 工具读取 fixture 目录下的 digest.md，报告其中的结论，然后用 quno_worker_report 提交。',
        }, 'qs-delegate-1'),
        textTurn('好，我来整理会议纪要，完成后在这里告诉你。'),
        textTurn('整理好了：结论是下周五评审。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'progress', summary: '纪要已读取，正在整理。' }, 'qs-worker-progress-1'),
        toolTurn('read', { path: 'digest.md' }, 'qs-worker-read-1'),
        toolTurn('quno_worker_report', { state: 'ready', summary: '结论：下周五评审。', artifacts: [{ kind: 'file', label: 'digest.md', uri: 'digest.md' }] }, 'qs-worker-ready-1'),
        textTurn('已完成并提交报告。'),
      ],
    },
    steps: [
      { kind: 'human', text: '帮我把 fixture 目录里的会议纪要整理一下，告诉我结论。' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const tickets = repo.listTickets(rt.host.qunoId, { limit: 5 })
      const ticket = tickets[0]
      const assignment = ticket === undefined ? undefined : repo.listAssignmentsByTicket(ticket.id).at(-1)
      const relays = relayMessages(rt)
      const reportRelays = relays.filter(relay => relay.kind === 'quno-report')
      const visible = assistantTexts(rt, MAIN_SESSION)
      const leaked = visible.filter(text => LEAK_MARKERS.some(marker => text.includes(marker)))
      const resultMentions = visible.filter(text => text.includes('下周五评审'))
      const assignmentStarted = ticket === undefined ? [] : sessionEvents(rt, executorSession(ticket.id))
      return {
        chain: [
          check('ticket.mandate', 'one-ticket', tickets.length === 1, 1, tickets.length),
          check('worker.report', 'ready-recorded', assignment?.report?.state === 'ready', 'ready', assignment?.report?.state ?? 'none'),
          check('worker.report', 'progress-kept-as-evidence', assignmentStarted.some(event => JSON.stringify(event).includes('纪要已读取')), 'progress durable in executor log', []),
          check('router.relay', 'single-report-relay', reportRelays.length === 1, 1, reportRelays.map(relay => relay.summary)),
          check('router.relay', 'relays-are-internal', relays.length > 0 && relays.every(relay => relay.presentation === 'internal'), "presentation === 'internal'", relays.map(relay => ({ kind: relay.kind, presentation: relay.presentation }))),
          check('router.relay', 'no-technical-leak-in-replies', leaked.length === 0, [], leaked),
          check('router.relay', 'result-said-once', resultMentions.length === 1, 1, resultMentions.length),
        ],
        semantics: [
          replyContainsFact('fact-conclusion', '下周五评审', rt),
          replyMustNotClaim('no-progress-chatter', '还在处理', rt),
        ],
      }
    },
    budget: { maxDurationMs: 90_000, maxModelCalls: 8 },
  },
  {
    id: 'main-task-internal-failure-hidden',
    title: '两次非法异步读取：失败证据在任务面，程序消息只走内部',
    priority: 'p0',
    requirement: 'Router 侧猜测的 organ 被同步拒绝（零 Exchange、零排队条目）；Worker 侧两次非法 organ op 落两条持久 error 证据；回到主对话的只有 internal 标记的 blocked 提问 relay；可见回复不泄漏 endpoint/错误细节',
    tags: ['interaction', 'quiet', 'exchange-failure'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto' } })
      rt.options.organ.setWhitelist(true)
    },
    scripts: {
      router: [
        toolTurn('quno_exchange', { responder: 'organ:missing-a', payload: { op: 'im.group.recent' } }, 'if-router-exchange-1'),
        toolTurn('quno_exchange', { responder: 'organ:missing-b', payload: { op: 'im.group.recent' } }, 'if-router-exchange-2'),
        toolTurn('quno_task', {
          title: '整理云之家会话',
          prompt: '通过只读云之家 organ 查询最近会话并整理；查询被拒绝时如实报告。',
        }, 'if-delegate-1'),
        textTurn('好，我来整理。有两个来源现在读不到，我先走可用的通道。'),
        textTurn('整理没能完成：云之家的查询被拒绝了两次。你确认授权范围后，我可以从原任务重试。'),
      ],
      worker: [],
    },
    steps: [
      { kind: 'script', role: 'worker', build: (_rt, drv) => toolTurn('quno_exchange', { responder: `organ:${drv.organInstanceId}`, payload: { op: 'im.message.send', params: { groupId: 'g1', text: 'hi' } } }, 'if-worker-exchange-1') },
      { kind: 'script', role: 'worker', build: (_rt, drv) => toolTurn('quno_exchange', { responder: `organ:${drv.organInstanceId}`, payload: { op: 'im.status.post' } }, 'if-worker-exchange-2') },
      { kind: 'script', role: 'worker', build: () => toolTurn('quno_worker_report', { state: 'blocked', summary: '两条查询都被 organ 白名单拒绝，无法整理会话。', question: { question: '是否调整查询范围后重试？' } }, 'if-blocked-1') },
      { kind: 'script', role: 'worker', build: () => textTurn('已如实报告。') },
      { kind: 'human', text: '先试试 missing-a 和 missing-b 两个来源，再整理云之家会话。' },
      { kind: 'settle' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const exchanges = repo.listExchanges(rt.host.qunoId, { limit: 10 })
      const errors = exchanges.flatMap(exchange => repo.getExchangeMessages(exchange.id).filter(message => message.kind === 'error'))
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const relays = relayMessages(rt).filter(relay => relay.kind === 'quno-report')
      const visible = assistantTexts(rt, MAIN_SESSION)
      const leaked = visible.filter(text => ['organ:', 'missing-a', 'missing-b', '异步读取失败', 'requestId', 'unsupported-op'].some(marker => text.includes(marker)))
      const workerResults = ticket === undefined ? [] : sessionEvents(rt, executorSession(ticket.id))
      return {
        chain: [
          check('input.delivery', 'router-refusals-never-persist-exchanges', exchanges.length === 2, 2, exchanges.map(exchange => ({ responder: exchange.responder, status: exchange.status }))),
          check('input.delivery', 'worker-failures-persisted', exchanges.length === 2 && exchanges.every(exchange => exchange.status === 'failed'), 'both failed', exchanges.map(exchange => exchange.status)),
          check('input.delivery', 'durable-error-evidence', errors.length >= 2, '>=2 error messages', errors.length),
          check('input.delivery', 'worker-sees-refusal-reasons', workerResults.some(event => JSON.stringify(event).includes('unsupported-op')), 'refusals reach the worker session', []),
          check('router.relay', 'main-only-internal-relays', relays.length >= 1 && relays.every(relay => relay.presentation === 'internal'), "presentation === 'internal'", relays.map(relay => ({ summary: relay.summary, presentation: relay.presentation }))),
          check('router.relay', 'no-endpoint-leak-in-replies', leaked.length === 0, [], leaked),
        ],
        semantics: [
          replyMustNotClaim('no-fake-success', '已经查到', rt),
          replyContainsFact('honest-refusal', '拒绝', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 12 },
  },
  {
    id: 'task-report-progress-no-chat',
    title: '多次 progress 只更新任务投影，主对话安静',
    priority: 'p0',
    requirement: '两条 progress Report 均不产生 router-relay；ready 恰好 relay 一次；任务记录里保留全部 progress 证据',
    tags: ['interaction', 'quiet', 'report-policy'],
    model: { router: 'scripted', worker: 'scripted' },
    scripts: {
      router: [
        toolTurn('quno_task', {
          title: '盘点群消息',
          prompt: '整理最近群消息要点并提交。',
        }, 'pn-delegate-1'),
        textTurn('好，我来盘点，完成后告诉你。'),
        textTurn('盘点好了：本周需要回应的有 2 条。'),
      ],
      worker: [
        // One bounded run: two progress reports then the final result. Each
        // progress is durable evidence but must not wake the main conversation.
        toolTurn('quno_worker_report', { state: 'progress', summary: '第一条：读取完成一半。' }, 'pn-progress-1'),
        toolTurn('quno_worker_report', { state: 'progress', summary: '第二条：读取完成。' }, 'pn-progress-2'),
        toolTurn('quno_worker_report', { state: 'ready', summary: '本周需要回应 2 条。' }, 'pn-ready-1'),
        textTurn('已提交。'),
      ],
    },
    steps: [
      { kind: 'human', text: '盘点一下最近群消息，告诉我需要回应哪几条。' },
    ],
    checks: (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const relays = relayMessages(rt).filter(relay => relay.kind === 'quno-report')
      const visible = assistantTexts(rt, MAIN_SESSION)
      const progressEcho = visible.filter(text => text.includes('读取完成一半') || text.includes('读取完成。'))
      const effects = repo.listDueEffects(Date.now() + 3_600_000, 50).filter(item => item.kind === 'router-relay')
      return {
        chain: [
          check('router.relay', 'exactly-one-report-relay', relays.length === 1, 1, relays.map(relay => relay.summary)),
          check('router.relay', 'relay-is-the-final-result', relays[0]?.summary?.includes('盘点') === true, 'ready relay', relays[0]?.summary ?? 'none'),
          check('router.relay', 'no-progress-relay-effects', effects.length <= 1, '<=1 (settled)', effects.length),
          check('router.relay', 'progress-never-in-chat', progressEcho.length === 0, [], progressEcho),
          check('worker.report', 'ready-ends-ticket', ticket?.ended?.outcome === 'completed', 'completed', ticket?.ended?.outcome ?? 'open'),
        ],
        semantics: [
          replyContainsFact('fact-count', '2 条', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 12 },
  },
  {
    id: 'task-activity-readonly-running',
    title: '运行中即可读执行记录：真实工具证据，无伪造步骤',
    priority: 'p0',
    requirement: 'taskActivity 在任务运行中返回真实任务指令/工具证据；无 system prompt；wire 无写面；结果不在时不得谎报',
    tags: ['interaction', 'activity', 'readonly'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      writeFixtureFiles(rt.fixtureDir, [{ path: 'memo.txt', content: '备忘：三点会。\n' }])
    },
    scripts: {
      router: [
        toolTurn('quno_task', {
          title: '读取备忘',
          prompt: '用 read 工具读取 fixture 目录下的 memo.txt 并汇报内容，然后 quno_worker_report 提交。',
        }, 'ra-delegate-1'),
        textTurn('好，我来读备忘，读好告诉你。'),
        textTurn('读好了：备忘写的是三点会。'),
      ],
      worker: [
        toolTurn('read', { path: 'memo.txt' }, 'ra-worker-read-1'),
        toolTurn('quno_worker_report', { state: 'ready', summary: '备忘内容：三点会。' }, 'ra-ready-1'),
        textTurn('已提交。'),
      ],
    },
    steps: [
      { kind: 'human', text: '读一下 fixture 目录里的 memo.txt。' },
    ],
    checks: async (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const record = ticket === undefined ? null : await rt.host.taskActivityForClient({ taskId: ticket.id, limit: 50 })
      const items = record?.items ?? []
      const serialized = JSON.stringify(items)
      return {
        chain: [
          check('worker.execution', 'record-reachable', record !== null && record.note === undefined, 'readable record', record?.note ?? 'ok'),
          check('worker.execution', 'task-input-projected', items.some(item => item.kind === 'task-input' && JSON.stringify(item).includes('memo.txt')), 'instruction visible', items.filter(item => item.kind === 'task-input').length),
          check('worker.execution', 'tool-evidence-projected', items.some(item => item.kind === 'tool' && (item as { tool: string }).tool === 'read'), 'read tool call', items.filter(item => item.kind === 'tool').map(item => (item as { tool: string }).tool)),
          check('worker.execution', 'no-system-prompt', !serialized.includes('SECRET') && !items.some(item => item.kind === ('system' as never)), 'whitelist held', []),
          check('worker.execution', 'session-identity-diagnostic', record?.sessionIdentity !== null && record?.sessionIdentity?.sessionId === executorSession(ticket?.id ?? ''), 'executor session id', record?.sessionIdentity ?? null),
        ],
        semantics: [
          replyContainsFact('fact-memo', '三点会', rt),
        ],
      }
    },
    budget: { maxDurationMs: 90_000, maxModelCalls: 8 },
  },
  {
    id: 'task-activity-redaction',
    title: '执行记录脱敏：token/env/推理块/长输出不出 Host',
    priority: 'p0',
    requirement: '伪造 token 参数、环境回显、推理文本与超长输出的会话经 taskActivity 投影后全部过滤或截断并标 truncated',
    tags: ['interaction', 'activity', 'redaction'],
    model: { router: 'scripted', worker: 'scripted' },
    scripts: {
      router: [
        toolTurn('quno_task', { title: '脱敏验收', prompt: '提交一份 blocked 报告带具体问题。' }, 'rd-delegate-1'),
        textTurn('好，我来核对，有需要我会问你。'),
        textTurn('这一步需要你确认：继续使用哪个账号？'),
      ],
      worker: [
        toolTurn('quno_cli_call', { capability: 'yzj', operation: 'im.message.list', params: { groupId: 'g1' }, token: 'SECRET-TOKEN-XYZ' }, 'rd-cli-1'),
        toolTurn('quno_worker_report', { state: 'blocked', summary: '登录态失效。', question: { question: '继续使用哪个账号？' } }, 'rd-blocked-1'),
        textTurn('已如实报告。'),
      ],
    },
    steps: [
      { kind: 'human', text: '查一下云之家消息；如果登录失效就问我。' },
    ],
    checks: async (rt) => {
      const repo = rt.host.repo
      const ticket = repo.listTickets(rt.host.qunoId, { limit: 5 }).at(-1)
      const record = ticket === undefined ? null : await rt.host.taskActivityForClient({ taskId: ticket.id, limit: 50 })
      const items = record?.items ?? []
      const serialized = JSON.stringify(items)
      return {
        chain: [
          check('worker.execution', 'token-never-leaves-host', !serialized.includes('SECRET-TOKEN-XYZ'), 'scrubbed', serialized.includes('SECRET-TOKEN-XYZ')),
          check('worker.execution', 'cli-call-shown-redacted', items.some(item => item.kind === 'tool' && (item as { tool: string }).tool === 'quno_cli_call'), 'cli call visible as a redacted summary', items.filter(item => item.kind === 'tool').map(item => (item as { tool: string }).tool)),
          check('worker.execution', 'display-bucket-from-declaration', items.some(item => item.kind === 'tool' && (item as { display: string }).display === 'read-messages'), 'read-messages', items.filter(item => item.kind === 'tool').map(item => (item as { display: string }).display)),
        ],
        semantics: [
          replyContainsFact('fact-question-relayed', '哪个账号', rt),
        ],
      }
    },
    budget: { maxDurationMs: 90_000, maxModelCalls: 8 },
  },
]
