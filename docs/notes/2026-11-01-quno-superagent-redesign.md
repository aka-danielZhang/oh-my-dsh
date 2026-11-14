# 2026-11-01 Quno 统一 Trigger 与 Router/Worker 内核重构设计

> 状态：**目标设计，待运行时接缝验证与实施；未改代码，不改变当前行为。**
>
> 触发材料：[《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)。本文吸收其中的统一事件驱动、Router/Worker 分层、Thread 订阅直通、异步 ReAct、Inline & Spill 与链式召回，不引入其 prototype 代码，也不采用云端常驻作为当前产品目标。
>
> 当前行为仍以 [`docs/quno-bot-design.md`](../quno-bot-design.md) 的实现口径为准。各实施阶段必须同步修订该权威文档；全部落地后，将目标契约收敛回权威文档，本文保留为决策历史。

## 1. 决策与主要代价

Quno 从「Sense → 独立 Analyzer → Attention/Notification；用户 → 主对话 → 一次性 Task」重构为「所有控制输入统一为 Trigger；永久主对话作为唯一 Agent Router；Worker 作为持续执行单元；Attention、Notification 与 OhMyMemo 继续承担各自产品职责」。

主要代价是废止「原始事件永不进入主对话」这一内部约束。新约束为：经过确定性过滤、归属路由、长度裁剪与预算控制的未归属 Trigger 可以进入 Router；已有明确 Worker 归属的 Trigger 不再消耗 Router 推理。

永久主对话因此会承担更多自动回合，带来上下文膨胀、提示词注入、自动回合展示与记忆污染风险。方案以 Thread 直通、Inline & Spill、独立自动回合工具门禁、回合投影和记忆来源过滤控制这些风险，而不是继续用独立分析会话回避它们。

## 2. 范围

### 2.1 产品不变量

- 一个 Quno 一条永久主对话；保留现有 `mainSessionId`、侧栏入口与身份连续性。
- 主对话不直接执行 Shell、文件、网页等具体任务，只负责路由、协调、召回与沟通。
- Sense 仍是独立插件，保留安装、配置、暂停、健康诊断、checkpoint 与可靠 ACK 语义。
- 保留动态/关注/任务/运行面板、任务卡、关注反馈按钮与设置页。
- 默认「有意义的变化才说」；安静时段、频控、合并、延后与不关注继续有效。
- OhMyMemo 只保存稳定事实、偏好与经验，不保存事件队列。
- 本地桌面启动即运行；关机后继续运行、多设备同步与云端常驻不在当前范围。
- 第一阶段 Worker 继续只读；对外写操作仍需独立的审批与权限设计。

### 2.2 内核变更

| 当前设计 | 目标设计 |
|---|---|
| 每轮分析创建独立、短生命周期分析会话 | 永久主对话 Router 处理自动 Trigger 批次 |
| 原始事件永不进入主对话 | 有界、可信标记明确的未归属 Trigger 可进入 Router |
| Task 一次启动、一次 settle、一次终态 | Worker 多回合执行，可等待新事件并冷恢复 |
| Delivery 只表示事件对 Quno 的分析投递 | Delivery 表示 Trigger 对 Router、Worker 或 Watchdog 的独立投递 |
| Run 主要是分析运行 | RouterRun 与 WorkerRun 分别记录 |
| 定时检查是主要思考驱动 | Trigger 是驱动，Timer 只是 Trigger 的一种 |
| 全文检索与压缩指针为主 | 对象引用图链式召回为主，全文检索为补充 |

### 2.3 非目标

- 不迁移到云端无状态计算，不引入端侧 daemon。
- 不在当前版本接入 IM/GitHub 等对外写信道。
- 不允许 Worker 自行扩大权限或直接对人类发言。
- 不让 Watchdog 在线修改提示词、权限或触发规则。
- 不为了「统一」而把 DSH 会话正文复制成 Quno SQLite 中的第二事实源。

## 3. 目标架构

