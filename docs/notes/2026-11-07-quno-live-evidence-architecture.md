# 2026-11-07 Quno Live 执行身份与证据架构

> 状态：**实施方案，未改代码。**目标不是给现有 JSON 随意补字段，而是用一条统一证据链描述「哪个模型、在哪个 session/turn、做了什么、花了多少 token、产生什么结果」。
>
> 本文承接 [Live E2E 验收设计](2026-11-07-quno-live-end-to-end-evaluation.md)，不增加新测试框架或依赖。

## 1. 设计原则

1. **配置与执行分离**：用户选择的是 `ModelPlan`，不是散落各处的环境变量。
2. **身份随调用传播**：`sessionId/turnId/stepId` 与模型请求同时进入证据，不靠文本推断或事后猜测。
3. **事实与汇总分离**：原始请求和事件是唯一事实源，报告只负责确定性聚合。
4. **真实用量优先**：token 使用 provider 返回值；没有返回就记 `null`，不估算、不补零。
5. **一个证据包即可解释**：不读代码也能还原当时模型、输入、工具、状态、用量和失败节点。

核心只需三个对象：

- `ModelPlan`：本次运行使用哪些模型路由；
- `ExecutionContext`：当前调用处于哪个 Case/Session/Turn/Stage；
- `UsageLedger`：按请求、角色、模型、Session、Stage、Case、Run 聚合用量。

## 2. ModelPlan：统一模型配置

### 2.1 类型

```ts
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly baseUrl: string
  /** 只记录引用，不记录密钥值。 */
  readonly credentialRef: 'env:QUNO_EVAL_LIVE_API_KEY' | 'env:DEEPSEEK_API_KEY'
  readonly temperature?: number
  readonly maxTokens?: number
}

export interface ModelPlan {
  readonly router: ModelRoute
  readonly worker: ModelRoute
}
```

默认值用同一条路由，必要时 Router/Worker 分开。ModelRoute 不包含实际密钥，也不会把 baseUrl 中的 query credential 写进证据。

### 2.2 配置解析顺序

只保留一个 `resolveModelPlan()`：

```text
内置默认路由
  → 环境默认路由
  → Case 覆盖（可选）
  → CLI 覆盖（优先级最高）
```

环境提供 `QUNO_EVAL_LIVE_MODEL/BASE_URL/API_KEY`；CLI 提供：

```sh
--router-model <model>
--worker-model <model>
--base-url <url>
--model <model>          # 同时覆盖两个角色的便捷写法
```

示例：

```sh
QUNO_EVAL_LIVE_API_KEY=... pnpm run eval:live -- \
  --suite p0 \
  --router-model deepseek-chat \
  --worker-model deepseek-reasoner \
  --repeat 3
```

`resolveModelPlan()` 同时返回**请求路由**与 provider `resolveModel()` 后的**实际路由**，避免把内部角色名 `router/worker` 误当成真实模型 ID。

## 3. ExecutionContext：执行身份传播

### 3.1 不可变的 Run Context

```ts
export interface RunContext {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  readonly seed: string
  readonly modelPlan: ModelPlan
  readonly startedAt: number
}
```

它在 case 开始时固定，后续所有证据都带 `runId/caseId/attempt/seed`。

### 3.2 随节点变化的 Node Context

```ts
export interface NodeContext {
  readonly stage: StageName
  readonly sessionId: string
  readonly turnId?: string
  readonly stepId?: string
  readonly refs: {
    readonly triggerIds?: readonly string[]
    readonly threadId?: string
    readonly evalId?: string
    readonly decisionId?: string
    readonly ticketId?: string
    readonly assignmentId?: string
    readonly workerRunId?: string
    readonly exchangeId?: string
    readonly notificationId?: string
  }
}
```

Driver 在进入节点时创建 NodeContext，并原样传给 ModelGateway、Tool/Effect handlers、Notification Outbox 和 TraceRecorder。ModelGateway 不再接收一个没有会话语义的 `GenerateOptions` 就结束。

Router 默认 `sessionId='quno-main'`；Worker 使用实际 `quno-exec-<ticketId>`。Turn/Step 从真实 DSH 事件读取，不自行发明编号。

## 4. 统一证据模型

### 4.1 一次模型请求

```ts
export interface ModelRequestRecord {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  readonly seq: number
  readonly role: 'router' | 'worker'

  readonly execution: {
    readonly requested: ModelRoute
    readonly resolved: {
      readonly provider: string
      readonly model: string
      readonly baseUrl: string
    }
  }

  readonly sessionId: string
  readonly turnId?: string
  readonly stepId?: string
  readonly stage: StageName
  readonly refs: NodeContext['refs']

  readonly startedAt: number
  readonly durationMs: number
  readonly request: {
    readonly messageCount: number
    readonly lastUserText: string
    readonly toolNames: readonly string[]
    readonly fingerprint: string
  }
  readonly output: {
    readonly text: string
    readonly toolCalls: readonly { readonly id: string; readonly name: string; readonly arguments: string }[]
    readonly finish: string
    readonly error?: string
  }
  readonly usage: TokenUsage | null
  readonly replayChunks: readonly StreamChunk[]
}
```

