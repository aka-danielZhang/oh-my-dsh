# 2026-11-15 Quno Worker 原生会话与工作入口实施记录（v2 交互定稿）

> 状态：**已实施（本 PR）**。目标设计见 [2026-11-14 Quno 单助理对话与 Worker 检查交互/架构设计](2026-11-14-quno-router-worker-product-and-program-design.md)（当前合并版）；契约已收敛回 [Quno 开发说明](../quno-bot-design.md)（§2、§5.3、§13.4、§13.6、§13.6b、§13.7、§15.1，落地记录 §18.4）。本文记录实现落点、设计判断与偏差、验证证据。
>
> 范围：v2 §12 的 P0（主对话降噪，v1 已落地、本轮保持）+ P1（工作列表与原生会话，本轮主体）。P2（活动与复杂状态）与 P3 未动。

## 落点

| 设计项 | 实现 |
|---|---|
| Worker 行列表 | `client/task-list.tsx` 重写：需要你/进行中/已结束三组纯 Worker 行（标题主、Worker 标签辅、状态右列，行内无嵌套按钮）；行点击直开原生 Worker 会话，任务详情中间页退役 |
| 「工作」入口 | `client/work-entry.tsx`（utilities 槽 order 45）：真实活动计数 badge（`activeCount` 含 needs-you、单 badge）、aria 全名、点击只切右栏 |
| Worker 会话 | `client/worker-session.tsx` 三席位：合并 leading 身份（返回 Quno + 任务标题 + Worker 标签 + 状态；single 槽单 cell）、`.actions` 停止/重试（order 20）、`conversation.composer` chain elect（priority -10，只读说明 + 可折叠任务摘要） |
| 导航 | `client/work-navigation.ts`：client-only，returnContext 走 window sessionStorage；`backToQuno`/`returnToMainFromPanel` + 焦点规则（键盘才移焦，`click.detail===0` 判定 + 一次性 focus 旗标） |
| workerDetail Remote | api/service/typert 四层：Host 按 ticketId 解析 executorSessionId（不接受调用方 session id）+ 状态 + 身份回显；`workerOpenFailure` 把 unknown-ticket / session-not-assigned / detail-failed 映射到诚实缺失页（绝不自动建会话） |
| 共享常量 | `presentation.ts`：`workerLabelOf`（FNV-1a 32bit → `Worker 02f803ec` 展示标签）、`EXECUTOR_PRESET`、`EXECUTOR_SESSION_PREFIX` + `executorTicketIdOf`（executor.ts/worker-tools.ts 改引用，host/client 同源） |
| 样式 | `QUNO_WORK_CSS`（`data-plugin-css` 幂等，tag `dsh-quno/worker-css`）：`--dsw-*` token、focus-visible、1100/720/480 三档响应式 |
| 退役 | `taskActivity` Remote（api/service/typert/api-types 全链）、`activity.ts`、`task-activity.tsx`、`task-detail.tsx`、任务卡置空（注册保留遮蔽 stock 卡）；`panel-state.taskSections` 死代码删除；locales 增 15 键（中英双语） |

## 设计判断与偏差

1. **inspect 的客户端半边走 composer chain 接管，而非 fork `interactionMode`**。基线（zw.9）无任何 read-only/interactionMode 概念；`conversation.composer` 是 chain 槽（`overlay: true`），ui-subagent 的 `SubagentReadOnlyComposer` 是同型先例——elect 以 `quno-exec-` 前缀纯谓词认领 executor 会话，其余会话回落 stock 条。组件级接管（非 CSS 隐藏）满足 v2 §9.4 的客户端示例语义。**Host 侧提交门未建**（基线 prompt 路径无模式拒绝），按 fork 流程补通用字段与提交门，在此之前不得声称 Host 级只读——本条记入 §18.4 后续项。程序输入不经 composer，天然不受接管影响（v2 §9.4 不拦程序事件）。
2. **合并 leading 身份**：`conversation.header.leading` 是 single 槽（单 cell，低优先级整体遮蔽），quno 主会话身份与 Worker 身份必须在**同一个注册**内分支渲染；hooks 全部无条件执行（#310 崩溃面教训）。
3. **会话头 chrome 未隐藏**：v2 §6.1 要求不显示「新建会话/模型/权限」等 stock 会话头控件，但整头替换（`conversation.session.header` single）要求插件渲染 stock 组件（纯度门禁止）且不可按会话条件化——记 fork 收敛；本轮 Worker 身份与命令走 additive 槽位。
4. **workerLabel 客户端派生**：v2 §9.1 允许由 ticketId 稳定短哈希派生；FNV-1a 32bit 取 8 位 hex，纯函数可测，不进 wire。
5. **`workPanelOpen` 恒真**：行点击只可能发生在右栏打开时；返回时无条件恢复工作列表。`workPanelVisible` 以 `[data-quno-panel]` DOM 探测保留兜底。
6. **两个 taskActivity evals 随投影退役**（`task-activity-readonly-running`/`task-activity-redaction`）：自绘 transcript 的白名单/脱敏断言失去载体；原生会话的公开数据边界由 DSH 工具卡渲染契约承担，实机验收行进 §15.1。

