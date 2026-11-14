# 2026-11-06 Quno 链路评测集与本地回放设计

> 状态：**评测系统实施设计，未改代码。**目标是让每一次 Quno 内核或 prompt 修改都能用同一条命令回答「哪条产品链路、哪个节点、以什么证据失败」，而不是只观察最后一句回复或截图。
>
> 本文是 Quno 验收体系的实施补充；行为契约仍以 [`docs/quno-bot-design.md`](../quno-bot-design.md) 为准。

## 1. 问题与目标

当前已有测试分别覆盖 Core、SQLite、Effect、Transport、真实 AgentLoop、Worker、Watchdog 和 Client，但它们主要回答单个模块或脚本化链路是否正确。改造后的真实对话仍可能因模型决策、工具装配、读写证据、回合门禁、Worker 回收或通知表达的衔接而失败。

评测系统必须同时满足：

1. **链路完整**：从 Human/Trigger 输入走到最终回答、Ticket、Report 和 Notification，不在中途用假结果代替后半段。
2. **逐节点断言**：每个节点都有可机读证据，失败时报告第一个失败节点，而不是只报 case failed。
3. **真实模型可用**：本地直接调用真实 Router/Worker 模型，不要求 mock 才能运行。
4. **录制回放**：真实请求/响应持久化，之后可用 scripted adapter 确定性复现。
5. **结果可判定**：结构断言优先，语义要求逐项判定；不得用平均分掩盖关键失败。
6. **本地安全**：scratch DSH_HOME、合成数据、只读权限、无外部写、不修改正式 Profile、不记录凭据。
7. **结果可复用**：每次运行生成独立证据包，可比较两次运行并回归同一失败。

不替代现有 `node:test`；现有单元和组合测试仍是快速门禁，链路评测补足真实模型与跨节点组合。

## 2. 分层验证模型

| 层 | 模型 | 存储/Effect/Transport | 外部来源 | 用途 |
|---|---|---|---|---|
| L0 单元 | 无 | MemoryRepository | 无 | 纯规则、状态机 |
| L1 持久链路 | Scripted | 真实 SQLite + Effect | Fixture Organ | 迁移、事务、崩溃恢复 |
| L2 AgentLoop 回放 | Recorded | 真实 DSH 组件 | Fixture Organ | 确定性 prompt/tool/回合回归 |
| L3 Live 端到端 | 真实 Router + Worker | 真实 DSH 组件 | Fixture Organ | 验证真实模型能否完成产品链路 |
| L4 Desktop 实机 | 真实或回放 | 打包 runtime + Desktop | 默认 Fixture | UI、入口、任务卡和通知投影 |

L4 只能作为 L3 的增量，不能拿 DOM 可见性代替 Host 链路断言。真实云之家/线上日历等来源不属于默认套件；如另加 live-source smoke，必须保持只读、显式选择且使用合成测试范围。

## 3. 运行架构

```text
Eval CLI
  ├─ Case Registry + Typed Cases
  ├─ Scenario Driver
  │    ├─ human.input / organ.ingest / time.advance
  │    ├─ ticket.stop / feedback.submit / process.restart
  │    └─ exchange.respond / effect.fail
  ├─ Real Runtime Composer
  │    ├─ Quno Engine + Store + Effect + SessionTransport
  │    ├─ Router / Executor Session + real AgentLoop
  │    └─ Fixture Organ / Fixture FS / Virtual Clock
  ├─ Model Gateway
  │    ├─ LiveAdapter
  │    ├─ ReplayAdapter
  │    └─ 按 Router/Worker 角色分别选择 live 或 replay
  ├─ Trace Recorder + Assertion Engine
  └─ JSON/Markdown Reporter + Evidence Bundle
```

