# dsh-quno-collector-yzj

Quno 的**云之家群聊采集器**：经宿主机 `yzj-cli` 只读采集云之家消息。默认**聚焦模式**——Host 按 5 分钟节奏调度采集（积压分片续跑），只把「群聊里直接 @我 的消息」和「他人发来的私聊」提交为事件；0.1.x 的选定群全量采集保留为兼容选项。纯 Host 插件，实现 `quno.collector/v2`：不调用模型、不发送消息、不标已读、不下载附件、不碰 token、不直接发 HTTP。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-quno-collector-yzj
```

前置：宿主机已安装并在 PATH 中可解析 `yzj-cli`，且已 `yzj-cli auth login`（无浏览器环境加 `--device`）。桌面 sidecar 的 PATH 分层覆盖 Homebrew、`~/.local/bin` 等常见 host CLI 目录，打包态无需额外配置；one-node 形态下 `yzj-cli` 经 node-shim 解析，shim 死路径会表现为「未登录」，所以 probe 把「CLI 不可用」和「未登录」分开报。

装好后 Quno 的「来源」页出现「云之家群聊」类型；接入向导里可以「从最近会话选择」群聊白名单（私聊无需选择，聚焦模式自动接收），聚焦模式也可以把白名单留空自动发现全部群聊。

## Behavior

- **聚焦模式（默认）**：采集是一个持续推进的工作队列——「每 5 分钟」只是近期活动发现周期，已发现的积压分片连续消化（每片最多 20 次消息请求或 30 秒，片间约 5 秒），不再整轮休眠。每片先 `whoami` 绑定身份（账号与实例绑定的 `(orgId, openId)` 不一致即停止，报 `account-changed`）；私聊/群聊两条公平队列各占一半请求预算、闲置互借；账户请求桶 30 次/分钟（同 profile 的实例在本 Host 内共享）。目录第 1 页每个发现周期读一次，续扫从持久页码按 2 页/分钟推进；新鲜水位相等的会话免读消息；移出白名单的群立即停止请求、游标保留。提交规则：
  - 群聊：仅 `param.desc[]` 中存在 `{type:"at", data:<我的openId>}` 的 text/richText 消息。@全员不算；正文手写「@姓名」无结构证据不算；`extFields` 里的 openId 是表情/编辑结构，不算；同一消息既 @我 又 @all 时按直接 @我 接收。
  - 私聊（`groupType: 1`）：他人发来的消息全部提交，自己的消息不算。
  - 其余消息是**已验证的非命中**，游标照常推进；`param/desc` 结构畸形的消息相关性未知，随持久 gap 同批 ACK 后推进（不堵死会话，但 gap 在后续安静轮次里保持可见，不会被抹掉）。
- **选定群模式（兼容）**：采集所选群聊的全部新消息，事件保持 0.1.x 的 data 形状（`p2`、无 `chatType`）。
- **初始化**：启用时刻（`focusedSince`）先持久化再读消息；每个会话独立读一个 newest 窗口钉基线，只提交晚于启用时刻且命中的消息。历史不回放，`firstSync: baseline-only`；初始化窗口装不下的启用后消息显式报 gap。初始化失败按原因诊断（`time-missing` / `page-order-unverified` / `invalid-message-id`）并走 1/2/5/15/30 分钟退避梯；连续 3 次同因失败标记「初始化受阻」，其他会话照常采集。
- **增量翻页**：从最后 ACK 的 msgId 游标 `--msg-id <cursor> --type new --limit 20`，每次服务取 1 页（空闲可连读，`maxPagesPerGroup` 为上限），未读完的重新排队下片继续。页面方向不可证、缺 msgId、零进展时**原位退避**，绝不跳过；事件或字节预算在页中耗尽时只推进到能容纳的连续前缀。
- **检查点**：具备 `checkpoint-entries/v1` 能力的 Host 上使用**分条检查点**——小体积 v3 根（owner / focusedSince / 目录扫描位置）+ 每会话一条 opaque 条目，事件、条目、根与批次回执同事务提交；0.1.x/0.2.x 的 v2 blob 自动迁移（游标全保留，旧 blob 存为只读快照，迁移中断可重试）。无该能力的 Host 回退单 blob 模式（自限 160 KiB / 200 会话，超容量拒绝而非裁剪）。分条模式容量目标 10,000 条/实例，超出为显式故障。
- **协议诚实**：`data.list` 缺失或 `more` 非布尔是协议失败，不会被归一化成「没有新消息」；时间戳按来源 `Asia/Shanghai` 解释（无时区字符串），带 offset 的保留原语义；缺发送人只展示稳定 ID，不反查通讯录。
- **健康展示（进度 ≠ 故障）**：目录跨页推进、会话排队等待展示为同步进度（含结构化 `progress` 字段）；只有会话受阻、范围外未覆盖、最老等待超阈值（`pendingWaitThresholdSec`，默认 600s）、目录停滞超阈值（`directoryStalledSec`，默认 900s）或登录/限流/网络故障才报 degraded/异常；历史覆盖缺口不会被安静分片抹平。
- **只读**：采集主路径只调用 `whoami`、`im group recent`、`im message list`，探活 `contact user get`，接入选项发现 `im group recent`。不写、不发、不标已读、不用已读状态做筛选。
- **按需读取（query `handleRequest`）**：实例运行期间，Quno 侧可经 `quno_exchange` 对 `collector:<instanceId>` 发起白名单内的只读查询（端点经 `quno_read.collectors` 发现）。与轮询共享同 profile 的每分钟请求预算；`reliability.readOriginal` 仍为 `false`——该声明描述入库载荷完整性，与按需查询正交。详见下节。
- **同步结构化查询（`quno_cli_call`）**：同一批 op 也注册为 Host 能力 `yzj`，Worker 可在同一回合直接取回结果（`capability: "yzj"` + `operation` + 声明参数；多账号用 `target` 选择实例 id）。profile 只来自实例配置；与轮询、异步 query 面共享同一份每分钟请求预算；查询能力随**实例配置**存活，暂停采集仍可用，禁用或删除实例才撤销。

### 按需读取白名单（v1）

| op | 参数（上限） | 映射 CLI |
|---|---|---|
| `im.group.recent` | `limit≤20, page≤10` | `im group recent --limit --page` |
| `im.group.search` | `keyword≤64, limit≤20, page≤10` | `im group search --keyword --limit --page` |
| `im.message.list` | `groupId≤64, limit≤50` | `im message list --group-id --limit`（当前 CLI 无 `--page`，只回最新窗口） |

payload 形如 `{ op, params? }`：枚举外 op 一律 `unsupported-op`、越界/未知参数一律 `invalid-args`（均不重试，reason 自带可用范围）；`--profile` 取自实例配置，payload 不得指定；任何 send/已读/成员/文件/审批类命令不在白名单。输出按条数与单字段 4000 字符截断并标注 `truncated`。

## Config

| 字段 | 默认 | 说明 |
|---|---|---|
| `collectionMode` | `focused` | `focused`（@我 + 私聊）或 `selected-groups`（旧全量；旧配置缺此字段一律按旧规则校验） |
| `groupIds` | 空 | focused 下是群聊白名单（空 = 自动发现全部；私聊始终接收）；selected-groups 下必选 |
| `yzjProfile` | `default` | 对应 `yzj-cli --profile`，一个 profile 一组凭据与配置 |
| `intervalSec` | `300` | 近期活动发现周期，最小 60（积压不按此休眠） |
| `maxConversationsPerCheck` | `20` | 单个执行分片的消息请求数上限（高级） |
| `maxDiscoveryPages` | `5` | 单次发现任务的目录页数上限，续扫按预算推进（高级） |
| `maxPagesPerGroup` | `5` | 每会话单次连读页数上限，默认每次服务 1 页（高级） |
| `freshnessThresholdSec` | `900` | 陈旧阈值（高级） |
| `pendingWaitThresholdSec` | `600` | 最老排队等待超此值才报「采集延迟」（高级） |
| `directoryStalledSec` | `900` | 目录无进展超此值才报「扫描受阻」（高级） |

### 健康分类（两层：先进程，后 API）

CLI 失败时 stdout 为空，stderr 是一行 `{"success":false,"error":{type,subtype,message,hint,code}}`。**本地登出态没有 errorCode**，只认 errorCode 会把未登录漏成「未知错误」：exit 3（`authentication`/`authorization`/`config`）→ `auth-required`，引导 `yzj-cli auth login`；exit 4（网络/超时）→ `unavailable`（限流 429 单独报 `rate-limited` 并退避，最长 30 分钟）；exit 2/5 → `degraded`（实现侧问题）。exit 1 按 API code 归类（10000400/93001/43001 → `auth-required`）。

「最后成功同步」只表示有成功闭环，不代表整个目录覆盖完整；目录未扫完、会话调度欠账、容量超限、相关性未知的 gap 各自以代码 + 数量 + 边界时间显示，不统一写成「登录失败」。

## Development

```sh
cd plugin/dsh-quno-collector-yzj
pnpm install && pnpm run typecheck && pnpm run test && pnpm run build
```

类型来自 `../dsh-quno/src/{types,collectors}.ts`（type-only，不打包 Host 实现）。生产构建只产出 `lib/index.js`。

## Design notes

- Quno 设计：`docs/quno-bot-design.md` §6.11。
- 按需只读查询方案与落地：`docs/notes/2026-11-08-quno-organ-on-demand-read-plan.md` 与 `docs/notes/2026-11-08-quno-organ-on-demand-read-impl.md`。
- 聚焦模式设计（登录态核验版）：`docs/notes/2026-10-29-quno-collector-yzj-mentions-direct-design-v2.md`。
- 采集调度改造设计与实施记录：`docs/notes/2026-10-30-quno-collector-yzj-collection-scheduling-redesign.md` 与 `docs/notes/2026-10-30-quno-collector-yzj-collection-redesign-impl.md`。
- v1 落地决策：`docs/notes/2026-10-23-quno-collector-yzj-impl.md`。
