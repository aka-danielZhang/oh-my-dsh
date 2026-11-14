# 2026-11-01 Quno Trigger 协议修订：器官自治与配对交换

> 状态：**目标设计修订，待实施；未改代码。**
>
> 本文修订 [Quno 统一 Trigger 与 Router/Worker 内核重构设计](2026-11-01-quno-superagent-redesign.md) 的 Trigger 类型、器官职责和请求/响应模型。其余设计继续继承；冲突处以本文为准。按笔记纪律，原设计记录不改写，最终实施时统一收敛回 [`docs/quno-bot-design.md`](../quno-bot-design.md)。

## 1. 核心修正

原设计把 `sense/human/timer/worker/system` 写成 Trigger 类型，混淆了**消息生产者**与**消息语义**。

目标模型不再存在名为 `sense` 的 Trigger 类型，也不把 `human/timer/worker/system` 作为同类枚举：

- Sense/器官是 Trigger 的生产者，不是 Trigger 的类型。
- 人类、Worker、Host、Watchdog 同样只是不同生产者。
- `type` 只表达领域语义，例如 `im.message.created`、`calendar.event.changed`、`timer.due`、`worker.task.completed`。
- `producer` 说明谁产生消息；`trust` 由 Host 根据已验证生产者与消息语义计算，不能由生产者自报提升。

因此统一 Trigger 协议统一的是**身份、投递、血缘、可靠性与召回**，不是把所有来源压成一种业务事件。

## 2. 器官是自治系统

器官拥有各自的信息收集方案与局部策略：

- 轮询、监听、推送、快照差分与预处理；
- 本地 checkpoint、重试、退避、缓存与缺口检测；
- 在声明范围内的重连、恢复和局部自愈；
- 决定哪些内部变化无需上报，哪些变化需要形成 Trigger。

Host 只负责注册、声明校验、授权、资源上限、持久接收与健康可见性，不代替器官决定具体采集和局部恢复步骤。Agent Router 不指挥器官如何完成每一次采集，只接收器官上报的观察，或在需要时发出明确请求。

类比「皮肤自行愈合、大脑只接收疼痛」时，权限边界仍然成立：局部自愈限于器官已获授权的内部恢复，不自动获得对外写、改全局状态或通知用户的权限。器官也不决定全局 Attention、Worker 创建或 Notification。

## 3. 不是所有交换都成对

Trigger 协议需要区分三类交换语义：

| 交换 | 是否配对 | 完成证据 | 用途 |
|---|---|---|---|
| Observation | 否 | 持久 ACK | 器官观察、状态变化、Worker 进展通知 |
| Request / Response | 是 | Response 被原需求方消费 | 查询原文、补拉历史、探测详情 |
| Command / Result | 是 | Result 被原命令方消费 | 暂停、恢复、取消、受限动作 |

Subscription 不是 Response，而是一句持久路由声明：「把这个 Thread 后续的 Observation 送给我」。ACK 只表示接收方已持久收到，不表示已经理解、执行或回答。

因此：

- 「我观察到疼痛」不需要大脑再回一个业务答案，只需接收 ACK。
- 「我要这份伤口的详细检查」需要 Response。
- 「暂停采集」需要 Result，至少要知道命令是否被接受与完成。

## 4. Trigger Envelope 修订

```text
Trigger
  id / qunoId
  type / schema
  exchange: observation | request | response | command | result

  producer: { kind: organ | human | worker | host | watchdog, id, generation }
  target?: EndpointId
  replyTo?: EndpointId
  requestId?: string
  responseTo?: requestId
  causationId?: TriggerId
  correlationKeys[]

  threadId?
  subjectRefs[]
  trust: direct-human | observed-source | derived-system
  occurredAt / observedAt / receivedAt
  summary / inlineData / fullContentRef?
  provenance / configRevision
```

约束：

- `type + schema` 描述业务语义和版本，不再用生产者类别代替。
- `target` 用于定向 Request/Command；Observation 通常不带固定消费者，由 Subscription 路由。
- `replyTo` 是持久 Endpoint，不是当前 live Agent 或进程内 Promise。
- `requestId` 标识一次配对交换；`responseTo` 必须等于原 `requestId`。
- `causationId` 表示由哪条 Trigger 引起，用于因果链；`threadId` 表示业务事件流。三者不能混用。
- `correlationKeys` 用于领域关联，不能代替一次请求的唯一身份。

现有 `quno.event/v1` Sense 消息默认解释为 `exchange=observation`，`producer` 由 Host 绑定的 Source/SenseInstance 得出，原有语义 `type` 不变。配对交换所需字段作为后续协议版本增加，不要求第一阶段重写所有 Sense。

## 5. 需求方如何获得 Response

### 5.1 持久 Endpoint 与 Inbox

每个可能收发消息的对象都有稳定 Endpoint：

```text
quno:<qunoId>/router
worker:<workerId>
organ:<instanceId>
watchdog:<qunoId>
```

Endpoint 对应持久 Inbox，不对应一次 live activation。即使 Router/Worker 当前不在内存中，Response 仍可先持久投递，等待后续冷恢复。

### 5.2 ExchangeRecord

每次 Request/Command 都建立持久记录：

```text
ExchangeRecord
  requestId
  requestTriggerId
  requester: EndpointId
  responder: EndpointId
  kind: request | command
  status: pending | delivered | responded | consumed | failed | expired | cancelled
  deadline
  responseTriggerId?
  attempts
  createdAt / updatedAt
```

