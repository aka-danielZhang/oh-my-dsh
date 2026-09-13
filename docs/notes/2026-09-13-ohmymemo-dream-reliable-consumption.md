# OhMyMemo 梦境提取长期可靠消费方案（2026-09-13）

> 状态：落地方案，待实现。
>
> 本文是 2026-09-13 核对夜间 maintenance Session 原始事件后形成的长期改造决策。设置页此前报告的两次 `max-token ceiling` 均为围栏 JSON 触发 salvage 后产生的假警报，并非真实 `max-tokens`；本文据此修正事故前提和实施顺序。它不改写历史记录：输出预算与 legacy salvage 的既有背景见 [`2026-09-07-ohmymemo-dream-output-budget-and-salvage.md`](2026-09-07-ohmymemo-dream-output-budget-and-salvage.md)，run-local 工具权限、exact replay 和崩溃恢复的详细设计见 [`2026-09-10-ohmymemo-dream-tool-driven.md`](2026-09-10-ohmymemo-dream-tool-driven.md)。
>
> **事实源边界**：本文是“证据工作单元、容量恢复、逐批 cursor 提交和长期演进顺序”的权威文档；9 月 10 日文档继续是 dream tools 的权限、安全、schema、Store replay 和单批完成协议的权威文档。两者冲突时，以本文对批处理和 cursor 的新决策为准。

## 1. 执行摘要

