# Quno Sense：感知扩展的定义、规则与接入标准

日期：2026-10-22

状态：设计提案，未实现。配套总设计：[Quno 事件流个人助理](2026-10-22-quno-event-stream-design.md)。

本提案将总设计中的“采集器”正式命名为 **Sense（感知器）**。本文是 Sense 的术语、扩展接口及接入规则的评审依据；总设计继续负责事件信封、消费、关注事项和通知机制。与总设计中的暂定采集器名称或接口冲突时，以本文为准；其余事件处理语义不变。

## 1. 正式定义

**Sense 是 Quno 的感知扩展：它在明确授权的范围内，独立观察一个上下文来源，按自己的节奏识别和整理变化，再以统一事件契约向 Quno 提交可追溯的观察结果。**

它不依赖用户先发一句话，也不依赖 Quno 的模型主动调用。它可以轮询、监听、接收推送，也可以自主聚合和预处理。运行前必须启用并获得来源授权；“自主”不表示可以自行扩大权限。

对用户的表达是：“给 Quno 接上一个日历 Sense”“这个 Sense 每分钟检查一次”“暂停消息 Sense”。UI 首次出现显示“感知器（Sense）”，日常以“感知器”呈现，不再创造额外缩写。

设计类比：Skill 提供做事知识，Tool 提供操作，Sense 提供持续感知；Quno 负责结合用户偏好作出判断。

## 2. 与 MCP、Hook、Skill、Plugin 的关系

这些概念不在同一抽象层，不能把它们视为几个互斥的安装格式。

| 概念 | 解决的问题 | 通常由谁触发 | 与 Sense 的关系 |
|---|---|---|---|
| MCP | 如何用统一协议访问工具、资源和提示等外部能力 | 客户端调用；部分能力支持订阅和通知 | Sense 可以用 MCP 读取消息或订阅资源；MCP 本身不规定 Quno 的事件、去重和 checkpoint 语义 |
| Tool | 某项操作如何被调用并返回结果 | Agent 或授权程序 | Sense 可以调用只读工具取数；返回一次查询结果不自动构成 Sense |
| Hook | 某个已定义生命周期节点发生时如何介入 | 宿主在对应节点触发 | Sense 可以用 Hook 捕捉变化；Hook 不天然提供独立采集周期或可靠事件交付 |
| Skill | 某类工作应遵循什么知识、方法和流程 | Agent 按需加载 | 可指导事件预处理或如何编写 Sense；单独一份提示词不能保证运行、去重与恢复 |
| Plugin | 功能如何安装、注册并跟随宿主生命周期运行 | 插件加载器 | 首版 Sense 用 DSH 插件承载；一个插件可以注册一个或多个 Sense 类型 |
| Sense | 怎样持续把外部变化变成可靠、可理解的输入 | 自己的采集策略或来源推送 | Quno 新增的感知能力契约，与具体取数方式无关 |

例如：日历 Sense 在 DSH 插件中启动，每分钟通过 MCP 的只读日历工具读取变化，进行 diff，然后提交 `calendar.event.updated`。这是“Plugin 承载 Sense，Sense 使用 MCP”，无需另起一套工具协议。

Sense 也可以完全不用 MCP：直接调用 REST API、监听文件或处理 webhook 均合法。MCP 的订阅能力存在与否，不改变 Sense 的责任边界。

## 3. 四个必须区分的对象

| 对象 | 定义 | 日历例子 |
|---|---|---|
| SenseType | 可安装、可复用的感知能力定义，包含实现和能力声明 | `quno/calendar` |
| SenseInstance | 该类型的一份运行配置与生命周期 | “工作日历同步”，配置每 60 秒运行 |
| Source | 实际观察的数据身份与范围，是事件来源身份 | 某账号下的一组明确日历 |
| Event | 一次不可变的观察或派生结果 | 某会议从 09:00 改到 10:00 |

