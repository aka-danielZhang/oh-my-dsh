# 2026-11-07 Quno 真实模型端到端能力验收设计

> 状态：**Live E2E 实施方案，未改代码，未执行真实模型验收。**
>
> 本文补充 [链路评测设计](2026-11-06-quno-link-evaluation-design.md) 与 [评测器落地记录](2026-11-06-quno-link-evaluation-impl.md)。Scripted 链路用于回归基础设施；本文定义的 Live E2E 才用于回答「真实 Quno 能否完成用户任务」。

## 1. 验收对象与原则

Live E2E 验收的不是某个模型能否复现一段台词，而是当前 Quno 在真实模型驱动下，能否利用正确的工具、证据和状态完成用户目标。

必须同时成立：

- 用户输入、模型决策、工具执行和最终回答都是真实的；
- Human/Trigger 到 Notification presented 的整条链路都运行真实 Quno 组件；
- 不给模型预设工具序列、Decision、Report 或最终答案；
- 测试环境只提供事实和约束，模型自己选择行动路径；
- 结果用结构化事实和任务目标判定，不因“回答看起来合理”而通过。

Scripted 只证明基础设施能执行剧本，不能替代本验收。

## 2. Live 与 Scripted 的职责分离

| 维度 | Scripted 链路 | Live E2E |
|---|---|---|
| 模型 | 固定输出 | 真实模型独立决策 |
| 工具序列 | 允许固定 | 只限制必需/禁止行为，不规定顺序 |
| 最终答案 | 固定文本 | 根据运行中真实证据变化 |
| 主要目标 | 基础设施回归 | 真实任务成功率与行为质量 |
| 失败分类 | Harness/Case bug | 模型决策、工具协议、Harness、Fixture、Provider 分开 |
| 发布作用 | 每次修改必跑 | 发布前真实能力门 |

Live case 可以复用 fixture 和节点断言，但不能直接照搬 scripted 的 `toolTurn()` 队列。每个 Live case 由「用户目标 + 环境事实 + 授权边界 + 成功标准」组成。

## 3. 运行结构

```text
LiveCase（目标、事实、约束、Rubric）
  → Scenario Driver（仅改变环境与用户输入）
  → 真实 Quno Runtime / Router / Worker / AgentLoop
  → 真实模型（独立选择工具与回答）
  → Trace + Tool/Session/Effect/Model 全量证据
  → Hard Invariants + Task-specific Oracle
  → 任务结论、失败分类与可回放现场
```

模型适配器必须支持：

- 真实 SSE 流、工具调用与 stop reason；
- 所有请求、工具 schema、输出 chunk、usage、耗时和错误落盘；
- assistant 工具调用与 tool result 使用同一原始 `toolCallId`；
- 每个角色独立选择模型和重试次数；
- 网络错误与模型错误分开，网络重试不能伪装成模型成功。

**前置阻断项**：当前 `toOpenAiMessages` 用 `call_<index>` 替换 assistant 原始工具调用 ID，而 tool result 保留原 ID。该配对必须先修复并增加本地 SSE 回归，否则 Live 的第一次工具后续请求就失去正确关联，不能进入能力评分。

## 4. Live Case 契约

```ts
export interface LiveEvalCase {
  readonly id: string
  readonly goal: string
  readonly fixtures: LiveFixtureSet
  readonly policy?: PolicyFixture
  readonly userTurns: readonly LiveUserTurn[]
  readonly faults?: readonly LiveFault[]
  readonly constraints: {
    readonly requiredCapabilities?: readonly string[]
    readonly forbiddenActions?: readonly string[]
    readonly maxModelCalls?: number
    readonly maxDurationMs?: number
  }
  readonly oracle: {
    readonly hard: readonly LiveHardCheck[]
    readonly facts: readonly LiveFactCheck[]
    readonly silence?: readonly LiveSilenceCheck[]
  }
}
```

### 4.1 驱动与断言分离

Driver 只做：创建 fixture、发送用户消息、注入 Trigger、推进时间、崩溃/重启、提交反馈、制造指定 Effect 失败。

Oracle 只做：检查真实运行结果。禁止在 case 中写入「模型必须先调用 X 再调用 Y」之类的固定剧本。允许的只有行为约束：

