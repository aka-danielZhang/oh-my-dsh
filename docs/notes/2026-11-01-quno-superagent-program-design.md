# 2026-11-01 Quno Super-agent 内核重构程序设计（实施终稿）

> 状态：**可直接用于实施的目标程序设计；未改代码，当前运行行为不变。**
>
> 本文取代 [统一 Trigger 与 Router/Worker 内核重构设计](2026-11-01-quno-superagent-redesign.md) 与 [Trigger 协议修订：器官自治与配对交换](2026-11-01-quno-trigger-organ-and-exchange.md)，是前两份方案的自包含终稿。旧 notes 保留为决策历史，不再分别维护。各实施 PR 必须同步修订 [`docs/quno-bot-design.md`](../quno-bot-design.md)；全部落地后将本设计收敛回该权威文档。

## 1. 目标、约束与实施前提

### 1.1 目标内核

Quno 从「独立 Analyzer 处理 Sense 事件、主对话派发一次性 Task」改为：

- 所有控制输入使用统一 Trigger 协议；协议统一身份、交换、投递、血缘和恢复，不统一业务语义。
- 永久主对话是唯一 Agent Router，负责直接人类交互、未归属 Observation 判断、Response/Result 消费、Worker 协调和通知决策。
- Worker 是持久执行身份，可在同一 durable Session 上多回合运行、等待、订阅和冷恢复。
- 器官（现有 Sense）独立决定采集、预处理、checkpoint、重试和授权范围内的局部自愈。
- Attention、Notification Outbox、OhMyMemo 保持各自职责，不充当消息队列。

### 1.2 产品约束

永久主对话、侧栏入口、Sense 配置、动态/关注/任务/运行面板、任务卡、关注反馈、安静时段、低打扰、本地运行和第一阶段只读权限均保持不变。云端常驻、对外写信道、多设备同步和全工具 Watchdog 不在本次范围。

### 1.3 硬约束

1. 主 preset 不开放 Shell、文件、网页等直接执行工具。
2. 所有模型可见输入必须能从 DSH Session 日志重建。
3. 所有 Thread 直通先写持久 Delivery，不直接调用 live Agent 代替队列。
4. 自动 Router 回合不得先执行动作再补账；动作先暂存，批次提交后由 Action Outbox 执行。
5. Quno SQLite 与 DSH Session 日志之间不假定分布式事务，使用 messageId、flush 和日志对账。
6. 自动内容不得进入 OhMyMemo 用户事实；自动回合在工具层禁用 memory write。
7. Electron 壳与桥不新增业务 IPC；优先使用 DSH Session、Agent、Subagents、Jobs、SessionQuery 和 Conversation 接缝。
8. 本文所列运行时适配能力先经 §16.1 验证；未验证前不得宣称现有 API 已完整支持。

## 2. 总体结构与包内落点

```text
器官 / 人类 / Worker / Host / Watchdog
                  │ Trigger
                  ▼
        Ingress + Trigger Log（events）
                  ▼
        Deterministic Trigger Router
          │              │              │
     Observation      Request/Command  Response/Result
          │              │              │
   订阅或未归属路由    指定 responder   原 requester
          ▼              ▼              ▼
       Delivery + DeliveryAttempt（每个消费者独立）
                  ▼
       ┌──────────┴──────────┐
       ▼                     ▼
 Agent Router Inbox      Worker/Organ Inbox
       │                     │
 RouterRun               WorkerRun/Organ Exchange
       │                     │
       └──── Action/Result ───┘
                  │
        Attention / Notification / UI
```

`plugin/dsh-quno/src/` 目标文件职责：

| 文件 | 职责 |
|---|---|
| `types.ts` | 本文定义的 ID、记录、状态与策略类型 |
| `contracts.ts` | Trigger、工具输入、Remote 输入和持久 JSON 的 Zod 校验 |
| `triggers.ts` | Trigger 构造、规范化、信任计算、ContentRef 与去重 |
| `organs.ts` | 现有 Sense 的器官适配、Request/Command 可选能力 |
| `ingress.ts` | 现有批次 ACK/checkpoint；Trigger 持久接收 |
| `threads.ts` | ThreadResolver、Thread 读取与关联 |
| `routing.ts` | 确定性路由、Subscription 与 Delivery 生成 |
| `transport.ts` | `followup/inject/sendMessage`、flush、日志接纳与恢复 |
| `router-runner.ts` | Automatic Batch、Human/Notification Turn 记录、批次提交 |
| `actions.ts` | ActionCommand 暂存、领取、执行、重试与结果 |
| `workers.ts` | Worker/WorkerRun 生命周期、订阅、冷恢复、结果上报 |
| `exchanges.ts` | Request/Response、Command/Result、超时与晚到处理 |
| `scheduler.ts` | Timer、到期、批次准入、退避，不含分析业务 |
| `attention.ts` | 现有 Attention 状态机与 CAS |
| `outbox.ts` | 现有 Notification Outbox，强化 Turn 证据 |
| `recall.ts` | 引用图读取、全文搜索、压缩替换链 |
| `service.ts` | Cordis 服务组合、持久 Router 绑定、事务编排 |
| `presets.ts` | `quno` Router 与 `quno-task` Worker 两类 preset |

`analyzer.ts` 和旧 `runner.ts` 在切换期作为 Legacy Analyzer 运行；Router 切换完成后删除主路径，历史分析 Run 只读保留。

## 3. 标识、协议与核心类型

### 3.1 ID 与 Endpoint

沿用本包当前字符串 ID 风格，不引入新依赖：

