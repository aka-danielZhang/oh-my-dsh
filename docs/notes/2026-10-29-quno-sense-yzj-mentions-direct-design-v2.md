# 2026-10-29 云之家「@我 + 私聊」Sense 落地设计 v2：登录态核验版

> 状态：**设计评审稿，待实现**。2026-10-29 使用已登录的 `yzj-cli 0.1.8` 完成只读抽样验证；不是实现完成或全场景认证。
>
> 本文修订并取代 [v1 设计稿](2026-10-29-quno-sense-yzj-mentions-direct-design.md) 的后续实施方案；旧稿保留为决策历史，不回写。当前已实现行为仍以 [Quno 开发说明](../quno-bot-design.md) §6.11 与 [插件 README](../../plugin/dsh-quno-collector-yzj/README.md) 为准。实施后把已验证行为收敛回权威文档。

## 1. 结论与修订范围

在现有 `dsh-quno-sense-yzj` / `quno/yzj-im` 上新增 `focused` 模式，默认每轮完成后等待 300 秒，只提交：

1. 多人群中，他人发送且 `param.desc[]` 存在 `{type: "at", data: selfOpenId}` 的直接 @消息；
2. `groupType = 1` 私聊中，`fromOpenId` 明确存在且不同于当前用户的消息。

**真实结构化 @证据已找到，群聊 @不再因“尚未登录、字段未知”而阻塞设计。** 私聊方向、分页续读和空页也已抽样验证。仍须完成自动化测试、故障注入及 scratch 环境端到端，才能发布。

| v1 假设或缺口 | v2 决策 |
|---|---|
| CLI 0.1.5，当前未登录 | 本次实际为 0.1.8，`whoami` 成功；不读取或保存凭据 |
| @字段待确定 | 固定消息读取 adapter：`param.desc[].type === "at"`，`data` 精确匹配 selfOpenId |
| 没有消息搜索 | 已有 `im message search --notify-to-open-id`，但必须带关键词；只作诊断，不作完整采集源 |
| 每轮永远枚举前 5 页 | 首页面向新活动，剩余额度跨轮续扫目录，避免固定前缀饥饿 |
| 整个初始目录完成才结束 bootstrap | 改为持久化启用时间 + 每会话独立初始化；目录过大不能阻止已初始化会话采集 |
| @结构缺失一律 degraded | 普通消息 `param:null` / `desc:[]` 是正常非命中；畸形结构与已知不支持的相关性结构才报缺口 |
| 运行时直接解析无时区时间 | 显式按来源时区 `Asia/Shanghai` 解释，禁止依赖宿主机本地时区 |
| 无界 catalog / seen 环 | checkpoint 有 200,000 字符硬限制；采用字节预算、目录容量和显式降级 |

保留 `selected-groups` 兼容模式，老实例仍采选定群全部新消息。复用 `quno.sense/v1 → ingestBatch → Delivery → 分析运行`，不改 Quno 核心、SQLite 表或 Electron IPC。Sense 不调用模型、不发送消息、不标已读、不下载附件。

## 2. 本次验证证据与边界

### 2.1 方法

只使用 `yzj-cli`：help、`whoami`、`im group recent`、`im message list` 和 `im message search`。原始响应临时存于仓库外的私有临时目录，完成后删除；本文只保留字段、数量和合成示例，不含真实姓名、组织 ID、会话 ID 或聊天正文。没有发送测试消息。

