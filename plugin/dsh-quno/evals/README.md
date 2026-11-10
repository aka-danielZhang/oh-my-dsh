# Quno 链路评测器（evals/）

按 [Quno 链路评测集与本地回放设计](../../docs/notes/2026-11-06-quno-link-evaluation-design.md) 与 [真实模型端到端能力验收设计](../../docs/notes/2026-11-07-quno-live-end-to-end-evaluation.md) 实现的两层评测：

- **Scripted 链路**（`pnpm run eval`）：真实组合跑预设剧本，基础设施回归，每次修改必跑；
- **Live E2E**（`pnpm run eval:live -- --suite live-p0`）：真实模型独立决策，隐藏 fixture + 行为 oracle 验收真实能力，发布门前必须连续三次全绿。行为契约以 [`docs/quno-bot-design.md`](../../docs/quno-bot-design.md) §15 为准。

## 命令

```sh
cd plugin/dsh-quno

pnpm run eval:protocol                  # L0 协议自检（SSE/toolCallId 配对，无网络无凭据）
pnpm run eval -- --list                 # 全部 case（scripted runnable/blocked + Live E2E）

# Scripted（确定性回归，无凭据）
pnpm run eval                           # scripted 全量
pnpm run eval -- --suite p0             # P0 套件
pnpm run eval -- --case direct-read --repeat 3   # 单 case 重复

# Live E2E（真实模型；凭据缺失时大声报错，不假通过）
pnpm run eval:live -- --case live-direct-read    # L1 冒烟：真实工具闭环
pnpm run eval:live -- --suite live-p0 --repeat 3 # 发布门：12 case 连续三次全过
pnpm run eval:live -- --case live-direct-read --seed 42  # 复现指定 seed
pnpm run eval:replay -- --run latest             # 回放最近一次 live 录制
```

Live 约束：`--suite live-p0` 或 Live case **必须** `--model live`（scripted 会被拒绝——剧本不是决策）；`--repeat N` 对 Live 是稳定性门禁（**全部 N 次通过**，无 stop-on-first-pass）；每次 attempt 用不同 seed 生成隐藏事实（`--seed` 可复现），事实只存在于 fixture 文件，prompt 里没有。

**角色级模型配置（ModelPlan，配置只解析一次）**：

```sh
pnpm run eval:live -- --suite live-p0 --router-model deepseek-chat --worker-model deepseek-reasoner
pnpm run eval:live -- --suite live-p0 --model deepseek-chat   # 两角色同模型的便捷写法
```

合并顺序：内置默认 → 环境变量（`QUNO_EVAL_LIVE_MODEL/BASE_URL`，可选 `QUNO_EVAL_ROUTER_MODEL/WORKER_MODEL`）→ Case 覆盖 → CLI 覆盖。计划记录「请求路由 + provider 解析路由」和凭据**引用名**（`credentialRef`），密钥值与 baseUrl query 永不入证据。

Live 凭据走环境变量：`QUNO_EVAL_LIVE_API_KEY`（或 `DEEPSEEK_API_KEY`）、`QUNO_EVAL_LIVE_BASE_URL`（默认 `https://api.deepseek.com`）、`QUNO_EVAL_LIVE_MODEL`（默认 `deepseek-chat`）。凭据不进 case、trace、报告或录像（`redact.ts` 兜底扫描，发现即全局硬断言失败）。

## 结构

