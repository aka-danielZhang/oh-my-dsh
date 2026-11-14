# 2026-11-13 Quno 结构化 CLI 能力层与结果回流修复

> 状态：**已实施**（本 PR）。方案要点来自用户 2026-11-13 提出的「Sense Scheduler / Worker Capability Broker / Result Delivery 三系统」提案；本文记录采纳范围、对提案的四处调整、实现落点与验收。契约口径已同步进 [`docs/quno-bot-design.md`](../quno-bot-design.md)（§5.4、§6.11、§8.3、§10.3、§14.2、§15.1）。按笔记纪律，2026-11-08 的 organ 方案与实施记录不改写；本文只补充二者之上的同步能力面与回流正确性。

## 1. 结论：三系统里一个已经存在、两个真缺

提案把系统拆成 Sense Scheduler / Worker Capability Broker / Result Delivery 三块。对照代码后：

| 提案系统 | 现状 | 本次动作 |
|---|---|---|
| 采集调度（定时采集、游标、Trigger） | **已经存在**：`collectors.ts` 生命周期（`run(ctx)` 由 Host 调度）+ 2s 有界 pass + 持久 Effect outbox；`checkpoint-entries/v1`、运行代际、健康三轴均已落地 | 不重建。仅明确「暂停只停采集，不停能力」的边界 |
| Worker Capability Broker | **真缺**：Worker 只有异步 `quno_exchange`；本地短查询被迫走「发起 → 等输入 → 再回合」，且模型无从发现结构化能力 | 新增 Host 服务 `qunoCli`（`CliCapabilityBroker`）+ Worker 工具 `quno_cli_call` + yzj 能力 provider |
| Result Delivery | **半缺**：成功回流已在，**失败/超时没有可靠送达**（Router 侧失败被静默吞掉；过期没有任何请求方输入） | 修复终态语义：失败原因持久化 + 请求方必被唤醒；不可投递时 Effect 重试而不是完成 |

提案的核心判断成立：**本地、短时间的只读 CLI 查询不该走异步 Exchange。** 同步 tool call/result 天然配对，Worker 能在同一回合整理结果；Exchange 保留给真正异步/远端的器官读取。这与既有设计的分工一致——`Skill` 提供做事知识、`Tool` 提供操作、`Sense` 提供持续感知（§6.1），结构化只读 CLI 属于「Tool 提供操作」，不需要发明新的器官协议。

## 2. 对提案的判断与调整

1. **不新增第三张「结果投递」表，也不引入 `pending → inbox-durable → presented` 三态。**
   Effect 行本身就是 pending 记录；`SessionTransport` 的稳定 messageId + `locate()`（先查持久会话日志、再查 live inbox）+ flush 屏障已经给出「durable 才算送达、失败就抛错重试」的完整语义。再加一张投递表就是第二个事实源，会在崩溃重放时互相打架。`presented`（对应回合已有完整回复并 flush）在设计里只对**通知 outbox** 有意义（§10.2），结果 relay 是直接应答，不承诺也不假装这个状态——文档写明「delivered-and-durable」是本层诚实终态。
2. **Mandate 授权按「accept 时的能力快照」记录，不改 Router 的 Decision schema。**
   `Mandate.cli = { capabilities, operations }` 在 `directAccept` / `evalDecide accept` 写入，值为当时已注册且**至少有一个已配置 target** 的只读能力与只读 operation。晚注册的能力不会被旧 Ticket 静默继承；旧 Ticket（无 `cli` 字段）一律不授权。这样无需给 `quno_eval_decide` 增加字段，也不把「授权」这一 Host 事实交给模型自报。
3. **target 可由模型按 id 选择，但 profile/argv/凭据永不由模型提供。**
   提案说「profile 由宿主配置提供，模型不能指定」，这条完全保留：provider 从 Sense 实例配置里读 `yzjProfile`，payload 里出现 `profile`/`argv` 一律以「未知参数」拒绝。多账号时模型必须按 `quno_read.cliCapabilities.targets[].id` 指定账号——那是**资源选择**（与既有 `organ:<instanceId>` 端点身份同构），不是凭据选择；凭据始终只在 yzj-cli 里。
4. **第三阶段（长 CLI 任务的持久 Job ID）不在本次范围。**
   同步能力的语义就是「本轮有界、超时即失败」；把它伪装成可恢复的长任务会把 WorkerRun 的生命周期和进程生命周期绑错。长任务的正确形态是持久 Job + 结果协议，需要独立设计（见 §6）。

