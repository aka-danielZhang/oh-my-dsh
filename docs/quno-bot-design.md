# Quno 开发说明（交互与技术设计）

> 本文是 Quno 的唯一权威开发说明，由三份当日提案合并而成：主对话/子任务/压缩设计、事件流个人助理设计、Sense 感知契约（原始提案见 `docs/notes/2026-10-22-quno-bot-design.md`、`docs/notes/2026-10-22-quno-event-stream-design.md`、`docs/notes/2026-10-22-quno-sense-contract.md`，保留为决策历史，不再各自维护）。合并对齐结论见 `docs/notes/2026-10-23-quno-dev-spec-merge.md`。
>
> 状态：**已实现（2026-10-23，一期/二期/三期全部落地并验证）**；实现记录与偏差见 §18。涉及的其他主题契约以其权威文档为准（壳 → `electron-shell-contract.md`；桥 → `desktop-bridge-contract.md`；记忆 → `ohmymemo-memory-space.md`；落点 → `plugin-monorepo.md`）。
>
> **2026-11-05 内核重构已落地**：Trigger → Thread → Eval → Decision/Mandate → Ticket → Assignment → WorkerRun/Input/Report → Effect → Notification 的目标内核已实现并替换旧的「Delivery/Run/Task」写路径；程序设计终稿见 [Super-agent 内核重构程序设计](notes/2026-11-05-quno-superagent-program-design.md)（保留为决策历史，本文为唯一权威契约）。落地记录见 §18.1。

## 0. 一页摘要

**Quno 是一个持续关注你的事情、按你指定的节奏整理信息、在值得打扰时主动找你的个人助理。** 它有自己的身份、职责、关注范围、工作节奏和**一条永久主对话**。

- **一个 Quno = 一条永久主对话**：没有「新建会话」，对话只追加、永不重开。身份连续，用户始终知道去哪找它。
- **三条独立节奏**：采集频率（Host 按采集器声明与 hint 调度）、思考频率（用户给 Quno 配置）、通知频率（打扰策略 + Quno 判断）。高频采集 ≠ 高频推理 ≠ 高频通知。
- **感知靠 Collector**：采集器按统一契约（`quno.collector/v2`）实现 `run(ctx)`，由 Host 统一定时调度并推导健康；每次 run 的观察经同一事务性 ingest 提交 Trigger。采集器可另声明受限的按需查询面（Exchange 白名单）：端点 `collector:<instanceId>` 经 `quno_read.collectors` 发现，门控校验「实例挂载且类型声明 `handleRequest`」，拒绝时列出真实可用端点。
- **判断与执行分离**：Eval 在永久主对话里按 Thread 串行合批判定；actual 工作跑在独立只读 Executor 会话（Ticket/Assignment/WorkerRun），结果经结构化 Report → Router relay → 通知 outbox 回流主对话。
- **主对话激进压缩 + 可检索历史**：上下文 ~50% 即滚动压缩，摘要带原文指针；全量历史永不删除，靠 `quno_recall` 全文检索召回。长期记忆复用 OhMyMemo。
- **落点**：一个 dual 插件 `dsh-quno`（preset-owned）+ 采集器插件族 `dsh-quno-collector-<name>`；壳与桥零改动、零新 IPC、不改 harness loop。

## 1. 产品定义

名称 Quno（读作 Koo-no），借奥丁渡鸦 Muninn 的意象：巡游世界、带回消息。首版只有一个实例，默认名 Quno；数据模型与接口全部带 `qunoId`，保留多实例隔离能力。

用「五官」理解职责划分：

| 部件 | 职责 | 不承担 |
|---|---|---|
| Collector（采集器） | 采集：按 Host 调度观察来源、提交事件 | 不决定是否打扰用户 |
| 事件收件箱 | 保存所见所闻（可重放、可追溯） | 不做判断 |
| Eval / Decision（永久主对话） | 按 Thread 合批判定来源事件、授权工作、维护关注事项 | 不直接执行 shell/文件/网页；不写长期记忆 |
| 关注事项 | 记住还没结束的事 | 不是待办列表的替身 |
| 主对话 | 与用户沟通的唯一长期入口 | 不承担事件队列职责 |
| 长期记忆（OhMyMemo） | 稳定偏好与事实 | 不存事件流 |

### 1.1 首版体验示例

1. 创建默认助理「Quno」：关注消息中需要回应的事项、今天的日程、临近截止的待办。
2. 接入消息与日历两个采集器，Host 按各自声明与 hint 调度。
3. 设置 Quno 每 5 分钟检查一次，22:00–08:00 不主动打扰。
4. 采集器发现一段讨论、一次会议改期、一个待办截止变更。
5. Quno 判断三者相关，在主对话里说：

> 明天的评审改到 10:00 了，与你的客户会议冲突。群里还在等你确认时间，建议今天先回复。演示材料仍在今晚 18:00 截止。
>
> 来源：评审讨论 · 日历更新 · 材料待办　　操作：已处理 / 一小时后提醒 / 不再关注

6. 用户回复「材料我交了，评审一小时后提醒」→ 更新两条关注事项；一小时后即使没有新事件也重新评估。

### 1.2 关键决策总表

| 决策 | 选择 | 理由 |
|---|---|---|
| 实现位置 | DSH 出树插件，业务在 Host | 薄壳契约；可迁移运行载体 |
| 采集协议 | 来源无关事件信封 + 来源自定义 payload | 统一可靠性与追踪，保留来源表达力 |
| 采集与消费 | 先持久化接收，再独立调度消费 | 模型慢/宕机/对话忙不阻塞采集 |
| 业务状态 | Trigger、Eval/Decision、Ticket/Assignment、通知分别持久化 | 「已收到」「已判定」「已授权」「已执行」「已告诉用户」是不同事实 |
| 判断位置 | Eval 在永久主对话（唯一 Agent Router）内完成；实际工作用独立只读 Executor 会话 | 一个 Quno 只有一个 Agent Router；原始事件正文不进主对话上下文 |
| 用户入口 | 每个 Quno 一条长期主对话 | 身份连续 |
| 主对话上下文 | 激进滚动压缩 + 指针摘要 + 全文召回 | 永久对话必须轻装，且历史可查 |
| 首版行动范围 | 读取、分析、生成建议、维护 Quno 状态、提醒本人 | 先验证闭环；对外写操作是后续独立能力 |
| 调度 | Quno 自有 2s 有界 pass + 持久 Effect outbox | 无 Trigger/到期记录时不调模型；提交后动作全部可恢复 |
| 用户提醒 | 原生 Schedule（投递进主会话） | 对话里「提醒我 X」是自然需求，复用现有机制 |
| 通知默认策略 | 有意义的变化才说 | 空检查不发声；「每轮有内容都汇报」仅作可选项 |
| 紧急唤醒 | 首版默认关闭 | 提前唤醒/突破安静时段需用户单独允许，防内容里的「紧急」二字无限调模型 |
| 运行形态 | 桌面客户端启动即运行 | 关机继续运行不需要；云端常驻移出范围 |
| 存储 | Quno 专用 SQLite（`$DSH_HOME/quno/quno.sqlite`），单 Host 写入 | 需要多表事务/索引/游标/outbox 同步提交；DSH storage KV 无跨记录事务契约 |
| 长期记忆 | OhMyMemo 复用，Quno 侧只读召回 + 显式写入 | 不 import 实现、不写它的私有文件 |
| 多 Quno | 首版一个实例，消费状态全带 qunoId | 未来增实例无需重做数据结构 |

## 2. 总体架构

```text
外部来源 ──> Collector（Host 调度；局部采集、预处理、重试、checkpoint）
                │  batch：校验 / 去重 / 持久化 / ACK（同一 SQLite 事务）
                ▼
          Trigger（只来自 Source 的不可变事件）
                │ Intake：ThreadResolver + Scope 过滤 + Subscription fan-out
                ▼
      Thread（primary 负责 Eval；其余只补 Correlation）
                │ 每个 Thread 至多一个 active Eval，按批合并
                ▼
      Eval ──> 永久主对话（唯一 Agent Router）──> Decision / Mandate
                │ accept（单事务）                      │ ignore/stop/unavailable
                ▼                                      ▼
      Ticket（目标 + 授权 + Input + Subscription）   审计记录
                │ Assignment（Ticket ↔ executor 实例）
                ▼
      Executor Session（只读 `quno-task`）──> WorkerRun（一次有界回合）
                │ Report / handback / follow / exchange
                ▼
      Ticket 状态 + Router relay Effect
                │
                ▼
      通知 outbox（安静时段/频控/合并/时效）──> Notification Turn（自然表达）
```

五条不能合并的流：

- **Trigger/Thread 流**：来源事实与时间有序上下文，可重放追溯。
- **Eval/Decision 流**：一次判断的候选、证据、授权与审计。
- **Ticket 流**：一项被授权的持续工作及其目标、授权、输入和结束语义。
- **执行流**：Assignment/WorkerRun 的绑定、投递、读取证据和报告。
- **沟通流**：通知候选、去重/时效/安静时段、展示证据与用户反馈。

### 2.1 三类回合，一个会话

Quno 只有一条永久主对话；它按输入来源分成三类回合：

| 回合 | 驱动 | 权限与结果 |
|---|---|---|
| Human Turn | 用户直接消息 | 直接回答；显式任务用 `quno_task`/`quno_route` 创建 direct Mandate |
| Eval Turn | 程序注入的 Eval/Report relay（source `quno-eval`/`quno-report`） | 读取、评估、路由、Decision；禁止记忆写入、提醒创建与执行 |
| Notification Turn | 获准的 outbox 通知（source `quno-notify`/`quno-task`） | 只做自然表达，不执行领域命令、不产生新领域事件 |

Executor 会话是独立的只读子会话（`quno-task` preset，稳定 id `quno-exec-<ticketId>`），不进入主对话上下文；Worker 只通过结构化 Report 回流。程序注入消息使用稳定 message id（`quno:<requestId>`），重启按 id 去重；source 的 `kind` 是回合分类与记忆门禁的唯一依据。

## 3. 核心对象模型

| 对象 | 核心字段 | 语义 |
|---|---|---|
| QunoDefinition | id、name、persona/instructions、model、mainSessionId、configRevision、acceptMode、autoSourceIds | 持久身份与策略；与某次运行分离 |
| CollectorType / CollectorInstance | type、definition、configRevision、checkpoint、health、可选 `query` 能力 | 采集能力定义 / 一份运行配置（§6） |
| Source | sourceId（Host 分配）、scope | 事件来源身份；Trigger 只来自 Source |
| Trigger | triggerId、sourceId、eventKey、threads[primary,…]、actor、human、addressed、type、occurredAt、data、contentRef、channel、provenance、contentHash | 不可变来源事件；内部对象（Report/Input/Effect/Exchange/Notification）不是 Trigger |
| Thread | id、sourceId、threadKey、pending、activeEval、correlatedThreads、closed | 时间有序流；primary 负责 Eval，其余只提供 Correlation |
| Eval | id、threadId、triggerIds、strength、basis、policyVersion、status、candidateMessageId、deadline | 一批 Trigger 的一次判断；每个 Thread 至多一个 active |
| Decision | id、evalId、kind（accept/stop/ignore/unavailable）、ticketId、mandate、audit | 可审计的结论；重复提交幂等 |
| Mandate | strength、policyVersion、scope、actor、basis、permissionPreset | 不可变授权；只在 accept 中生成，恢复前重验 |
| Ticket | id、title、goal、mandate、origin、channels、mode、ended、question | 被授权的持续工作；不随 Session 存亡 |
| Assignment | id、ticketId、state、executorSessionId、directory、report | Ticket 与一次 Executor 实例的绑定 |
| WorkerRun | id、assignmentId、status、inputIds、fence、turnId、result | Assignment 内一次有界执行回合 |
| TicketInput | id、ticketId、kind（trigger/policy/note/resume/response/result/text）、human、context、deliveredAt/readAt/acknowledgedAt/handedBackAt | 送入 Ticket 的工作；身份稳定，投递/读取/处理分开 |
| WorkerReport | state（progress/waiting/ready/blocked/failed/dropped）、summary、artifacts、question | Worker → Router 的结构化报告 |
| Subscription | ticketId、threadId、mode（owned/context）、origin、startIngestSeq、cancelledAt | owned 才能接管人类 follow-up；context 只提供输入 |
| AttentionItem | id、topicKey、status、revision、materialRevision、evidence、nextReviewAt | 跨来源的个人持续关注事项（不是 Ticket） |
| Exchange | id、kind、requester、responder、status、deadline、request/responseMessageId | 异步配对问答；ACK/responded/consumed 分离 |
| Effect | kind、key、payload、seq、generation、attempts、dueAt | 提交后执行的动作 outbox；同 key 合并、旧执行不可覆盖 |
| Notification | id、topicKey、materialRevision、reason、evidence、expiresAt、status | 一次有意义的沟通意图 |

命名纪律：**Agent Router 就是永久主对话**；程序侧的路由叫 Intake/Thread，不再把 `routing.ts` 之类的确定性 fan-out 也叫 Router。

## 4. 主对话层

### 4.1 交互承诺

- 一个 Quno 一条永久主对话，UI 无「新建会话」「清空上下文」。「重来」诉求由记忆修正（`memory_forget`）承担，日志只追加。
- **主对话只路由、不直接执行**：需要独立执行或依赖外部证据的任务必须立即 `quno_task`，不得以「简单/只查一下」为由自己完成。主 preset 不提供 shell、文件、网页、Skill、Goal 等执行入口；委派返回后马上应答，结果回流后只转述。用户追问进度或结果时，用 `quno_task` 的 `status/result` 读取持久任务记录，不依赖进程内 activation，也不反复轮询。
- **执行工具在注册表层被挡住**（2026-10-31 定稿）：宿主全局面（dsh-base 行、MCP）注册的执行工具对本会话**逐名 deny 隐藏**（`HIDE_GLOBAL_TOOLS`，名单内不存在的名字跳过，动态 MCP 名单不可穷尽）；其余非路由调用由 `tools.guard` 返回「只负责委派」拒绝。**禁止把 allow-list 传给 `tools.restrict()`**：preset row 的 restriction 落在本 preset 自己的 scope 层，对该层的工具（`quno_*` 等）而言是「后代 agent 的继承面」，allow-list 会把它们从所有加入 agent 的模型视图中过滤掉（2026-10-31 事故，见 `docs/notes/2026-10-31-quno-preset-tool-restriction.md`）。装配健康由 per-request 的 `systemPrompt.tools` provider 校验（必需工具缺失时 logger.error 报「装配缺少必需工具」，不抛错打断回合）。
- 事件原始内容**永不进主对话上下文**——进主对话的只有：用户消息、Quno 回复、主动汇报 notice、子任务回流 notice。主对话因此天然增长缓慢；压缩是第二道防线而非主机制。
- 主动汇报在消息流里折叠显示为「Quno 主动汇报」，来源可查看（具体渲染需基线冒烟验证）。
- 汇报消息带确定性操作按钮（已处理 / 稍后提醒 / 不再关注），按钮提交带事项 `expectedRevision` 的服务命令。
- 主对话**不挂 `thread_handoff`**：该功能整体不需要，dsh-thread 直接退役下船（§16.1），Quno **不做能力承接**——不是体验替换。

### 4.2 绑定与归属

- `QunoDefinition.mainSessionId` 绑定一条 durable Session（`agentPreset: 'quno'`，preset 随会话持久化，resume 还原同一组合）。启动时对账 `sessionPersistence.stat`，丢失则 fail loud，**不静默新建**（那等于悄悄失忆）。
- persistence 单写者锁保证同时只有一个进程写；声明主对话归桌面 Host 所有，终端 `dsh web` 同开是未定义行为（文档约定，不锁死）。
- 归档 Quno 对话应引导暂停 Quno 或换绑对话，不得继续向归档对话静默投递。

### 4.3 激进压缩

主对话 preset 的 compaction realm（`isolate: { compaction: true, toolResultPruner: true }`）：

| 旋钮 | stock 默认 | Quno | 理由 |
|---|---|---|---|
| Provider | compaction-basic | dsh-compaction-hierarchical（已随包） | 永久对话历史可任意大，map-reduce 是必需品 |
| 压力触发点 | `floor(min(W×0.8, W−O−64K))` | ~50% | 不等爆；摘要输入短、质量高 |
| 近期尾部保留 | 16% of `W−O` | ~8% | 细节可靠 `quno_recall` 查回 |
| 工具结果剪枝 | 先剪后压 | 保留 | 无模型调用的便宜剪枝优先 |

配套演进（dsh-compaction-hierarchical 侧或 quno 专用子类 Provider）：

- **摘要带指针**：固定章节注明覆盖的 turn/seq 区间与涉及 taskId/runId；配合 `traceEvent` 的 `replacementChain`，任何被压掉的原文可精确找回。
- **永不压缩区**：system 身份段在 node 0 天然豁免；OhMyMemo capsule 是每 turn 首步动态注入，不进压缩区间——「身份与记忆永不压缩」由现有机制满足。
- 已知限制沿用：模型切换后首个 pre-step 按旧容量判断；Quno preset 固定默认模型规避。

### 4.4 历史召回：`quno_recall`

主对话工具，入参 `{ query, timeRange?, scope?: 'main'|'tasks'|'all', refId? }`：

- 实现：`sessionQuery.searchEvents`（主会话内全文）/ `searchSessions`（限定本 Quno 会话集合：主会话 + Ticket 的 Executor 会话）→ `readEvent` 带上下文窗口取原文 → 命中压缩区间时经 `traceEvent` 替换链追到 shadow 前原文。
- 输出**带 seq/时间戳的摘录**而非全文；模型引用后决定是否深挖。
- 「可以查很多历史记录，像人一样」= 检索能力，不是上下文长度。

### 4.5 长期记忆（OhMyMemo 复用纪律）

- 召回只读：capsule 每回合注入由 ohmymemo 插件原样提供；Quno 不 import 其实现、不读写 `~/.dsh/ohmymemo/` 文件。
- 写入收敛：**短期指令存 Quno 自身状态**（如「今天别提醒」），**长期偏好才写 OhMyMemo** 且经用户确认；Quno 专属偏好 key 前缀 `quno.<botId>.`。
- 梦境提取只采 `source.kind === 'user'` 的 direct-human 消息；Quno 的自动 relay（`quno-eval`/`quno-report`/`quno-input`/`quno-worker-prompt`/`quno-notify`）与 Worker 会话因此天然不产生用户事实。Eval/Notification 回合在 Host 工具层额外禁用 `memory_*` 写入。

## 5. 委派工作：Ticket、Assignment 与 Report