| 核验项 | 观察结果 | 能证明什么 |
|---|---|---|
| `whoami` | exit 0、`success:true`；`data.openId/name/orgId` 为字符串 | 当前默认 profile 登录可用，可绑定用户及组织 |
| recent 第 1–5 页，每页 20 | 100 个唯一会话；57 个类型 2、17 个类型 1、25 个类型 3、1 个类型 8；每页 `more:true` | 当前账号目录超过 100；固定前 5 页不能覆盖整个可见目录 |
| 3 个群 + 2 个私聊，每个 newest 20 条 | 共 100 条；都有 `msgId/fromOpenId/msgType/content/sendTime/param/extFields`；5 页均时间正序 | adapter 的实际字段形状与样本顺序；不证明所有服务端页永远如此 |
| 群内直接 @当前用户 | 同一群最新窗口内找到 2 条 incoming，`desc` 中 `type:"at"`、`data` 等于 `whoami.openId` | 可使用结构化 ID 判定直接 @我 |
| @全员 | 2 条样本含 `{type:"at", data:"all"}`，并有 `notifyToAll:true` | 可明确排除只有 @all 的消息 |
| 私聊 | 两个窗口分别有 6 / 10 条 incoming，其余为本人 outgoing | 不必读取正文即可区分收发方向 |
| `new` 中间锚点，limit 3 | 已知窗口索引 9 为锚点，返回 10–12；继续返回 13–15 | 样本不含锚点，能从页尾向前续读，`more:true` |
| `old` 同一锚点，limit 3 | 返回索引 6–8，仍为正序 | `old` 的查询方向与数组排序不是一回事 |
| `new` 已知末尾锚点 | 成功，`data.list:[]`、`more:false`，**没有 count** | 空页不能因缺 count 被当作解析失败 |
| 关键词 + `--notify-to-open-id self` 搜索 | 10 月范围第一页返回 20 个群、20 条消息；均有 self 的 at 描述，18 条 text、2 条 richText；14 个群 `hasMoreMessages:true` | 可交叉确认 text/richText 的 @结构；搜索结果有组内截断，不能当完整消息流 |

搜索是用当前用户显示名作为关键词来寻找验证样本，**生产识别绝不依赖姓名文本**。实际 `notifyType` 同时出现数字 `1` 和字符串 `"1"`，`notifyToAll` 可能缺省；不能把它们的固定类型或存在性作为 direct-@self 必要条件。

### 2.2 尚未证明的能力

- recent 是否枚举所有活跃会话、分页过程是否有稳定快照、源端消息保留窗口：未知，仍是 `sampled / gapDetection: partial`。
- 空会话、失效/过期 msgId、权限撤销、离线期间大积压、账号切换和限流：本次未用真实账号制造，纳入故障注入与发布验收。
- 混合 @all + @个人、转发中的 @、未知 msgType：只有明确规则与合成测试计划，不声称已有真实样本证明。
- 来源 `sendTime` 实测形如 `2026-10-29 21:29:52.194`，**不带时区**。按云之家当前业务时区 `Asia/Shanghai` 解释是本版明确策略，发布前与客户端展示抽查核对；不能从字符串本身证明时区。

## 3. 命令面与 adapter

生产正常路径只调用以下三类读命令，每次均传配置中的 `--profile`，用 argv 启动，不经 shell：

```text
yzj-cli --profile <profile> whoami
yzj-cli --profile <profile> im group recent --limit 20 --page <page>
yzj-cli --profile <profile> im message list --group-id <id> --type newest --limit 20
yzj-cli --profile <profile> im message list --group-id <id> --type new --msg-id <cursor> --limit 20
```

`whoami` 在每轮第一步执行，避免 CLI profile 被外部切换后仍使用缓存身份。以 `(orgId, openId)` 绑定 Source；任一变化立即停止本轮并报 `degraded/account-changed`，须新建实例或显式处理身份迁移。请求期间外部换账号仍是 CLI 不提供会话快照的限制；如响应身份能校验则逐响应校验，不宣称跨命令原子性。

成功必须同时满足 exit 0 和 `success:true`。`data.list` 必须为数组、`more` 必须为布尔值；count 仅作可选统计。错误信封、缺 list、非 JSON、超时不能被归一化成空结果。消息 `groupId` 取查询会话，名字取目录；message-list 并不保证逐条带群名、发送人姓名。缺姓名直接展示稳定 ID 或“群成员”，不额外遍历通讯录。

