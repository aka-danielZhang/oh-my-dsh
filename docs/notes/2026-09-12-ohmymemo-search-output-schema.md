# OhMyMemo memory_search 输出契约：schema 漏声明 score 的九日潜伏与校验缝测试化

2026-09-12 · dsh-ohmymemo 0.2.4 · 随 Desktop 0.3.0-rc.56 发布

## 事故

用户会话（`session-2dcd899b-7b5c-4243-a6ba-bc45657b216d`，2026-09-12）中 agent 调用 `memory_search`，六条命中全部被拒：

```
Error: tool "memory_search" returned invalid output: "value.hits[0].score" is not a
declared property (additionalProperties: false); …（hits[1..5] 同）
```

记忆数据无损；受影响的只是模型侧检索入口——凡命中 ≥1 的 `memory_search` 调用 100% 失败。

## 根因（一处失配 + 一处测试盲区）

1. **schema 与实现失配**：`tools.ts` 的 `memory_search` 输出 schema 对 hit items 声明 `additionalProperties: false`，但只列了 `id/scope/kind/key/revision/status/snippet` 七个字段；而 `service.search` 返回的 `MemorySearchHit` 自 Phase 2（`e6c98e9`，2026-09-03）起恒带 `score`（`search.ts` 排序分，已规整两位小数）。harness `dsh-tools` 的 `ToolRegistry.createSuccessResult` 对每个成功返回值跑 `validateJsonSchemaValue`，多出未声明属性即 `ToolOutputError`。该严格校验上游自 `dsh-v0.1.0-rc.8` 时代（2026-07-21 canonical typed tool outputs）就在 dispatch 里强制，早于本工具上线——即工具自上线起，命中即炸。
2. **为何潜伏九日**：空结果 `{"hits":[],"truncated":false}` 可过校验；记忆主链路（capsule 注入、梦境提取、Curator、生命周期维护）全部进程内直调 store/service，不经过工具输出校验缝。所以记忆功能整体正常，直到今天才有 agent 真正调用 `memory_search` 且搜到结果。
3. **为何测试没拦住**：`tests/tools.test.ts` 的 mock registry 收集定义后**直调 `execute()`**，恰好绕过 ToolRegistry 的输出校验缝——schema 是死数据，单测只验行为不验契约，失配不可见。

## 修复

- **`tools.ts`**：hit items schema 补 `score: { type: 'number', required: true }`。保留 `additionalProperties: false` 严格姿态与 `score` 本身（render 走完整 JSON，score 是模型判断「这批命中是否值得 `memory_get` 回读」的相关性校准信号；剥离它属于行为变更，不是修 bug）。
- **`tests/tools.test.ts`**：新增契约测试「contract: every tool output validates against its declared output schema」——对全部五个 `memory_*` 工具跑真实 `execute()`，用 `@deepseek-ai/dsh-tools` 公开导出的 `validateJsonSchemaValue` 校验返回值 vs `definition.output.schema`（`defineTool` 已把它规范化为 canonical schema，与 `createSuccessResult` 消费的同一形态）。六个样本：search 命中、search 空结果（恰是掩盖事故的形状，钉死）、get、remember、update、forget。已红队验证：回退 score 声明该测试立即红。

## 取舍与边界

- **不放宽 `additionalProperties: true`**：search hit 是小而稳定的投影面，严格声明成本低；宽松化弱化模型面契约，偏离 fail-loud 仓规。`memory_get` 的 records 用宽松是特例（record 形状大且随生命周期演进）。
- **不做 schema 自动生成**：harness JSON-Schema 是受支持子集（`assertSupportedJsonSchema`），五工具手写可控；codegen 引入转换风险，上游自己也手写。
- **不修上游**：校验器行为正确，本次正是它在工作。
- 同类审计：`thread_handoff`（dsh-thread）返回值经 `boundedArtifacts` seam 投影、逐字段与声明一致，是正面范本；`dream_memory_*` 走 host 内部协议定义件、当前提取器 `tools.restrict({ allow: [] })`，不经 ToolRegistry 派发，不受此失败模式影响。其余 memory_* 写工具的 `MutationResult`/`ForgetResult` 与声明逐字段一致。
- 治本边界：本次把「校验缝」搬进测试，但 schema 与 TS 类型仍是两份手写事实；契约测试覆盖的是**本包注册的工具**。若未来插件大量增工具，可再评估 per-package 共享契约测试 helper，暂不抽象。

## 测试

- `pnpm run typecheck` / `pnpm test`（221 全绿，含新契约测试）/ `pnpm run build`。
- 红队：临时删去 `score` 声明 → 契约测试红（`memory_search output violates its declared schema`）→ 恢复后全绿。

## 发布

dsh-ohmymemo 0.2.4 随 Desktop 0.3.0-rc.56（`v0.3.0-rc.56`）发货。