```ts
export type QunoId = string
export type TriggerId = string
export type ThreadId = string
export type DeliveryId = string
export type RunId = string
export type WorkerId = string
export type ExchangeId = string
export type CommandId = string
export type EndpointId = string
```

新 ID 前缀：`trg_`、`thr_`、`dlv_`、`run_`、`wrk_`、`exg_`、`cmd_`。现有 `task_` ID 可原样作为 WorkerId，不能为迁移重新编号。

Endpoint 采用持久字符串：

```text
quno:<qunoId>/router
worker:<workerId>
organ:<senseInstanceId>
watchdog:<qunoId>
```

Endpoint 标识持久 Inbox，不是 live Agent、activation 或进程内 Promise。

### 3.2 Trigger

```ts
export type ExchangeKind = 'observation' | 'request' | 'response' | 'command' | 'result'
export type ProducerKind = 'organ' | 'human' | 'worker' | 'host' | 'watchdog'
export type TriggerTrust = 'direct-human' | 'observed-source' | 'derived-system'

export interface TriggerProducer {
  readonly kind: ProducerKind
  readonly id: string
  readonly generation: number
}

export type ContentRef =
  | { readonly kind: 'session-message'; readonly sessionId: string; readonly messageId: string }
  | { readonly kind: 'session-seq'; readonly sessionId: string; readonly seq: number }
  | { readonly kind: 'quno-event'; readonly eventId: string }
  | { readonly kind: 'blob'; readonly ref: string; readonly sha256?: string }

export interface TriggerRecord {
  readonly id: TriggerId
  readonly qunoId: QunoId
  readonly type: string
  readonly schema: string
  readonly exchange: ExchangeKind
  readonly producer: TriggerProducer
  readonly trust: TriggerTrust

  readonly dedupeScope: string
  readonly dedupeKey: string
  readonly ingestSeq: number
  readonly threadId: ThreadId | null
  readonly subjectKey: string | null
  readonly subjectRevision: string | null
  readonly subjectRefs: readonly string[]
  readonly correlationKeys: readonly string[]
  readonly operation: EventOperation
  readonly priority: SuggestedPriority
  readonly deadline: number | null
  readonly supersedesTriggerIds: readonly TriggerId[]
  readonly parentTriggerIds: readonly TriggerId[]

  readonly target: EndpointId | null
  readonly replyTo: EndpointId | null
  readonly requestId: ExchangeId | null
  readonly responseTo: ExchangeId | null
  readonly causationId: TriggerId | null

  readonly occurredAt: number | null
  readonly observedAt: number
  readonly receivedAt: number
  readonly summary: string | null
  readonly inlineData: unknown
  readonly fullContentRef: ContentRef | null
  readonly provenance: Provenance
  readonly contentHash: string
  readonly configRevision: number
  readonly expiresAt: number | null
  readonly prunedAt: number | null
}
```

规则：

- `type` 只写业务语义，如 `im.message.created`、`calendar.event.changed`、`timer.due`、`worker.task.completed`；不存在 `sense` 类型。
- `producer` 由 Host 从绑定身份、Session source 或 Worker 记录计算，提交方不能自报提权。
- `requestId` 是 Request/Command 的交换身份；Response/Result 用 `responseTo` 指向它。
- `threadId` 是业务事件流，`causationId` 是直接因果，`correlationKeys` 是领域关联，三者不互换。
- `inlineData` 必须满足现有单事件和批次大小限制；大正文使用 `fullContentRef`。
- `trust` 不等于内容可信度评分，只决定工具与权限策略。

现有 `quno.event/v1` 统一映射为 `exchange: 'observation'`，原 `type/schema` 不变，`producer` 由绑定的 SenseInstance/Source 生成。

### 3.3 Delivery 两轴状态

业务处理和会话传输不得共用一个状态字段：

```ts
export type DeliveryStatus =
  | 'pending' | 'claimed' | 'processed' | 'ignored' | 'deferred' | 'dead-letter'

export type TransportStatus =
  | 'idle' | 'pending' | 'prepared' | 'inbox-durable'
  | 'uncertain' | 'retryable-failure' | 'delivery-blocked'

export interface DeliveryRecord {
  readonly id: DeliveryId
  readonly qunoId: QunoId
  readonly triggerId: TriggerId
  readonly targetType: 'router' | 'worker' | 'organ' | 'watchdog'
  readonly targetId: EndpointId
  readonly status: DeliveryStatus
  readonly transportStatus: TransportStatus
  readonly priority: 'p0' | 'p1' | 'p2' | 'p3'
  readonly eligibleAt: number
  readonly attempts: number
  readonly runId: RunId | null
  readonly reason: string | null
  readonly claimedAt: number | null
  readonly settledAt: number | null
}
```

`DeliveryAttemptRecord` 每次传输单独一行：`id/deliveryId/attempt/messageId/status/reason/createdAt/finishedAt`。ACK、inbox-durable、模型消费、Exchange responded 和 consumed 都是不同事实。

### 3.4 Exchange

```ts
export type ExchangeStatus =
  | 'pending' | 'delivered' | 'responded' | 'consumed'
  | 'failed' | 'expired' | 'cancelled'

export interface ExchangeRecord {
  readonly id: ExchangeId
  readonly qunoId: QunoId
  readonly kind: 'request' | 'command'
  readonly requestTriggerId: TriggerId
  readonly requester: EndpointId
  readonly responder: EndpointId
  readonly status: ExchangeStatus
  readonly deadline: number
  readonly responseTriggerId: TriggerId | null
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}
```

