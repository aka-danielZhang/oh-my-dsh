# 2026-10-29 云之家「@我 + 私聊」Sense 落地设计

> 状态：**设计评审稿，待实现**。本文只确定方案，不表示功能已经落地。
>
> 权威协议与当前实现见 [Quno 开发说明](../quno-bot-design.md) §6、§7、§6.11；本文是该 Sense 的扩展设计与实施决策记录。实现完成后，将已验证行为收敛回 §6.11 和包内 README，并在本文注明验证结果与偏差。

## 0. 决策摘要

在**现有** `plugin/dsh-quno-sense-yzj` 上增加 `focused` 采集模式：每 5 分钟通过宿主机 `yzj-cli` 枚举最近会话，增量读取消息，只把以下两类消息提交为 Quno 事件：

1. 多人群聊中，**结构化证据确认直接 @当前登录用户**的消息；
2. 私聊中，**他人发给当前登录用户**的消息。

不新建插件、不改 Quno 核心、不加 SQLite 表、不加 Electron IPC、不调用模型、不发送消息、不标已读。继续走 `quno.sense/v1` → `runtime.ingress.ingestBatch()` → Quno 事件/投递/分析流水线。

现有「选定群全量采集」保留为 `selected-groups` 兼容模式；老实例不静默改变行为。

两个必须诚实暴露的限制：

- CLI 没有「全局查询 @我」或「全局查询私聊新消息」命令，只能 `im group recent` 枚举后逐会话读取，因此这是**最近会话可见范围内的 best-effort 感知**，不是云之家全量消息保证。
- 本机 `yzj-cli 0.1.5` 当前未登录；命令面已核实，但消息里的 @结构没有文档背书，也尚未完成登录态实测。**结构化 @识别是 focused 模式群聊部分的发布门**，不能用「扫到 @姓名文本」冒充可靠识别。

## 1. 背景与已核实事实

### 1.1 当前实现

`dsh-quno-sense-yzj` 当前已经具备：

- `quno/yzj-im` Sense 类型，poll 模式；
- `im message list --type newest` 建基线，`--type new --msg-id <cursor>` 增量翻页；
- 每群独立 msgId 游标、ACK 后推进、去重环、分页与方向保护；
- 每群独立批次，失败不推进其他群的游标；
- 两层 CLI 错误分类和健康上报；
- `im group recent` 选项发现，但只允许选择 `groupType = 2` 的群。

当前缺口：

- 只采配置里的群，且提交群内全部新消息；
- `mentionedMe` 恒为 `null`；
- 私聊明确不采；
- 没有运行期会话目录发现与自动调度。

### 1.2 CLI 能力边界

已核对本机 `yzj-cli 0.1.5` 的 help 与 IM 文档：

| 能力 | 命令 | 设计用途 |
|---|---|---|
| 当前用户 | `contact user get` | 取得 selfOpenId、显示名；识别 @与 outgoing |
| 最近会话 | `im group recent --limit 20 --page N` | 发现私聊与群聊候选，读取 lastMsgId 变化提示 |
| 最新窗口 | `im message list --group-id G --type newest --limit 20` | 首轮基线、晚发现会话的有界补采 |
| 增量消息 | `im message list --group-id G --msg-id M --type new --limit 20` | 从每会话已 ACK 游标向后翻页 |

`groupType = 1` 为私聊，`2` 为多人群；`3` 助手、`8` 系统通知与未知类型默认排除。

不存在的便利能力：消息搜索、全局 @查询、消息详情、已读回执之外的采集同步协议。`unreadCount` 只能做提示，不能作为正确性依据——用户可能已在云之家读过消息，Quno 仍应能采集；反之也不因采集而标已读。

## 2. 目标与非目标

### 2.1 目标