首版一个 SenseInstance 绑定一个 Source；一个 Source 可以包含多个已声明子范围，如多个日历 ID。未来一个包支持多个账号时，创建多个实例，不把账号切换隐藏在一个实例里。

`sourceId` 由 Host 分配，不能直接用邮箱、凭据或插件名充当身份。刷新 token、重启、升级包不改变 sourceId；切换到另一个账号或业务数据域必须创建新 Source。普通过滤/频率修改形成新的 configRevision；若改变底层观察范围，要声明生效边界及重新建立基线的策略。

Quno 订阅 Source，而不是某个进程。多个 Quno 可以消费同一个 Source，无需重复轮询同一个账号。

## 4. 规范必须满足的原则

MUST 表示接入必需条件；SHOULD 表示推荐条件，偏离时须声明理由；MAY 表示可选能力。原则要能落实为验证项，不能只写成口号。

| 原则 | 规范要求 | 判断是否满足 |
|---|---|---|
| **来源无关** | Quno 核心 MUST 不根据厂商名称编写分支；来源特有逻辑由 Sense 负责 | 接入第三个来源无需修改核心处理流程 |
| **感知自治** | Sense MAY 自定轮询、监听、推送及预处理；MUST 受用户配置和 Host 上限约束 | 5 秒采集可以与 5 分钟思考独立运行 |
| **职责分离** | Sense MUST 只提交观察与提示，不直接调用 Quno 调度或通知本人 | Sense 无权创建 Quno 汇报或改变关注事项 |
| **事实有出处** | MUST 区分 observed / derived，保留来源引用与覆盖说明 | 每条重要结论可定位证据；未知不伪装成完整 |
| **可靠交付** | MUST 使用稳定身份、持久 ACK 和 checkpoint 提交边界 | ACK 丢失、重启和重复投递不造成重复业务事件 |
| **可恢复且诚实** | MUST 声明回溯与缺口检测能力，不得承诺无法保证的不丢失 | 不可回补的来源恢复后标记覆盖不确定 |
| **资源有界** | MUST 有请求、并发、批量、缓存和可选模型预算 | 来源刷屏或模型异常不会无限占内存或花费 |
| **可停可撤销** | MUST 支持暂停、取消和卸载，撤销运行资格后不再接收旧写入 | 暂停/HMR/账号撤销后，无僵尸轮询和越权晚到提交 |
| **可观测** | MUST 区分没有变化、没有同步成功、鉴权失效和限流 | 无事件时仍能判断来源是否新鲜 |
| **权限清晰** | MUST 声明来源范围和读取能力，凭据用引用 | 来源内容不能扩大权限或成为执行指令 |
| **可演进** | MUST 分离契约、实现、数据 schema 与配置版本 | 升级实现不把所有历史信息误认成新事件 |
| **接入轻量** | 公共框架 SHOULD 承担通用校验、重试与指标；Sense 只实现来源特性 | 不需要为每个来源重写数据库、通知系统与完整恢复逻辑 |

“可靠”从接收边界开始建立：Quno 对已 ACK 的内容负责；源端从未保留的瞬时变化，不能靠框架凭空恢复。允许 best-effort 来源接入，但必须在配置、健康状态和推理上下文中保留这一事实。

## 5. 自由度与硬边界

### Sense 自己决定

- 获取方式：poll、watch、push，或声明为 hybrid。
- 采集间隔、退避、聚合窗口和业务过滤规则。
- 提交原始变化、结构化事实，还是带血缘的语义摘要。
- 在来源能力允许时回读原文、补拉历史或重建快照。

Host 根据用户策略设置上限：Sense 可以自调到更慢的频率；更频繁的访问、扩大范围、启用额外模型成本不得超过已授予额度。

### Sense 必须交给 Quno 决定

- 事件对哪个 Quno 有效，什么时候触发推理。
- 事件是否意味着一条关注事项，以及是否该更新它。
- 是否通知、何时通知、通知谁、如何遵守安静时段。
- 用户反馈是否改变长期偏好，是否允许外部行动。

