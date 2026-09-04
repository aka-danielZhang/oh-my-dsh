# OhMyMemo Phase 2：显式记忆闭环

日期：2026-09-03

状态：已实现（`plugin/dsh-ohmymemo` 0.1.0，分支 `feature/ohmymemo`）；后续梦境候选提取与只读 UI 首段见 `2026-09-04-ohmymemo-dream-memory-and-ui.md`

前置：`2026-09-03-ohmymemo-store-phase1.md`（Phase 1 介质契约）；设计输入 `2026-09-03-ohmymemo-memory.md`（Phase 2 范围＝「实施阶段 · Phase 2」）

## 决策摘要

在 Phase 1 冻结的 Store API 上交付用户可用的显式记忆闭环：`ctx.ohMyMemo` 服务、五个 `memory_*` Tools、exact key/tag/中英文正文检索与排序、user/workspace 有界 views、`agent/pre-step` 持久 context capsule（digest 对账）。介质语义零改动——Store 的锁/CAS/journal/事务恢复原样承载 Phase 2 全部写入。

## 结构（新增模块）

```text
src/search.ts    纯检索：硬过滤（状态/隐私/有效期/作用域/隔离）+ 设计文档八维排序 + CJK snippet
src/views.ts     确定性 views（user-profile + 每工作区），generated 头 + digest，可删重建
src/capsule.ts   纯 capsule：权限声明 + workspace→confirmed→pinned→importance 确定性排序与预算截断 + digest 标记
src/service.ts   ctx.ohMyMemo 服务（search/get/remember/update/dispute/reactivate/forget/
                 rebuildViews/doctor/stats/scopeForCwd/capsuleInput/subscribe）+ Context 类型增强
src/tools.ts     ohmymemo-tools 行：五 Tools + 准入提示段（systemPrompt.section）
src/context.ts   ohmymemo-context 行：agent/pre-step 注入 + 对账
```

包形态变为三行一包（`dsh-ohmymemo` / `dsh-ohmymemo/tools` / `dsh-ohmymemo/context`，subpath exports，bridge 的 `exports["./log-sink"]` 同款）。

## 关键实现决策

1. **两个待决点按建议落地**：capsule 走独立 `ohmymemo-context` 行（与 tools 解耦，读写路径分离）；capsule 消息暂为纯文本包装 + `source: {kind:'plugin', plugin:'dsh-ohmymemo-context', form:'snapshot'}`，不扩展 harness `MessageSourceMap`（上游类型留待有真实 UI 需求时再议）。

2. **UserMessage 零运行时导入自建**。message 是冻结数据记录（`createUserMessage` 只做 brand+freeze），context 行以纯字面量构造（`randomUUID()` id + plugin-sourced snapshot sections），保持 store/context 两个入口零 `@deepseek-ai/*` 运行时导入；唯 tools 行运行时导入 `@deepseek-ai/dsh-tools` 的 `defineTool`（它做 JSON Schema 转换与参数校验，不可省），按 dsh-thread 先例以 **peerDependencies 钉到 profile 树的运行时副本**（`>=0.1.0-rc.8 <1`），devDeps 钉 `0.1.2-alpha.3` 基线供 typecheck——防 unique-symbol 模块身份分裂。

3. **capsule 对账 = surface 回扫 digest，不引 sessionProjections**。注入消息尾部带 `[ohmymemo-capsule digest=<16hex>]`；pre-step 时倒序扫 session surface 的 `user/message`（只认 source.plugin 为本行），最近一条 digest 相同→跳过，不同→注入带「替换旧 capsule」声明的更新消息（历史只追加，覆盖语义写在消息里）；扫不到→首注。进程重启/resume 天然一致（扫的是持久 surface），无额外状态、无 zod 依赖。设计验收「相同 digest 在 resume 时不重复」由该机制直接满足。

4. **subagent 只读**：写工具（remember/update/forget）检测 `exec.parent`（嵌套派发）或 header `origin==='subagent'` 即拒绝；search/get 放行。来源绑定 `exec.agent`：session_id 取自 agent.id，cwd 取自 header（工具入参不可能伪造会话身份）。

5. **update 的 resolution 语义**：带 content 的修订=supersede（新后继 ID+归档旧记录，revision 链完整）；`dispute`=双方 disputed + 对称 contradicts（服务层两次受锁修订，中间崩溃由 doctor 的 dangling 诊断兜底——完整冲突治理属 Phase 3）；`reactivate`=disputed→active；confirm/元数据修订原地 revision+1。

6. **排序实现为可测纯函数**（`search.ts`）：workspace 命中 +100、精确 id/key +80/+60、tag +40、短语 +25、多词覆盖率 ×15、来源权威与 confirmed、disputed −20、importance/新鲜度/confidence 微调；分数只决定先看哪条，不改变状态权威。硬过滤排除 quarantined/非 active/非 normal privacy/有效期外/作用域外。sensitive 正文永不回显（get 返回 redacted 标记）。

7. **views 漏斗与 capsule 同一资格谓词**（active+normal+pinned+未隔离），头带 `generated: true`/memory_ids/digest；store 行 open 后与每次变更（含外部编辑触发的 catalog 刷新）都重建——手工改 view 会被下一次变更覆盖，永不反向写 canonical。

## 验证

- 单测 117/117（Phase 1 的 80 + Phase 2 新增 37：search 排序与硬过滤、views 确定性与重建、capsule 预算/对账/替换、service 五链路含 dispute 对称、tools 经 fake exec 的全工具回路与 subagent 拒绝、context 行注入/跳过/替换/中断穿透）。
- 实机冒烟（scratch DSH_HOME + 仓内组装 runtime）：`plugin add` 后 `--dump-config` 三行齐；`dsh web` 启动零错误，store 初始化且 `views/user-profile.md` 自动生成（证明 store 行→service→views 管线在真实 profile 内跑通；peer 依赖解析正常）。

## 已知边界（留待后续阶段）

- 本阶段 `memory_remember` 只写 active（准入靠工具描述+提示段+Store 硬门）；后续已增加定时 candidate 生成与增量游标，但确认/拒绝、TTL 和完整冲突治理仍未实现。
- dispute 的对称链接跨两次锁窗口，崩溃中窗由 doctor 兜底；原子化需 Phase 3 的多文件对称事务。
- capsule 与 tools 的模型可见提示段仍为中文；后续 Client UI 文案已独立接入 `ctx.locale` 的中英文 typed dictionary。
- 检索是进程内线性扫描（v1 规模刻意为之）；FTS/embedding 缓存按设计属 Phase 4。
