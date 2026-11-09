# 2026-11-05 Quno Super-agent 内核重构程序设计（源码对齐实施终稿）

> 状态：**已于 2026-11-05 按 P0–P5 落地；本文保留为决策历史，实施契约已收敛回 [`docs/quno-bot-design.md`](../quno-bot-design.md)（见其 §18.1）。**
>
> 本文取代此前 `2026-11-01` 的三份目标设计笔记，旧 notes 保留为决策历史。设计依据包括 [Super-agent 文章](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)、公开 [`dsh-superagent-prototype` 源码](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4)（核对的提交为 `8c32a9dc5d72c033816c6a8110b37f40cf94fba4`）以及 Quno 当前实现。Prototype 是研究代码，本文只吸收已核对的机制，不把文章中的未实现方向当作源码能力。
>
> 各实施 PR 必须同步修订 [`docs/quno-bot-design.md`](../quno-bot-design.md)；全部落地后将本设计收敛回该权威文档，本文保留为决策历史。

## 1. 最终决策

Quno 的目标内核采用：

```text
Source/Organ → Trigger → Thread → Eval → Decision
                                  │ accept + Mandate
                                  ▼
                               Ticket
                                  │ Assignment
                                  ▼
                        Executor Session / WorkerRun

已订阅 Thread 的 Trigger → Ticket Input → Assignment（绕过 Eval，不扩大授权）
Worker → Report → Ticket → Router → Notification/Channel
```

核心决策：

1. **Trigger 只表示 Source/器官产生的领域事件。**Worker Report、Ticket Input、Effect、Notification、Exchange Message 和 Channel Message 不伪装成 Trigger。
2. **共享可靠消息底座，不统一所有领域对象。**ID、ContentRef、血缘、传输尝试和恢复机制可复用，业务状态机保持独立。
3. **永久主对话是唯一 Agent Router。**独立 Analyzer 退出目标主链路，但 Eval 是按 primary Thread 串行和合批的领域对象，不是一个全局无差别批次。
4. **Ticket、Mandate、Assignment、WorkerRun 分层。**Ticket 的目标与授权不跟随某个 Executor Session 的存亡。
5. **AttentionItem 继续存在。**它是跨来源的个人关注事项，不是 Ticket，也不是 Prototype 中“一个待回答问题”的同名概念。
6. **自动执行先 observe 后 auto。**所有自动 Ticket 都有不可变 Mandate，恢复时重新验证，权限不能由外部文本扩大。

## 2. 产品不变量与非目标

### 2.1 产品不变量

- 一个 Quno 一条永久主对话，保留 `mainSessionId`、侧栏入口与身份连续性。
- 主对话不直接执行 Shell、文件、网页等具体工作。
- Sense/器官仍独立安装、配置、暂停、诊断，并保留可靠 ACK/checkpoint。
- 动态/关注/任务/运行面板、任务卡、关注反馈、设置页保持原有产品形态。
- 默认「有意义的变化才说」；安静时段、频控、合并、延后、不关注继续有效。
- OhMyMemo 继续保存稳定事实、偏好与经验，不保存事件队列。
- 本地桌面启动即运行；第一阶段执行保持只读。
- 现有事件 ID、Task ID、Session ID、Attention/Notification ID 与用户状态保持连续。

### 2.2 非目标

- 不建设云端常驻、端侧 daemon、多设备同步。
- 不在本次开放 IM/GitHub 等外部写操作；Channel 仅定义未来接缝和保存来源地址。
- 不让 Watchdog 任意修改提示词、权限或 Policy。
- 不用 Ticket 替换 AttentionItem，不用 Trigger 吞并所有内部记录。
- 不引入 Prototype 代码依赖；只在其机制适合 Quno 时重新实现。

## 3. 领域对象与职责

| 对象 | 职责 | 明确不承担 |
|---|---|---|
| Source/Organ | 自治采集、预处理、checkpoint、局部恢复、Trigger 翻译 | 全局路由、Attention、Notification |
| Trigger | 一条不可变来源事件，携带 actor、Threads、正文/引用和来源地址 | 内部 Worker 报告、动作结果 |
| Thread | 时间有序事件流；持有 pending、当前 Eval、Subscription 和 Decision | 跨来源语义事项 |
| Eval | 对一个 primary Thread 的一批 Trigger 做一次判断 | 等待外部条件、直接执行 |
| Policy | 当前准入规则、来源授权、accept mode 与版本 | 具体任务执行 |
| Mandate | 不可变授权：范围、强度、来源身份、依据、Policy 版本 | 随 WorkerRun 临时变化 |
| Decision | accept/stop/ignore/unavailable 的审计结果 | 进程内临时回答 |
| Ticket | 一项被授权的持续工作，持有目标、Input、Assignment、Channel | 依赖某次 activation 判定存亡 |
| Assignment | Ticket 与一次 Executor 实例的绑定 | 永久授权本身 |
| WorkerRun | Assignment 中一次有界执行回合 | Ticket 的完整生命周期 |
| TicketInput | 送入 Ticket 的 Trigger、Policy 变化、Exchange 返回、备注或恢复事实 | 新授权 |
| Report | Worker 对 Assignment 的结构化报告 | 直接写 Attention/Notification |
| Exchange | 异步 Request/Response、Command/Result 配对 | 普通 Observation 广播 |
| Effect | 领域事务提交后的持久工作 | 提交前副作用 |
| AttentionItem | 跨来源、跨 Thread 的个人持续关注事项 | Ticket 状态、消息队列 |
| TicketQuestion | Ticket 上一次具体、待人工回答的问题 | 长期个人关注事项 |
| Notification | 向永久主对话展示的沟通意图 | 任务执行 |
| Channel | Source 管理的外部写入地址与发送能力 | 输入路由、授权 |