```text
                        ┌──────────────────────┐
                        │   永久主对话 Router   │
                        │ 全局协调 / 人类交互   │
用户直接消息 ───────────▶│ 任务分派 / 历史召回   │
                        └───────┬───────▲──────┘
                                │       │
                     创建/协调 Worker   │ 结果、升级、跨任务信息
                                │       │
┌─────────┐   ┌───────────┐   ┌────────▼───────┴──────┐
│ Sense   │──▶│ Trigger   │──▶│ 确定性 Trigger Router │
│ Timer   │   │ Event Log │   │ Fast Path / Slow Path │
│ Worker  │   │           │   └───────┬─────────┬────┘
│ System  │   └───────────┘           │         │
└─────────┘                     未归属/全局   已归属 Thread
                                      │         │
                                      ▼         ▼
                                 Router Inbox  Worker Inbox
                                      │         │
                                      ▼         ▼
                                   Router     Workers
                                                │
                                     只读执行 / 多回合推进
                                                │
                   ┌────────────────────────────┤
                   ▼                            ▼
             Attention 状态               Notification Outbox
                   │                            │
                   └────────── 产品 UI ─────────┘
```

职责边界：

| 组件 | 负责 | 不负责 |
|---|---|---|
| Trigger Log | 保存驱动系统行动的事实与引用 | 不做语义判断 |
| 确定性 Trigger Router | 过滤、Thread 归属、生成 Delivery | 不调用模型 |
| Agent Router | 未归属事件判断、跨任务协调、人类交互 | 不直接执行具体任务 |
| Worker | 一个持久目标的具体执行 | 不直接向人类输出 |
| Attention | 保存仍需关注的业务状态 | 不承担事件队列 |
| Action Outbox | 提交后执行 Worker 等动作命令 | 不由模型绕过提交直接使用 |
| Notification Outbox | 控制何时、以什么内容打扰用户 | 不决定任务如何执行 |
| OhMyMemo | 稳定长期记忆 | 不吸收自动事件洪流 |

「Agent Router」指永久主对话；「Trigger Router」指确定性程序路由，二者命名与代码落点必须区分。

## 4. 统一 Trigger 与事实归属

### 4.1 Trigger 类型

| 类型 | 示例 | 默认信任级别 |
|---|---|---|
| `sense` | 日历改期、RSS 更新、云之家消息 | 外部观察，不作为指令 |
| `human` | 主对话直接用户消息 | 直接人类输入 |
| `timer` | 到期复查、显式提醒、重试 | 系统派生 |
| `worker` | 阶段结果、完成、失败、请求升级 | 系统派生，内容仍需审查 |
| `feedback` | 已处理、延后、取消后产生的事实 | 用户命令的持久结果 |
| `system` | 来源失联、存储压力、绑定损坏 | 系统派生 |

统一事件化不等于所有输入都交给模型。确定性按钮仍是 Host Command：先按 `expectedRevision` 执行，再将结果写成 Trigger。通知表达回合、Outbox 内部重试和 Health 心跳不自动生成新 Trigger；只有实质健康状态变化才生成 System Trigger。

### 4.2 Trigger 字段

```text
Trigger
  id / qunoId / kind
  sourceId?
  eventKey / dedupeKey
  ingestSeq
  threadId?
  subjectRefs[] / correlationKeys[]
  causedByTriggerIds[]
  trust: direct-human | observed-source | derived-system
  occurredAt / observedAt / receivedAt
  summary
  inlineData
  fullContentRef?
  provenance
  configRevision
```

大正文默认只存引用与有界摘要。`causedByTriggerIds` 用于因果追踪、循环检测与成本归集。对象 ID 只用于检索，不构成读取授权。

### 4.3 统一调度，不强制统一正文存储

- Sense 正文继续以 Quno Event/Blob 为事实源。
- 人类消息正文继续以 DSH 主会话日志为事实源，Trigger 只保存 `sessionId + messageId`、摘要与血缘。
- Worker 结果正文继续以其 DSH 会话日志为事实源，Trigger 保存结果摘要、digest 与 `sessionId + seq` 引用。
- 所有进入模型的 Inline 内容和后续工具读取必须能从相应 Session 日志重建；不得只存在于进程内 prompt 或 Quno 私有内存。

### 4.4 人类消息不重复进入 Router

Host 观察主会话 `user/message` 后生成引用型 Human Trigger。原生 DSH 回合就是该 Trigger 的 Router 处理过程，不再把同一消息 `followup` 一次。RouterRun 通过 `messageId/turnId` 关联 Human Trigger。

