# 2026-11-14 Quno Router/Worker 程序落地与交互总设计

> 状态：**目标设计，未实施，未改代码。**
>
> 本文基于现行 [Quno 开发说明](../quno-bot-design.md)、2026-11-01 Router/Worker 目标设计、2026-11-05 内核程序设计、2026-11-08 按需只读查询方案和 2026-11-13 结构化 CLI/结果回流实现，给出下一轮完整的产品与程序方案。重点不是重建 Router/Worker，而是统一「主对话里的 Quno」「任务中心里的任务」「按需查看的执行记录」三种投影。
>
> 实施时必须同 PR 收敛 `docs/quno-bot-design.md` 的 §2、§5、§8、§10、§13、§15，并另写实施记录；本文保留为决策历史。

## 1. 产品目标与最终原则

用户的核心诉求定稿为：

1. 主对话里只有 Quno。Quno 接到工作后，以第一人称告诉用户「我来做」，不需要让用户理解 Worker、Executor、Organ、Exchange、CLI、队列或 Session。
2. 用户能看到工作已被接受、当前是否还在进行、是否需要自己回答、是否完成或失败；但不能被内部技术消息反复打断。
3. 用户确实有一个任务列表，可以进一步看到每项工作的执行过程，包括对应执行会话里的消息和工具调用。
4. 执行过程是**只读证据**，不是一个让用户继续输入、误改 Worker 状态的聊天窗口。
5. 任务过程可查看，但默认不打扰；执行细节可钻取，但不污染主对话。

由此固定六条原则：

- **一个身份**：主对话的发言者只有 Quno，始终使用「我」。
- **一个任务事实源**：Ticket / Assignment / WorkerRun / Report / Session 日志是唯一事实，主对话、任务卡和执行记录都只是投影。
- **一次有意义的沟通**：接受、需要用户、完成、失败、取消才进入主对话；普通工具调用和排队回执不进入。
- **一个任务入口**：右栏「任务」是任务列表的唯一入口，不再另建 Worker 列表。
- **一个只读执行入口**：从任务详情进入执行记录，不直接打开可编辑的子会话。
- **不伪造对话**：内部输入仍真实落 Session 日志并交给模型，隐藏只发生在 UI 投影；不伪造 assistant 消息、不改 JSONL。

## 2. 阅读基线与现状判断

### 2.1 已阅读并继承的设计

- [Quno 开发说明](../quno-bot-design.md)：当前唯一权威契约，含 2026-11-13 CLI 与 Exchange 终态回流口径。
- [2026-11-01 统一 Trigger 与 Router/Worker 内核重构](2026-11-01-quno-superagent-redesign.md)：持久 Worker、三类 RouterRun、忙碌合批、Inline/Spill 与恢复原则。
- [2026-11-01 Trigger 协议修订](2026-11-01-quno-trigger-organ-and-exchange.md)：同步 Tool 与异步 Exchange 不重复，ACK/responded/consumed 分离。
- [2026-11-05 Super-agent 内核程序设计](2026-11-05-quno-superagent-program-design.md)：Ticket、Mandate、Assignment、WorkerRun、TicketInput、Exchange、Effect 的领域分层。
- [2026-11-08 按需只读查询方案](2026-11-08-quno-organ-on-demand-read-plan.md) 与 [落地记录](2026-11-08-quno-organ-on-demand-read-impl.md)：能力发现、封闭白名单与 Organ 门控。
- [2026-11-13 结构化 CLI 能力层与结果回流](2026-11-13-quno-cli-capability-and-result-delivery.md)：同步 `quno_cli_call`、Mandate 能力快照、失败/超时持久证据与请求方唤醒。
- [2026-10-30 主对话只路由](2026-10-30-quno-main-routing-only.md) 与 [2026-10-31 工具限制事故](2026-10-31-quno-preset-tool-restriction.md)：主 preset 不直接执行，deny/guard 分离。

### 2.2 可以保留、不能重写的底座

