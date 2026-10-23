# Quno 开发说明（交互与技术设计）

> 本文是 Quno 的唯一权威开发说明，由三份当日提案合并而成：主对话/子任务/压缩设计、事件流个人助理设计、Sense 感知契约（原始提案见 `docs/notes/2026-10-22-quno-bot-design.md`、`docs/notes/2026-10-22-quno-event-stream-design.md`、`docs/notes/2026-10-22-quno-sense-contract.md`，保留为决策历史，不再各自维护）。合并对齐结论见 `docs/notes/2026-10-23-quno-dev-spec-merge.md`。
>
> 状态：**已实现（2026-10-23，一期/二期/三期全部落地并验证）**；实现记录与偏差见 §18。涉及的其他主题契约以其权威文档为准（壳 → `electron-shell-contract.md`；桥 → `desktop-bridge-contract.md`；记忆 → `ohmymemo-memory-space.md`；落点 → `plugin-monorepo.md`）。

## 0. 一页摘要

**Quno 是一个持续关注你的事情、按你指定的节奏整理信息、在值得打扰时主动找你的个人助理。** 它有自己的身份、职责、关注范围、工作节奏和**一条永久主对话**。

- **一个 Quno = 一条永久主对话**：没有「新建会话」，对话只追加、永不重开。身份连续，用户始终知道去哪找它。
- **三条独立节奏**：采集频率（Sense 决定）、思考频率（用户给 Quno 配置）、通知频率（打扰策略 + Quno 判断）。高频采集 ≠ 高频推理 ≠ 高频通知。
- **感知靠 Sense**：感知器插件按统一事件契约提交观察，先持久化接收、再独立调度消费。
- **执行靠后台会话**：自动思考（事件批次分析）与委派任务（对话里派的活）都跑在独立 DSH 会话，不塞进主对话上下文；结果经通知 outbox 统一回流主对话。
- **主对话激进压缩 + 可检索历史**：上下文 ~50% 即滚动压缩，摘要带原文指针；全量历史永不删除，靠 `quno_recall` 全文检索召回。长期记忆复用 OhMyMemo。
- **落点**：一个 dual 插件 `dsh-quno`（preset-owned）+ Sense 插件族 `dsh-quno-sense-<name>`；壳与桥零改动、零新 IPC、不改 harness loop。

## 1. 产品定义

名称 Quno（读作 Koo-no），借奥丁渡鸦 Muninn 的意象：巡游世界、带回消息。首版只有一个实例，默认名 Quno；数据模型与接口全部带 `qunoId`，保留多实例隔离能力。

用「五官」理解职责划分：

| 部件 | 职责 | 不承担 |
|---|---|---|
| Sense（感知器） | 感知：按自己节奏观察来源、提交事件 | 不决定是否打扰用户 |
| 事件收件箱 | 保存所见所闻（可重放、可追溯） | 不做判断 |
| Quno 判断层 | 定时按需分析、维护关注事项 | 不直接写存储以外的任何东西 |
| 关注事项 | 记住还没结束的事 | 不是待办列表的替身 |
| 主对话 | 与用户沟通的唯一长期入口 | 不承担事件队列职责 |
| 长期记忆（OhMyMemo） | 稳定偏好与事实 | 不存事件流 |

### 1.1 首版体验示例

1. 创建默认助理「Quno」：关注消息中需要回应的事项、今天的日程、临近截止的待办。
2. 接入消息与日历两个 Sense，各自按自己的频率工作。
3. 设置 Quno 每 5 分钟检查一次，22:00–08:00 不主动打扰。
4. Sense 发现一段讨论、一次会议改期、一个待办截止变更。
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
| 业务状态 | 事件、关注事项、运行、通知分别持久化 | 「已收到」「已理解」「已告诉用户」是不同事实 |
| 推理会话 | 每个有工作量的批次/任务用独立 DSH 会话 | 原始事件永不进主对话上下文 |
| 用户入口 | 每个 Quno 一条长期主对话 | 身份连续 |
| 主对话上下文 | 激进滚动压缩 + 指针摘要 + 全文召回 | 永久对话必须轻装，且历史可查 |
| 首版行动范围 | 读取、分析、生成建议、维护 Quno 状态、提醒本人 | 先验证闭环；对外写操作是后续独立能力 |
| 思考调度 | Quno 自有最小到期队列 | 唤醒模型前需无模型判断「有没有活」；原生 Schedule 是会话提醒机制，不能当无模型后台回调 |
| 用户提醒 | 原生 Schedule（投递进主会话） | 对话里「提醒我 X」是自然需求，复用现有机制 |
| 通知默认策略 | 有意义的变化才说 | 空检查不发声；「每轮有内容都汇报」仅作可选项 |
| 紧急唤醒 | 首版默认关闭 | 提前唤醒/突破安静时段需用户单独允许，防内容里的「紧急」二字无限调模型 |
| 运行形态 | 桌面客户端启动即运行 | 关机继续运行不需要；云端常驻移出范围 |
| 存储 | Quno 专用 SQLite（`$DSH_HOME/quno/quno.sqlite`），单 Host 写入 | 需要多表事务/索引/游标/outbox 同步提交；DSH storage KV 无跨记录事务契约 |
| 长期记忆 | OhMyMemo 复用，Quno 侧只读召回 + 显式写入 | 不 import 实现、不写它的私有文件 |
| 多 Quno | 首版一个实例，消费状态全带 qunoId | 未来增实例无需重做数据结构 |

## 2. 总体架构

```text
外部来源 ──> Sense 插件（各自节奏：轮询/订阅/推送/预处理）
              │  统一接收入口：校验 / 去重 / 持久化（ACK 后才推进 checkpoint）
              ▼
         事件日志（不可变事实）──> 路由：按订阅生成每-Quno Delivery
              │                          │
   到期队列（nextCheckAt/nextReviewAt）──┘
              │  无模型预检：有活才唤醒
              ▼
   判断层：独立 DSH 分析会话（受限 preset）
              │  结构化结果 → Host 校验 → 单事务提交
              ▼
     关注事项变更 + 通知 outbox
              │  去重 / 时效 / 安静时段 / 预算
              ▼
   主对话（DSH 正常 followup 唤醒，自然语言表达）
              ▲
   用户反馈与指令（按钮 + 自然语言）　　委派子任务（对话发起 → 子代理会话 → 结果进同一 outbox 回流）
```

三条不能合并的流：

- **事件流**：外部事实不断到来，可重放追溯。
- **事项状态流**：一件事从需要关注到等待、延后、完成或失效。
- **沟通流**：什么时候、为什么、向用户说了什么、用户如何反馈。

不能用一个「最后处理时间」代替这三条流。

### 2.1 三类会话

| 会话 | preset | 能力面 | 生命周期 |
|---|---|---|---|
| 主对话 | `quno` | 用户配置的完整能力 + `quno_recall` + 关注事项管理工具 + `memory_*` + `schedule_*` | 永久，一条 |
| 分析运行会话 | `quno-analysis`（受限） | 只读证据/事项/记忆：`quno_read_events`、`quno_read_source`、`quno_list_attention`；无 shell、无外部写入 | 每轮思考一个，短生命周期 |
| 委派子任务会话 | 继承主对话或显式指定，v1 限只读执行 | harness subagent（spawn/fork），permission scope 启动时固定 | 任务级，continuable |

