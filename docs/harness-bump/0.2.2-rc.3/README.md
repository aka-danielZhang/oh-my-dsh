# 0.2.2-rc.3 基线升级记录（跨 minor：0.2.1-rc.2 → 0.2.2-rc.3）

日期：2026-11-15。fork 分支 `feature/upstream-0.2.2-rc.3`（尖端 `ab366abecf`，merge 提交 `df2d791a70`），本仓同 topic worktree（尖端 `8d99ca4`）。发布：fork `v0.2.2-rc.3+zw.1`（`@crazx/*@0.2.2-rc.3.zw.1`，17 包，本地 publish-fork 镜像路径，tag 已推 origin）；本仓 revision 钉同 tag（sha `0b218447`）。

## 概览

上游 4216 个提交（0.2.2 alpha.2 → alpha.3 → rc.1 → rc.2 → rc.3）一次并入。fork 侧 26 处冲突（上轮 56 处——瘦身见效）；本仓 8 个插件移植。本轮同时落地 Quno v2 审计遗留的三项 fork 需求（§6.1/§9.4/§10）。

## fork 侧

### 裁决原则与执行

- **上游已收编的 fork 补丁退役**：
  - `mcp-client/status` 事件 → 上游官方 `McpStatusCell`/`connectionStatusOf(fiber)`（语义同源：contained listener、fiber 存活、dispose 解绑）。fork 的 `packages/mcp/mcp-client` 全盘回归上游，发布面减一。
  - 会话菜单行插槽 → 上游 `ctx.contextMenus` + `registerSessionMenus`（内置 pin/rename/fork/archive/session-id 五件套原生化，外部行插槽保留为 legacy 面）。
  - `selectModel` 的 `selectForNextRequest` → 上游 `agent.model.select`；`selectionFor` → `agent.model.current()`。
- **移植保留的 fork 面**（上游无对应）：
  - effort 记忆：`recallEffort` 咨询进上游新 selectModel 流程；记忆写入改 `selected.reasoningEffort`。测试期望改随上游 validate-only 语义（adapter 默认值在 dispatch 时物化，选择记录保持裸值）。
  - pi-ai 会话亲和头：嫁接进上游 contributor `requestHeaders` 流程（`prepare(request, initial)` → attribution → affinity 收尾），config 侧 `sessionAffinityHeaders`/opencode-go 默认路由自动合并完好。
  - frontend-static 显式 content-length：移植到上游 fetch Response 架构（stream body 否则 identity/chunked 分帧）。
  - sidebar 头部动作席位 + `conversationAgentPreset` 行归属：落到上游 pinned-panel SidebarRoot（More 菜单/pin 语义共存）；**syncPanels 的 preset 元数据投影被自动合并丢过一次，测试拦回**（playbook「自动合并旧 hunk 污染」再验证）。
  - ui-workspace alternate 视图 + 会话可见性 hooks：并入上游新 injected 形状（workspaceActionRequest/contextMenuTarget 并存）。
  - ui-slots 声明式 options（`SlotEntryDef.options` → 存储袋）：接到上游 hoc-kind register 类型上。
- **上游结构迁移**：菜单行测试/`ArchiveSessionMenuItem` 等死引用清理；`AGENTS.md`/README 双语冲突取上游正文 + fork 句段回插；`pnpm-workspace` i18n 哈希记录 `verify-translation-pairing --write` 重录；catalog `gen-cordis-catalog` 重生成（fork 遗留 `EVENT_SCOPE_PAGE['mcp-client']`/`McpClientStatus` 归属清理）。
- **新功能（Quno v2 三项，`ab366abecf`）**：
  - §6.1 `conversation.session.header` single → **chain**：条目按优先级升序尝试，stock 头以 `select: () => true` 注册兜底，插件按派发 `sessionId`（`quno-exec-` 前缀纯谓词）整头认领 worker 会话——纯度门不再逼插件渲染 stock 组件（composer chain 先例的头部级复刻）。
  - §10 QueueDock seam 上收：可选会话级 `conversationQueueVisibility` 服务（`scope.set`），stock dock 对持久行应用之；本地 pending 回显不过策略。插件侧 v1 克隆（queue-dock.tsx）退役。
  - §9.4 inspect 提交门：`session/setInteractionMode` Remote 命令（易失 WeakMap，Host 重启即失）+ `prompt()` 在任何持久写入前以 `session/read-only` 拒绝 inspect 会话的用户准入；程序输入不经 prompt 路径。liveshare 分类 `owner-only`。`uiWorkspace.openSession(target, { interactionMode })` 声明随导航（失败降级日志，interactive 默认兜底）。
  - 附带：ui-agent-preset 显式创建 preset 保护（上轮主 checkout 未提交补丁转正，`d347e8116d`）。

### 发布