- 永久主对话就是唯一 Agent Router；Executor 是稳定 `quno-exec-<ticketId>` 会话。
- Ticket 保存目标与授权，Assignment 绑定执行实例，WorkerRun 表示一次有界执行；等待时不消耗模型。
- `quno-task` 保持只读，主对话仍无 shell/文件/网页执行工具。
- 本地短 CLI 查询使用同步 `quno_cli_call`；真正异步/远端读取才使用 Exchange。
- Report、Exchange outcome、Effect、SessionTransport 的持久化、稳定 messageId、flush 和恢复机制继续复用。
- 工作区树、扁平列表和搜索继续隐藏 Quno 主会话与 Executor 会话；从任务入口可定向访问。
- 现有右栏「动态 / 关注 / 任务 / 运行」和任务卡可以作为产品接缝，不需要新桌面 IPC。

### 2.3 当前真正缺口

| 缺口 | 当前表现 | 设计修正 |
|---|---|---|
| 主对话暴露技术角色 | 「已交后台」「Worker 报告」「子会话」等文案 | 改为 Quno 第一人称与「任务」语义 |
| 内部输入像用户消息 | composer 上方出现多条「Quno 异步读取失败」排队消息 | 入队前过滤程序消息；入队后隐藏 Chat 节点 |
| 工具过程变成用户负担 | `收到执行请求`、requestId、参数错误、CLI 名词进入消息流 | 主对话只显示任务状态与最终结果；工具细节进执行记录 |
| 进度被误当结果 | 「已发起」「排队中」被说成「查询中/快好了」 | 接受、执行、结果、送达分别建模，文案只陈述已发生事实 |
| 普通 progress 也唤醒主对话 | 每次 Report 都产生 relay | 只有需要用户、实质结果、失败、取消进入主对话 |
| 任务执行记录入口不完整 | 只有 done/cancelled 才显示子会话按钮 | 所有状态都可查看执行记录，运行中尤其重要 |
| 子会话不是只读 transcript | 打开的是正常会话，可能继续提交 | 任务详情内提供只读时间线，不进入可编辑 composer |
| 主对话与执行记录可能漂移 | 卡片依赖 tool meta，详情依赖另一份状态 | 三者统一从 Ticket/Assignment/Run/Report/Session 投影 |

## 3. 总体结构：一个事实源，三种产品投影

```text
用户 / Sense
   │
   ▼
Agent Router（永久主对话）
   │ accept + Mandate
   ▼
Ticket ── Assignment ── WorkerRun ── TicketInput / Exchange
   │                                      │
   │                                      ▼
   │                              Executor Session 日志
   │                                      │
   │                                      ▼
   │                              Worker Report / 终态
   │                                      │
   └──────────── 持久 Effect / SessionTransport ─────────┘
                                          │
                ┌─────────────────────────┼─────────────────────────┐
                ▼                         ▼                         ▼
        主对话投影                   任务中心投影                 执行记录投影
        Quno 第一人称                状态 / 结果 / 操作           只读消息与工具时间线
        接收/需回答/结果             所有状态可钻取               无 composer、无写操作
```

三个投影读取同一份事实，但各自回答不同问题：

- 主对话：Quno 现在需要告诉我什么？
- 任务中心：有哪些工作，当前状态是什么，需要我做什么？
- 执行记录：这项任务具体读了什么、调用了什么、在哪一步失败？

不新增第二套 Worker、第二份任务表或第二个「结果队列」事实源。Effect 和 Session 日志继续承担可靠投递与证据职责。

## 4. 名词与状态投影

### 4.1 用户可见名词

| 层级 | 使用 | 默认不使用 |
|---|---|---|
| 主对话 | Quno、任务、处理中、需要你、已完成、未完成、已停止 | Worker、Executor、子代理、Organ、Exchange、CLI、Session、队列 |
| 任务中心 | 任务、执行记录、当前活动、结果、产物、重试、停止 | Router、Mandate、fence、generation |
| 诊断折叠区 | 执行会话、Assignment、WorkerRun、Exchange、能力名、错误码 | 可将这些默认展开 |
| 开发者轨迹 | 原始事件、工具参数、requestId、turn/seq | 不要求普通用户理解 |