命名纪律：Agent Router 是永久主对话；程序路由由 `Intake/Thread` 完成，不再把 `routing.ts` 中的程序也叫一个 LLM Router。

## 4. 共享消息底座与 Trigger 协议

### 4.1 共享元数据

需要跨组件传输或恢复的记录复用以下元数据，但不要求共享领域状态机：

```ts
export type QunoId = string
export type TriggerId = string
export type ThreadId = string
export type TicketId = string
export type AssignmentId = string
export type RunId = string
export type ExchangeId = string
export type EndpointId = string

export type ContentRef =
  | { readonly kind: 'session-message'; readonly sessionId: string; readonly messageId: string }
  | { readonly kind: 'session-seq'; readonly sessionId: string; readonly seq: number }
  | { readonly kind: 'quno-event'; readonly eventId: string }
  | { readonly kind: 'blob'; readonly ref: string; readonly sha256?: string }

export interface MessageMeta {
  readonly id: string
  readonly qunoId: QunoId
  readonly producerEndpoint: EndpointId
  readonly occurredAt: number | null
  readonly receivedAt: number
  readonly summary: string | null
  readonly contentRef: ContentRef | null
  readonly causationId: string | null
  readonly correlationKeys: readonly string[]
  readonly configRevision: number
}
```

Endpoint 使用 `quno:<id>/router`、`ticket:<id>`、`organ:<instanceId>`、`watchdog:<id>`，指向持久 Inbox，不是 live Promise。对象 ID 不构成读取授权。

### 4.2 TriggerRecord

```ts
export interface ActorRef {
  readonly source: string
  readonly id: string
}

export interface ThreadRef {
  readonly source: string
  readonly id: string
}

export interface ChannelRef {
  readonly source: string
  readonly thread: string
  readonly address: Record<string, string>
}

export interface TriggerRecord {
  readonly id: TriggerId
  readonly qunoId: QunoId
  readonly sourceId: string
  readonly eventKey: string
  readonly type: string
  readonly schema: string

  /** 第一项为 primary Thread，负责 Eval；其余只补 Correlation 上下文。 */
  readonly threads: readonly ThreadRef[]
  readonly actor: ActorRef
  readonly human: boolean
  readonly addressed: 'mention' | 'direct' | null

  readonly occurredAt: number | null
  readonly observedAt: number
  readonly receivedAt: number
  readonly summary: string | null
  readonly data: unknown
  readonly contentRef: ContentRef | null
  readonly channel: ChannelRef | null

  readonly operation: EventOperation
  readonly priority: SuggestedPriority
  readonly deadline: number | null
  readonly correlationKeys: readonly string[]
  readonly supersedesTriggerIds: readonly TriggerId[]
  readonly parentTriggerIds: readonly TriggerId[]
  readonly provenance: Provenance
  readonly contentHash: string
  readonly configRevision: number
  readonly expiresAt: number | null
  readonly prunedAt: number | null
}
```

不存在 `sense/human/worker/system` 这样的 Trigger 类型。`type` 写 `im.message.created`、`calendar.event.changed`、`timer.due` 等业务语义；Source 身份由 Host 绑定，actor.human 只说明来源作者，不表示任何内部对象都要 Trigger 化。

现有 `quno.event/v1` 保持兼容：Source 适配器补出 `threads/actor/human/addressed/channel`，缺失作者时使用空 actor id 和 `human=false`，不能猜。

## 5. Source/Organ 接口

### 5.1 现有 Sense 兼容

保留 SenseDefinition、factory、checkpoint、health、ingestBatch、声明的 reliability 五项和 generation。Source 自主决定轮询、监听、推送、预处理、重试、退避、缓存和授权范围内的局部自愈。

Host 负责：配置与声明校验、授权、配额、持久接收、生命周期与健康可见性。Agent Router 不逐步指挥采集，器官也不创建 Ticket、修改 Attention 或发送 Notification。

### 5.2 Thread 与上下文能力

```ts
export type ThreadResolution =
  | { readonly status: 'resolved'; readonly threads: readonly ThreadRef[] }
  | { readonly status: 'unresolved'; readonly reason: string }

export interface OrganCapabilities {
  resolveThreads?(event: ParsedEventEnvelope): ThreadResolution
  readOriginal?(request: {
    readonly triggerId: TriggerId
    readonly part: 'self' | 'thread' | 'root' | 'parent'
    readonly cursor: string | null
    readonly signal: AbortSignal
  }): Promise<{
    readonly items: readonly unknown[]
    readonly nextCursor: string | null
    readonly truncated: boolean
  }>
}
```

`resolved` 必须包含至少一个 Thread，且第一项为 primary。无法证明稳定身份时返回 `unresolved`：适配器建立来源私有单对象 Thread 用于审计和 Eval，但不得自动获得已有 Ticket 的 Subscription。文本相似度和模型猜测不能生成直通身份。

### 5.3 可选异步交换

器官可另实现 `handleRequest/handleCommand`，由 Host 分配 ExchangeId。器官只能通过 `completeExchange(exchangeId, result)` 返回，不能指定任意返回地址。未声明能力返回 `capability-unavailable`。

## 6. Intake 与 Thread

### 6.1 ThreadRecord

```ts
export interface ThreadRecord {
  readonly id: ThreadId
  readonly qunoId: QunoId
  readonly sourceId: string
  readonly threadKey: string
  readonly label: string | null
  readonly lastAt: number | null
  readonly correlatedThreadIds: readonly ThreadId[]
  readonly pendingTriggerIds: readonly TriggerId[]
  readonly activeEvalId: string | null
  readonly expiredCount: number
  readonly meta: Record<string, unknown>
  readonly closed: { readonly at: number; readonly outcome: string } | null
}
```