实现优先复用当前 `MemoryRepository`、SQLite Store、`Engine`、`EffectsRuntime`、`SessionTransport`、`@deepseek-ai/dsh-agent-loop-testkit` 和现有 scripted adapter 工具。不引入新的测试框架或 YAML 依赖；用 TypeScript 定义 case，使用现有 `tsx` 运行。

## 4. 目录与命令

```text
plugin/dsh-quno/
  evals/
    README.md
    cli.ts
    case.ts
    assertions.ts
    trace.ts
    runtime.ts
    driver.ts
    report.ts
    redact.ts
    models/
      live.ts
      replay.ts
      scripted.ts
    fixtures/
      calendar.ts
      feed.ts
      im.ts
      fs.ts
      crash.ts
    cases/
      conversation.ts
      eval.ts
      worker.ts
      notification.ts
      exchange.ts
      recovery.ts
      desktop.ts
```

建议 package scripts：

```json
{
  "eval": "node --import tsx evals/cli.ts",
  "eval:live": "node --import tsx evals/cli.ts --model live",
  "eval:replay": "node --import tsx evals/cli.ts --model replay"
}
```

使用方式：

```sh
# 无凭据、确定性全量回放
pnpm eval:replay

# 本地真实模型核心套件；缺凭据时立即给出明确配置错误
pnpm eval:live -- --suite p0

# 单链路重复三次，验证模型稳定性
pnpm eval:live -- --case direct-read --repeat 3

# 回放某个历史 run；也可用 --run-dir 指定绝对证据目录
pnpm eval:replay -- --run latest
```

Live 模式从当前进程环境读取已配置的 provider/model/credential，首版支持环境变量方式；凭据不得写入 case、trace、报告或录像。Scratch DSH_HOME 由 runner 在临时目录创建并默认保留失败现场，成功现场按 `--keep=all|failures|none` 清理。

## 5. Case 定义

```ts
export interface EvalCase {
  readonly id: string
  readonly title: string
  readonly priority: 'p0' | 'p1'
  readonly requirement: string
  readonly tags: readonly string[]
  readonly fixtures: {
    readonly organs?: readonly OrganFixture[]
    readonly files?: readonly FileFixture[]
    readonly policy?: PolicyFixture
  }
  readonly model: {
    readonly router: 'live' | 'replay' | 'scripted'
    readonly worker: 'live' | 'replay' | 'scripted'
  }
  readonly steps: readonly EvalStep[]
  readonly expect: {
    readonly chain: readonly ChainExpectation[]
    readonly facts: readonly FactExpectation[]
    readonly forbidden: readonly ForbiddenExpectation[]
  }
  readonly budget: {
    readonly maxDurationMs: number
    readonly maxModelCalls: number
    readonly maxInputTokens?: number
  }
}
```

`EvalStep` 是驱动动作，不是断言：

```ts
type EvalStep =
  | { kind: 'human'; text: string }
  | { kind: 'ingest'; trigger: TriggerFixture }
  | { kind: 'advanceTime'; to: number }
  | { kind: 'waitFor'; stage: StageName }
  | { kind: 'stopTicket'; ticketRef: string }
  | { kind: 'answerQuestion'; text: string }
  | { kind: 'crash' }
  | { kind: 'restart' }
  | { kind: 'failNextEffect'; effect: EffectKind; error: string }
  | { kind: 'exchangeResponse'; exchangeRef: string; result: unknown }
  | { kind: 'desktop.click'; target: string }
```

Case 通过稳定引用名（如 `ticketRef: 'accepted'`）关联运行中生成的 ID，不把动态 ID 写死。

## 6. 节点与证据契约

### 6.1 Trace 格式

每个节点写结构化 `trace.jsonl`：