### 4.2 用户状态机

```text
accepted（已接受）
   │ Assignment 已创建，等待执行资源
   ▼
running（进行中） ⇄ waiting（等待外部信息/后续事件）
   │                   │
   │                   └─ 不催用户、不刷主对话
   ├─ needs-you（需要你）── 用户回答 ──> running（原 Ticket 继续）
   ├─ done（已完成）
   ├─ failed（未完成）
   └─ cancelled（已停止）
```

状态由事实推导，不由模型措辞决定：

| 用户状态 | 领域事实 |
|---|---|
| accepted | Ticket/Assignment 已持久化，尚未有 active WorkerRun |
| running | 有 active WorkerRun，或最新 Report 为 progress 且工作仍在继续 |
| waiting | persistent Ticket 等待来源事件，或 waiting Report 等待非用户输入 |
| needs-you | TicketQuestion 非空，或 blocked/failed 需要用户决定 |
| done | once Ticket `ended.outcome=completed`；persistent ready 只表示「有新结果」，不自动等于整个任务结束 |
| failed | `ended.outcome=failed`，或当前工作无法继续且等待用户处理 |
| cancelled | `ended.outcome=stopped` |
| closed/dropped | 没有值得交付的工作；任务列表可记为「无需处理」，主对话默认安静 |

`accepted` 与 `running` 不能共用「正在执行」：资源不足、launch 失败或进程退出时必须能显示「等待执行资源/启动失败」，不能永远显示「正在干」。

### 4.3 活动事实

任务详情可显示一条「当前活动」，但它必须来自真实记录：

- 正在读取最近会话；
- 正在读取指定会话的消息；
- 正在查阅文件或网页；
- 正在整理结果；
- 正在等待你回答；
- 正在等待后续事件。

活动标签由已注册能力/工具的展示声明映射，不让模型自由编写进度，不展示虚假的「第 3/8 步」。没有新的活动事实时，只显示「最近活动于 <时间>」或「等待中」，不用心跳伪造进度。

## 5. 主对话交互方案

### 5.1 主对话只允许出现的内容

1. 用户消息；
2. Quno 的自然语言回复；
3. 一张轻量任务状态卡（有任务时）；
4. 获准的关注/通知卡。

默认不再出现：

- 「收到执行请求」等内部工具卡；
- `quno_exchange`、`quno_cli_call` 的原始参数与结果；
- 【Quno 异步读取失败】等排队回执；
- Worker Report 原文、requestId、organ 端点、CLI argv；
- 多条「我还在等」「结果马上回来」的填充消息。

### 5.2 接受任务

用户：

> 帮我整理最近云之家消息。

Quno：

> 好，我来看看，整理好后在这里告诉你。

同时可出现一张轻量卡：

```text
Quno 任务 · 整理云之家最近消息
状态：进行中                         查看详情
```

卡片只包含任务标题、用户状态、一个主操作。主操作始终是「查看详情」，不是直接跳子会话。运行中可另提供「停止」；不默认展示技术 ID 或执行会话按钮。

接受话术只承诺已建立可靠的结果回流，不能承诺未经验证的时间，如「一分钟就好」。启动失败时必须随后如实纠正，不能停留在「正在干」。

### 5.3 执行过程

- 普通工具调用、CLI 成功、Exchange 入队、异步结果到达都只更新任务投影，不发主对话消息。
- `progress` Report 只更新任务状态和当前活动；默认不产生 Router relay。
- `waiting` 且没有用户问题时不发主对话，不消耗表达模型。
- 用户主动问进度时，Router 用 `quno_task status/result` 读取持久状态后回答；不唤醒 Worker 重做，不额外制造一条「还在运行」通知。
- 长任务不周期性刷「还在处理」。只有状态发生有意义变化才说话。

### 5.4 需要用户回答

Quno：