物理唯一键为 `(qunoId,sourceId,threadKey)`。一个 Trigger 的多个 Thread 关系写入 `trigger_threads`，`ordinal=0` 为 primary；共享 Thread 只形成 Correlation 读取边，不直接产生路由。

### 6.2 Intake 算法

`Engine.receive(trigger)` 是唯一领域接收命令，在调用方的 SQLite 事务内执行：

1. 规范时间和字段；重复 `(sourceId,eventKey)` 返回 duplicate，同键不同内容报 identity-conflict。
2. 执行 Source scope 过滤；filtered 也保留 Trigger 与 Disposition，不生成后续工作。
3. 保存 Trigger 与全部 Thread 关系，更新 Correlation 和 Thread 时间。
4. 对每个匹配 Subscription 创建幂等 TicketInput，区分 owned/context；bot、CI 与人类消息使用相同 fan-out，但权限和恢复不同。
5. 对人类消息计算 `followupOwners`；有 Owner 时不进入 Eval。
6. 无 Owner 的 Trigger 加入 primary Thread.pending；已有 pending/activeEval 不重复排队。
7. 提交后经 Effect 唤醒 Eval 或 Assignment。

Sense 批次接收把 `Engine.receive`、批次回执和 checkpoint 放在同一个 T1 事务中，不再保留「已接收未路由」的跨事务窗口。

### 6.3 Follow-up 所有权

- owned Subscription 上的人类消息由对应 Ticket 的 Executor 判断，不重新 Eval。
- context-only Subscription 只提供 Input，不赋予所有权，也不恢复 ended Ticket。
- 人类 stop 过的 Ticket 不再接收新 Input；需要新的 accept。
- 非人类 stop 的 ended Ticket 可由 owned 人类消息在同一 Mandate 下恢复，恢复前 revalidate。
- bot/CI 可交给 live Ticket，但不恢复 ended Ticket。
- Executor 对超范围消息调用 handback；每个 Ticket 对同一 Trigger 最多 handback 一次。
- 只有所有 Owner 都释放后，消息才回到 primary Thread Eval。
- Ticket 结束时，未 delivered、未 read、未 acknowledged/answered/handed-back 的人类 follow-up 返回 Eval；已处理或纯致谢不重复派发。

## 7. Policy、Mandate、Eval 与 Decision

### 7.1 Policy

```ts
export type AcceptMode = 'off' | 'observe' | 'auto'
export type Strength = 'explicit' | 'inferred'

export interface GateResult {
  readonly admissible: boolean
  readonly strength: Strength
  readonly basis: Mandate['basis'] | null
  readonly reason: string | null
}

export interface PolicySnapshot {
  readonly version: string
  readonly paused: boolean
  readonly acceptMode: AcceptMode
  readonly evalTimeoutMs: number
  gate(trigger: TriggerRecord, thread: ThreadRecord, tickets: readonly TicketRecord[]): GateResult
  revalidate(mandate: Mandate): { readonly valid: boolean; readonly reason: string | null }
  admitsInferred(ruleIds: readonly string[]): boolean
}
```

Policy version 覆盖 accept mode、规则和每个 Source 的授权配置。直接桌面 Human Turn 的显式任务走 direct accept；Source 中的人类/bot 消息按来源 gate 计算 explicit/inferred/not-admitted。

### 7.2 Mandate

```ts
export interface Mandate {
  readonly strength: Strength
  readonly policyVersion: string
  readonly scope: string
  readonly actor: ActorRef
  readonly basis: {
    readonly via: 'direct' | 'addressed' | 'followup' | 'admission' | 'rule' | 'bot'
    readonly sourceId: string | null
    readonly scope: Record<string, unknown>
    readonly matchedRuleIds: readonly string[]
  }
  readonly permissionPreset: 'quno-task'
}
```

Mandate 只在 accept Decision 中生成，之后不可变。只有人类 stop 或恢复时 revalidate 失败会撤回。Policy 变化向受影响 live Ticket 写 PolicyInput，不在半路强制取消；旧 Eval 则按新版本重排。

### 7.3 EvalRecord 与 Decision

```ts
export type EvalStatus = 'delivering' | 'waiting-decision' | 'decided' | 'unavailable'
export type DecisionKind = 'accept' | 'stop' | 'ignore' | 'unavailable'

export interface EvalRecord {
  readonly id: string
  readonly qunoId: QunoId
  readonly threadId: ThreadId
  readonly triggerIds: readonly TriggerId[]
  readonly primaryTriggerId: TriggerId
  readonly strength: Strength
  readonly basis: Mandate['basis']
  readonly policyVersion: string
  readonly status: EvalStatus
  readonly candidateMessageId: string | null
  readonly startedAt: number
  readonly deliveredAt: number | null
  readonly deadline: number
  readonly pausedAt: number | null
  readonly expiryCount: number
}
```

规则：

- 每个 Thread 最多一个 active Eval；期间新 Trigger 留到下一批。
- Eval ID 在领取时生成；崩溃/传输重试沿用持久 ID，人工 reevaluate 或新一轮评估创建新 ID。
- candidate 到达主 Session 后才开始超时计时；暂停时冻结并平移 deadline。
- 超时最多重排两次，第三次记 unavailable；单 Thread 故障不阻塞其他 Thread。
- `off` 不允许 inferred accept；`observe` 记录 `ignore + would_accept`，不创建 Ticket；`auto` 才允许按匹配规则 accept。
- accept 在单事务中写 Decision、Ticket、Mandate、首个 Assignment、 owned Subscription 和 launch/acknowledgement Effects；Source accept 的 TicketId 由 EvalId 派生，重复 accept 返回已有 Decision，不创建第二个 Ticket。
- Eval 不等待异步 Exchange 或外部时间条件；需要等待时由 Source 持续观察，稍后产生新 Trigger。