来源的 priority 或 deadline 是建议，不是绕过 Host 策略的命令。

### 首版不属于 Sense 的动作

回复消息、替用户确认会议、修改业务待办、自动标记消息已读等业务写入不属于采集权限。传输层 ACK 或游标续订可以是交付协议的一部分，但必须声明，不能以“读取附带效果”为由默许业务状态修改。

## 6. 声明契约：安装前就知道它能做什么

每个 SenseType 提供一份机器可校验的 definition。它是能力声明，不是 Skill Markdown，也不代替 DSH 的包 manifest。首版建议通过插件注册对象提供；下列 YAML 只是等价展示，不要求实现额外配置文件加载器。

```yaml
contractVersion: quno.sense/v1
type: quno/calendar
implementationVersion: 0.1.0
displayName: 日历感知器
description: 观察授权日历中的日程变化
modes: [poll]
eventSchemas:
  - type: calendar.event.updated
    schema: quno.calendar-change/v1
configSchemaRef: quno.calendar-config/v1
permissions:
  reads: [calendar.events]
  credentialKinds: [calendar-oauth]
  writes: []
collection:
  defaultIntervalSeconds: 60
  minIntervalSeconds: 5
  maxConcurrentRequests: 1
processing:
  mode: deterministic
  modelUse: none
capabilities:
  checkpoint: cursor
  replay: bounded
  replayWindowSeconds: 604800
  readOriginal: true
  changeCoverage: snapshot-diff
  gapDetection: partial
```

这是一个假设来源支持七天补拉的示例，具体实现必须按真实 API 能力填写，不能照抄承诺。

必需声明分为四组：

1. **身份与兼容性**：type、contractVersion、implementationVersion、eventSchemas、configSchema。
2. **权限与依赖**：读取对象、账号/范围配置、凭据类型、网络目标或 MCP 服务/工具依赖；是否需要模型。
3. **运行与限制**：mode、建议频率、最小频率、并发、超时、资源配额；poll/watch/push 按模式校验必需项。
4. **可靠性能力**：checkpoint、replay、changeCoverage、gapDetection、原文回读能力。可声明 none，但不能省略后假定具备。

推荐 capability 枚举：`checkpoint = cursor | snapshot | none`；`replay = bounded | none`；`changeCoverage = all-changes | snapshot-diff | sampled`；`gapDetection = explicit | partial | none`。all-changes 只能用于上游确有可验证完整变化日志的情况。

凭据值不放进 definition；实例绑定凭据引用与实际授权 scope。实际访问权限是“声明范围 ∩ 用户授权 ∩ Host 允许范围”，声明本身不构成授权。

原总设计中的 `registerCollector` 改为拟议的 `registerSense`；`CollectorInstance` 改为 `SenseInstance`；`collectorConfigRevision` 改为 `senseConfigRevision`。事件身份仍用 sourceId，不能把来源身份与感知器实现绑定。

## 7. 运行接口与生命周期

以下是新增接口的语义提案，不是已有 DSH API，也不要求每个 Sense 都实现一整套同名方法。

| 接口 | 负责方 | 责任 |
|---|---|---|
| registerSense(definition, factory) | Sense 插件 → Host | 注册类型，返回卸载 disposer |
| validate(config) | Sense | 无业务写入地检查配置格式；不能擅自启动采集 |
| probe(binding, signal) | Sense | 有界检查凭据、能力及范围；返回健康诊断，不将测试结果伪装业务事件 |
| start(runtime, signal) → handle | Sense | 从 Host 提供的 checkpoint 和授权启动，建立采集循环或订阅 |
| ingestBatch(batch) | Sense → Host 受限入口 | 提交事件并等待 durable ACK；沿用总设计的批次事务语义 |
| reportHealth(status) | Sense → Host | 汇报采集状态、覆盖、延迟和缺口 |
| stop(reason) | 运行 handle | 幂等释放 timer、watcher、网络订阅和自有任务 |
| readOriginal(ref, signal) | Sense，可选 | 在当前授权内回读证据；返回版本/时间与不可用原因 |
| replay(range, signal) | Sense，可选 | 有界补拉；仍经同一个 ingress 交付，不旁路去重 |