自动 Trigger 不搭乘直接人类回合，而是使用独立的程序来源回合，以便分别实施工具门禁、两阶段提交、UI 投影与记忆过滤。新的人类消息在下一合法推理边界优先于普通自动批次。

## 5. Thread、Subscription 与 Delivery

### 5.1 Thread 与 Attention 不合并

Thread 是外部对象自然形成的确定性事件流，例如同一个 PR、IM 话题或邮件串；Attention 是 Quno 对「仍需关注什么」的语义状态，可以跨来源、跨 Thread。Thread 负责路由，Attention 负责产品状态，二者通过引用关联。

### 5.2 Thread 身份

按以下来源适配规则确定性解析：

1. 来源明确提供的稳定讨论/对象 ID；
2. 经来源适配器确认可表示 Thread 的 `correlationKeys`；
3. 语义明确的 `sourceId + subjectKey`；
4. 无法证明稳定归属时不建立直通 Thread，只交 Agent Router。

不得把文本相似度、摘要内容或模型临时猜测直接当作高可靠 Thread 身份。跨来源语义合并仍发生在 Attention 层。

### 5.3 两条路径

```text
                     ┌─ 已有 Worker 订阅
Trigger → Fast Path ─┤   → Worker Inbox → Worker
                     │
                     └─ 无归属 / 跨任务 / 需全局判断
                         → Router Inbox → Agent Router
```

Subscription 支持 Worker 与 Thread 多对多关系，记录 `startIngestSeq`、revision 和取消原因。Worker 可退订或将事件交回 Router；退订不影响已持久历史。

### 5.4 独立 Delivery

```text
Delivery
  triggerId
  targetType: router | worker | watchdog
  targetId
  status: pending | prepared | claimed | processed | ignored | deferred | dead-letter
  eligibleAt / attempts / runId
  messageId?
  claimedAt / settledAt / reason
```

唯一键为 `(triggerId, targetType, targetId)`。Router 处理完成不代表 Worker 处理完成；一个 Worker 的结算也不影响其他订阅者。直通只绕过 Agent Router 推理，不绕过持久 Delivery。

## 6. Agent Router

### 6.1 会话与工具面

Router 继续使用现有永久主对话，不创建第二条系统 Router 对话。工具逻辑上分为：

| 工具组 | 职责 |
|---|---|
| `quno_task` | start、stop、status、result、subscribe、unsubscribe、escalate |
| `quno_attention` | 查询和带 revision 地更新关注事项 |
| `quno_notify` | 提交通知候选，不直接投递 |
| `quno_read_* / quno_recall` | 读取 Trigger、Thread、Worker、Artifact 与历史 |
| `quno_batch_settle` | 结算自动批次及其暂存命令 |

主 preset 仍不提供直接执行工具。自动程序回合按可信 source 安装更严格的工具子集：禁止 OhMyMemo 写入、禁止无预算的 Worker 创建、禁止把来源建议当成紧急授权；直接人类回合保留现有管理能力。

### 6.2 三类 RouterRun

| 类型 | 输入 | 命令执行 |
|---|---|---|
| Human Turn | 原生用户消息 | 用户显式命令先持久登记再立即执行，保持即时反馈 |
| Automatic Batch | 有界程序 Trigger 批次 | 工具只暂存命令，批次事务提交后由 Action Outbox 执行 |
| Notification Turn | 已获准的 Notification | 只做受限自然表达，不执行领域命令，不生成新 Trigger |

Notification Turn 是独立的表达运行，不参与 Automatic Batch 的 `quno_batch_settle`，也不能被当作新事项重新路由。其输入、回复与 `notificationId + turnId` 关联，供 Outbox 判定展示结果。

自动回合采用两阶段提交，不能让模型先启动 Worker、随后批次失败却无法回滚：

1. 创建 RouterRun，记录输入 Trigger、配置版本、fence 与租约。
2. 模型调用路由/事项/通知工具时只生成带幂等键的候选命令。
3. `quno_batch_settle` 提交事件处置与暂存命令；遗漏 Trigger 不默认 processed。
4. 单事务提交 Attention 变更、Delivery 结算、Action Outbox、Notification Outbox 与 Run 结果。
5. 提交后执行 Action Outbox；Worker 启动失败只影响动作状态，不回滚已确认的事件判断，并产生可重试/可升级结果。
6. 未 settlement、fence 失效或校验失败时，不执行该批任何暂存动作，Delivery 按重试策略恢复。

