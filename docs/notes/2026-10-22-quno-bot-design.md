# 2026-10-22 Quno Bot 设计立项

## 决策

为「Quno」小 Bot 立项设计：一个 Quno 绑定**一条永久主对话**（无新建会话），任务型意图后台启动子代理执行、结果回流主对话，主对话**激进滚动压缩**（~50% 触发，摘要带原文指针），全量历史靠 `sessionQuery` 全文检索召回（`quno_recall` 工具），长期记忆原样复用 dsh-ohmymemo。

完整交互与技术设计（架构、回流协议、崩溃对账、压缩参数、UI 槽位、分期路线图）见权威文档 [`docs/quno-bot-design.md`](../quno-bot-design.md)。

## 关键选型理由

- **不自建调度器**：复用 harness Schedule（投递进主会话，契合单对话承诺）；`dsh-scheduled-tasks` 退役教训已吸收。
- **子任务回流自管而不用内建 `delivery: 'parent'`**：内建投递要求父代理 live 且只是纯文本；自管回流 + 启动对账（子会话 durable，崩溃后续跑或补投递）才撑得起任务卡与桌面退出场景。
- **压缩用 dsh-compaction-hierarchical**（已随包发货）：永久主对话的历史可任意大，map-reduce 是必需品；「猛」体现在触发点与尾部保留参数，不换事务模型。
- **壳与桥零改动**：全部落在插件面（新 dual 插件 `dsh-quno`，preset-owned）与 preset 面；通知、回跳、后台保留均由现有桥/壳机制覆盖。
- **设计参考**：Meta Muse（消息感、三层状态、主/侧聊天）与 Grok Bot（持久命名 Bot、独立记忆、审批三档、Routines）；调研结论记录在设计文档 §2。

## 边界

v1 只内置一个 Quno（数据模型按 N 设计）；云端常驻（关机也跑）是独立命题，不在本设计内；开放问题见设计文档 §8。
