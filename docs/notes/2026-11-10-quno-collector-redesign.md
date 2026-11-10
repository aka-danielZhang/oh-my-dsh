# 2026-11-10 — Quno 采集层重构：Sense/Organ → Collector（Host 调度）

## 背景

0.4.0-rc.8 时代的感知层（`quno.sense/v1`）有三个结构性问题：

1. **隐喻负担**：「Sense（感知器）」+「Organ（器官）」两个身体隐喻持续增加理解与对话成本。
2. **定时散落**：三个插件各自 `setTimeout` 轮询——calendar 的退避只写健康不生效、feed 失败后 double-timer，只有 yzj 有认真分片调度；「感知自治」实际是「各自为政」。
3. **健康自报不可信**：插件可以一直喊 healthy；Host 无法从协议层区分「没变化」「没跑」「撒谎」。

## 决策

统一为**通用定时采集架构**：Host 统一调度，定期调用插件的 `run(ctx)`；每次 run 把观察经同一事务性 ingest 丢进 Quno；按需查询改为同一声明上的可选 `query` 面。隐喻名退役，统一叫 **Collector（采集器）**。

- **名字用 Collector**；纯定时器（每工作日 9:00 丢 trigger 类）本轮不做，协议里 `nextRunAtMs` hint 与 `schedule.defaultIntervalSec` 已留好位置。
- 契约 `quno.sense/v1` → `quno.collector/v2`：声明 `runtime.{modes,concurrency,timeoutMs}` 删除，改 `schedule.{defaultIntervalSec,minIntervalSec,maxRunMs}`；quotas 改按 run 计；`organ` → `query`（仅 `handleRequest`）；`handleCommand`/`organ.readOriginal`/`resolveThreads` 删除（resolveThreads 生产 fallback `object:<eventKey>` 行为不变）；`reliability.readOriginal` 布尔声明保留。
- **Host 调度规则**（`collectors.ts`，与 2s pass 循环分开）：启用/改配/boot 即跑；成功 `next = clamp(hint ?? now+defaultIntervalSec, [now+1s, now+24h])`（hint 允许远小于 minIntervalSec——yzj 积压续跑 5s/令牌等待依赖此）；失败非 fatal `next = max(now+interval, retryAfterMs ?? backoffMs(failures))`；fatal/超时停排。
- **健康由 Host 推导**：state/code/consecutiveFailures/nextRetryAt/lastAttemptAt/lastSuccessAt 从 outcome 落列；extras（detail/coveredThrough/sourceLagSec/progress/issues）合并进 `health_json`，与旧自报形状 wire 兼容；两次 run 之间保持上次推导结果；成功 run 带 issues 或上报 gap 判 degraded。
- **generation 级栅栏**：每次 run `bumpGeneration`；ingress `assertWritable` 三查语义不变。两次 run 之间最后一次 run 的 ctx 仍可写（评测器 fixture 依赖），下一次 run 启动/改配/停用即栅栏生效；run 超时被强停时 Host 额外 bump 一次，撤销那个再也不会被下一次 run 栅栏的写面（评审修订，见下）。
- `IngestBatch`/`quno.event/v1`/Exchange 状态机/checkpoint-entries/v1/批次幂等/checkpoint CAS 全部不变；feed 304 空 cursor commit 保留。
- **实施落地**：`senses.ts` 重写为 `collectors.ts`；store v3→v4（四表 RENAME + `events.collector_config_revision`，存量数据零改写，实例 id `sense-*` 保留、新实例 `col-` 前缀）；`organ:<id>` → `collector:<id>`、`quno_read.organs` → `collectors`、服务键 `qunoSenses` → `qunoCollectors`、`ctx.qunoIngress` 删除（唯一使用者评测器改走 run ctx commit 面）；面板视图 id `'sense'` → `'collectors'`，文案「感知器/感知来源」→「采集器/采集来源」。
- **三插件**：calendar/feed 删 timer 改 `run(ctx)` 一次 check/poll（退避/double-timer bug 由 Host 统一调度自然修复；429 retry-after 从此真的生效）；yzj `round.ts` 行为不变（仅 `provenance.collector` 等包名字符串随改名变更，6 行），既有 worker 单测原样通过；`run` = 实例**长生命周期 worker** 的一次 `runRound` 的 outcome 映射（worker 槽位由 `mount` 建、disposer 回收——初版每 run 重建 worker 是评审阻断 2，见下），worker 七类健康报告集中为 run extras，`registerOrganInstance` 迁 `mount`；三包改名 `dsh-quno-collector-{calendar,feed,yzj}`。
- **桌面退役**：`src/install.ts` `RETIRED_DESKTOP_PACKAGES` 增 `dsh-quno-sense-calendar/feed`（yzj 从未随包）；旧包被退役清扫移除、新包走首启安装事务，需一次桌面 `v*` 发版生效。旧契约插件与新 Host 并存时因契约版本不符拒载（loud，符合纪律）。

## 明知的行为变化（逐条可回退）