### 6.3 Batching 与全双工

- Router 空闲且有到期 Trigger 时，按优先级、等待时长与公平配额取有界批次。
- Router 忙碌时，Trigger 仍先持久化；在当前合法推理边界后合并处理，不逐条增加模型调用。
- 忙碌时可使用 `agent.inject()` 将已持久 Trigger 落到下一次获准请求；空闲时使用 `followup` 唤醒。若当前回合不会产生后续请求，必须在回合边界改用 `followup`，不能让 Trigger 等待一个不存在的请求。`inject` 不负责唤醒，不能把「已提交给 inject」误记为「已被模型接纳」。
- 每批限制 Trigger 数、Inline 字符、工具调用、运行时长与输出；未入批者保持 pending。
- 人类消息在下一合法边界优先于普通自动批次，不为抢优先级强行打断流式生成。
- 每个程序输入都先记录确定 `messageId`，再以日志中的接纳证据推进 Delivery；不确定性通过对账解决。

### 6.4 检查间隔的新语义

用户可见设置可保留，内部含义改为普通 Trigger 的最大等待/合并节奏，而不是无工作也定期唤醒：

- 无 Trigger、无到期事项：零模型调用。
- 高优先级 Trigger：按确定性策略提前组成批次。
- 低优先级 Trigger：等待合并窗口并防饿死。
- Timer Trigger 以 `(timerKey, dueAt)` 幂等生成，重启不重复补发。
- 安静时段默认限制通知，不必停止所有后台分析或只读工作。

### 6.5 自动回合保持安静

自动 Trigger 消息带程序 source 与 `routerRunId`。自动回合默认只显示为运行记录；模型不直接写用户正文，只调用路由与管理工具。只有经 Notification Outbox 准入的内容才展开为「Quno 主动汇报」，无通知候选时 UI 完全安静。

不伪造 assistant 消息、不直接改 DSH JSONL；展示由 Conversation/Turn 投影完成。直接人类回合及其回复不参与自动折叠。

## 7. Worker

### 7.1 Worker 是持久身份，不是常驻进程

Worker 由持久目标、DSH Session、权限范围、订阅与结果组成。`waiting-for-events` 时不保留 live activation，也不消耗模型；新 Trigger 到来后在同一 durable Session 上创建新的 WorkerRun。

WorkerRun 表示一次有界执行回合，Worker 表示跨回合目标。不得以一次 assistant 回复或一次 activation settle 直接判定整个 Worker 完成。

### 7.2 生命周期

```text
created → starting → running ⇄ waiting-for-events
                         │          │
                         │          └─ 新订阅 Trigger → running
                         ├─ blocked / failed / interrupted
                         └─ completed / cancelled
```

分别记录：Turn 完成、Worker 等待、目标完成、结果已交给 Router、通知已展示。目标是否完成由 Worker 的明确结果命令与 Router 确认共同决定，用户取消优先于晚到结果。

### 7.3 创建与投机执行

Worker 可由用户显式委派，也可由自动 Router 批次通过 Action Outbox 创建。自动创建必须满足：

- 来源和动作策略允许；
- 自动任务独立日预算与并发上限未耗尽；
- `(topic, materialRevision, actionKind)` 不重复；
- Quno 未暂停，权限仍为只读；
- 目标、证据引用、cwd 与 permission scope 已固定。

自动创建不得依赖某次人类工具调用留下的 live `exec.agent`；Action Outbox 通过 Router 的持久会话绑定解析父上下文，无法解析时动作明确失败并生成可重试/可升级结果，不伪造父子关系。

第一阶段支持只读投机执行：提前核对证据、搜集资料或准备草稿；有价值才通知，无价值则记录并安静完成。

### 7.4 Worker Inbox 与恢复

- 新 Trigger 先写 Worker Delivery，再尝试唤醒。
- Worker 忙碌时在当前推理边界后组成下一 WorkerRun。
- Worker 冷会话通过持久 Session 恢复，不依赖进程内 activation。
- 投递前持久化 messageId；flush、日志接纳与回合完成分别记录。
- 重启后对账 running WorkerRun：已完成补结果，未完成按策略 cold resume 或标记 interrupted。
- Worker 只向 Router 提交结果，不直接更新 Attention 或向用户发通知，避免多写入者绕过全局协调。