Exchange 只用于异步 Request/Response、Command/Result。同进程短读取继续使用 logged Tool call/result，不创建 Exchange，也不能同时再走异步 Response。

## 4. 器官适配与自治边界

### 4.1 现有 Sense 的兼容

现有 SenseDefinition、factory、checkpoint、health 和 `ingestBatch` 不变。Host 在适配层把 SenseInstance 视为 `organ:<instanceId>`，其提交的消息自动获得：

```text
exchange = observation
producer = { kind: organ, id: instanceId, generation }
trust = observed-source
dedupeScope = source:<sourceId>
dedupeKey = eventKey
```

器官独立实施采集、预处理、重试、退避和局部恢复。Host 不逐步指挥采集，只执行声明校验、授权、配额、生命周期和持久接收。

### 4.2 可选配对能力

需要响应主动查询或命令的器官实现可选接口：

```ts
export interface OrganExchangeHandler {
  handleRequest?(request: {
    readonly exchangeId: ExchangeId
    readonly trigger: TriggerRecord
    readonly signal: AbortSignal
  }): Promise<{
    readonly type: string
    readonly schema: string
    readonly summary?: string
    readonly inlineData?: unknown
    readonly fullContentRef?: ContentRef
  }>

  handleCommand?(command: {
    readonly exchangeId: ExchangeId
    readonly trigger: TriggerRecord
    readonly signal: AbortSignal
  }): Promise<{
    readonly type: string
    readonly schema: string
    readonly summary?: string
    readonly inlineData?: unknown
  }>
}
```

器官通过 Host 的 `completeExchange(exchangeId, result)` 返回，不能自行指定任意返回地址。未实现所请求能力时返回 `capability-unavailable`，不能伪造空结果或假成功。

局部自愈仅限器官授权的内部恢复，不获得修改 Attention、创建 Worker、写 OhMyMemo 或对外写的权限。

## 5. Thread 与确定性路由

### 5.1 ThreadResolver

```ts
export interface ThreadResolution {
  readonly threadKey: string | null
  readonly reason: string
}

export interface ThreadResolver {
  resolve(trigger: TriggerRecord): ThreadResolution
}
```

每个器官类型可注册 Resolver；默认按以下顺序：

1. 来源显式声明的稳定 Thread key；
2. 经该来源适配器确认的 correlation key；
3. 语义明确的 `sourceId + subjectKey`；
4. 返回 `threadKey: null`，只交 Agent Router。

不得用摘要、文本相似度或模型临时判断生成直通身份。物理 Thread 唯一键为 `(qunoId, sourceId, threadKey)`；跨来源语义关联留在 Attention，不合并物理 Thread。

### 5.2 Subscription

```ts
export interface SubscriptionRecord {
  readonly id: string
  readonly qunoId: QunoId
  readonly targetType: 'router' | 'worker' | 'watchdog'
  readonly targetId: EndpointId
  readonly threadId: ThreadId | null
  readonly sourceId: string | null
  readonly filter: SubscriptionFilter
  readonly startIngestSeq: number
  readonly revision: number
  readonly cancelledAt: number | null
}
```

Subscription 是多对多路由状态，不是 Response。Worker 可 subscribe/unsubscribe/escalate；startIngestSeq 防止默认回放全部历史。

### 5.3 路由算法

每个 ingest 批次 ACK 后调用 `TriggerRouter.route(throughSeq)`，在 SQLite 单事务内完成 Delivery 和路由游标：

```text
for trigger in orderedNewTriggers:
  if exchange = observation:
    targets = activeSubscriptionsMatching(trigger)
    if targets empty and trigger needs semantic admission:
      targets += quno:<qunoId>/router
  if exchange = request or command:
    targets = [validated trigger.target]
  if exchange = response or result:
    exchange = requireExchange(trigger.responseTo)
    targets = [exchange.requester]
  insertMissingDeliveries(trigger, targets)
advanceRoutingCursor(lastContiguousSeq)
```

默认不为已有 Worker 归属的每条 Observation 再镜像到 Router。需要全局观察的来源可显式配置 `mirrorToRouter`，其 Delivery 独立结算。Human 原生消息只登记引用和 Human Turn，不再投递唤醒主对话；Notification Turn 不生成领域 Trigger。

路由失败整批不推进游标；重复路由依赖 `(triggerId, targetType, targetId)` 唯一约束幂等。

## 6. SQLite 逻辑 schema

保留 `$DSH_HOME/quno/quno.sqlite` 单 Host 写入。物理表可继续复用现有名字以降低迁移成本，TypeScript 使用本文逻辑名称。

### 6.1 `events`（逻辑 TriggerRecord）

保留现有列，新增/调整：

```text
quno_id TEXT NOT NULL            -- 新增，迁移时从 sources 回填
source_id TEXT NULL              -- 旧 NOT NULL 放宽；人类/Host/Worker 可为空
exchange TEXT NOT NULL DEFAULT 'observation'
producer_json TEXT NOT NULL
trust TEXT NOT NULL
dedupe_scope TEXT NOT NULL
thread_id TEXT NULL
target_endpoint TEXT NULL
reply_to_endpoint TEXT NULL
request_id TEXT NULL
response_to TEXT NULL
causation_id TEXT NULL
full_content_ref_json TEXT NULL
config_revision INTEGER NOT NULL -- 旧 sense_config_revision 改名并回填
UNIQUE(quno_id, dedupe_scope, event_key)
INDEX(events_route, ingest_seq)
INDEX(events_thread, thread_id, ingest_seq)
INDEX(events_exchange_response, response_to)
```