## 8. Ticket、Assignment 与 WorkerRun

### 8.1 分离模型

```ts
export interface TicketQuestion {
  readonly id: string
  readonly question: string
  readonly triggerId: TriggerId | null
  readonly createdAt: number
}

export interface TicketRecord {
  readonly id: TicketId
  readonly qunoId: QunoId
  readonly title: string
  readonly goal: string
  readonly decisionId: string
  readonly mandate: Mandate
  readonly origin: { readonly triggerId: TriggerId | null; readonly triggerIds: readonly TriggerId[] }
  readonly channels: readonly ChannelRef[]
  readonly mode: 'once' | 'persistent'
  readonly ended: {
    readonly at: number
    readonly by: 'human' | 'executor' | 'source' | 'host'
    readonly outcome: 'completed' | 'failed' | 'dropped' | 'stopped' | 'closed'
    readonly reason: string | null
  } | null
  readonly question: TicketQuestion | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface AssignmentRecord {
  readonly id: AssignmentId
  readonly ticketId: TicketId
  readonly state: 'pending' | 'running' | 'ended'
  readonly executorSessionId: string
  readonly directory: string
  readonly report: WorkerReport | null
  readonly deliveredAt: number | null
  readonly idleAt: number | null
  readonly endedReason: string | null
  readonly createdAt: number
}
```

Ticket 独立决定 open/ended；Assignment 可 pending/running/ended；WorkerRun 只描述一次执行。默认一个 Ticket 复用稳定 Executor Session 和目录，但 retry/recovery 创建新 Assignment，不改写 Ticket/Mandate。

现有 Human Task 默认 `mode=once`；persistent 必须由 Router 显式指定。Human direct accept 以 `sessionId + messageId + toolCallId` 幂等，重复工具调用返回原 Ticket。旧 `task_` ID 原样作为 TicketId。

### 8.2 WorkerReport

```ts
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export interface WorkerReport {
  readonly state: ReportState
  readonly summary: string
  readonly at: number
  readonly artifacts: readonly TaskArtifact[]
  readonly question?: { readonly question: string; readonly triggerId?: TriggerId }
}
```

- `ready` 表示结果可供验收；无待跟随 Thread 的 once Ticket 可完成。
- `waiting` 表示等待新 Input，不占用模型调用。
- `blocked/failed` 暂停自动 Input，直到人类消息、显式 retry 或新 Report 解除。
- `dropped` 表示没有值得交付的工作，默认安静结束。
- Report 只更新 Ticket 并产生 Router relay Effect，不直接写 AttentionItem 或 Notification。
- TicketQuestion 是单次问题；AttentionItem 是长期关注事项，两者通过引用关联，不合并。

### 8.3 Worker 工具与完成

保留只读 `quno-task` preset，新增/约束：

- `quno_worker_report`：提交结构化 Report；
- `quno_thread_handback`：交回超范围 Trigger；
- `quno_thread_follow`：增加 context-only Subscription；
- `quno_thread_unrelated`：退订允许退订的 attached Thread；
- `quno_read/quno_recall`：只读授权对象；
- `quno_exchange`：发起受限异步读取。

Ticket ended 后 Worker 工具拒绝新动作。Source 可对 PR 等 Thread 报 `threadClosed`；Ticket 只有在当前工作完成且其 owning/followed Threads 满足来源结束规则时才关闭，不能只因一次 assistant 回复就结束 persistent Ticket。

## 9. TicketInput 与 SessionTransport

### 9.1 TicketInput

```ts
export type InputKind = 'trigger' | 'policy' | 'note' | 'resume' | 'response' | 'result' | 'text'

export interface TicketInput {
  readonly id: string
  readonly qunoId: QunoId
  readonly ticketId: TicketId
  readonly kind: InputKind
  readonly triggerId: TriggerId | null
  readonly exchangeId: ExchangeId | null
  readonly human: boolean
  readonly context: boolean
  readonly text: string | null
  readonly createdAt: number
  readonly deliveredTo: AssignmentId | null
  readonly deliveredAt: number | null
  readonly readAt: number | null
}
```

Input ID 由 `ticketId + kind + triggerId/exchangeId/sourceRevision` 派生。`deliveredAt`、`readAt` 和 `turnEnded` 分开：写入 Session 不等于被模型读取；被读取也不等于 Ticket 已处理。

### 9.2 三种投递模式

```ts
export type DeliveryMode = 'queue' | 'steer' | 'inject'

export interface SessionTransport {
  resolve(endpoint: EndpointId): Promise<Agent | undefined>
  send(agent: Agent, input: {
    readonly requestId: string
    readonly text: string
    readonly mode: DeliveryMode
    readonly source: {
      readonly kind: string
      readonly form: 'relay' | 'notice'
      readonly summary: string
      readonly runId?: RunId
    }
  }, authorize: () => void): Promise<void>
  flush(agent: Agent): Promise<boolean>
  readSession(agent: Agent): Promise<readonly SessionEventLike[]>
}
```

- `queue` 映射 followup：排队并唤醒 idle Agent。
- `steer` 映射 nextStep：在 running Agent 的下一推理步提供 Eval candidate、Report 或新 Input。
- `inject` 只用于不主动唤醒的上下文通知；若没有后续请求，不得用它代替必要的 queue/steer。

实现采用稳定 `messageId = quno:<requestId>`：扫描持久历史与 live nextTurn/nextStep inbox；同 ID 不重发，同 ID 不同内容报冲突；flush 后才确认传输。新 source 使用 `MessageSourceMap` declaration merge。

### 9.3 读取证据