## 验证

- `pnpm run typecheck` 0 错误；`pnpm run build` 通过（client 8 文件）；`pnpm test` **238 项全绿**——新增 `tests/work-surface.test.ts` 8 项（入口计数与 aria、Worker 行活动矩阵、composer elect 前缀判定、returnContext 编解码、缺失原因映射、backToQuno 存储恢复与降级、focus 旗标一次性、缺失页返回），`presentation.test.ts` 增 `workerLabelOf` 稳定性用例。
- Scripted evals：16 例 runnable 全 pass、无新增失败；9 例既有 blocked（L4 桌面 DOM 层等）与改动前一致；退役 2 例 taskActivity 用例。
- **未在本轮验证**（与 §18.3 惯例一致，发布门前必须补）：桌面 DOM/键盘/读屏/窄屏实机验收（Electron `desktop:dev` + scratch `DSH_HOME`）；v2 §13 的 8 条真实评测（`worker-inspect-reject-submission-while-events-continue` 依赖 fork 提交门）；Live 发布门。

## 后续

- fork：通用 `interactionMode` 字段 + SessionController Host 提交门（v2 §9.4）；QueueDock seam 上收（§18.3 沿用）；会话头 chrome 整头接管评估。
- 实机验收轮：§15.1 两行实机验收 + 键盘/读屏/窄屏。
- P2：真实活动标签细化、persistent resultRevision 合并、详情期刷新提速。

## 同日第二轮：v2 全量核对与补齐

逐节核对 v2 后补齐的缺口：

| v2 条目 | 补齐实现 |
|---|---|
| §6.2 隐藏凭据/环境变量 | 新增 `src/redaction.ts`（纯：denylist 递归 + 凭据文本模式 scrub + 有界）与 `client/tool-cards.tsx`——`quno_cli_call`/`quno_exchange` keyed toolview 遮蔽 stock 原始参数卡；模型幻觉出的未声明 `token` 参数与自由文本密钥一律 `=<已脱敏>` |
| §7.3 读屏语义 | 工作列表改语义化 `ul/li`（每行一个 button）；行状态文本加 `role="status"`（实际变化才播报） |
| §4.2 aria-expanded | 「工作」入口按右栏状态输出 `aria-expanded` |
| §6.3 缺失页焦点 | 缺失页键盘进入时聚焦「返回 Quno」（keyboard 随 WorkerMissing 传递） |
| §9.1/§10 WorkerProjection 增量 | `workerLabel` 进 `TaskWire`（可选）与 `WorkerDetailWire`（必填），client 优先取 wire、派生兜底 |
| §2.3/§2.4 视觉规格 | 摘要正文 14px/22px；按钮换 stock 原语，删除手写 `#fff` 字面色 |
| §13 必加评测 | 新增 `worker-missing-session-no-auto-create`（P0 门，scripted 全绿） |

**8 条必加评测覆盖映射**（v2 §13）：`main-conversation-no-worker-leak` ≈ 存量 `main-task-quiet-success`（LEAK_MARKERS 断言同口径）；`worker-missing-session-no-auto-create` 本轮新增（scripted）；`worker-navigation-does-not-restart`/`worker-result-once-after-restart` 的状态层语义由存量 `worker-restart`/`worker-handback` 覆盖（relay-once/不重启执行）；`work-entry-count-and-empty-state`/`worker-list-open-and-return-keyboard`/`worker-list-narrow-and-long-content`/`worker-inspect-reject-submission-while-events-continue`（依赖 fork 提交门）为 DOM 层 L4，实机验收轮执行。

**核对后仍明确的剩余项（全部依赖 fork 流程）**：§9.4 Host 提交门（通用 `interactionMode` + SessionController 门）、§6.1 stock 会话头 chrome 隐藏（single 槽整头替换）、§10 QueueDock 上收（v1 插件侧克隆退役）。插件侧无法安全实现这三项，需走 `docs/harness-bump/README.md` 的 fork 合并 → zw 发版 → 本仓 bump revision 流程。
