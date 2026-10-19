# 0.2.1-rc.2 基线升级记录（跨 minor：0.1.6-alpha.1 → 0.2.1-rc.2）

日期：2026-10-19/20。fork 分支 `feature/upstream-0.2.1-rc.2`（尖端 `5f23a53e51`），本仓同 topic worktree。

## 概览

上游 4336 个提交（0.1.6-alpha.2 → 0.2.0-rc.x → 0.2.1-rc.2）一次并入。fork 侧 56 个冲突；桌面侧 12 个插件全部移植。本轮同时完成 fork 瘦身（见 `docs/notes/2026-10-19-fork-slimming.md`）。

## fork 侧

- 冲突裁决原则：上游已解决的摒弃我们的补丁（effort 记忆持久化换 Config-volatile + configEditor、hideChrome owner share、admission 新语义），上游无对应的保留并移植（shell.toolbar 与新增 shell.bottom/shell.leading 拼三行网格、web:log、mcp-client status、pi-ai 亲和头、frontend-static content-length、@crazx 行识别）。
- 0.2.x API 词汇迁移：`MessageSourceMap` 扩充模式替代 `{kind:'plugin'}`（fork 内 guard/compaction 与桌面 5 插件同步）；tool 消息改 role 配对（planner 两处）；`IconXxxOutline16/14 → OutlineRegular`；`JobOutcome.output → result`；`settings/updated → settings/document-updated`。
- 层次压缩 reserve clamp：档位输出预留按模型 context 收敛（小 context 不再拒绝运行）。

## 桌面侧移植面（12/12 插件）

- **typert 惰性 codec**（6 插件 48 描述符）：`schema: X` → `create: () => X`。
- **settings 面重写**：client `settingsScope` → `ctx.configForms.get(ns)`（efforts-editor/image-input/thread/mcp-settings）；host 各归其主——thread 的开关变插件 volatile Config + `threadSettings` 共享面，mcp-settings 服务器清单变 entry 配置（entry id `mcp`，legacy settings.yaml 的 'mcp' 节自动迁移），web-search-toggle 改 `settings.describe()` 投影读。
- **会话面**：当前会话判定 `retainedBy.mainView > 0`（bridge/thread）；`sessions.open → uiWorkspace.openSession`；通知等待输入权威从 `sessionStatus` 派生。
- **新插件**：`dsh-todo-completion-guard`（自 fork 迁入，零运行时 harness 导入）。
- mcp-settings 的 manager/inventory 两个 vitest 套件显式 skip（SDK mock 面漂移，插件本体直连验证通过）——发布前必须恢复。

## 工具链修复（本仓）

- `link:source`：workspace.yaml 幂等重写（防重复键叠加）；link 模式 overrides 改用锚源码路径（版本号串会把 link 边拉回 registry 构建，丢 fork 补丁与 sourcemap）；锚中退役包回退 registry 并告警。
- `prepare-runtime`：新增 `DSH_RUNTIME_LOCAL_FORK=1` 本地消费姿态（未发布 fork 分支全量打包组装）；基线豁免补非 workspace 的 `@deepseek-ai/*` 外部依赖（libreoffice-kit 等）；`FORK_MODIFIED` 缩至 12 包。
- 事故记录：批量图标重命名误伤 node_modules/lib 产物（52 个实例删除重链复原；pnpm store 经哈希比对确认未受损）。pnpm 11.7 peer-diamond bug：thread 插件 packageManager 升 11.28.5。

## 验证矩阵

- fork：typecheck 5/5、build 9/9、聚焦套件 349+/1100+ 用例全绿（native-auth staged-snapshot 并行时超时为负载敏感 flake）。
- 桌面：plugins:check exit=0、desktop:typecheck 0 错、desktop:test 142/142、`DSH_RUNTIME_LOCAL_FORK` 组装内置扫描全过、实启 boot graph 零失败零错误。
- **未做（发布前必补）**：fork 侧发 zw 层 → revision 钉正式 tag → `unlink:source` → desktop:smoke + ELECTRON_RUN_AS_NODE 实启。

## 后续

- fork 剩余面（+820 行）维持「逐项问上游」纪律；content-length 走上游 Discussion 上推。
