# 2026-10-23 Quno 三份提案合并为单一开发说明

## 决策

将 2026-10-22 的三份 Quno 提案合并为唯一权威开发说明 [`docs/quno-bot-design.md`](../quno-bot-design.md)：

- `2026-10-22-quno-bot-design.md`（主对话/委派子任务/激进压缩/召回）
- `2026-10-22-quno-event-stream-design.md`（Sense 采集/事件流/关注事项/通知 outbox）
- `2026-10-22-quno-sense-contract.md`（Sense 定义、原则、生命周期、接入门禁）

三份 notes 保留为决策历史不再维护；此后 Quno 契约变更走「同 PR 改主题文档」纪律。

## 合并时的对齐结论（冲突点的裁决）

1. **命名**：采集器统一为 **Sense（感知器）**，接口 `registerSense`/`ingestBatch`/`reportHealth`，服务 `ctx.qunoSenses`/`ctx.qunoIngress`——以 Sense 契约文档为准。
2. **调度**：思考 tick 用 Quno 自有到期队列（唤醒前需无模型预检），原生 Schedule 只保留给用户显式提醒（投递进主对话，契合单对话承诺）。裁决掉主对话稿「直接用 Schedule 做例程」的写法。
3. **存储**：Quno 业务状态用专用 SQLite（`$DSH_HOME/quno/quno.sqlite`），不用 DSH storage domain KV（无跨表事务契约）；主对话绑定表随之迁入 `qunos` 表。
4. **子任务回流通道统一**：委派子任务的完成通知与 Sense 主动汇报**共用同一条通知 outbox**（去重/安静时段/对账语义一致），不再单独自管 settlement 注入；崩溃恢复沿用「子会话 durable + 消息 id 先持久化」对账。
5. **首版行动范围**：子任务 v1 限只读执行（调研/整理/汇总），对外写操作与审批卡（Grok 三档）同属后续阶段——与事件流稿「先验证个人助理闭环」一致。
6. **记忆纪律**：OhMyMemo 只读召回 + 显式写入；短期指令存 Quno 状态（「今天别提醒」不提升为长期偏好）；分析会话与自动汇报排除出梦境提取来源。
7. **压缩定位**：事件原文永不进主对话上下文（只有汇报/回流 notice 进），主对话天然增长缓慢；激进压缩（~50% 触发 + 指针摘要 + `quno_recall` 召回）是永久对话的第二道防线，保留为主对话层设计。
8. **会话三分**：主对话（完整能力）/ 分析运行（受限只读 preset）/ 委派子任务（subagent，v1 只读）三类会话分别定义能力面。

## 边界

合并只涉及文档，无代码；三份原始 notes 按纪律不改写。两份 2026-10-22 提案中与本说明冲突处，以 `docs/quno-bot-design.md` 为准。