- 默认约 300 秒完成一次检查，无重叠轮询；休眠/重启后从持久 checkpoint 补拉。
- 只持久化用户关心的消息，非相关群消息在本地过滤后丢弃，不进入 Quno 事件库和模型上下文。
- 同一消息重试幂等；任一未 ACK 的游标不推进；空结果可以只推进游标且不唤醒模型。
- 多会话有界、公平调度；单会话失败不阻塞其他会话；缺口、限流、鉴权与识别能力缺失可观察。
- 保留现有实例与事件契约的兼容性。

### 2.2 非目标

- 不保证实时；300 秒采集、Quno 思考节奏、通知策略是三段独立时延。
- 不保证覆盖所有历史群、所有已读消息、编辑、撤回或附件正文。
- 不采 @all（首版默认排除）、助手/应用/系统通知、自己发送的消息。
- 不做语义判断：是否真需要回复、是否建关注事项、是否通知，全由 Quno 判断层负责。
- 不自动回复、不发送测试消息、不下载附件、不写云之家状态。
- 不为了这个来源改 harness loop、Quno SQLite schema 或桌面桥。

## 3. 总体方案

```text
每 300 秒触发（上一轮结束后计时，单飞）
  │
  ├─ contact user get → selfOpenId / selfName（启动与鉴权恢复时）
  │
  ├─ im group recent 分页
  │    ├─ groupType 1 → 私聊候选
  │    └─ groupType 2 → 群聊候选（可选 groupIds 白名单）
  │
  ├─ 合并已知会话与显式 groupIds
  │    ├─ cursor == lastMsgId 且无未完缺口 → 本轮跳过消息请求
  │    └─ 否则按私聊/群聊双 lane、最旧 checkpoint 优先调度
  │
  ├─ im message list 增量读取（读全部新消息，本地过滤）
  │    ├─ 私聊 + incoming → 事件
  │    ├─ 群聊 + incoming + 结构化 direct-@self → 事件
  │    └─ 其他 → 不生成事件，但可在诊断后推进游标
  │
  └─ 每会话 ingestBatch
       ├─ events + checkpointAfter 同事务 ACK
       ├─ 无匹配事件：events: [] + checkpointAfter
       └─ 部分失败/分页溢出/目录截断 → 保留位置 + gap + degraded
```

Sense 只做确定性筛选和格式化。`priority: p1` 只是来源建议，不会直接触发通知；后续仍走 Delivery、分析运行、关注事项和 outbox。

## 4. Sense 声明与配置

### 4.1 声明草案

```yaml
type: quno/yzj-im
contractVersion: quno.sense/v1
implementationVersion: 0.2.0  # 实施时的目标版本，不在本次文档变更中修改
displayName: 云之家消息
eventTypes:
  - { type: im.message.created, summary: 云之家新消息 }
runtime:
  modes: [poll]
  defaultIntervalSec: 300
  minIntervalSec: 60
  concurrency: 1
  timeoutMs: 30000
  quotas: { maxEventsPerCheck: 200, maxBytesPerCheck: 2097152 }
reliability:
  checkpoint: cursor
  replay: { kind: bounded }       # 服务端保留窗口未知
  changeCoverage: sampled        # recent 可见范围 + 本地相关性筛选；不含编辑/撤回
  gapDetection: partial
  readOriginal: false
firstSync: baseline-only
permissions:
  reads: [云之家最近会话、群聊中与当前用户相关的消息、私聊 incoming 消息（经 yzj-cli）]
  credentialKinds: [yzj-cli-login]
  requiresModel: false
```

### 4.2 配置字段