现有 `data_json` 直接作为 `inlineData`，不新增第二份 `inline_data_json`。旧 `(source_id,event_key)` 映射为 `dedupe_scope='source:<sourceId>'`。非器官生产者的 scope 分别为 `worker:<id>`、`host:<qunoId>`、`human:<sessionId>`。

### 6.2 `deliveries` 与 `delivery_attempts`

`deliveries` 增加 `target_type/target_id/transport_status`，现有 `event_id` 即逻辑 `trigger_id`，唯一键改为 `(event_id,target_type,target_id)`；旧记录目标为 `quno:<qunoId>/router`。保留 status/priority/eligibleAt/runId/attempts/reason 时间列。

`delivery_attempts`：

```text
id TEXT PRIMARY KEY
delivery_id TEXT NOT NULL
attempt INTEGER NOT NULL
message_id TEXT NULL
status TEXT NOT NULL
reason TEXT NULL
created_at INTEGER NOT NULL
finished_at INTEGER NULL
UNIQUE(delivery_id, attempt)
INDEX(delivery_attempts_message, message_id)
```

### 6.3 `exchanges`

```text
id TEXT PRIMARY KEY
quno_id TEXT NOT NULL
kind TEXT NOT NULL
request_trigger_id TEXT NOT NULL UNIQUE
requester TEXT NOT NULL
responder TEXT NOT NULL
status TEXT NOT NULL
deadline INTEGER NOT NULL
response_trigger_id TEXT NULL
attempts INTEGER NOT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
INDEX(exchanges_requester, requester, status, deadline)
INDEX(exchanges_responder, responder, status, deadline)
```

### 6.4 `threads` 与 `subscriptions`

`threads(id,quno_id,source_id,thread_key,created_at)`，唯一 `(quno_id,source_id,thread_key)`。

`subscriptions` 增加 target/thread/cancelled 字段；旧 Quno Source 订阅迁移为 Router 订阅。任何读取先校验 qunoId 和 active revision。

### 6.5 `router_runs`

```text
id TEXT PRIMARY KEY
quno_id TEXT NOT NULL
kind TEXT NOT NULL              -- human | automatic | notification
management TEXT NOT NULL        -- managed | observed
status TEXT NOT NULL            -- claimed | running | waiting-settle | committed | failed | interrupted
turn_id TEXT NULL
session_id TEXT NULL
input_trigger_ids_json TEXT NOT NULL
config_revision INTEGER NOT NULL
fence INTEGER NOT NULL
claim_expires_at INTEGER NULL
result_json TEXT NULL
error_json TEXT NULL
cost_json TEXT NULL
started_at INTEGER NOT NULL
finished_at INTEGER NULL
```

Human 与 Notification 是由 Session 事件驱动的 observed run；Automatic 是 Host managed run，不能套用同一立即执行语义。

### 6.6 `workers` 与 `worker_runs`

`workers` 保留现有 Task 字段并增加：

```text
mode TEXT NOT NULL              -- once | persistent
goal TEXT NOT NULL
goal_revision INTEGER NOT NULL
status TEXT NOT NULL            -- created | starting | running | waiting | blocked | completed | failed | interrupted | cancelled
origin TEXT NOT NULL            -- human | automatic | legacy
permission_json TEXT NOT NULL
result_reported_at INTEGER NULL
```

`worker_runs` 使用与 RouterRun 相同的输入/租约/成本字段，另存 `worker_id/activation_id/turn_id/disposition`。唯一活跃约束由 `activeWorkerRun(workerId)` 与 fence 保证，不依赖数据库部分唯一索引的跨方言能力。

### 6.7 `action_commands`

```text
id TEXT PRIMARY KEY
quno_id TEXT NOT NULL
router_run_id TEXT NULL
kind TEXT NOT NULL              -- start_worker | stop_worker | subscribe | unsubscribe | escalate | organ_request | organ_command
payload_json TEXT NOT NULL
dedupe_key TEXT NOT NULL
status TEXT NOT NULL            -- pending | executing | done | retryable-failure | failed | cancelled
attempts INTEGER NOT NULL
eligible_at INTEGER NOT NULL
result_json TEXT NULL
error_json TEXT NULL
created_at INTEGER NOT NULL
updated_at INTEGER NOT NULL
UNIQUE(quno_id, dedupe_key)
INDEX(action_commands_ready, status, eligible_at)
```

现有 `attention_items/attention_history/notification_outbox/notification_attempts/feedback/sense_*/sources` 保留，新增对象只通过引用关联。

ActionCommand 的 dedupeKey 按意图生成：自动 start 使用 `topic:materialRevision:actionKind`；Human start 使用 `messageId:toolCallId`；stop 使用 `targetId:goalRevision`；subscribe/unsubscribe 使用 `targetId:subscriptionRevision`；organ_request/organ_command 使用 `requester:target:causationId:payloadHash`。这样既能跨重试幂等，又不会永久阻止新的用户意图、目标修订或新因果事件。

## 7. SessionTransport

### 7.1 适配接口

```ts
export interface SessionTransport {
  resolve(endpoint: EndpointId): Promise<Agent | undefined>
  followup(endpoint: EndpointId, input: TransportInput): Promise<void>
  inject(endpoint: EndpointId, input: TransportInput): Promise<void>
  sendMessage(endpoint: EndpointId, input: TransportInput): Promise<void>
  flush(endpoint: EndpointId): Promise<boolean>
  readSession(endpoint: EndpointId): Promise<readonly SessionEventLike[]>
}

export interface TransportInput {
  readonly messageId: string
  readonly runId: RunId
  readonly source: {
    readonly kind: string
    readonly form: 'notice'
    readonly summary: string
    readonly runId: RunId
  }
  readonly text: string
}
```