runtime 只提供绑定的身份、授权配置、凭据访问、checkpoint、限额、受限 ingress、日志和取消信号；不得把 Quno 通知服务作为感知器的默认能力下发。

Host 管理生命周期和约束，Sense 管理来源循环：poll 由 Sense 的驱动按其策略轮询；watch/push 不再额外启动一个通用轮询。公共 helper 可以实现循环、退避和取消，但不能在两个层面各启动一套 timer。

运行期望状态与健康状态分开：

- **期望状态**：enabled / paused / disabled，表示用户是否希望它工作。
- **生命周期**：starting / running / stopping / stopped / failed，表示进程资源是否已建立。
- **健康状态**：healthy / degraded / rate-limited / auth-required / unavailable / unknown，表示获取信息是否正常。

暂停不删 checkpoint；恢复从原位置续接。停用保留配置和历史，释放运行资源。删除实例需明确数据保留选择，不级联删除其他 Quno 的事项或历史证据。

Host 为每次启动发放新的运行 generation，同一实例只能有一个有写入资格的 generation。暂停、取消授权、卸载或新一代启动后，旧 generation 的晚到提交拒绝。已经提交成功的事务保持有效；之后未获 ACK 的数据恢复时重试，不能宣称 stop 能回滚过去。

配置变更按“校验 → 撤销旧运行资格 → 停止 → 保存新 revision → 启动”执行；失败保持可观察的 stopped/failed，不暗中用旧权限继续工作。无权限变化的小型调参以后可以优化热更新，首版优先使用统一重启语义。

## 8. 事件与交付规则的补充