### 7.5 多 Worker 与冲突

Subscription 允许多个 Worker 接收同一 Thread，以便发现共享环境中的相互影响。只读阶段冲突主要是重复调查，以去重和预算控制；未来开放写操作时，需另设共享环境锁、写幂等键与审批规则，不能直接沿用只读并发策略。

## 8. 上下文与长期记忆

### 8.1 Inline & Spill

Trigger 默认 Inline：ID、类型、信任级别、时间、Thread ID、摘要、关联对象 ID、局部正文与续读引用。根据局部性附加少量同 Thread 最近事件、被回复/被取代事件、相关 Attention 与 Worker 摘要。

长正文、完整 Session、文件与旧工具结果默认 Spill。任何 Inline 内容都进入持久 Session 日志；Spill 读取通过 logged tool call/result 完成。

### 8.2 链式召回

目标引用图：

```text
Trigger → Thread → AttentionItem → Worker → WorkerRun → Session → Artifact
```

每次读取返回有界摘录、当前对象 ID、下一跳对象 ID、是否截断与原文是否已 prune。按 ID 的授权读取不受「最近 20 个任务/24 个会话」等展示上限约束；全文检索只作为关键词补充。

原文过期后保留对象 ID、证据摘录、hash 与 prune 标记，不把引用失效伪装成对象从未存在。跨 Quno、跨权限边界的引用必须拒绝。

### 8.3 压缩与 OhMyMemo

保留永久主对话激进压缩与指针摘要。OhMyMemo 仍只读召回加经确认的显式写入，并增加以下硬门禁：

- 程序 Trigger 回合不参与梦境提取；
- 含自动 Trigger 的回合不提取为用户事实；
- WorkerRun 不参与用户记忆提取；
- 自动汇报与 Worker 结果不反向成为 Sense 来源；
- 自动回合在工具层禁用 memory write，不能只靠提示词自觉。

## 9. 状态、事务与恢复

### 9.1 核心对象

| 对象 | 职责 |
|---|---|
| TriggerRecord | 统一事实、引用与血缘 |
| ThreadRecord | 确定性事件流身份 |
| SubscriptionRecord | Worker 对 Thread 的订阅 |
| DeliveryRecord | Trigger 对单个消费者的持久投递 |
| RouterRun / WorkerRun | 一次有界处理及输入、租约、成本与结果 |
| WorkerRecord | 持久目标、Session、权限、订阅与产物 |
| ActionCommand | 自动批次暂存并在提交后执行的幂等命令 |
| AttentionItem | 需要持续关注的业务状态 |
| NotificationOutbox | 用户沟通意图与投递状态 |

所有对象保留 `qunoId`。Timer、ActionCommand、Notification 与 Worker 结果分别使用稳定幂等键，不能共用一个「最后处理时间」。

### 9.2 跨存储不假定分布式事务

Quno SQLite 与 DSH Session 日志之间采用 Outbox/Inbox 对账，不假装存在单事务：

1. 先在 SQLite 持久化 messageId、目标 Session 与待投递状态。
2. 再执行 `followup/inject/sendMessage` 与 flush。
3. 以 Session 日志中的 messageId 和 Turn 证据推进状态。
4. flush 失败或结果不明记 uncertain，读取两侧状态后决定重试，不盲目重发。

Sense ACK/checkpoint、路由游标/Delivery、Run 提交/Attention/两个 Outbox 仍分别在 SQLite 单事务内完成。

### 9.3 通知展示证据

`inbox-durable`、`presented` 与「用户已读/事项完成」继续区分。`presented` 必须绑定 `notificationId + turnId` 的对应回复，不再以「之后出现过任意 assistant 消息」作为充分证据，以免 Router 自动活动造成误判。

### 9.4 循环防护

- Worker 结果默认不回投给产生它的 Worker。
- Notification 表达回合不生成领域 Trigger。
- 自动回合不进入梦境提取。
- 因果链限制深度、Worker 数、模型调用与总预算。
- 同语义结果使用稳定 materialRevision，不以措辞变化生成新工作。
- System Health 只在实质状态变化时生成 Trigger，心跳不进入事件洪流。

## 10. Attention、Notification 与 UI 映射