用户在主对话派的活与自动 Eval accept 的工作共用 Ticket 模型，但授权来源不同（direct vs source）。

### 5.1 生命周期

1. Human Turn 判别为任务型意图 → 调 `quno_task start`（或 `quno_route accept`）；Eval Turm 用 `quno_eval_decide accept`。
2. Host 在单事务中写 Decision、Ticket、Mandate、首个 Assignment、owned Subscription 与 `assignment-launch` Effect；TicketId 对 direct accept 由 `sessionId+messageId+toolCallId` 幂等，对 source accept 由 EvalId 派生。
3. Effect 运行时解析持久主对话 Agent 为 parent，创建/恢复稳定 Executor 会话并投递 assignment prompt；解析失败退避重试，**不伪造父子关系**。
4. Worker 只读执行，结束前调用 `quno_worker_report`。Report 进入 Ticket，并产生 `router-relay` Effect；主对话转述结果。
5. once Ticket 在 `ready` 且无待跟随 Thread 时结束；persistent Ticket 需其 owning/followed Thread 满足来源结束规则。`blocked/failed` 暂停自动 Input，等待人类消息或显式 retry。
6. 用户追问进度/结果时，`quno_task status/result` 读取持久 Ticket/Assignment/Report，不进入子会话、不轮询。

### 5.2 崩溃与退出对账

- Assignment 是持久绑定，WorkerRun 是持久回合；桌面退出后 `Executor.reconcile` 对账：turn 已结束的关闭 run，未结束的重新 arm launch Effect。
- 输入投递使用稳定 message id；已 delivered 未 read 的 Input 在新 Assignment 重投，已 read/acked/answered/handed-back 不重复。
- 已提交 Decision 而 launch 未执行只恢复 Effect，不重新 Eval；Worker 已完成未 relay 只恢复 relay，不重复执行。
- 旧 Assignment、旧 fence、旧采集器 run generation、已结束 Ticket 的晚到写入全部拒绝。

### 5.3 任务卡

- 任务列表/卡片由 Ticket + Assignment + Report 投影；三层：L1 一句话状态 / L2 输入、产物与问题 / L3 完整 Worker 会话只读视图。
- 状态：`running`（有 active turn）/ `waiting`（已交付、无 active turn）/ `interrupted`（有 TicketQuestion 或失败需人处理）/ `done` / `failed` / `cancelled`。
- Ticket 详情按需加载（`ticketDetail`），不进 15 秒轮询；进行中静默更新卡片，不刷消息流。

### 5.4 Worker 工具与能力边界

- 只读 preset `quno-task` + `quno-task-guard`；新增 worker 控制工具（不算执行权限）：`quno_worker_report`、`quno_thread_handback`、`quno_thread_follow`、`quno_thread_unrelated`、`quno_read`、`quno_recall`、`quno_exchange`。
- 首版只读：不写文件、不发外部消息、不下单；产物通过 Report.artifacts 结构化登记。
- 容量：初始 4 个 WorkerSlot（active turn 占槽）；等待人工回答/结果验收释放槽；人类 follow-up 可用一个额外槽，wake 优先于新 launch。
- 对外写操作与审批卡仍是后续阶段；Channel 只保存地址与未来发送能力，当前不执行外部 send。

## 6. 采集层：Collector 契约（Host 调度）

**Collector 是 Quno 的采集扩展：在明确授权范围内观察一个上下文来源，把识别到的变化以统一事件契约提交为可追溯的观察结果。** 设计类比：Skill 提供做事知识，Tool 提供操作，Collector 提供持续采集，Quno 负责判断。与 0.4.0-rc.8 时代的 Sense/Organ 契约（`quno.sense/v1`）的关键差异：**定时归 Host**——插件不持有任何定时器，只实现 `run(ctx)`；健康由 Host 从 run 结果推导，不再接受自报心跳；按需读取面统一改叫 query。决策见 `notes/2026-11-10-quno-collector-redesign.md`。

### 6.1 与相邻概念的关系

Plugin 承载 Collector；Collector 可以用 MCP/Tool/Hook 取数，也可以直接 REST/文件监听/webhook。MCP 的订阅能力存在与否不改变 Collector 的责任边界；一次工具查询结果不自动构成采集。对用户表达统一为「采集器」：「给 Quno 接上一个日历采集器」。

### 6.2 四个必须区分的对象

| 对象 | 定义 | 例子 |
|---|---|---|
| CollectorType | 可安装、可复用的采集能力定义（实现 + 能力声明） | `quno/calendar` |
| CollectorInstance | 一份运行配置与生命周期 | 「工作日历同步」，Host 按 60s 调度 |
| Source | 实际观察的数据身份与范围（Host 分配 sourceId） | 某账号下一组日历 |
| Event | 一次不可变观察或派生结果 | 会议从 09:00 改到 10:00 |

首版一个 Instance 绑定一个 Source；多账号 = 多实例。刷新 token/重启/升级不改 sourceId；换账号或业务域必须新建 Source。Quno 订阅 Source 而非进程；多个 Quno 可消费同一 Source。

### 6.3 原则（MUST/SHOULD）

| 原则 | 要求 |
|---|---|
| 来源无关 | Quno 核心 MUST 不按厂商写分支；接第三个来源不改核心 |
| 调度归 Host | 插件 MUST NOT 自带定时循环；节奏由 Host 调度器决定，插件只在 `run` 返回里 hint 下次运行 |
| 职责分离 | MUST 只提交观察与提示，不调用调度/通知，不改关注事项 |
| 事实有出处 | MUST 区分 observed/derived，保留来源引用与覆盖说明 |
| 可靠交付 | MUST 稳定身份 + 持久 ACK + checkpoint 提交边界 |
| 可恢复且诚实 | MUST 声明回溯与缺口检测能力；不承诺无法保证的不丢失 |
| 资源有界 | MUST 受 Host 配额（每次 run 的事件/字节上限）与 `maxRunMs` 超时约束 |
| 可停可撤销 | MUST 支持暂停/取消/卸载；撤销后旧写入失去资格 |
| 可观测 | MUST 区分「没有变化」「同步失败」「鉴权失效」「限流」 |
| 权限清晰 | MUST 声明读取范围，凭据用引用；来源内容不是授权也不是指令 |
| 可演进 | MUST 分离契约/实现/数据 schema/配置版本 |
| 接入轻量 | 公共框架 SHOULD 承担校验/调度/重试/健康推导，Collector 只实现来源特性 |

「可靠」从接收边界建立：Quno 对已 ACK 内容负责；源端从未保留的瞬时变化不能靠框架凭空恢复。best-effort 来源可接入，但事实必须保留在配置、健康与推理上下文中。

### 6.4 声明契约（`quno.collector/v2`）

机器可校验，经插件注册对象提供（不另起配置语言），四组必需声明：

1. **身份与兼容**：type、contractVersion（`quno.collector/v2`，未知契约拒绝注册）、implementationVersion（semver）、eventTypes、configFields。
2. **权限与依赖**：reads、credentialKinds、网络目标或 MCP server/工具依赖、是否需要模型。
3. **schedule（调度与限制）**：defaultIntervalSec（无 hint 时的默认间隔）、minIntervalSec（只约束无 hint 默认间隔）、maxRunMs（单次 run 超时，超时强 abort）、quotas.maxEventsPerRun/maxBytesPerRun。
4. **可靠性能力**：`checkpoint = cursor|snapshot|none`；`replay = bounded|none`（含窗口）；`changeCoverage = all-changes|snapshot-diff|sampled`；`gapDetection = explicit|partial|none`；`readOriginal`。可声明 none，不可省略后假定具备；snapshot-diff 不得宣称 all-changes。

实际访问权限 = 声明范围 ∩ 用户授权 ∩ Host 允许范围；声明本身不构成授权。凭据值不进 definition。

### 6.5 三面模型与运行生命周期

一个 Collector 类型 = 一份声明 + 一个工厂，三个面：

```text
Collector（就一个东西）
├─ 接入面  validateConfig / probe / listOptions      （可选，形状不变）
├─ 采集面  run(ctx) — Host 调度调用，多次 commit 合法，返回 outcome
└─ 查询面  query.handleRequest（可选，= 原 organ.handleRequest）
```

工厂接口（`register(definition, factory) → disposer`）：

- `run(ctx)`：一次采集尝试。ctx 下发 instanceId/sourceId/type/config、**runId（本次 run 的 generation 栅栏）**、checkpoint（含 `checkpoint-entries/v1` 分条读面）、limits（`maxEventsPerRun/maxBytesPerRun` 为声明的单次运行配额；`maxEventsPerBatch/maxBytesPerBatch` 为 Host 单次 commit 的批次上限，插件据此分批而不必值导入 Host 常量）、logger、`commit(batch)`（唯一写面，一次 run 可多次 commit，提交与事件/checkpoint/回执同事务）与 abort signal。返回 outcome：
  - `{ ok: true, nextRunAtMs?, health? }`——成功；`nextRunAtMs` 是下次运行 hint；
  - `{ ok: false, failure: { state: 'auth-required'|'rate-limited'|'unavailable'|'degraded', code, message, retryAfterMs?, fatal? }, health? }`——失败；`fatal: true` 表示 Host 停止调度该实例，直至改配/重启用。
  - `health` extras 只报 Host 推不出来的东西：detail / coveredThrough / sourceLagSec / progress / issues。
- `mount(m: { instanceId, config }) → disposer?`：实例启用/改配时挂载、停用/改配/卸载时回收。需要常驻实例态的采集器（如按需查询面的注册表）在这里绑定。

**Host 调度规则**（`collectors.ts` 内的采集调度器，与 2s pass 循环分开；每实例单发 one-shot timer，最早到期优先）：

- 首次运行：启用/改配/boot 即跑（wake）。
- 成功：`next = clamp(nextRunAtMs ?? now+defaultIntervalSec, [now+1s, now+24h])`。hint 只受 24h 上限约束，**允许远小于 minIntervalSec 的续跑**（积压续跑 5s、令牌等待、1s 下限）；`minIntervalSec` 只约束无 hint 时的默认间隔。
- 失败非 fatal：`failures+1`，`next = max(now+interval, retryAfterMs ?? backoffMs(failures))`（确定性退避 + attempt 抖动）。
- 失败 fatal / 超时（`maxRunMs`，强 abort signal）：lifecycle=failed，不再排程，直至改配/重启用。
- 健康由 Host 从 run 结果推导：state/code/consecutiveFailures/nextRetryAt/lastAttemptAt/lastSuccessAt 直接落列；extras 合并进 `health_json`（与旧自报形状 wire 兼容）。两次 run 之间保持上次推导结果，`stale` 仍按 lastSuccessAt 阈值算；**运行间隔之外无心跳**。成功 run 是否降级只看插件报告的 `issues`：单批 gap（含 yzj「首轮只钉基线不回放」这类声明过的常规进度）由 ingress 记入缺口视图，不作为降级输入。
- 生命周期词表：`idle`（两次 run 之间）| running | stopped | failed（`starting/stopping` 为历史值保留）。期望状态仍是 enabled/paused/disabled，三层状态分离不变。

**栅栏与重启语义**：每次 run `bumpGeneration` 发新 runId，同实例同一时刻只有一个可写 generation；ingress `assertWritable` 语义不变（generation + desiredState + configRevision 三查），所以暂停/撤销/改配/下一次 run 启动后，旧 run 晚到提交被拒。栅栏是 **generation 级**：两次 run 之间，最近一次 run 的 commit 面在下一次 run 起跑前仍可写（规范的采集器只在 `run` 内提交）；run 超时被强停时 Host 立即再 bump 一次 generation，撤销这个从此不会再被下一次 run 栅栏的写面。已提交事务保持有效；stop 不回滚过去。配置变更走「停 run → 回收 mount → 存新 revision → 挂载 → 立即 run」统一重启语义。暂停不删 checkpoint；停用保留配置与历史；删除实例不级联删其他 Quno 的事项与证据。

### 6.6 交付执行约束（对事件流 §7 的补充）

1. 可重试身份：来源对象 ID + revision 优先；无 revision 用稳定规范化内容生成；抓取时间或摘要文本不能当身份。
2. 派生结果固定：预处理只生成一次，ACK 丢失复用；重算用新 eventKey 并引用旧事件。
3. 空批次合法：无变化可提交空 events + checkpointAfter，只推进游标不建事件不唤醒模型。
4. 批次幂等：batchId 来源内稳定，同 batchId 内容不一致报冲突。
5. 游标不倒退：checkpointRevision CAS + generation 拒绝旧写入；不比较 opaque 上游 cursor 大小。
6. 错误可分类：validation / identity-conflict / stale-generation / checkpoint-conflict / quota-exceeded / temporarily-unavailable + retryable/retryAfter。`stale-generation`/`checkpoint-conflict` 对 run 是 fatal（停排），三个内置采集器统一此语义。
7. 毒数据不静默跳过：必须越过时先持久诊断（身份、失败、缺口）再显式推进 checkpoint。
8. 分页溢出（「最近 100 条」型 API）必须检测并分页或报告缺口；支持「覆盖未知」。
9. 超出单次运行配额或单批上限的变更集：按批提交可容纳的前缀，checkpoint（含条件请求校验器）只推进到已提交部分，余量以续跑 hint 交给下一次 run——不得整批越过上限被拒、不得静默跳过（2026-11-10 起 calendar/feed 遵守，yzj 按页提交天然在限内）。

### 6.7 健康与成本

健康行字段固定：lastAttemptAt、lastSuccessAt、lastEventAt、连续失败数、错误分类、下次重试——全部由 Host 从 run 结果推导；extras 提供 coveredThrough/sourceLag/progress/issues（语义沿用：lastSuccessAt ≠ 捕捉全部变化；lastEventAt 长期不变可能正常；progress 是调度压力不是故障，issues 才是 fault）。freshnessThreshold 是实例配置，采集器建议默认值，无全局常量。持续失联由 Host 归并成一条来源异常事项，恢复后关闭。请求速率、队列字节、事件量、错误、模型成本分别计量；模型预算用尽只许切已声明验证过的降级模式，否则暂停报 degraded。

### 6.8 隔离边界

首版 Collector 插件是**可信代码**：同进程 Cordis 生命周期 ≠ 安全沙箱；协议合规与代码信任是两个条件。不可信第三方 Collector 需独立进程/受限执行环境（后续）。MCP-backed Collector 必须绑定具体 server 与只读工具并验证其行为（叫 "search" 不保证无副作用）。业务写（回消息、改待办、标已读）不属于采集权限；传输层 ACK/游标续订须声明。

### 6.9 命名

- 类型 ID：`<publisher>/<name>`（如 `quno/calendar`），publisher 是命名空间不是已验证身份；`quno.event/v1` 事件契约不变。
- 插件包：`dsh-quno-collector-<name>`（2026-11-10 起由 `dsh-quno-sense-<name>` 改名），遵守目录名 === 包名约定，`plugin:new` 生成。
- 服务：`ctx.qunoCollectors`（注册与生命周期）；旧 `ctx.qunoIngress` 受限接收入口已删除（唯一使用者是评测器，改走 run ctx 的 commit 面）。
- 实例 id：新实例前缀 `col-`；存量 `sense-<ts>-<rand>` id 一律不改（store v4 迁移只做 RENAME，不重写数据）。

### 6.10 Collector 编写最小面与打包分发

写一个 Collector 不应该是大工程。以 `dsh-quno-collector-feed` 为蓝本，**一个 Collector = 三个文件 + 一个压缩包**：

- **三个文件起步**：`package.json`（`name: dsh-quno-collector-<name>`、`dsh.bundle.patch`、`files` 白名单）、`cordis.patch.yml`（一行挂 host 行）、`src/index.ts`（definition + factory）。骨架经 `plugin:new` 生成（host-only），删减即用；类型从 `../dsh-quno/src/{types,collectors}.ts` type-only import，跨包不引实现符号。
- **声明保持最小**：`eventTypes` / `configFields` 只声明真实用到的；`reliability` 五项必须填但**诚实报低完全合法**（`checkpoint: none`、`replay: {kind: none}`、`readOriginal: false` 都是一等公民）；`factory` 只有 `run(ctx)` 必需，`validateConfig` / `probe` / `listOptions` / `mount` 可选。Collector 拿到的 ctx 只有 checkpoint / signal / limits / logger / commit——不管调度、不碰存储、不碰通知。
- **分发单元 = 单压缩包**：`pnpm pack` 出 tarball（`files` 白名单：`lib/index.js` + `cordis.patch.yml` + `README.md`）；安装 `dsh plugin --profile web add <tarball|目录>`；随桌面发货标 `dsh.desktop.ship: true`（进首启 Profile 事务与 revision manifest）。这是契约：任何 Collector 都应是「一个压缩包给谁谁就能装」。
- 演进项：`plugin:new` 增加 `--face collector` 模板（后续），把「蓝本复制」变成脚手架。

### 6.11 云之家群聊 Collector（dsh-quno-collector-yzj）设计

首个「消息」来源，补上首版体验示例（§1.1）的核心采集面。**经宿主机 `yzj-cli` 采集**：登录态、凭据、API 细节全由 yzj-cli 承担，Collector 不碰 token、不直接发 HTTP。

> **状态（2026-11-10）**：包名由 `dsh-quno-sense-yzj` 改为 `dsh-quno-collector-yzj` 并迁到 `quno.collector/v2`。focused 模式（0.2.0）与采集调度改造（0.3.0：分片工作队列、账户请求桶、水位跳过、初始化退避分类、`checkpoint-entries/v1` 分条 checkpoint 与迁移、结构化健康字段）的行为语义**原样保留**：`createWorker`/`round.ts` 的行为不变（仅 `provenance.collector` 等包名字符串随改名变更），既有 worker 单测原样通过；**worker 跨 run 存活**——实例槽位由 `mount` 建立、由其 disposer（暂停/停用/删除/改配/卸载）回收，worker 的 deps 经 getter 指向当前 run（commit 面、abort 信号、日志、健康收集），batchKey 命名空间冻结为 worker 创建时的 runId（ACK 不确定的原样重试跨 run 仍命中同一回执），fatal 或在中止信号下结束的轮次会丢弃 worker、下次 run 从持久 checkpoint 重建——否则每次 run 都会判定「到期发现」，把共享请求桶耗在目录页上；`run(ctx)` = 一次 `runRound`，outcome 映射 `nextWorkAtMs → nextRunAtMs`、`failed → failure`（分类取自该轮捕获的健康报告现值，`nextRetryAt` 并入 `retryAfterMs`）、`fatal → fatal`；worker 内七类健康报告集中为 run 返回的 extras（progress/issues/sourceLagSec/detail）；`registerOrganInstance` 迁到 `mount`/dispose；`takeToken` 每分钟 30 次/每 profile 桶不变（采集与 query 继续共享）。实施记录见 [实施记录](notes/2026-10-30-quno-collector-yzj-collection-redesign-impl.md)，调度改造设计见 [改造方案](notes/2026-10-30-quno-collector-yzj-collection-scheduling-redesign.md)。登录态核验依据见 [设计 v2](notes/2026-10-29-quno-sense-yzj-mentions-direct-design-v2.md)。**Host 通用能力**：`checkpoint-entries/v1`（`collector_checkpoint_entries` 表 + `commit.checkpointPatch` 同事务 patch + run ctx 分条读面）属 dsh-quno 的通用扩展，任意采集器可在能力声明缺失时回退单 blob 检查点。