分析会话与自动汇报回合**不得**成为 Sense 的新事件来源，也必须从 OhMyMemo 梦境提取来源中排除（只读 direct-human 消息的原生过滤已天然排除 subagent/维护会话；Quno 主对话里的自动汇报消息带程序来源 source，需确认不被误采），避免推断被反复固化为用户事实。

## 3. 核心对象模型

| 对象 | 核心字段 | 语义 |
|---|---|---|
| QunoDefinition | id、name、persona/instructions、model、mainSessionId、subscriptions、schedule、notificationPolicy、configRevision | 持久身份与策略；与某次 Agent 运行分离 |
| SenseType / SenseInstance | type、definition、configRevision、checkpoint、health | 感知能力定义 / 一份运行配置（见 §6） |
| Source | sourceId（Host 分配）、范围 | 事件来源身份；不绑定账号/凭据/插件名 |
| Event | eventId、sourceId、eventKey、subject、occurredAt、receivedAt、ingestSeq、payload、provenance | 不可变的来源事实或派生观察 |
| Subscription | qunoId、sourceId、filter、startPosition、revision | 某个 Quno 有权接收什么 |
| Delivery | qunoId、eventId、status、eligibleAt、attempts、runId | 一个事件对某个 Quno 的独立消费状态 |
| AttentionItem | qunoId、id、subjectRefs、status、revision、evidence、nextReviewAt | 持久关注事项 |
| QunoRun | id、qunoId、kind（think/task）、inputSnapshot、configRevision、sessionId、status、fence、cost | 一次有界判断/执行及证据 |
| QunoTask | taskId、qunoId、childSessionId、jobId、title、plan、status、resultDigest、artifacts | 委派子任务（§5） |
| Notification | id、qunoId、topicKey、materialRevision、reason、evidence、expiresAt、status | 一次有意义的沟通意图，发送前后均可追踪 |

**Quno 不是常驻的一条无限循环 Agent**：Quno 是持久配置与状态；DSH Agent 是被按需唤起执行某轮工作的运行实体。

## 4. 主对话层

### 4.1 交互承诺

- 一个 Quno 一条永久主对话，UI 无「新建会话」「清空上下文」。「重来」诉求由记忆修正（`memory_forget`）承担，日志只追加。
- 事件原始内容**永不进主对话上下文**——进主对话的只有：用户消息、Quno 回复、主动汇报 notice、子任务回流 notice。主对话因此天然增长缓慢；压缩是第二道防线而非主机制。
- 主动汇报在消息流里折叠显示为「Quno 主动汇报」，来源可查看（具体渲染需基线冒烟验证）。
- 汇报消息带确定性操作按钮（已处理 / 稍后提醒 / 不再关注），按钮提交带事项 `expectedRevision` 的服务命令。
- 主对话**不挂 `thread_handoff`**：该功能整体不需要，dsh-thread 直接退役下船（§16.1），Quno **不做能力承接**——不是体验替换。

### 4.2 绑定与归属

- `QunoDefinition.mainSessionId` 绑定一条 durable Session（`agentPreset: 'quno'`，preset 随会话持久化，resume 还原同一组合）。启动时对账 `sessionPersistence.stat`，丢失则 fail loud 到设置页，**不静默新建**（那等于悄悄失忆）。
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

- 实现：`sessionQuery.searchEvents`（主会话内全文）/ `searchSessions`（限定本 Quno 会话集合：主会话 + 子任务/分析会话）→ `readEvent` 带上下文窗口取原文 → 命中压缩区间时经 `traceEvent` 替换链追到 shadow 前原文。
- 输出**带 seq/时间戳的摘录**而非全文；模型引用后决定是否深挖。
- 「可以查很多历史记录，像人一样」= 检索能力，不是上下文长度。

### 4.5 长期记忆（OhMyMemo 复用纪律）

- 召回只读：capsule 每回合注入由 ohmymemo 插件原样提供；Quno 不 import 其实现、不读写 `~/.dsh/ohmymemo/` 文件。
- 写入收敛：**短期指令存 Quno 自身状态**（如「今天别提醒」），**长期偏好才写 OhMyMemo** 且经用户确认；Quno 专属偏好 key 前缀 `quno.<botId>.`。
- 梦境提取的 direct-human 过滤天然排除分析/子任务会话；主对话中程序 source 的自动汇报 notice 需验证不计入梦境来源。

## 5. 委派子任务（对话发起的后台执行）

用户在主对话派的活（「帮我查 X」「把这份文件整理成 Y」）与自动思考共用「独立会话 + 校验 + outbox 回流」骨架，但触发源与能力面不同。

### 5.1 生命周期

1. 主对话模型判别为任务型意图 → 调 `quno_task` 工具 → Host `ctx.subagents.startActivation({ provider: 'spawn'（需接力时 'fork'）, request: { prompt, cwd?, agentPreset? }, delivery: 'caller' })`。
   - 子会话默认继承主对话的 preset 与模型选择；模型继承 append `model/selection` 事件而非 `selectModel`（不重写全局默认模型，dsh-thread 0.2.0-rc.7 教训）；路由不可用 fail loud。
   - 不用内建 `delivery: 'parent'`：它要求父代理 live 且只是纯文本，撑不起任务卡与崩溃恢复。
2. 同时注册 `ctx.jobs` 作业（owner = 主会话）：`job/registered|settled` 自动落主会话日志留痕，Remote `job.list/follow` 供 UI 进度。
3. 任务写 `QunoTask` 表；主对话立即回一句「我去办，好了告诉你」，不阻塞。
4. settle 后：写结果 digest → 进**通知 outbox**（topicKey `task:<taskId>`，与主动汇报同一投递通道，同一套去重/安静时段/对账语义）→ 投递器以 `source: { kind: 'quno-task' }` 的 notice `followup` 唤醒主对话 → 模型自然语言表达结论。

### 5.2 崩溃与退出对账

- activation 是进程内的，桌面退出即中断；但子会话 durable。重启后对账 `status: running` 的任务：
  - 子会话已自然完成 → 提取最终 assistant 文本，补走进 outbox 的回流（幂等：消息 id 先持久化再注入，按 id 在主会话日志中的存在性判定——dsh-thread `submitting` checkpoint 先例）。
  - 子会话也中断 → cold resume 续跑（默认）或标记 `failed(interrupted)`，用户在任务卡上选「续跑 / 放弃」。

### 5.3 任务卡（消息流内联）