### 2.1 两处实现口径的取舍

- **参数用声明式 `CliParamSpec`，不引入 JSON Schema 运行时。** 提案里的 `inputSchema` 如果照搬，会同时出现「schema 校验」与「provider 自己的 argv 校验」两套真相。现在 operation 声明 `{ name, kind, min, max, maxChars }`，broker 用同一份声明做运行期校验**并**投影成 `quno_read.cliCapabilities` 里的工具描述——只有一处定义。
- **yzj 的 organ 面仍保留一份「运行实例 → profile」表。** 它是**运行代际**索引（`start` 注册、`stop` 注销、随 Sense 生命周期回收），不是跨生命周期的全局注册表；organ 契约（`handleRequest(request)`）没有配置通道，profile 只能从运行配置里拿。同名模式在能力面被彻底消除：target 由 broker 从实例配置解析。

### 2.2 行为边界：采集暂停 ≠ 能力撤销

- **`quno_exchange`（异步器官面）**：随 Sense 运行代际存活。实例暂停/停止即不再应答（`instance-not-running`），因为它是「运行中采集器」的读取面。
- **`quno_cli_call`（结构化同步面）**：随**配置**存活。target 来自该类型下 `desiredState != disabled` 的实例，所以暂停中的账号仍可被显式授权的 Worker 查询；禁用或删除实例才撤销。凭据本就属于 yzj-cli，与调度无关。
- 两个面的健康分工：Sense 健康（healthy/degraded/auth-required…）描述采集；`quno_read.cliCapabilities` 的 target 带 `health`，但**不能用采集态推断按需查询一定不可用**。

## 3. 实现落点

### 3.1 能力层（`plugin/dsh-quno/src/cli-broker.ts`）

```ts
CliCapabilityProvider {
  capability, title, senseType,
  operations: Record<op, { access: 'read' | 'command', params: CliParamSpec[] }>,
  timeoutMs?, maxConcurrent?, maxOutputChars?,
  execute(request) => { ok: true, data } | { ok: false, code, message, retryable? }
}
```

`CliCapabilityBroker` 在**任何进程启动之前**强制：能力已注册 → operation 在闭表内 → `access === 'read'` → Mandate 快照授权 → target 解析（0 个：配置指引；多个：要求显式 target；disabled：不可见）→ 参数校验（未知键拒绝、越界拒绝而非裁剪）→ 并发上限 → 截止时间（**broker 自己 race，不信任 provider 自觉**）→ 输出上限。可执行文件与 argv 由 provider 生成，全程不经 shell。注册走 Cordis effect：插件卸载即撤能力；同一 capability 二次声明直接报错而不是静默覆盖。

拒绝原因自描述且可指导：`unknown-capability` 附现有能力目录，`unknown-operation` 附该能力只读操作清单，`ambiguous-target`/`unknown-target` 附 `id（label）`，`invalid-params` 附合法参数与上限，`not-authorized` 指向「让主对话重新委派」。

### 3.2 Worker 面（`plugin/dsh-quno/src/app/worker-tools.ts`）

- 新工具 `quno_cli_call { capability, operation, params?, target? }`，结果在同一回合返回；`WORKER_TOOL_NAMES` 同步加名，`quno-task` guard 因此放行**工具名**，真正授权在 broker 内。
- `quno_read` 输出新增 `cliCapabilities`（capability / title / targets / 每个 operation 的参数声明）——能用的东西必须能被发现，否则 2026-11-08 的「模型乱猜端点」会重演。
- `WORKER_BOUNDARY` 增加一条：本地只读查询用 `quno_cli_call`，名字只能来自 `quno_read.cliCapabilities`，绝不把排队/被拒说成查询成功；`quno_exchange` 只留给真正异步/远端。
- 主对话 preset 仍未挂任何 CLI 工具（`quno_exchange` 保留为单次证据补读，§7.2 定稿不变）。

### 3.3 yzj provider（`plugin/dsh-quno-collector-yzj/src/{organ,capability}.ts`）

- `runYzjOperation()` 成为**唯一执行路径**：Organ 异步面与 `quno_cli_call` 同步面共用 argv 构造、`classifyRun` 分类与 `takeToken` 每 profile 共享预算（按需查询与轮询同一桶，不单设配额）。
- `handleOrganRequest` 保留为兼容适配层（运行实例注册表、`instance-not-running` 语义不变），内部改调同一函数，删除重复的执行/分类代码。
- `capability.ts` 声明三个只读 op（`im.group.recent` / `im.group.search` / `im.message.list`），参数上限直接引用 `ORGAN_BOUNDS`，所以工具声明与运行期校验不可能对不上；输出在条数上限之外再接受 `maxOutputChars` 预算，裁掉的部分以 `truncated: true` 如实标注。
- 插件 `apply` 里注册能力（可选服务 `ctx.get('qunoCli')`，缺失时 warn 且不阻塞 Sense）。