**形态与范围**

- Host 定时调度；两种采集模式（`collectionMode`）：**focused（默认，新建实例显式写入）**与 **selected-groups（0.1.x 兼容，旧配置缺字段一律按旧规则校验必选群）**。端到端时延 = 采集调度 + 思考节奏 + 通知策略（§1 三种节奏），不宣称实时。
- **focused（@我 + 私聊）**：每轮 `whoami` 绑定身份（与实例绑定的 `(orgId, openId)` 不一致即 fatal 停排，报 `account-changed`，须人工处理），扫描「最近会话」目录，只提交：①多人群中他人发送且 `param.desc[]` 存在 `{type:"at", data:selfOpenId}` 的 text/richText 消息（@all 不算；正文手写「@姓名」无结构证据不算；`extFields` 的 openId 是表情/编辑结构不算；既 @我 又 @all 按直接 @我 接收）；②`groupType = 1` 私聊中他人的消息。其余为已验证非命中，游标照常推进。@ 结构用姓名/正则补足证据被明确禁止。
- **selected-groups**：采集所选群聊全部新消息，事件保持 0.1.x data 形状（`p2`、无 `chatType`）。
- 只读边界不变：不发送消息、不标已读、不下载附件、不用已读状态筛选（§6.8 业务写边界）。
- 多账号/配置空间经 yzj-cli 全局 `--profile <name>` 隔离（默认 `default`），与 §6.2「多账号 = 多实例」对齐。

**目录发现与公平调度**

- 每轮读 recent 第 1 页（新活动）+ 从持久 `discovery.nextPage` 跨轮续扫（每轮最多 `maxDiscoveryPages` 页）；扫到 `more:false` 完成本遍、下轮从第 2 页重开。目录页码续扫只改善公平性，不证明无漏（`sampled / gapDetection: partial` 的来源）。
- 跟踪上限 200 个会话，插件自限 checkpoint 160 KiB UTF-8（Host 硬上限 200,000 字符）；超容量**拒绝而非裁剪**，未纳入会话计为显式 `directory-capacity` 欠账。已知会话暂时不在 recent 仍保留游标；无积压的缺席会话至少每 30 分钟进入一次探测候选。
- 私聊/群聊两条 lane 各占一半会话预算（默认每轮 20 个），闲置互借；lane 内最早到期/最久未服务优先，ACK 后更新服务时间；单会话级 degraded 故障退避，不占满预算。
- 每轮预算：CLI 调用 ≤106（1 身份 + 5 目录 + 20×5 消息）、软截止 120s（到点不再起新调用，单次 deadline 取 `min(20s, 剩余)`，超时 kill）；`definition.schedule.maxRunMs: 30000` 只约束单次 run 的 Host 超时（worker 软截止 30s 在此之内），`BudgetExhausted` 的成功续跑经 `nextWorkAtMs` hint 续排。

**初始化（从启用时刻开始）**

- 首个候选批次先持久化 owner 绑定与 `focusedSince`（启用时刻；run ctx 不提供实例创建时间，以「首次启用 focused 的持久时间」替代），**然后**才发消息请求。
- 每个新会话独立读一个 newest 窗口：时间可证升序时钉最新边界，窗口内晚于 `focusedSince` 且命中的消息提交，更早的是基线不回放；窗口最早时间仍晚于 `focusedSince` 且 `more:true` 时显式报 `init-window-exceeded`（首版不做更早补采）。时间不可证（缺时间/乱序）则只建基线、不钉游标、下轮重试——绝不猜边界。空会话建 `initialized:true, cursor:null`，后续仍走 newest + `focusedSince` 过滤。
- 已有旧模式游标的会话切 focused 后沿用该游标（切换过滤模式不清空来源历史）；0.1.x v1 checkpoint 自动迁移为 v2（游标/seen/钉扎时间全保留），损坏或未知版本的检查点 fail loud，绝不归零重建。

**分页与缺口（纪律）**

- 增量只从最后 ACK 游标 `type new` 翻页（每页 20，CLI 上限；每会话每轮最多 5 页）。方向不可证、倒序、缺 msgId、零进展（空页却 `more:true`）一律**原位退避**，绝不越过未证明的边界推进游标；事件预算在页中耗尽时只推进到能容纳的连续前缀，剩余 `needsCatchUp` 下轮优先。
- `data.list` 缺失或 `more` 非布尔是协议失败（会话级 degraded 退避），**不能被归一化成「没有新消息」**。无时区 `sendTime` 按 `Asia/Shanghai` 解释；带 offset 的保留原语义；非法时间按「时间未知」走初始化/分页规则。
- 相关性 unknown（畸形 param/desc、未验证类型的 @）随**持久 gap 同批 ACK** 后推进，不堵死会话；gap 带代码/计数/边界时间持久保存，后续安静轮次不得把它抹成「完整覆盖」。事件身份冲突（同键不同内容）→ 该会话暂停 30 分钟 + 持久 gap，不覆盖旧事实。

**命令面**（全部只读；每次均传 `--profile`，argv 启动不经 shell）

| 用途 | 命令 |
|---|---|
| 身份绑定（每轮第一步） | `yzj-cli --profile <p> whoami`（防 profile 被外部切换后仍用缓存身份） |
| 探活（probe，接入面用） | `yzj-cli --profile <p> contact user get` |
| 目录扫描 | `im group recent --limit 20 --page <n>` |
| 建基线 | `im message list --group-id <G> --type newest --limit 20` |
| 增量采集 | `im message list --group-id <G> --msg-id <cursor> --type new --limit 20` |
| 选群辅助（向导，不进采集循环） | `im group recent` 分页 |

**事件与 checkpoint**

- 事件类型 `im.message.created`，schema `quno.yzj-im.message/v1`；`eventKey = yzj:<groupId>:<msgId>`。focused 群聊 @我 事件：`priority: p1`（来源建议）、`correlationKeys: [yzj-group:<id>, yzj-mentioned-me]`、data 带 `chatType/direction/mentionedMe/mentionEvidence/textTruncated`；私聊同信封（`chatType: direct`、`mentionedMe: null`、`correlationKeys` 带 `yzj-direct:<id>`）；selected-groups 保持 v1 形状。正文 ≤4000 字符、summary ≤200、`p1` 只是来源建议，Collector 不判「必须回复」。
- checkpoint 为 Host 不解释的版本化 JSON（v2）：owner / focusedSince / discovery（nextPage、sweepStartedAt、lastSweepCompletedAt）/ 每会话（groupType、label、cursor、initialized、seen 环 ≤20、needsCatchUp、retryNotBefore、gap 标记）/ coverage。worker 在一次 run 内持有 `{state, revision}`（`ctx.checkpoint` 只是起始快照；跨 run 通过 checkpoint-entries 与根 checkpoint 续接）；ACK 不确定时用**完全相同**的 batchKey/body 原样重试，CAS 冲突/stale generation 停止调度。batchKey = runId + 轮内序号 + 冻结内容 hash。

**可靠性声明（诚实版）**

| 能力 | 声明 | 说明 |
|---|---|---|
| checkpoint | `cursor` | msgId 游标（v2 文档化 JSON） |
| replay | `bounded` | `type old` 有界回翻；窗口取决于服务端保留，声明未知窗口 |
| changeCoverage | `sampled` | cursor 翻页完整采集新增；**编辑/撤回不可观测**；目录页码续扫 + recent 有限覆盖不证明无漏 |
| gapDetection | `partial` | 目录截断/调度欠账/初始化窗口/容量/协议异常/身份冲突显式报缺口 |
| readOriginal | `false` | 入库载荷截断（正文 ≤2000/4000 字符）且编辑/撤回不可观测，不构成可读原文；按需结构化查询（query `handleRequest` 白名单）另行支持，与本声明正交（2026-11-08 定稿，见 `notes/2026-11-08-quno-organ-on-demand-read-plan.md`） |

**按需读取（query `handleRequest`，2026-11-08 起）**：封闭 op 白名单——`im.group.recent`（limit≤20、page≤10）、`im.group.search`（keyword≤64、limit≤20、page≤10）、`im.message.list`（groupId≤64、limit≤50；当前 CLI 无 `--page`，v1 只回最新窗口）。枚举外 op 与越界参数一律 `failExchange('unsupported-op' | 'invalid-args')` 不重试；与采集共享 per-profile 每分钟请求预算，耗尽 `rate-limited` 可重试；profile 取自运行实例配置（`mount` 绑定），payload 不得指定。端点 `collector:<instanceId>` 经 `quno_read.collectors` 发现，不猜端点名。

**健康分类**（两层判定：先看 CLI 进程级信号，再看 API 业务码。失败时 stdout 为空、stderr 单行 `{"success":false,"error":{type,subtype,message,hint,code}}`；分类在 worker 内完成，经 run 的 failure/outcome 上交 Host）：

- **进程级**：exit 3（如本地未登录 `credentials_missing`——**此时没有 errorCode**，只认 errorCode 会把登出态漏成「未知错误」）→ `auth-required`，引导 `yzj-cli auth login`（无浏览器环境 `--device`）；exit 4（网络/超时）→ `unavailable`，**429/限流单独报 `rate-limited`**（`retryAfterMs` 交 Host 退避，最大 30 分钟）；exit 2 与 exit 5 → `degraded`（实现侧 bug，不甩给来源）。
- **API 级**（exit 1）：10000400/93001/43001 → `auth-required`；429 → `rate-limited`；其他按 `message`/`hint` 归类。
- **成功判定**：exit 0 **且** 信封 `success: true`。CLI 不存在 → probe 即失败。
- **覆盖口径**：lastSuccessAt 只表示有成功闭环；目录未扫完（`directory-truncated`）、会话欠账（`round-deferred`）、容量（`directory-capacity`）、初始化窗口（`init-window-exceeded`）、相关性 unknown、身份冲突各自以 issue 代码显示，不统一写成「登录失败」，也不在安静轮次里被抹平。

**运行环境依赖**：宿主机已安装并登录 yzj-cli；桌面 sidecar 的 PATH 分层已覆盖 host CLI 解析（见 `electron-shell-contract.md` sidecar 节）。one-node 下 yzj-cli 经 node-shim 解析，shim 死路径会表现为「CLI 不可执行/未登录」——probe 把「CLI 不可用」与「未登录」区分开。

**definition 草案**（等价展示，以代码注册对象为准）：

```yaml
contractVersion: quno.collector/v2
type: quno/yzj-im
implementationVersion: 0.4.0
displayName: 云之家群聊
eventTypes: [{ type: im.message.created, schema: quno.yzj-im.message/v1 }]
configFields: [collectionMode(默认 focused), groupIds(focused 白名单可空/legacy 必选), yzjProfile(默认 default),
  intervalSec(默认300/最小60), maxConversationsPerCheck(默认20), maxDiscoveryPages(默认5),
  maxPagesPerGroup(默认5), freshnessThresholdSec(默认900)]
permissions: { reads: [云之家候选会话的全部增量消息（经 yzj-cli；@识别需读候选群新消息，仅命中提交）], credentialKinds: [yzj-cli-login] }
schedule: { defaultIntervalSec: 300, minIntervalSec: 60, maxRunMs: 30000, quotas: { maxEventsPerRun: 200 } }
query: { handleRequest: 三 op 白名单（见上） }
firstSync: baseline-only
reliability: { checkpoint: cursor, replay: bounded(窗口未知), changeCoverage: sampled, gapDetection: partial, readOriginal: false }
```

## 7. 事件流：信封、接收与路由

### 7.1 事件信封 v1（`quno.event/v1`）

CloudEvents 风格的来源/类型/主体/时间/数据分离，首版用自有版本化契约，不宣称实现 CloudEvents 全部绑定。采集器提交形态（示例见原提案 notes）字段组约束：

| 字段组 | 规则 |
|---|---|
| 身份 | `(sourceId, eventKey)` 唯一；重试同内容返回原 eventId；同键不同内容报冲突 |
| 主体 | subject.key 稳定标识来源对象；revision 为来源定义的 opaque 值，不通用比较大小 |
| 类型 | type 说「发生什么」；schema 声明 data 版本；operation = upsert/delete/retract（撤回是新事件，不删历史） |
| 时间 | occurredAt 业务时间（可 null）；observedAt 采集时间；receivedAt Host 接收时间 |
| 内容 | summary 与 data 至少一项有效；摘要非天然可信；大附件用引用，禁塞无限正文 |
| 提示 | priority/deadline/相关人只是来源建议，有效优先级由 Quno 策略算 |
| 血缘 | provenance.kind = observed/derived；derived 必须有输入引用、处理器版本、覆盖说明 |
| 关系 | 可扩展 correlationKeys/supersedesEventIds/parentEventIds；引用须可验证 |

接收端补充 eventId、绑定身份验证后的 sourceId、receivedAt、单调 ingestSeq、内容 hash、collectorConfigRevision；提交方不能伪造 sourceId。跨来源不凭文本相似去重；语义合并在关注事项层做。

允许 Collector 预处理（原始变化 / 规则抽取 / 模型窗口摘要均合法），派生事件标注输入引用、窗口、完整性、处理器版本，模型抽取再标置信度；首次产出即固定，重试不重采样。无法回读原文时降低结论强度。预处理模型调用计入来源成本，便宜规则优先。

### 7.2 提交、ACK 与 checkpoint

方法：`register`（接入面）与 run ctx 的 `commit`（唯一写面）。首版 transport = 同 Host Cordis 插件调用；外部 HTTP push 后续加（同语义 + 来源 token + 限额）。

批次语义：

1. 入口校验、按稳定键去重，**同一 SQLite 事务**写事件、批次回执、采集 checkpoint。
2. 全部有效才返回 durable ACK（逐条 accepted/duplicate）。
3. 任一无效整批拒绝，不推进 checkpoint，返回错误下标与原因。
4. ACK 丢失原样重试返回已有结果；只写内存不能 ACK。
5. 上游游标由采集器理解，Host 只存 opaque checkpoint；不可暂停的 webhook 需 durable spool 或依赖源端重试，否则健康状态明确报可能丢失。

首版限额（待真实负载校准）：单事件 64 KiB、每批 100 条且 ≤1 MiB。

### 7.3 Intake 与订阅

- 事件日志只存一次；每 Quno 独立 Trigger，`(source_id, event_key)` 唯一，同键不同内容显式冲突，不覆盖。
- `Engine.receive` 是唯一领域接收命令，在采集批次的同一 SQLite 事务（T1）内执行：规范时间/字段 → scope 过滤（保留 Trigger + Disposition）→ 写 Trigger/Thread/Correlation → 按 Subscription fan-out 幂等 TicketInput（owned/context）→ 计算 followupOwners → 无 Owner 的 Trigger 入 primary Thread.pending → 提交后唤醒 Eval/Assignment。
- 订阅是 Ticket ↔ Thread 关系（`subscriptions`），不是「某 Quno 订阅某 source」。owned 接管人类 follow-up；context 只提供输入，不恢复已结束 Ticket。
- 人类 stop 过的 Ticket 不再接收新 Input；非人类 stop 的 ended Ticket 可由 owned 人类消息在同一 Mandate 下恢复，恢复前 revalidate。bot/CI 只交给 live Ticket，不恢复 ended Ticket。
- 同一 Trigger 每个 Ticket 至多 handback 一次；所有 Owner 释放后才回到 primary Thread Eval。
- 来源 scope 过滤是确定性规则；自然语言筛选只发生在 Eval/Router，不让每条事件先过一次隐藏 LLM。

## 8. Eval、Decision 与调度

### 8.1 准入策略

- `acceptMode`：`off` 只准入点名的人类消息；`observe` 评估 inferred 工作但记录 `would_accept`，不创建自动 Ticket；`auto` 才按匹配规则 accept。
- `autoSourceIds` 是每个 Source 的显式自动授权；来源被感知不等于被授权。直接桌面任务走 direct accept，不经过 Source 准入。
- Policy version 覆盖 accept mode、规则与来源授权；Eval 携带其准入版本。Policy 变化向 live Ticket 写 PolicyInput（不半路强制取消），并把旧版本 in-flight Eval 标 unavailable、按新版本重排 pending。
- Mandate 只在 accept 中生成、之后不可变；恢复/retry 前 `revalidate`（版本、模式、规则存在性、permissionPreset）。

### 8.2 Eval 与 Decision

- 每个 Thread 至多一个 active Eval；期间新 Trigger 留在 pending 等下一批。Eval 候选只在 primary Thread 上串行、按批合并。
- 候选只在交付到主对话后开始超时计时；暂停时冻结并平移 deadline。超时最多重排两次，第三次记 unavailable；单 Thread 故障不阻塞其他 Thread。
- accept 在单事务 T3 写 Decision、Ticket、Mandate、首个 Assignment、owned Subscription 与 launch/ack Effect；重复 accept 返回原 Decision/Ticket。observe 下 inferred accept 降级为 ignore + `would_accept`。
- Eval 不等待异步 Exchange 或外部时间条件；需要等待时由 Source 继续观察，稍后产生新 Trigger。

### 8.3 调度与 Effects

- 每 2 秒及 Effect 请求时执行有界 pass：到期 Exchange → 超时 Eval → 打开 pending Eval → 执行到期 Effect → 通知 outbox。无 Trigger、无到期记录时一次 pass 只做一次廉价事务与零模型调用。
- 所有提交后动作走持久 Effect（Action Outbox）：`eval-delivery`、`assignment-launch`、`input-delivery`、`router-relay`、`notice`、`exchange-delivery`（`channel-reply` 预留）。同 kind/key 合并并递增 generation；执行完成/失败按 seq/generation 校验，旧执行不能覆盖新 payload；pause/shutdown 保留等待行。
- 用户配置：检查间隔（默认 300s，最小 60s）、时区、工作时段、安静时段；暂停停自动投递，采集器继续按调度运行。`checkIntervalSec` 是普通 Eval 的最大等待/合并节奏，不是模型轮询周期。
- **只读 Watchdog**：按需检查超时 Eval、连续失败的 Effect、长时间无 active Eval 的 pending Thread、输入未投递且无 WorkerRun 的 Ticket，只报告不修改提示词/权限/Policy/状态；报告进入 `quno_status`，由人或 Effect 重试决定后续动作。