- `publish-fork --list` 17 包（+ui-agent-preset/-ui-conversation/-liveshare/-test-runtime/-client-shortcuts/-ui-slots，-mcp-client）。dry-run 过后本地 publish（Actions 对 npm-release workflow 未触发的既定镜像路径），`npm view` 逐包核验在线（registry 传播分钟级）。
- **上游新 prepack 依赖**：0.2.2 的 dsh CLI 把文档暂存挪进 prepack/postpack（解析仓根 `scripts/stage-dsh-docs.ts`）。staging 树无仓根——publish-fork 改为**真实树先跑一次 prepack**（gitignore 的 apps/cli/docs 随包复制）+ staging manifest 摘除 hooks（`0b21844732`）。真实树发布前整仓 build 已按 FORK.md 执行。
- tag `v0.2.2-rc.3+zw.1` 推 origin（master `0b218447`），pre-push typecheck 绿。

## 本仓侧移植面

- **依赖纪律**：registry 钉 `0.2.2-rc.3`；fork 面 `@crazx/*@0.2.2-rc.3.zw.1`（source-deps.mjs 基线常量 + FORK_MODIFIED/prepare-runtime 同步 17 包集）。生态：cordis 4.1.0、schemastery 3.19.0、cordis-plugin-timer 1.2.0、zod 4.6.6（上游 zod 升级，插件 4.4.3 全部跟随——**双实例类型不兼容是真实事故面**，ohmymemo domainTable 首当其冲）。agent-presets/invariants 上游仍未重发，维持 0.0.1-rc.1 豁免。
- **peer 供给（§4b）**：`dsh-error` 成为 dsh-llm 与 dsh-working-directory 的新 peer——所有锁这两个包的插件显式 devDep（quno/todo-guard/mcp-settings/compaction/fs-observation-log/ohmymemo/reasoning-efforts + 锚）。
- **dsh-quno（三项落地 + executor 移植）**：
  - worker 整头认领（chain 注册 priority -10，`select` 谓词），leading 席位收敛为仅主身份；
  - `openWorker` 声明 `interactionMode: 'inspect'`、`backToQuno`/`returnToMainFromPanel` 声明 `interactive`；
  - 主会话作用域 `conversationQueueVisibility`（store 订阅随 main.sessionId 换装），queue-dock.tsx 删除；
  - executor 到 0.2.2 agent 工厂：`meta.parentSession`（原 `parentAgent`）、resume 携带 `agentOptions`、`installModelSelection(agentCtx)` 单参、去 `presentAs`；测试 fake registry/agentCtx 同步（`ctx.on` 需要 stub）。
- **dsh-mcp-settings**：manager 迁移官方 `connectionStatusOf`（spawn 后取 handle、`onChange` 投影 connection+toolCount；cell 在 final disposal 解绑观察者）；`projectMcpStatus` 纯映射；posture 守卫改验官方面（identity 0.2.2-rc.3 + `connectionStatusOf` 存在）；toClientConfig 改 **Input 形态**（`Parameters<typeof McpClient.Config>[0]`，上游 closeTimeoutMs/expandTemplates 新字段由 schema 默认值物化，插件零硬编码）；vitest manager/inventory 套件维持上轮 skip 状态（SDK mock 面漂移，发布门恢复项）。
- **dsh-web-search-toggle**：0.2.2 assemble waterfall 类型面（PromptPresentation 含 contexts/variables、tools 仅完整装配携带）——约束 `tools?` 可选 + 抑制函数透传未知成员。
- **dsh-fs-observation-log / dsh-ohmymemo**：0.2.2 工具批处理面（model 形 `ToolCallBlock` 进、`ToolBatchResult.results[{callId,result}]` 出，arguments 为 JSON 字符串）+ **executor 拆分为 `dsh-tool-executor-native` 独立插件**（dsh-tools Config 的 mode 字段已移除）；两仓测试 boot 组装挂 executor。
- **dsh-send-while-running**：SessionSnapshot 新增 `historyWasPartial`/`historyLoadStatus` fixture 补齐。
- mcp-settings 的 pnpm-workspace.yaml 整族 overrides 由 `node scripts/source-deps.mjs unlink` 重建（上轮手写快照淘汰）。

## 验证矩阵

- fork（worktree 内）：typecheck 5/5、build 10/10、聚焦套件 6388+ 用例全绿（session-controller/ui-conversation/ui-workspace/ui-sidebar/ui-slots/llm-pi-ai/frontend-static/agent-default-model/client-modules/test-support；sidebar 1541、workspace 531）。
- 本仓：`plugins:check` 22 包全绿（registry 姿态）；`desktop:typecheck` 0 错；`desktop:test` 全绿；`prepare-runtime` 组装 + 内置漂移/重复/基线扫描全过；**`desktop:smoke` 过**（19 随包插件 × 4 preset 两轮 boot，v0.2.2-rc.3+zw.1）；打包 Electron（44.0.0 钉版）as-node 实启 sidecar（scratch home，addons 接受、webserver 响应）。
- link:source 姿态已切换（未提交），交付用户实机验证；回归 registry 姿态用 `pnpm run unlink:source`。

## 后续

- 用户实机验收轮：v2 §15.1 两行实机验收 + 键盘/读屏/窄屏 + quno evals（`worker-inspect-reject-submission-while-events-continue` 现已可跑——依赖的 Host 提交门已就位）。
- mcp-settings manager/inventory 两个 vitest 套件恢复（发布门前必做，沿用上轮清单）。
- P2（活动标签细化、persistent resultRevision 合并）未动。