本次已发生的故障不是模型容量耗尽，而是**输出解析分类错误**：两次 maintenance turn 都以 `completed (stop)` 正常结束，正文是完整闭合的 `{"memories":[...]}`，但外层带有 ` ```json ` 围栏。`parseJsonObject()` 只接受裸 JSON，解析失败后无条件进入 prefix salvage；salvage 又无条件返回 `truncated=true`，最终被 Manager 翻译成错误的 `max-token ceiling` 诊断。

因此 09-11 和 09-13 的 9 条、7 条记忆均完整落地，没有证据漏采。此前依据 `truncated=true` 推断真实 `max-tokens`、隐藏推理耗尽和不可恢复漏采，均不适用于这三次 run。当前数据只能证明 parser fallback 与真实截断混为一类，不能证明近期发生过容量截断。

潜在可靠性问题仍然存在：如果未来 turn **真实**以 `max-tokens` 结束，legacy salvage 仍可能只恢复前缀，却把整份 fitted evidence window 的 cursor 推进。长期方案仍应把梦境提取改造成可恢复消费系统，但实施顺序必须先修复分类并建立可信基线：

1. **WHAT：结束原因与解析恢复正交化。** `turnEndReason` 来自 Session 事件；`outputFormat` 描述裸 JSON、围栏 JSON或前缀 salvage；`truncated` 只由真实 `max-tokens` 决定。
2. **WHAT：tool-only 显式完成协议。** 每条记忆通过 run-local `dream_memory_remember` 独立提交；模型处理完整个小批后必须调用 `dream_memory_complete`。
3. **WHAT：确定性微批。** 一个 scheduled run 拆成多个有界 evidence batch；每批独立完成、独立审计、独立提交 cursor。
4. **WHAT：容量自愈。** 只有真实 `max-tokens` 且没有 complete 时，当前批不消费；Host 自动缩小批次并重试，必要时按明确策略降低 effort。
5. **WHAT：at-least-once + exact replay。** 已写记忆不回滚；重试由 Store 锁内 exact replay 变成幂等 no-op。
6. **WHAT：结构化可观测性。** 记录每批的输入规模、模型路由、effort、token usage、事件结束原因、解析格式、完成信号、重试和 cursor commit，不再从 `truncated` 或英文 detail 猜运行状态。

第一目标是让观测事实可信；长期目标才是让真实容量不足只增加成本或延迟，不能静默丢失尚未确认处理完的证据。

## 2. 现状事实

### 2.1 已确认的运行数据

从三份 maintenance Session 的 `session.v3.jsonl` 解压核对得到：

| 日期 / Run | turn/end | 正文 | strict JSON | 审计结果 |
|---|---|---|---|---|
| 09-11 `f204e68d` | `completed (stop)` | 4545 字符、9 条、完整闭合、带 `json` 围栏 | fail | `truncated=true` |
| 09-12 `a577df2d` | `completed (stop)` | 3545 字符、10 条、完整闭合、无围栏 | pass | `truncated=false` |
| 09-13 `ba2741f8` | `completed (stop)` | 3039 字符、7 条、完整闭合、带 `json` 围栏 | fail | `truncated=true` |

三次 run 均没有 `max-tokens`，三份正文都完整闭合，模型给出的 7/9/10 条全部落地且 `rejected=0`。因此：

- 09-11、09-13 是 parser fallback 假警报；
- 没有证据表明这三轮发生了容量截断或漏采；
- 现有历史 `truncated` 指标已被输出格式恢复污染，不能用于截断率基线；
- token usage 只能作为成本观测，不能反推本次结束原因；结束原因必须以 `turn/end.reason.kind` 为事实源。

模型仍声明 131072 的最大输出，而插件请求 16384；这说明未来存在容量边界，但不能把配置差异当作已发生事故的证明。

### 2.2 当前代码语义

当前生产路径仍是 legacy JSON，实际控制流是：

1. `manager.ts` 收集并拟合一个全局 evidence window；
2. 创建无工具 maintenance Agent；
3. 要求最终输出 `{"memories":[...]}`；
4. Manager 先接受 `completed` 或 `max-tokens` 两种 turn outcome；
5. `parseDreamOutput()` 对正文直接执行裸 `JSON.parse`；
6. **任何** parse error 都进入 `salvageDreamOutput()`，并在有完整对象前缀时无条件返回 `truncated=true`；
7. Manager 再计算 `progress.truncated = outcome === 'max-tokens' || parsed.truncated`；
8. `finishRun()` 只要看到 `truncated=true` 就写入 `max-token ceiling` 文案；
9. 成功后提交整个 window 的 cursor patch。

这造成三个本应独立的概念被压成一个布尔值：

- Session 事件为什么结束；
- 输出是否需要格式规范化或 prefix salvage；
- 输出是否真的被截断。

本次实际问题是第一项为 `completed`、第二项为 fenced JSON normalization、第三项为 false，却被记录成了第三项 true。真正的 prefix truncation 风险尚未在这三次 run 中发生，但当前代码在它发生时仍会把“前缀可用”误等同于“整个输入窗口处理完毕”。

### 2.3 已完成但尚未接入的基础

工具驱动迁移不是从零开始，阶段 0/1 已落地：

- `dream-tools.ts` 已有 opaque evidence、schema、ledger、slot/repair 配额和安全错误；
- `dream.ts` 已有 tool-only prompt；
- `service.ts` 已有内部 `rememberFromDream()`；
- `store.ts` 已有 `createDreamMemory()` 和 writer-lock 内 exact replay；
- 纯函数、Store 和 Service 已有对应测试。

当前缺口集中在 Manager 接线、持久状态升级、逐批消费和真实组合验证。

## 3. WHY：为什么必须长期改造

### 3.1 先有可信分类，才有容量治理

这次误判说明 `truncated` 既不是可靠事件字段，也不是可用指标。若把 parser fallback 数量当作模型截断率，后续会错误调整 effort、token、batch 大小，甚至用一个不存在的容量事故论证架构改造。

结束原因必须原样来自 `turn/end.reason.kind`；输出是否带围栏、是否经过 prefix salvage 是另外两组事实。阶段性指标和自适应策略只能消费结构化的真实结束原因，不能消费兼容解析器的返回路径。

### 3.2 Cursor 必须代表确认消费，而不是“拿到了一些结果”

Cursor 是下一轮是否还会读取某段用户证据的唯一持久边界。它的正确含义只能是：

> Host 已获得模型对该工作单元的显式完成声明，并且所有已接受写入、审计与状态提交满足提交条件。

“模型返回了部分合法对象”不证明它检查了所有输入，也不证明未输出部分没有合格记忆。把 salvage success 作为 cursor ack 会把容量故障转化成静默数据损失。

### 3.3 单个 96KB window 不是可靠的事务单位

输入有界只说明不会无限增长，不说明它适合成为一次原子消费单元。一个 window 可以包含 12 个 Session 和几十条长消息；任何一次模型截断、provider 抖动、取消或 Host 中断都会影响整窗。

可靠系统需要把故障半径限制在小批：已完成批次可以提交，未完成批次可以重放，后续批次尚未开始。不能要求一次随机长度的模型生成承担整夜证据的唯一 ack。

### 3.4 单纯提高 token 只能降低概率

本次三轮数据不支持“立即把 16384 提高到 32768”的事故结论；是否调整必须等分类修复后的真实容量基线。即使未来观测证明需要提高，它也只是容量参数，不是正确性机制：

- 推理模型在高 effort 下仍可能用尽更高预算；
- provider 可能调整实际限制或 token 统计方式；
- 输出条数、内容语言和工具调用轨迹都会改变消耗；
- 更高上限提高单次最坏成本和运行时间；
- 任何有限上限最终都存在截断边界。

正确性不能依赖“这次大概够用”。

### 3.5 仅把最终 JSON 换成 NDJSON 仍然不够

NDJSON 能简化逐行 salvage，却无法证明模型处理了整个输入。只要没有独立完成信号，Host 仍需在“推进 cursor”与“重跑可能重复”之间猜测。

显式 `dream_memory_complete` 才是模型侧 ack；Store exact replay 才是 Host 侧重试基础。两者必须同时存在。

### 3.6 仅完成 tool-only 仍有大窗口重试问题

9 月 10 日设计解决了逐条提交、完成信号、权限和幂等，但仍按单个全局 evidence window 推进 cursor。如果 96KB window 在 complete 前达到 token 上限，虽然不会再漏采，却可能每晚重放整个窗口；工具调用历史还会增加上下文成本。

因此 tool-only 是必要条件，微批才让它成为长期可运营方案。

## 4. 设计原则

### 4.1 事实正交原则

事件结束原因、输出包装格式、解析完整性、协议完成信号和 cursor 资格必须分别建模。一个字段不能同时表达“模型为什么停”“解析器走了哪条兼容路径”和“证据是否处理完”。

### 4.2 完成信号原则

只有 Host 可验证的 `dream_memory_complete` 才能授予当前 batch 的正常 cursor commit 资格。最终文本、turn `completed`、已创建条数、格式规范化或 salvage 前缀都不是 tool-only 的完成信号。

### 4.3 最小确认单元原则

Cursor 按 batch 提交，不按整个 scheduled run 一次性提交。一个批次失败不能回滚之前已确认批次，也不能消费自己和后续批次。

### 4.4 At-least-once 原则

未确认批次必须允许重放。已落库记忆不做跨记录回滚；相同 source fingerprint 与 canonical payload 的重放由 Store 返回 `already-present`，不得创建副本或重复 journal。

### 4.5 Host 掌控边界原则

模型只决定哪些事实值得保存及其语义字段。Host 决定 evidence 身份、来源、scope 解析、固定产品字段、配额、批次、cursor、重试、完成资格和持久提交。

### 4.6 容量故障可恢复原则

`max-tokens` 是容量信号，不是成功，也不应立即成为死信。Host 应先缩小当前批次；缩到最小批仍失败后，才按有界策略调整 effort 或进入跨 run failure streak。

### 4.7 显式降级原则

任何 effort 降级、legacy rollback、批次拆分、dead-letter 跳过都必须进入结构化审计和 UI。系统不得静默改变模型策略或消费证据。

### 4.8 有界成本原则

每个批次、每次重试、每条记忆修复和整个 run 都有上限。可靠性不能演变为无限模型调用。

## 5. WHAT：目标架构

### 5.1 输出分类层

在切换 tool-only 前，先把 legacy 输出处理拆成两个步骤：

1. `classifyTurnEnd(events)` 只读取 Session 事件，产出 `turnEndReason`；
2. `parseLegacyDreamOutput(output, turnEndReason)` 根据结束原因选择严格解析、格式规范化或截断 salvage。

围栏兼容只接受**锚定整个正文、至多一层、语言标记为空或 `json`** 的 Markdown fence。去掉 fence 后必须对完整内文执行 `JSON.parse` 和现有全量 proposal/grounding 校验；不得从任意 prose 中搜索 JSON 子串。合法围栏输出记录为 `outputFormat='json-fence'`、`formatRecovered=true`、`truncated=false`。

Prefix salvage 只允许在 `turnEndReason='max-tokens'` 且完整 JSON 解析失败时执行。`completed` 下的其他畸形输出属于确定性协议错误，不能因为内部恰有完整对象而 salvage。

结构化分类至少包含：

```ts
interface DreamLegacyOutputClassification {
  turnEndReason: string
  outputFormat: 'bare-json' | 'json-fence' | 'prefix-salvage' | 'invalid'
  formatRecovered: boolean
  outputComplete: boolean
  truncated: boolean
  salvagedItems: number
}
```

其中 `truncated` 的唯一来源是 `turnEndReason === 'max-tokens'`；`formatRecovered` 不得影响它。兼容矩阵：

| turn end | 输出 | 结果 |
|---|---|---|
| `completed` | 完整裸 JSON | 正常成功，`truncated=false` |
| `completed` | 完整单层 JSON fence | 格式恢复成功，`truncated=false` |
| `completed` | 畸形/前缀 JSON | 协议失败，不 salvage |
| `max-tokens` | 不完整但有合法对象前缀 | legacy prefix salvage，`truncated=true` |
| `max-tokens` | 无可用前缀 | 容量失败，`truncated=true` |
| 其他 end reason | 任意正文 | 按对应失败分类，不解析成成功 |

历史 v1 audit 没有 `turnEndReason/outputFormat`，不得仅根据 `truncated=true` 自动迁移成真实容量事故。旧记录统一标记 `legacy-classification-ambiguous`；已人工核验的三次 run 可在决策记录中说明，但不回写或伪造缺失的持久事件字段。可信截断率从分类修复上线后的新 run 开始计算。

### 5.2 三层工作单元

梦境提取分成三层：

- **Run**：一次 manual/scheduled/catch-up 调度，负责 lease、source snapshot、batch plan、总体状态和 maintenance/curator。
- **Batch**：可独立完成和提交 cursor 的最小消费单元，拥有稳定 `batchWindowHash`、opaque evidence map、Agent turn/attempt 和 batch audit。
- **Item**：一次逻辑记忆提案，使用 slot；通过 `dream_memory_remember` 独立写入或 exact replay。

Run 成功不再是 cursor 的唯一提交点。每个 Batch 完成后立即提交自己的 cursor patch；Run 负责汇总已完成、未完成和跳过的批次。

### 5.3 确定性 BatchPlan

Host 从当前 source snapshot 生成 `BatchPlan`：

```ts
interface DreamBatchPlan {
  batchId: string
  ordinal: number
  protocolVersion: 'dream-tool/v2'
  evidenceWindowHash: string
  sessionRanges: Array<{
    sessionId: string
    fromSeqExclusive: number | null
    throughSeqInclusive: number
    messageCount: number
  }>
  messageCount: number
  transcriptBytes: number
  maxMemories: number
}
```

规划规则：

1. 延续现有 append-origin、direct-human、secret、lookback 和 maintenance-session 排除规则。
2. 每个 Session 内按 seq 升序，只取当前 cursor 之后的 eligible messages。
3. 在不打破各 Session seq 前缀的前提下，按 `(time, sessionId, seq)` 稳定归并。
4. 按 `batchTranscriptBytes`、`batchMaxMessages` 和 `batchMaxSessions` 三个上限切批；任何一条超长消息继续使用现有字符/bytes 拟合。
5. 同一 Session 跨批时，后批只能包含前批 `throughSeqInclusive` 之后的消息。
6. `evidenceWindowHash` 在 opaque ID 生成前计算，覆盖 canonical evidence、scope availability、limits、协议版本和 planner 版本。
7. `batchId` 可以带 run-local 随机性；failure streak 与 replay 身份只能依赖稳定 window hash，不能依赖 batchId/promptHash。

首版建议保守默认值：

```yaml
batchTranscriptBytes: 16384
batchMaxMessages: 16
batchMaxSessions: 4
batchMaxMemories: 6
maxBatchesPerRun: 12
```

这些是 Cordis manager row 的 operator 配置，不进入用户记忆 `config.yaml`，首版也不增加普通 UI 控件。上线后根据实测分布调整，而不是把默认值当协议常量。

### 5.4 Tool-only Batch 协议

每个 Batch 执行以下协议：

1. 为本批 evidence 创建 run-local opaque handles。
2. maintenance Agent 只看见 `dream_memory_remember` 和 `dream_memory_complete`。
3. 模型逐条串行调用 remember；Host 校验 quote、scope、secret、slot 和配额。
4. 每次 `created`、`already-present`、policy rejection 后更新 body-free batch progress checkpoint。
5. 模型处理完全部 evidence 后调用一次 complete。
6. complete 成功且没有 fatal/protocol/abort latch，Batch 才成为 `commit-eligible`。
7. Manager 先写 terminal batch audit/commit intent，再 fenced commit batch cursor，最后标记 audit applied。
8. 注销本批 tools 和 opaque map，再进入下一批。

不得在同一 Batch 自动切回 legacy JSON，也不得读取最终 assistant 文本作为备用结果。

### 5.5 逐批 Cursor

每个 Batch 只提交它实际覆盖的、逐 Session 连续 seq 前缀：

- `completed`：提交本批 cursor patch；
- `partial`：模型明确 complete，但存在被放弃/政策拒绝 item，仍提交本批 cursor patch；
- `capacity-retry`：未 complete，不提交；
- `error/cancelled`：不提交本批；
- `dead-lettered`：达到稳定 window 的阈值后，显式记录损失并提交本批 cursor patch；
- 后续尚未执行 Batch：不提交。

如果 Run 的前 3 批完成、第 4 批失败，则前 3 批 cursor 保留，第 4 批和后续批次在下次 Run 重新规划。UI 必须显示“已完成 3/计划 N 批”，不能笼统显示整轮成功。

### 5.6 Run 状态

建议把提取结算与调度执行结果分开：

```ts
type DreamRunSettlement =
  | 'success'       // 全部计划批次完成，无放弃
  | 'partial'       // 全部计划批次已消费，但有 item 放弃/拒绝
  | 'incomplete'    // 至少一个批次未消费，后续可重试
  | 'dead-lettered' // 至少一个批次被显式跳过
  | 'cancelled'
  | 'error'