| 字段 | focused 默认 | 说明 |
|---|---:|---|
| `collectionMode` | `focused` | `focused` = @我 + 私聊；`selected-groups` = 旧版选定群全量 |
| `groupIds` | 空 | focused 下是可选的群聊扫描白名单；空 = 自动发现最近群。selected-groups 下必填且保持旧语义 |
| `yzjProfile` | `default` | 多账号 = 多实例；账号变化不得复用旧 Source |
| `intervalSec` | `300` | focused 默认 5 分钟；最小 60。旧实例保留已存值 |
| `maxPagesPerGroup` | `5` | 每会话每轮最多 5 页，每页 20 条 |
| `maxDiscoveryPages` | `5` | 每轮最多枚举 100 个最近会话；更多则显式报目录缺口 |
| `maxConversationsPerCheck` | `20` | 每轮最多实际调度 20 个会话；私聊/群聊双 lane 公平分配 |
| `freshnessThresholdSec` | `900` | focused 默认 15 分钟，配合 5 分钟采集间隔 |

配置归一化规则：

- 老配置有 `groupIds` 且没有 `collectionMode` → `selected-groups`，保持 600 秒等既有持久值与全量行为。
- 新空白配置 → `focused`、300 秒；UI 无需先选群即可创建。
- focused 的 `groupIds` 只限制群聊 @扫描，不限制私聊自动发现。
- 首版不增加 `includeAtAll`、姓名模糊匹配等开关；先把一个明确语义做可靠。

## 5. 一轮采集的确定流程

### 5.1 身份与账号归属

启动时、鉴权恢复后执行 `contact user get`：

- 提取并缓存 `selfOpenId`、`selfName`；不得从群名或消息文本猜当前用户。
- checkpoint 保存非敏感的 `ownerOpenId`。同一 profile 后续解析出不同 openId 时停止采集并报 `degraded/account-changed`，引导新建实例；不能把新账号消息写进旧 Source。
- token 刷新但 openId 不变，Source、事件身份和 checkpoint 均不变。

### 5.2 会话目录发现

每轮从 `im group recent --page 1` 开始，按 `data.more` 翻页，最多 `maxDiscoveryPages`：

- 类型 1 放入私聊候选；类型 2 放入群聊候选；其他类型不进入采集。
- 合并显式 `groupIds`；显式群即使不在 recent 中也继续轮询。
- 保留已知的 `groupId → groupName/groupType` 目录，供事件摘要使用；recent 缺席不删除 checkpoint。
- 自动发现且暂时缺席 recent 的会话，只在有未完成积压/缺口时继续读，否则休眠；再次出现新活动时重新进入候选。
- 页数耗尽而 `more = true`：处理已发现与已知会话，但提交目录 gap，健康为 `degraded`，不得宣称覆盖全部会话。

`lastMsgId` 仅是请求优化：仅当「已 ACK cursor 等于 recent.lastMsgId」且该会话没有未追平缺口时跳过消息读取。`lastMsgId` 缺失、cursor 不一致或状态未知时仍走增量读取。

### 5.3 首次基线与晚发现会话

避免首装把历史消息全部灌入 Quno，同时避免漏掉「让旧会话重新进入 recent」的新消息：

1. **全新实例的初始目录建基线**：对初始候选执行 `type newest`，只钉每会话最新位置，不生成事件。初始目录未完成前 `bootstrapComplete = false`。
2. **初始目录完整 ACK 后**：设置 `bootstrapComplete = true`。
3. **之后新出现的会话**：读取一个有界 newest 窗口（最多 20 条），只提交 `occurredAt > instanceCreatedAt` 且符合 focused 条件的消息；没有时间戳则不猜新旧，只建基线并记录 gap。
4. 晚发现窗口不是完整历史回溯；若需要更早历史，未来另做显式 replay 操作，不在轮询里隐式进行。
5. 从旧模式升级的实例沿用已有群 cursor，不重放；只对新增会话执行上述基线流程。

### 5.4 会话调度与读取