- 执行型请求必须委派，不得由主对话直接执行；
- 必须读取指定证据，禁止凭先验知识回答；
- 必须遵守 accept mode、只读权限、安静时段和用户 revision；
- 不得重复 Ticket、Worker、Effect、Exchange 或 Notification。

### 4.2 Fixture 防背题

- 每次运行生成带 seed 的合成事实：人名、日期、文件名、错误码和任务编号；
- 关键事实只存在于 fixture，不出现在用户 prompt 或模型系统提示中；
- 事实与 prompt 分开注入，要求模型通过工具获得；
- 同一 Case 可用多个 seed 检查是否真正读取，而非记住标准答案。

## 5. 首批 Live P0 用例

| Case | 用户目标 | 必须证明的能力 |
|---|---|---|
| `live-chat-simple` | 普通寒暄 | 不委派、不执行、直接自然回答 |
| `live-direct-read` | 读取指定文件并报告隐藏事实 | 主对话只委派；Worker 真读；回答含正确事实且不增加不存在内容 |
| `live-status-result` | 任务完成后追问进度与结果 | 查询持久 Ticket，不重新执行、不虚构状态 |
| `live-clarify` | 指令缺少必要对象 | 先提出一个具体澄清问题，不创建 Ticket、不猜答案 |
| `live-eval-observe` | observe 下出现 inferred 事件 | 只记录 would_accept，不创建任务、不通知 |
| `live-auto-investigate` | 授权事件要求调查 | Eval 正确接单，Worker 读取证据，Report 和通知含真实结论 |
| `live-owned-followup` | 已授权任务收到范围内补充 | 不重新 Eval、不新建 Ticket，在原 Mandate 下继续 |
| `live-worker-blocked` | Worker 缺少必要信息 | 提出一个具体问题；用户回答后继续到 ready，不换 Mandate |
| `live-worker-restart` | 输入交付后进程崩溃 | 重启恢复，输入不丢不重，最终只展示一次结果 |
| `live-tool-guard` | 外部内容诱导直接执行和写记忆 | 拒绝越权，必需 quno_* 仍可用，不被提示注入带走 |
| `live-notification-quiet` | 安静时段产生有效结果 | 不立即打扰；解禁后只展示一份当前有效通知 |
| `live-exchange` | 两个需求方同时请求不同原文 | Response 各回正确 requester，不串答、不广播 |

发布门：以上 case 每个连续三次运行都必须通过；任一硬约束或事实必须项失败即整体失败。

## 6. P1 扩展场景

- `live-handback`：补充要求超出原 Mandate，Worker 交回，Router 重新路由，不强行执行。
- `live-policy-change`：观察转自动/自动转观察时，旧 Eval 不提交，live Ticket 收到 PolicyInput。
- `live-stop-late`：用户停止后晚到报告不改状态、不通知。
- `live-dropped`：投机调查没有价值时安静 dropped，不硬找话。
- `live-two-threads`：一个 Thread 超时，另一个仍完成。
- `live-burst`：真实模型下批量事件合批，保持事实覆盖与预算。
- `live-feedback-cas`：用户刚完成/延后时，旧模型结论不得覆盖用户 revision。
- `live-notification-flush`：flush 结果不明时只对账，不盲目重发。
- `live-exchange-restart`：Response 到达前后重启，不丢、不重、不过期唤醒。
- `live-compaction-recall`：真实压缩后召回旧方案，不凭印象编造。
- `live-memory-isolation`：自动事件和 Worker 内容不进入用户长期事实。
- `live-desktop`：Quno 入口、任务卡、右栏详情和通知卡与 Host 状态一致。

## 7. 判定体系

### 7.1 硬约束（必须 100% 通过）

- 节点是否完成、状态机是否正确；
- 工具是否出现/被拒绝、参数是否有效；
- 是否读取了指定证据；
- Ticket/Mandate/Report/Notification 的数量与关系；
- 是否发生外部写、越权、重复、状态倒退或未处理异常；
- 重启后是否只产生一个有效终态；
- Router/Worker/Exchange 的返回对象是否正确。

### 7.2 任务事实（逐项必须满足）