### 8.4 预算与容量

| 项 | 初始值 | 处理 |
|---|---|---|
| 单 Eval 批次 | 20 条 Trigger | 其余留 pending，下一批 |
| 单 Thread active Eval | 1 | 新 Trigger 等下一批 |
| 候选超时 | `budget.runTimeoutSec` | 最多重排两次，第三次 unavailable |
| WorkerSlot | 4 个 active turn | 人类 follow-up 可多一个；wake 优先 |
| 每日模型预算 | 用户可配 | 按 Eval/Worker/通知表达分别记账 |
| Effect 重试 | 指数退避，上限 10 分钟 | 永久失败保留行与 lastError |

## 9. 关注事项

典型事项：需要回复的人、未确认的安排、将到期的承诺、等待中的结果、需继续观察的异常。事项未必是待办，可以只是「继续关注」。

状态机：

| 状态 | 含义 | 后续触发 |
|---|---|---|
| open | 需要关注或行动 | 新证据、截止临近、用户反馈 |
| waiting | 等待他人/外部条件 | 新证据或约定复查时间 |
| snoozed | 用户要求暂缓 | 到 snoozedUntil 重评 |
| resolved | 用户完成或来源证明已解决 | 新的实质事实才允许重开 |
| dismissed | 用户明确不关注 | 保持抑制，除非用户恢复或重大变化规则 |
| expired | 时间窗已过 | 必要时汇报「已错过」，不发送过时提前提醒 |

- 版本变化分「证据补充」（不通知）与「实质变化」（截止/责任人/行动要求/阻塞变化才可再提醒）。
- 用户显式状态（已处理/不用提醒）不能被模型凭低置信度旧消息覆盖；后台提交带 `expectedRevision`，冲突时重新评估而非覆盖。
- 延期必须存 `nextReviewAt`——**时间本身也是触发条件**。

## 10. 沟通层：通知 outbox、主动汇报与反馈

### 10.1 通知准入

只有有价值的变化才进入通知（默认策略已定稿：**有意义的变化才说**；「每轮汇报」仅为可选项，且只汇报实际处理了内容的轮次，空检查不发声）。投递前重新检查：事项是否已解决、证据是否撤回、通知是否过期、同实质变化是否已发、用户是否刚反馈、是否安静时段、是否超预算。

去重键 `(qunoId, topicKey, materialRevision, reminderStage)`；reminderStage 区分用户明确安排的下次提醒；模型换措辞不是新版本。初始打扰策略：普通至少间隔 10 分钟、每小时 ≤3 次主动汇报、同主题合并；安静时段只暂存，解禁后按最新状态出一份合并汇报，不逐条倾倒。

### 10.2 投递到主对话（统一通道）

主动汇报与子任务回流**共用同一条 outbox 投递通道**：

1. outbox 持久 payload 先保存确定的 DSH 输入 messageId；每次实际重试记独立 attempt；投递器单飞。
2. 投递 = Host 给主对话提交带 `notificationId` 的程序来源 notice（`source: { kind: 'quno-notify' }` / `{ kind: 'quno-task' }`，MessageSourceMap declaration merge），`followup` 唤醒 + `ctx.sessions.flush()`。
3. 沟通回合只做自然表达：基于已校验报告，禁止外部动作与重新全量采集；引用与关键时间以报告为准，由通知记录确定性渲染，不依赖表达模型重新生成。
4. 不伪造 `assistant/message`、不直接改会话 JSONL；表达失败不影响已提交的事项状态，只影响沟通状态。
5. 自动汇报回合的工具限制由 Host 按可信 source 与 notificationId 安装、随回合结束撤销——不只靠提示词要求。
6. 状态区分：`inbox-durable`（唤醒消息已可靠入队）≠ `presented`（对应回合已有完整回复并 flush）；用户「已读」≠ 事项「已完成」。
7. 用户正在对话时不 steer 当前推理；投递器等空闲并在交付前再验状态（用户刚说「已完成」就不再发旧提醒）。

代价是每次有价值的主动消息多一次小型模型调用，计入预算；选它是为了保留原生对话、正常回复与持久历史。

### 10.3 状态机与恢复矩阵

```text
Eval:      delivering → waiting-decision → decided | unavailable（超时最多重排两次）
Input:     (created) → delivered → read → acknowledged | handed-back
WorkerRun: prepared → running → ended | failed
Assignment:pending → running → ended
Ticket:    open → ended（completed | failed | dropped | stopped | closed）
Effect:    (enqueued) → executed（同 kind/key 新 generation 覆盖旧执行）→ 完成/退避
Notice:    pending → prepared → inbox-durable → presented
                              ↘ uncertain / retryable-failure
           pending / prepared → suppressed | superseded | expired
```

| 故障位置 | 恢复 |
|---|---|
| 落库后 ACK 丢失 | 原键重试返回 duplicate，checkpoint 不倒退 |
| 落库后尚未路由 | 路由游标补扫 |
| 运行已领取未提交 | 转 interrupted；未结算事件重新就绪；旧 fence 禁写回 |
| 模型已返回、事务未提交 | 从已校验完整结果恢复或重新分析；尚无外部副作用 |
| 事项与 outbox 已提交未投递 | 只重试 outbox，不重新分析 |
| DSH 已 flush、outbox 未标记 | 按 messageId 查 inbox/日志对账，不盲目重新 followup |
| flush 失败或无法确认 | 标 uncertain，等可靠读写对账；不凭超时认定未发送 |
| 输入已入队、回复失败/取消 | 区分未接纳/回合失败/部分可见；有限重试并关联旧 attempt |
| 会话已删/不可恢复 | 标 delivery-blocked，UI 引导重新绑定，不自动造第二个身份不明的对话 |
| 同进程 flush 失败但内存 inbox 有消息 | 恢复先查内存与持久日志，先可靠 flush 再决定是否重投 |

运行瞬时失败指数退避 + 抖动，≤3 次；结构/来源数据错误进 dead-letter，其他来源继续；无效模型输出最多一次有界修正。支持查看失败原因、修复后重放、人工忽略留理由。桌面原生通知在会话回复持久化后触发，只提示「Quno 有新消息」——辅助渠道，不是投递凭证，不因 toast 失败重发对话内容。

### 10.4 用户反馈

- 确定按钮（已处理/延后/不再关注）提交带 expectedRevision 的服务命令；自然语言经主对话的受限管理工具更新，模糊反馈先澄清对象。
- 反馈短期状态进 Quno 库，长期偏好经确认才写 OhMyMemo（§4.5）。
- 完成/延后等反馈触发桥的通知机制（主会话 running/pendingInteraction 边），原生横幅点击回跳主会话——现有桥能力零改动。

## 11. 持久化与保留

- 目录 `$DSH_HOME/quno/`：`quno.sqlite` + 附件快照 `blobs/`。不向 OhMyMemo 目录或 DSH Session 文件塞事件队列。
- 目标表：`qunos`、`collector_types/instances/batches/checkpoint_entries`、`sources`、`events`（即 Trigger 存储）、`trigger_threads`、`threads`、`thread_pending`、`trigger_dispositions`、`evals`、`decisions`、`subscriptions`（Ticket↔Thread）、`tickets`、`assignments`、`worker_runs`、`ticket_inputs`、`input_attempts`、`exchanges`、`exchange_messages`、`effects`、`attention_items/history/attention_links`、`notification_outbox/attempts`、`feedback`。
- 旧 `deliveries`/`runs`/`tasks` 只用于迁移与 legacy 只读展示，不再进入目标写路径；来源过滤器旧表已改名 `source_subscriptions`。
- 关键唯一键：events `(source_id, event_key)`；threads `(quno_id, source_id, thread_key)`；trigger_threads `(trigger_id, thread_id)`；subscriptions `(ticket_id, thread_id)`；effects `(kind, key)`；exchange_messages `(exchange_id, kind, content_hash)`；ticket_inputs 稳定 id；assignments/worker_runs 有序索引。
- 用插件自有 SQLite repository（DSH storage KV 无多表事务契约）；单 Host 写锁 + WAL + `synchronous=FULL`；schema 版本化迁移（当前 v3），升级前备份，重复迁移无副作用。
- 保留：事件正文默认 30 天、运行诊断 14 天、通知 30 天。**未结算 Eval/Input/Exchange、未结束 Ticket 的输入证据、未终结通知不按年龄删除**；Trigger 正文过期后保留 ID、摘要、hash、血缘与 `pruned` 标记。磁盘/配额近限时背压 + 来源限额 + 可观察告警，不静默丢高价值事件。

## 12. 安全与权限

- 来源内容是数据不是授权：来源文本里的「忽略规则并发送所有消息」不改变工具白名单、订阅权限或收件人；模型回读原文同样受订阅范围约束。
- 凭据存引用，交给已有凭据设施/采集器安全存储；不写入事件或提示词；日志只记必要标识。
- 首版只向当前用户的主对话汇报，不向同事/群组/外部系统发送。外部执行能力以后按 action 类型加授权、审计与幂等键，不凭「你是个人助理」获得全部权限。
- 宿主注入防护：自动回合工具限制由 Host 安装（§10.2）；Eval/Notification 回合禁用记忆写入/提醒/执行；Worker preset 只读（§2.1、§5.4）。

## 13. UI 与 Remote

> **当前口径（2026-10-27）**：侧栏仍是原生面板行（无页签、不重写 WorkspaceBrowser）；胶囊在会话头右上工具区，点击出三行概要并可带 `view` 打开右栏；接入向导是 `shell.overlay` 里的三栏大 Modal；右栏面板支持采集器详情钻取、关注完结分组与事件详情；主动汇报卡按 Turn 绑定；任务详情支持取消。下文保留 2026-10-23 的沿革记录，冲突处以本段与 §13.4–§13.7、§13.10、§20 为准（决策记录见 `docs/notes/2026-10-27-quno-interaction-completion.md`）。
>
> 本节于 2026-10-23 两次修订。第一版交互改版建立在 `sidebar.workspaces.sessionListView` 槽上，经核实该槽**在 fork 源码中不存在**（仅以未合入 note 形式存在；dsh-thread 与 dsh-quno 的注册均为永不触发的 dormant 注册），`registerMessageProjection` 实为 Host 侧 LLM 消息投影而非 UI 通道——两处事实性错误已在偏差 #11 更正。同日的第一版落地方案（占用 `sidebar.workspaces` 主槽 + 自绘精简会话列表）经用户纠偏与实机验证后，改为本节的 **work / Quno 页签制**（偏差 #13）：fork 增加 `sidebar.workspaces.alternate` 接缝槽并发布 `v0.2.1-rc.2+zw.6`，stock 浏览区原样保留为「work」页签，Quno 独享「Quno」页签。以下挂载点均已对照 fork `v0.2.1-rc.2+zw.6` 源码与实机（scratch `DSH_HOME` + 真实浏览器 DOM 断言）验证。

### 13.1 总体形态：三个面

```text
┌──────────────┬──────────────────────────────┬──────────────────┐
│ 左侧栏        │ 主对话（消息流）              │ 右栏 Quno 面板    │
│ brand/新会话  │  · 汇报卡 / 任务卡 / 聊天      │ ┌──────────────┐ │
│ 插件/自动化   │  · 任务卡点击 ───────────────→ │ │动态│关注│任务│ │
│ ┌work│Quno┐  │                              │ │  实时状态     │ │
│ │(work=原样) │  对话内胶囊（composer 上方）    │ └──────────────┘ │
│ ◉ Quno 在线   │  （运行任务/待办事项计数）      │ 默认收起         │
└──────────────┴──────────────────────────────┴──────────────────┘
```

- **work 页签 = 原样**：stock WorkspaceBrowser（搜索、工作区树/单列、会话行菜单、对话框、拖拽）原封不动；brand 行、新会话、插件、自动化任务等壳层行常驻，不随页签切换。
- **Quno 页签 = 消息对象**：每个 Quno 一行（头像 + 名字 + 一行状态 + 待关注徽标），点击直接进唯一主对话；cwd 固定默认、用户不可见不可选，工作区与 preset（「模式」）不露出；模型选择器等 composer 常规件保留（§13.3）。
- **Quno 主对话有自己的皮肤**：每条 Quno 消息带助手头像、会话头有身份与状态、首开空态有欢迎块（§13.8）；渲染管线仍是 stock（§13.9 的不接管决策）。
- **右栏默认收起，胶囊在对话框里**：Quno 面板（动态/关注/任务）挂在右栏，但**不自动展开**；常态入口是正文右上角的悬浮胶囊（实时计数，不在会话头按钮区），点击出三行概要，按行打开右栏（§13.5）。
- **任务从对话里长出来**：`quno_task` 任务卡嵌在引起它的那条回复里；点卡片 → 右栏面板打开并定位该任务的实时运行视图（§13.6）。

视图内容分工：设置页承担**配置**（单页表单、无内部页签：基本/通知/角色与模型/采集来源/高级，自动保存；关注/任务/运行实时态全部迁到右栏），不承担主对话入口；右栏面板承担**实时状态**（采集器健康、关注事项、任务、运行）；「为什么提醒/没提醒」的证据与规则摘要在面板的动态视图可查（可审计结论依据，不暴露模型内部推理）。

### 13.2 左侧栏改版：work / Quno 页签（fork 接缝）

**接缝（fork `v0.2.1-rc.2+zw.6`）**：ui-workspace 的 `sidebar.workspaces` 占位者改为 WorkspacesRegion 包装，并声明子槽 **`sidebar.workspaces.alternate`**（list / root，owner `{ active }`，槽级 inject `hooks.alternate` 提供席位元数据 = `{ occupied, label() }`）。无备选注册时区域逐字节等价于 stock 浏览器；有注册时顶部出现「work / <备选标签>」页签条，按页签挂载浏览器或备选条目；备选 dispose 时从任一页签回落浏览器并撤掉页签条。rail 态有备选时渲染 W/<首字> 两枚切换钮。设计依据与上游合并成本评估见 fork 仓 `.agents/notes/implemented/feature/2026-10-23-workspaces-alternate-view.md`。

**插件侧（dsh-quno）**：向 `sidebar.workspaces.alternate` 注册 id `quno`、`label: () => t('nav')` 的联系人视图（头像 + 名字 + 在线/静默/暂停状态 + 待关注徽标 + 运行中/待办子行；点击 → `remote.quno.ensureMain()` → `ctx.uiWorkspace.openSession(mainSessionId)`；任务子行点击 → 右栏面板定位该任务）。Quno 总开关关闭（`config.enabled === false`）时 dispose 全部门控注册：alternate 消失 → 页签条消失 → 区域原样回归 stock；总开关只影响门控注册，设置页/任务卡/回合尾按钮不随开关消失（历史任务卡仍可读，面板动作降级为跳子会话）。

**页签条样式规格（fork 侧验收项，对齐分段控件截图语义）**：页签条是 fork WorkspacesRegion 渲染的 chrome，Quno 侧只提供 label 与视图、不自绘页签。规格：置于浏览区顶部的分段 pill 控件——两个等分段（work / Quno）、行高与 stock 侧栏行（32px）对齐、容器左右留白与浏览区 padding 一致；激活段为抬升底色 pill（`--dsw-*` 提升面 token），未激活段文字次级色；图标 + 文案居中，字号字重与侧栏行一致；rail 态退化为 W/Q 两枚切换钮（已有）。目标：看起来就像侧栏原生的一员，而不是贴上去的外来控件。

**「新会话」语义（定稿；入口口径 2026-10-23 四次修订——页签方案否决）**：work/Quno 页签与「两个面板」方案**整体否决**（同日三次修订的页签首分区、壳行退场全部回退——「不用搞这个页签了，直接在自动化任务下面加一个按钮即可」——用户明确）。侧栏回归 stock 原样：新会话按钮、插件/自动化任务行、工作区列表不动；Quno 入口为**原生面板行**——`main` 槽注册 `quno-entry` 页 + `sidebar.panellist` 同 id 条目（order 30，排序在自动化任务之后），壳自持按钮/标签/选中态，样式天然协调。注册的页面是**交接页**而非目的地：挂载即 `ensureMain()` → `openSession()` → `selectPanel(null)` 切回对话视图，使该行成为纯粹的「打开 Quno」按钮；总开关关闭时行随门控整体消失。Quno 主对话不提供独立的新建会话入口（首次创建只由侧栏 Quno 入口触发 `ensureMain`）；⌥⌘N 仍只建 work 会话。对话面安静皮肤（§13.8）不受影响，随在屏会话作用域生效。

> **2026-10-30 导航与选中态补充**：入口实际交接顺序已修为 `ensureMain() → backToConversation() → openSession()`（原因见 [入口导航修复](notes/2026-10-30-quno-entry-navigation-fix.md)）。该顺序会让 `activePanelId = null`，而侧栏原先只按 `activePanelId` 判定选中，所以 Quno 行在导航成功后失去高亮。**现已实施**：Quno 的 `sidebar.panellist` 注册额外声明 `conversationAgentPreset: 'quno'`，侧栏在**主区显示对话**时改用当前 `mainView` 会话的 `agentPreset` 投影推导该行选中（`activePanelId` 非空时仍是面板优先）；不新增第二份选择状态，刷新恢复、切换普通会话、收起 rail 都走同一条推导。能力由 fork `v0.2.1-rc.2+zw.9` 提供（ui-slots 开放「槽声明的额外注册选项」+ ui-sidebar 投影 `SidebarPanelMetadata.conversationAgentPreset`），根因、否决方案与验收矩阵见 [Quno 侧栏选中态](notes/2026-10-30-quno-sidebar-selection-state.md)。旧 runtime 忽略该选项，退化为仅面板选中，不崩溃。同时把 `layout`、`uiWorkspace` 提升为 Quno 客户端 `inject` 声明——两者是交接页的载荷依赖，只靠 `ctx.get()` 读会让启动顺序决定成败（2026-10-30 二次修订，见同篇 §8.1）。