> 我查到两个同名群。你要整理的是「产品周会」还是「产品周会-全员」？

任务卡同步变为「需要你」。用户回答后通过 `quno_task note` 进入同一 Ticket、同一执行会话继续，不新建任务，不扩大 Mandate。

### 5.5 完成与失败

完成：

> 整理好了。今天需要你回应的有两条：……

失败：

> 我没能完成这次查询：云之家登录已失效。你重新登录后，可以让我从原任务重试。

失败卡提供「重试」或「查看原因」。主对话展示用户可行动的说明，原始 `invalid-args`、`groupId`、CLI stderr 收进执行记录和诊断区。

### 5.6 停止与晚到结果

用户停止后，Quno 只说：

> 已停止这项任务。

任务卡显示「已停止」。晚到结果只留执行证据，不把任务改回完成，也不再向主对话发完成消息。

### 5.7 自动任务

自动 Eval accept 的任务默认只进入任务列表，不在主对话额外说「我开始了」。只有产生值得用户知道的结果、需要用户回答或失败需要处理时才发声；这与「有意义的变化才说」一致。

## 6. 任务中心交互方案

### 6.1 列表

右栏「任务」按以下顺序分组，空组不渲染：

1. **需要你**：有问题、失败待处理；
2. **进行中**：accepted/running/waiting；
3. **已结束**：done/failed/cancelled/dropped。

每行只显示：标题、用户状态、最近活动时间、一个快捷操作。快捷操作只能是查看详情、停止或重试，不直接打开执行会话。

列表继续复用现有有界 `state()`；状态变化更新列表，不向主对话刷消息。打开任务详情时可提高只读刷新频率，离开后恢复原频率。

### 6.2 任务详情

固定信息架构：

1. **概览**：目标、状态、创建时间、耗时、来源（用户交办/自动发现）；
2. **当前活动**：真实活动标签与最近活动时间；
3. **需要你**：问题与回答入口，或失败后的下一步；
4. **结果与产物**：只在真实存在时显示；
5. **执行记录**：所有状态都可进入，运行中默认优先展示；
6. **诊断信息（折叠）**：executorSessionId、Assignment、WorkerRun、Exchange、错误码、权限快照。

「执行记录」在右栏内展开，不跳转出主对话。返回时回到原任务详情与原主对话滚动位置。

### 6.3 执行记录视图

执行记录是只读时间线，包含：

- 任务指令和后续输入；
- Quno Worker 的对外文本（不含隐藏推理）；
- 工具调用名称、用户可读操作名、开始/结束状态；
- 有界、脱敏后的参数摘要和结果摘要；
- Report、错误、取消和终态；
- turn/seq 仅作为定位信息，默认放在诊断样式中。

明确禁止：

- 输入框、发送、编辑、steer、删除队列消息；
- 修改 Worker 权限、模型或 preset；
- 通过该视图直接调用工具；
- 展示凭据、环境变量、隐藏 system prompt 或私有 reasoning；
- 以「完整记录」为名输出无界正文。

操作仍通过任务命令完成：停止、重试、回答。它们调用 Host 的 TaskCommand，不向执行会话手写消息。

## 7. 内部消息与工具投影

### 7.1 入队前：不再显示程序 QueueDock 条目

当前 `QueueDock` 在消息尚未被 Agent 接纳前读取 `inbox.next-turn`，所以仅用 ConversationNodeDefinition 隐藏已入队消息是不够的。

需要增加一个**通用队列展示过滤接缝**，由 Quno 注册：

- `source.presentation = 'internal'` 的新程序消息不进入用户 QueueDock；
- 兼容旧记录时，按已注册的 Quno source kind 集合过滤，不要求历史数据迁移；
- 真实人类排队消息（`source.kind='user'`）完全保留现有编辑、删除、steer 行为；
- 程序消息仍在 DSH inbox 中，仍按原顺序交给模型，过滤只影响展示；
- 不提供用户编辑/删除内部消息的入口，避免破坏可靠投递。

