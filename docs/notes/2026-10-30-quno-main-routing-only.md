# Quno 主对话只路由、不直接执行

## 实证问题

主会话 `session-b336b0f3-d8cd-4059-aa1d-67489cec3992` 的 durable 日志显示：模型可用工具共 39 个，`quno_task` 在其中，但实际调用为 **61 次 `bash`、0 次 `quno_task`**；最后一轮也直接执行 `bash` 与 `read_image`。这证明不是委派工具未挂载，而是主 preset 同时提供直接执行工具，且提示词只要求「耗时工作」委派，允许模型把请求判断为简单工作后自己完成。

## 决策

主对话是中转秘书，只负责判断、快速应答、历史召回、关注/记忆/提醒管理、澄清和结果转述。凡需要独立执行或依赖外部证据的任务，一律立即 `quno_task`，不枚举用户可能提出的工作类型，也不得以「简单」「只查一下」为由自己执行。`quno_task` 返回后本轮立即结束；结果回流后只转述，不重新执行。

约束同时落在两层：

1. `quno` preset 移除 shell、文件、网页、Skill、Goal、Jobs、Todo 等直接执行工具，只保留 Quno 自有工具、`schedule_*`、`ask_user_question` 与 `present`。另以 `MAIN_ROUTING_TOOLS` allow-list 隐藏全局/MCP 执行工具，并以 `tools.guard` 拒绝其他作用域晚注册的执行调用，不能只靠提示词自觉。
2. `QUNO_GUIDANCE` 与 `quno_task` 描述改为全量强制委派，明确快速应答和结果转述语义。闲聊、基于现有对话直接回复，以及 Quno 状态和历史管理不要求委派。

`quno_task` 同时提供 `start`（默认）、`status`、`result` 三种 action。查询读取 `QunoTask` 持久记录，返回状态、结果、错误和 childSessionId；原生 `list_agents` 只提供 running/inactive，activation.result 又只在进程内，因此不以原生接口替代这条跨重启查询路径，也不要求主对话反复轮询。

子任务仍遵守首版只读边界；本次不开放写操作，也不改 Harness AgentLoop。

## 验证

- `tests/dsh-quno.test.ts` 断言主 preset 不含直接执行工具，并保留委派、提醒、澄清、展示与压缩配置。
- `tests/main-agent.test.ts` 使用真实 AgentLoop、真实工具注册表与脚本化模型：用户要求读取云之家并整理建议时，唯一工具调用为 `quno_task`，随后直接回复已交后台；无额外调研回合。后续分别以 `status` 查询进行中状态、`result` 取回已完成结果，均读取持久任务记录。另在根注册表注入 `bash`，验证全局执行工具不会到达模型。
- `dsh-quno` 全套 142 项测试与构建通过；构建产物包含 allow-list、执行 guard 和强制委派提示，主 preset 产物无 shell/文件/网页/Skill/Goal/Todo 行。
- 指定会话的工具清单与调用计数来自实际 JSONL 解压核查，不依赖对产品行为的猜测。