- calendar/feed 的私货定时 bug 被统一调度修复。
- 三插件对 `stale-generation`/`checkpoint-conflict` 统一 fatal 停排（calendar/feed 原来无限重试；yzj 原语义保持）。
- 健康不再由插件自报心跳，两次 run 之间显示上次推导结果；`idle` 是新 lifecycle 词。
- 模型可见字符串变化（`collector:` 端点、`quno_read.collectors`）——evals 断言同步更新。

## 验证

- 四包 typecheck/test/build 全绿：dsh-quno 188（含新增 `collector-scheduler.test.ts` 调度单测：启用即跑、hint 钳制、退避/retryAfterMs、fatal 停排、run 超时、栅栏、健康推导）、calendar 7、feed 7、yzj 54（`round.ts` 43 项 worker 用例原样保留）。
- scripted evals 21 用例全 pass（9 个 blocked 为既有架构性阻塞，与本次无关）；`quno_read.collectors` 发现面与 `collector:` 端点经 exchange 用例实测。
- **迁移验证**：真实 `~/.dsh` Quno DB（v3：1719 批次、1454 checkpoint 条目、1 个 yzj 实例）经 backup API 取快照后跑 v3→v4：14 项断言全 PASS——`user_version=4`、旧四表消失、新四表行数与实例行逐字段一致、`events` 列改名且行数不变、批次回执与 checkpoint 条目可读、重开幂等。
- **scratch home 挂载**：`dsh plugin add` 四包（dsh-quno + 三个 collector）→ boot 后 Host 真实调度 calendar run：事件入库（`calendar/event-updated`）、批次回执、checkpoint 推进 revision 1、实例 `healthy/idle`。顺手修复 calendar 对未经 `validateConfig` 的存量行 `file/directory` 为 undefined 时的误读（`?? null` 归一，readCalendar 加固）。
- **桌面 e2e**：`DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 pnpm desktop:dev` → `DSH_E2E_OK`（exit 0）；壳未动，`desktop:typecheck`（干净）与 `desktop:test`（148 项）全绿。
- **待办（实机）**：yzj 实机只读交换 smoke 需真实云之家账号经 `quno_read.collectors` 发现端点后完成，留给下一次真实 profile 会话验证（合成 fixture 与 54 项单测已覆盖协议面）。

## 评审修订（2026-11-10，同 PR）

代码级评审发现 3 个阻断级缺陷，均属「测试全绿、装进 tarball 或跑在真实积压下才发作」一类；已修复，并为每一个补了能抓住原缺陷的测试（变异测试验证：还原缺陷即失败）。

1. **跨包值导入 Host 错误类 → 安装态 `instanceof` 永假**。calendar/feed 值导入 `QunoIngressError`、yzj 值导入 `CollectorOptionsError`；tsdown 把私有副本打进各自的 `lib/index.js`，而 `ctx.commit` 抛的是 Host 实例的错误——安装态下 fatal 映射是死代码（栅栏拒绝退化为无限重试），yzj 向导的分类失败全部退化为 `discovery-failed`。开发态相对导入解析到同一文件，所以测试恰好全绿。**修法**：插件按结构判别（`error.name === 'QunoIngressError'` + `shape.code`；yzj 抛 `name: 'CollectorOptionsError'` + `code` 的普通 Error），Host 改用 `isCollectorOptionsError` 结构判别；三包新增**纯度守卫测试**（src 对 `dsh-quno/src/*` 只许 `import type`，含动态 `import()`；对缺陷版本源码实测命中）。副作用收益：值导入曾把 Host 的 ingress→store→zod 整条依赖拖进每个插件包，修复后产物 calendar 167→19 kB、feed 162→14 kB、yzj 252→105 kB，产物内 zod/sqlite 引用归零。tsdown 纯度门只拦 `@deepseek-ai/*`，拦不住相对路径跨包值导入——守卫测试补的就是这个缺口。
2. **yzj 每 run 重建 worker → 目录发现节奏被摧毁**。`lastDiscoveryAt`/`lastSweepPageAt`/`watermarks` 都是 worker 闭包内存，每 run 重建使每次 run 都判定「到期发现」，积压续跑时每 ~5s 一次整套 whoami+目录页，全部扣共享的每分钟 30 次请求桶。**修法**：实例 worker 槽位由 `mount` 建、disposer 回收（对齐旧「一代一 worker」），worker 的 deps 经 getter 指向**当前 run**——直接复用会捕获首个 run 的 commit 面，第二次 run 起必被栅栏拒为 `stale-generation`（这是复用方案自身的陷阱，测试专门覆盖）；batchKey 命名空间冻结为 worker 创建时的 runId（ACK 不确定的原样重试跨 run 仍命中同一回执）；fatal 或中止信号下结束的轮次丢弃 worker；失败阶梯回传 `previousFailures`。适配器导出可注入 CLI 的 `runCollector` 与 `resetCollectorWorkers` 测试接缝（沿 `resetTokens` 先例）。
3. **每次 run 收尾把 `last_event_at` 抹成 null**——`writeHealth` 写 `detail.lastEventAt ?? null` 而 extras 契约没有该字段。修复时发现**同类第二处**：失败 run 的 detail 不含 `lastSuccessfulSyncAt`，每次失败也会抹掉 `last_success_at`（陈旧判定误报「从未同步」）。**修法**：列只在本次写入带值时更新（`undefined` 保持、`null` 才覆盖），`health_json` 从当前行继承两字段；`onGap` 的中间写入同样合并而不覆盖。

