# 2026-11-14 Quno Router/Worker 交互方案实施记录（P0+P1）

> 状态：**已实施（本 PR）**。目标设计见 [2026-11-14 Quno Router/Worker 程序落地与交互总设计](2026-11-14-quno-router-worker-product-and-program-design.md)（保留为决策历史）；契约已收敛回 [Quno 开发说明](../quno-bot-design.md)（§2、§5、§8、§10、§13、§15，落地记录 §18.3）。本文记录实现落点、四处设计判断与偏差、验证证据。
>
> 范围：P0（主对话降噪与文案统一）+ P1（统一任务投影与只读执行记录）。P2 的活动标签细化、详情期刷新提速、persistent 结果合并；P3 全部未动。

## 落点

| 设计项 | 实现 |
|---|---|
| TaskPresentation 纯投影 | `plugin/dsh-quno/src/presentation.ts`（新）：`presentTask` 八态状态机 + `activityKindForTool` 展示声明映射 + `resultRevisionOf`。`service.ticketView`（模型面）与 `api.toTaskWire`（浏览器面）同走此投影 |
| 只读执行记录投影 | `plugin/dsh-quno/src/activity.ts`（新）：`projectTaskActivity` 白名单事件（turn 边界 / user / assistant 公开文本 / tool call+result 配对）、参数 denylist 递归剔除 + 凭据文本模式脱敏（`accessToken=…` 类自由文本同样命中）、reasoning 块剔除、ARGS 400 / RESULT 600 / TEXT 600 有界截断、seq 独占下界游标（旧页面不受追加影响） |
| `taskActivity` Remote | `service.taskActivityForClient` → `api.buildTaskActivity`（Ticket → 最新 Assignment 的 executorSessionId，**不接受调用方 session id**）；`sessionReader()` duck-type `sessionQuery.readSession`；会话缺失/服务缺失返回显式 `note`，不伪造活动。zod 输入 `taskActivityInput`，typert 描述符 21 方法 |
| Relay 沟通准入 | `Engine.report` 调 `reportRelayWorthy(state, hasQuestion)`：`ready`/`failed` 恒 relay；带问题的 `blocked`/`waiting` relay；`progress`/静默 `waiting`/`dropped` 不 relay。Effect key 仍 `ticket.id` 单行合并。Exchange 终态 relay（`settleExchangeFailure`/`inputForExchange`）不变 |
| 第一人称 Router | `QUNO_GUIDANCE`「你只路由，不执行」整节重写（我来做 / 不提后台与内部工具 / 排队、requestId、工具入队不是查询结果 / 失败说明事实与下一步不猜根因 / 普通进展不主动汇报）；`quno_task` description、start/status/result 返回文本同口径；`quno_status` 文案「后台任务」→「任务」；`renderReport` 结尾指令补第一人称与不猜根因 |
| 入队后隐藏 | `client/report-turn.ts` 泛化：匹配四类程序源（quno-eval/report/notify/task），`claimId` 按 notificationId → evalId → `ticketId:assignmentId` 稳定折叠，exclusive + `visibility: 'hidden'`；Quno 真实回复原生渲染。`MessageSourceMap` 六个 quno source 全部声明 `presentation: 'internal'`（`transport.ts`、`outbox.ts`） |
| QueueDock 过滤 seam | `client/queue-internal.ts`（双信号：前向 `presentation` flag + legacy kind 注册表，human 恒放行）+ `client/queue-dock.tsx`（同 id `queue` priority -1 遮蔽条，结构/样式对照锁定基线 stock QueueDock 逐条复刻，locale 复用 conversation NS 的 `queue.*` 键）+ QUNO_QUEUE_CSS 独立 `data-plugin-css` 幂等样式 |
| 任务卡/列表/详情 | `task-card.tsx`（标题/用户状态/有界结果/查看详情，运行中「停止」，失败「重试」）；`task-list.tsx`（需要你/进行中/已结束）；`panel-state.ts`（`taskUserStatus` 含 legacy 回退、`taskSections` 新分区：activity/question/record/diagnostics，record 全状态可进）；`task-detail.tsx`（概览/当前活动/需要你+回答输入/结果产物/执行记录/诊断折叠）；`task-activity.tsx`（新，只读时间线 + 加载更早 + 无任何输入面）；`store.ts`（`loadTaskActivity` AsyncValue + seq 守卫、`taskCommand` 增 `answer`） |
| 文案 | `locales.ts` 全量改用户词汇（已接受/进行中/需要你/未完成/已停止/无需处理；任务指令/补充输入；正在读取最近会话/消息/文件/网页/整理结果/等待你回答/等待后续事件/正在处理），中英双语同步 |

## 四处设计判断与偏差