`newest/old/new` 都保留来源顺序，不对 msgId 作数值或字典序比较。明确无时区时间按上节策略转换 ISO；已有 offset 的时间保留其语义；非法时间变 unknown 并按初始化/分页规则处理。

`param` 允许 null 或对象；`desc` 中只读取顶层 `type/data` 作为 @证据。`extFields` 中实测有反应表情、编辑等结构：其中出现 selfOpenId **不代表 @我**。不递归搜索整个 JSON 的 openId，也不从 `replyOpenId`、`replySummary` 或通知摘要推断 @。

以下是与观察字段形状一致的**合成输入**，用于说明 adapter，不是原始聊天记录；`start/length` 仅作展示元数据，不参与身份判断：

```json
{
  "msgId": "m-1001",
  "fromOpenId": "u-peer",
  "msgType": "text",
  "content": "@示例用户 请确认评审时间",
  "sendTime": "2026-10-29 22:01:00.000",
  "param": {
    "desc": [{ "type": "at", "data": "u-self", "start": 0, "length": 5 }],
    "notifyToAll": false,
    "notifyType": 1
  },
  "extFields": null
}
```

## 4. focused 过滤规则

| 输入 | 判定及处理 |
|---|---|
| 类型 1，非空 sender != self | incoming 私聊，生成事件；内容为空或附件仍可用类型占位 |
| 类型 1，sender == self | 不生成事件，包含 self-chat 中自己的消息 |
| 类型 2，incoming，text/richText，顶层 desc 有 `at + selfOpenId` | 直接 @我，生成事件；reply 字段的存在不取消正文中的直接 @ |
| 类型 2，仅 `at + all` / `notifyToAll:true` | 不生成事件 |
| 类型 2，既有 `at + self` 又有 `at + all` | 依据直接 self 证据接收；这是明确产品规则，待合成及真实混合样本验收 |
| 类型 2，仅 `at + otherOpenId`，或普通 `param:null/desc:[]` | 正常非命中，游标可推进，不报识别能力故障 |
| 只有正文“@姓名”，没有 self at 结构 | 不命中，不能用姓名正则补足证据 |
| 顶层带 forward 元数据，或合并转发/未知消息类型可能含嵌套 @ | 不把转发原文当当前直接 @；报告覆盖限制，首版不展开嵌套消息 |
| 缺 sender、畸形 param/desc、at 的 data 非字符串 | unknown；不生成事件，提交可诊断的 coverage gap；禁止声称已可靠排除 @ |
| 缺 msgId 或无效消息对象 | 无法确定遍历边界，停止此页；不得越过该位置推进 cursor |
| 类型 3、8 或未知会话类型 | 排除，不尝试读取其历史 |

unknown 但有稳定 msgId 的消息允许与 **持久 gap 同批 ACK** 后推进，避免永久堵住整个群；这意味着修复 adapter 后不会自动重放这些消息，须显式有界补采。该取舍必须在健康详情中可见。结构错误不得记为“正常非命中”。

普通 file 群消息无直接 @证据时不命中；私聊附件只保存类型和经过白名单提取的稳定引用，不持久化 `localPath`、下载 token 或整个 param。首版 `readOriginal:false`。

## 5. 配置与版本兼容

| 字段 | 新 focused 默认 | 约束 |
|---|---:|---|
| `collectionMode` | `focused` | 新建显式写入；旧配置缺字段一律归 selected-groups，再按旧规则校验必选群 |
| `groupIds` | 空 | focused 下是群聊白名单，空为自动发现；不限制私聊 |
| `yzjProfile` | `default` | 使用已登录 CLI，不由插件接触凭据 |
| `intervalSec` | 300 | 最小 60；旧实例保留持久值 |
| `maxDiscoveryPages` | 5 | 每轮最多 5 页；启用跨轮续扫时最小 2 |
| `maxConversationsPerCheck` | 20 | 实际读消息的会话数，不含相等水位检查 |
| `maxPagesPerGroup` | 5 | 每会话每轮最多 100 条原始消息 |
| `freshnessThresholdSec` | 900 | 配合每轮耗时及排队延迟解释，非通知 SLA |