Attention 不再承担事件队列，但仍是带用户权威状态的持久业务对象。按钮命令继续使用 `expectedRevision`；自动 Router 不能凭旧证据覆盖用户刚完成/ dismiss 的状态。

Worker 结果先形成 Worker Trigger 并交给 Router，再由 Router 提出通知候选。旧「Task 完成直接写通知 Outbox」路径在 Worker 切换后退役，避免同一结果既进 Router 又直接通知。

产品面板映射：

- 动态：Sense 健康、Trigger 与 Thread；
- 关注：Attention 与证据；
- 任务：Worker 目标、等待/运行/完成、订阅、产物；
- 运行：RouterRun 与 WorkerRun，可筛选，不混淆二者成本与状态；
- 主对话：直接人类对话与获准通知，自动处理回合默认折叠。

## 11. 安全与权限

- 来源内容不是授权，不能改变工具、权限、预算、收件人或记忆。
- Router 无直接执行工具；自动回合只能提交受限候选命令。
- 自动 Worker 与人类显式 Worker 分账计量，自动行为不能耗尽用户全部预算。
- 高优先级文本不能自行突破安静时段、工具权限或审批。
- OhMyMemo 写入仅限直接人类语义且满足既有确认纪律，并由 Host 在自动回合硬禁用。
- Worker preset 在注册表和 guard 两层维持只读，不只依赖提示词。
- Sense 仍是可信同进程代码；统一协议不等于第三方 Sense 沙箱。
- 写操作、跨设备 daemon 与多信道输出开放前必须另做威胁建模。

## 12. Watchdog 与部署

Watchdog 作为后续本地独立控制回路，由 Timer Trigger 驱动，读取 Sense 健康、RouterRun、WorkerRun 与持久进度，识别接口故障、长期无实质进展与目标偏离。

第一阶段只读诊断并提出受限恢复命令；重启、取消、续跑等动作经固定服务接口和预算执行，不提供任意修改提示词/规则的能力。确定性对账仍是可靠性主机制，Watchdog 不替代事务与恢复。

当前不采用文章的云端存算分离。模块接口保留未来替换 Session/Worker 执行环境的可能，但不为此提前建设云端控制面。

## 13. 现有模块目标映射

| 当前模块 | 目标处理 |
|---|---|
| `ingress.ts` | 保留，扩展统一 Trigger 类型与引用型输入 |
| `routing.ts` | 改为确定性 Trigger Router，增加 Thread 与 Worker 路由 |
| `scheduler.ts` | 缩为 Timer、到期、退避与批次准入，不再是分析主循环 |
| `analyzer.ts` | 过渡期保留，Router 切换后退出主链路 |
| `runner.ts` | 泛化 RouterRun 协调，保留校验、fence 与事务纪律 |
| `tasks.ts` | 重构 WorkerOrchestrator，支持多回合、等待、订阅与冷恢复 |
| `attention.ts` | 保留，去除事件队列职责 |
| `outbox.ts` | 保留通知通道，强化 notificationId + turnId 展示证据 |
| `recall.ts` | 扩展引用图召回与授权读取，保留全文检索 |
| `presets.ts` | 保留 Router/Worker 两类 preset，分析 preset 随切换退役 |
| `store.ts` | 增加 Thread、通用 Delivery、ActionCommand 与 WorkerRun |
| UI Remote/Panel | 产品形状基本不变，数据改读新对象模型 |

优先复用 DSH 的 Session、`agent.inject/followup`、Subagents、Jobs、SessionQuery、ConversationNodeDefinition 与 Slot 接缝。Electron 壳与桥不新增业务 IPC；只有接缝验证证明能力不足时，才按 fork 流程增加通用能力。

## 14. 迁移方案

### 阶段 0：运行时接缝验证（Go/No-Go）

在大规模迁移前验证：

1. 忙碌 Router 的多个持久 Trigger 能否在下一获准请求有界合并，且日志可重建；
2. Worker 热/冷 Session 能否可靠追加消息、等待后恢复并对账；
3. 自动回合能否按 source/Turn 折叠，且不误伤直接人类对话与通知展示。

任一接缝不成立，先调整实现路径，不进入全量数据迁移。

### 阶段 1：统一存储与路由，保留 Analyzer