Executor 监听 `session/event(user/message)` 记录 Input 已进入模型历史，并在后续 Report 或 Turn end 后确认 read。被取消或失败且未进入历史的 Input 保持 unread，在新 Assignment 中重新投递；Session inbox 中的旧副本先移除，避免双份。

自动 Worker 创建通过持久 `mainSessionId` 解析 Router parent，不依赖某次 Human 工具调用的 live `exec.agent`。解析失败时 launch Effect 退避并报告，不伪造父子关系。

## 10. Exchange 与 Channel

### 10.1 Exchange 使用范围

异步 Exchange 只用于可能耗时、排队、离线恢复或跨重启的 Request/Response、Command/Result。本地短读取继续使用 logged Tool call/result，不能同时再走异步 Response。

Eval 不阻塞等待 Exchange。Worker/Router 发起 Exchange 后立即得到 requestId；结果稍后成为 TicketInput 或 Router relay。

### 10.2 ExchangeRecord

```ts
export interface ExchangeRecord {
  readonly id: ExchangeId
  readonly qunoId: QunoId
  readonly kind: 'request' | 'command'
  readonly requester: EndpointId
  readonly responder: EndpointId
  readonly status: 'pending' | 'delivered' | 'responded' | 'consumed' | 'failed' | 'expired' | 'cancelled'
  readonly deadline: number
  readonly requestMessageId: string
  readonly responseMessageId: string | null
  readonly attempts: number
  readonly createdAt: number
  readonly updatedAt: number
}
```

Request 创建时同事务写 Exchange、ExchangeMessage 和 responder Effect；responder ACK 后标 delivered。Response/Result 返回时：

1. 校验 Exchange、已验证 responder 和当前状态；
2. 创建唯一 ExchangeMessage，`responseTo=exchangeId`；
3. 按原 `ExchangeRecord.requester` 写 TicketInput 或 Router relay，不信任自报 replyTo；
4. 标 responded；需求方 Run/Turn 提交后标 consumed。

重复返回幂等，同 Exchange 不同内容报 identity-conflict。过期/取消后的晚到结果只留证据并标 late/superseded，不重开已取消工作。ACK、responded、consumed 分别持久化。

### 10.3 Channel

Channel 是 Source 管理的写入侧，保存地址、当前配置是否允许、链接解析和发送能力。未来启用外部写时：

- 每个 ChannelMessage 有稳定 ID，供外部服务或隐藏标记幂等；
- 同一 Ticket、同一目标对话按顺序发送；
- `gone` 只用于永久不可达，临时错误继续退避；
- Source disabled 时等待，Source 不再监听目标时记录 dropped；
- 外部写仍需独立审批/Mandate 范围，不因存在 Channel 自动开放。

当前版本只保存 ChannelRef，不执行外部 Channel send。

## 11. Agent Router 与工具面

### 11.1 三类主对话回合

| 回合 | 驱动 | 权限与结果 |
|---|---|---|
| Human Turn | 直接用户消息 | 直接回答；显式任务 direct accept；不经过 Source Trigger 重注入 |
| Eval Turn | Eval candidate/Report relay | 读取、评估、路由、Decision；外部工作只写提交后 Effect |
| Notification Turn | 获准 Notification | 只做自然表达，不执行领域命令、不产生新领域事件 |

Human Turn 在下一合法推理边界优先于普通 Eval 工作，不强行打断流式生成。Eval candidate 和 Worker Report 使用 steer/queue 合批，被动 notice 使用 inject。

### 11.2 Router 工具

| 工具 | 职责 |
|---|---|
| `quno_eval` | 读取当前 candidate、批次、Thread 和相关 Ticket |
| `quno_eval_read` | 有界展开 Trigger、原文、Thread、Ticket、Decision |
| `quno_eval_decide` | 提交 accept/stop/ignore/unavailable；accept 事务创建授权工作 |
| `quno_route` | 对 1–20 个显式候选逐项 accept/attach/stop/ignore；单项拒绝不污染其他项 |
| `quno_task` | Human direct start/status/result/stop/retry/note |
| `quno_attention` | 现有 Attention 查询与 expectedRevision 更新 |
| `quno_notify` | 提交主对话通知候选 |
| `quno_read/quno_recall` | 对象图读取与全文召回 |
| `quno_exchange` | 发起受限异步 Request/Command，立即返回 requestId |

Eval Turn 不允许 memory write、任意 Shell/文件/网页执行或无预算的 Ticket 创建。Notification Turn 只保留表达所需最小工具。继续沿用全局执行工具逐名隐藏与 tools.guard，禁止把 preset 自有工具放入 allow-list restriction。

### 11.3 自动回合展示

Eval/relay 输入带程序 source 和 evalId/reportId，UI 默认折叠为运行记录；只有获准 Notification 展开为主动汇报。Human Turn 不折叠。不得伪造 assistant 消息或修改 JSONL。

Notification 的 `presented` 必须绑定 `notificationId + turnId`，不能以之后任意 assistant 回复代替。

## 12. Effects 与 Scheduler

### 12.1 Effects

```ts
export type EffectKind =
  | 'eval-delivery' | 'assignment-launch' | 'input-delivery'
  | 'router-relay' | 'notice' | 'exchange-delivery' | 'channel-reply'

export interface EffectRecord {
  readonly kind: EffectKind
  readonly key: string
  readonly payload: unknown
  readonly seq: number
  readonly generation: number
  readonly attempts: number
  readonly dueAt: number
  readonly since: number
  readonly lastError: string | null
}
```

领域事务中 enqueue，commit 后执行。相同 kind/key 的等待项合并并增加 generation；执行完成/失败按 kind/key/seq/generation 校验，旧执行不能覆盖新 payload。每种 Effect 配置 limit、ordered 和 retry；pause/shutdown 保留等待行。