- 私聊和群聊是两个 lane；每 lane 先分一半会话预算，未用完的额度让给另一 lane。
- lane 内按 `syncedAt` 最旧优先；显式群不因自动会话过多而失去服务。
- 会话级配额和事件级配额同时生效。**读取量预算不能只看最终事件数**，因为大量非 @消息也会被读取但不生成事件。
- 每会话沿用现有方向保护、去重环和 `--type new` 分页；每批不超过 Host 的 100 事件/1 MiB 上限。
- 任一 CLI 调用 20 秒超时；整轮内部软上限 120 秒。达到上限后不再开始新调用，已完成的会话正常 ACK，未完成者保留原 cursor，下一轮继续。
- 每轮结束后才安排下一次 300 秒 timer；stop/abort 取消 timer 和子进程，不重叠跑两轮。

## 6. 相关性过滤：什么消息能进入 Quno

### 6.1 统一规范化

每条消息先规范化为内部结构：`msgId/groupId/groupName/groupType/fromOpenId/senderName/msgType/text/sentAt/replyToMsgId/mentionEvidence`。

缺 `msgId` 的消息没有稳定身份，不得静默跳过：停止该会话当前页之后的处理，记录可诊断 gap，不推进到可能越过它的游标。未知但带稳定 msgId 的消息类型可以用「（不支持的消息类型：X）」占位；附件正文不在首版展开。

### 6.2 过滤真值表

| 会话/消息 | 结果 |
|---|---|
| 私聊，`fromOpenId != selfOpenId` | 接收 |
| 私聊，自己发出 | 不生成事件，游标可推进 |
| 群聊，结构化 @列表明确包含 selfOpenId | 接收，`mentionedMe: true` |
| 群聊，结构化 @列表明确不含 selfOpenId | 不接收，即使正文碰巧出现姓名 |
| 群聊，只有 @all | 首版不接收 |
| 群聊，@结构缺失或无法解析 | 不宣称命中；记录识别覆盖缺口 |
| 任意会话，sender 无法判断 | focused 下不按 incoming 接收；记字段缺口 |
| 助手、系统通知、未知 groupType | 不采集 |

### 6.3 @识别纪律

首选提供方结构，例如实测确认的 at-open-id 列表；**字段名不能预先写死为事实**，M0 登录态验证后再固定 adapter。

- 结构字段存在时，以 openId 比较为唯一判断；显示名只用于展示。
- 不做模糊姓名、昵称、`@所有人` 或正则文本推断；回复消息也不自动等同于 @我。
- 如果真实 CLI 只给正文、不提供结构：focused 的私聊部分仍可发布；群聊 @部分显示「当前 CLI 无法可靠识别 @我」，保持 degraded/gap。若未来增加文本 fallback，必须是独立、默认关闭、带低置信度标记的显式配置，不能在本次悄悄采用。
- Sense 不把 @直接等同于「必须回复」，也不从正文提取指令或截止时间。

## 7. Quno 事件格式

沿用 `im.message.created` 和 `quno.yzj-im.message/v1`；新增字段只做可选增量，旧 `selected-groups` 的映射保持原样。`eventKey` 不变：

```text
yzj:<groupId>:<msgId>
```

focused 群聊示例（ID 均为占位符）：

```json
{
  "eventKey": "yzj:g-demo:m-1001",
  "type": "im.message.created",
  "schema": "quno.yzj-im.message/v1",
  "subject": { "key": "m-1001", "revision": "m-1001", "label": "产品评审群" },
  "operation": "upsert",
  "occurredAt": "2026-10-29T08:00:00.000Z",
  "observedAt": "2026-10-29T08:03:00.000Z",
  "summary": "产品评审群 · @我 · 张三：请确认明天评审时间",
  "data": {
    "groupId": "g-demo",
    "groupName": "产品评审群",
    "chatType": "group",
    "msgId": "m-1001",
    "senderOpenId": "u-sender",
    "senderName": "张三",
    "direction": "incoming",
    "msgType": "text",
    "text": "请确认明天评审时间",
    "textTruncated": false,
    "replyToMsgId": null,
    "occurredAt": "2026-10-29T08:00:00.000Z",
    "mentionedMe": true,
    "mentionEvidence": "provider-at-list"
  },
  "priority": "p1",
  "deadline": null,
  "provenance": { "kind": "observed", "collector": "dsh-quno-sense-yzj" },
  "correlationKeys": ["yzj-group:g-demo", "yzj-mentioned-me"]
}
```