- **为什么走 fork**：`sidebar.workspaces` 是 single 槽，占位即整体替换；且**profile 启动的插件客户端没有动态 runner 的 shadowing facade**（它只在运行时插件管理器路径存在），single 槽注册若不显式 `priority: -1` 会与 stock 占位者同优先级冲突抛错（实机复现）。要「原样保留 stock 又并列一个备选视图」，插件侧无扩展点，满足 fork 门槛。
- **Quno 会话均不出现**：`origin: 'subagent'` 的 Executor 会话由 ui-workspace 原生隐藏；Quno 另经 `uiWorkspace.registerSessionVisibilityFilter` 注册 preset 过滤，隐藏 `agentPreset === 'quno'` 的永久主会话。工作区树、扁平列表和搜索结果统一应用这些过滤，注册/注销即时重算；过滤只影响浏览器展示，不改变 Workspace 成员关系、Host 搜索或会话日志，Quno 入口、任务卡与 `quno_recall` 仍可打开和检索相应会话。旧 runtime 没有该注册方法时插件正常加载，仅主会话新增过滤不生效。
- **风险与回归**：无 alternate 注册时区域渲染路径与上游一致；壳 e2e 探针断言的侧栏折叠循环与 `shell.leading` 重开不受影响。rail 态的搜索/添加图标在有备选时让位于切换钮（展开后齐全），为 stock rail 的唯一可见变化。

**被否决的两版（记录在案）**：占用 `sidebar.workspaces` 主槽自绘「Quno / 会话」页签（第一版落地后经用户纠偏否决——新会话/插件/自动化任务应当与既有会话同属 work，而非被替换；且自绘会话列表有搜索/右键/拖拽等先天缺口）；`sidebar.panellist` + `main` keyed 面板（Quno 会成为「一页应用」而非「消息对象」）。

### 13.3 主对话铬件净化（无工作区、无模式）

主对话由 `ensureMain` 以固定 cwd 创建（缺省 homedir），用户全程无 cwd/工作区/preset 入口。对话面本身**就是正常对话框**：模型选择器、权限、Plan、附件等 composer 常规件**全部保留**（「一个对话框和模型选择等等的」——用户明确）；只移除两类露出：**工作区**（hero/空态选择器、面包屑中的工作区路径）与**模式**（agent preset 控件与标签）。「模式」在本节的界定 = agent preset；权限模式、Plan 属常规 composer 件，保留。

- **会话标记**：同一标记组件注册进两个席位——`conversation.session.header.utilities`（list/session，id `quno-main-marker`）与 `conversation.hero.options`（list/session，id `quno-main-marker-hero`）：组件渲染隐藏哨兵，会话 `projectionValues.agentPreset === 'quno'` 时向上找最近 `[data-slot="main.conversation"]` 锚打 `data-quno-main="main"`（带 owner token 的认领，卸载/切换安全交接；右栏会话面与投影未到达时不打标——投影迟到只表现为净化晚一拍，不误伤）。hero 席位覆盖首开空态（此时头部铬件尚未渲染，utilities 席位不存在）。
- **按槽接缝隐藏**（只用 `[data-slot]` 接缝与自有命名空间，禁用 stock CSS-module 类名）：

| 隐藏对象 | 选择器接缝 |
|---|---|
| hero 工作区选择 / preset 控件 | `[data-slot="conversation.hero.workspace"]` / `[data-slot="conversation.hero.agentPreset"]` |
| 会话头面包屑（含工作区/cwd 露出风险） | `[data-quno-main] [data-slot="conversation.session.header.lineage"]` |

| 保留对象（正常对话框语义） | 说明 |
|---|---|
| 模型选择器 `conversation.input.model` | 用户明确保留；默认值由 quno preset 固定 |
| 权限 `conversation.input.permission` / Plan `conversation.input.plan` / 附件等 | composer 常规件，不动 |

- **会话头 preset 标签**（`conversation.session.header.actions` 的 `agent-preset` 占位）：同 id + `priority: -1` 遮蔽（dsh-copy-session-id 先例），组件在非 quno 会话渲染简易等价文本（数据源 `projectionValues.agentPreset`）、quno 主会话渲染 null。遮蔽是全局的，简易复刻是刻意取舍。
- preset 与工作区默认值由 `quno` preset / `ensureMain` 固定；模型默认值同，用户可在对话面改模型。
- 已知残留（v1 接受）：空态首屏 composer 的占位文案仍提「选择一个工作区开始」（`conversation.composer.bar` 内的输入占位，功能上可直接输入开聊，不拦工作流）。
- 勘误（2026-10-23）：`conversation.empty.workspace` 槽在本基线**不存在**，本节旧版与 QUNO_CSS 中的该选择器为死选择器，实现期删除；QUNO_CSS 现行隐藏 `conversation.input.model/permission/plan` 的规则随本节口径修订一并移除。

### 13.4 右栏 Quno 面板（动态 / 关注 / 任务实时看板）

基座原生两段式（ui-schedule 已发货先例）：

1. **类型注册**：`ctx.sidebarRightTabs.register({ id: 'dsh-quno/panel', kind: 'qunoPanel', multiple: false, keepMounted: true, title })`；参数经 `SidebarRightTabParamsMap` declaration merge 声明（`{ taskId?, view? }`）。
2. **实体注册**：keyed 槽 `sidebar.right.pane.tab`（body，key = `dsh-quno/panel`）+ `sidebar.right.pane.tab.title`（chip 标题，含运行中任务计数）。

- **面板内四视图**（组件内页签，设置页两页签同款 useState 模式）：
  - **动态**：各采集器实例一行（按钮）→ **采集器详情**；信息缺口；最近事件摘要，事件行 → **事件详情**（`eventDetail` 按需读取，payload 有界）。
  - **关注**：open/waiting/snoozed 列表 + 已处理/延后/不再关注按钮（`actAttention`，带 expectedRevision 防并发）；折叠分组「已完结」读 resolved/dismissed/expired，并显示完成时间；证据引用按 `reliability.readOriginal` 与事件 `pruned` 决定能否点开原文，不可读时只展示摘要与血缘。
  - **任务**：进行中/已结束列表；点击进入任务详情（§13.6，取消/续跑/子会话/产物）。
  - **运行**：Eval/Decision 与 WorkerRun 分列筛选——状态、来源 Thread/Ticket、超时次数、错误；通知列表（title/status/body/why/时间）；顶部「立即检查」复用 `checkNow()`。大正文只经 `evalDetail`/`ticketDetail` 按需加载。
- **采集器详情**（`collector-detail.tsx`，设置页与面板共用）：三轴状态（期望/生命周期/健康）分开展示；`healthy + stale` 显示「连接正常，但数据可能陈旧」；上次尝试/成功/事件/重试/连续失败/错误码/覆盖范围/来源延迟/检查点版本；能力声明（调度、间隔、run 超时、配额、权限、可靠性五项、首轮语义）；配置（secret 掩码）；本实例缺口；操作（暂停/恢复/停用/探测/编辑/删除）。声明缺失时显示「声明不可用」，不把未知补成支持。
- **导航参数**：`SidebarRightTabParamsMap.qunoPanel = { taskId?, collectorId?, runId?, view? }`；`view` 为 `'collectors' | 'attention' | 'task' | 'runs'`；`narrowPanelParams` 校验并丢弃非法值；实例删除后详情显示「实例不存在」并可返回，不崩溃。
- **数据源**：现有 `remote.quno.state` + 15 秒轮询 store（增 `eventsRecent`；任务列表连同 `plan`/`prompt` 摘要随 `state()` 下发，见偏差 #14）；新增按需只读 `noticeDetail` / `eventDetail`（有界缓存，不进轮询）；实时性升级路径为 typert stream（`@Remote({mode:'stream'})`），v1 不阻塞在轮询上。
- **右栏默认收起（2026-10-23 定稿，取代自动展开）**：进入 quno 主会话**不再自动 openTab**；面板打开入口只有两个——对话内胶囊（§13.5）与任务卡（§13.6）。用户手动展开后面板留在该会话右栏（dockkit 每会话一棵 dock 树，原生记忆）；手动关闭后不回弹。其他会话右栏内容不动；push/fullscreen/float/分栏/折叠全部吃 dockkit 原生能力，零自研。原「进入会话自动展开」的 watcher（含 600ms 有界重试）随之移除。
- **2026-10-28 状态体系改造（决策记录 `docs/notes/2026-10-28-quno-state-system.md`）**：四个视图按「页面状态 → 列表/详情」重排，`QunoCard` 不再承担全部页面容器。
  - **异步读取是值不是 `undefined`**：store 的 `noticeDetails` / `eventDetails` 缓存为 `AsyncValue<T> = loading | ready | missing | error`；`missing` 只来自 Host 明确返回 `null`；最近事件有独立 `eventsStatus`，失败保留旧列表且不把「读取失败」写成「没有内容」；每个详情请求带请求序号，旧响应不覆盖新响应。
  - **动态页状态机**（`panel-state.ts` 纯函数 + 单测）：`loading / load-failed / install-guide / first-connect / all-paused / syncing / empty / list`；首次同步中不显示「没有新变化」，后台刷新失败保留列表并出陈旧 callout，来源行只给一个最高优先级状态。
  - **展示原语**：列表统一 `PanelListRow`（状态点 + 标题 + 元信息 + 钻取箭头）；详情统一 `DetailHeader + DetailSection`；空态分四级——`PanelEmpty`（整页）、`InlineEmpty`（分区）、`MissingState`（对象不存在）、`Callout`（需要解释的状态）；`LoadingRows` 只用于首次加载。
  - **关注页**：保留卡片但去掉左色条，不显示 `topicKey`，状态本地化；操作失败留在原卡上提示冲突，不跳回列表。
  - **采集器详情**：默认只给身份、状态、上次成功同步、声明驱动的配置摘要、当前异常与主操作（暂停/恢复、编辑、探测）；三轴、检查点版本、尝试/重试时间、延迟与覆盖、连续失败、错误码、可靠性五项、权限原始声明与原始配置收进「诊断信息」折叠；停用与删除移入独立危险区（确认按钮为「取消 / 确认删除」）。
  - **任务页**：按「需要处理（failed/interrupted）/ 进行中 / 已结束」分组，空组不渲染；详情按状态条件渲染（running 计划、done 结果与产物、failed/interrupted 错误与续跑、cancelled 取消说明），无计划/无产物不留空标题；任务不存在用独立 `taskMissing`。
  - **运行页**：只负责思考运行，通知正文不再堆叠；`runId` 真正消费为运行详情页（状态、触发方式、起止、耗时、模型与成本、处置/延后/汇报数、错误）。运行状态统一映射：`claimed/running → 进行中`、`committed → 已提交`、`failed → 失败`、`interrupted → 已中断`、其他 → 未知状态；手动检查无工作时明确写「没有可处理内容，本次未调用模型」，不创建虚假运行记录。

### 13.5 对话内胶囊（正文右上悬浮；slot 只提供会话上下文）

- **挂载点（2026-10-29 定稿，取代「会话头工具区」）**：仍注册在 `conversation.session.header.utilities`——该槽提供 `sessionId`、preset 投影与会话级生命周期；但槽内只渲染一个隐藏 sentinel，可见胶囊用 `createPortal` 渲染到本会话的 `[data-conversation-content]` 右上角。理由：该容器 `position: relative`、位于会话头之外、包含滚动区与 composer，随左右栏和窗口大小自然变化；继续留在 header 内做 absolute/fixed 会随侧栏宽度漂移、被头部 stacking context 截断。沿革：`shell.overlay` fixed（废弃）→ `input.dock`（废弃）→ composer overlay（废弃）→ header 工具区（2026-10-23）→ 正文悬浮（2026-10-29）。
- **锚点校验（`capsule-anchor.ts`）**：从 sentinel 起，先看自身是否已在 content 内，再找最近的 `[data-slot="main.conversation"]`，最后逐级向上找；候选必须同时满足 `data-conversation-session === sessionId` 且不在 `[data-sidebar-right-session]` 内（拒绝右栏嵌入副本与其他保留会话）。找不到锚点就不渲染（`hidden-no-anchor`），不退回 header。
- **定位**：`[data-quno-capsule-root] { position: absolute; top: 8px; right: 12px; z-index: 6 }`；浮层 `top: calc(100% + 6px)`、宽 `min(300px, 正文宽 − 24)`、高 `min(420px, 正文高 − 64)`；不写 fixed 坐标、不读 `window.innerWidth`。浮层与胶囊共用同一 stacking context，层级低于 composer 菜单、原生菜单与设置弹窗。
- **显隐状态机（`view-model.capsuleVisibility`）**：`hidden-not-quno / hidden-no-face / hidden-no-content / hidden-no-anchor / hidden-right-panel / hidden-navigation / visible-collapsed / visible-flyout`。右栏展开按**当前 Session**判断（`[data-sidebar-right-session="<sid>"][data-sidebar-right-open]`），并在 `[data-dockkit-float]` 内查找 `[data-quno-panel]`（保留挂载 ≠ 可见）；其他会话的右栏不影响本会话胶囊。
- **交互**：点击胶囊只展开概要浮层（非模态 `role="dialog"`，不设 `aria-modal`）；点击外部或 Escape 只关浮层，Escape 把焦点还给触发按钮；点击任务/关注/动态任一行 → 立即关浮层 → 立即隐藏胶囊（navigation hidden，覆盖右栏展开动画）→ `openTab('qunoPanel', { params: { view } })`；右栏关闭后若仍有内容则胶囊恢复。`openTab` 抛错时恢复胶囊并显示非阻塞提示，不假装右栏已打开。行内不显示 `topicKey` 或事件 ID。
- **形态**：高 26px 全圆角，描边 + layer 底色，无阴影；只显示非零计数并配任务/关注/来源图标；正文宽度 < 480px 时退化为「Q 标 + 合计数字」，浮层仍显示完整概要；无内容时不渲染。
- **可访问性**：触发按钮带 `aria-haspopup="dialog"`、`aria-expanded`、`aria-controls` 与完整可访问名称（“Quno 概览：N 个任务进行中，M 条关注，K 个来源异常”）；`prefers-reduced-motion` 关闭浮层入场动画。
- **清理**：会话切换、preset 变化、总开关关闭、正文容器重建、插件卸载都会清理 Portal、Resize/Mutation observer、document 监听、导航隐藏与浮层状态；不新增全局单例。

### 13.6 任务卡 → 面板联动（子任务实时运行）

- `quno_task` 任务卡（`tool.call.toolview` keyed 槽，已落地）的主按钮改为：`ctx.sidebarRight.openTab('qunoPanel', { params: { taskId, view: 'task' } })`（ui-schedule `openTaskDetail` 同款发货先例）；「查看完整子会话」`openSession(childSessionId)` 为次按钮；面板服务不可用或总开关关闭时主按钮降级为跳子会话。
- **任务详情视图（2026-10-27 修订）**：真实状态、静态计划、原始指令、按 `createdAt/settledAt` 计算的耗时、结果、错误、产物与子会话入口。**不展示「第几步/工具调用 5/8/单轮 120s」**——现有委派数据没有步骤状态机，8 次工具与 120 秒是 Eval/WorkerRun 预算，不能套到 Ticket 的全部生命周期；要做实时过程需另开按需 `taskDetail` 并从子会话日志推导。
- **取消（2026-10-27）**：新增 `taskCommand({action:'cancel'})`。先持久化用户取消意图，再 dispose 子任务 activation；所有晚到完成/失败/中断在写状态前检查 durable status，取消后不改状态、不再发完成通知；重复取消幂等；重启对账不会复活已取消任务。已完成任务拒绝取消。`abandon` 保留为取消的别名。
- **子会话与产物**：「查看子会话（只读执行权限）」——`openSession(childSessionId)` 打开的是正常会话，只读边界来自 `quno-task` preset 的执行权限，不是一个只读 transcript 查看器。产物：`url` 走普通外链；`file`/`directory` 显示路径并提供复制（不硬跳 `file://`）；`note` 可展开查看。
- 链路闭环：回复消息里的卡片（对话上下文）→ 点击 → 右栏实时运行（不离开主对话）→ 需要深挖才跳进子会话只读视图。
- 运行日志的逐行 follow（`ctx.jobs` Remote stream）v1 未接，任务详情以结果/计划/产物 + 子会话入口呈现（偏差 #14）。

- **2026-10-28 修订**：任务详情改由状态表驱动（见 §13.4）：计划只在 running、结果与产物只在 done、错误与续跑只在 failed/interrupted、取消说明只在 cancelled；原来「计划 + 产物」的固定空分区一并移除。子会话入口只在 done/cancelled 出现，任务不存在用独立 `taskMissing`。

### 13.7 挂载点与 Remote 总表（2026-10-23 修订，work/Quno 制）

| 槽/机制 | 内容 | 状态 |
|---|---|---|
| `sidebar.panellist` 条目声明（fork zw.9 能力） | Quno 行归属：`conversationAgentPreset: 'quno'`，对话态按主会话 `agentPreset` 投影推导选中 | 已落地，`v0.2.1-rc.2+zw.9` |
| `sidebar.workspaces.alternate`（fork zw.6 新槽） | Quno 联系人页签 | 已发布（`v0.2.1-rc.2+zw.6`）并实机验证 |
| `sidebar.workspaces`（stock，不动） | work 页签 = stock 浏览区原样 | fork Region 包装，无备选时逐字节等价 |
| `sidebarRightTabs.register` + `sidebar.right.pane.tab`（+`.title`） | Quno 面板（动态/关注/任务） | 已落地，实机验证 |
| `conversation.session.header.utilities`（order 60） | 对话内胶囊：槽内只放隐藏 sentinel，胶囊 Portal 到正文容器右上角 | 2026-10-29 定稿（header 工具区版废弃） |
| `conversation.session.header.utilities` + `conversation.hero.options` | `data-quno-main` 会话标记（双席位，渲染 null/哨兵） | 已落地，实机验证 |
| `conversation.header.leading`（显式 priority:-1） | Quno 会话头身份（头像 + 名字 + 状态点） | 2026-10-23 新增（§13.8），待实现 |
| `conversation.hero.options` | Quno 首开欢迎块（头像 + 欢迎语 + 建议开场） | 2026-10-23 新增（§13.8），待实现 |
| QUNO_SKIN_CSS（`data-plugin-css` 幂等） | 消息头像、皮肤 token、卡片规格 | 2026-10-23 新增（§13.9），待实现 |
| `conversation.session.header.actions` 同 id 遮蔽 | quno 主会话隐藏 preset 标签 | 已发货机制（copy-session-id 先例） |
| `tool.call.toolview` key `quno_task` | 任务卡（主按钮 → 面板，次按钮 → 子会话） | 已落地 |
| `conversation.chat.turnTail` | 回合尾反馈按钮（读本回合通知，不再扫「最近一小时」） | 2026-10-27 改为 Turn 绑定 |
| `ctx.uiConversation.events.register` | `quno-notice` Definition：通知消息 → 隐藏 Chat node → `turnDataSource` 按回合回读 | 2026-10-27 新增 |
| `shell.overlay`（id `quno-onboarding`） | 三栏接入向导（创建/编辑同一表单，`min(1120px, viewport-64px)`） | 2026-10-27 新增 |
| Typert Remote `quno` | 20 方法：新增 `triggerDetail` / `threadDetail` / `ticketDetail` / `evalDetail` / `exchangeDetail`（大正文不进轮询） | 2026-11-05 新增 |
| `settings.section` / `settings.general.item` | Quno 设置页 / 总开关 | 已落地 |
| Typert Remote `quno` | 11 方法（含新增 `eventsRecent`；任务列表随 `state()` 携带 plan/prompt） | 已落地 |