初始用途：Eval candidate、Assignment launch、TicketInput delivery、Worker Report relay、Notification、Exchange 投递和未来 Channel reply。它是 Action Outbox 的实现，不再另建一套平行动作队列。

### 12.2 Scheduler/Passes

每两秒及 Effect 请求时执行有界 pass：

1. 处理到期 Exchange 和失败重试；
2. 对 active Thread 执行 Eval 超时/启动；
3. 对 active Ticket 处理恢复和待投递 Input；
4. 调度到期 Attention 和 Notification；
5. 空工作只落健康/时间，不调用模型。

现有 `checkIntervalSec` 改作普通 Eval 最大等待/合并节奏。无 Trigger、无到期事项、无待恢复工作时不创建 Eval。Timer 条件由内置虚拟 Source 产生 `timer.due` Trigger；Eval 自己永不等待。

### 12.3 WorkerSlots

初始 `maxWorkers=4`。launch、唤醒、active Turn 和未结束后台工作占用 slot；人类 follow-up 可使用一个额外 slot，且 wake 优先于新 launch。等待人工回答/结果验收时释放 slot；后台 Shell/Subagent 的资源规则在 P0 单独验证，不能把 turn idle 误当资源空闲。

## 13. Attention、Notification、Memory 与 UI

### 13.1 AttentionItem

保留现有 `open/waiting/snoozed/resolved/dismissed/expired`、`nextReviewAt`、materialRevision、evidence 和 expectedRevision。新增通用关联表，将 AttentionItem 链到 Trigger/Thread/Ticket/Exchange，但不把 Ticket 状态复制进 Attention。

用户按钮是 Host Command，直接按 revision 更新；自动 Eval/Router 不能用旧证据覆盖用户刚完成或 dismiss 的状态。

### 13.2 Notification

Worker Report 和 Eval 产生的通知候选都先进入现有 Notification Outbox。继续执行安静时段、频控、materialRevision、合并、抑制和用户反馈检查。

Worker 不再直接写完成通知；固定路径为 `Report → Ticket → Router relay → Notification candidate → Outbox → Notification Turn`。

### 13.3 OhMyMemo

保留 capsule、长期记忆、激进压缩和指针摘要。Eval、Notification、WorkerRun 和程序输入均不参与梦境提取；混合自动回合默认不产生用户事实。Eval Turn 在 Host 工具层禁用 memory write。

### 13.4 保留期

沿用现有 `eventBodyDays=30`、`runDiagnosticsDays=14`、`noticeDays=30` 作为初始值。未结算 Eval/Input/Exchange、未结束 Ticket 证据和未终结 Notification 不按年龄删除；Trigger 正文过期后保留 ID、摘要、hash、血缘和 pruned 标记。磁盘接近配额时先背压和告警，不静默丢弃高价值事件。

### 13.5 UI 映射

- 动态：器官健康、Trigger、Thread、Correlation；
- 关注：AttentionItem 与证据；
- 任务：Ticket、Assignment、WorkerRun、Input、Artifact、TicketQuestion；
- 运行：Eval/Decision 与 WorkerRun 分列筛选；
- 主对话：Human 和 Notification 可见，Eval/relay 默认折叠。

Remote 初版保持现有 `state()` 和 Task Wire 兼容，新增按需 `triggerDetail/threadDetail/ticketDetail/evalDetail/exchangeDetail`，大正文不进入 15 秒轮询。

## 14. SQLite 实施 schema

保留 `$DSH_HOME/quno/quno.sqlite`、单 Host 写入和版本化迁移。以下列是逻辑必需字段；物理命名沿用 snake_case。

### 14.1 来源与 Trigger

- `events`：保留现有 Trigger 字段，新增 `quno_id`、`actor_json`、`human`、`addressed`、`channel_json`、`content_ref_json`；`source_id` 继续 NOT NULL，因为 Trigger 只来自 Source。
- `trigger_threads(trigger_id,thread_id,ordinal,at)`：唯一 `(trigger_id,thread_id)`，索引 `(thread_id,at,trigger_id)`。
- `threads`：§6.1 字段，唯一 `(quno_id,source_id,thread_key)`，索引 active/pending 工作集。
- `trigger_dispositions(trigger_id,filtered_json,eval_id,decision_id,fanout_json,handbacks_json,acked_json,requeued,updated_at)`。

现有 `data_json` 继续作为 Trigger data；旧 `(source_id,event_key)` 唯一约束保留。quno_id 在迁移时经 Source 回填。

### 14.2 Eval 与授权

- `evals`：§7.3 全部字段，索引 `(thread_id,status)`、`(status,delivered_at,deadline)`。
- `decisions(id,quno_id,eval_id,thread_id,trigger_ids_json,kind,strength,reason_json,policy_version,ticket_id,mandate_json,audit_json,created_at)`。
- `subscriptions(id,quno_id,ticket_id,thread_id,mode,origin,start_ingest_seq,revision,cancelled_at)`；mode 为 owned/context，origin 为 eval/source/executor。

### 14.3 Ticket 与执行

- `tickets`：§8.1 字段及 `channels_json/mandate_json/origin_json/question_json`，索引 open/active 工作集。
- `assignments`：§8.1 字段及 report JSON，索引 `(ticket_id,created_at)` 和 pending/running。
- `worker_runs(id,quno_id,ticket_id,assignment_id,status,input_ids_json,fence,lease_until,turn_id,result_json,error_json,cost_json,started_at,finished_at)`。
- `ticket_inputs`：§9.1 字段，唯一稳定 Input ID，索引 `(ticket_id,read_at,delivered_at)`。
- `input_attempts(id,input_id,attempt,message_id,mode,status,reason,created_at,finished_at)`，唯一 `(input_id,attempt)`，索引 messageId。