Response/Result 到达时，Host 根据 `responseTo` 找到 ExchangeRecord，并写入**原 requester**的 Delivery。不能仅凭 Response 自报的 `replyTo` 改投其他对象，也不能让无关生产者伪造响应。

### 5.3 一次完整交换

```text
需求方 Router
  │ Request{id=R, target=organ:A, replyTo=quno:q/router}
  ▼
持久 ExchangeRecord(R) + organ:A 的 Delivery
  │
  ▼
器官 A 处理自己的查询策略
  │ Response{responseTo=R}
  ▼
Host 校验 R 与 responder
  │ 写 quno:q/router 的 Delivery
  ▼
Router 在 Automatic Batch 中消费 Response
  │ 批次提交后
  ▼
ExchangeRecord(R) = consumed
```

Request/Command 的 Delivery ACK、ExchangeRecord 的 responded、需求方的 consumed 是三个不同事实。需求方批次失败时，Response 保留可重试状态，不能因已收到就视为已使用。

### 5.4 超时、取消与晚到响应

- 到期未响应：ExchangeRecord 标为 expired，并可向 requester 发 `exchange.expired` System 语义 Trigger。
- 需求方取消：标为 cancelled，后续响应只留证据，不自动唤醒已取消工作。
- 晚到 Response：持久保存并标 late/superseded，不伪造成及时答案，也不默认重新打开已结束事项。
- 重复 Response：按 Trigger ID 与 `responseTo` 幂等处理，不生成重复 Delivery。
- 响应者错误：返回结构化 failed Result，不把无响应当成失败，也不把 ACK 当成成功答案。

## 6. 同步 Tool 与异步 Trigger 不重复

配对交换不意味着所有本地读取都必须改成两条 Trigger：

- 同进程、短耗时、无需跨重启恢复的读取，可继续使用 Tool call/result；两者已落在 Session 日志中，天然成对。
- 跨器官、可能耗时、需要排队、离线恢复或跨重启的读取，使用 Request/Response Trigger。
- 同一个逻辑请求只能选择一条返回路径，不能既同步返回又异步发 Response，避免重复答案。

`readOriginal`、历史补拉、器官 probe 可根据实现分别采用这两种方式；模型看到的是同一个逻辑能力，Host 负责选择并记录交换路径。

## 7. 路由规则修订

原设计的 Observation 两条路径保留，并增加定向与返回路径：

```text
Observation
  ├─ 已订阅 Thread → 各订阅者 Inbox
  └─ 未归属/全局 → Agent Router Inbox

Request / Command
  └─ 按已验证 target → 指定 responder Inbox

Response / Result
  └─ 按 ExchangeRecord.requester → 原需求方 Inbox
```

Response 不再走普通 Subscription 广播，也不因为属于同一 Thread 就投给所有 Worker。一个 Thread 中可能同时存在多个独立请求，所以必须依靠 `requestId/responseTo` 配对。

Automatic Batch 可以同时包含 Observation、Response 和 Result；`quno_batch_settle` 分别结算 Delivery 与 ExchangeRecord，不能用一个 processed 状态掩盖两种生命周期。

## 8. 对原重构设计的替代范围

| 原章节 | 修订 |
|---|---|
| §4.1 Trigger 类型 | 整表废止；生产者改为 `producer`，`type` 只写领域语义 |
| §4.2 Trigger 字段 | 增加 `exchange/target/replyTo/requestId/responseTo` |
| §5.3 两条路径 | 扩展为 Observation、定向 Request/Command、返回 Response/Result 三组规则 |
| §6 Agent Router | Automatic Batch 增加 Response/Result 消费与 Exchange 结算 |
| §8 Inline & Spill | 原文读取可为同步 Tool，也可为异步 Request/Response，二者不重复 |
| §9 核心对象与恢复 | 增加 ExchangeRecord、超时、取消与晚到响应矩阵 |
| §14–§15 迁移与验收 | 增加配对交换迁移、重启恢复和幂等验收 |

未列章节继续继承原设计，包括永久主对话、三类 RouterRun、两阶段自动命令、Worker 持久身份、Attention/Notification 分工、OhMyMemo 门禁和本地只读边界。

## 9. 新增验收场景

- Observation 只收到 ACK，不产生 Response 风暴。
- 两个 Worker 在同一 Thread 同时查询同一器官，Response 各自回到正确 Worker。
- Request 发出后进程退出，Response 在重启前到达；重启后仍能恢复 Exchange 并交原需求方消费。
- Response 已到达但需求方批次失败，重试后只消费一次。
- 过期、取消后的晚到 Response 有证据但不重开工作。
- 伪造 responder、篡改 `responseTo` 或自报 `replyTo` 不能改变返回地址。
- 同步 Tool 与异步 Response 不会为同一请求重复返回答案。
- 器官局部自愈不产生全局副作用，也不需要 Agent Router 逐步指挥。

## 10. 自查结论

- 删除的不只是 `sense` 类型，而是整个按生产者分类的 Trigger.kind 思路。
- 器官自治不等于器官获得全局权限；局部策略与全局判断仍分离。
- 收发并非一律成对：Observation 单向、Request/Response 与 Command/Result 配对、Subscription 持续路由。
- 配对不能只用 Thread ID；必须有独立 `requestId/responseTo` 和持久 ExchangeRecord。
- 返回地址以原请求记录为准，不信任 Response 自报；ACK、responded、consumed 分开持久化。