纪律沿用：注册即 effect、缺槽 try/catch 降级（rc.45 教训）、样式预打 `data-plugin`/`data-plugin-css`、只用 `[data-slot]` 接缝与 `--dsw-*` token、文案中文接 `ctx.locale` 双语；另加两条实机教训：boot 插件无 runner facade（single 槽显式 priority 或走接缝槽）、React 钩子不得位于条件返回之后（#310 崩溃面）。

### 13.8 对话面设计标准（Quno 皮肤；2026-10-23「连成一体，安静对话」二次修订）

设计目标：主对话看起来、摸起来都像「和 Quno 这个人说话」，而不是又一个 agent 控制台；视觉方向为冷灰侧栏、白色主画布、克制的雾蓝强调（提案《连成一体，安静对话》，实现记录见 `docs/notes/2026-10-23-quno-quiet-design.md`）。

**原则**

1. **身份在场**：每轮回复首部带头像；会话头有名字与状态；首开空态有欢迎。
2. **换肤不换管线**：stock 的流式渲染、Markdown、工具卡、回合轨、滚动管理全部保留；Quno 风格 = 作用域 CSS（`[data-quno-main]`）+ 加法槽。整体接管为何不取，见 §13.9 决策与风险表。
3. **一致性**：只用 `--dsw-*` token、`--quno-*` 调色板与 `[data-slot]` 接缝；暗色双写（`body[data-ds-dark-theme]` 下的调色板覆盖）；文案中文接 `ctx.locale`。

**身份三件套**

- **消息头像**：assistant 回复首段左侧 26px 圆形 Quno 头像——纯 CSS `::before` 挂在 `[data-chat-flow-kind="assistant-step"]`（皮肤补 `position: relative`；正文列左缘 36px 固定，与输入框列对齐不动）。**头像占列首独立行槽 0..26px**（不悬出列缘、与正文留 10px），**回复底部动作行随正文缩进**（`[data-turn-tail]` 加同一 indent，stock 的 `-6px` 与按钮 6px 内边距抵平，图标左缘核回正文左缘）：头像因此在消息气泡之外，且恒在复制按钮垂直线的左侧（头像右缘 26 < 按钮盒左缘 30），两者分列两轴——2026-10-23 二次裁定，取代「头像左缘对齐复制按钮左缘」的旧口径；连续输出与工具过程后的后续段不重复插头像（相邻同 Kind 撤销 `::before`）。user 消息保持 stock 右对齐气泡；system/compaction/tool 节点无头像。回复首部名字标签为待办：chat 流的分组虚拟化使纯 CSS 无法稳定挂到每轮首段，需 fork 座位或上游 hook。
- **会话头身份**：`conversation.header.leading`（single/root，显式 priority）渲染「头像 + Quno + 状态点（在线/静默/暂停）」，仅当前在屏会话为 quno 主会话时输出，其余渲染 null；**头部两行左对齐**——第一行身份，第二行「对话/轨迹」居其下（会话标题行退场；不贴右侧，2026-10-23 用户裁定）；面包屑已隐藏（§13.3）。
- **首开欢迎**：`hero.options`（list/session）渲染 Quno 欢迎块（大头像 + 一句欢迎语 + 三枚建议开场 chips，点击即发送）。stock 鲸鱼座（`hero.brand.mark` 的 fallback）在 `[data-quno-main]` 下经座席 `[data-slot]` wrapper 隐藏；`hero.headline` 文案硬编码不可换，接受保留。

**视觉规格（安静对话）**

- 消息列与输入框同宽居中：`min(800px, 100%)`（提案 800–840px），右栏打开自适应收窄。
- 气泡：用户气泡右对齐、冷灰底（`--dsw-specific-bubble` 作用域覆盖为 `--quno-bubble`）；assistant 无气泡，靠头像与段落节奏分区。
- **回合节奏**：已完成过程行（「已完成，用时 X 秒」）退场——执行信息走轨迹视图；运行中行内含 `[data-chat-running]` 不受影响（执行中状态保留）；回复组以 24px 上间距分区，不再有横贯分隔线。
- **回复底部只留复制与用量**：赞/踩/分支按钮退场（按 stock aria-label 中英双字典值锚定，stock 改文案时 fail-open）；复制/用量/时间保持 stock 图标形态原样（不加文字、不改样式）；复制成功反馈为 stock 原位行为；用量沿用 stock 统计口径；复制与用量/时间簇收拢到行内相邻按钮的 8px 节奏——对 `[data-turn-tail]` 行末 meta span 置 `margin-left: 0` 抵消 stock 的分组边距（评价/分支在场时该边距是呼吸，只剩复制时读作空洞，2026-10-23 用户裁定；stock 改结构时规则失效回落 stock 值）。
- 卡片（汇报卡/任务卡统一）：圆角 16、1px `--dsw-alias-border-l1`、padding 12/14、标题行 13px 次级色 + 正文 14px、左缘 3px 状态条（running=interactive、done=state-success、failed=state-danger）。
- 输入框：与消息列对齐、16px 圆角、极弱底部阴影；附件/模型/权限/Plan 保留；发送钮雾蓝 `--quno-accent`；对话内胶囊（任务/关注入口）在会话头右上工具区（§13.5），无事项不渲染。
- token 作用域：容器级覆盖只写少量 alias 与 `--quno-*` 调色板；portal（Tooltip/Modal/Menu 渲到 document.body）逃出容器作用域——胶囊/卡片的 tooltip 不吃覆盖，接受。
- 状态呈现：stock RunningStatus（鲸尾 + shimmer）保留，文案不可换（不是槽），只经 token 改色；turn 状态读取面用 `useSession` / `useSessionStatus`。
- 动效：页签切换 160ms 底色过渡、alternate 视图 160ms 淡入，缓动 cubic-bezier(0.22,1,0.36,1)，`prefers-reduced-motion` 时全部取消；流式输出原速呈现，不逐字淡入；「对话/轨迹」140ms 与右栏 220ms 属 stock 自有行为，皮肤不接。

### 13.9 对话面代码设计

**组件/注册清单**（注册即 effect、总开关门控）：

| 件 | 槽/机制 | 形态 |
|---|---|---|
| 会话标记 | `conversation.session.header.utilities` + `conversation.hero.options` | `data-quno-main` 哨兵（已有） |
| 消息头像 | 纯 CSS（QUNO_SKIN_CSS） | `::before` + 缩进 + 呼吸 |
| 会话头身份 | `conversation.header.leading`（single/root，显式 priority:-1） | `QunoHeaderIdentity`，非 quno 渲染 null |
| 首开欢迎 | `conversation.hero.options`（list/session） | `QunoHeroWelcome`（头像 + 欢迎语 + chips） |
| 对话内胶囊 | `conversation.session.header.utilities`（session 座位） | `QunoCapsule`（§13.5） |
| 右栏面板 | `sidebarRightTabs` + `sidebar.right.pane.tab` | §13.4（已落地） |
| 任务卡 / 回合尾 | `tool.call.toolview` / `conversation.chat.turnTail` | 已落地 |

**QUNO_SKIN_CSS 结构**（单一 `<style data-plugin="dsh-quno" data-plugin-css="skin">`，幂等插入；2026-10-23 收敛为七块）：

1. token 作用域块（`[data-quno-main]`；头像 26px）
2. 消息头像块（`data-chat-flow-kind` 选择器；连续输出不重复插头像）
3. 会话头身份 / hero 欢迎块
4. 胶囊块
5. 卡片块（汇报卡/任务卡统一规格）
6. 铬件隐藏块（§13.3 表）
7. Quno 调色板（`--quno-*`，暗色双写）+ 安静对话页（头部一行化、列宽 800、已完成过程行退场、回复底部只留复制与用量、底部动作行随正文缩进让出头像列、气泡冷灰、发送钮雾蓝）

侧栏无皮肤块：Quno 入口为原生面板行（`main` 槽 + `sidebar.panellist`，见 §13.2），壳自持样式。

**实现期修正项**（对现行代码的 delta）：移除 QUNO_CSS 中 `conversation.input.model/permission/plan` 的隐藏（口径已修订为保留）；移除 `conversation.empty.workspace` 死选择器（该槽在本基线不存在）；胶囊仍注册在 `conversation.session.header.utilities`（该槽只提供会话上下文），可见 DOM 由 Portal 落 `[data-conversation-content]` 右上角（fixed / dock 行内 / overlay 悬浮 / header 工具区四版均废弃，§13.5）；移除右栏自动展开 watcher。

**不整体接管对话框的决策**（「可能不能沿用 DSH 对话框」的严肃回答——评估过三条接管路径，均否）：

1. 遮蔽 `conversation.chat.node`（keyed）：assistant-step 要重写 Markdown 流式渲染（纯度门禁止值 import stock 组件），遮蔽全局生效、非 quno 会话无回落——否。
2. 接管 `conversation.session` / `main.conversation`（single）：带 children 的 single 槽遮蔽后，dispose 会把同名子槽 entries 清空且不可恢复（`releaseChildren` 无引用计数），插件卸载即留下残局；且 `renderSlot('conversation.chat.flow')` 有调用方授权（SlotOwnershipError），外部 entry 渲不了 stock 消息流——否。
3. `conversation.composer` chain 接管输入条：select 拿不到 agentPreset（SessionSnapshot 无此字段），且会丢草稿/附件/快捷键等 stock 行为——否。

结论：**皮肤化是唯一严肃路径**。若未来确需深度接管，先解决子槽释放语义（fork 事项，另立 note）。

**风险表**：

| 风险 | 处置 |
|---|---|
| `conversation.header.leading` 全局占位 | 非 quno 会话稳定渲染 null；实机回归各会话头 |
| portal 逃逸容器作用域 | tooltip/popover 不吃皮肤，接受 |
| RunningStatus 文案不可换 | 接受，只 token 改色 |
| 胶囊是头部工具行条目而非浮层 | 行内流式排布（全圆角/软阴影），无内容时不渲染；面板展开即退场 |

### 13.10 接入向导（`shell.overlay`，2026-10-27）

- **为什么不是设置弹窗**：原生设置弹窗宽度约 800px，容纳不下「类型 300 + 表单 + 说明 240」三栏；挂 `settings.onboarding` 会误入全局首次启动流程。
- **形态**：应用内大 Modal，`shell.overlay` 注册宿主（不随总开关消失），宽度 `min(1120px, calc(100vw - 64px))`；`≥980px` 三栏，`720–979px` 右栏说明下移，`<720px` 类型卡改为顶部下拉；头尾固定、中栏滚动。
- **草稿归属**：向导宿主持有草稿；切换列/缩放/轮询不清空；有未保存修改时关闭需二次确认；Escape 同路径。
- **创建闭环**：校验通过 → 保存 → 显示「已创建，正在首次同步」+ 当前三轴状态；不先报成功。编辑复用同一表单，走 `collectorCommand({action:'reconfigure'})` 的统一重启语义。
- **字段驱动**：`CollectorConfigField` 支持 `min/max/step`、静态 `options`、`multiple`（字符串列表）、`discover`（远程选项）、`advanced`（折叠组）与 `secret`（留空保持，清空是独立动作）。跨字段规则由 Host 返回完整错误，客户端不猜。
- **云之家「最近群聊」**：`discover: true` 的 `groupIds` 经 `collectorOptions` → `im group recent` 分页；只有 `groupType: 2`（多人群聊）可选，私聊/助手/系统通知/未识别类型显示但禁用并给出原因。`auth-required` 显示 `yzj-cli auth login` 引导，不自动执行登录、不接触 token。

- **2026-10-28 修订**：类型卡只保留类型图标、名称与一句话能力说明（不再显示实例数量）；选项按钮用字段语义「选择{字段} / 收起 / 重试」，未选择时显示「尚未选择{字段}」；选项请求以 `type + field + 草稿配置 + page` 为键，键已变化的旧响应直接丢弃；密钥字段区分「未配置 / 已配置保持不变 / 将替换 / 将清除」四种状态；脏表单关闭按钮为「继续编辑 / 放弃修改」；创建结果按真实阶段展示（正在启动 / 等待登录 / 首次同步中 / 已就绪 / 启动失败及原因），不先报成功。

### 13.11 状态文案纪律（实现固定）

| 事实 | 必须这样写 |
|---|---|
| 检查点 | 「检查点版本 `v{revision}`」，不显示/命名「游标」 |
| 最后成功同步 | 旁边给缺口/覆盖范围提示：成功 ≠ 完整捕捉 |
| `nextRetryAt === null` | 「未安排（失败后采集循环会自行退避重试）」 |
| `healthy + stale` | 「连接正常，但数据可能陈旧」 |
| gaps | 「最近记录的缺口」，不说「当前未解决缺口」 |
| 首轮同步 | 按类型 `firstSync` 分别说明；未声明为「未知」，不写通用的「从现在开始」 |
| 创建成功 | 「已创建，正在首次同步」，不是「连接成功/基线已建立」 |
| 探测成功 | 只说明可达性，不写成同步成功 |
| 取消任务 | 「已取消」+「晚到结果不会改回状态」；不改写完成通知 |
| 加载失败 | 「读取失败」+ 重试；不写成「没有内容」 |
| 对象不存在 | 事件/任务/运行/采集器各有独立 missing 文案，不复用其他对象 |
| 首次同步中 | 「首次同步进行中」，不写「目前没有新变化」 |
| 初始数据未读回 | 首次加载用骨架行；后台刷新失败保留旧内容 + 陈旧提示，不清空列表 |
| 手动检查无工作 | 「没有可处理内容，本次未调用模型」 |
| 运行状态 | `committed → 已提交`、`claimed/running → 进行中`；不直出英文枚举 |

## 14. 插件落点与 DSH 能力映射

### 14.1 包结构

一个核心安装单元（`pnpm run plugin:new -- dsh-quno --face dual --preset-owned`），内部按「纯领域 / 宿主适配 / 产品面」分层；采集器按需独立插件：

```text
dsh-quno
  core/model      TypeScript 领域类型与纯谓词（无 I/O）
  core/policy     准入、Policy 版本、Mandate revalidate
  core/repository 持久化端口（SQLite 与内存实现共同契约）
  core/intake     Trigger/Thread/fan-out/Eval 排队
  core/evals      Eval 批处理、Decision、超时与重排
  core/tickets    Ticket/Subscription/Input/resume/stop/handback
  core/assignments Assignment/WorkerRun/Report/读取证据
  core/exchanges  Exchange 配对与超时
  core/engine     唯一领域写入口与角色接口
  core/memory-store 内存 Repository（领域测试）
  app/store       SQLite Repository、事务、迁移、只读查询
  app/effects     持久 Effect queue
  app/transport   followup/steer/inject、messageId、flush、对账
  app/executor    Worker 生命周期、WorkerSlots、恢复与 Report
  app/worker-tools Worker 工具面
  app/assessor    主对话 Eval/Report 投递
  app/turn-kind   回合分类与记忆门禁依据
  app/watchdog    只读运行健康检查（不修改状态）
  collectors      采集层（registry + Host 调度器 + mount 生命周期 + 健康推导；query.handleRequest 走封闭白名单，拒绝可指导）
  scheduler       有界 pass、到期与退避
  recall          对象图与全文召回
  service         Cordis 组合根与窄接口装配
  api + client    Remote、设置页、四面板与小部件

dsh-quno-collector-<name>   各来源采集器（日历、订阅源、云之家群聊）
```

边界：`core` 不做 I/O，不 import `app/collectors/client`；`collectors` 不 import `app` 私有实现；Client 只消费 Wire 类型；所有注册随 Cordis effect 回收。

### 14.2 能力映射（核对基线 `v0.2.1-rc.2+zw.4`）

| 能力 | 已有 | 本方案落点 |
|---|---|---|
| 插件生命周期 | Cordis service/effect/scoped tools | Host 管采集/调度/存储；注册与 timer 随卸载回收 |
| 独立 Agent | `ctx.agents.create`（可设模型/受限工具） | 每轮分析与委派任务；ohmymemo dream 有相似先例 |
| 子代理 | `ctx.subagents.startActivation`（spawn/fork、`delivery:'caller'`） | 委派子任务执行（§5） |
| 后台作业可观察 | `ctx.jobs`（事件落 owner 会话日志 + Remote 流） | 任务进度与留痕 |
| 长期会话恢复 | `ctx.sessionController.resolveAgent` | 冷主对话投递前恢复 |
| 唤醒与注入 | `followup` 唤醒；`inject` 不唤醒 | 汇报/回流用 followup；不拿 inject 当唤醒 |
| 可靠写入 | `ctx.sessions.flush` | outbox 投递必经检查 |
| 原生 Schedule | 持久任务、冷会话恢复、合并错过周期、最小 60s | 只用于用户显式提醒（投递进主对话） |
| 压缩 | compaction realm（per-preset isolate）+ hierarchical Provider | 主对话激进参数（§4.3） |
| 历史检索 | `sessionQuery`（全文、`traceEvent` 替换链） | `quno_recall`（§4.4） |
| 记忆 | OhMyMemo 全套 | 只读召回 + 显式写入纪律（§4.5） |
| 存储 | storage KV 无跨记录事务 | 专用 SQLite repository（§11） |
| Webhook | experimental，一动一会话 | 不直接复用其语义做采集入口 |
| UI | slot/Remote 模式 | §13；具体槽挂载需基线冒烟 |

**明确不走的捷径**：浏览器 setInterval 驱动 Quno；把全部事件写进 system prompt；以 inject 当唤醒；复制伪造 assistant 日志；依赖 experimental 包私有 API；新增 Electron 业务 IPC；改 harness loop。若现有 slot/隔离能力不足，先验证并列最小通用扩展；确需 fork 按基线升级流程发 zw 层并 pin revision。

桌面退出/休眠期间不承诺继续采集：恢复后补拉支持回溯的来源，不支持回溯的明确报缺口。**关机后继续运行明确不需要**（产品决策，§17），云端常驻不做。

## 15. 验收（行为验证）