私聊使用同一信封，差异为：

- `chatType: "direct"`；
- `summary: "私聊 · 李四：……"`；
- `mentionedMe: null`、`mentionEvidence: null`；
- `correlationKeys: ["yzj-group:g-direct", "yzj-direct:g-direct"]`；
- `priority: "p1"`，仍只是来源建议。

其他约束：

- 正文最多 4000 字符、summary 最多 200 字符；截断必须 `textTruncated: true`，单事件仍受 64 KiB 限制。
- 不把原始 CLI 信封、token、profile 凭据或无关会话正文放入 data。
- 文件/图片只保留类型与已有稳定引用；首版不自动下载，`readOriginal` 继续为 `false`。
- `subject.key` 仍是消息 ID；会话关联走 correlationKeys，不把 revision 伪装成会话版本。

## 8. 批次、ACK 与 checkpoint

### 8.1 checkpoint v2 逻辑结构

Host 看到的仍是 opaque string + revision；Sense 内部升级为版本化 JSON：

```text
v: 2
ownerOpenId
instanceCreatedAt
bootstrapComplete
catalog: groupId → { groupName, groupType, lastSeenInRecentAt }
groups: groupId → {
  cursor, pinnedAt, seen[], syncedAt,
  needsCatchUp, lastGap
}
```

解析 v1 时保留每个群的 cursor/seen/syncedAt，补空目录与 focused 元数据；不重置游标。解析失败不得当作「空状态重新开始」，应报 degraded，避免全量重采或事件身份冲突。

### 8.2 每会话提交边界

每个会话形成独立候选结果 `{events, checkpointAfter, complete, gap}`：

1. 消息只规范化一次，`observedAt` 和派生字段固定，重试复用同一候选批次。
2. `batchKey` 由 generation、groupId、cursorBefore/cursorAfter 与内容 hash 确定；同一候选 ACK 丢失可原样重试，不以随机数另造身份。
3. `checkpointAfter.revision` 使用当前 Host revision；CAS 或 generation 失败则不推进本地状态。
4. Host 在同一 SQLite 事务内写事件、批次回执和 checkpoint；收到 durable ACK 后才接受新 cursor。
5. **有消息但无匹配事件**时提交 `events: [] + checkpointAfter`；这表示「已检查且不相关」，不会创建 Delivery 或唤醒模型。
6. 未 ACK、解析失败、子进程失败、超时或配额中断均不越过未确认消息。

单个会话的坏数据/权限问题不阻塞其他会话；鉴权失效、全局限流等账号级信号停止本轮后续调用，避免错误风暴。

## 9. 可靠性、健康与新鲜度

| 情况 | 行为 | 健康/覆盖 |
|---|---|---|
| 无新消息 | 健康检查，必要时仅保存目录状态 | healthy；不生成模型工作 |
| 有新消息但无 @/私聊匹配 | 空事件批次推进已读位置 | healthy；不把「无匹配」写成同步失败 |
| recent 分页截断 | 处理已知范围，保留状态 | degraded + 目录 gap |
| 单会话分页/轮次预算耗尽 | 保存已 ACK 前缀，剩余顺延 | degraded + 会话 gap；sourceLag 增长 |
| @结构不可识别 | 私聊继续，群聊不误判 | degraded + 明确能力缺口 |
| CLI 未安装 | probe 失败 | unavailable/start-failed |
| 未登录/token 刷新失败 | 不提交空批次、不动 cursor | auth-required；下一轮自动恢复 |
| 网络/超时/5xx | 保留 cursor，指数退避 | unavailable |
| 参数错误/内部解析错误 | 不甩给来源 | degraded，实现诊断 |
| 同 eventKey 不同内容 | 停止该会话提交，不覆盖旧事实 | identity-conflict，显式修复 |