- Event 内部扩展 Trigger 字段；增加 Thread、通用 Delivery、ActionCommand 与 Worker Inbox。
- 现有 Analyzer 暂时继续消费 Router Delivery。
- 建立 Inline/Spill、对象引用和来源适配器。
- 验证迁移、幂等、保留期与恢复，用户行为不变。

### 阶段 2：Router 接管自动事件

- 增加独立自动回合、两阶段命令提交、UI 投影与记忆硬门禁。
- 新旧逻辑短期 shadow 对比；shadow 不写真实 Attention、不启动 Worker、不发通知，只记录比较结果。
- 对齐后切换，停用独立分析会话主路径；不长期双跑模型。

### 阶段 3：Worker 持久化与直通

- 改造 Worker 状态机与 WorkerRun。
- 支持等待、退订、升级、多回合和冷恢复。
- 已归属 Thread 切入 Worker Inbox；一次性 Task 作为 Worker 简化形态兼容。
- Worker 完成切换为「结果 Trigger → Router → Notification」，退役直接通知旧路径。

### 阶段 4：召回与 Watchdog

- 完整链式召回与 prune 证据语义。
- 引入本地只读 Watchdog。
- 清理旧 Analyzer、旧 Delivery 假设和临时兼容分支。

### 数据迁移原则

- 保留现有 Event ID，映射为 Sense Trigger；引用型 Human/Worker Trigger 不复制正文。
- 现有 Delivery 映射为 Router 目标；现有分析 Run 标为 `legacy-analysis` 历史，不回放。
- 保留 Task ID、childSessionId、结果与产物；运行中的旧 Task 先按旧逻辑对账再迁移，避免双 settle。
- Attention、Notification、Feedback 的 ID 与用户状态不变。
- Sense checkpoint 不清空；`mainSessionId` 不变；OhMyMemo 数据不动。
- 每个阶段可回滚，但 shadow 不得产生真实副作用，兼容双写不得长期存在。

## 15. 验收与度量

### 15.1 行为验收

- 用户、Sense、Timer、Worker 结果均可经统一 Trigger 追踪，用户消息不重复注入。
- Router 忙碌时 100 条 Trigger 不产生 100 次模型调用；空队列零调用。
- 自动批次未提交前没有 Worker、Attention 或通知副作用。
- 已订阅 Thread 无需 Router 推理即可进入正确 Worker，崩溃后仍可恢复。
- 多 Worker 订阅同一 Thread 时独立结算；退订和升级生效。
- Worker 能运行→等待→冷恢复→再次运行→完成，一次性旧任务不被唤醒。
- 长 Trigger 默认截断，能按引用逐跳召回相关对象；prune 后证据状态诚实。
- 自动事件不进入长期记忆，无价值变化不打扰用户。
- 外部文本不能提升权限、写记忆、无限创建 Worker 或形成事件循环。
- 永久主对话、侧栏入口、关注按钮、任务卡与面板保持产品连续。

### 15.2 故障矩阵

至少覆盖：接收后 ACK 丢失、路由前崩溃、Delivery prepared 后崩溃、inject/followup 后 flush 失败、Router 已返回未提交、Action 已提交未执行、Worker 已完成未回流、Notification 已入队未展示、旧 fence 晚提交、用户反馈与自动提交并发。

### 15.3 量化指标

- Trigger→Router 决策、工作请求→Worker 完成的 p50/p95；
- 每 100 条 Trigger 的 Router 推理次数与读缓存 token；
- Thread 直通减少的 Router 决策比例；
- 平均/最大 batch 大小、单批耗时与单决定成本；
- 自动 Worker 有效率、重复率、取消率与预算占用；
- 通知/处理事项比例、重复提醒数；
- 链式召回成功率与平均工具跳数；
- 重启后的重复投递与状态倒退数（目标均为 0）。

## 16. 自我审查与已修正问题