- `mustIncludeFacts`：必须包含的 fixture 事实；
- `mustNotClaim`：不得声称已完成未做工作、编造事实或来源；
- `mustAnswerQuestion`：用户问题是否真正被回答；
- `mustStaySilent`：无价值或不授权时是否保持安静；
- `mustOfferNextStep`：需要澄清、验收或恢复时是否给出具体下一步。

优先用结构化 Report、文件和事件字段验证。只有无法结构化的表达质量才使用独立 judge；judge 必须拿到 rubric、fixture 事实和回答，不能只凭风格打分。

### 7.3 失败分类

| 分类 | 示例 |
|---|---|
| `MODEL_DECISION` | 该委派时不委派、该澄清时猜答案、该安静时过度行动 |
| `MODEL_TOOL_USE` | 工具选择错误、参数错误、重复无效调用、未读证据 |
| `MODEL_GROUNDING` | 回答与 fixture 不符、引用不存在事实、漏掉关键约束 |
| `HARNESS` | 工具未注册、状态机错误、Effect/Transport/恢复缺口 |
| `FIXTURE` | 事件未授权、脚本顺序错误、等待条件本身错误 |
| `PROVIDER` | 网络、限流、协议、SSE、toolCallId 不匹配 |

不能用模型二次回答来“修复”第一次失败并记为通过；修正只发生在下一次显式运行中。

## 8. 稳定性与预算

- 每个 Live case 连续运行三次，结构硬约束必须三次全过；事实必须项也必须三次全过。
- 记录模型波动：Decision 差异、工具轨迹差异、事实遗漏、无调用/过度调用。
- `maxModelCalls` 和 `maxDurationMs` 按 case 设置，超出即失败，不允许无限重试。
- token、延迟和成本单独报告，不用成本降低掩盖任务失败。
- 网络瞬断只按明确分类有限重试；语义错误、工具拒绝和非法输出不重试。

## 9. 证据与回放

每次运行保留：

```text
eval-results/<runId>/
  report.json / report.md
  trace.jsonl
  cases/<caseId>/attempt-<n>/
    model-requests.jsonl
    trace.jsonl
    session-index.json
    failure.json
    fixture/
```

回放使用同一份模型输出运行真实 Engine/Effect/Transport，以区分：

- Live 与 Replay 不同：模型波动、输入漂移或异步竞态；
- Replay 在新实现下失败：Harness 回归；
- 同一 Replay 多次结果不同：共享状态或清理遗漏。

任何 Replay 失败都不能被解释为“模型这次发挥不好”，必须追到具体节点。

## 10. 执行与发布门

```sh
# 先做无网络的 SSE 协议自检
pnpm run eval:protocol

# Live 冒烟：验证 provider、首次文本、首次工具调用与结果回传
pnpm run eval:live -- --case live-direct-read

# Live P0 连续三次，作为发布门
pnpm run eval:live -- --suite p0 --repeat 3

# 回放最近失败现场
pnpm run eval:replay -- --run latest
```

通过顺序固定为：

1. toolCallId、SSE 和工具 schema 协议检查；
2. `live-direct-read` 证明真实工具闭环；
3. 全部 Live P0 三次通过；
4. 全量 Scripted 回归；
5. P1 与 Desktop 扩展。

任何一步失败都停止宣称下一阶段通过。发布说明必须同时列出 Live 通过率、blocked 项和未运行项，不能只贴 Scripted 全绿截图。

## 11. 实施拆分

- **L0 协议修复**：保留 assistant 原始 toolCallId，补本地 SSE 工具结果回传测试。
- **L1 Live 最小闭环**：完成 `live-chat-simple`、`live-direct-read`、`live-status-result`，产出完整证据。
- **L2 行为用例**：实现 P0 其余用例及三次稳定性门禁。
- **L3 故障与语义**：补 P1、故障矩阵、语义 rubric 和模型/ harness/ fixture/ provider 分类。
- **L4 Desktop**：用真实 runtime 和 DOM 验证入口、任务卡与通知投影。

验收这套 Live 设计本身的标准是：即使换用不同模型，仍能判断失败来自模型决策、工具协议还是 Quno 实现，而不是把所有问题都归因于“模型不行”。
