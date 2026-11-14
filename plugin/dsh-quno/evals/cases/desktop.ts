/**
 * Cases that need a different verification layer than the Host link (L4) or a
 * composition the eval harness deliberately does not mount. They stay in the
 * registry as `blocked` so the report is honest about coverage instead of
 * silently missing cases (design §2, §12).
 *
 * @module dsh-quno/evals/cases/desktop
 */

import type { BlockedCase } from '../case.ts'

export const desktopCases: readonly BlockedCase[] = [
  {
    id: 'desktop-entry',
    title: 'Quno 入口、zw.9 归属选中、普通会话切换无残留',
    priority: 'p1',
    reason: 'L4 Desktop DOM 层：需要真实桌面 runtime 与浏览器 DOM 断言，Host 链路评测器不覆盖',
  },
  {
    id: 'desktop-task-card',
    title: '任务卡 → 面板 → Executor 只读视图与真实状态一致',
    priority: 'p1',
    reason: 'L4 Desktop DOM 层：需要真实桌面 runtime 与浏览器 DOM 断言，Host 链路评测器不覆盖',
  },
  {
    id: 'compaction-recall',
    title: '真实压缩后通过引用/全文召回旧结果，不编造',
    priority: 'p1',
    reason: '需要挂载 compaction realm（agentPresets 注册表 + compaction Provider）；当前评测组合用 setup 直挂 preset 工具面，压缩链路属 L4 或后续挂注册表后补',
  },
  {
    id: 'burst-100',
    title: '100 条突发 Trigger 只产生有界 Eval 批',
    priority: 'p1',
    reason: '批处理经济性已由 tests/eval-flow.test.ts 结构化覆盖（100→2×20）；真实模型回合的 100 条批量评测待 P1 扩展',
  },
  {
    id: 'two-threads-timeout',
    title: '一个 Thread 超时不影响另一个',
    priority: 'p1',
    reason: '需要真实模型回合的 Eval 超时（候选交付计时 + 重排两次）；待 Live 门禁接入后补',
  },
  {
    id: 'feedback-cas',
    title: '用户反馈与模型提交竞争时保留用户状态',
    priority: 'p1',
    reason: 'expectedRevision CAS 已由 tests/client-view.test.ts 覆盖 UI 层；跨回合竞争的模型回合评测待补',
  },
  {
    id: 'notification-flush',
    title: 'flush 不明时按 messageId 对账，不盲发',
    priority: 'p1',
    reason: '对账矩阵已由 outbox 单测覆盖 uncertain/absent 分支；需持久 session journal 崩溃窗口注入后补端到端',
  },
  {
    id: 'exchange-restart',
    title: 'Exchange 请求后重启、晚到/超时/取消语义正确',
    priority: 'p1',
    reason: '依赖 E2 故障注入矩阵（§10 每个事务边界）；当前已注入 crash/restart 与 failNextEffect，Exchange 专用窗口待补',
  },
]
