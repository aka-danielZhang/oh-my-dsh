# 梦境提取的输出预算、截断抢救与死信游标（2026-09-07）

## 背景

定时梦境提取出现「已达到输出 token 上限回答被截断」。排查结论：**不是输入方式问题**——输入侧本就有界（`maxTranscriptBytes` 96KB、每会话 80 条、每条 4000 字符二分拟合）。根因在输出侧，且失败语义把一次截断放大成永久循环：

1. **输出预算与产出契约不匹配**。`agentMaxTokens` 默认 4000，而提取契约允许一次输出最多 12 条记忆 × content 最长 1200 字符 + 逐字 quote + 元数据——最坏 ~20KB ≈ 7–10K tokens。GLM 系（zai 路由）推理模型的「思考」与正式输出**共享同一个 max_tokens 预算**，思考先烧掉大半，JSON 写到一半被砍。
2. **截断即整批作废 + 每晚重试**。turn 以 `max-tokens` 结束 → `requireCompletedTurn` 抛错 → `failRun` 不推进游标 → 下个调度周期用同样证据重跑 → 同样截断。无人值守场景没有「发送继续」，死循环每夜烧钱。
3. **维护会话成本与归组问题**。`maintenanceCwd` 取证据的主要 workspace cwd，使 prompt assembly 把该仓 AGENTS.md（本仓 65KB+）拉进每次提取，维护会话还出现在该 workspace 分组下。

另发现两个 UI/wire 缺陷：

- 设置页模型/档位选择器渲染自 `models()` 快照，而 `updateSettings` 成功后只折叠 overview、**从不重取 models**——用户设了 `dream_effort: max`（config.yaml 已确认落盘）但选择器一直显示「跟随默认」。
- `updateDreamSettingsRequestSchema` 的 `modelProvider`/`model`/`effort` 带 `.min(1)`，而 UI 选「跟随默认」时发送空串——**一旦设置过任何覆盖就永远无法清除回默认**。

## 决策

### 输出预算对齐产出契约（manager Config 默认值）

- `agentMaxTokens` 4000 → **16384**（上限 32768 → 65536）：同时容纳最坏 JSON 与推理消耗。
- `maxCandidateContentChars` 1200 → **300**：记忆正文本该一两句话，1200 是离群值。
- quote 新增硬上限 **`MAX_QUOTE_CHARS = 200`**（`parseProposal` 拒绝超限），prompt 同步声明 content/quote 上限，让模型可依约输出。
- `maxMemoriesPerRun` 保持 12：预算上调后 12 × (300 + 200 + 元数据) ≈ 7KB ≈ 3.5K tokens，宽裕。

### 截断抢救（`parseDreamOutput` salvage 路径）

- turn 允许两种结局：`completed` 与 `max-tokens`（其余仍抛 `DreamOutputError`）。
- 输出在流中截断时，string-aware 括号扫描恢复 memories 数组中**已完整闭合**的前缀 items，逐项走与 strict 路径完全相同的 grounding 校验（quote 子串、secret、超限）。全部通过且至少一条 → 按 `truncated: true` 入账并照常推进游标；任何一条非法或零条存活 → 原样抛错。
- 姿态保持 fail-closed：**截断豁免缺失的条目，绝不豁免非法的条目**——一个未落地的引用仍使整轮失败。fenced/畸形输出若连 memories 数组都没打开，按原错误抛出（既有测试断言不松动）。

### 死信游标（打破重试循环）

- 新增 `DreamOutputError` 标记**确定性输出失败**（未完成 turn、空文本、解析失败、ungrounded 输出）；只有它计入死信。超时/取消/供应商错误是运气，保持重试。
- `DreamRuntimeState.failureStreak = { promptHash, count }`：同一证据窗口（同 promptHash）连续 N 次毒失败累计，成功清零；达到 `deadLetterThreshold`（新 Config 字段，默认 3）→ 强制推进本次 run 的 cursors、审计 detail 标注 dead-lettered。代价是该窗口证据被跳过（有界损失），换来不再每夜重买同一失败。

### 维护会话 cwd 中性化

- `maintenanceCwd()` 恒返回 `homedir()`，删除证据 workspace 择优逻辑。persona 的 `{{cwd}}` 仍可解析（保留 cwd 是 stock prompt assembly 的硬要求），但提取器不再背负任意仓库的 AGENTS.md，维护会话在 UI 中呈「未分组」。记忆 scope 不受影响——scope 始终取自证据的 `cwd`（`scopeForCwd(proposal.evidence.cwd)`），不是维护会话的 cwd。

### wire/UI 修复

- `updateDreamSettingsRequestSchema` 三个覆盖字段去掉 `.min(1)`：空串即「清除覆盖」。既有持久化记录缺 `truncated`/`failureStreak` 字段由 zod `.default()` 兜底，不阻塞启动（与 825c16e 同一姿态）。
- Client controller `updateSettings` 成功后**顺序重取** `models()`（必须在写提交之后，避免读到旧配置）并折叠进 store——选择器立即反映新档位。

## 不做的事

- **不改 `dream_effort` 默认值**：档位 id 是模型相关的，无法通用默认「最低档」；显示 bug 修复后用户显式选择即可（GLM 系建议低档，思考直接烧输出预算）。
- **不动 capsule 注入结构**（surface `replace` 语义、delta 注入）：普通会话输入侧慢性增长是独立课题，见会话讨论；本 note 只治理梦境提取的输出侧。

## 验证

- `pnpm run typecheck` 零错误；`pnpm test` 152/152（新增：截断抢救 3 例 + quote 超限 + prompt 契约声明 + models 重取 + 空串清除覆盖）；`pnpm run build` 通过。