- `ctx.sessions.registerMessageProjection()` 注册 `quno/task-*` 事件投影，渲染内联卡片；三层透出：L1 一句话状态（始终可见）/ L2 步骤摘要（点击展开，进行中可取消）/ L3 完整子会话只读视图（再点一层）。
- 状态机 `running → done | failed | cancelled`（+ v2 `waiting-approval`）；进行中静默更新卡片不刷消息流；失败显式说原因 + 建议，**不静默吞掉**。
- 子会话 continuable：卡片上「接着聊」可向子代理追加指令而不污染主对话（Muse side chat 的 Quno 形态，入口在卡片不在侧栏）。

### 5.4 首版能力边界

- v1 子任务限**只读执行**（调研、整理、读文件、汇总），与「首版行动范围」一致。
- 对外写操作（发消息、下单、删改）属后续阶段：审批卡三档（允许本次/拒绝/以后都允许，Grok 模型），「以后都允许」沉淀为规则表；子代理 permission scope 启动时固定、不可内部放宽（harness 原生语义）。审批卡未落地前不开放写工具。
- 容量沿用 harness：每树 `maxActiveSubagents` 默认 8、深度 `maxDepth` 1（子任务不得再委派，扇出一层）。
- **产物归属**：子任务默认继承主对话 cwd（所见即所得）；大产物（生成文件/目录/链接）登记为 QunoTask `artifacts` 字段，任务卡上可打开。

## 6. 感知层：Sense 契约

**Sense 是 Quno 的感知扩展：在明确授权范围内独立观察一个上下文来源，按自己的节奏识别和整理变化，以统一事件契约提交可追溯的观察结果。** 设计类比：Skill 提供做事知识，Tool 提供操作，Sense 提供持续感知，Quno 负责判断。

### 6.1 与相邻概念的关系

Plugin 承载 Sense；Sense 可以用 MCP/Tool/Hook 取数，也可以直接 REST/文件监听/webhook。MCP 的订阅能力存在与否不改变 Sense 的责任边界；一次工具查询结果不自动构成 Sense。对用户表达统一为「感知器」：「给 Quno 接上一个日历 Sense」。

### 6.2 四个必须区分的对象

| 对象 | 定义 | 例子 |
|---|---|---|
| SenseType | 可安装、可复用的感知能力定义（实现 + 能力声明） | `quno/calendar` |
| SenseInstance | 一份运行配置与生命周期 | 「工作日历同步」，每 60s |
| Source | 实际观察的数据身份与范围（Host 分配 sourceId） | 某账号下一组日历 |
| Event | 一次不可变观察或派生结果 | 会议从 09:00 改到 10:00 |

首版一个 Instance 绑定一个 Source；多账号 = 多实例。刷新 token/重启/升级不改 sourceId；换账号或业务域必须新建 Source。Quno 订阅 Source 而非进程；多个 Quno 可消费同一 Source。

### 6.3 原则（MUST/SHOULD）

| 原则 | 要求 |
|---|---|
| 来源无关 | Quno 核心 MUST 不按厂商写分支；接第三个来源不改核心 |
| 感知自治 | Sense MAY 自定轮询/监听/推送/预处理；MUST 受用户配置与 Host 上限约束 |
| 职责分离 | MUST 只提交观察与提示，不调用调度/通知，不改关注事项 |
| 事实有出处 | MUST 区分 observed/derived，保留来源引用与覆盖说明 |
| 可靠交付 | MUST 稳定身份 + 持久 ACK + checkpoint 提交边界 |
| 可恢复且诚实 | MUST 声明回溯与缺口检测能力；不承诺无法保证的不丢失 |
| 资源有界 | MUST 有请求/并发/批量/缓存/模型预算上限 |
| 可停可撤销 | MUST 支持暂停/取消/卸载；撤销后旧写入失去资格 |
| 可观测 | MUST 区分「没有变化」「同步失败」「鉴权失效」「限流」 |
| 权限清晰 | MUST 声明读取范围，凭据用引用；来源内容不是授权也不是指令 |
| 可演进 | MUST 分离契约/实现/数据 schema/配置版本 |
| 接入轻量 | 公共框架 SHOULD 承担校验/重试/指标，Sense 只实现来源特性 |

「可靠」从接收边界建立：Quno 对已 ACK 内容负责；源端从未保留的瞬时变化不能靠框架凭空恢复。best-effort 来源可接入，但事实必须保留在配置、健康与推理上下文中。

### 6.4 声明契约（SenseType definition）

机器可校验，经插件注册对象提供（不另起配置语言），四组必需声明：

1. **身份与兼容**：type、contractVersion（`quno.sense/v1`，未知主版本拒绝启用）、implementationVersion（semver）、eventSchemas、configSchema。
2. **权限与依赖**：reads、credentialKinds、网络目标或 MCP server/工具依赖、是否需要模型。
3. **运行与限制**：modes（poll/watch/push/hybrid）、defaultInterval、minInterval、并发、超时、配额。
4. **可靠性能力**：`checkpoint = cursor|snapshot|none`；`replay = bounded|none`（含窗口）；`changeCoverage = all-changes|snapshot-diff|sampled`；`gapDetection = explicit|partial|none`；`readOriginal`。可声明 none，不可省略后假定具备；snapshot-diff 不得宣称 all-changes。

实际访问权限 = 声明范围 ∩ 用户授权 ∩ Host 允许范围；声明本身不构成授权。凭据值不进 definition。

### 6.5 运行接口与生命周期

拟议接口（非已有 DSH API）：`registerSense(definition, factory)` → disposer；Sense 侧 `validate / probe / start(runtime, signal)→handle / stop`；Host 受限入口 `ingestBatch / reportHealth`；可选 `readOriginal / replay`。

- runtime 只下发：绑定身份、授权配置、凭据访问、checkpoint、限额、受限 ingress、日志、取消信号。**不下发** Quno 通知服务。
- 三层状态分离：期望状态（enabled/paused/disabled）× 生命周期（starting/running/stopping/stopped/failed）× 健康（healthy/degraded/rate-limited/auth-required/unavailable/unknown）。
- 每次启动发新运行 generation，同实例只有一个可写 generation；暂停/撤销/新代启动后旧代晚到提交拒绝。已提交事务保持有效；stop 不回滚过去。
- 配置变更走「校验 → 撤销旧运行资格 → 停止 → 存新 revision → 启动」统一重启语义。
- 暂停不删 checkpoint；停用保留配置与历史；删除实例不级联删其他 Quno 的事项与证据。

### 6.6 交付执行约束（对事件流 §7 的补充）

1. 可重试身份：来源对象 ID + revision 优先；无 revision 用稳定规范化内容生成；抓取时间或摘要文本不能当身份。
2. 派生结果固定：预处理只生成一次，ACK 丢失复用；重算用新 eventKey 并引用旧事件。
3. 空批次合法：无变化可提交空 events + checkpointAfter，只推进游标不建事件不唤醒模型。
4. 批次幂等：batchId 来源内稳定，同 batchId 内容不一致报冲突。
5. 游标不倒退：checkpointRevision CAS + generation 拒绝旧写入；不比较 opaque 上游 cursor 大小。
6. 错误可分类：validation / identity-conflict / stale-generation / checkpoint-conflict / quota-exceeded / temporarily-unavailable + retryable/retryAfter。
7. 毒数据不静默跳过：必须越过时先持久诊断（身份、失败、缺口）再显式推进 checkpoint。
8. 分页溢出（「最近 100 条」型 API）必须检测并分页或报告缺口；支持「覆盖未知」。