新建表单显式存 `collectionMode:focused`，从而区别“老配置缺字段”和“新配置默认值”；不能仅凭配置有无 groupIds 猜测实例年代。目标插件版本在实施时确定，本次不改 package.json。

groupIds 手工添加也必须通过已取得的会话类型验证，不能把类型未知的 ID 当群聊。recent 未找到时可用 CLI 群搜索辅助人工定位，但该命令不保证类型；无法证实类型的 ID 显示 unresolved，不把私聊误归群聊。

## 6. 目录发现与公平调度

### 6.1 跨轮目录扫描

每轮读 recent 第 1 页，用于新活动；另外最多 4 页从持久 `nextDiscoveryPage` 续扫。第一页与续扫重叠时按 groupId 去重；到 `more:false` 后完成这一遍扫描，下一轮从第 2 页重新开始。持久化已发现目录及 next page 后才能移动扫描位置。

本次第 5 页仍 `more:true`，因此预期第一轮覆盖 1–5，第二轮覆盖 1、6–9，而不是永远 1–5。目录会随消息活动重排，页码续扫只能改善公平性，不能证明无漏；每次扫到末页后重扫、保留已知会话，并报告扫描滞后。`lastUpdateTime` 实测也是无时区字符串，当前 CLI 没有对应增量参数，不把它伪装成稳定分页游标。

已知会话即使暂时不在 recent 也保留 cursor。待补积压优先；无积压的缺席会话至少每 30 分钟进入一次探测候选（预算不足可更晚，但必须显示 lag）。recent 的 lastMsgId 相等只可跳过本轮刚看到该会话且无 backlog 的请求；不能拿旧目录缓存永久跳过。

### 6.2 调度

私聊、群聊各保留一半会话预算，空余可借给另一 lane。lane 内以最早到期/最久未服务排序，ACK 后更新服务时间；暂时错误记录下次重试时间，不能让一个坏群每轮占满预算。显式群参加同一公平队列，超过容量不承诺额外优先 SLA。

读取、事件、字节、调用数、时间都要计预算：非匹配消息虽不产生事件，仍消耗消息读取量。每轮 CLI 总调用上限 106（1 次身份 + 5 页目录 + 20×5 页消息），默认顺序执行。120 秒软截止前不再启动新调用，单次剩余 deadline 取 `min(20秒, 剩余轮次时间)`；超时 kill 子进程。整轮结束后再等 300 秒，无重叠运行。

`definition.runtime.timeoutMs:30000` 是现有 Host 对 probe/start 等生命周期操作的超时，**不是后台整轮 30 秒预算**。start 及时返回 handle，后台轮次自行管理 deadline；stop 与 runtime.signal 都必须取消 timer 和在途子进程。

## 7. 初始化、分页与缺口

### 7.1 从启用时刻开始

先用空事件 checkpoint 批次持久化 `focusedSince`，再发消息请求。当前 SenseRuntime 不提供实例创建时间，因此以“首次启用 focused 的持久时间”替代 v1 的 `instanceCreatedAt`，不改 Host 接口。

每个新会话独立读取一个 newest 窗口，历史 `sentAt <= focusedSince` 只作基线；窗口中明确晚于该时间且符合规则的消息可以提交。如此晚发现的会话与首次目录分批处理使用同一规则，没有必须等待整个 recent 目录完成的全局 bootstrap 闸门。