SessionTransport 只处理 Router/Worker/Watchdog 的 Session Endpoint；Organ Endpoint 由 OrganDispatcher 处理。新的程序 source 通过 `MessageSourceMap` declaration merge 注册，具体 DSH API 只允许出现在适配层和 Worker 创建适配层，业务模块不直接依赖 live Agent。

### 7.2 投递算法

1. Delivery 已为 claimed，写入 `prepared` DeliveryAttempt 和确定 messageId。
2. 目标 idle：`followup`；目标 running：允许 `inject` 到下一获准请求。
3. `inject` 后若当前 Turn 没有后续请求，在 Turn 边界对未接纳 messageId 使用 `followup`，不得无限等待。
4. flush 成功仅推进为 inbox-durable；模型消费仍需 Run 提交证据。
5. flush 失败或结果不明记 uncertain/retryable-failure，读取 Session 日志后决定重试，不盲目重发。
6. 同一 messageId 已在日志中时不得再次注入；同 ID 不同内容报冲突。

### 7.3 无 live 人类 parent

自动 Worker 创建不得依赖人类工具调用的 `exec.agent`。Worker 创建适配器通过持久 `mainSessionId` 冷/热解析 Router Agent，再建立 Subagent 父子关系；无法解析时 ActionCommand 标 retryable-failure 并生成可升级结果，不伪造 parent。

## 8. Agent Router

### 8.1 三类 RouterRun

| 类型 | 产生方式 | 工具与副作用 |
|---|---|---|
| Human Turn | 直接用户 message 驱动，observed | 显式命令先持久登记再立即执行；直接回复用户 |
| Automatic Batch | Router Delivery 驱动，managed | 只暂存领域命令，提交后 Action Outbox 执行 |
| Notification Turn | 获准 Notification 驱动，observed | 只做受限自然表达，不执行领域命令、不生成新 Trigger |

自动 Trigger 不搭乘 Human Turn。新人类消息在下一合法推理边界优先于普通自动批次，不强行打断流式生成。

### 8.2 Router 工具

| 工具 | Human | Automatic | Notification | 行为 |
|---|---:|---:|---:|---|
| `quno_task` | 是 | 是 | 否 | start/stop/status/result/subscribe/unsubscribe/escalate；Automatic 只暂存 |
| `quno_attention` | 是 | 是 | 否 | 查询、expectedRevision 更新；Automatic 随批次提交 |
| `quno_notify` | 是 | 是 | 否 | 只提交通知候选 |
| `quno_read_*` | 是 | 是 | 受限 | 有界读取 Trigger/Thread/Worker/Exchange/Artifact |
| `quno_recall` | 是 | 是 | 受限 | 引用图与全文召回 |
| `quno_batch_settle` | 否 | 必需 | 否 | 提交本批处置和暂存命令 |
| `memory_* write` | 按现有确认纪律 | 否 | 否 | Host 按 Turn 来源硬门禁 |
| `schedule_*` | 是 | 受限 | 否 | Automatic 受数量与来源策略限制 |

继续沿用全局执行工具隐藏与 `tools.guard`，不得把 preset 自有工具放进 allow-list restriction。

### 8.3 Automatic Batch 算法

```text
route()
if activeAutomaticRun: return
ready = selectReadyRouterDeliveries(bounds, fairness)
if ready empty: scheduleNextDue(); return
run, deliveries = transaction(claimRunAndDeliveries)
transport.prepareAndSend(run, deliveries)
waitForTurnSettlement()
validateBatchOutputAndStagedCommands()
transaction(commitRun)
executeEligibleActionCommands()
scheduleNextDue()
```

批次提交必须在同一 SQLite 事务中完成：

- 校验 runId、fence、租约和输入 Trigger；
- 写入每个 Delivery 的 processed/ignored/deferred；漏报保持未结算；
- 结算已消费 Exchange 为 consumed；
- 应用带 expectedRevision 的 Attention 变更；
- 写 ActionCommand；
- 写 NotificationOutbox；
- 写 RouterRun 结果、成本和 committed。

无 `quno_batch_settle`、输出非法、fence 失效或提交失败时，不执行任何暂存 Action；Run 失败并释放 Delivery，按 attempts 退避或 dead-letter。

### 8.4 Batching 参数

沿用当前默认起点并纳入显式配置：`maxTriggersPerBatch=100`、`maxInlineChars=48000`、`maxRunSec=120`、`mergeWindowMs=15000`、`maxActionsPerBatch=4`。高优先级可提前成批，低优先级有等待配额；空队列零模型调用。现有 `checkIntervalSec` 改作普通 Trigger 最大等待/合并节奏，不再无工作定时唤醒。

### 8.5 自动回合显示

自动输入使用带 `routerRunId` 的程序 MessageSource。Conversation/Turn 投影默认折叠 Automatic Run，只显示获准 Notification 和 Human 对话；不得伪造 assistant 消息或直接修改 JSONL。Notification Turn 的 presented 证据绑定 `notificationId + turnId`，不能使用之后任意 assistant 回复代替。

## 9. Worker

### 9.1 Worker 与 WorkerRun

Worker 是持久目标，不是常驻 activation；`waiting` 时可释放 live Agent。WorkerRun 是一次有界执行，activation.result 只结束 WorkerRun，不自动结束 Worker。