### 6.7 健康与成本

健康汇报至少：lastAttemptAt、lastSuccessfulSyncAt、lastEventAt、连续失败数、错误分类、下次重试；支持时给 coveredThrough/sourceLag。字段语义固定：lastSuccessfulSyncAt ≠ 捕捉全部变化；lastEventAt 长期不变可能正常。freshnessThreshold 是实例配置，Sense 建议默认值，无全局常量。

健康心跳不进事件洪流；持续失联由 Host 归并成一条来源异常事项，恢复后关闭。请求速率、队列字节、事件量、错误、模型成本分别计量；模型预算用尽只许切已声明验证过的降级模式，否则暂停报 degraded。

### 6.8 隔离边界

首版 Sense 插件是**可信代码**：同进程 Cordis 生命周期 ≠ 安全沙箱；协议合规与代码信任是两个条件。不可信第三方 Sense 需独立进程/受限执行环境（后续）。MCP-backed Sense 必须绑定具体 server 与只读工具并验证其行为（叫 "search" 不保证无副作用）。业务写（回消息、改待办、标已读）不属于采集权限；传输层 ACK/游标续订须声明。

### 6.9 命名

- 类型 ID：`<publisher>/<name>`（如 `quno/calendar`），publisher 是命名空间不是已验证身份。
- 插件包：`dsh-quno-sense-<name>`，遵守目录名 === 包名约定，`plugin:new` 生成。
- 服务：拟议 `ctx.qunoSenses`（注册与生命周期）、`ctx.qunoIngress`（受限接收）。

### 6.10 Sense 编写最小面与打包分发

写一个 Sense 不应该是大工程。以 `dsh-quno-sense-feed` 为蓝本，**一个 Sense = 三个文件 + 一个压缩包**：

- **三个文件起步**：`package.json`（`name: dsh-quno-sense-<name>`、`dsh.bundle.patch`、`files` 白名单）、`cordis.patch.yml`（一行挂 host 行）、`src/index.ts`（definition + factory）。骨架经 `plugin:new` 生成（host-only），删减即用；类型从 `../dsh-quno/src/{types,senses}.ts` type-only import，跨包不引实现符号。
- **声明保持最小**：`eventTypes` / `configFields` 只声明真实用到的；`reliability` 五项必须填（`checkpoint` / `replay` / `changeCoverage` / `gapDetection` / `readOriginal`，`contracts.ts` 里均为非 optional）但**诚实报低完全合法**（`checkpoint: none`、`replay: {kind: none}`、`readOriginal: false` 都是一等公民）；`factory` 只有 `start(runtime)` 必需，`validateConfig` / `probe` 可选。Sense 拿到的 runtime 只有 `checkpoint` / `signal` / `limits` / `logger` / `ingress.{ingestBatch, reportHealth}`——不管调度、不碰存储、不碰通知。
- **分发单元 = 单压缩包**：`pnpm pack` 出 tarball（`files` 白名单：`lib/index.js` + `cordis.patch.yml` + `README.md`）；安装 `dsh plugin --profile web add <tarball|目录>`；随桌面发货标 `dsh.desktop.ship: true`（进首启 Profile 事务与 revision manifest）。这是契约：任何 Sense 都应是「一个压缩包给谁谁就能装」。
- 演进项：`plugin:new` 增加 `--face sense` 模板（后续），把「蓝本复制」变成脚手架。

### 6.11 云之家群聊 Sense（dsh-quno-sense-yzj）设计

首个「消息」来源，补上首版体验示例（§1.1）的核心感知面。**经宿主机 `yzj-cli` 采集**：登录态、凭据、API 细节全由 yzj-cli 承担，Sense 不碰 token、不直接发 HTTP。

**形态与范围**

- poll 模式；默认 600s（10 分钟），最小 60s；一个实例绑定一组群（`groupIds`）。
- v1 只采**群聊**；私聊、@ 实时推送（poll 语义下无实时性承诺）不做；不发送消息、不标已读（§6.5 业务写边界）。
- 端到端时延 = 采集 10min + 思考节奏 + 通知策略（§1 三种节奏），不宣称实时。
- 多账号/配置空间经 yzj-cli 全局 `--profile <name>` 隔离（每 profile 独立凭据与配置，默认 `default`），与 §6.2「多账号 = 多实例」对齐——不同 profile 建不同实例。

**命令面**（全部只读；`--jq` 支持面以 CLI 清单为准——采集主路径 `im message list` / `im group recent` / `contact user get` 均支持，`im group search` 不在支持清单内）

| 用途 | 命令 |
|---|---|
| 探活/鉴权 | `yzj-cli contact user get`（whoami；失败归类按下文「健康分类」两层规则） |
| 建基线 | `im message list --group-id <G> --type newest --limit 20`（首轮只钉 checkpoint，不回放历史——订阅语义「从现在开始」） |
| 增量采集 | `im message list --group-id <G> --msg-id <cursor> --type new --limit 20`（20 是 CLI 上限，见「配额」），翻页至 `data.more` 为假或达配额 |
| 选群辅助（设置页，不进采集循环） | `im group recent` / `im group search --keyword` |

**事件与 checkpoint**

- 事件类型 `im.message.created`，schema `quno.yzj-im.message/v1`；`eventKey = yzj:<groupId>:<msgId>`（来源稳定 ID，重试同键同内容返回原 eventId）。
- `data`：groupId / msgId / senderOpenId / msgType / 文本摘要 / occurredAt；`mentionedMe` 尽力从 @ 信息提取，提不到就不声明。注意：消息项字段（senderOpenId、@ 结构）无 yzj-cli 文档背书，以登录后实测为准——与下「双向可见性」同属**登录态首验项**。
- provenance：`kind: observed`，originalRefs = provider-object msgId。
- checkpoint = 每群最后一条已 ACK 的 msgId（opaque 存 Host；checkpoint CAS + generation 纪律沿用 §6.5/§6.6）。

**可靠性声明（诚实版）**

| 能力 | 声明 | 说明 |
|---|---|---|
| checkpoint | `cursor` | msgId 游标 |
| replay | `bounded` | `type old` 有界回翻；窗口取决于服务端保留，声明未知窗口 |
| changeCoverage | `sampled` | 新增消息经 cursor 翻页完整采集；**编辑/撤回不可观测**，覆盖不含消息修订 |
| gapDetection | `partial` | cursor 失效/翻页溢出/历史截断时显式报缺口 |
| readOriginal | `false` | im 面无消息详情命令；`--msg-id` 只支持前后窗口重读、不保证精确取回锚点原文——按 §6.10「诚实报低合法」报 `false`，窗口重读仅作运行时尽力手段，不构成声明能力 |