该接缝应属于 DSH Conversation 通用展示层，不写 Quno 业务分支。若现有注册机制无法覆盖 QueueDock，按 fork 流程增加一个小型通用 seam；不新增 Electron IPC，不改 AgentLoop。

### 7.2 入队后：内部输入独占隐藏，Quno 回复正常显示

扩展当前 `qunoNoticeDefinition` 的思路到所有主对话内部来源：

- `quno-eval`、`quno-report`、`quno-notify`、`quno-task` 等程序输入被 `exclusive` 认领；
- Chat 节点 `visibility: hidden`，但 `turnDataSource` 保留 taskId/evalId/notificationId 等业务引用；
- Quno 后续真实 assistant 回复保持原生渲染；
- 不能把隐藏内部输入误写成「用户没有发送任何内容」或阻止模型读取。

### 7.3 工具卡按会话投影

- 主对话的 `quno_task` 工具结果渲染为第 5 节的任务卡。
- 主对话若发起单次 `quno_exchange`，其工具节点按 quno-main 投影隐藏或显示为非技术「正在核对信息」，不展示原始请求卡。
- 执行记录中的同一工具则展示完整操作名、状态和脱敏参数，不做全局隐藏。
- `quno_cli_call` 主要发生在 Worker，主对话不应出现；若装配错误让它进入主 preset，应视为装配失败，而不是靠 CSS 掩盖。

## 8. 端到端消息时序

### 8.1 用户交办、同步 CLI 完成

```text
用户 → Router：整理最近消息
Router → directAccept：Ticket + Mandate + Assignment + launch Effect
Router → 用户：好，我来看看，整理好后在这里告诉你
Host → Executor：恢复/创建 quno-exec-<ticketId>
Worker → quno_cli_call：同一回合取得只读结果
Worker → Report(ready)：结论与产物
Engine → T5：保存 Report + router-relay Effect
Assessor → queue + flush：内部 quno-report
UI：QueueDock 不显示，Chat 内部节点隐藏
Router → 用户：整理好了……
任务中心：done；执行记录保留全部过程
```

### 8.2 真正异步读取

- Exchange 创建时只表示请求已接受，主对话不能说「已经查到」。
- responded/failed/expired 都形成持久 outcome，并回到原 requester。
- Router 请求的结果走内部 relay；Ticket 请求的结果走 TicketInput 唤醒同一 Worker。
- 结果到达只触发一次后续回合；用户取消后晚到结果不重新打开任务。

### 8.3 需要用户回答

Worker `blocked/waiting + question` → 主对话提出一个具体问题 → 用户回答 → 原 Ticket note/input → 同一 Executor 新 WorkerRun → ready → 主对话汇报。整个过程中主对话不出现 Worker 名称。

### 8.4 失败与恢复

- 同步 CLI 失败先作为工具错误回到 Worker；Worker 可以修正一次合法参数，仍失败则如实 blocked/failed。
- 异步 Exchange 失败/超时必须回流，不能留下「处理中」假象。
- Router 正忙时结果排队但不打断；进程重启后按 messageId 对账，不重复汇报。
- 表达失败不等于任务执行失败，任务结果仍保留，只重试沟通。

### 8.5 普通 progress 的 relay 调整

当前每次 Report 都生成 router-relay。目标策略改为：

| Report | 主对话策略 |
|---|---|
| progress | 默认只更新任务中心，不 relay |
| waiting（无用户问题） | 不 relay |
| ready | once 完成只汇报一次；persistent 仅在有新实质结果时汇报 |
| blocked/waiting + question | 必须 relay，形成用户可回答的问题 |
| failed | 必须 relay，给出可行动下一步 |
| dropped | 默认安静，仅任务列表记录 |

该策略是沟通层的过滤，不回写或篡改 Worker 的真实 Report。

## 9. 程序落地方案

### 9.1 Host：新增纯投影，不新增事实源

建议增加一个纯函数任务投影模块（逻辑职责命名即可，实施时按包内落点选择文件）：