```
evals/
  cli.ts          运行编排：--case/--suite(p0|p1|live-p0)/--model/--router-model/--worker-model/
                  --base-url/--repeat/--run/--seed/--protocol/--list；ModelPlan 唯一解析点；run.json/
                  events.jsonl/requests.jsonl 汇流
  case.ts         Scripted case 契约（steps + chain checks + semantic items + budget）
  live.ts         Live E2E case 契约（goal + hidden fixtures + 行为 oracle，无剧本）
  plan.ts         ModelPlan：内置→环境→Case→CLI 合并；credentialRef 引用；baseUrl 消毒
  usage.ts        UsageLedger：按 role/model/session/stage/case/run 聚合；usageMissing ≠ 0
  classify.ts     Live 失败分类：MODEL_DECISION / MODEL_TOOL_USE / MODEL_GROUNDING / HARNESS / FIXTURE / PROVIDER
  protocol.ts     L0 协议自检（eval:protocol）：SSE/toolCallId 配对 + ModelPlan 合并/无密钥/消毒 + usageMissing
  trace.ts        每 stage 的 trace.jsonl；未到达 stage 一律 blocked，不混入根因
  redact.ts       凭据/密钥模式扫描
  runtime.ts      Real Runtime Composer：testkit 挂载 + 真实 QunoHost（scratch SQLite）+
                  resolveNodeContext（真实 turn/step seq + stage 推导 + 领域 refs）+ 虚拟时钟
  persistence.ts  真实 sessionPersistence 后端（create/open/stat + append/read/flush + 证据导出）
  driver.ts       Scenario Driver：human/ingest/advanceMs/script/config/crash/restart/
                  settleUntil/waitFor/lateReport，所有等待有 deadline
  report.ts       report.json + report.md（首个失败 stage、失败分类、UsageLedger 表、对比上一 run）
  models/
    gateway.ts    单一 LlmAdapter，按角色分流 live/replay/scripted；每条请求带 ExecutionContext
                  （runId/caseId/attempt/seed + sessionId/turnId/stepId/stage/refs + requested/resolved
                  路由 + provider usage）；SseAssembler 与 toOpenAiMessages 纯函数可本地回归
    scripted.ts   text/tool turn 的 chunk 构造（与现有单测同一词汇）
  fixtures/
    organ.ts      合成采集器：走真实 qunoCollectors 注册 + run ctx commit 事务提交 Trigger；
                  query 能力面响应真实 Exchange
    fs.ts         fixture 目录 + 只读 read/glob/grep + 真实但惰性的全局 bash
    hidden.ts     Live 隐藏事实生成器（seeded RNG：负责人/截止日期/文件名/错误码 + 干扰值）
  cases/          Scripted：P0（9）+ P1（10）+ blocked 清单（含真实第三方来源）
  cases/live/     Live E2E：P0 全部 12 个 + P1 第三方能力缺口
```

## 覆盖与边界（诚实清单）

**Scripted P0（回归层，每次修改必跑）**：`chat-simple`、`direct-read`、`status-result`、`eval-observe`、`auto-investigate`、`owned-followup`、`worker-restart`、`notification-quiet`、`tool-guard`。

**Scripted P1**：`irrelevant-ignore`、`explicit-source-accept`、`worker-blocked-answer`、`worker-handback`、`worker-stop-late`、`policy-change`、`exchange-roundtrip`、`third-party-tool-unavailable`、`notification-dedupe`、`memory-isolation`。

**Scripted blocked（registry 中带原因，不假通过）**：`desktop-entry`、`desktop-task-card`（L4 DOM）、`compaction-recall`、`burst-100`、`two-threads-timeout`、`feedback-cas`、`notification-flush`、`exchange-restart`、`third-party-cli-live-read`（真实 yzj-cli 正向读取；生产按需 Organ 与显式 live-source 选择尚未提供）。

**Live E2E P0（能力验收层，发布门）**：`live-chat-simple`、`live-direct-read`、`live-status-result`、`live-clarify`、`live-tool-guard`、`live-eval-observe`、`live-auto-investigate`、`live-owned-followup`、`live-exchange`、`live-worker-blocked`、`live-worker-restart`、`live-notification-quiet`——与验收设计 §5 一一对应；每个 case 由「用户目标 + 隐藏事实 + 授权边界 + 行为 oracle」组成，失败按 §7.3 分类（classification.json 落盘）。