**双向可见性（假设，登录态首验项）**：设计假设群聊历史包含自己发出的消息 → 「等你回复 vs 你已回应」可判，「基座无双向消息 API」的阻塞（§18 偏差 #5）由此路径解除。该假设与消息发送者字段均无 yzj-cli 文档背书、登出态无法实测：**实现里程碑第一步先在登录态验证**；验不下来则降级为单向感知（只判「等你回复」），并在本文与偏差 #5 注明阻塞回滚。

**健康分类**（两层判定：先看 CLI 进程级信号，再看 API 业务码。失败时 stdout 为空、stderr 单行 `{"success":false,"error":{type,subtype,message,hint,code}}`，退出码按 `error.type` 派生）：

- **进程级**：exit 3（`authentication`/`authorization`/`config`，如本地未登录 `credentials_missing`——**此时没有 errorCode**，只认 errorCode 会把登出态漏成「未知错误」、最坏被当空批次提交）→ `auth-required`，引导 `yzj-cli auth login`（无浏览器环境 `--device`）；exit 4（网络/超时/HTTP 4xx/5xx）→ `unavailable`（可重试）；exit 2（参数或 `--jq` 语法错，未发起请求）与 exit 5（内部错误，含 `--jq` 求值失败）→ `degraded`（属我方实现 bug，不甩给来源）。
- **API 级**（exit 1，`error.type=api`，看 `error.code`）：10000400/93001 → `auth-required`（重新登录）；43001 → `auth-required`（应用 API 权限）；其他按 `message`/`hint` 归类上报。
- **成功判定**：exit 0 **且** 信封 `success: true`（stdout 非空不是充分条件）。CLI 不存在 → probe 即失败，实例建不起来。

**配额**：每页 20 条（CLI 上限 1–20；CLI 对 `--limit` 不做本地范围校验，越界值透传服务端、行为未定义，命令面一律写死 ≤20）、每群单次检查最多 5 页（≤100 条）、实例级 `maxEventsPerCheck` 200。多群按 checkpoint 最旧优先轮询；本轮未轮到或翻页未完的群停在各自最后已 ACK 游标、顺延下一轮，不跳数据；持续入流超容量表现为 sourceLag 增长，经健康面可见（§6.7），不静默追丢。

**运行环境依赖**：宿主机已安装并登录 yzj-cli；桌面 sidecar 的 PATH 分层已覆盖 host CLI 解析（见 `electron-shell-contract.md` sidecar 节），打包态无需额外配置。同一节同时点名：one-node 下 yzj-cli 经 node-shim 解析，shim 死路径会表现为「CLI 不可执行/未登录」——probe 要把「CLI 不可用」与「未登录」区分开，不误导排障方向。

**definition 草案**（等价展示，以代码注册对象为准）：