```text
输入：Ticket + Assignment + WorkerRun + Report + 最近 Session 活动
输出：TaskPresentation
  status: accepted/running/waiting/needs-you/done/failed/cancelled/dropped
  activityKind?: recent-groups/read-messages/read-file/read-web/summarize/waiting
  lastActivityAt?: number
  canCancel/canRetry/canAnswer/canViewActivity
  resultRevision?: string
```

约束：

- 不写回 Ticket，不生成第二份状态；
- 所有状态可由持久记录重算；
- `resultRevision` 用于 persistent 结果去重，不能按 assistant 文案 hash；
- 活动标签来自工具/能力的展示声明，未知时为通用「处理中」；
- 主对话状态查询、任务卡和任务列表都调用同一投影。

### 9.2 Report relay 策略位置

- Engine 继续保存所有 Report 和必要 Effect；
- Assessor/沟通准入层决定哪些 Report 需要进入主对话，避免把「每份 Report」与「每次打扰」绑定；
- 已过期、已取消、被后续结果取代的 Report 在投递前再次检查；
- 同一 Assignment/Report nonce 的 relay 保持幂等；
- 直接用户 `status/result` 查询不依赖 relay，始终读持久投影。

### 9.3 执行记录 Remote

在现有 `quno` Remote 增加按需只读查询，逻辑接口为：

```text
taskActivity({ taskId, cursor?, limit? })
  → { items, nextCursor, truncated, sessionIdentity? }
```

服务端职责：

1. 校验当前 Quno 对该 Ticket 的读取权限；
2. 从最新 Assignment 解析 executorSessionId；
3. 经 `sessionQuery` 读取真实日志，按 seq 有界分页；
4. 只投影允许的事件类型与字段；
5. 在 Host 完成凭据/环境/隐藏推理过滤和输出截断；
6. 返回稳定游标，旧页面不受新事件追加影响。

建议允许的事件：`user/message`、`assistant/message` 的公开文本、`tool/call`、`tool/result` 的脱敏摘要、turn/step 边界和任务终态。默认排除 system prompt、credentials、环境详情、内部 reasoning 和未声明的原始事件数据。

`sessionIdentity` 只用于诊断折叠区，不进入主对话卡片。旧任务没有新字段时按同一规则从原 Session 回放，无需迁移。

### 9.4 数据 Wire 增量

现有 `TaskWire` 可增量补充，保持旧客户端兼容：

- `presentationStatus`；
- `activityKind`、`lastActivityAt`；
- `canViewActivity`（真实 session 可解析时恒为 true，含运行中）；
- `resultRevision`；
- `originLabel`（用户交办/自动发现的机器枚举）。

客户端文案仍由 locale 字典生成，Host 不下发本地化字符串。

### 9.5 Client 组件调整

| 组件 | 调整 |
|---|---|
| `task-card.tsx` | 只保留标题、用户状态、结果摘要与「查看详情」；移除直接子会话入口和技术文案 |
| `task-list.tsx` | 统一新状态分组；所有状态可钻取执行记录 |
| `task-detail.tsx` | 增加当前活动、执行记录入口、诊断折叠；详情不再依赖 done/cancelled 才显示记录 |
| 新增只读活动组件 | 渲染 taskActivity 时间线、分页、脱敏摘要、无 composer |
| `panel-state.ts` | 与 Host 共用状态语义，处理旧 Wire 缺字段的回退 |
| `report-turn.ts` | 扩展为通用内部来源隐藏与 Turn 绑定 |
| `locales.ts` | 全部产品文案改为 Quno/任务/执行记录，中英双语 |
| `QUNO_CSS` | 只负责视觉，不承担隐藏错误装配或安全过滤 |

### 9.6 Router prompt 与工具结果文案

主对话 prompt 改为第一人称产品纪律：

- 「接到任务后，以『我来做』告知用户；不要描述 Worker、后台会话或内部工具。」
- 「接受后立即结束本轮；结果到达后再依据持久结果回答，不重复汇报进度。」
- 「排队、requestId、工具入队都不是查询结果。」
- 「失败时说明能确认的事实和下一步，不猜桌面更新、并发串参等根因。」