```ts
export interface EvalTraceEvent {
  readonly runId: string
  readonly caseId: string
  readonly attempt: number
  readonly stage: StageName
  readonly status: 'started' | 'passed' | 'failed' | 'blocked'
  readonly at: number
  readonly durationMs: number
  readonly refs: {
    readonly triggerIds?: readonly string[]
    readonly threadId?: string
    readonly evalId?: string
    readonly decisionId?: string
    readonly ticketId?: string
    readonly assignmentId?: string
    readonly workerRunId?: string
    readonly inputIds?: readonly string[]
    readonly exchangeId?: string
    readonly notificationId?: string
    readonly sessionId?: string
    readonly messageId?: string
  }
  readonly expected?: unknown
  readonly actual?: unknown
  readonly error?: { readonly code: string; readonly message: string }
  readonly evidence: readonly string[]
}
```

`evidence` 指向 SQLite 查询、Session seq、模型录像和 DOM 快照；敏感信息经统一 redactor，不把完整私人文本放进报告。

### 6.2 节点断言表

| 节点 | 必须读取的真实证据 | 典型失败 |
|---|---|---|
| `source.ingest` | Trigger、批次 ACK、checkpoint revision | 假 ACK、重复事件、游标越过失败项 |
| `intake.thread` | primary Thread、Correlation、pending/fan-out | 错路由、Correlation 误路由 |
| `eval.candidate` | Eval、候选 messageId、deliveredAt、实际模型请求 | 候选未生成、工具缺失、未交付却超时 |
| `eval.decision` | Decision、policyVersion、accept mode、audit | observe 误接单、旧 Policy 提交 |
| `ticket.mandate` | Ticket、Mandate、scope、strength、permission preset | 未授权执行、重复 accept |
| `assignment.launch` | Assignment、Effect、WorkerSlot、Executor Session | Effect 未入队、重复启动、错误 parent |
| `input.delivery` | deliveredAt、readAt、messageId、Turn 证据 | 写入未读、重启后重复/丢失 |
| `worker.execution` | 真实工具调用、只读 guard、WorkerRun | 直接写、UNKNOWN_TOOL、读错文件 |
| `worker.report` | 结构化 Report、Question、Artifact | 没有 Report、状态误判完成 |
| `router.relay` | Report→Router message、回合 source、relay Effect | 结果未回 Router、自动记忆污染 |
| `notification.outbox` | materialRevision、eligibleAt、attempts、messageId | 重复、过期、安静时段误发 |
| `notification.presented` | notificationId+turnId、实际回复 | 入队冒充已展示 |
| `feedback.command` | expectedRevision、Attention/Ticket 状态 | 旧模型覆盖用户最新反馈 |
| `recovery.restart` | 重启前后记录、Effect generation、最终唯一结果 | 状态倒退、双 Worker、双通知 |

另设全局硬断言：无未授权外部写、无凭据泄漏、无未处理 Promise rejection、无未解释 UNKNOWN_TOOL、无第二份长期记忆污染、无状态倒退。

## 7. 首批评测集

### 7.1 P0：每次发布前必须通过

| Case | 链路 | 关键结果 |
|---|---|---|
| `chat-simple` | Human → Router 直接回复 | 无 Ticket、无执行工具、回答切题 |
| `direct-read` | Human → quno_task → Ticket → Worker 读 fixture → Report → 回复 | 主对话只委派；回复包含文件中的真实事实 |
| `status-result` | direct-read → status/result 查询 | 读取持久 Ticket，不靠 live activation 或重复轮询 |
| `eval-observe` | inferred Trigger → Eval → would_accept | 不创建 Ticket/Worker/通知 |
| `auto-investigate` | 授权 Trigger → Eval accept → Mandate → 只读 Worker → Notification | 自动闭环一次完成，证据正确 |
| `owned-followup` | 已有 Ticket → owned Thread 新人类消息 → Worker | 不再 Eval、不新建 Ticket、不扩大 Mandate |
| `worker-restart` | Input 已交付未读时崩溃 → restart → Report | 不丢、不重、不多一个 Worker，结果只展示一次 |
| `notification-quiet` | 有价值结果 + quiet hours → 解禁 | 期间不展示，解禁只留最新有效通知 |
| `tool-guard` | Human/Eval 中尝试直接执行与 memory write | 必需 quno_* 可用，执行/记忆写入被真实 guard 拒绝 |