一并收掉：`arm()` 的 fire-and-forget 补 `.catch`（删行/关库竞态不再泄漏 unhandled rejection）；`idle` 补中英文案、`failed` 文案改为新语义「已停止调度」，纯映射下沉到 `panel-state.lifecycleKey` 并以 `Record<CollectorLifecycle, true>` 做编译期穷举测试；模型可见措辞（`quno_exchange` 描述、拒答目录、preset 指引）统一为采集器，evals 断言同步；死代码删除（core `QueryCapabilities`/`ThreadResolution` 残留槽、`EngineForOrgans`、`capabilitiesForSource`），`collectorEndpoint`/`collectorInstanceOf` 改为 service 的端点前缀单点；store v4 顺带把遗留索引 `sense_instances_quno` 改成新库同名 `collector_instances_quno`；run 超时强停时额外 bump 一次 generation（见上「generation 级栅栏」）。

**补的测试**（全部对原缺陷做过变异验证）：yzj 适配器 3 项（worker 跨 run 存活且第二次 run 不再发现目录、栅栏后提交走当前 run 的 commit 面、remount 重建、fatal 后丢弃、auth 失败映射）；calendar run 级 4 项（快照差分提交与无变化不提交、缺目录分类、结构化 fatal/暂态拒绝、`ingressRefusalOf` 只认 QunoIngressError 形）；feed run 级 3 项（200 提交 → 仅校验器变化的空 cursor 提交 → 304 不提交、429 Retry-After 成为 Host 重试延迟、结构化 fatal）；Host 调度 4 项（健康列跨 run 保持、run-threw 退避、pause→resume 重挂载即跑、删行竞态只告警）+ 超时撤销写面；v3→v4 迁移 2 项（以**反向降级**真实写入的 v4 库构造逐列一致的 v3 夹具：改名、行数、实例行逐字段、回执/条目可读、幂等、新库同名）；Host 结构化 options 错误分类。

**需要知道的行为语义**（非缺陷，记录在案）：
- 升级后存量 `organ:<id>` Exchange 在启动即 `failed/capability-unavailable`——响亮、不吞，模型侧经 `quno_read.collectors` 重新发现端点。
- 栅栏是 generation 级：两次 run 之间最近一次 run 的写面仍有效（规范采集器只在 run 内提交）；超时停排已补撤销。
- `minIntervalSec` 只约束无 hint 的默认间隔（hint 可低于它，yzj 续跑的必要设计）；失败重试下限沿旧语义为 `defaultIntervalSec`。
- **已知问题（既有，非本次引入，下轮修）**：calendar 单次事件数超配额时只发前缀，但 checkpoint 写全量快照，截断部分被静默跳过（`complete` 字段删除前也只是不被读取的标记）。正确修法是只 checkpoint 已发前缀或报 gap。
- 三包 `implementationVersion` 与包版本未 bump，进下一次发版清单（发版提交统一 bump）；退役清扫与新包首装都要等下一次桌面 `v*`。
- 评测 case id / check id（如 `organ-discovery`、`organ-answered`）**保持不变**：它们是历史基线的比对键，改名会使基线对比断档；代码标识符、夹具文件名与描述文案已改。

验证（修订后）：dsh-quno 195、calendar 13、feed 12、yzj 59 全绿；四包构建通过且产物内无 Host 类副本；scripted evals 21/21、新增失败无；全仓 `plugins:check` 20 包全绿；壳层 `desktop:typecheck` 干净、`desktop:test` 148、`shipped-plugins` 9 全绿。

验证环境注意（既有开发工具问题，不在本 PR 范围）：`pnpm desktop:dev` 的 `linkPluginRuntimeDeps` 会把随包插件的 `@deepseek-ai/*` 对等依赖改链到开发 runtime 且不复原，之后在这些包目录里跑测试就是对着 runtime 的 harness 版本。初版验证跑过桌面 e2e 后，`dsh-ohmymemo` 的 `dsh-contract.test.ts`（按 rc.2 写）在 zw.9 runtime 上失败 8 项（主仓自 10-30 一次 desktop:dev 起即处于同样状态，9 项）；dsh-quno 评测器的类型双实例冲突也是同一来源。本轮验证前已按锁文件干净重装恢复 registry 链接后再跑。

## 关联

- 改写 `docs/quno-bot-design.md` §6（三面模型 + 调度规则 + run/outcome 契约）、§6.9、§6.11、§14.1、§15.3、摘要与沿革。
- 前置：`docs/notes/2026-11-01-quno-trigger-organ-and-exchange.md`（Organ/Exchange 引入）、`docs/notes/2026-11-08-quno-organ-on-demand-read-plan.md`（按需读取白名单）。