- newest 的 `more:true` 表示还有更老历史，**不等于 new 方向尚有积压**。
- 若窗口最早时间仍晚于 focusedSince 且 more:true，明确记录“启用后消息可能超出初始化窗口”的 gap；首版只做窗口补采，不宣称无损回放。
- 初始化时无法判断时间的新消息不猜新旧：只建基线并记 gap。无法证明 newest 页尾是最新边界（乱序/缺时间）则不钉 cursor，保留 pending 初始化。
- 空 newest 页建 `initialized:true, cursor:null`；后续仍走 newest，并使用 focusedSince 过滤。空会话真实行为尚待验收。
- 已有旧模式 cursor 的会话切 focused 后继续该 cursor，避免跳过未读积压；focusedSince 只管没有既有 cursor 的初始化。切换过滤模式不是清空来源历史。

### 7.2 正常增量

从最后 ACK cursor 调用 `type new`，校验当前页原始顺序和字段，按来源连续前缀处理；稳定边界只取已检查且已提交部分的最后 msgId。空数组 + more:false 表示追平。处理所有原始消息，包括被过滤的消息，再按页/预算边界提交。

页面有 more:true 但会话/整轮预算耗尽：保留已 ACK 前缀，置 needsCatchUp，下一轮从该前缀续读；`cursor == recent.lastMsgId` 也不能覆盖未解决 gap。事件或字节配额不够时，同样只能推进到容纳得下的连续前缀，不能过滤完一整页却只提交部分匹配事件并推进整页 cursor。

**禁止沿用现有倒序分支“移到最新再报 gap”的行为。** 新页倒序、方向未知、空页却 more:true、重复锚点导致零进展时，不推进该页，报协议缺口并退避。时间相同但来源有序可保留原序；无法凭样本证明邻接关系的变体必须增加针对性证据，不能靠重新排序补造连续性。

## 8. checkpoint、容量与 ACK

checkpoint 仍是 Host 不解释的版本化 JSON 字符串。v2 建议结构（下面是合成示例，不含真实 ID）：

```json
{
  "v": 2,
  "owner": { "orgId": "org-demo", "openId": "u-self" },
  "focusedSince": "2026-10-29T14:00:00.000Z",
  "discovery": { "nextPage": 6, "sweepStartedAt": "2026-10-29T14:00:00.000Z", "lastSweepCompletedAt": null },
  "groups": {
    "g-demo": {
      "groupType": 2,
      "label": "示例群",
      "cursor": "m-1001",
      "initialized": true,
      "seen": ["m-1001"],
      "lastSeenInRecentAt": "2026-10-29T14:01:00.000Z",
      "lastAttemptAt": "2026-10-29T14:01:00.000Z",
      "syncedAt": "2026-10-29T14:01:00.000Z",
      "needsCatchUp": false,
      "gap": null
    }
  },
  "coverage": { "directoryTruncated": true, "unresolvedCount": 0 }
}
```

容量必须在实施时实测：Host 的 value 上限为 **200,000 字符**，整批仍 ≤1 MiB。插件设更保守的 **160 KiB UTF-8 checkpoint 上限、最多 200 会话**，任一先到即触发 directory-capacity gap；seen 默认每会话最多 20 个，label 最多 80 字符，gap 只保留代码/计数/边界，不留正文或无限历史。字符数和实际序列化字节都校验。

不能为了塞进新会话静默删除旧 cursor。超容量继续服务已跟踪会话，并显示无法纳入新会话的计数，建议缩小群白名单；扩容或显式清理是后续配置能力。公平性只覆盖已纳入容量的会话，不声称 200 个以外仍可轮转无损采集。seen 仅防短期重读，不能替代 durable cursor。

ACK 规则：