```ts
export type WorkerStatus =
  | 'created' | 'starting' | 'running' | 'waiting' | 'blocked'
  | 'completed' | 'failed' | 'interrupted' | 'cancelled'

export type WorkerDisposition = 'wait' | 'complete' | 'escalate'
```

状态主路径：`created → starting → running ⇄ waiting → completed`，异常进入 blocked/failed/interrupted/cancelled。用户取消先写 durable 状态，晚到 settle 不得改回。

### 9.2 创建路径

Human `quno_task(start)`：事务创建 Worker 与 ActionCommand 后立即执行，保持即时任务卡和快速应答。

Automatic `quno_task(start)`：只暂存 ActionCommand；批次提交后执行。准入检查：

- `(topic,materialRevision,actionKind)` 生成稳定 dedupeKey；
- 自动任务独立日预算、并发和因果深度未超限；
- Quno enabled，来源策略允许；
- goal、evidence、cwd、permission scope、mode 已固定；
- `mode` 在工具边界必填；现有 Human/legacy 任务默认 `once`，自动投机任务也只有显式需要持续订阅时才使用 `persistent`。

第一阶段自动 Worker 仅只读，用于调查、整理和草稿；无价值结果安静完成。

### 9.3 Worker 执行与结束

Worker 使用现有 `quno-task` 只读 preset，并新增 `quno_worker_finish`：

```ts
{
  disposition: 'wait' | 'complete' | 'escalate'
  summary: string
  artifacts?: TaskArtifact[]
  reason?: string
}
```

- `mode=once`：正常最终回复但未调用 finish 时按 complete 兼容现有任务。
- `mode=persistent`：未调用 finish 时只结束 WorkerRun，Worker 进入 waiting，由 Router 决定后续。
- complete：生成 `worker.task.completed` Observation 给 Router。
- wait：生成 `worker.run.completed` Observation，可附下一次复查或订阅信息。
- escalate：生成 `worker.task.escalated`，交回 Router，不自行另建 Worker。
- Worker 不直接更新 Attention 或 Notification，结果统一经 Router。

Worker 完成 Trigger 持久化后，旧「Task 完成直接写 Notification Outbox」路径退役，避免双通知。

### 9.4 Worker Inbox 与恢复

新 Observation 先写目标 Worker Delivery，再创建 WorkerRun。Worker 忙碌时在当前推理边界合批；等待/冷会话从持久 childSessionId 恢复。WorkerRun 重启对账：已自然完成则补结果，未完成按策略 cold resume 或 interrupted。

多 Worker 可订阅同一 Thread，各自 Delivery 独立。只读阶段用去重控制重复调查；未来写操作另做共享环境锁与审批，不在本次放宽。

## 10. Request/Response 与 Command/Result

### 10.1 发起

Human Turn 可直接调用 `requestOrgan/requestWorker`；Automatic Batch 只能先暂存 `organ_request/organ_command` ActionCommand，T5 提交后才允许进入以下创建流程，避免异步查询绕过两阶段提交。

`requestOrgan/requestWorker` 在同一 SQLite 事务中：

1. 校验 requester/responder、能力、deadline、权限和超时上限；
2. 创建 ExchangeRecord；
3. 创建 `exchange=request|command` 的 Trigger，`target=responder`、`replyTo=requester`；
4. 创建 responder Delivery；
5. 提交后由 Transport/Organ dispatcher 投递；responder 持久 ACK 后将 Exchange 标为 delivered。

`deadline` 必须显式，初始默认查询 60s、命令 30s，最大 900s，纳入配置。

### 10.2 返回

`completeExchange(exchangeId, producer, result)`：

1. 校验 Exchange 存在、responder 与已验证 producer 一致、状态仍可返回；
2. 创建 Response/Result Trigger，`responseTo=exchangeId`，内容身份幂等；
3. 返回地址读取 `ExchangeRecord.requester`，不信任结果自报 replyTo；
4. 同事务写 requester Delivery、Exchange status=responded；
5. 需求方 Router/Worker 在 Run 提交后标 consumed。

重复 Response 返回已有结果；同 Exchange 不同内容报 identity-conflict。过期/取消后的晚到结果只保存证据并标 late/superseded，不自动重开工作。

### 10.3 超时与取消

Scheduler 扫描到期 Exchange：标 expired 并生成 `exchange.expired` Observation 给 requester。取消先写 cancelled；后续结果不唤醒已取消 Worker。无响应不能等同失败，失败必须由结构化 Result 或 deadline 事实判定。

### 10.4 同步读取

本地 Event/Session 的短读取继续 `quno_read_*` Tool call/result，不创建 Exchange。慢速、跨器官、需要排队或跨重启的查询才走异步配对；同一逻辑请求只能选择一种返回路径。

## 11. Inline、Spill、召回与记忆

### 11.1 注入渲染

`renderTriggerForModel(trigger)` 默认只输出：ID、type/schema、producer/trust、时间、threadId、exchange/requestId、摘要、关联 ID、有界 inlineData 和 fullContentRef。长正文、Session、文件与旧工具结果默认 Spill。

可附少量同 Thread 最近 Trigger、被回复/取代 Trigger、相关 Attention 和 Worker 摘要。所有 Inline 内容由程序 source 消息持久化；所有续读通过 logged Tool call/result。

### 11.2 引用图读取

```text
Trigger → Thread → AttentionItem → Worker → WorkerRun → Session → Artifact
```