事件字段、ACK 和批量限额的唯一规范仍是[总设计 §5.2–§5.4](2026-10-22-quno-event-stream-design.md#52-事件信封-v1)。本文增加 Sense 特有的执行约束：

1. **可重试身份**：原始对象的来源 ID + revision/变更 ID 优先；无 revision 时用稳定规范化内容与明确变更语义生成。仅用抓取时间或摘要文本不能代表稳定事件身份。
2. **无原始变更 ID 的限制**：快照 diff 可以识别两次成功观察之间的变化，不能保证捕捉其间“变更后又还原”的状态。必须声明 snapshot-diff，不能宣称 all-changes。
3. **派生结果固定**：预处理只生成一次待提交结果，ACK 丢失时复用；变更处理器后要重算时，使用新的派生事件身份并关联旧结果，不能以同键不同内容覆盖。
4. **空批次合法**：成功同步但无变化时，可提交空 events + checkpointAfter；该事务只推进同步位置并记录回执，不创建业务事件或唤醒模型。没有新 checkpoint 时，仅报告成功同步即可。
5. **批次幂等**：batchId 在来源内稳定；相同 batchId 的内容及 checkpoint 必须一致，否则报冲突。回执与身份记录的保留至少覆盖声明的重试/重放窗口。
6. **游标不可倒退**：同来源有 checkpoint 的提交串行；Host 通过 checkpointRevision 的 CAS 和运行 generation 拒绝旧写入，不尝试比较 opaque 上游 cursor 的大小。push 无游标的实例仍受运行资格和去重约束。
7. **错误可分类**：返回 validation、identity-conflict、stale-generation、checkpoint-conflict、quota-exceeded、temporarily-unavailable 等稳定错误及 retryable/retryAfter。确定性非法输入不无限重试。
8. **不能悄悄跳过毒数据**：如必须越过不可解析的源记录，先通过持久诊断通道保存该记录的身份、失败和覆盖缺口；再显式推进 checkpoint。不可解析正文不必成为业务事件，但缺口不能只写在易失日志里。

如果来源每次只返回“最近 100 条”，Sense 必须检测可能溢出并分页或报告缺口；成功发出一次请求不等于完整同步。协议应支持报告“覆盖未知”，不强迫适配器编造精确缺失条数。

## 9. 健康、覆盖与成本

健康汇报至少包含：lastAttemptAt、lastSuccessfulSyncAt、lastEventAt、连续失败数、当前错误分类、下次重试时间；支持上游覆盖水位时再给 coveredThrough / sourceLag。字段含义固定：

- lastSuccessfulSyncAt：一次同步成功结束，不代表捕捉了全部历史变化。
- lastEventAt：最后产生变化的时间，长期不变可能完全正常。
- coveredThrough：来源能证明已覆盖到的位置/时间，未知时明确空缺。
- health：结合成功同步时效与模式判断，不能只看最后一个事件多久以前。

poll 来源应定期成功同步；无事件的 watch/push 来源通过连接状态、续订或声明的 liveness probe 判断可用性。仅证明进程活着的心跳不能证明上游订阅仍有效。freshnessThreshold 是实例配置，默认值由 Sense 建议，不设一个适用于所有来源的全局常量。

已知 gap、best-effort 标记与来源健康通过独立元数据通道进入 Quno 的下一轮上下文。原始健康心跳不进入事件洪流；真正持续失联可由 Host 归并成一条来源异常事项，恢复后关闭。

请求速率、队列字节数、事件量、错误与模型成本分别计量。模型预处理用尽预算后，只有已声明且验证过的降级模式才允许切换，例如带 processingMode 的原始事件输出；否则暂停该路径并报告 degraded，不偷偷换成不同语义的数据。

## 10. 版本、兼容性与命名

| 版本 | 影响什么 | 规则 |
|---|---|---|
| contractVersion | Sense 与 Host 的接口语义 | `quno.sense/v1`；未知主版本拒绝启用 |
| implementationVersion | 某 Sense 代码实现 | semver；一般升级不改变 sourceId 或原始事件身份 |
| event schema | 来源 payload 的结构与含义 | 独立版本；不兼容变更新主版本，保留旧事件解读路径 |
| configRevision | 一次实例配置 | Host 分配；事件和运行记录可追踪实际配置 |
| processorVersion | 派生处理规则/模型提示 | 用于血缘与显式重算；不能用包升级自动重发所有历史 |

未知 Sense 契约版本拒绝启用；未声明的事件类型/schema 拒绝接收，不能 ACK 后才发现不可读。已声明且通过验证、但不属于通用内置业务类型的事件，可以作为带来源说明的 data 进入通用分析，Quno 核心不应硬编码厂商类型白名单。

schema 注册采用受限的声明式验证描述；冲突的同名同版本定义拒绝注册，禁止上传任意代码作为 schema validator。支持的 schema 方言和复杂度限制在 SDK 实现前固定并进入一致性测试。

命名分层：

- 产品概念：**Quno Sense / 感知器**。
- 类型 ID：`<publisher>/<name>`，如 `quno/calendar`；publisher 是命名空间，不是已验证的发布者身份，实际信任由安装的包来源决定。
- 插件包：未加 scope 的 `dsh-quno-sense-<name>`，如 `dsh-quno-sense-calendar`，遵守本仓目录名等于包名的约定。
- 实例显示名：用户可编辑，如“我的工作日历”；身份 ID 不随显示名变化。
- 服务：拟议 `ctx.qunoSenses` 负责注册与实例生命周期，`ctx.qunoIngress` 负责受限接收；不引入独立缩写协议名。

## 11. DSH 中的落点与隔离边界

Sense 是 DSH 插件提供的一种能力契约，不替换 DSH Plugin、Tool 或 Skill 系统。新增插件仍通过 `plugin:new` 生成；插件用 Cordis service 注册 Sense，相关 disposer、timer 与监听随 fiber 回收。

首版原生插件必须是可信代码：同进程 Cordis 生命周期隔离不等于安全沙箱。即使 runtime 只下发受限接口，恶意 Node 插件仍可能绕过它访问宿主资源。协议合规与代码信任是两项条件，不能把 manifest 权限声明宣传为强制隔离。

首版只接受用户明确安装的可信原生 Sense。以后接入不可信第三方代码时，需要独立进程/受限执行环境和代理化网络、凭据访问；单独设计隔离能力。外部 HTTP push 可作为另一种 transport，必须认证并绑定 sourceId，也不自动获得执行代码的资格。

MCP-backed Sense 必须绑定具体 server、只读工具/资源和实际运行宿主的权限。MCP 工具叫“search”不保证无副作用；接入者必须验证其行为。Quno 模型能够临时使用某个 MCP，也不代表后台 Sense 已获长期授权。

## 12. 接入验收门槛

一个“能调用 API 的脚本”只有满足以下条件，才算可接入的 Sense。SDK 可提供 conformance runner；下表是未来实现必须通过的行为测试，当前文档未实现该 runner。

| 编号 | 必测条件 | 通过标准 |
|---|---|---|
| S01 | 声明、配置与能力协商 | 错误配置、未知契约版本、schema 冲突在启用前失败 |
| S02 | 独立采集 | 没有用户聊天、没有模型运行时仍按模式观察来源 |
| S03 | 重复与 ACK 丢失 | 同事件及同 batch 重试返回同一身份，不重复产生 Delivery |
| S04 | 崩溃恢复 | 接收前/接收后/checkpoint 提交边界故障均可对账，不跳数据 |
| S05 | 运行代次与游标 | 旧 generation 或旧 checkpointRevision 的提交被拒绝 |
| S06 | 空结果与健康 | 空同步推进合法 checkpoint，但不触发模型；来源失效不报告 healthy |
| S07 | 来源完整性 | 分页溢出、断线、回溯超窗按能力补拉或报告 gap/未知覆盖 |
| S08 | 资源与背压 | 队列/磁盘/配额满时不假 ACK、不无限缓存；可观察地退避或暂停 |
| S09 | 停止与卸载 | 重复 stop 幂等，timer/watch/任务释放，晚到写入失去资格 |
| S10 | 权限与账号隔离 | 凭据轮换不重建来源身份；账号更换不复用身份；越权回读失败 |
| S11 | 预处理血缘 | 派生结果保留输入、覆盖和版本，重试不重新采样覆盖原身份 |
| S12 | 版本升级 | 实现升级不重复发送历史；payload 变更显式版本化 |
| S13 | 故障独立性 | 某个 Sense 鉴权失效或出错不阻塞其他 Sense；共享资源受配额控制 |
| S14 | 业务副作用边界 | 不发送消息、不自动标已读、不改关注事项，不旁路通知策略 |

涉及 readOriginal、replay、模型预处理的测试按声明能力增加；none 能力不要求伪造支持，但必须通过相应降级与缺口展示测试。同进程插件无法防御恶意阻塞，S13 是可信实现的正常故障隔离验收，不是对恶意代码的安全保证。

## 13. 首版交付尺度

首版需要：Sense definition schema、类型注册/实例生命周期、与现有 ingress 的绑定、健康与覆盖状态、公共取消/退避 helper、一致性测试夹具，以及两个真实 Sense。

首版不需要：新的 MCP 替代协议、Sense 商店、独立配置语言、自动生成任意采集代码、多进程调度平台或复杂依赖图。先做到第三个 Sense 可以按同一规则接入，而不修改 Quno 核心。

成立条件是：**实现自治、边界统一；事实可追溯、交付可恢复；资源可约束、运行可停止；能力不夸大、失败不伪装成安静。**
