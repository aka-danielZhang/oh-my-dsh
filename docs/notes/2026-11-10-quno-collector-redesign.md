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
- **per-run generation 棚栏**：每次 run `bumpGeneration`；ingress `assertWritable` 三查语义不变。两次 run 之间最后一次 run 的 ctx 仍可写（评测器 fixture 依赖），下一次 run 启动/改配/停用即栅栏生效。
- `IngestBatch`/`quno.event/v1`/Exchange 状态机/checkpoint-entries/v1/批次幂等/checkpoint CAS 全部不变；feed 304 空 cursor commit 保留。
- **实施落地**：`senses.ts` 重写为 `collectors.ts`；store v3→v4（四表 RENAME + `events.collector_config_revision`，存量数据零改写，实例 id `sense-*` 保留、新实例 `col-` 前缀）；`organ:<id>` → `collector:<id>`、`quno_read.organs` → `collectors`、服务键 `qunoSenses` → `qunoCollectors`、`ctx.qunoIngress` 删除（唯一使用者评测器改走 run ctx commit 面）；面板视图 id `'sense'` → `'collectors'`，文案「感知器/感知来源」→「采集器/采集来源」。
- **三插件**：calendar/feed 删 timer 改 `run(ctx)` 一次 check/poll（退避/double-timer bug 由 Host 统一调度自然修复；429 retry-after 从此真的生效）；yzj `round.ts` 与 54 项单测不动，`run` = 一次 `runRound` 的 outcome 映射，worker 七类健康报告集中为 run extras，`registerOrganInstance` 迁 `mount`；三包改名 `dsh-quno-collector-{calendar,feed,yzj}`。
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

## 关联

- 改写 `docs/quno-bot-design.md` §6（三面模型 + 调度规则 + run/outcome 契约）、§6.9、§6.11、§14.1、§15.3、摘要与沿革。
- 前置：`docs/notes/2026-11-01-quno-trigger-organ-and-exchange.md`（Organ/Exchange 引入）、`docs/notes/2026-11-08-quno-organ-on-demand-read-plan.md`（按需读取白名单）。