这份记录同时回答：模型是谁、在哪个 Session/Turn/Stage、用了哪些工具、结果如何、是否可回放、消耗多少 token。

### 4.2 TokenUsage

```ts
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedInputTokens?: number
  readonly source: 'provider'
}
```

`totalTokens = inputTokens + outputTokens`，由代码计算。Provider 未返回 usage 时整个字段为 `null`，不写 `0` 冒充已知值。若 provider 支持 cache 命中统计，`cachedInputTokens` 使用原始返回；不支持则省略。

### 4.3 证据包

```text
eval-results/<runId>/
  run.json                    # 不可变 ModelPlan、环境、seed、开始/结束时间
  report.json / report.md     # 汇总与失败分类
  events.jsonl                # 统一 stage trace
  requests.jsonl              # §4.1 模型请求
  sessions/
    <sessionId>/events.jsonl  # 必要的脱敏 Session 证据
  cases/<caseId>/attempt-<n>/
    trace.jsonl
    model-requests.jsonl
    failure.json
```

`run.json` 和请求记录是事实源；`session-index.json` 不再需要只写 `main/prefix`，而是从真实 refs 生成完整的 Session ↔ Ticket/Assignment/Run 映射。

## 5. UsageLedger：从请求到汇总

UsageLedger 只消费 `ModelRequestRecord`，不另起一套计数器：

```text
ModelRequestRecord.usage
  → byRole(router/worker)
  → byModel(provider/model)
  → bySession(sessionId)
  → byStage(stage)
  → byCase(caseId)
  → byRun(runId)
```

每份汇总包含：

```ts
export interface UsageSummary {
  readonly modelCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cachedInputTokens?: number
  readonly usageMissing: number
  readonly durationMs: number
}
```

`usageMissing` 表示有多少请求没有 provider usage，避免把“没有数据”误读成“零消耗”。durationMs 与 modelCalls 分别保留，不能混用 token 数与工具调用数。

报告同时提供：

- 全 run 汇总；
- Router/Worker 分列；
- 每个模型 ID 分列；
- 每个 case 的总量与逐请求明细；
- 失败 case 的 token 与失败阶段；
- 与上一 run 的用量差异，但不用成本变化掩盖正确性变化。

## 6. 配置、记录与回放的同一模型

Live 和 Replay 共用 `ModelPlan`：

- Live 按实际 route 发请求并记录 resolved model；
- Replay 默认沿用原 ModelPlan 与原始输出；
- Replay 的 fingerprint 同时包含 route、prompt、tool schema、session/turn/step 和角色；
- 换模型、换 session、漏掉工具或 prompt 漂移都明确报错，不模糊匹配。

这样可以回答：这次回答差异来自模型、Session、上下文、工具面还是 Harness。

## 7. 隐私与边界

- `credentialRef` 可以记录，密钥值永不记录；
- baseUrl 只保留 scheme/host/path 的必要部分，query 中的 key/token 一律丢弃；
- 默认只写合成 fixture；真实 session 内容按统一 redactor 脱敏；
- usage 可记录但不自动接价格系统，成本需要价格配置时单独计算，避免把不同模型价格写死；
- `usageMissing` 与真实 `0` 区分，未知消耗不能当成零消耗。

## 8. 对现有代码的最小改造

| 现有位置 | 改造 |
|---|---|
| `evals/cli.ts` | 用 `resolveModelPlan()` 替代单次 `liveConfigFromEnv()`；支持角色级 CLI 覆盖 |
| `evals/runtime.ts` | 在进入节点时生成 NodeContext 并传给 ModelGateway/Effect/Trace |
| `evals/models/gateway.ts` | 保留实际 provider/model/baseUrl；把 session/turn/step/refs 和 usage 写入请求记录 |
| `evals/persistence.ts` | 提供 Session/Turn/Step 索引，不只保存 main/prefix |
| `evals/report.ts` | 用 UsageLedger 派生 run/role/model/session/stage/case 汇总 |
| `evals/protocol.ts` | 增加 model 配置解析、session 身份、usage missing、toolCallId 配对测试 |
| `evals/README.md` | 写明角色级模型设置、证据字段与分析方式 |

无需引入新的库；使用现有 `tsx`、AgentLoop、LlmAdapter 和 JSONL 证据。

## 9. 验收标准

- 能用一个 `--model` 同时设置两角色，也能分别设置 Router/Worker 模型。
- 每个模型请求都能直接读出真实 provider/model、sessionId、turnId/stepId、stage 和 refs。
- `report.json` 能按 role/model/session/stage/case/run 汇总 input/output/total tokens、modelCalls、durationMs 与 usageMissing。
- provider 不返回 usage 时报告为 unknown，而不是 0。
- 任意两个 case/run 可比较工具轨迹、token、延迟和失败节点。
- Replay 能按原 ModelPlan 与原 Session 证据复现，不因配置名称或角色名误解模型。
- 全程不记录密钥、不修改正式 Profile、不产生外部写。

这套设计的优雅之处不在于多几个 JSON 字段，而是**配置只解析一次、身份只生成一次、用量只聚合一次**：所有分析都建立在这条不可变证据链上。