### 3.4 结果回流（`core/engine.ts`、`app/assessor.ts`）

- `failExchange` 终态：把 `{ outcome, reason, responder }` 写成 `exchange_messages.kind = 'error'` 的持久证据（同 `(exchange, kind, hash)` 幂等），再按请求方唤醒——Ticket 请求方得到 `TicketInput`（「异步读取失败/超时：<原因>」），Router 请求方得到 `router-relay` Effect。
- `expireExchanges` 与失败走同一个 `settleExchangeFailure`：**过期是终态而不是静默状态变化**。晚到的响应仍只作证据，不产生第二次唤醒。
- `assessor.relayExchange` 从「只认 responded」改为「读终态证据」：responded/consumed → 结果；failed/expired → 失败/超时（确定性渲染，重放同文本 → 稳定 messageId 去重）；仍未终态 → 抛 `EffectRetryError` 让 Effect 保留重试，**绝不静默完成**；cancelled 明确返回 obsolete。
- `assessor.relayReport`：开放 Ticket 但尚无 Report 时同样抛错重试；只有 Ticket 已结束才是 obsolete。
- relay 一律 `queue` 而不是 `steer`：结果是对用户/路由的**直接应答**，不打断 Router 正在进行的回合，也不受安静时段与「只有主动通知才发」的策略抑制（安静时段只约束通知 outbox，§10.1）。

## 4. 兼容与迁移

- `Mandate.cli` 为可选字段，`tickets.mandate_json` 原样 JSON 往返，无需 schema 迁移；旧 Ticket 读回为 `undefined` → broker 判 `not-authorized`（诚实：它们从未授权过）。
- `boundOrganList` 新增可选第三参，旧调用行为不变。
- `exchange_messages.id` 为 `quno:exchange:<id>:error`，插入冲突键是 `(exchange_id, kind, content_hash)`；同一 Exchange 只会有一个终态，重放安全。

## 5. 验收

| 层 | 结果 |
|---|---|
| `dsh-quno` node:test | **219** 全绿（合并 collector 线后；新增 `cli-broker.test.ts` 17 条、`exchange-outcome.test.ts` 6 条，过期用例按新语义改写） |
| `dsh-quno-collector-yzj` node:test | **66** 全绿（新增 `capability.test.ts` 7 条：声明面、profile 来源、参数拒绝、失败分类、共享预算、输出上限、apply 注册） |
| Scripted 链路评测 | 21 通过 + 8 blocked → **25 通过 + 9 blocked，0 fail**；新增四条 P0：`cli-capability-read`（暂停中的实例仍被查询；真实子进程 → 同回合结果 → report → 主对话只汇报一次）、`cli-capability-refuse`（带 `profile` 的 payload 被拒且**零进程**，纠正参数后成功）、`cli-capability-failure`（鉴权失败 → 工具错误 → report blocked + question → 主对话只汇报一次且不称成功）、`exchange-failure-relay`（Exchange 终态失败回流一次） |
| 安全边界 | 越界/未知参数、写 operation、未授权 capability、disabled target 均在进程启动前拒绝；`quno-task` 仍无 `bash`，preset 断言不变 |

**未完成（不冒充已通过）**：`live-third-party-tool-unavailable`、`third-party-cli-live-read` 仍为 blocked，需要真实模型 + 生产 profile 的云之家实例；`pnpm run plugins:check` 全树与发版留待提交后按 runbook 执行。

## 6. 后续

1. **长任务阶段**：CLI 调用超过同步上限（或需要跨重启）时走持久 Job：`cli-job` Effect kind + Job 结果写入同一结果协议（error/response 消息 + 请求方唤醒），Worker 用 `quno_cli_call` 的 `jobId` 分支恢复。设计前提是「进度可查、结果只投一次」。
2. **能力面扩展**：`gh` / `ot` 等 CLI 按同一 provider 契约接入；`access: 'command'` 的写操作需要独立的审批卡与审计，不在只读 Worker 里放开。
3. **发版**：`dsh-quno` 与 `dsh-quno-collector-yzj` 各自独立插件 tag，不与桌面锁步（壳/IPC/打包未动）。
