# 2026-10-30 云之家 Sense 采集调度改造实施记录（Phase A/B + C 主体）

> 状态：**已实现并通过两包全部单测（yzj 43/43、dsh-quno 141/141），尚未完成方案 §10 的全部验收门**。设计依据：[改造方案](2026-10-30-quno-sense-yzj-collection-scheduling-redesign.md)；本文记录落地范围、关键取舍、实测验证与遗留清单。
>
> 版本：`dsh-quno-sense-yzj 0.3.0`（Phase A 调度重写 + Phase B entries 适配）；`dsh-quno` 侧 schema 升 v2（`sense_checkpoint_entries` 表）、ingress 同事务 patch、runtime `checkpoint-entries/v1` 能力、Scheduler 分析准入门。契约同步：[Quno 开发说明](../quno-bot-design.md) §6.11 与包内 README。

## 1. 已落地

### Phase A（调度与诊断，保持 v2 blob 格式兼容）

- **分片工作队列**：`runRound` 改为一个执行分片——whoami（每片验证身份）→ 到期发现（页 1 每 `intervalSec`，续扫页按 2 页/分钟 pacing）→ 公平队列服务（每会话每次 1 页后让出，空闲连读）。积压分片以 ~5 秒续跑（`BACKLOG_CONTINUATION_MS`），不再「处理 20 个就睡满 5 分钟」。
- **账户请求桶**：30 次/分钟，进程内按 `yzjProfile` 共享（`takeToken`）；令牌耗尽分片让出并携带下次令牌时间。身份请求同样花令牌。
- **水位跳过**：发现读到的 `lastMsgId` 作为新鲜水位缓存；与已 ACK cursor 相等且无积压/缺口/补采的会话免读消息。旧缓存不会永久压制探测（30 分钟冷探测候选保留）。
- **白名单即时生效**：选择队列按当前 `groupIds` 重校，移出范围立即停止请求、游标保留。
- **字节预算实际消费**：分片累计事件 JSON 字节 + 检查点字节，页内逐条门控（`shardBytes + lastCommit + batchBytes + eventBytes > maxBytesPerCheck` 即切前缀）。
- **`lastAttemptAt` 每次服务必盖戳**；初始化失败按原因细分（`time-missing` / `page-order-unverified` / `invalid-message-id`）并走 1/2/5/15/30 分钟退避梯，连续 3 次同因 → `init-blocked`（健康显示「初始化受阻」，其他会话继续）。
- **唯一计数**：`coverage.capacityRejectedIds` 去重集合（上限 500），重复遇到的拒收会话不再累加；展示「至少 N 个」。
- **健康语义重写**：目录推进、排队等待属于**进度**（healthy + 结构化 progress 字段 + 文案）；只有受阻会话、容量拒收、最老等待超 `pendingWaitThresholdSec`（默认 600s）、目录停滞超 `directoryStalledSec`（默认 900s）、standing gap 才 degraded。standing gap 不被安静分片抹平。

### Phase B（`checkpoint-entries/v1`）

- **Host**：schema v2 新表 `sense_checkpoint_entries (instance_id, entry_key, value_json, updated_at)`；每实例容量目标 10,000 条（`QunoStore.CHECKPOINT_ENTRIES_CAPACITY`），超出为显式 quota 拒绝、绝不静默淘汰。`ingestBatch` 新增可选 `checkpointPatch {upserts, deletes}`，与事件、根 checkpoint、批次回执**同一 SQLite 事务**提交；batch hash 覆盖 patch（同 key 不同 patch → identity-conflict）。runtime 暴露 `checkpointEntries` 分页读面 + `capabilities.checkpointEntries` 能力声明；contracts 扩展均为可选字段，旧客户端/旧 Sense 不受影响。
- **yzj 适配**：具备能力的 Host 上 worker 进入 entries 模式——根 checkpoint 升 v3（不含 groups 的小文档），每会话一条 `c:<id>` opaque 条目（≤8KiB 引导），内存持有调度元数据；提交按引用差异只写脏条目 + 根，batchKey 指纹覆盖 patch。**迁移**：检测到 v2 blob 即暂停写者，旧 blob 整体存为 `m:v2` 只读快照条目，会话条目 ≤100/patch 幂等分批，最终事务写 `m:done` + v3 根；中断可从快照重试。无能力的 Host 走原 blob 路径（回滚面：新插件读 v2 blob 之后的数据旧插件会拒绝启动并明确报「版本未知」，不会静默重建基线——见方案 §5.3 的回滚约束）。

### Phase C（已落地部分）

- **分析准入门**（`dsh-quno/scheduler.ts`）：`onIngest` 不再直接 `checkNow('event')`，改为 `scheduleAutoAnalysis()`——只路由 + 布防最早**获准**时刻。普通自动分析最早 = `max(首条 ready Delivery 时刻 + 15s 合并窗口, 上次分析启动 + checkIntervalSec)`；`lastAutoStartedAt` 从最近 run 记录恢复，重启不重置冷却；手动「立即检查」绕过窗口但不绕过暂停/单飞/每日预算，且消费积压后同样推进分析边界；到期事项按自身 dueAt 唤醒，不等普通窗口。
- **结构化健康字段**：`progress`（tracked/pending/blocked、oldestPendingAt、lastDirectoryProgressAt、nextDiscoveryPage、requestBudgetPerMinute 等）与 `issues[]`（code + detail）贯穿 contracts → types → senses 落库 → yzj 上报；旧字段全部保留。

## 2. 实测验证（2026-10-30 只读抽样，未发送任何消息）

`yzj-cli 0.1.8` 登录态下确认（方案 §6.2 发布门 4 的源端语义部分）：

| 命令 | 结果 |
|---|---|
| `newest --limit 1` | 返回 1 条最新消息，`more: true`（单条即可取锚点 A，不依赖整页升序） |
| `old --msg-id A --limit 1` | 返回 A 的前一条（锚点排除，时间正序），`more: false` |
| `new --msg-id A --limit 1` | 空 `list` + `more: false`、无 `count`（空页规则再次确认） |

## 3. 遗留（后续批次）

1. **初始化边界恢复状态机**（方案 §6.2 全量）：anchor 探测 + 前向/补采独立任务 + 200 条补采预算。上述 limit-1 验证已扫清其源端语义门；状态机未实装，当前 `init-blocked` 会话仍以退避等待（可经「编辑实例」重置触发重新初始化）。
2. **方案 §10 验收门其余项**：1,000 会话/100 页目录基准、200 会话+3 永久失败会话的公平性压测、虚拟时钟的全预算矩阵、故障注入与 scratch 升级往返、10,000 条资源基准。单测已覆盖矩阵的关键分支（跨轮续扫、容量去重、退避梯、patch 事务、CAS/旧 generation、ACK 丢失重试、standing gap），但基准级压测未跑。
3. **UI 面板对 `progress/issues` 的结构化渲染**：当前字段已入库，动态页仍以 detail 文案展示；结构化渲染是纯客户端增量。

## 4. 部署记录

- 正式 `~/.dsh` 实例重启后首片将触发 v2 blob → entries 迁移（138+ 会话条目）；迁移前备份：`~/.dsh-desktop/backups/2026-10-30-pre-entries-migration/`。
- demo2（`/tmp/quno-demo2-ttoq6E`）同版本部署。