1. **QueueDock seam 走插件侧同 id 遮蔽，而非 fork**。设计 §7.1 首选「DSH Conversation 通用展示层」接缝，fork 为兜底。评估后取了兜底之外的第三条路：`conversation.input.dock` 是 list 槽，现基线（ui-slots）支持同 id 不同 priority 遮蔽（copy-session-id 先例），因此以**插件侧通用克隆**实现该接缝——组件与注册表零 Quno 业务词汇（过滤信号是 `presentation: 'internal'` + 已注册 kind 集合），克隆的 JSX 结构与 CSS 对照锁定基线的 stock QueueDock 逐条复刻（`QueueDock.tsx` / `QueueDock.module.css`）。代价：纯度门禁止 import stock 组件，结构与样式需随基线手动同步（runtime 锁定使该代价可控）；遮蔽全局生效（所有会话的队列条都过同一过滤器，普通会话只见行为等价的克隆）。fork 上收（小型通用 seam + 本条目退役）记入 §18.3 后续项。
2. **「非法异步请求」的两层事实**。设计 §13.4 的 `main-task-internal-failure-hidden` 假设非法请求落 Exchange 失败证据。实测发现 Router 面的 `requestExchange` 对未知 responder **同步拒绝**（`unknown-responder` 工具错误，零 Exchange 落库）——猜测端点根本进不了队列，天然满足「QueueDock 无程序条目」；真正落持久 error 证据的是 **Worker 面对已挂载 organ 的非法 op**（`failExchange` → `exchange_messages` error 行）。评测用例按真实语义覆盖两层：Router 两次猜测零落库 + Worker 两次非法 op 两条持久证据 + 主对话只收 internal 标记的提问 relay。契约口径不变（§8.3 Exchange 终态回流），只是用例与系统对齐。
3. **`waiting` Report 的处理**。`quno_worker_report` 工具强制 waiting/blocked 必须带 question，因此「静默 waiting」在现行工具面几乎不可达；投影仍按设计实现（无问题的 waiting → `waiting` 状态、不 relay、不打扰），防御未来语义放宽。`reportRelayWorthy` 对 waiting 只认有问题的。
4. **`presentationMeta` 与卡片**。`quno_task` 输出新增 `presentationStatus`（原 `status` 保留 legacy 值），卡片与详情优先读新字段、缺字段回退 legacy（旧缓存快照不崩）。`executorSessionId` 仍在工具输出里（模型可见 meta），但产品面不再展示。

## 其他落地偏差

- **`worker-restart` / `worker-handback` 评测脚本按新 relay 策略收敛**：两 case 原本编码「progress 也 relay」的旧行为（router 脚本里有对应回复轮）；新策略下 progress 不再 relay，移除相应 router 回复并注明原因。
- **redact 扫描器 `sk-` 模式补 `\b` 词边界**：新 case id `main-ta`**`sk-success`** 会命中裸 `sk-[A-Za-z0-9_-]{8,}` 造成全局硬断言误报；加锚后真密钥（引号/空白前）仍命中。
- **`taskCommand` 增 `answer` 动作**（设计 §6.2「回答入口」）：文本经 `noteTicket` 进同一 Ticket（与 `quno_task note` 同管道），不新建任务；wire 沿用 `resume` 表示重试语义。
- **`quno_exchange` 主对话工具卡未做非技术投影**（设计 §7.3）：主对话发起单次 Exchange 的场景当前不存在（Router 只在确定性读取用同步 CLI；Exchange 面留给 Worker），故本版仅记录未实施；若未来主对话发起 Exchange，需补 keyed `tool.call.toolview` 卡。
- **`assistant/message` 的 `interrupted` 无文本事件**也投影为一条「被中断」占位（诚实呈现中断事实），`stream`/`usage`/`error.reason` 等原始字段不出 Host。
- **TaskWire 增量字段全部可选**（`presentationStatus?` 等），旧客户端/旧缓存按 legacy `status` 回退；未新增 SQLite 表、未迁移任何数据。

## 验证

- `pnpm run typecheck` / `pnpm run build`（client 534 kB）/ `pnpm test`：220 项 node:test 全绿；新增 `tests/presentation.test.ts`（状态机矩阵/活动映射/origin/revision）、`tests/activity.test.ts`（白名单/脱敏/配对/分页稳定性）、`tests/queue-internal.test.ts`（双信号/放行/disposer）、`core-domain.test.ts` 增 3 条 relay 准入用例；`panel-state`/`client-store`/`effects-transport`/`eval-agent` 按新契约更新。
- Scripted 链路评测（`pnpm run eval`）**全量通过**：新增 5 条 P0 交互用例全部 pass；存量 25 条 runnable 全 pass（`worker-restart`/`worker-handback` 按新策略收敛后恢复）；9 条 blocked 与改动前一致（L4 桌面 DOM 层与 compaction 挂载等，非本 PR 引入）。
- **未在本轮验证**：真实桌面（Electron `desktop:dev` + scratch `DSH_HOME`）下的 QueueDock 遮蔽实机断言、任务详情右栏 DOM 行为、Live 发布门（`live-p0` 连续三次全绿）——与既有惯例一致，留待实机验证轮；发布门前必须补。