### 14.4 Exchange、Effect 与既有状态

- `exchanges`：§10.2 字段，索引 requester/responder/status/deadline。
- `exchange_messages(id,exchange_id,kind,producer_endpoint,payload_json,content_ref_json,content_hash,response_to,created_at)`，唯一 `(exchange_id,kind,content_hash)`。
- `effects`：§12.1 字段，唯一 `(kind,key)`，索引 `(kind,due_at,seq)`。
- 保留 `attention_items/attention_history/notification_outbox/notification_attempts/feedback/sense_*/sources`。
- 新增 `attention_links(quno_id,item_id,target_type,target_id)`，唯一 `(item_id,target_type,target_id)`。

旧 `deliveries/runs/tasks` 只用于迁移和 legacy 读取，不进入目标写路径。

## 15. 事务与恢复

| 编号 | SQLite 事务内容 | 提交后动作 |
|---|---|---|
| T1 | Sense Trigger、Intake、Thread、TicketInput、Eval pending、批次 ACK、checkpoint | Eval/Input Effects |
| T2 | Eval 创建、Thread activeEval、candidate Effect | candidate transport |
| T3 | Decision、Ticket/Mandate/Assignment、Subscription、Attention/Notification、Effects | launch/ack/notice |
| T4 | InputAttempt prepared/messageId | queue/steer/inject、flush |
| T5 | Assignment/WorkerRun Report、Ticket 状态、Router relay Effect | relay |
| T6 | Exchange、ExchangeMessage、requester/responder Input/Effect、状态 | Exchange transport |
| T7 | Notification attempt/messageId | Notification Turn 与 Turn 对账 |
| T8 | 未来 ChannelMessage/receipt/effect | 外部 Channel send（当前禁用） |

恢复规则：

- T1 整批失败则不 ACK、不推进 checkpoint；重复批次按原身份返回。
- Eval candidate 未送达不超时；已送达超时只重排本 Thread，最多两次。
- T4 后崩溃按 messageId 查 Session；存在不重复，不存在从 prepared 重试。
- 已 delivered 未 read 的 Input 在新 Assignment 重投；已 read/acked/answered/handed-back 不重复。
- Decision 已提交而 launch 未执行，只恢复 Effect，不重新 Eval。
- Worker 已完成未 relay，从 Assignment/Report 恢复 Effect，不重复执行。
- Exchange responded 未 consumed，只恢复 requester 输入；晚到和取消结果不重开工作。
- Notification 已入队未展示，只恢复 Notification，不重做领域工作。
- 旧 Eval ID、旧 Assignment ID、旧 fence、旧 organ generation 和已取消 Ticket 的晚到写入全部拒绝。

## 16. 包内模块与 Engine API

### 16.1 目录职责

```text
plugin/dsh-quno/src/
  core/
    model.ts        本文领域类型与纯谓词
    policy.ts       gate、Policy version、Mandate revalidate
    intake.ts       Trigger、Thread、fan-out、Eval 排队
    evals.ts        Eval batching、Decision、超时与重排
    tickets.ts      Ticket、Subscription、Input、resume/stop/handback
    assignments.ts  Assignment、WorkerRun、Report、读取证据
    exchanges.ts    Exchange 配对与超时
    engine.ts       唯一领域写入口和角色接口
    memory-store.ts 内存 Repository，供领域测试
  app/
    store.ts        SQLite Repository、事务、迁移和只读查询
    effects.ts      持久 Effect queue
    transport.ts    followup/steer/inject、messageId、flush、对账
    executor.ts     Worker 生命周期、WorkerSlots、后台资源
    assessor.ts     主 Session candidate 与评估工具适配
    outbox.ts       主对话 Notification
    sessions.ts     Router/Worker Session、prompt、preset、source
  organs.ts         现有 Sense 适配与可选 Exchange
  scheduler.ts      Passes、Timer、到期与退避
  recall.ts         对象图与全文召回
  service.ts        Cordis 组合根和窄接口装配
  client/           现有产品面板的 Wire 适配
```

`core` 不做 I/O，不 import `app/organs/client`；`organs` 不 import `app` 私有实现；Client 只消费 Wire 类型。所有注册随 Cordis effect 回收。

### 16.2 Engine 角色接口

| 角色 | 方法 |
|---|---|
| `EngineForOrgans` | receive、threadClosed、completeExchange |
| `EngineForRouter` | candidate、candidateDelivered、decide、directAccept、attach、note、requestStatus、requestExchange |
| `EngineForPeople` | stopTicket、retryTicket、reevaluate、unsubscribe、dismiss |
| `EngineForExecutor` | assignmentStarted、inputsDelivered、inputsRead、turnEnded、deliveryFailed、report、handback、followForContext、markUnrelated、requestExchange |
| `EngineForSettings` | policyChanged |

命令使用 imperative 名称（stopTicket）；适配器事实使用过去式（inputsDelivered）。Engine 是 Trigger/Thread/Eval/Decision/Ticket/Assignment 的唯一写者；Effect、Notification、Source checkpoint 各有唯一写者。

## 17. 数据迁移