1. 单个串行 worker 持有 `{state, revision}`，在整个 generation 内延续；`runtime.checkpoint` 是启动快照，不能每轮从它重置。
2. 每次候选批次包含完整 checkpointAfter，revision 填最近一次 ACK 返回值。目录批次与消息批次串行，不能各拿旧 state 覆盖彼此。
3. `events:[] + checkpointAfter` 用于目录、基线、非匹配消息和诊断缺口。源码已确认只有 `acceptedCount > 0` 才调用 onCommitted；空批次不创建新的 Delivery/分析工作。
4. batchKey = generation + 本轮提交序列 + 冻结批次内容 hash（长度 ≤200）；冻结 observedAt、目录标签、gap 与时间字段。ACK 不确定时阻塞后续提交，用**完全相同**的 batchKey/body 重试，不重新调用 CLI 生成候选。
5. ACK 后接受新 state/revision。进程崩溃后从 Host 持久 checkpoint 恢复：事件和游标同事务，不能只提交了事件而没提交游标。CAS 冲突/旧 generation 停止当前 worker，不能原地修改 revision 继续覆盖。
6. 事件 hash 包括 summary/data/subject 等，不包括 observedAt；重读时姓名、群名或可变附件信息也可能导致 identity-conflict。保存固定展示标签，避免解析同一消息时补入易变资料；遇冲突显式停止该会话，不覆盖旧事实。

v1 checkpoint 迁移保留所有已提交 cursor/seen/pinnedAt/syncedAt，先规范化为 v2 再 ACK；损坏/未知版本不能当空状态。存量本身超容量时不能裁掉 cursor，应拒绝迁移并给出可操作错误。回滚旧插件前暂停 focused 实例；新文档不承诺旧代码能理解 v2。

## 9. 事件输出

继续使用 `im.message.created`、`quno.yzj-im.message/v1`、`eventKey = yzj:<groupId>:<msgId>`。新增 data 字段为 focused 的可选扩展，不改变 selected-groups 的输出。以下为完整合成群聊事件：

```json
{
  "eventKey": "yzj:g-demo:m-1001",
  "type": "im.message.created",
  "schema": "quno.yzj-im.message/v1",
  "subject": { "key": "m-1001", "revision": "m-1001", "label": "示例群" },
  "operation": "upsert",
  "occurredAt": "2026-10-29T14:01:00.000Z",
  "observedAt": "2026-10-29T14:03:00.000Z",
  "summary": "示例群 · @我：@示例用户 请确认评审时间",
  "data": {
    "groupId": "g-demo",
    "chatType": "group",
    "msgId": "m-1001",
    "senderOpenId": "u-peer",
    "senderName": null,
    "direction": "incoming",
    "msgType": "text",
    "text": "@示例用户 请确认评审时间",
    "textTruncated": false,
    "replyToMsgId": null,
    "occurredAt": "2026-10-29T14:01:00.000Z",
    "mentionedMe": true,
    "mentionEvidence": "yzj-param-desc-at"
  },
  "priority": "p1",
  "deadline": null,
  "provenance": { "kind": "observed", "collector": "dsh-quno-sense-yzj" },
  "correlationKeys": ["yzj-group:g-demo", "yzj-mentioned-me"]
}
```

私聊使用同一信封，`chatType:direct`、`mentionedMe:null`、`mentionEvidence:null`，摘要前缀“私聊”，correlationKeys 为会话键及 `yzj-direct:<groupId>`。不因会话是私聊就把对端所有历史重新提交。

正文保留来源 content，不依照 at 偏移删除文字，最多 4000 字符；完整 summary 最多 200 字符，截断显式标记。单事件 ≤64 KiB、每批 ≤100 条且 ≤1 MiB（包括 checkpoint），每轮事件最多 200、提交批次总字节最多 2 MiB，均服从 runtime 更小的限额。非匹配正文不写数据库、健康详情或日志，不进入模型。

`p1` 只是来源建议；Sense 不生成通知、不判“必须回复”。聊天里的命令是观察数据，不能改变 Quno 权限。

## 10. 健康、权限与产品展示