> 链路评测的 case、节点证据、Live/Replay 与本地运行设计见 [Quno 链路评测集与本地回放设计](notes/2026-11-06-quno-link-evaluation-design.md)。**评测器已落地**（`plugin/dsh-quno/evals/`，`pnpm run eval`；scripted 全量 21 case 绿 + 8 blocked，实施记录与所修缺陷见 [评测器落地](notes/2026-11-06-quno-link-evaluation-impl.md)，organ 发现/白名单用例见 [按需只读查询落地](notes/2026-11-08-quno-organ-on-demand-read-impl.md)）；发布门仍以 Live P0 连续三次全绿为准，尚未执行。

### 15.1 主对话、Ticket 与 Worker

| 场景 | 必须观察到 |
|---|---|
| 永久对话 | 任意重启/压缩后身份、记忆、话题连续；无新建会话入口 |
| 主对话只路由 | 执行型请求的唯一工具调用为 `quno_task start`（Eval 回合为 `quno_eval_decide accept`），返回后立即应答「已交后台」；主 preset 无 shell/文件/网页/Skill/Goal 工具 |
| 第三方工具不可用 | Worker 无对应通道时必须明确 blocked/failed/waiting 并如实回流；端点经 `quno_read.collectors` 发现、不猜端点名，`queryAdvertises` 校验「实例挂载且类型声明 `handleRequest`」，拒绝文案列出真实可用端点（endpoint + label）；不得虚构 `collector:*` 已挂载、桌面更新根因或第三方查询结果；白名单外 payload 被 organ 拒绝且原因回流（`organ-whitelist-reject`）；真实来源正向读取单独验收（`third-party-cli-live-read`，保持 blocked），不用合成 Organ 冒充 |
| Ticket 正常回流 | 主对话立即回应 → 任务卡进度 → Worker Report 经 Router relay 自然语言汇报 + 卡片定格 |
| direct accept 幂等 | 同一 `sessionId+messageId+toolCallId` 重复调用只产生一个 Ticket/Assignment |
| Eval accept | 单事务写 Decision/Ticket/Mandate/Assignment/Subscription/launch Effect；重复 accept 返回原 Ticket |
| Ticket 中途退出桌面 | 重启后对账：turn 已结束的关闭 WorkerRun、未完成的重新 arm launch Effect；已交付未读 Input 重投、已读不重投 |
| 人类 follow-up 所有权 | owned Thread 上的人类消息交给 Ticket，不重新 Eval；context-only 只提供输入；所有 Owner 释放后才回 Eval |
| handback | 每个 Ticket 对同一 Trigger 最多交回一次；最后一个 Owner 释放后回到 primary Thread 的 Eval |
| stop / resume | 人类 stop 后不再接收新 Input；非人类结束的 Ticket 可由 owned 人类消息在同一 Mandate 下恢复，恢复前 revalidate |
| observe / auto | observe 下 inferred accept 记录 `would_accept` 且不建 Ticket；off 只准入点名消息；auto 才按 `autoSourceIds` 规则执行 |
| 激进压缩 | 上下文 ~50% 即滚动压缩；摘要含 turn/seq 指针；身份与 capsule 不被压 |
| 历史召回 | 「三月那个方案」经 recall 命中被压缩原文（替换链追溯）并正确引用 |
| 记忆纪律 | 「今天别提醒」不进 OhMyMemo；自动回合（Eval/Report/Notification）的 `memory_*` 写入被 Host 拒绝 |
| 梦境隔离 | 自动 relay 与 Worker 会话不产生梦境证据（只采 `source.kind === 'user'`） |
| 侧栏 Quno 入口 | 自动化任务行下方出现原生面板行「Q Quno」；点击打开唯一主对话并保持选中；总开关关闭后行消失、侧栏原样回归 |
| Quno 会话过滤 | 工作区树、扁平列表与搜索均不显示 Quno 主会话与 Executor 会话；Quno 入口与任务卡仍可打开相应会话 |
| 铬件净化 | quno 主会话无 hero/空态工作区选择、preset 标签与 cwd 露出；模型选择器、权限、Plan 等 composer 常规件保留可用 |
| 右栏面板与胶囊 | 右栏默认收起；胶囊实时计数；动态/关注/任务三视图实时刷新；大正文只经 detail 接口按需加载 |
| 对话皮肤 | 每条 Quno 消息左侧头像；会话头头像 + 名字 + 状态点；首开欢迎块；非 quno 会话无皮肤残留 |
| 任务卡联动 | 点任务卡 → 右栏定位 Ticket（目标/输入/产物/问题/续跑/放弃）；「查看完整子会话」进入只读 Executor 会话；会话不出现在列表 |

### 15.2 事件流与判断（沿用事件流设计验收表）

| 场景 | 必须观察到 |
|---|---|
| 5 秒采集、5 分钟思考 | 采集 ~60 轮，变化按策略进有限批次；不产生 60 次模型调用 |
| 来源重复投递 100 次 | 一个 Trigger 身份、稳定 ACK、不重复 fan-out |
| 同键不同内容 | 明确冲突，不覆盖原事实 |
| 同主题十条更新 | 一个关注事项，最多一次当前版本合并汇报 |
| 接收/Intake/ACK 间崩溃 | 同事务全有或全无；重放批次返回原 ACK |
| 100 条突发 Trigger | 每 Thread 一个 active Eval、每批 ≤20 条，不产生 100 次 Router 调用 |
| 撤回/乱序 | 撤回影响事项与未投递通知；不按到达序盲信（supersedes/occurredAt） |
| 用户点击与 Eval 并发 | Attention revision CAS 保护用户最新状态 |
| 一小时后提醒且无新事件 | 时间到仍重评，产生一次新阶段提醒 |
| 无新事件无到期事项 | 不创建模型运行，不发空消息 |
| 休眠 8 小时 | 一次补偿检查分批消化，不补发 96 条 |
| Eval 超时 | 候选已交付才计时；最多重排两次，第三次 unavailable 并结算 pending |
| 一条毒事件 | 有界重试后定位隔离，不阻塞其他来源 |
| flush 后进程崩溃 | 对账既有输入，不盲目重复投递 |
| 已入队表达失败 | 展示沟通失败/待重试，不误报「已告诉用户」 |
| 安静时段 50 条变化 | 正常采集分析，解禁后只汇报仍有价值内容 |
| 来源 2 小时未同步 | Quno 不说「一切正常」，明确信息陈旧 |
| 单一来源刷屏 | 配额与公平调度生效 |
| 停用/插件 HMR | timer、订阅、运行取消正确回收，重启从持久状态恢复 |
| 断网/磁盘满 | 不假 ACK、不静默跳 cursor |
| 两个 Quno 订阅同一事件（未来） | 独立消费互不影响 |

### 15.3 Collector 接入门槛（S01–S14 + Host 调度，tests/collector-gates + collector-scheduler）

声明协商失败即拒启 / run ctx 只含 checkpoint+commit 等采集面 / 重试同身份 / 崩溃各边界可对账 / 旧 run context 写入拒绝（generation 栅栏）/ 空同步不唤醒模型 / 分页溢出报缺口 / 背压不假 ACK / 暂停幂等释放 mount / 凭据轮换不重建身份 / 派生血缘固定 / 升级不重发历史 / 单采集器故障不阻塞其他 / 无业务副作用。调度单测另钉：启用即跑、hint 钳制 [now+1s, now+24h]、`retryAfterMs` 优先于退避梯、fatal/超时停排、健康推导（issues 降级成功 run、extras 透传）。

### 15.4 质量指标

`EngineMetrics`（`app/metrics.ts`，按需从持久行计算，无独立计数表漂移）：

- Trigger→Decision 的 p50/p95（由 Decision.createdAt 与其 Trigger.receivedAt 推导）；
- 每 100 条被判定 Trigger 的 Decision 数（Router 调用经济性）、每 Eval 平均批大小；
- accept/ignore/unavailable 数与 direct accept 占比；
- observe 模式 `would_accept`/降级记录数；
- Input delivered → read → acknowledged 的分段 p50/p95；
- 通知重复数、重启重复投递与状态倒退数目标为 0（由 Effect generation、稳定 message id、revision CAS 保证）；
- 来源新鲜度、缺口与 dead-letter、主对话压缩频率与召回命中率沿用旧口径。

`Watchdog` 只读报告额外覆盖超时 Eval、连续失败 Effect、空闲 pending Thread 与未投递输入。性能目标排除模型与网络不可控耗时单独压测；不把 5 秒采集宣称成 5 秒提醒。

## 16. 分期路线图

- **阶段 A（协议与可靠性闭环）—已完成 2026-10-23**：contracts/store/ingress/routing/scheduler + 测试 Sense + 假模型结果 + outbox；故障注入覆盖 ACK 幂等、事务原子性、重启恢复、对账；主对话绑定与 `quno` preset 骨架（含压缩参数）同步落地。
- **阶段 B（可用的个人助理）—已完成 2026-10-23**：真实 AgentLoop 分析与主对话投递、关注事项、反馈（按钮 + 自然语言）、安静时段、来源健康、`quno_recall`、委派子任务正常路径 + 任务卡、设置页五个页签、侧栏入口。两个真实 Sense 落地为**本地 iCalendar + RSS/Atom**（消息源当时无可用 API 而延后，现经 yzj-cli 路径解除阻塞，Sense 设计见 §6.11，待实现）；dry-run 由 `config.dryRun` 提供，开启主动汇报由用户决定。
- **阶段 C（真实使用调优）—机制已落地 2026-10-23**：以确定性模拟验证 125 条积压的有界批次、跨源公平、同主题合并、每小时通知上限与最小间隔、时间驱动的复查、保留期清理与预算；真实数天的误报/漏报调参仍需上线后按 §15 指标迭代。
- **交互改版（2026-10-23 落地，work/Quno 制）**：§13 全面重写两次后定稿——fork zw.6 增 `sidebar.workspaces.alternate` 接缝，「work」（stock 原样）/「Quno」（联系人视图）双页签；主对话铬件净化（双席位标记 + 接缝 CSS）；右栏 Quno 面板（动态/关注/任务 + `eventsRecent`）；收起态实时胶囊；任务卡 → 面板联动。实机（scratch `DSH_HOME` + 真实浏览器 DOM 断言）全链路通过；偏差 #12–#15。
- **Super-agent 内核重构—已完成 2026-11-05**：Trigger/Thread/Eval/Decision/Mandate/Ticket/Assignment/WorkerRun/Input/Exchange/Effect 领域内核、SQLite v3 迁移、Effect outbox、SessionTransport（followup/steer/inject + 稳定 messageId）、只读 Executor、主对话 Eval Router 与按回合门禁全部落地；旧 Analyzer/Router/Runner/TaskOrchestrator 写路径删除。实现与验收证据见 §18.1，设计依据见 `docs/notes/2026-11-05-quno-superagent-program-design.md`。
- **dsh-thread 退役—已执行 2026-11-03**：见 §16.1——功能整体不需要，**不依赖 Quno 进度、无能力平价要求**，随桌面 0.4.0-rc.8 下船（插件整包删除 + `src/install.ts` 退役事务清理存量安装）；执行记录见 `docs/notes/2026-11-03-retire-dsh-thread.md`。
- **后续明确延期**：审批卡与对外写操作、多 Quno 配置 UI 与跨 Quno 通知仲裁、独立 HTTP push、多设备、复杂 cron、采集器商店、自然语言编译采集器。
- **明确不做**：云端常驻/关机继续运行（产品决策，§17）。

### 16.1 dsh-thread 退役路径

决策 6（§17）：thread_handoff 的跨会话交接功能**整体不再需要**——不是用 Quno 替换其体验，不存在能力承接，也没有平价验收门槛。dsh-thread 直接退役下船：

> 执行状态（2026-11-03）：已按下列路径落地——插件目录删除、随包清单收紧、壳首启退役事务接入 `RETIRED_DESKTOP_PACKAGES`；记录见 `docs/notes/2026-11-03-retire-dsh-thread.md`。

1. **时机**：不依赖 Quno 进度，由桌面发版节奏决定；建议不晚于 Quno 首版所在 Release（避免两套「任务/交接」叙事并存）。
2. **下船**：壳首启 Profile 事务把 dsh-thread 从 web Profile 下船——改写 manifest 去依赖与 `dsh.profile.bundles` 条目、删 `node_modules` 链接、提交后删 `~/.dsh-desktop` 下解压副本。**只认桌面自己装的那一份**（依赖钉在解压目录/链接解析进该目录/只剩解析不到的 bundle 条目）；用户从 registry 或自己目录装回的副本一律保留（参照 2026-10-20 dsh-scheduled-tasks 先例）。
3. **用户数据**：存量 Thread Link 与关系数据原地保留、不删不迁移；插件下船后 UI 不再展示，数据留作只读历史。
4. **清单与发版**：revision manifest 清理 thread 版本条目（`shipped-plugins.mjs` 扫描同步）；退役当次发桌面 `v*` Release（壳随包清单变化）；`docs/notes/` 新建日期 note，`docs/plugins-catalog.md` 更新沿革。插件包与独立 tag 历史保留（插件与桌面锁步禁止，退役只是不再随包）。
5. **回退**：下船事务可经 shadow-CAS + journal 回滚；用户如有需要可随时终端 `plugin add` 自行装回 dsh-thread（桌面不会再自动安装，也不会清除用户自装副本）。

## 17. 产品决策（2026-10-23 定稿）

原开放问题七项已全部定稿，正文相应处已同步：

| # | 问题 | 决策 |
|---|---|---|
| 1 | 第一个 Quno 的职责 | **当前桌面的个人助理**（职责示例见 §1.1；首批来源建议消息 + 日历） |
| 2 | 默认通知策略 | **有意义的变化才说**（空检查不发声；「每轮汇报」仅为可选项，§10.1） |
| 3 | 紧急提前唤醒/突破安静时段 | **首版默认关闭**（按推荐；开启需用户单独允许，§8.2） |
| 4 | 关机后继续运行 | **不需要**：保持客户端启动运行即可；云端常驻移出范围（§14.2、§16） |
| 5 | 子任务产物归属 | 默认继承主对话 cwd；大产物登记为 **QunoTask 附件**（§5.4），不依赖 dsh-thread 产物机制 |
| 6 | 主对话与 thread_handoff | thread_handoff 功能**整体不需要**：主对话不挂，dsh-thread 直接退役下船（§16.1），Quno 不做能力承接、无平价验收（原「能力超集/替换」表述作废） |
| 7 | Quno 会话可见性 | **主会话与后台运行会话均不进普通侧栏会话列表或搜索**；主会话仍从 Quno 原生入口打开，后台会话从运行记录/任务卡进入（§13.2） |

## 18. 落地记录与偏差（2026-10-23）

> 本节表格记录的是 2026-10-23 一期落地；其中「分析会话 / Delivery / QunoTask」相关条目已被 2026-11-05 内核重构取代，以 §18.1 与当前代码为准。

实现不是对本文的逐字翻译，以下偏差是已验证的落地事实，后续修改以本节与代码为准：

| # | 本文原方案 | 实际落地 | 原因 |
|---|---|---|---|
| 1 | `dsh-quno` 为 preset-owned，preset YAML 行挂载 | **profile 行**（dual）+ Host 启动时 `ctx.get('agentPresets').register` 程序化注册 `quno` / `quno-task` | 浏览器半边必须挂 profile；`dsh-agent-preset` 在 profile 根不可解析，YAML preset 行无法落地 |
| 2 | `preset-snippet.yml` | 不随包；preset 由代码注册 | 同上；声明式副本会与代码漂移 |
| 3 | 统一 `quno` 服务 | `quno` + `qunoSenses` + `qunoIngress` 三个服务（**2026-11-10 已取代**：现为 `quno` + `qunoCollectors`，`qunoIngress` 删除，见 §6.9） | Sense 只拿代际化 ingress，避免接触调度/通知/存储 |
| 4 | 分析会话由 runner 直接创建 | 经 `ctx.agents.create({meta:{origin:'subagent'}})` 创建隐藏会话；读取用 `sessionQuery` | 复用官方隐藏会话语义；live `snapshotEvents` 仅测试回退 |
| 5 | 首批 Sense：建议消息 + 日历 | **日历（本地 .ics）+ RSS/Atom** | 基座没有「双向消息源」插件；订阅源与日历都是真实、可离线验证的感知面 |
| 6 | 通知频控按「已生成通知」计数 | 按**已投递/可能已投递**计数（`inbox-durable` 起） | 否则一次积压的 N 条 pending 会立刻触发小时上限，把所有通知延后 |
| 7 | deferred 投递等下一轮 | `deferred` 在 `eligible_at` 到达后重新可领取 | 否则延后事项永远不重试 |
| 8 | 回合尾反馈按钮按来源消息过滤 | 1 小时内可操作通知窗口 | turn-tail props 不暴露触发消息来源 |
| 9 | 主对话「绑定 workspace」 | `sessionController.create({cwd, agentPreset:'quno'})`，不强制挂 workspace | Quno 主对话是独立入口；warehouse 挂载由侧栏自己的 slot 承担 |
| 10 | 自定义层次压缩 Provider | 直接用 stock `compaction-basic`（本 fork 已带层次能力）+ `thresholdRatio 0.5` / `retainRatio 0.08` + command-compact + tool-result pruner | 不重复造 Provider；压缩仍是「第二道防线」，指针摘要 + `quno_recall` 兜底 |
| 11 | 侧栏经 fork `sidebar.workspaces.sessionListView` 挂 Quno 分组视图 | 该槽**不存在于任何已发布 fork**（仅以未合入 note 存在），dsh-thread/dsh-quno 的注册均 dormant，侧栏入口从未实际渲染 | §13 已于 2026-10-23 全面重写为真实槽位方案（占用 `sidebar.workspaces` + 右栏两段式注册）；更正见 `docs/notes/2026-10-23-quno-sidebar-redesign.md` |
| 12 | 「动态插件注册经门面天然压过 shipped 占位者」 | 只对**运行时插件管理器**装载路径成立；profile 启动的客户端走裸 ModuleLoader、无该 facade，single 槽注册必须显式 `priority: -1`，否则与 stock 占位者同优先级冲突抛错（实机复现并修） | 最终方案不占用主槽（#13），该教训沉淀为实机纪律；见 `docs/notes/2026-10-23-quno-sidebar-impl.md` |
| 13 | 第一版落地：占用 `sidebar.workspaces` 自绘「Quno / 会话」页签 + 精简会话列表 | 用户纠偏：新会话/插件/自动化任务应与既有会话同属 work；改为 fork zw.6 `sidebar.workspaces.alternate` 接缝，work 页签 stock 原样、Quno 独享页签，先前列键缺口（搜索/右键/拖拽）整体消失 | 产品形态以「消息对象」+「原样 work」为准；见 `docs/notes/2026-10-23-quno-work-quno-tabs.md` |
| 14 | Remote 增 `events.recent` / `tasks.list` 两方法 | 仅增 `eventsRecent`；任务列表随 `state()` 下发并扩 `plan`/`prompt` 摘要列，不再单开 `tasks.list`；任务详情的运行日志逐行 follow（`ctx.jobs`）v1 未接，以子会话入口呈现 | state() 已是全量有界快照，避免双通道漂移 |
| 15 | 铬件净化覆盖首开空态 | 标记组件双席位（`header.utilities` + `hero.options`）覆盖空态首屏；空态 composer 占位文案仍提「选择一个工作区开始」（输入功能不受影响） | 文案属基座 stock，拦截需遮蔽 composer 面，v1 接受 |