`quno_task` 的模型可见描述与返回文本也采用同一口径，避免 system prompt 说一套、工具结果又诱导模型说「已在后台开始」。Worker 内部 prompt 继续使用技术术语，不影响产品表达。

## 10. 权限、隐私与安全

- 主对话不获得 CLI；Worker 的 `quno_cli_call` 仍受 Mandate 快照与 broker 白名单约束。
- 执行记录只读不改变 Session 的真实写权限；它根本不是一个可提交会话。
- 活动 API 必须先验证 Ticket 与 Quno 归属，不能仅凭传入 sessionId 读任意会话。
- 默认不展示隐藏推理、system prompt、凭据、token、环境变量和未脱敏命令输出。
- CLI 参数与结果按字段白名单投影；长文本有界截断并标 `truncated`，完整隐私数据仍只在原授权 Session 中。
- 停止/重试/回答走 Host Command，保持 revision、幂等和晚到防护。
- 内部输入的 UI 隐藏不影响模型可见日志的可重建性。

## 11. 兼容与迁移

- 不需要新 SQLite 表，不需要迁移 Ticket、Assignment 或 Session。
- `Mandate.cli` 和现有 Exchange 状态机保持不变。
- 新 Wire 字段全部可加可选；旧任务根据现有状态回退投影。
- 旧程序消息通过 source kind 集合隐藏，不要求补写 `presentation` 字段。
- 现有 `openSession(childSessionId)` 可从产品主路径退役为诊断入口；普通用户不再被引导进可编辑子会话。
- 普通 work 会话的 QueueDock、工具卡、会话列表和 composer 行为完全不变。
- 不新增桌面业务 IPC；QueueDock 通用过滤 seam 若需 fork，按 runtime 升级流程单独发 zw 层并钉 revision。

## 12. 实施阶段

### P0：主对话降噪与文案统一

- 第一人称 prompt 与工具结果文案；
- 任务卡简化，所有任务提供「查看详情」；
- 内部 source 入队后隐藏；
- QueueDock 通用过滤 seam 与旧 source kind 兼容；
- progress/waiting 默认不再 relay，ready/failed/question 正确回流。

验收：同一真实任务中，主对话不再出现 Worker、后台、requestId、内部失败队列和原始工具参数；结果只出现一次。

### P1：统一任务投影与只读执行记录

- TaskPresentation；
- taskActivity Remote 与 Host 脱敏；
- 任务列表/详情统一新状态；
- 右栏只读时间线，所有状态可查看，支持分页与返回。

验收：运行中任务能看到当前真实活动；任务详情无输入框，不能向执行会话发消息；主对话仍停留在原位置。

### P2：活动标签与实时性完善

- CLI provider/常用工具的展示声明；
- 详情打开时的有界刷新，离开即停；
- persistent 结果 revision 与合并；
- 诊断区展示 Assignment/WorkerRun/Exchange 关联。

验收：无伪造步骤数、无心跳假进度；persistent 不重复汇报同一结果。

### P3：后续独立设计，不阻塞本方案

- 长 CLI Job 的跨重启恢复；
- 对外写操作与审批卡；
- Typert stream 替代可见区域的轮询；
- 完整富文本 transcript 的更高保真渲染。

## 13. 验收与评测矩阵

### 13.1 主对话行为

- 用户交办后只出现 Quno 第一人称接受话术和轻量任务卡，无 Worker/后台/Session 术语。
- 两次工具调用和两次异步失败均不生成用户可见排队条目；真实用户排队消息仍可编辑/删除/steer。
- CLI 成功、Exchange 入队不被称为「已经查到」；完成后只有一次自然语言结果。
- 普通 progress 不产生额外主对话消息；需要用户时只问一个具体问题。
- 失败后主对话给出真实原因和下一步，不把参数错误归因为并发或桌面更新。
- 取消后晚到结果不发声，状态不倒退。

### 13.2 任务中心与执行记录