提供 `quno_read_trigger/read_thread/read_worker/read_run/read_artifact`，每次返回有界摘录、关联 ID、truncated/pruned 和下一跳引用。按 ID 授权读取不受 UI 最近 20/24 条限制；全文检索只是补充。

原文过期后保留 ID、证据摘录、hash 和 pruned 标记。跨 Quno、跨 Source 权限或已撤销 generation 的引用拒绝读取。

### 11.3 OhMyMemo

保留 capsule、激进压缩与显式写入纪律。Automatic/Notification Turn、WorkerRun 和程序 Trigger 均不进入梦境提取；混合自动回合默认不提取用户事实。Automatic Turn 的 memory write 在 Host 工具层禁用。

## 12. Attention、Notification 与 UI

Attention 保持当前状态机和 expectedRevision，用户按钮是 Host Command，不经模型。Automatic Router 不能用旧证据覆盖用户更新。

Worker 结果路径固定为：Worker result Trigger → Router → Notification candidate → Notification Outbox → Notification Turn。通知频控、安静时段、materialRevision 和去重沿用现有实现。

UI 数据适配：

- 动态：Sense/器官健康、Trigger、Thread；
- 关注：现有 Attention；
- 任务：Worker，旧 Task Wire 由 adapter 映射；
- 运行：RouterRun/WorkerRun 分列筛选，旧 Run Wire 保留 legacy-analysis；
- 主对话：Human 与 Notification 可见，Automatic 默认折叠。

Remote 初版保持现有 `state()` 快照兼容，新增按需 `triggerDetail/threadDetail/workerDetail/exchangeDetail`，不把大正文并入 15 秒轮询。

## 13. 策略、安全与配置

新增显式配置并给初始值，实施后用真实负载校准：

```ts
export const DEFAULT_QUNO_RUNTIME_POLICY = {
  router: {
    maxTriggersPerBatch: 100,
    maxInlineChars: 48_000,
    maxRunSec: 120,
    mergeWindowMs: 15_000,
    maxActionsPerBatch: 4,
  },
  worker: {
    maxConcurrent: 4,
    maxTriggersPerRun: 50,
    maxAutoStartsPerDay: 20,
    maxCausalDepth: 8,
  },
  exchange: {
    defaultQueryTimeoutSec: 60,
    defaultCommandTimeoutSec: 30,
    maxTimeoutSec: 900,
  },
} as const
```

自动与 Human Worker 分账计量。外部文本不能改变工具、权限、预算、返回地址或记忆；来源 high priority 不能自动突破安静时段。Worker 只读由 preset 和 guard 双重保证。Sense 仍是可信同进程代码，Trigger 协议不等于第三方沙箱。

## 14. 事务与恢复矩阵

| 编号 | SQLite 事务内容 | 事务后动作 |
|---|---|---|
| T1 | Sense 事件、批次回执、checkpoint | 返回 durable ACK |
| T2 | Thread/Subscription 匹配、Delivery、路由游标 | 调度目标 |
| T3 | RouterRun/WorkerRun claim、Delivery claim | 准备模型输入 |
| T4 | DeliveryAttempt(prepared,messageId) | followup/inject/sendMessage、flush |
| T5 | RouterRun 结果、Delivery/Exchange 结算、Attention、Action、Notification | 执行 Action/Notification |
| T6 | ActionCommand claim/结果 | 调 Worker/Subscription；失败生成结果 |
| T7 | WorkerRun 结果、Worker 状态、结果 Trigger | 路由给 Router |
| T8 | Exchange Response、requester Delivery、responded | 唤醒 requester |
| T9 | Notification attempt/messageId | 主对话投递与 Turn 对账 |

恢复要求：

- T4 后崩溃：按 messageId 查 Session，存在不重复，不存在从 prepared 安全重试。
- T5 前模型失败：不执行 Action，释放 Delivery；毒消息有界重试后 dead-letter。
- Action 已提交未执行：只重试 Action，不重跑 RouterRun。
- Worker 已完成未回流：从 WorkerRun 记录补结果 Trigger，幂等。
- Exchange responded 未 consumed：只重试 requester Delivery/Run。
- Notification 已入队未展示：只处理 Notification，不重做领域工作。
- 旧 fence、旧 generation、已取消 Worker 的晚到写入全部拒绝。

## 15. 数据迁移

### 15.1 一次性迁移

1. 备份 SQLite 与运行关联；暂停主动投递和自动工作。
2. 重建 `events` 以调整 NULL 与唯一约束：新增并回填 quno_id（经 Source 归属），放宽 source_id 为 NULL，将 sense_config_revision 迁移为 config_revision；旧记录 exchange=observation，producer/trust/dedupeScope 从 Source 生成，type/schema/ID/ingestSeq/data_json 不变。
3. `deliveries` 增加目标与传输字段：旧记录 target=Router，业务 status 保留；传输状态由既有记录推导为 idle，不伪造历史传输证据。
4. 旧 Source 订阅迁移为 Router Subscription。
5. 旧分析 Runs 标 `legacy-analysis`，只读展示，不回放。
6. 旧 Tasks 复制到 Workers：保留 ID、childSessionId、结果和产物，`mode=once`、`origin=legacy`。running 任务先由旧 TaskOrchestrator 对账再切换。
7. Attention、Notification、Feedback、Sense checkpoint、mainSessionId 和 OhMyMemo 不变。
8. 迁移后先只读校验，再恢复调度；失败恢复备份时保持主动投递暂停，先对账。

### 15.2 兼容与回滚