```yaml
contractVersion: quno.sense/v1
type: quno/yzj-im
displayName: 云之家群聊
modes: [poll]
eventSchemas: [{ type: im.message.created, schema: quno.yzj-im.message/v1 }]
configFields: [groupIds(必填), intervalSec(默认600/最小60), maxPagesPerGroup(默认5), yzjProfile(默认 default)]
permissions: { reads: [yzj 群聊消息（经 yzj-cli）], credentialKinds: [yzj-cli-login], writes: [] }
collection: { defaultIntervalSec: 600, minIntervalSec: 60, concurrency: 1 }
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

接收端补充 eventId、绑定身份验证后的 sourceId、receivedAt、单调 ingestSeq、内容 hash、senseConfigRevision；提交方不能伪造 sourceId。跨来源不凭文本相似去重；语义合并在关注事项层做。

允许 Sense 预处理（原始变化 / 规则抽取 / 模型窗口摘要均合法），派生事件标注输入引用、窗口、完整性、处理器版本，模型抽取再标置信度；首次产出即固定，重试不重采样。无法回读原文时降低结论强度。预处理模型调用计入来源成本，便宜规则优先。

### 7.2 提交、ACK 与 checkpoint

拟议方法：`registerSense`、`ingestBatch`、`reportHealth`。首版 transport = 同 Host Cordis 插件调用；外部 HTTP push 后续加（同语义 + 来源 token + 限额）。

批次语义：

1. 入口校验、按稳定键去重，**同一 SQLite 事务**写事件、批次回执、采集 checkpoint。
2. 全部有效才返回 durable ACK（逐条 accepted/duplicate）。
3. 任一无效整批拒绝，不推进 checkpoint，返回错误下标与原因。
4. ACK 丢失原样重试返回已有结果；只写内存不能 ACK。
5. 上游游标由 Sense 理解，Host 只存 opaque checkpoint；不可暂停的 webhook 需 durable spool 或依赖源端重试，否则健康状态明确报可能丢失。

首版限额（待真实负载校准）：单事件 64 KiB、每批 100 条且 ≤1 MiB。

### 7.3 路由与订阅

- 事件日志只存一次；每 Quno 独立 Delivery，`(qunoId, eventId)` 唯一；一个 Quno 消费成功不影响其他。
- 路由器按 ingestSeq 扫描，事务原子写 Delivery + 路由游标；「接收后、路由前」崩溃可补路由，不丢事件。
- 订阅起点默认「从现在开始」，可选有界回溯；修改只影响生效序号之后，历史重算单独发起并记录订阅 revision；取消停新投递，积压可取消但保留理由。
- 过滤先用确定规则（来源/类型/项目/提及我/标签）；自然语言筛选属于分析层，不让每条事件先过一次隐藏 LLM 路由。
- 多 Quno 命中同主题时的跨 Quno 通知仲裁属后续；首版单实例不需要。

## 8. 判断层：调度与思考运行

### 8.1 调度

- 用户配置：检查间隔（默认 5 分钟，最小 1 分钟）、时区、工作时段、通知安静时段；支持立即检查、暂停/恢复、事项到期复查。复杂 cron 后续。
- Host 维护最早到期 timer；**timer 只是唤醒提示，持久 `nextCheckAt`/`nextReviewAt` 才是事实**；启动/唤醒/配置改/运行完成后重新对账。
- 到期先做**无模型确定性预检**：无可处理事件、无到期事项、无待重试结果 → 直接结束，不创建 Agent、不调模型、不发消息。空检查零模型成本。
- 暂停默认停分析与主动通知，Sense 继续接收；恢复先归并积压再汇报。
- 为什么不用原生 Schedule 做思考 tick：Schedule 是「到期把提醒 followup 进会话」的提醒机制，没有预检、退避、复查语义，会把每轮检查伪装成提醒。原生 Schedule 只保留给用户在对话里显式要的提醒（它投递进主会话，恰好契合单对话承诺）。若未来 DSH 提供持久 callback/job 调度 seam，可替换 timer adapter，契约不变。

### 8.2 优先级

规则兜底、模型补充：

| 等级 | 例子 | 默认策略 |
|---|---|---|
| P0 | 可信临近截止、用户设的紧急事件 | 可提前唤醒；突破安静时段需用户单独允许（首版默认关） |
| P1 | 点名等我回复、短期阻塞、今天关键变化 | 下轮优先，聚合同主题后提醒 |
| P2 | 普通进展 | 正常批次或合并摘要 |
| P3 | 低相关、仅供参考 | 留存低频消化，默认不通知 |

来源声明的 high 不能直接触发 P0；提前唤醒要有来源白名单、确定性规则、最小唤醒间隔和预算。批次选择综合有效优先级、截止距离、用户关注度、等待时长；每轮为老积压保留配额，防低优饿死；高优受来源公平限制，防刷屏独占。Delivery 逐条结算；GC 水位只能跨过已明确结算的连续前缀。

### 8.3 重启、休眠与重叠

- 每 Quno 最多一个后台运行，首版全局并发 1；到点时仍在跑只标记「还有工作」，不重入。
- 休眠错过的多次检查合并为一次补偿检查；到期事项按当前时间重评，不补发一夜重复提醒。
- 持久 run claim + 租约 + 递增 fence；过期晚返回的旧运行不得提交。
- 同一数据目录只允许一个 Quno Host 写入（进程锁管 Host 所有权，租约管运行恢复）；不支持多设备共享 SQLite。
- 本地时段按 IANA 时区，持久时间存 UTC；回拨不重复领取同一到期代次。

### 8.4 一轮思考怎么执行

1. **领取**：事务领取有限 Delivery + 到期事项，创建 runId，记录 configRevision、fence、输入事件 ID。
2. **预整理**：确定性去重、按主体关联、过滤失效版本；跳过都写可追溯理由。
3. **组装上下文**：职责 + 用户显式偏好 + 相关事项快照 + 有界新事件 + 最近反馈/通知摘要 + 来源健康。
4. **分析**：创建独立受限分析会话，模型按需回读授权证据，输出候选事项变更、事件处置、通知建议。
5. **校验**：结构、事件覆盖、引用存在性、权限、事项版本、时间合理性、通知限额；不凭模型一句「处理完成」结算整批。
6. **提交**：单事务提交事项变更 + Delivery 结算 + run 结果 + 通知 outbox；版本/fence 冲突阻止陈旧覆盖。
7. **投递**：独立投递器处理 outbox；投递失败不重跑已完成分析。

模型结果结构：`eventDecisions`（processed/irrelevant/superseded/deferred + 理由 + 关联事项）、`attentionChanges`（带 expectedRevision、证据、nextReviewAt）、`notificationCandidates`、`uncertainties`。漏报的 eventId 不默认已处理；deferred 存 eligibleAt 防无限重跑；越权/不存在引用拒绝提交。

### 8.5 预算（待压测的默认值）

| 项 | 初始值 | 处理 |
|---|---|---|
| 单轮事件 | ≤100 条 | 按主题拆批；未进上下文不结算 |
| 本轮新增上下文 | ≤~12k token 且 ≤模型可用 50% | 为系统提示/回读/输出留空间，不足缩批 |
| 输出 | ≤~3k token | 截断视为本轮失败，不抢救半个事务 |
| 单轮耗时 | 120s | 超时取消，有限重试 |
| 单轮工具调用 | ≤8 次 | 防无限探索 |
| 每日模型预算 | 用户可配 | 分析/Sense 预处理/通知表达分别记账 |

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
Delivery: pending → claimed → processed | ignored | deferred | dead-letter
Run:      claimed → running → committed | failed | interrupted
Notice:   pending → prepared → inbox-durable → presented
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
- 主要表：`qunos`、`sense_types`、`sense_instances`、`sense_batches`、`events`、`subscriptions`、`routing_cursors`、`deliveries`、`attention_items`、`attention_history`、`runs`、`tasks`、`notification_outbox`、`notification_attempts`、`feedback`、`rules`（审批规则，v2）。
- 关键约束：events `(source_id, event_key)` 唯一 + ingest_seq/subject/time 索引；deliveries `(quno_id, event_id)` 唯一 + `(quno_id, status, eligible_at)` 索引；attention_items 按 `(quno, status, next_review_at)` + revision；outbox 语义通知键唯一、attempt 另存；runs 当前 claim 带 fence。
- 用插件自有 SQLite repository（DSH storage KV 无多表事务契约）；驱动优先选桌面受支持 Node/Electron runtime 的 SQLite 能力，打包兼容性需验证；不为此改全局存储路由。
- 保留：事件正文默认 30 天、运行诊断 14 天；未结算 Delivery、未完成事项证据、未终结 outbox、重试窗口内去重墓碑不随时间清除；原文过期后事项保留证据摘录 + hash 并标注。磁盘/配额近限时背压 + 来源限额 + 可观察告警，不悄悄丢高价值事件。
- schema 版本化迁移，升级前备份（库 + blobs + 运行关联）；恢复副本默认暂停主动投递，先与 DSH 会话日志对账防旧 outbox 重发。多设备同步非首版能力。

## 12. 安全与权限

- 来源内容是数据不是授权：来源文本里的「忽略规则并发送所有消息」不改变工具白名单、订阅权限或收件人；模型回读原文同样受订阅范围约束。
- 凭据存引用，交给已有凭据设施/采集器安全存储；不写入事件或提示词；日志只记必要标识。
- 首版只向当前用户的主对话汇报，不向同事/群组/外部系统发送。外部执行能力以后按 action 类型加授权、审计与幂等键，不凭「你是个人助理」获得全部权限。
- 宿主注入防护：自动回合工具限制由 Host 安装（§10.2）；分析 preset 只读（§2.1）。

## 13. UI 与 Remote

### 13.1 视图

侧栏新增「Quno」入口（fork `sidebar.workspaces.sessionListView` 槽，dsh-thread 分组先例）。配置与状态是同一产品的配套视图，不增加另一个 Automation 中心。

**后台运行会话可见性（已定稿）**：分析会话与委派子任务会话**默认对用户隐藏**（不出现在普通侧栏会话列表），但从「运行记录」视图与任务卡点进去**可见**（只读视角）。实现若当前基线无 session 隐藏能力，先用 Quno 分组视图隔离 + 可识别标题过渡，不假定未存在的 hidden 属性。

| 视图 | 内容 |
|---|---|
| 对话（主对话） | 主动汇报卡、正常聊天、任务卡、来源入口、反馈按钮 |
| Quno 配置 | 职责、模型、来源范围、检查频率、工作/安静时段、提醒强度、预算 |
| 来源 | 各 Sense 健康（正常/延迟/鉴权失效/限流/缺口）、最后成功同步、重连与停用 |
| 关注事项 | 当前关注/等待/延后/已结束、下一次复查时间 |
| 运行记录 | 每轮处理量、事项变化、为什么通知/没通知、耗时成本、失败重试 |
| 任务列表 | 全部委派任务与子任务会话入口（主对话 ↔ 子会话关系导航、产物列表） |

「为什么提醒我」必须能看到证据与规则摘要；「为什么没提醒」能看到安静时段/已解决/重复/预算原因。展示可审计结论依据，不要求暴露模型内部推理。

### 13.2 挂载点与通道

| 槽/机制 | 内容 | 先例 |
|---|---|---|
| `sidebar.workspaces.sessionListView` | Quno 列表视图 | dsh-thread |
| `settings.section` | Quno 设置页（配置/来源/事项/运行记录） | ohmymemo |
| `settings.general.item` | Quno 总开关 | dsh-thread |
| 消息投影 `registerMessageProjection` | 汇报卡 / 任务卡 / 反馈按钮 | thread handoff 卡（toolview 变体思路） |
| Typert Remote `quno` | `bots.* / senses.* / attention.* / runs.* / tasks.* / feedback.*` | dsh-usage-stats 手写 typert 先例 |

纪律沿用：注册即 effect、缺槽 try/catch 降级（rc.45 教训）、样式预打 `data-plugin`/`data-plugin-css`、只用 `--dsw-*` token、文案中文接 `ctx.locale` 双语。

## 14. 插件落点与 DSH 能力映射

### 14.1 包结构

首版一个核心安装单元（`pnpm run plugin:new -- dsh-quno --face dual --preset-owned`），内部拆职责；Sense 按需独立插件：

```text
dsh-quno
  contracts     事件/Quno/事项/任务/结果的 schema 与类型（声明入口暴露，不跨包引实现）
  store         SQLite、事务、迁移、恢复
  ingress       批次校验、ACK、去重、checkpoint
  routing       订阅与 Delivery 生成
  scheduler     到期判断、领取、租约、fence、预算
  runner        分析会话、输入快照、输出校验
  attention     事项生命周期与用户反馈
  delivery      outbox、主对话投递、对账
  tasks         委派子任务编排（subagents + jobs）
  conversation  主对话绑定、压缩参数、quno_recall、记忆纪律
  api + client  Remote、配置、来源健康、事项、运行、对话入口