P0 发布门：真实模型连续三次运行，所有 case 的结构断言和语义必须项全部通过；不允许用其他 case 的平均分抵消失败。

### 7.2 P1：完整链路

| Case | 覆盖 |
|---|---|
| `irrelevant-ignore` | 无关消息只 ignore，无 Ticket、无通知 |
| `explicit-source-accept` | Source 中授权人类点名直接接单 |
| `burst-100` | 每批 ≤20，每 Thread 单 active Eval，无 100 次 Router 调用 |
| `two-threads-timeout` | 一个 Thread 超时/毒数据不影响另一个 |
| `policy-change` | in-flight Eval 重排，旧 Policy 不提交，live Ticket 收到 PolicyInput |
| `worker-blocked-answer` | blocked/Question → 人类回答 → 同 Mandate 恢复 → ready |
| `worker-handback` | 超范围 follow-up 交回，无 Owner 后重新 Eval |
| `worker-stop-late` | 人类 stop 后晚到 Report/Effect 不改状态、不通知 |
| `worker-dropped` | 投机调查无价值时 dropped 且安静 |
| `notification-dedupe` | 同 materialRevision 和措辞变化不重复 |
| `feedback-cas` | 用户完成/延后与模型提交竞争时保留用户状态 |
| `notification-flush` | flush 不明时按 messageId 对账，不盲发 |
| `exchange-roundtrip` | 两个需求方同时查询，Response 各自正确返回 |
| `exchange-restart` | 请求后重启、晚到/超时/取消语义正确 |
| `compaction-recall` | 真实压缩后通过引用/全文召回旧结果，不编造 |
| `memory-isolation` | Eval/Worker/Notification 不产生 OhMyMemo 用户事实 |
| `desktop-entry` | Quno 入口、zw.9 归属选中、普通会话切换无残留 |
| `desktop-task-card` | 任务卡→面板→Executor 只读视图，真实状态一致 |

每个 Case 都可单独运行，不能只提供全量 suite。

## 8. 结果判定

### 8.1 结构优先

以下全部使用确定性断言，不使用 LLM judge：

- 节点是否到达、顺序、数量和 ID 关联；
- 工具是否出现/被拒绝、Effect/Session/SQLite 状态；
- Ticket/Mandate/Report/Notification 状态机；
- 调用次数、并发、预算、重复投递和恢复；
- 事实输出中的日期、文件名、事件 ID、关键数值可经结构化数据验证。

### 8.2 语义要求

自然语言不做整段字符串相等，也不仅看「像不像」。Case 将要求拆成：

```text
mustIncludeFacts: 必须出现的事实
mustNotClaim: 禁止声称的结果
mustProvide: 必须给用户的下一步/证据
mustStaySilent: 必须保持安静的场景
```

优先用结构化 Report 和事实字段判定。只有无法结构化的表达质量才使用 judge；judge 输入含 rubric、证据与回答，不接触凭据。每个 must 项独立 pass/fail，任一关键项失败则 Case 失败。

### 8.3 报告

```text
eval-results/<runId>/
  report.json
  report.md
  trace.jsonl
  cases/<caseId>/
    attempt-1/trace.jsonl
    model-requests.jsonl
    session-index.json
    failure.json
    dom/
```

终态只展示：

- Case pass/fail；
- 第一个失败 Stage；
- expected vs actual；
- 直接 evidence 路径；
- 后续节点是 failed 还是因上游 blocked；
- 与上一 run 的新增/修复/仍存在失败。

`blocked` 不得被统计成通过，也不得被误报为根因。

## 9. 录制与回放

### 9.1 Live 录制

LiveAdapter 为每个模型调用持久化：