```

Jobs 层映射：

- `success`、`partial` -> `completed`；
- `incomplete`、`dead-lettered`、`error` -> `failed`；
- `cancelled` -> `killed`。

`lastSuccessAt` 只在整个 Run 的计划批次全部得到正常消费（success/partial）时更新。逐批 cursor commit 与 `lastSuccessAt` 解耦：前者表示证据消费事实，后者表示整轮健康度。

## 6. HOW：容量自愈策略

### 6.1 默认执行策略

正常批次使用用户选择的 provider/model/effort。长期仍建议梦境提取默认或 UI 推荐 `medium`，因为任务是受 Host 严格校验的结构化筛选，`max` 的边际质量收益不值得其容量波动；但系统不得在第一次尝试时覆盖用户显式选择。

分类修复上线时先保持 `agentMaxTokens=16384` 和现有用户 effort，不把假警报转化为未经证实的参数调整。获得可信基线后，若真实 `max-tokens` 或成本/时延数据支持，再单独评估 32768 或 effort 推荐值；任何调整都只是工程余量，不是正确性保障。实际请求上限、模型声明和 provider 响应必须进入审计。

### 6.2 Capacity 容量恢复阶梯

当 turn 以 `max-tokens` 结束且 ledger 没有成功 complete：

1. 关闭当前 batch tool scope；已经写入的 item 保留。
2. 不提交当前 Batch cursor。
3. 若 Batch 含多条 evidence，将未确认 Batch 按同一确定性 planner 二分为两个子批。
4. 先处理前半，再处理后半；每个子批独立 complete 和提交。
5. 如果已缩到单条 evidence 仍 `max-tokens`，允许一次审计可见的 effort 降级重试：`max -> high -> medium`，最多下降一级或由 operator 配置固定阶梯。
6. 若最小批、最大允许 token、允许的 effort 重试仍失败，结束本 Run 为 `incomplete`，保留稳定 failure streak，等待下一次调度。
7. 相同 `evidenceWindowHash + protocolVersion + effectivePolicy` 连续达到 dead-letter 阈值后，才允许显式跳过，并在 UI 标明证据范围和原因。

首版每个原始 Batch 建议最多 3 次容量 attempt，整个 Run 最多 16 次模型 step/批次调用预算之外的重试。具体计数必须由 Host ledger 强制。

### 6.3 为什么先拆批、后降 effort

拆批保持用户选择的模型策略，只缩小故障单元；降 effort 会改变模型行为，应作为第二级恢复并明确审计。对单条 evidence 仍因 `max` 推理耗尽的情况，降 effort 比继续增大输入/输出预算更可控。

### 6.4 已写 Item 的重试

capacity retry 可能发生在若干 remember 已成功之后。重试时模型可能再次提出相同记忆：

- 同 source fingerprint + canonical payload -> `already-present`；
- 同 durable write key + 不同 payload -> idempotency conflict，返回不可重试政策错误；
- tombstone 必须优先于 replay，遗忘记录不得复活；
- 换措辞造成不同 durable identity 的残余重复风险仍由 key policy/Curator 治理，不在重试层做 embedding 或模糊覆盖。

## 7. 持久状态与审计

### 7.1 Manager Domain

`dsh_ohmymemo_manager` 从 v1 升级到 v2。除 9 月 10 日方案已有的 run activeProgress/commitIntent 外，增加 Batch 维度：

```ts
interface DreamBatchProgress {
  batchId: string
  ordinal: number
  parentWindowHash: string
  evidenceWindowHash: string
  plannerVersion: string
  phase: 'planned' | 'extracting' | 'completed' | 'committing' | 'applied' | 'failed'
  sourceSessions: Array<{ sessionId: string; throughSeq: number; messageCount: number }>
  sourceMessages: number
  transcriptBytes: number
  attempt: number
  effectiveProvider: string
  effectiveModel: string
  configuredEffort: string
  effectiveEffort: string
  requestedMaxTokens: number
  turnEndReason: string | null
  outputFormat: 'tool-only' | 'bare-json' | 'json-fence' | 'prefix-salvage' | 'invalid'
  formatRecovered: boolean
  outputComplete: boolean
  inputTokens: number | null
  outputTokens: number | null
  createdIds: string[]
  alreadyPresentIds: string[]
  rejectedCount: number
  explicitlyCompleted: boolean
  cursorPatch: Record<string, number>
  cursorCommitted: boolean
}
```

禁止持久化 evidence 正文、quote、cwd、opaque ID map、模型隐藏 reasoning 内容或 secret detector 命中正文。

### 7.2 Audit

每个 Run 保留总审计，每个 Batch 保留 bounded 子审计。至少记录：

- planner/protocol/execution mode；
- planned/completed/partial/retried/dead-lettered batch 数；
- configured/effective route 与 effort；
- requested model limit 与 provider 可观察 token usage；
- transcript bytes/messages/sessions；
- `turnEndReason`、`outputFormat`、`formatRecovered`、`outputComplete`、complete observed、tool calls/errors/repairs；
- created/already-present/rejected；
- cursor commit intent、commit result、appliedAt；
- capacity split 的 parent/child hash 关系；
- dead-letter reason 和明确跳过的 session seq ranges。

`detail` 只用于人类补充说明，不再承担状态解析。UI 和恢复逻辑只能读取结构化字段。

### 7.3 崩溃恢复

沿用 9 月 10 日的 fenced commitIntent，粒度从 Run 扩展到 Batch：

- Store commit 后、Batch complete 前崩溃：记忆保留，cursor 不推进，下次 exact replay；
- Batch complete checkpoint 后、terminal audit 前崩溃：cursor 不推进，重跑；
- terminal batch audit 后、cursor state commit 前崩溃：恢复按 claim token/state generation 幂等补提交；
- cursor commit 后、audit ack 前崩溃：state 中 `lastAppliedBatchHash` 证明已提交，只补 ack；
- 已进入后续 Batch 时，旧 intent 不得覆盖更高 cursor 或新的 active identity。

Run-level terminal audit 不得重新提交已经由 Batch commit 的 cursor，只汇总事实。

## 8. Legacy 与兼容策略

### 8.1 Legacy JSON 定位

legacy JSON 仅作为 operator 显式回滚模式保留，且必须显示 degraded：

- legacy run 保留现有 strict/salvage parser；
- legacy salvage 可以落库完整前缀，但**不再获得正常 cursor commit 资格**；
- 若必须保留旧“salvage 后推进”行为，只能使用单独的 `legacy-lossy` 内部模式并在 UI 显示会漏采；默认和普通配置不可启用；
- tool-only 不做同 run JSON fallback。

这修订了 9 月 10 日设计中“legacy 成功通过旧解析即可推进”的宽松规则。长期正确性不能因为 rollback 而静默退回已知有损语义。

### 8.2 升级兼容

- v1 state/audit 通过显式 migration 读入 v2；
- 旧 `{promptHash,count}` failure streak 不继承到 tool-v2；
- 旧 `truncated=true` audit 原样保留，但统一按 `legacy-classification-ambiguous` 展示，不计入真实截断率；
- v2 domain 不承诺旧二进制可读，二进制回滚前必须备份并验证 migration；
- execution mode 在 claim 时固定，HMR/配置变更不影响活动 Run。

### 8.3 Legacy 移除

默认 tool-only 上线后至少经过两个 RC 且不少于 14 天 dogfood。验证期覆盖多模型、max effort、capacity split、manual/scheduled/catch-up、取消和崩溃；无 blocker 后在下一 minor 删除 legacy 生产路径。

## 9. Curator 边界

本次不把 Curator 一并工具化。Curator 继续是提取完成后的独立阶段，但做以下约束：

- 只处理本 Run 已正常 complete 的 Batch evidence；
- 不因未完成 Batch 扩大 curator 输入；
- 使用 opaque `evidenceId + quote` grounding；
- Curator 失败只进入 curator detail，不回滚已提交 Batch cursor；
- confirmed/sensitive 条目继续不进入可修改 catalog；
- Curator 的 refresh/merge 工具化另立设计。

如果 Run 在中间 Batch 失败，仍可对已完成批次运行 Curator，但必须在审计中标明 evidence coverage；首版为降低状态复杂度，也可以只在所有计划 Batch 完成后运行 Curator。

**首版决策：仅在所有计划 Batch 正常消费后运行 Curator。** 这避免 Curator 与中断恢复交错，后续如有明确收益再放宽。

## 10. UI 与运维体验

设置页不再只显示一条英文诊断，至少展示：

- 当前阶段：规划 / 第 X/N 批提取 / 容量拆批 / 提交 / 维护；
- route：provider、model、configured effort、effective effort；
- 最近结果：success / partial / incomplete / dead-lettered / cancelled / error；
- 批次统计：计划、完成、重试、拆分、未完成；
- 记忆统计：created、already-present、rejected；
- cursor：已提交批次和“下次将重扫”的未提交批次；
- 输出信息：turn end reason、output format、format recovered、output complete；
- 容量信息：requested max、可观察 input/output tokens；
- legacy mode 的降级标识。

普通用户仍只选择模型和 effort，不暴露 batch bytes、repair count、dead-letter threshold 等 operator 参数。诊断信息默认简洁，详细字段可折叠展示。

## 11. 实施阶段

### 阶段 A：修复解析分类并建立可信基线

WHAT：

- 接受完整、单层、锚定全文的裸 JSON 或 fenced JSON；
- 只有 `turn/end.reason.kind === 'max-tokens'` 才允许 prefix salvage 并设置 `truncated=true`；
- audit/summary 增加 `turnEndReason`、`outputFormat`、`formatRecovered`、`outputComplete` 和 `salvagedItems`；
- 设置页根据结构化字段显示“格式已规范化”“真实容量截断”或“输出协议错误”；
- 保持当前 `dream_effort=max` 和 `agentMaxTokens=16384`，不基于假警报调参。

WHY：

- 当前 `truncated` 指标被围栏输出污染，任何截断率、effort 或 batch 结论都不可信；
- 事件结束原因必须成为容量治理的事实源；
- fenced JSON 是完整输出格式兼容，不应伪装成截断或 dead-letter 输入。

HOW：

- 先在 Manager 读取并固定 `turnEndReason`，再把它显式传给 legacy parser；
- 将 fenced normalization 与 prefix salvage 拆成不同函数和返回类型；
- normalization 只剥离一层锚定全文的 fence，随后仍执行完整 `JSON.parse`、shape 和 grounding 校验；
- `completed + malformed prefix` 直接成为确定性输出错误，不走 salvage；
- 历史 v1 `truncated` 标为 ambiguous，不纳入新指标，也不回写猜测的 end reason；
- 上线后连续观察至少 3 个 scheduled run，只按 `turnEndReason` 统计真实 max-token 率，同时记录格式恢复率、成本、时长和每条有效记忆成本。

阶段 A 是后续容量设计的测量前置条件。观察窗口内没有真实 `max-tokens` 也不能取消 tool-only 改造，因为显式完成和安全重试解决的是协议正确性，不依赖近期事故频率。

### 阶段 B：完成 tool-only Manager 接线

WHAT：

- 注册 run-local remember/complete tools；
- Manager 改以 ledger complete 判定消费；
- legacy 路径显式隔离；
- 接入已经存在的 Store exact replay seam。

WHY：

- 消除最终 JSON 的单点完成歧义；
- 让每条政策错误可在同一回合修复；
- 为安全重试建立幂等基础。

HOW：

- 按 9 月 10 日文档的阶段 2/3 实现；
- tool-only 下删除生产 salvage 调用；
- 没有 complete 的 `completed/max-tokens` 都按协议未完成处理；
- 先保持单 Batch，冻结协议行为后再引入 planner。

### 阶段 C：引入 deterministic BatchPlan 和逐批 cursor

WHAT：

- 把一个 Run 拆成多个小 Batch；
- 每批独立 Agent 协议、audit、commitIntent 和 cursor commit；
- Run 汇总多批结果。

WHY：

- 将容量和基础设施故障半径从整夜窗口缩小到一个批次；
- 已完成工作无需因后续失败而重做。

HOW：

- 先实现纯 `planDreamBatches()` 和性质测试；
- 确保每个 Session 的消息跨批保持 seq 前缀；
- Manager 串行执行 Batch，首版不并行；
- 每批 commit 后重新读取/校验 state generation；
- maxBatches 达限时停止为 `incomplete`，未规划完的证据不推进。

### 阶段 D：容量自适应

WHAT：

- `max-tokens/no-complete` 自动二分当前 Batch；
- 最小批可按受控阶梯降 effort；
- 加入 run/attempt 成本上限。

WHY：

- 固定 batch 默认值不能覆盖所有模型、语言和消息长度；
- 自动恢复减少人工调参和隔夜等待。

HOW：

- split 关系进入稳定 audit；
- 子批重新计算 window hash 和 cursor patch；
- 已写 item 通过 exact replay 收敛；
- 所有自动 effort 变化显式展示；
- provider/timeout/Store 错误不触发容量二分。

### 阶段 E：UI、dogfood 与 legacy 移除

WHAT：

- 上线结构化 Batch 进度和 incomplete/dead-letter 展示；
- 做 scratch Home、真实模型和 Desktop GUI 验收；
- 满足观察窗口后删除 legacy。

WHY：

- 后台系统不能只靠日志判断是否漏采；
- tool capability 和 concludeTurn 必须在打包 runtime 中验证，不只依赖单测。

HOW：

- source-linked 与 packaged runtime 各跑一次；
- 至少覆盖 GLM max/medium、默认模型、零记忆、政策拒绝、capacity split、cancel、crash 和 catch-up；
- 两个以上 RC、14 天以上稳定后删除 legacy 生产路径。

## 12. 测试矩阵

### 12.1 结束原因与解析分类

- `completed + bare JSON`：strict success、`truncated=false`；
- `completed + 完整 json fence`：normalization success、`formatRecovered=true`、`truncated=false`；
- `completed + 完整无语言 fence`：同上；
- `completed + fence 外 prose/双重 fence/非 json 标记`：协议失败；
- `completed + 只含若干完整 item 的畸形前缀`：协议失败，不 salvage；
- `max-tokens + 不完整 JSON + 合法 item 前缀`：salvage success、`truncated=true`；
- `max-tokens + 无完整 item`：容量失败、`truncated=true`；
- `error/aborted/interrupted + 可解析 JSON`：仍按 turn end 失败，不误记成功；
- 围栏 normalization 后的每个 item 继续执行 shape、grounding、quote 和 secret 全量校验；
- Manager detail/UI 由结构化分类渲染，不再由 `truncated` 单字段生成固定 max-token 文案；
- pre-v2 `truncated=true` 迁移后为 ambiguous，不计入 max-token 指标。

### 12.2 Planner 性质测试

- 相同 source/config 生成相同 batch ranges/window hashes；
- 任意 Session 在各批中的 seq 严格递增且无重叠；
- 已提交前 N 批后重新规划，只产生剩余 evidence；
- bytes/messages/sessions/memories 上限全部生效；
- 单条超长消息确定性截短，不产生空 Batch；
- 时间乱序不会让高 seq 越过未处理低 seq；
- maxBatches 截断计划时，未计划 evidence cursor 不前进。

### 12.3 协议与容量

- remember 0..N 次后 complete 成功；
- `max-tokens` 且无 complete 不提交 cursor；
- 已 created 后 max-tokens，重试返回 already-present；
- 原 Batch 二分后两个子批分别提交正确 cursor；
- 第一子批成功、第二子批失败，只保留第一子批 cursor；
- 单 evidence max-tokens 触发一次 effort 降级并记录 configured/effective 值；
- provider error、timeout、Store busy 不误触发容量 split；
- retry/run 上限耗尽后为 incomplete，不 dead-letter、不推进当前批。

### 12.4 状态、事务与恢复

- 每个 batch commitIntent 的 claim token/state generation fence；
- terminal audit/state 两次写之间崩溃可幂等前滚；
- 旧 batch intent 不覆盖 newer cursor/lastResult；
- Run summary 不重复提交 batch cursors；
- cancel 保留已提交批，当前批不提交；
- v1 -> v2 migration 可重复执行；
- retention 不删除未 applied commit intent。

### 12.5 安全与 Store 回归

- maintenance Agent 只见两个 dream tools；
- opaque evidence 跨 batch/run 不可重放；
- exact quote、append-origin、direct-human、secret 三层检查保持；
- tombstone 优先于 replay；
- workspace scope 必须由 Host 解析已有 cwd scope；
- 模型不能提交 source/cwd/privacy/pinned/confirmed/cursor；
- ordinary memory tools 和 Store CAS 行为不变。

### 12.6 真实验收

- scratch `DSH_HOME` 冷启动并执行 manual/scheduled/catch-up；
- 人为设置极低 max tokens，稳定触发 split 并最终完整消费；
- 在 created 后、complete 前取消，重跑不生成副本；
- Desktop 设置页实时显示 Batch 进度，无文本重叠或状态误导；
- 连续运行至少 14 天，统计截断率、自动恢复率、dead-letter 数和单位记忆成本。

## 13. 可观测指标与发布门槛

建议按最近 60 次 Run/Batch 保留以下聚合：

- `turn_end_reason` 分布（真实结束原因事实源）；
- `output_format` 与 `format_recovery_rate`；
- `invalid_output_rate`；
- `batch_completion_rate`；
- `capacity_retry_rate`；
- `capacity_recovery_rate`；
- `dead_letter_batch_count`；
- `cursor_lag_messages` 与最老未消费时间；
- `created_per_1k_input_tokens`；
- `already_present_rate`；
- `policy_rejection_rate`；
- p50/p95 batch duration；
- configured/effective effort 分布；
- provider/model 维度、仅按 `turnEndReason='max-tokens'` 统计的真实 max-token 率。

Tool-only 成为默认的发布门槛：

1. 无 complete 时没有任何正常 cursor commit；
2. 已写后重放不产生副本；
3. capacity split 能在低 token 故障注入下最终消费全部证据；
4. crash/cancel 只影响当前未确认 Batch；
5. packaged runtime 的 tool error continuation 与 concludeTurn 行为通过；
6. v1 数据升级后历史 cursors/runs 可读；
7. GUI 能区分“创建了部分记忆”和“证据已完整消费”。

Legacy 删除门槛：

- 至少两个 RC 且不少于 14 天；
- 默认模型与 GLM 路由均覆盖；
- 无未解释 cursor 跳跃、重复写或未决 commitIntent；
- capacity recovery 成功率达到 99%，dead-letter 为 0 或每个都有人工确认原因；
- rollback 演练和 domain backup 恢复通过。

## 14. 风险与取舍

| 风险 | 影响 | 控制 |
|---|---|---|
| Tool 调用增加模型 step 和 token 成本 | 单 Run 成本上升 | 小 Batch、严格 slot/repair/run 上限、统计单位记忆成本 |
| 单批跨 Session 减少，模型更难全局去重 | 可能生成近重复记忆 | Batch 允许最多 4 个 Session；exact replay 处理同源重放；Curator 治理近重复 |
| 逐批 state/audit 写放大 | 本地 domain 写入增加 | body-free checkpoint、bounded retention；正确恢复优先于微小写放大 |
| 自动 effort 降级改变质量 | 个别重试判断更保守或更宽松 | 先拆批后降级、最多一级、结构化审计、Host grounding 不变 |
| Batch planner 复杂度引入 cursor bug | 跳过或重复证据 | 纯函数、性质测试、逐 Session seq 前缀不变量、fenced commit |
| v2 domain 阻碍二进制回滚 | 旧版本可能无法读取新状态 | 同版本 legacy rollback、升级前备份、显式 migration、发布演练 |
| Dead-letter 仍会造成有界损失 | 极端毒窗口被跳过 | 先完成容量恢复阶梯；结构化展示具体 seq ranges；后续可增加人工重放入口 |

## 15. 不做的事

本次长期改造明确不做：

- 不通过无限提高 `agentMaxTokens` 代替完成协议；
- 不把 salvage 前缀当作完整 Batch 成功；
- 不做同 run tool -> JSON 自动 fallback；
- 不把通用 `memory_remember/update/forget` 开放给 maintenance Agent；
- 不引入整 Run 跨记录事务或回滚已创建记忆；
- 不用 embedding/LLM 相似度参与 cursor、幂等或安全决策；
- 不让模型决定 session/cwd/source/cursor；
- 不并行执行 Batch，首版保持串行确定性；
- 不在本次改造中工具化 Curator；
- 不把 operator 批次参数暴露成普通用户设置项。

## 16. 涉及文件

| 文件 | 主要改动 |
|---|---|
| `plugin/dsh-ohmymemo/src/manager.ts` | tool-only 接线、Batch loop、capacity retry、逐批 commit、Run 汇总 |
| `plugin/dsh-ohmymemo/src/dream.ts` | end reason 感知的 legacy parser、fence normalization、deterministic planner、tool-v2 prompt/window hash |
| `plugin/dsh-ohmymemo/src/dream-tools.ts` | Batch identity、effective policy、ledger/usage 汇总 |
| `plugin/dsh-ohmymemo/src/manager-contract.ts` | v2 state/audit/summary、Batch progress、settlement |
| `plugin/dsh-ohmymemo/src/manager-domain.ts` | v1 -> v2 migration、batch commitIntent |
| `plugin/dsh-ohmymemo/src/service.ts` | 复用并收紧 `rememberFromDream()`，原则上不扩大服务面 |
| `plugin/dsh-ohmymemo/src/store.ts` | 保持 exact replay/tombstone 契约，仅补必要恢复查询 |
| `plugin/dsh-ohmymemo/src/client/*` | Batch 进度、结构化诊断、incomplete/dead-letter 展示 |
| `plugin/dsh-ohmymemo/tests/*` | planner、协议、容量、恢复、迁移、UI 与真实组合测试 |
| `plugin/dsh-ohmymemo/README.md` | 当前行为、operator 配置、兼容和运维说明 |
| `docs/ohmymemo-memory-space.md` | 链接本方案并更新当前运行语义 |
| `docs/plugins-catalog.md` | 发版时记录插件版本沿革，不复制契约正文 |

按仓库规则，实际契约变更同 PR 更新 `docs/ohmymemo-memory-space.md` 和包内 README；历史 note 不改写，后续修订继续新增日期化 note 并在新文档中声明取代范围。

## 17. 最终验收标准

长期改造完成必须同时满足：

1. `turnEndReason` 与 Session 原始 `turn/end.reason.kind` 一致；完整 fenced JSON 记录为格式恢复而非截断，prefix salvage 只能由真实 `max-tokens` 触发。
2. 任意 `max-tokens`、timeout、provider error、cancel 或进程崩溃都不能使未显式 complete 的 Batch 正常推进 cursor。
3. 一个 Run 中已完成 Batch 的 cursor 可以独立提交，后续 Batch 失败不回滚也不重做它们。
4. 已写 item 在任意重试路径下通过 Store exact replay 收敛，不产生重复文件或 journal。
5. `max-tokens` 首先触发当前批二分；最小批才允许受控 effort 降级；所有动作有界并可审计。
6. dead-letter 只针对相同稳定 window 和协议策略的连续确定性失败，且 UI 明确展示被跳过的证据范围。
7. 模型仍只拥有 run-local 最小工具权限，现有 grounding、secret、scope、tombstone 和固定产品字段不弱化。
8. v1 state/audit 可升级读取，terminal audit/state 分叉可由 fenced commitIntent 幂等恢复。
9. 设置页能分别表达“模型如何结束”“输出如何解析”“写入了几条”“处理完几批”“哪些 cursor 已提交”。
10. source-linked、packaged runtime、插件 typecheck/test/build 和 Desktop GUI 验收全部通过。
11. 经过至少两个 RC、14 天真实调度后，才删除 legacy 生产路径。

## 18. 结论

本次问题的直接触发是完整 fenced JSON 被裸 `JSON.parse` 拒绝，随后通用 salvage 路径把格式兼容错误标成了容量截断。三次已核验 run 均以 `completed (stop)` 结束，没有真实 `max-tokens`，也没有证据漏采。此前基于 `truncated=true` 得出的近期容量结论必须撤回。

长期改造仍然必要，但论证应建立在协议边界而不是错误事故数据上。改造后的边界应当清晰：

- `turn/end` 表达模型为何停止；
- output classification 表达正文如何解析、是否完整；
- 模型用单条工具表达语义结果；
- complete 表达“本批处理完毕”；
- Batch 限制故障半径；
- exact replay 支撑安全重试；
- cursor 只确认已完成 Batch；
- capacity controller 只响应真实容量信号；
- audit/UI 负责把格式恢复、成本、降级和残余损失如实展示。

第一步不是调低 effort 或调高 token，而是修正分类并重新建立测量基线。在此基础上，tool-only、微批和逐批 cursor 才能解决未来真实截断时的潜在漏采，而不会继续被围栏假警报驱动。