**验证**（2026-10-23，scratch `DSH_HOME`，未污染真实 `~/.dsh`）：

- `pnpm run typecheck` / `build`：`dsh-quno`（Host 6 入口 + client 225 kB）、`dsh-quno-sense-calendar`、`dsh-quno-sense-feed` 全绿。
- 测试：`dsh-quno` 78 项（契约、store/ingress、管线、真实 AgentLoop + 脚本化适配器、Sense 门禁 S01–S14、调优模拟）、日历 7 项、订阅源 7 项，全部通过。
- 实机：`dsh web` 加载 `dsh-quno` 行；`quno/state`、`ensureMain`（程序化 `quno` preset 挂载成功）、`updateConfig`、`mute`、`checkNow`、`createSense` 均经 Typert Remote 往返；两个 Sense 实例 running/healthy，日历与订阅源各产生 1 条真实事件、2 条待处理投递；SQLite 表与锁文件落在 `$DSH_HOME/quno/`；boot graph 含 `dsh-quno/client.js` 且 combo 返回 200。
- 打包形态：`pnpm pack` 产物安装进全新 scratch profile，同样能加载 Quno 行、注册两个 Sense、创建主对话。
- 主对话 preset 真实验证：向主对话发一条普通消息，会话头记录 `agentPreset: "quno"`，请求头装配出 29 个工具（含 `quno_recall`/`quno_attention`/`quno_mute`/`quno_status`/`quno_task` 与 stock 工具）、system prompt 含 Quno persona 与中文指引；回合在模型边界以 `MISSING_CREDENTIAL` 结束（该 scratch home 未配置 API key），证明 preset 行、工具装配与 `dsh-quno/preset` 均在真实运行时生效。
- 思考回合同样按设计**失败发声**（`analyzer-error`，投递保持 pending）；真实挂载演示还发现并修复了模型偶发写错 `nextReviewAt` epoch 的问题（提交校验失败后增加一次语义修正回合，78 项测试覆盖）。真实模型输出的完整闭环由 `tests/analyzer-agent.test.ts`（真实 AgentLoop + 脚本化适配器）与 `tests/pipeline.test.ts`（假分析器）覆盖。

### 18.1 2026-11-05 内核重构落地

- **领域内核**：`src/core/{model,policy,repository,intake,evals,tickets,assignments,exchanges,engine,memory-store}.ts`。Engine 是 Trigger/Thread/Eval/Decision/Ticket/Assignment/WorkerRun/Input/Subscription/Exchange 的唯一写者；命令全部在调用方事务内执行；Effect 只登记、不执行。
- **持久化**：SQLite schema v3 新增 threads/trigger_threads/thread_pending/trigger_dispositions/evals/decisions/subscriptions/tickets/assignments/worker_runs/ticket_inputs/input_attempts/exchanges/exchange_messages/effects/attention_links；events 扩为 Trigger 存储；旧 source 过滤器表改名 `source_subscriptions`；迁移把旧事件回填 Thread/pending、旧 tasks 迁移为 Ticket/Assignment（保留 task id 与 child session）、旧分析 runs 标 `legacy-analysis`，重复执行幂等。
- **宿主适配**：`src/app/{store,effects,transport,executor,worker-tools,assessor,turn-kind}.ts`。Executor 以持久主对话为 parent 创建/恢复稳定 `quno-exec-<ticketId>`；SessionTransport 以 `quno:<requestId>` 去重并在 flush 后确认；Effect runtime 按 seq/generation 拒绝陈旧执行。
- **路由与回合**：Intake 在 Sense 批次同一事务内 fan-out 并计算 followupOwners；主对话只保留 Human/Eval/Notification 三类回合，Eval/Notification 回合由 Host 工具门禁禁止记忆写入、提醒创建与领域命令。
- **旧路径删除**：`analyzer.ts`、`runner.ts`、`routing.ts`、`tasks.ts` 及其测试删除；旧 deliveries/runs/tasks 表仅保留迁移与历史只读，不再写入。
- **只读 Watchdog 与指标**：`app/watchdog.ts` 检查超时 Eval、连续失败 Effect、空闲 pending Thread 与未投递输入，只报告；`quno_status` 暴露健康摘要，`quno_recall` 的 tasks 范围覆盖 Ticket 的 Executor 会话；`app/metrics.ts` 从持久行计算批大小、Decision/Trigger 比、direct accept 占比与 Input 分段延迟。
- **验证**（`plugin/dsh-quno`）：`pnpm run typecheck`、`pnpm run build`、`pnpm test` 全绿；新增领域测试 26 项、SQLite 迁移/保留期 6 项、Effect/Transport 8 项、端到端 Eval/Report 流程 7 项、Executor 7 项、Watchdog 4 项、真实 AgentLoop Eval 回合 1 项；合计 172 项通过。
- **未在本轮验证的运行时项**（P0 接缝的实机部分）：真实桌面 `dsh web`/Electron 下的 followup/steer/inject 合批、无 live Human parent 的冷创建、后台 Shell/Subagent 占槽行为需在实机 scratch `DSH_HOME` 复验；单测已用真实 AgentLoop testkit 与结构化 stub 覆盖接口契约。

## 19. 文档沿革

- 2026-10-22 三份原始提案（主对话设计、事件流设计、Sense 契约）各自成文于 `docs/notes/`。
- 2026-10-23 合并为本文（唯一权威），对齐结论见 `docs/notes/2026-10-23-quno-dev-spec-merge.md`；此后契约变更走「同 PR 改本文」纪律。
- 2026-10-23 七项开放问题定稿（§17，决策记录见 `docs/notes/2026-10-23-quno-product-decisions.md`）。
- 2026-10-23 决策 6 **修订**：thread_handoff 功能整体不需要，dsh-thread 直接退役、无能力承接（§16.1）；当日早些时候的「能力平价替换」方案（含草稿确认形态）随之撤销（修订记录见 `docs/notes/2026-10-23-quno-thread-retirement.md`）。
- 2026-10-23 三期实现落地并验证（记录见 §18；决策与偏差见 `docs/notes/2026-10-23-quno-implementation.md`）。
- 2026-10-23 Sense 编写最小面与打包分发定稿（§6.10）；云之家群聊 Sense 设计（§6.11），消息源阻塞经 yzj-cli 路径解除（决策见 `docs/notes/2026-10-23-quno-sense-yzj.md`）。
- 2026-10-23 §6.11 按 yzj-cli 0.1.5 实测评审修订：`--limit` 上限 20 与配额按群口径、健康分类改「进程级退出码 → API errorCode」两层、`readOriginal` 诚实报 `false`、双向可见性与消息项字段降级为登录态首验项、`--jq` 支持面修正（`im group search` 不支持）、`--profile` 进 configFields（记录见 `docs/notes/2026-10-23-quno-sense-yzj-cli-contract-review.md`）。
- 2026-10-23 UI 交互改版：§13 全面重写（左栏「Quno/会话」页签、主对话铬件净化、右栏 Quno 面板、收起态胶囊、任务卡 → 面板联动），并更正「`sidebar.workspaces.sessionListView` 槽存在」的事实错误（§18 偏差 #11；方案与依据见 `docs/notes/2026-10-23-quno-sidebar-redesign.md`）。
- 2026-10-23 §13 修订：左栏页签走 fork `sidebar.workspaces.alternate` 接缝（页签条为 fork chrome，样式规格与新会话语义见 §13.2）；主对话铬件口径修订为「只去工作区与 preset 模式，模型选择器等 composer 常规件保留」（§13.3；修订记录见 `docs/notes/2026-10-23-quno-sidebar-tab-chrome.md`）。
- 2026-10-23 §13.2 二次修订：页签条提为侧栏首分区（品牌行之下、新会话/插件/自动化任务等壳行之上）——插件皮肤 CSS 几何重排（`display: contents` + `order`，`:has` 结界自门控），零 fork；同轮完成对话面皮肤与右栏/胶囊口径的实机验证。
- 2026-10-23 §13.2 三次修订：侧栏分裂为两个面板——Quno 页签下壳行（新会话按钮、插件/自动化任务行）整体退场，work 页签 stock 原样；声明权 `data-quno-side` 挂侧栏 root（alternate 挂载即写、卸载即释放），皮肤 CSS 7b 块据此隐藏，自门控口径不变。
- 2026-10-23 §13.2 四次修订（页签方案否决）：work/Quno 页签与两个面板整体回退，侧栏回归 stock；Quno 入口改为自动化任务行下的原生面板行（`main` + `sidebar.panellist` 注册，交接页挂载即打开主对话并 `selectPanel(null)` 切回对话视图）；同轮落地「连成一体，安静对话」视觉（§13.8 二次修订，实现记录见 `docs/notes/2026-10-23-quno-quiet-design.md`）。
- 2026-10-23 §6.11 实现落地：`plugin/dsh-quno-sense-yzj` 0.1.0 按本文件建成并验证（单测 16 项 + 真实 CLI 登出态 auth 路径 + 真实 `QunoSensesService` 生命周期 + scratch profile 注册），落地偏差四条（probe 只判 CLI 可用性、增量页方向自我保护、`type old` 回翻未实现、`mentionedMe` 恒 null）见 `docs/notes/2026-10-23-quno-sense-yzj-impl.md`。
- 2026-10-23 交互改版落地并按用户纠偏修订为 work/Quno 制：fork `v0.2.1-rc.2+zw.6` 增 `sidebar.workspaces.alternate` 接缝（`@crazx/dsh-client-ui-workspace`、`@crazx/dsh-cordis-client-runner` 首发于 zw.6；zw.5 因陈旧构建产物已弃用），dsh-quno 侧栏改注册接缝槽、右栏面板/收起态胶囊/任务卡联动/铬件净化全部实机验证；偏差 #12–#15，决策与实施记录见 `docs/notes/2026-10-23-quno-work-quno-tabs.md` 与 `docs/notes/2026-10-23-quno-sidebar-impl.md`。
- 2026-10-23 对话面二次修订：右栏默认收起、胶囊迁入对话框内 `conversation.input.dock`；新增 Quno 皮肤标准与代码设计（§13.8/§13.9：消息头像/会话头身份/首开欢迎块 + 不整体接管对话框的三路否决）；勘误 `conversation.empty.workspace` 死选择器（记录见 `docs/notes/2026-10-23-quno-conversation-skin.md`）。
- 2026-10-23 §13.8 头像几何二次裁定：头像改占列首行槽 0..26px（不再悬出列缘、不再与复制按钮同轴），动作行随正文缩进一个 indent，图标左缘仍与正文对齐——「头像在气泡之外、复制按钮垂直线左侧」落地（记录见 `docs/notes/2026-10-23-quno-avatar-gutter.md`）。

- 2026-10-27 交互补全：Sense 详情钻取、三栏接入向导（`shell.overlay`）、字段驱动表单与云之家最近群聊、真实 `probeSense`、按 Turn 绑定的汇报卡、关注完结分组、事件详情、任务取消与晚到防护、密钥掩码；补齐「检查点版本 / 首轮语义 / 重试 / 陈旧」文案纪律（§13.10、§13.11、§20；记录见 `docs/notes/2026-10-27-quno-interaction-completion.md`）。

## 21. 视觉对齐交互稿（2026-10-27）

按 `quno-ui-spec.html` v1.0（s01–s09）收敛 Quno 自有表面：统一渐变 Q 标（侧栏 glyph / 会话头 / 欢迎 / 面板 / 消息头像）、卡片规格（16px 圆角 + 左缘 3px 状态条 + 头部标签·主题·时间 + 正文 + 来源 chips + 动作行）、面板卡与 Sense 详情分区/kv 行、yh 登录卡、会话头右上工具区的胶囊 + 三行概要浮层、程序消息以 `exclusive` 认领避免幻影用户气泡。首开按 §13.8 融入现有 Hero 接缝（stock headline 保留），不单独接管 Hero；逐像素居中另立通用 Hero 接缝议题（2026-10-28 方案）。

**剩余 fork 项**：侧栏 Quno 行的副标题（「4 条关注 · 1 个任务进行中」）与右侧徽标需要 `SidebarPanelMetadata` 增加 `description`/`badge`/`tone` 并在 SidebarRoot 渲染；zw.7 只有 `{id, order, label}`。按运行时升级流程发 zw 层后插件侧再接。记录见 `docs/notes/2026-10-27-quno-visual-parity.md`。

## 20. 交互补全落地（2026-10-27）

按交互稿补全采集器详情、接入向导、胶囊概要、按 Turn 绑定的汇报卡、关注完结分组与任务取消。核心约束：**不重写原生侧栏、不伪造运行状态、不把视觉缺槽误判成必须接管整个对话或设置页**。

| 交互 | 落点 | 语义 |
|---|---|---|
| 采集器详情钻取 | 右栏面板（复用任务详情的「列表→详情→返回」） | 三轴状态、健康/新鲜度、能力声明、配置、缺口、暂停/恢复/停用/探测/编辑/删除 |
| 接入向导 | `shell.overlay` 三栏 Modal | 字段驱动表单 + 草稿保护 + 「已创建，正在首次同步」；不挂 `settings.onboarding` |
| 字段选项发现 | `collectorOptions` + `CollectorFactory.listOptions` | 只允许 `discover` 字段；草稿配置可发现；云之家最近群聊仅多人群聊可选 |
| 真实探测 | `probeCollector` | 不重启、不改配置版本、不推进检查点、不写健康、不报同步成功 |
| 胶囊概要 | `conversation.session.header.utilities` | 三行概要 → 带 `view` 打开右栏；外部点击/Escape/展开自动关闭 |
| 汇报卡 | `ConversationNodeDefinition` + `turnDataSource` | 绑定 `source.notificationId` 所在 Turn；历史重载可恢复；快照外按需 `noticeDetail` |
| 历史证据 | `eventDetail` | 按需、有界（8KB）；已 prune 明确标注 |
| 关注完结 | 面板 + 设置页 | resolved/dismissed/expired 分组，显示完成时间；冲突提示不覆盖新状态 |
| 任务取消 | `taskCommand({action:'cancel'})` | 先持久化意图再 dispose；晚到 settle 不改状态、不发完成通知；幂等 |
| 密钥 | `state()` 掩码为 `null` + `secretSet` | 浏览器不拿明文；编辑 `null` 表示保持，空串表示清除 |

**明确未做**（需要 fork 加法接缝或尚缺数据）：独立居中的首开欢迎画布、原生侧栏行的副标题/徽标、任务实时步骤追踪、完全只读的子会话 transcript 视图。

**验证**：`dsh-quno` 94 项测试、`dsh-quno-sense-yzj` 18 项、日历/订阅源各 7 项全绿；四包 typecheck/build 通过。决策与实施记录见 `docs/notes/2026-10-27-quno-interaction-completion.md`。
- 2026-10-27 视觉对齐：Q 标、卡片规格、面板、胶囊（会话头工具区）与去幻影气泡落地；侧栏行副标题/徽标列为 fork 项（§21；记录见 `docs/notes/2026-10-27-quno-visual-parity.md`）。
- 2026-10-28 交互方案收敛：设置只保留「配置 / 来源」；右栏扩为「动态 / 关注 / 任务 / 运行」，设置里的运行态与「立即检查」迁入右栏；胶囊回会话头工具区；首开回 Hero 接缝；证据按 readOriginal/pruned 决定可读性（记录见 `docs/notes/2026-10-28-quno-interaction-plan.md`）。
- 2026-10-29 Quno 会话可见性收敛：主会话与后台会话均从工作区树、扁平列表和搜索中过滤；fork 提供通用可注销过滤注册点，Quno 声明主 preset 过滤，直接导航与历史检索不受影响（记录见 `docs/notes/2026-10-29-quno-session-visibility.md`）。
- 2026-10-29 设置项使用盘点：移除设置页底部主对话行，主对话统一由侧栏 Quno 入口创建或打开；各项真实消费与未生效边界记录见 `docs/notes/2026-10-29-quno-settings-usage-audit.md`。
- 2026-10-29 §6.11 扩展设计 v2（待实现）：登录态验证结构化 @、私聊方向与分页；修订目录续扫、初始化、过滤分类及容量限制。方案与剩余验收门见 [登录态核验版设计](notes/2026-10-29-quno-sense-yzj-mentions-direct-design-v2.md)，保留旧稿为决策历史。
- 2026-10-30 主对话只路由：真实会话证实主 agent 在拥有 `quno_task` 的情况下仍直接执行后，主 preset 移除直接执行工具，所有实际工作强制立即委派并快速应答；`quno_task` 同时支持持久任务状态与结果查询（实证与验收见 `docs/notes/2026-10-30-quno-main-routing-only.md`）。
- 2026-11-05 内核重构：目标设计终稿见 `docs/notes/2026-11-05-quno-superagent-program-design.md`；同日按 P0–P5 落地领域内核、SQLite v3、Effect outbox、SessionTransport、只读 Executor 与 Eval Router，旧 Analyzer/Delivery/Task 写路径删除，契约收敛回本文（§2–§3、§5、§7.3、§8、§11、§14.1、§15、§18.1）。
- 2026-11-10 采集层重构：Sense/Organ（`quno.sense/v1`，插件自带定时器 + 自报健康）退役为统一 Collector 契约（`quno.collector/v2`）——Host 统一调度（单发 timer、hint 钳制、退避、fatal 停排）、`run(ctx)` 三面模型、健康由 Host 推导、`mount` 生命周期；`senses.ts` 重写为 `collectors.ts`，store v3→v4 四表 RENAME，`organ:` 端点改 `collector:`，`quno_read.organs` 改 `collectors`，插件族改名 `dsh-quno-collector-<name>`；本文 §6、§14.1、§15.3 已收敛到新契约。决策与实施见 `docs/notes/2026-11-10-quno-collector-redesign.md`。