每阶段可回滚，但不长期双写或双跑模型。Shadow Router 使用永久主对话的只读历史快照和独立评估会话，不向真实主对话注入测试回合，不写真实 Attention、不创建 Worker、不发 Notification，只记录比较结果。Wire 兼容 adapter 与新内核解耦，不能以 UI 兼容为理由保留旧控制路径。

## 16. 实施顺序与验证

### 16.1 P0：运行时接缝探针（Go/No-Go）

在 scratch `DSH_HOME` 使用真实 AgentLoop 验证：

1. running Agent 的多个持久输入能通过 inject/followup 在下一获准请求合批，且每个 messageId 有明确日志证据；无后续请求时能回退唤醒。
2. Subagents/SessionController 支持 Worker 热追加、等待后冷恢复，以及无 live 人类 parent 时从持久 Router 绑定创建子会话。
3. Conversation/Turn 投影能分别处理 Human、Automatic、Notification，不隐藏 Human 回复、不伪造 assistant、不重复通知。
4. OhMyMemo 梦境来源能按程序 source/Turn 排除 Automatic、Notification 和 Worker。

探针失败时先调整适配器或按 fork 流程补通用接缝，不进入全量迁移。

### 16.2 P1：协议、schema 与只读适配

实现 §3–§6、旧数据迁移、Trigger/Thread/Exchange 读取和 Wire adapter；现有 Analyzer 继续消费 Router Delivery。验收旧行为不变、迁移幂等、重复路由不重复 Delivery。

### 16.3 P2：Transport 与 Exchange

实现 §7、§10 和故障矩阵；同步 Tool 与异步 Exchange 各跑一条真实链路。验收重启、超时、取消、晚到、伪造返回地址和重复响应。

### 16.4 P3：Automatic Router 与 Action Outbox

实现 §8、§11 和自动回合投影；先 shadow 对比 Legacy Analyzer，再切换。切换后自动 Trigger 只走主 Router，Legacy Analyzer 不再创建新会话。

### 16.5 P4：Worker 持久化与 Thread 直通

实现 §9，旧 once Task 保持体验；persistent Worker 完成运行→等待→冷恢复→再运行→完成。Worker 结果切换为 Trigger→Router→Notification，删除直接通知旧路径。

### 16.6 P5：链式召回、Watchdog 与清理

补齐对象图、prune 证据、指标和本地只读 Watchdog；删除 Legacy Analyzer 主路径、旧 Delivery 假设和临时兼容代码，并将契约收敛回 `docs/quno-bot-design.md`。

## 17. 测试清单与度量

### 17.1 单元与契约测试

- Trigger producer/trust/dedupe/ContentRef 校验；不存在 source 类别 Trigger.type。
- ThreadResolver 无法证明身份时返回 null，不用文本相似度直通。
- Observation、Request/Response、Command/Result 路由与唯一键。
- Delivery 业务状态与 Transport 状态独立迁移。
- Automatic 未 settle 时 Action/Attention/Notification 均无副作用。
- Action dedupe、租约、重试和晚到 fence。
- Worker once/persistent 结束语义、取消优先和 cold resume。
- Exchange 超时、取消、重复、冲突、晚到和原 requester 返回。
- 引用图授权、prune、跨 Quno 拒绝和全文召回。

### 17.2 真实 AgentLoop / 组合测试

- Human 执行请求立即委派；Automatic 工具只暂存；Notification 不执行领域命令。
- 100 条 Trigger 在 Router 忙碌时合批，空队列零模型调用。
- 所有模型可见输入可由 Session 日志重建；压缩后引用仍可追溯。
- 自动回合 memory write 被真实工具注册表拒绝；梦境来源无自动内容。
- 旧 preset 拓扑下全局执行工具仍不可见，quno_* 不被误过滤。

### 17.3 故障注入与迁移测试

逐项执行 §14 的崩溃窗口；旧库升级保留全部 ID、Session 绑定、checkpoint 和用户状态，重复执行迁移无副作用，回滚不重复通知。

### 17.4 实机与量化验收

- Human/Automatic/Notification 的真实 DOM 投影正确；任务卡、关注按钮和面板连续。
- 指标：Trigger→决策和任务完成 p50/p95、每 100 Trigger 的 Router 调用数与读缓存 token、直通节省比例、batch 大小/耗时、自动 Worker 有效率/重复率、链式召回跳数、通知重复数、重启重复投递与状态倒退数（后两者目标为 0）。

## 18. 终稿自查

- **生产者与语义已分离**：不存在 Sense/Human/Worker 类型 Trigger，只有 producer 元数据和业务 type。
- **单向与配对已分离**：Observation 只 ACK，Request/Response、Command/Result 由 Exchange 配对，Subscription 只路由后续 Observation。
- **返回路径可恢复**：Response 按 ExchangeRecord.requester 返回，非自报地址、非 Thread 广播、非 live Promise。
- **处理与传输已分离**：Delivery 两轴状态消除“收到/理解/完成”混用。
- **自动副作用可回滚**：Automatic 先暂存，T5 提交后执行；Human 保持即时命令路径。
- **持续 Worker 不等于常驻进程**：Worker/WorkerRun 分层，等待可冷恢复，once 兼容旧任务。
- **正文没有第二事实源**：人类与 Worker 内容引用 DSH Session；Sense 内容引用 Quno Event/Blob；模型输入全部可重建。
- **产品边界未被内核吞并**：Attention、Notification、OhMyMemo、低打扰和只读权限仍独立。
- **未知能力没有写成现状**：仅有 §16.1 的运行时接缝属于实施前 Go/No-Go 验证，不再保留概念层开放选择。