**Live E2E P1**：`live-third-party-tool-unavailable` 用真实模型验证第三方 CLI 未接入时的诚实失败，禁止虚构 collector 端点、桌面更新根因或查询结果。该 case 以 `mountEvalCollector: false` 建模「没有任何第三方来源」——合成采集器不挂载，`quno_read.collectors` 为空，worker 只能从发现面如实报缺口（2026-11-10 首跑发现：若合成源在场，worker 会探测它并被回显「成功」，既污染被测链路也违背 case 主题）。它只覆盖负向行为，不代表真实第三方读取已通过；其余 P1 扩展随验收设计 §6 待补。

实现边界（与设计文档的偏差）：

- **重启保真**：评测组合挂载真实 `sessionPersistence` 实现（`evals/persistence.ts`，每会话一个 JSONL 文件，`create/open/stat` + handle `append/read/flush`），并同一实现承担 `sessionQuery` 读面与 `session/flush` 屏障；crash/restart 走与生产一致的 resume 路径，transport 去重、executor 对账、outbox 对账读的都是同一份持久日志。与生产 persistence-jsonl 的差异：单进程、无 fork lineage/repair，`releaseWriters()` 在组合完全停止后释放写权（restart 语义即「旧组合已死」）。Quno SQLite 的全部领域持久性（Ticket/Input/Attempt/Effect/Notice/恢复对账）是真实的。
- **虚拟时钟**：`QunoHost` 新增构造参数 `{ now }`（默认墙钟，生产行为不变）；评测注入虚拟时钟驱动调度/安静时段/到期。`advanceMs` step 推进虚拟时间；waitFor 停滞时小步推进以放行虚拟退避。
- **E2 故障注入**：已实现 `crash`/`restart`/`failNextEffect`（包装下一个 effect handler 抛错）/`lateReport`（stop 后晚到报告注入）；§10 的每个事务边界矩阵仍按计划补齐（见 blocked 清单）。
- **语义判定**：v1 全部结构化（报告字段、回复文本包含/不包含必须项），未接 LLM judge——设计允许 judge 只用于无法结构化的表达质量。
- **Live 协议映射**：SSE → StreamChunk 组装器（`SseAssembler`）与 OpenAI 历史映射（`toOpenAiMessages`）为纯函数并有本地回归（`tests/eval-gateway.test.ts`）：provider 工具调用 id 全程保留，`tool_calls[].id` 与 tool result 的 `tool_call_id` 严格配对。

## 结果与证据

**证据包结构**（设计 §4.3，一条证据链）：

```text
eval-results/<runId>/
  run.json                    # 不可变 ModelPlan（requested+resolved）、seed、repeat、环境
  report.json / report.md     # 汇总、失败分类、UsageLedger 聚合
  events.jsonl                # 全 run 的 stage trace 汇流
  requests.jsonl              # 每次模型调用的完整身份（run/case/attempt/seed/seq/role/
                              #   execution.requested+resolved/sessionId/turnId/stepId/stage/refs）
  cases/<caseId>/attempt-<n>/
    trace.jsonl               # 节点级断言
    model-requests.jsonl      # 同 requests.jsonl 内容（replay 源）
    sessions/<id>.jsonl       # 脱敏 Session 证据 + sessions/index.json（Session↔Ticket 映射）
    fixture-seed.json         # 本次隐藏事实（Live）
    fixture/                  # fixture 文件副本（Live）
    failure.json / classification.json  # 失败现场与分类
```

**UsageLedger（§5）**：报告按 run / role / model / stage / case 聚合 `modelCalls / inputTokens / outputTokens / totalTokens / cachedInputTokens / durationMs / usageMissing`。token 一律取 provider 返回值；provider 未返回的请求计入 `usageMissing`（未知消耗 ≠ 0，报告会显式提示），不估算。请求耗时用墙钟（durationMs），与虚拟时钟的调度推进互不污染。

`eval-results/` 已 gitignore；失败现场 scratch home 默认保留（`--keep failures`），成功即清（`--keep all|none` 可覆盖）。

发布门（验收设计 §10）：`eval:protocol` → `eval:live -- --case live-direct-read` 冒烟 → `eval:live -- --suite live-p0 --repeat 3` 全绿之前，不把「测试全绿」当作链路可用。