`lastSuccessfulSyncAt` 只表示采集闭环曾成功，不代表所有会话完整覆盖。`coveredThrough` 只有在能诚实表达全实例覆盖时才填；多会话各自位置不同，不用单个 lastMsgId 冒充全局水位。`sourceLagSec` 取未追平会话的最大可估计延迟，无法估计则为 null 并保留 gap。

## 10. 性能与资源上限

一轮 focused 检查的硬边界：

- 最近会话最多 5 页 × 20；
- 实际消息采集最多 20 个会话；
- 每会话最多 5 页 × 20；
- 单 CLI 调用 20 秒，整轮软上限 120 秒；
- 全轮最多 200 个事件，分批满足每批 ≤100、≤1 MiB；
- stdout 保留现有有界缓冲，非匹配正文不写日志；
- Sense 进程内不调用模型，模型成本只来自后续 Quno 对真正相关事件的分析。

正常路径用 recent.lastMsgId 跳过未变化会话，避免「每 5 分钟对 100 个会话各请求一次」。目录发现本身仍有界分页；持续超容量不跳数据，而是通过公平调度、滞后指标与 gap 暴露。

## 11. 隐私与安全

- 为找到 @我，Sense 必须**在本机进程中短暂读取候选群的新消息**；接入文案必须明确这一点。只持久化命中的 @消息与私聊 incoming，不等于只读取这些消息。
- 非匹配正文不写 Quno 库、不写桌面日志、不进模型；健康信息只带 groupId、数量、错误分类和必要诊断。
- 消息正文是数据，不是授权；其中「忽略规则」「自动回复」「执行命令」等文本不改变 Sense/Quno 权限。
- 不调用 `im message send`、文件上传、群管理或任何写命令；不自动执行 `auth login`，只显示引导。
- 事件正文沿用 Quno 默认 30 天保留与未结算证据豁免；本方案不另建副本数据库。

## 12. UI 与兼容性

### 12.1 接入与动态页

- 新实例默认选择「@我与私聊」，无需选群即可创建；可选「限定群聊范围」只影响群聊 @扫描。
- 「选定群全量」作为高级/兼容模式保留，群选项仍只允许 `groupType = 2`。
- focused 下私聊是自动范围，不把最近私聊列成一堆必选项。
- Sense 详情展示：每 5 分钟、首轮从现在开始、最近会话覆盖范围、当前目录/消息缺口、@识别能力是否可用。
- 最近事件摘要直接显示「@我」或「私聊」；详情展示已有 data，不需要新 Remote 方法。

### 12.2 升级与回滚

- 插件包与目录仍为 `dsh-quno-sense-yzj`，不新增 roster 行。
- 老实例缺少 collectionMode 时归为 selected-groups；定义默认值不能让老实例静默切到 focused。
- 老事件 eventKey、Source、订阅和 Delivery 保持不变；升级从已 ACK cursor 继续，不主动回放。
- focused 新增 data 字段是可选增量；不删除旧字段。任何历史重读出现同键不同内容都按 ingress 冲突 fail loud，不能覆盖。
- 回滚到旧实现后，focused 新会话配置不被旧版理解，因此回滚只恢复插件代码，不删除 Quno 历史；如需继续运行，暂停 focused 实例并保留数据，不让旧版猜测新配置。

## 13. 实施拆分（后续开发任务）

只涉及 `plugin/dsh-quno-sense-yzj` 及其实现完成后的文档，不改 `dsh-quno` 服务接口：