- accepted/running/waiting/needs-you/done/failed/cancelled 都能从任务列表进入详情。
- 运行中可看到真实消息与工具活动，不是只有完成后才能看。
- 执行记录无 composer、无编辑、无 steer、无工具执行按钮。
- 返回任务详情与主对话后保留原导航和滚动状态。
- 大正文分页、截断有证据；无凭据、环境变量、隐藏推理泄漏。
- 普通 work 列表与搜索仍看不到 Executor 会话。

### 13.3 可靠性与故障

- Router 忙碌时结果只在下一合法边界处理一次，不 steer 打断。
- CLI 完成未 relay 时重启，只恢复 relay，不重新执行 CLI。
- flush 后崩溃按 messageId 去重，不产生两条用户结果。
- Exchange failed/expired 均有持久错误证据与请求方唤醒。
- blocked → 用户回答 → 原 Ticket 恢复 → ready 全链路无新 Ticket。
- 用户停止与 Worker 完成竞争时，用户取消优先。

### 13.4 必须加入发布门的真实评测

- `main-task-quiet-success`：真实模型 + 真实只读 CLI fixture，主对话无技术泄漏，结果一次。
- `main-task-internal-failure-hidden`：连续两个非法异步请求，QueueDock 无程序条目，任务中心有两次失败证据。
- `task-activity-readonly-running`：Worker 运行中打开执行记录，能看活动，不能发消息。
- `task-report-progress-no-chat`：多次 progress 只更新任务卡，主对话安静。
- `task-result-router-busy-restart`：Router 忙 + 重启，结果只呈现一次。
- `task-activity-redaction`：伪造 token/env/reasoning/长输出，Host 投影全部正确过滤。

前四项应成为本方案的 P0 产品验收，不得只用现有 `cli-capability-*` 证明交互已经合格。

## 14. 度量

- 首次接受话术延迟、任务完成到主对话结果的 p50/p95；
- 主对话内部程序 QueueDock 可见数（目标 0）；
- 主对话 Worker/后台/requestId/CLI/Organ 技术泄漏数（目标 0）；
- 普通 progress 产生的额外主对话回合数（目标 0）；
- 同一结果重复呈现数、重启后重复投递数、状态倒退数（目标 0）；
- 运行中任务执行记录可打开率（目标 100%）；
- 执行记录中未授权写操作数（目标 0）；
- 失败/超时最终可送达率（目标 100%）；
- 任务状态查询导致 Worker 重跑数（目标 0）。

## 15. 非目标

- 不把 Worker 从产品中删除；删除的是主对话里的技术角色暴露。
- 不开放任意 bash，不改变只读 Worker 与 Mandate 边界。
- 不把所有执行细节压进主对话，也不让主对话成为任务控制台。
- 不引入新的消息队列服务或第二份任务/结果事实源。
- 不重写 DSH Chat、AgentLoop、Session 或 Composer；只在必要处增加通用展示 seam。
- 不追求本期长 Job、外部写、云端常驻或多设备。

## 16. 最终定稿

1. 主对话里的执行者始终是 Quno；Worker 只作为执行记录和诊断中的技术事实存在。
2. 接受后只说一句第一人称承诺，普通进度不再反复发消息；结果、问题、失败和取消才进入主对话。
3. 右栏「任务」承载全部任务管理，不再另建 Worker 列表。
4. 所有任务状态都能查看执行记录；执行记录是右栏内的只读时间线，不是可编辑子会话。
5. 内部程序消息入队前与入队后都隐藏，但模型输入与持久日志完全保留。
6. 主对话、任务卡、任务列表和执行记录统一由 Ticket/Assignment/WorkerRun/Report/Session 投影，禁止第二份状态。
7. 同步 CLI、异步 Exchange、Effect 和 SessionTransport 沿用现有底座；本方案主要改造沟通准入、Remote 只读投影和 Client 呈现。
8. 发布验收必须同时证明「结果能回来」与「过程不打扰」，不能再只用工具链路全绿代替产品体验验收。