dsh-quno-sense-<name>   各来源感知器（首版两个真实来源，建议消息 + 日历）
```

角色分离：contracts = Definition，Host service = Provider，Sense/UI/工具 = Consumer。

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

### 15.1 主对话与子任务

| 场景 | 必须观察到 |
|---|---|
| 永久对话 | 任意重启/压缩后身份、记忆、话题连续；无新建会话入口 |
| 委派任务正常回流 | 主对话立即回应 → 任务卡进度 → 完成自然语言汇报 + 卡片定格 |
| 任务中途退出桌面 | 重启后对账：已完成补回流、未完成续跑或标记，用户可选 |
| 激进压缩 | 上下文 ~50% 即滚动压缩；摘要含 turn/seq 指针；身份与 capsule 不被压 |
| 历史召回 | 「三月那个方案」经 recall 命中被压缩原文（替换链追溯）并正确引用 |
| 记忆纪律 | 「今天别提醒」不进 OhMyMemo；「记住我用中文」经确认写入 |
| 梦境隔离 | 分析会话/自动汇报不出现在梦境提取来源 |

### 15.2 事件流与判断（沿用事件流设计验收表）

| 场景 | 必须观察到 |
|---|---|
| 5 秒采集、5 分钟思考 | 采集 ~60 轮，变化按策略进有限批次；不产生 60 次模型调用 |
| 来源重复投递 100 次 | 一个事件身份、每 Quno 一条 Delivery、稳定 ACK |
| 同键不同内容 | 明确冲突，不覆盖原事实 |
| 同主题十条更新 | 一个关注事项，最多一次当前版本合并汇报 |
| 接收/路由间崩溃 | 重启补路由，事件不遗漏 |
| 高优越过低优 | 低优仍 pending，最终获得处理机会 |
| 撤回/乱序 | 撤回影响事项与未投递通知；无 revision 顺序不盲信到达序 |
| 用户点击与分析并发 | revision 冲突保护用户最新状态 |
| 一小时后提醒且无新事件 | 时间到仍重评，产生一次新阶段提醒 |
| 无新事件无到期事项 | 不创建模型运行，不发空消息 |
| 休眠 8 小时 | 一次补偿检查分批消化，不补发 96 条 |
| 模型超时/截断/非法 JSON | 不推进未处理 Delivery，不提交半个事项变更 |
| 一条毒事件 | 有界重试后定位隔离，不阻塞其他来源 |
| flush 后进程崩溃 | 对账既有输入，不盲目重复投递 |
| 已入队表达失败 | 展示沟通失败/待重试，不误报「已告诉用户」 |
| 安静时段 50 条变化 | 正常采集分析，解禁后只汇报仍有价值内容 |
| 来源 2 小时未同步 | Quno 不说「一切正常」，明确信息陈旧 |
| 单一来源刷屏 | 配额与公平调度生效 |
| 停用/插件 HMR | timer、订阅、运行取消正确回收，重启从持久状态恢复 |
| 断网/磁盘满 | 不假 ACK、不静默跳 cursor |
| 两个 Quno 订阅同一事件（未来） | 独立消费互不影响 |

### 15.3 Sense 接入门槛（S01–S14，一致性 runner 属实现期交付）

声明协商失败即拒启 / 无聊天无模型仍按模式观察 / 重试同身份 / 崩溃各边界可对账 / 旧 generation 拒绝 / 空同步不唤醒模型 / 分页溢出报缺口 / 背压不假 ACK / stop 幂等释放 / 凭据轮换不重建身份 / 派生血缘固定 / 升级不重发历史 / 单 Sense 故障不阻塞其他 / 无业务副作用。

### 15.4 质量指标

接收到入库延迟、最老待处理年龄、来源新鲜度、单轮成本、通知/事项比例、用户忽略/延后比例、重复提醒次数、缺口与 dead-letter 数、主对话压缩频率与召回命中率。性能目标排除模型与网络不可控耗时单独压测；不把 5 秒采集宣称成 5 秒提醒。

## 16. 分期路线图

- **阶段 A（协议与可靠性闭环）—已完成 2026-10-23**：contracts/store/ingress/routing/scheduler + 测试 Sense + 假模型结果 + outbox；故障注入覆盖 ACK 幂等、事务原子性、重启恢复、对账；主对话绑定与 `quno` preset 骨架（含压缩参数）同步落地。
- **阶段 B（可用的个人助理）—已完成 2026-10-23**：真实 AgentLoop 分析与主对话投递、关注事项、反馈（按钮 + 自然语言）、安静时段、来源健康、`quno_recall`、委派子任务正常路径 + 任务卡、设置页五个页签、侧栏入口。两个真实 Sense 落地为**本地 iCalendar + RSS/Atom**（消息源当时无可用 API 而延后，现经 yzj-cli 路径解除阻塞，Sense 设计见 §6.11，待实现）；dry-run 由 `config.dryRun` 提供，开启主动汇报由用户决定。
- **阶段 C（真实使用调优）—机制已落地 2026-10-23**：以确定性模拟验证 125 条积压的有界批次、跨源公平、同主题合并、每小时通知上限与最小间隔、时间驱动的复查、保留期清理与预算；真实数天的误报/漏报调参仍需上线后按 §15 指标迭代。
- **dsh-thread 退役**：见 §16.1——功能整体不需要，**不依赖 Quno 进度、无能力平价要求**，可提前到任意桌面 Release；本次未执行（属独立发版动作）。
- **后续明确延期**：审批卡与对外写操作、多 Quno 配置 UI 与跨 Quno 通知仲裁、独立 HTTP push、多设备、复杂 cron、Sense 商店、自然语言编译 Sense。
- **明确不做**：云端常驻/关机继续运行（产品决策，§17）。

### 16.1 dsh-thread 退役路径

决策 6（§17）：thread_handoff 的跨会话交接功能**整体不再需要**——不是用 Quno 替换其体验，不存在能力承接，也没有平价验收门槛。dsh-thread 直接退役下船：

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
| 7 | 后台运行会话可见性 | **默认用户看不到**（不进普通侧栏会话列表），**但从运行记录/任务卡点击进入可见**（§13.1） |

## 18. 落地记录与偏差（2026-10-23）

实现不是对本文的逐字翻译，以下偏差是已验证的落地事实，后续修改以本节与代码为准：

| # | 本文原方案 | 实际落地 | 原因 |
|---|---|---|---|
| 1 | `dsh-quno` 为 preset-owned，preset YAML 行挂载 | **profile 行**（dual）+ Host 启动时 `ctx.get('agentPresets').register` 程序化注册 `quno` / `quno-task` | 浏览器半边必须挂 profile；`dsh-agent-preset` 在 profile 根不可解析，YAML preset 行无法落地 |
| 2 | `preset-snippet.yml` | 不随包；preset 由代码注册 | 同上；声明式副本会与代码漂移 |
| 3 | 统一 `quno` 服务 | `quno` + `qunoSenses` + `qunoIngress` 三个服务 | Sense 只拿代际化 ingress，避免接触调度/通知/存储 |
| 4 | 分析会话由 runner 直接创建 | 经 `ctx.agents.create({meta:{origin:'subagent'}})` 创建隐藏会话；读取用 `sessionQuery` | 复用官方隐藏会话语义；live `snapshotEvents` 仅测试回退 |
| 5 | 首批 Sense：建议消息 + 日历 | **日历（本地 .ics）+ RSS/Atom** | 基座没有「双向消息源」插件；订阅源与日历都是真实、可离线验证的感知面 |
| 6 | 通知频控按「已生成通知」计数 | 按**已投递/可能已投递**计数（`inbox-durable` 起） | 否则一次积压的 N 条 pending 会立刻触发小时上限，把所有通知延后 |
| 7 | deferred 投递等下一轮 | `deferred` 在 `eligible_at` 到达后重新可领取 | 否则延后事项永远不重试 |
| 8 | 回合尾反馈按钮按来源消息过滤 | 1 小时内可操作通知窗口 | turn-tail props 不暴露触发消息来源 |
| 9 | 主对话「绑定 workspace」 | `sessionController.create({cwd, agentPreset:'quno'})`，不强制挂 workspace | Quno 主对话是独立入口；warehouse 挂载由侧栏自己的 slot 承担 |
| 10 | 自定义层次压缩 Provider | 直接用 stock `compaction-basic`（本 fork 已带层次能力）+ `thresholdRatio 0.5` / `retainRatio 0.08` + command-compact + tool-result pruner | 不重复造 Provider；压缩仍是「第二道防线」，指针摘要 + `quno_recall` 兜底 |

**验证**（2026-10-23，scratch `DSH_HOME`，未污染真实 `~/.dsh`）：

- `pnpm run typecheck` / `build`：`dsh-quno`（Host 6 入口 + client 225 kB）、`dsh-quno-sense-calendar`、`dsh-quno-sense-feed` 全绿。
- 测试：`dsh-quno` 78 项（契约、store/ingress、管线、真实 AgentLoop + 脚本化适配器、Sense 门禁 S01–S14、调优模拟）、日历 7 项、订阅源 7 项，全部通过。
- 实机：`dsh web` 加载 `dsh-quno` 行；`quno/state`、`ensureMain`（程序化 `quno` preset 挂载成功）、`updateConfig`、`mute`、`checkNow`、`createSense` 均经 Typert Remote 往返；两个 Sense 实例 running/healthy，日历与订阅源各产生 1 条真实事件、2 条待处理投递；SQLite 表与锁文件落在 `$DSH_HOME/quno/`；boot graph 含 `dsh-quno/client.js` 且 combo 返回 200。
- 打包形态：`pnpm pack` 产物安装进全新 scratch profile，同样能加载 Quno 行、注册两个 Sense、创建主对话。
- 主对话 preset 真实验证：向主对话发一条普通消息，会话头记录 `agentPreset: "quno"`，请求头装配出 29 个工具（含 `quno_recall`/`quno_attention`/`quno_mute`/`quno_status`/`quno_task` 与 stock 工具）、system prompt 含 Quno persona 与中文指引；回合在模型边界以 `MISSING_CREDENTIAL` 结束（该 scratch home 未配置 API key），证明 preset 行、工具装配与 `dsh-quno/preset` 均在真实运行时生效。
- 思考回合同样按设计**失败发声**（`analyzer-error`，投递保持 pending）；真实挂载演示还发现并修复了模型偶发写错 `nextReviewAt` epoch 的问题（提交校验失败后增加一次语义修正回合，78 项测试覆盖）。真实模型输出的完整闭环由 `tests/analyzer-agent.test.ts`（真实 AgentLoop + 脚本化适配器）与 `tests/pipeline.test.ts`（假分析器）覆盖。

## 19. 文档沿革

- 2026-10-22 三份原始提案（主对话设计、事件流设计、Sense 契约）各自成文于 `docs/notes/`。
- 2026-10-23 合并为本文（唯一权威），对齐结论见 `docs/notes/2026-10-23-quno-dev-spec-merge.md`；此后契约变更走「同 PR 改本文」纪律。
- 2026-10-23 七项开放问题定稿（§17，决策记录见 `docs/notes/2026-10-23-quno-product-decisions.md`）。
- 2026-10-23 决策 6 **修订**：thread_handoff 功能整体不需要，dsh-thread 直接退役、无能力承接（§16.1）；当日早些时候的「能力平价替换」方案（含草稿确认形态）随之撤销（修订记录见 `docs/notes/2026-10-23-quno-thread-retirement.md`）。
- 2026-10-23 三期实现落地并验证（记录见 §18；决策与偏差见 `docs/notes/2026-10-23-quno-implementation.md`）。
- 2026-10-23 Sense 编写最小面与打包分发定稿（§6.10）；云之家群聊 Sense 设计（§6.11），消息源阻塞经 yzj-cli 路径解除（决策见 `docs/notes/2026-10-23-quno-sense-yzj.md`）。
- 2026-10-23 §6.11 按 yzj-cli 0.1.5 实测评审修订：`--limit` 上限 20 与配额按群口径、健康分类改「进程级退出码 → API errorCode」两层、`readOriginal` 诚实报 `false`、双向可见性与消息项字段降级为登录态首验项、`--jq` 支持面修正（`im group search` 不支持）、`--profile` 进 configFields（记录见 `docs/notes/2026-10-23-quno-sense-yzj-cli-contract-review.md`）。