| 自查问题 | 结论与修正 |
|---|---|
| 「所有输入统一 Trigger」是否会复制人类/Worker 正文？ | 会若照搬；改为统一身份、调度与血缘，正文仍各由 DSH Session 或 Quno Event 持有（§4.3）。 |
| 原生人类消息与 Human Trigger 是否会双重唤醒？ | 增加引用型 Trigger 与原生 Turn 映射，禁止重新 followup（§4.4）。 |
| Thread 直通是否绕过可靠队列？ | 不允许；所有目标先有独立 Delivery，再执行唤醒（§5.4）。 |
| Worker 等待是否意味着常驻 activation？ | 不是；Worker 是持久身份，等待可释放 live Agent，后续冷恢复（§7.1）。 |
| 自动 Router 工具先执行、批次后失败是否会产生不可回滚副作用？ | 初稿存在此问题；已改为候选命令 + 事务提交 + Action Outbox（§6.2）。 |
| 自动回合进入主对话是否会污染 UI 与 OhMyMemo？ | 增加程序 source、Turn 投影、记忆来源过滤和自动回合 memory-write 硬门禁（§6.5、§8.3）。 |
| 模型可见的 Inline/Spill 是否可能只存在内存？ | 不允许；注入与工具读取全部落在 Session 日志，满足可重建要求（§4.3、§8.1）。 |
| 「之后有 assistant 回复」能否证明某通知已展示？ | 不能；改为 notificationId + turnId 对应证据（§9.3）。 |
| Worker 结果直接通知是否绕过全局 Router？ | 切换后退役旧路径，统一结果 Trigger → Router → Notification（§10）。 |
| 自动批处理与直接人类回合混用是否难做权限和事务？ | 自动 Trigger 不搭乘人类回合；Human、Automatic、Notification 三类运行分离，人类消息在下一合法边界优先（§4.4、§6.2）。 |
| Notification Turn 是否会被重复当成领域事件处理？ | 明确为独立表达运行，不执行领域命令、不生成新 Trigger，也不参与批次 settlement（§6.2）。 |
| `inject` 后没有下一请求是否会让队列永久等待？ | 回合没有后续请求时必须改用 `followup` 唤醒，不以 inject 调用成功代替日志接纳（§6.3）。 |
| 自动 Worker 创建是否依赖 live 人类 parent？ | 不依赖；Action Outbox 从持久 Router 绑定解析父上下文，失败则明确重试或升级（§7.3）。 |
| 新旧 shadow 是否可能双写、双通知？ | shadow 只比较，不写真实状态、不启动 Worker、不发通知（§14）。 |
| 引用图召回是否受当前最近任务/会话展示上限约束？ | 按 ID 授权读取不受展示上限约束，全文检索仍有界（§8.2）。 |

## 17. 尚存风险与验证门

以下是当前未证实项，不应在实现前写成既有能力：

1. **忙碌合并接缝**：`agent.inject()` 的确切接纳时机、持久证据与多 Trigger 合并方式需真实 AgentLoop 验证。
2. **持续 Worker 接缝**：现有 Subagents `sendMessage` 能否覆盖等待后的冷恢复与跨重启对账，以及无 live 人类 parent 时如何解析持久父上下文，需验证；必要时走 fork 通用接缝。
3. **自动回合投影**：现有 Conversation/Turn 定义能否完整隐藏自动过程、保留通知与直接人类回复需实机 DOM 验证。
4. **两阶段命令体验**：自动工具暂存与 Human Turn 立即执行的工具语义需要避免同名歧义，实施时按 exec 来源和 Run 类型明确分派。
5. **Router 上下文质量**：真实事件量下是否仍优于独立 Analyzer，必须以 token、通知质量与延迟指标验证；不能仅凭文章结论承诺。
6. **通知表达成本**：沿用通知 Outbox 唤醒主对话可能保留额外表达调用；先维持可靠语义，后续是否优化需单独评审，不能伪造 assistant 日志。

若阶段 0 的接缝验证失败，允许调整适配器或 fork 方案，但不回撤到「未经持久化直通」「自动副作用先执行后记账」或「自动内容进入长期记忆」这三条捷径。

## 18. 最终设计结论

- Trigger 是唯一控制驱动，Timer、Worker 结果与系统异常都属于 Trigger。
- 永久主对话是唯一 Agent Router，Human、Automatic、Notification 三类运行分轨处理。
- Worker 是可持续、可等待、可冷恢复的执行身份，Thread 是确定性路由单元。
- Attention 是产品状态，Notification Outbox 是打扰边界，OhMyMemo 是长期记忆，三者不与事件队列合并。
- 所有直通、异步执行与通知都以持久、幂等、可对账为前提。
- 当前仍坚持本地、低打扰、只读与可审计，不因采用 Super-agent 内核而默认扩大产品权限。