- 角色（Router/Worker）、模型路由、prompt/input messages、工具 schema、输出流、stop reason、usage、耗时；
- 对应 run/case/stage、Session ID、Turn ID；
- 请求序号与因果关系。

凭据、provider 私有过头信息和无关隐私必须移除。默认 fixture 全为合成数据。

### 9.2 ReplayAdapter

- 按 Case + 角色 + 请求序号选择录制结果，不用模糊文本猜；
- 输入漂移时 fail loud，报告 prompt/tool schema 的第一个差异；
- 保持原 stop reason、工具调用、文本与 usage；
- 不发起网络请求；
- Replay 仍运行真实 Engine/Effect/Transport/Session，不是只比较文本。

失败分类：

- Live 与 Replay 在同一实现下表现不同：优先查模型波动、prompt 差异或非确定性；
- Replay 在新实现下失败：优先查链路/状态机/工具适配回归；
- 同一 Replay 重复运行不同：查共享状态、时钟、异步竞态或未清理资源。

## 10. 故障注入与可重复性

Runner 必须支持在指定边界 crash 或失败，而不是只测正常路径：

- Trigger 已入库未 ACK；
- Eval candidate prepared/未 flush；
- Decision 已提交未 launch；
- Input 已交付未 read；
- Worker Report 已提交未 relay；
- Exchange responded 未 consumed；
- Notification 已入队未 presented；
- 旧 Effect generation、旧 Eval、旧 Assignment 晚到。

虚拟时钟控制超时、安静时段、到期复查与退避；随机只用于可记录 seed。所有异步等待有 deadline，套件永不因一个失联节点无限挂起。

## 11. 实施顺序

### E0：最小闭环

实现 case schema、CLI、Trace、scratch runtime、一个 `direct-read` Live+Replay 用例。验收：一条命令跑完真实对话和只读 Worker，失败能定位到具体 Stage。

### E1：核心 P0

补齐其余 P0、JSON/Markdown 报告、重复运行和事实断言。要求连续三次 P0 全绿后才用于发布门禁。

### E2：故障与配对交换

实现 crash/restart、虚拟时钟、Effect 注入、Exchange、Notification 对账；覆盖 §15 的每个事务边界。

### E3：完整 P1 与 Desktop

补齐 Thread/Policy/Worker/Memory/Compaction 和可选 Desktop DOM；与现有 node:test 共享 fixture，但不复制其实现。

### E4：使用纪律

- PR：现有单测 + Replay；
- 每次 Quno 行为/prompt/内核修改：本地 Live 相关 Case + P0；
- 发布前：Live P0 连续三次 + 完整 Replay；
- 定期：完整 Live P1，跟踪 token、延迟和模型漂移；
- 失败修复后必须重跑对应 Case、P0 和完整 Replay，不能只改代码后看单次聊天截图。

## 12. 评测系统自身的验收

- 无凭据时 Replay 可直接运行；Live 缺凭据时明确报配置，不假装通过。
- 单 Case、P0、全量、重复、录制、回放都可经一条本地命令完成。
- 任一节点失败都有结构化证据和首个失败点；下游 blocked 不混淆根因。
- 不修改正式 Profile，不产生外部写，不记录凭据，不污染 OhMyMemo。
- 同一输入运行两次不产生重复 Ticket、Worker、Effect、Exchange 或 Notification。
- 已知历史故障（如 quno_* 缺失、直接执行绕过、输入未读、通知假 presented）有对应回归 Case。
- 评测结果只有满足当前 Case 的全部硬要求才算通过，报告不允许红项被平均分掩盖。

## 13. 自查结论

这套设计不是「再补一些单测」，而是给现有测试增加一个真实模型驱动、可回放、可故障注入的链路层。它的核心产物不是总分，而是**每个节点的可验证事实和首个失败位置**。只有这样才能形成「运行 → 定位 → 修复 → 回放旧失败 → 跑全量回归」的稳定循环。