1. 备份 SQLite，暂停主动投递与自动工作。
2. `events` 增加 quno_id 并经 Source 回填；补 actor/human/addressed/channel/contentRef 默认值。旧 type/schema/ID/ingestSeq/data_json 不变，source_id 不放宽。
3. 由旧 subject/correlation/parents 和来源适配器生成 `trigger_threads/threads`；无法证明的历史关联只保留原字段，不伪造直通 Subscription。
4. 旧 pending/deferred Delivery 映射到 primary Thread.pending；已处理记录只保留 Disposition，不回放。
5. 旧分析 Runs 标 legacy-analysis，只读展示。
6. 旧 Tasks 迁移为 Tickets：保留 task ID、childSessionId、prompt/goal、结果、产物；mode=once、Mandate 标 legacy-direct、当前状态先由旧 TaskOrchestrator 对账，再生成对应 Assignment。
7. Attention、Notification、Feedback、Sense checkpoint、mainSessionId 和 OhMyMemo 不变。
8. 新 Eval 先以 `observe` 运行，记录 would_accept，不创建自动 Ticket；验证后再由用户显式开启 auto。
9. 每阶段可回滚，但不长期双写或双跑模型；回滚前暂停投递并对账。

## 18. 实施顺序

### P0：运行时接缝探针（Go/No-Go）

在 scratch DSH_HOME 用真实 AgentLoop 验证：

1. followup/steer/inject 三种模式、running 合批、messageId 历史和 inbox 去重；
2. Worker 热追加、等待后冷恢复，以及无 live Human parent 时从持久 Router 创建子会话；
3. Human/Eval/Notification Turn 投影与 notificationId+turnId 展示证据；
4. OhMyMemo 按程序 source/Turn 排除自动内容；
5. 后台 Shell/Subagent 对 WorkerSlot 和 Turn idle 的实际影响。

探针失败先修适配器或按 fork 流程补通用接缝，不进入全量迁移。

### P1：领域 core、schema 与只读 Wire

实现 §3–§8、§14、§17；Legacy Analyzer 暂时继续运行。真实 SQLite 与内存 Repository 行为一致，迁移幂等，旧 UI 不变。

### P2：Transport、Effects 与 Exchange

实现 §9–§12 和 §15 故障矩阵；跑通 candidate、Input、Report relay 和异步 Exchange 的真实持久链路。

### P3：Eval Router 接管

实现主 Session Eval 工具、observe/auto、Mandate、Decision 和自动回合投影。先在 observe 验证，再切换；Legacy Analyzer 不再创建新会话。

### P4：Ticket/Assignment 与持续 Worker

实现 persistent Ticket、Subscription、handback、resume、WorkerSlots 和 Thread 直通；旧 once Task 保持体验，Worker 结果统一切换到 Report→Router→Notification。

### P5：链式召回、Watchdog 与清理

完善对象图、prune 证据、指标和本地只读 Watchdog；删除旧 Analyzer、旧 Delivery 写路径和临时代码，将契约收敛回 `docs/quno-bot-design.md`。

## 19. 测试与量化验收

### 19.1 领域与契约测试

- Trigger 稳定 ID、primary/Correlation、重复与同键冲突。
- Intake fan-out、owned/context、人类 stop、Mandate revalidate、handback 和 unread 回收。
- 每 Thread 单 Eval、忙碌合批、暂停平移、三次超时、单 Thread 故障隔离。
- off/observe/auto、inferred accept 门禁、Policy version 和旧 Decision 防护。
- Ticket/Assignment/WorkerRun 状态独立，once/persistent 完成语义。
- Exchange 原 requester 返回、超时、取消、重复、冲突和晚到。
- Attention CAS、Notification 去重、记忆门禁和引用授权。

### 19.2 真实组合与并发测试

- Human direct accept 立即创建任务；Eval accept 只写提交后 Effect；Notification 不执行领域命令。
- 100 条 Trigger 不制造 100 次 Router 调用；不同 Thread 可独立恢复。
- running Agent 的 steer 合批、idle followup、被动 inject 和重启去重。
- Worker 热/冷恢复、人类优先 slot、后台工作占槽和取消优先。
- 主 preset 无执行工具，quno_* 不被误过滤；模型可见输入全部由 Session 日志重建。

### 19.3 迁移、故障与实机

逐项执行 §15 崩溃窗口；旧库迁移保留 ID、Session 绑定、checkpoint 和用户状态，重复迁移无副作用。实机验证主对话、任务卡、关注按钮、四面板和安静通知。

### 19.4 指标

- Trigger→Decision、工作请求→结果 p50/p95；
- 每 100 Trigger 的 Router 调用数与读缓存 token；
- 每 Thread batch 大小、耗时和超时率；
- Subscription 直通减少的 Eval 比例；
- 自动 Ticket 的 observe/auto 有效率、重复率、取消率；
- Input delivered→read→处理的分段延迟；
- 链式召回成功率与平均跳数；
- 通知重复数、重启重复投递与状态倒退数（后两者目标为 0）。

## 20. 终稿自查

- **没有过度统一领域对象**：Trigger 只来自 Source；Report/Input/Effect/Exchange/Notification 各有状态机。
- **器官自治有边界**：局部恢复不需要 Router 指挥，但不获得全局写权限。
- **配对交换可恢复**：Exchange 按 requestId/responseTo 和原 requester 返回，ACK/responded/consumed 分离。
- **Correlation 不参与路由**：primary Thread 负责 Eval，Subscription 才决定 fan-out。
- **授权与执行分离**：Ticket/Mandate 不随 Session/activation 消亡，Assignment/WorkerRun 可独立恢复。
- **读取证据完整**：delivered/read/turnEnded/Report 分开，Ticket 结束不会吞掉未处理人类消息。
- **自动副作用在提交后发生**：所有外部工作由持久 Effect 执行，无「先启动后记账」。
- **Quno 优势完整保留**：Attention、OhMyMemo、低打扰、可靠感知、只读门禁、保留期和桌面产品形态均未删弱。
- **Prototype 局限没有带入**：不复制 Router 的直接执行工具、无限历史增长、Source 私有逻辑渗入 core 或研究代码本身。
- **未知项只剩运行时验证**：P0 是实施前 Go/No-Go 门，不再保留概念层开放选择。