| 状态 | 行为 |
|---|---|
| 无新消息 / 正常非命中 | healthy；必要时空批次更新位置，无新模型工作 |
| 目录未扫完 / 调度欠账 / 初始化窗口不足 / 容量超限 | degraded，显示各自代码、数量、最老欠账；不统一写“登录失败” |
| 稳定 ID 但相关性 unknown | 同批持久 gap 后可推进；gap 未处理不能被后续普通成功抹成“完整覆盖” |
| 单会话权限或坏数据 | 暂停/退避该会话，其他会话继续；不越过未知遍历边界 |
| 身份变化 | degraded/account-changed，全轮停止 |
| 未登录/凭据过期/应用权限不足 | auth-required，不把失败当空页 |
| 明确限流 | rate-limited，全轮停止并退避；没有 retry-after 时指数退避，最大 30 分钟 |
| 网络/超时 | unavailable，保留最后 ACK 状态；会话级失败可继续其他会话，账号级失败停止 |
| CLI 缺失 | unavailable/start-failed，明确安装或 PATH 问题 |
| 参数/解析/协议错误 | degraded，实现诊断，不引导反复登录 |

沿用现有 CLI 两层错误分类，详见 [权威说明](../quno-bot-design.md)。`lastSuccessfulSyncAt` 仅表示有成功闭环，不能代表整个目录覆盖；sourceLag 用未服务/未追平会话最老欠账估计，不能用历史最后发言时间让安静会话永久显示陈旧。无法估计就 null + gap；全局 coveredThrough 默认不填。

接入文案：“每 5 分钟检查最近会话，接收直接 @你及他人私聊。为识别 @，本机会读取候选群的新消息，仅把命中消息交给 Quno。最近会话范围、分页及容量可能造成延迟或缺口。”权限声明必须写清**读取候选会话全部增量消息**，不能只写“读取 @我消息”。用户自己已读与否不影响采集，也不调用 read-status 作为筛选依据。

## 11. 实施与验收

只改本插件内部 adapter/filter/checkpoint/poller、声明与文档；不借此改 Quno 服务或桥。按以下顺序实施：

1. 固定 CLI 0.1.8 的已验证 adapter，建立合成、脱敏 fixture；不以版本字符串替代结构校验，其他 CLI 版本按能力实测决定支持。
2. 纯函数覆盖 text/richText direct-@self、at-other、all、混合 all/self、普通 null/空 desc、reply-only、转发、extFields self、outgoing、self-chat、sender 缺失、畸形字段与无时区日期。notifyType 数字/字符串/缺省均不得破坏结构化判断。
3. 状态机覆盖 recent 超 5 页跨轮续扫、分页移动去重、双 lane、单会话故障不饥饿、目录及 160 KiB 上限、初始化期间仍可接收新消息、空会话、晚发现窗口缺口。
4. 分页测试覆盖已知连续 new 页、空尾页无 count、同时间戳、倒序/未知/零进展、msgId 缺失、事件/字节预算在页中耗尽、每轮配额与停止/超时。
5. 事务测试使用真实 Quno ingress/SQLite：空批次不触发投递；ACK 丢失原批次重试；跨轮使用新 revision；目录与消息串行合并；崩溃恢复；CAS/旧 generation 拒绝；损坏 checkpoint 不归零；模式切换不回放旧事件。
6. scratch `DSH_HOME` 挂载端到端，校验事件 → Delivery → 分析运行、HMR/重启/暂停/身份变化；只读复用真实历史样本，不发送测试消息。执行插件 typecheck/test/build 及相关 Sense 协议门禁。
7. 发布前核对来源无时区时间、空会话和失效游标；缺真实样本的变体保持保守规则及覆盖说明。通过后更新权威 §6.11、包内 README 和版本沿革。

本次交付仅为新版设计及权威索引更新，未写实现代码。核心字段不确定性已经缩小，剩余发布门集中在状态机、异常恢复和真实运行链路，不能据此承诺全局 @或私聊零遗漏。
