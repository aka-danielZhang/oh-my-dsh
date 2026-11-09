/**
 * Notification-layer cases: notification-quiet (and the dedupe P1 case).
 *
 * @module dsh-quno/evals/cases/notification
 */

import type { EvalCase } from '../case.ts'
import { multiToolTurn, textTurn, toolTurn } from '../models/scripted.ts'
import { check, replyContainsFact, sessionEvents, imMention } from './support.ts'

function hhmm(ms: number): string {
  // Quiet hours are interpreted in the Quno config's timeZone
  // (Asia/Shanghai); format the virtual instant in THAT wall clock.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms))
}

export const notificationCases: readonly EvalCase[] = [
  {
    id: 'notification-quiet',
    title: '安静时段不展示，解禁后只出一份合并汇报',
    priority: 'p0',
    requirement: 'quiet hours 内通知只暂存不投递；解禁后恰好一份 presented，不倾倒旧通知',
    tags: ['notification', 'quiet-hours'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      // A quiet window spanning "now" on the virtual clock (start 09:00).
      const now = rt.now()
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', quietHours: { start: hhmm(now - 30 * 60_000), end: hhmm(now + 30 * 60_000) } } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'nq-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '确认发布窗口', goal: '确认发布窗口并汇报结论。' }, 'nq-decide-1'),
        textTurn('已受理。'),
        toolTurn('quno_notify', { title: '发布窗口确认', summary: '发布窗口确认完成', body: '发布窗口确认：明天 10:00-12:00 可以发布。', why: '结论已确认，值得汇报。' }, 'nq-notify-1'),
        textTurn('结果会在合适的时机通知你。'),
        // The notification turn after quiet hours end.
        textTurn('发布窗口确认：明天 10:00-12:00 可以发布。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'ready', summary: '发布窗口确认：明天 10:00-12:00 可以发布。' }, 'nq-worker-report-1'),
        textTurn('已提交。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('nq-trigger-1', '@Quno 确认一下明天的发布窗口', Date.parse('2026-11-06T09:12:00Z'))] },
      // While quiet hours hold, the notice must stay pending and undelivered.
      { kind: 'waitFor', description: 'notice is quiet-held', until: (rt) => rt.host.store.listNotices(rt.host.qunoId, 10).some(notice => notice.status === 'pending' && (notice.reason ?? '').includes('quiet')), deadlineMs: 30_000 },
      { kind: 'config', patch: { quietHours: null } },
      // The quiet hold pushed eligibleAt past the quiet end; advance past it.
      { kind: 'advanceMs', ms: 31 * 60_000 },
      { kind: 'waitFor', description: 'notice presented', until: (rt) => rt.host.store.listNotices(rt.host.qunoId, 10).every(notice => notice.status === 'presented') && rt.host.store.listNotices(rt.host.qunoId, 10).length >= 1, deadlineMs: 60_000 },
    ],
    checks: (rt) => {
      const notices = rt.host.store.listNotices(rt.host.qunoId, 10)
      const mainUserMessages = sessionEvents(rt, 'quno-main')
        .filter(event => event.type === 'user/message')
        .map(event => event.data as { source?: { kind?: string } })
      const notifyMessages = mainUserMessages.filter(message => message.source?.kind === 'quno-notify')
      const attempts = notices.flatMap(notice => rt.host.store.listNoticeAttempts(notice.id))
      return {
        chain: [
          check('notification.outbox', 'quiet-held-before-release', true, 'held', 'waitFor step proved the hold'),
          check('notification.outbox', 'no-duplicate-notice', notices.length === 1, 1, notices.map(notice => ({ status: notice.status, topicKey: notice.topicKey }))),
          check('notification.presented', 'presented-exactly-once', notifyMessages.length === 1, 1, notifyMessages.length),
          check('notification.presented', 'presented-status', notices.every(notice => notice.status === 'presented'), 'presented', notices.map(notice => notice.status)),
          // One delivery pass: exactly one prepare, no retryable failures.
          // (The presented transition numbers its row from the stored attempts.)
          check('notification.presented', 'no-extra-attempts-after-presented', attempts.filter(attempt => attempt.status === 'prepared').length === 1 && attempts.every(attempt => attempt.status !== 'retryable-failure'), 'one prepared row, no retries', attempts.map(attempt => ({ attempt: attempt.attempt, status: attempt.status }))),
        ],
        semantics: [
          replyContainsFact('fact-window', '10:00-12:00', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 10 },
  },
  {
    id: 'notification-dedupe',
    title: '同主题通知合并，不重复打扰',
    priority: 'p1',
    requirement: '同 topicKey 的第二条通知合并进第一条；只展示一次',
    tags: ['notification', 'dedupe'],
    model: { router: 'scripted', worker: 'scripted' },
    setup: async (rt) => {
      await rt.host.updateConfig({ patch: { acceptMode: 'auto', quietHours: null } })
    },
    scripts: {
      router: [
        toolTurn('quno_eval', {}, 'nd-eval-1'),
        toolTurn('quno_eval_decide', { kind: 'accept', title: '跟踪发布状态', goal: '跟踪发布状态。' }, 'nd-decide-1'),
        textTurn('已受理。'),
        // Both notify calls happen in ONE model turn: the model emits two tool
        // calls, the Host merges the second into the same topic.
        multiToolTurn([
          { name: 'quno_notify', args: { title: '发布进度', summary: '发布进行中', body: '发布进行中：50%。', why: '有实质进展。', topicKey: 'release-status' }, id: 'nd-notify-1' },
          { name: 'quno_notify', args: { title: '发布进度', summary: '发布进行中', body: '发布进行中：80%（合并更新）。', why: '同一主题的实质进展。', topicKey: 'release-status' }, id: 'nd-notify-2' },
        ]),
        textTurn('同一主题的更新已合并，不会重复打扰。'),
        // The notification turn renders from the merged notice payload.
        textTurn('发布进度：50%，进展会合并汇报。'),
      ],
      worker: [
        toolTurn('quno_worker_report', { state: 'ready', summary: '发布进行中：50%。' }, 'nd-worker-report-1'),
        textTurn('已提交。'),
      ],
    },
    steps: [
      { kind: 'ingest', envelopes: [imMention('nd-trigger-1', '@Quno 跟踪一下发布状态', Date.parse('2026-11-06T09:15:00Z'))] },
    ],
    checks: (rt) => {
      const notices = rt.host.store.listNotices(rt.host.qunoId, 10)
      const notifyMessages = sessionEvents(rt, 'quno-main')
        .filter(event => event.type === 'user/message')
        .filter(event => (event.data as { source?: { kind?: string } }).source?.kind === 'quno-notify')
      return {
        chain: [
          check('notification.outbox', 'merged-into-one-notice', notices.length === 1, 1, notices.map(notice => ({ topicKey: notice.topicKey, status: notice.status }))),
          check('notification.presented', 'presented-once', notifyMessages.length === 1, 1, notifyMessages.length),
        ],
        semantics: [
          replyContainsFact('fact-progress', '50%', rt),
        ],
      }
    },
    budget: { maxDurationMs: 120_000, maxModelCalls: 12 },
  },
]