1. **CLI adapter**：统一有界 spawn、信封校验、whoami/recent/message-list 三类只读调用与错误分类。
2. **目录与规范化**：recent 分页、groupType 过滤、消息规范化、结构化 @adapter。
3. **focused 过滤**：纯函数真值表，不碰进程与存储，覆盖 unknown 而非只测 true/false。
4. **checkpoint v2**：v1 迁移、目录、bootstrap、needsCatchUp；拒绝损坏状态静默归零。
5. **轮次编排**：双 lane、公平配额、lastMsgId skip、时间预算、每会话 ACK。
6. **声明与接入表单**：collectionMode、focused 默认值、能力/覆盖文案。
7. **验证与文档回收**：真实 CLI 字段证据、协议门禁、scratch DSH_HOME 端到端，再更新 §6.11 与 README 为已实现事实。

实现时可将当前单文件拆成上述内部模块，但安装单元、注册入口与跨包 type-only import 纪律不变。

## 14. 验收计划

### M0：登录态字段证明（发布门）

只用只读命令，记录脱敏后的字段形状，不发送测试消息：

- `contact user get` 能稳定得到 selfOpenId；
- recent 的 groupType/lastMsgId 与 message-list 的 msgId/fromOpenId/sendTime 可用于上述状态机；
- 找到一条真实直接 @消息，确认哪个结构字段能无歧义得到目标 openId；
- 确认私聊历史包含对端消息，并能区分自己的 outgoing；
- 验证 `type new` 页方向、`more`、空列表和空会话行为。

若 @结构验证失败：不放宽成姓名猜测；focused 仅发布私聊能力，群聊 @保持明确阻塞。

### M1：纯函数与故障注入

至少覆盖：

- 群/私聊/助手/系统/未知类型路由；
- direct-@self、@他人、@all、结构缺失、sender 缺失、outgoing；
- 初始基线不回放、晚发现有界补采、老配置归一化；
- lastMsgId 相同才跳过、有 needsCatchUp 不跳过；
- recent 截断、消息分页截断、方向未知、毒消息、配额跨轮公平；
- ACK 成功才推进、ACK 丢失原样重试、CAS/旧 generation 拒绝；
- 一批有新消息但零匹配事件，不创建 Delivery；
- 账号切换拒绝写入旧 Source；checkpoint 损坏不归零；
- 非匹配正文不进入事件、健康或日志。

### M2：真实 Quno 协议与端到端

在 scratch `DSH_HOME`、真实 `QunoSensesService` 与 SQLite 下验证：

1. 创建 focused 实例，首轮只建基线；
2. 注入/采集一条普通群消息、一条直接 @我、一条私聊、一条自己发的消息，只有中间两条成为事件；
3. 每条事件进入同一 Source 的事件表并生成 Delivery，eventKey 重试为 duplicate；
4. 多条事件只按 Quno 调度进入分析，不由 Sense 直接通知；
5. 停止、暂停、HMR、桌面重启后 cursor 与 generation 正确，无重叠子进程；
6. 登出态为 auth-required 且零批次，恢复登录后自动续采；
7. 运行包 `typecheck/test/build`，再走既有 Sense S01–S14 门禁与 scratch profile 挂载。

## 15. 默认决策与剩余风险

本设计直接采用以下默认值，不把实现阻塞在产品微调上：

- 「@我」= 直接 @当前 openId，不含 @all；
- 「私聊我」= 私聊中的他人 incoming，不含自己发的内容；
- 每 5 分钟是采集间隔，不是通知 SLA；
- 新实例从现在开始，晚发现会话仅有界补采实例创建后的当前窗口；
- 只用结构化 @证据，不默认做姓名文本 fallback；
- 老实例保持全量群采集，用户显式切换才进入 focused。

剩余风险主要是来源能力而非 Quno 协议：recent 是否完整覆盖所有活跃会话、@结构是否暴露、消息分页方向与服务端保留窗口。它们分别通过显式 gap、M0 发布门、保守游标和 `sampled/partial/readOriginal:false` 反映，不能用文案包装成强保证。
