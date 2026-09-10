# DeepSeek Harness `0.1.5-rc.1` 升级落地方案

## 0. 落地进展（实施分支 `feat/rc1-toolbar-port`）

P0 Fork 基座已完成，提交序列（基于合并提交 `c7da3280b9`）：

| 提交 | 内容 |
|---|---|
| `e0cce55d3a` | 恢复 shell.toolbar：ui-layout 声明第五个子 slot（空席位零高度轨道）、`LayoutController` 宿主注册表（set/release 身份守卫 + dispose 撤回）、`useToolbarHosts` 标准 root hook（替代 alpha 的 module-store + `useSyncExternalStore`，符合 rc.1 client 规则）；ui-conversation 会话标题头 portal（centerHost/sessionEndHost + 就地回退）；test-runtime `toolbarHosts` 数据源；27 个 spec fixture 补标准属性桩 |
| `463945cad6` | 分层压缩真实 V3 region 集成测试（one-shot 溢出 → map → reduce 全走生产 `summarize()` 路径，断言每次子请求 system head 前置、start/summary/end 事件、system 节点不在阴影区、重放确定性）；`dsh-todo-completion-guard` manifest 版本对齐 `0.1.5-rc.1` |

已验证：root `pnpm run typecheck` 通过；`tsc -b tsconfig.client.json` 0 错误；`test:gui` 5337 通过；`DSH_SNAPSHOT=replay test:web` 353 通过（空 toolbar 行对组装快照不可见）；compaction 166/166；lint/archived-notes/translation-pairing 提交钩子通过。

`publish-fork.mjs --list` 现为 13 包：新增 `dsh-client-test-runtime`、`dsh-client-ui-conversation`、`dsh-client-ui-layout`；`dsh-session-persistence` 相对 upstream 无差异自动退出清单。

已知残留（本轮不阻塞，移交下阶段）：`verify-agent-note-format` 对既有 fork note `2026-08-19-retire-models-provider-row-slot` 报 Alternatives 节缺失（合并带入，非本次改动）；corpus 级 translation-pairing 存在三处既有 fork note 链接 locale 后缀问题；基线 fork 的 selection-history（`canBack/canForward`）能力未随 toolbar 移植，desktop-bridge 若需要导航箭头需单独评估。

## 0.1. 落地进展（Desktop P0 插件阻断项，主工作区）

五个 P0 插件阻断项已修复，`pnpm run plugins:check`（全部 14 插件 typecheck+test+build）exit 0：

- `dsh-thread`：`gateway.ts` 六处 `Session.events` 全部改为 `snapshotEvents()`（419/521/609/717/796/887）；manifest `dsh.client.inject` 补 `dsh-client-ui-layout`（shell.overlay）与 `dsh-client-ui-settings-general`（settings.general.item）；Host peer 补运行时必需的 `dsh-system-prompt`、`dsh-session-projection`。64/64 测试通过。
- `dsh-web-search-toggle`：client 增加 `@deepseek-ai/dsh-api-gateway/client` 模块增强（`ctx.remote.$mount` 可解析），`dsh.client.inject` 的 `api-remotes` 换成 `api-gateway`，补 peer+dev 边；旧 prerelease peer 下界（`>=0.0.1-rc.1 <1` 等）统一提升到可容纳 rc.1 的 `>=0.1.5-alpha.1 <1`；tsconfig 纳入 `tests/**/*.tsx`，WebSearchRow fixture 补 `keyRef` 与正确的 t/快照类型。15/15 测试通过。
- `dsh-send-while-running`：组件重写为框架 hooks 形态 —— `PropsRuntime<'conversation.input.right'>` + `PropsLocale` + `InjectFace`，经 `useSession`/`useInput` 订阅状态，废弃的 `imageIds` 改为 `attachmentIds`，cancel 仍走每会话注入的 `interrupt`；补 `dsh-client-store` 类型依赖（此前 `SnapshotSelectorHook` 静默退化为 any）；测试改为真实 `SessionSnapshot`/`InputState` stub。16/16 测试通过。
- `dsh-usage-stats`：从 `dsh.client.inject`/peer/dev/tsdown externals 移除不存在的 `@deepseek-ai/dsh-client-runtime`（该名从未存在于 upstream，正确名为 test-runtime 且本插件未使用）；`ctx.plugin(SlotRegistry, [])` 改为无参形式修复类型错误；`scripts/shipped-plugins.test.mjs` roster 13→14（补 `dsh-usage-stats`）。node 58/58 + browser 21/21 通过，tarball 无残留引用。
- `dsh-provider-balance`：监听事件从不存在的 `credentials/updated` 改为 `credentials/reference-updated`（两个基线均只定义后者），README 同步；`settings.models.provider-card` slot 迁移（退休 DOM 解析）留待 P1，属 UX 变更需设计确认。

限制说明：本轮验证基于现有 alpha.1 锁定依赖（`plugins:check` 门），rc.1 冻结依赖矩阵验证仍按 §9 在依赖迁移阶段执行。

## 0.2. 落地进展（P0 安全项 + P1 项 + opencode-go 方案，主工作区）

- **dsh-fs-observation-log 安全重构**：删除跨会话 healing（evidence 未绑定 fork cut，父会话 fork 后的读取不再授权子会话编辑；fork 父指针保留在 sidecar header 备未来切点绑定）；文件名改为完整 opaque SessionId 的 SHA-256（分隔符孪生 id 不再碰撞），加载时校验 header.id 与请求 id 一致、不匹配按不存在处理且强制重写；压实触发改为物理 JSONL 行数（同目标反复观察不再无限增长）；`DSH_HOME` 归一化（空/`~`/相对路径）；`cordis.patch.yml` 落 Host 单例行使其真正激活，`preset-snippet.yml` 退役；`inheritFork`/`maxLineageDepth` 字段删除且遗留 preset 显式报错。29/29 测试通过。
- **dsh-ohmymemo**：写权限不再把 `ToolExecution.parent`（PTC transport token）当 subagent 身份——仅以 Agent 会话 origin/delegation metadata 判定，根 PTC 子分发可写、真 subagent（含 PTC 内）拒绝；dream 路由覆盖时不再继承默认模型 effort（route-owned，显式配置经路由校验，否则省略）；Typert sourceLocation 刷新至当前 manager 行号。220/220 测试通过。
- **P1**：两个模型编辑器 dispose 现在清理 DOM 标记与网格类（重挂载恢复控件）；efforts 编辑器 CSS 字符串中 JS `//` 注释改为合法 `/* */`；reasoning-efforts thinking-format 镜像补 `baseten`；hierarchical 聚合 `TokenUsage.totalTokens`（all-or-nothing）；desktop-bridge 的 await-input 通知改以 `ctx.uiSession.pendingInteractions` 为权威源（join sessions.list，订阅双方，dispose 双撤）。
- **opencode-go 会话头（方案文档 §4 主路径）**：fork `llm-pi-ai` 新增路由级 `sessionAffinityHeaders`——adapter 在 profile headers/attribution 之后把每个声明头写为当前会话 ID，一条注入点覆盖 completions/responses/anthropic 三条线上路径；未声明路由零字节变化；attribution 保留名拒绝。schema/adapter/回归测试 70/70，包内全量 333/333；配置目录已再生（zh 镜像同步）；Agent Note 已附。`llm-pi-ai` 进入 fork 发布面（现 14 包）。
- **依赖迁移加固**：`source-deps.mjs` 升级到 rc.1 基线 + 14 包 fork 别名 + 全量 `pnpm.overrides` 钉死（官方 rc.1 包的传递 caret 在 npm 出现 rc.2 后漂移混线，overrides 使插件安装对 registry 漂移免疫）；无别名 9 插件锁已按官方 rc.1 重建（rc2=0）。`prepare-runtime.mjs`：SCRIPT_REV 12、FORK_MODIFIED=14 包、精确 `.zw.N`（删除逐包降级回退）、peer 保留 `@deepseek-ai/*` 原名 + 精确 fork semver（与 publish-fork 对齐）、runtime/tools pnpm 11.7.0。

验证：`plugins:check` 14 插件 typecheck+test+build EXIT:0（registry 姿态，transitional 节点态）；desktop:typecheck + desktop:test 141/141；harness root typecheck、client aggregate、`test:gui` 5337、`test:web` replay 353 均绿。

## 0.3. 发布阻塞与用户侧 runbook（唯一剩余步骤）

npm 无凭据（`npm whoami` → ENEEDAUTH），以下步骤必须由持有 `@crazx` 发布权的用户执行：

```sh
# 1. 发布 fork 层（deepseek-harness，分支 feat/rc1-toolbar-port，HEAD 2126a563bb）
npm login            # 或配置 NPM_TOKEN
node scripts/publish-fork.mjs 1            # 14 包 @crazx/*@0.1.5-rc.1.zw.1
npm view @crazx/dsh@0.1.5-rc.1.zw.1 version # 逐包核验
# 2. 全部包可解析后打 tag 并推送（tag 承诺所有包已发布）
git tag v0.1.5-rc.1+zw.1 2126a563bb && git push origin feat/rc1-toolbar-port --tags
# 3. 切 runtime pin（oh-my-dsh）
#    runtime/revision.json: ref=v0.1.5-rc.1+zw.1, sha=2126a563bb...
# 4. 组装与冒烟
node scripts/prepare-runtime.mjs && pnpm run desktop:smoke && pnpm run check
# 5. 插件锁重生成并提交（5 个带别名插件执行 pnpm install 后提交 lock）
pnpm run unlink:source && for d in plugin/dsh-*/; do (cd $d && pnpm install --no-frozen-lockfile); done
```

过渡态说明：当前工作区 5 个带别名插件（thread/send/mcp-settings/ohmymemo/bridge）的 node_modules 仍为源链接树（可开发调试）；其 manifest 已提交为 registry 别名形态，发布完成后一次 `pnpm install` 即切换。

## 1. 目标与边界

本轮把 Oh My DSH 的 Harness 基线从 `v0.1.5-alpha.1+zw.3` 升级到基于官方 `0.1.5-rc.1` 的新 fork 版本，并完成 Desktop runtime、14 个随附插件、原生模块、既有用户数据和打包链路的兼容验证。

本方案分成两个阶段：

1. 基线同步阶段：把 fork `master` 合并到最新 `upstream/master`，只处理合并冲突和使合并树可编译所必需的直接适配。
2. 兼容实施阶段：恢复 Desktop 依赖但未进入旧 fork master 的能力，修复插件缺陷，发布完整 fork npm 层，最后更新 Desktop runtime pin。

不得在 fork 包未发布、插件未完成目标版本验证时提前修改 `runtime/revision.json`。不得修改或删除 `plugin/dsh-usage-stats/.preview/` 和对应 `scripts/preview-*` 等 9 个既有未跟踪文件。

## 2. 已建立的基线

| 项目 | 版本或提交 | 状态 |
|---|---|---|
| 旧 Desktop runtime | `v0.1.5-alpha.1+zw.3` / `98bcf0c6e9d7391b13d4be83fbc78f65b22c4535` | 当前仍在使用 |
| 官方发布 | `dsh-v0.1.5-rc.1` / `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | 目标发布版本 |
| 同步时 upstream HEAD | `aa8262ec091698bae9a6b04773a6b5b06ad4aef2` | 比 rc.1 标签多 9 个提交 |
| fork 合并前 HEAD | `a6fec4194b67a219812f67363143f80b4f7d5a5f` | 旧 fork master |
| 已完成合并 | `c7da3280b92e35402bcb24a6c43fdfc4c0afb99e` | 两个父提交为上述 fork HEAD 和 upstream HEAD |
| Desktop HEAD（审计时） | `e6e7f585` / `0.3.0-rc.48` | 尚未修改 runtime 或插件 |

`98bcf0c6` 不是旧 fork master 的祖先。它包含 Desktop 依赖的 `shell.toolbar`、layout toolbar host 和 conversation header portal 等能力；这些改动没有进入本次合并树。因此 `c7da3280b9` 是有效的 upstream 同步基线，但不能直接发布给 Desktop 使用。

基线同步阶段已经完成以下直接适配：

- 保留 `web:log` CLI、client bundle `Content-Length`、模型 effort 记忆、MCP status、分层压缩和 todo completion guard 等 fork 行为。
- 分层压缩适配 V3 `SummarizationInput.messages` 中的 system message：system head 不计入源范围，在每次 map/reduce 调用中重放并计入预算。
- todo completion guard 改从 `assistant/message` 和 `assistant/attempt` 的 V3 stream 判断 `max-tokens`，测试改为异步创建 Agent。
- Session persistence 采用 upstream 的 `SessionHandle`、原子写入和 POSIX flock 架构，删除旧 coordinator 实现。
- 重新生成 Cordis API、事件关系图和双语配对记录。

已验证：

- `pnpm run typecheck` 通过。
- compaction hierarchy 与 todo guard 聚焦测试 29/29 通过。
- CLI/web-log 10/10、frontend-static 1/1、client modules/model selection 58/58 通过。
- Session persistence 14 个文件、486 个测试通过；本机原生构建需 `PATH=/opt/homebrew/bin:$PATH pnpm run build:native-system`。
- archived Agent Notes 1884 个冻结制品通过校验，双语配对和提交钩子通过，Harness 工作树干净。

## 3. 发布决策

### 3.1 Fork 发布原则

目标版本暂定：

- npm：`@crazx/*@0.1.5-rc.1.zw.1`
- Git tag：`v0.1.5-rc.1+zw.1`

只有当 `.zw.1` 的全部包均已发布并可安装时才能创建 tag。若实施期间已有同版本或需要重发，统一递增 `N`，禁止混用不同 `.zw.N` 层。

当前 `node scripts/publish-fork.mjs --list` 返回 11 个包。`@deepseek-ai/dsh-session-persistence` 相对 rc.1 标签只有 upstream 标签后的 README 差异，且相对 `upstream/master` 无差异；应在发布前确认是否需要进入 fork 层。恢复 toolbar 后，`ui-layout`、`ui-conversation` 和 `client-test-runtime` 将成为实际 fork 修改包。

最终规则：

1. 实施完成后运行 `node scripts/publish-fork.mjs --list`，输出是唯一发布清单。
2. `scripts/prepare-runtime.mjs` 的 fork alias 集合必须与该清单完全一致。
3. 对仅文档变化且运行产物与官方包一致的条目，先修正发布清单判定或形成明确保留理由，不能凭人工猜测删除。
4. 所有 fork 包的基础版本必须统一为 `0.1.5-rc.1`；todo guard 当前的 `0.1.2-rc.1` 必须修正。

### 3.2 Toolbar 方案

选择恢复 fork toolbar 能力，不采用 Desktop bridge 的静默降级作为正式方案。

需要将 `98bcf0c6` 中下列能力移植到 rc.1 的新 `main` panel 架构：

- `dsh-client-ui-layout`：声明 `shell.toolbar` keyed Slot，恢复 toolbar host 的注册、选择和销毁 API。
- `dsh-client-ui-conversation`：恢复会话 header portal 和无 owner 时的安全回退。
- `dsh-client-test-runtime`：补齐测试运行时 Slot/API 支持。
- 对应 Loader、Slot 生命周期、dispose/HMR、sidebar 展开/收起和 global panel 切换测试。

完成前不得把 Desktop runtime 指向 `c7da3280b9`，否则 macOS 会隐藏 stock rail，却可能没有替代导航、更新入口和通知入口。

## 4. Harness 改造清单

### 4.1 分层压缩

- 保留原始 input 不变地传给 stock one-shot summarizer。
- hierarchy 路径同时支持 rc.1 leading system message；如仍需兼容旧输入，只在明确存在旧消费者时保留 legacy normalization，避免无使用方的兼容分支。
- system head 从 `toolBalancedUnits`、source span 和 range 编号中剔除，在每个 map/reduce 请求前置并计入 fixed budget。
- 增加真实 `compactRegion` / Session V3 集成测试，验证 `compaction/start`、summary、surface replacement、`compaction/end` 以及每次子请求的 system preservation。
- `TokenUsage.totalTokens` 按 all-or-nothing 规则聚合。
- 修复包发布面：删除无产物的 `./src/*` export，或生成并打包对应声明；确认 `schemastery` 的直接 runtime 依赖归属。
- 增加 Loader preset replacement 和 `pnpm pack --dry-run` 产物测试，更新 README 的 rc.1 输入说明。

### 4.2 Todo completion guard

- 将 package version 更新为 `0.1.5-rc.1`。
- 保留 V3 assistant stream 的 `max-tokens` 判断和异步 Agent 创建适配。
- 同包源码测试必须解析 `src`，发布面测试另外验证构建后的 `lib`，避免旧产物掩盖修改。
- 复核是否仍需要 `session-projection` devDependency；无直接使用则删除并更新 lock。

### 4.3 MCP status 与发布包

- `dsh-mcp-settings` 依赖 fork-only `mcp-client/status`；官方 rc.1 不提供该事件。
- 必须发布并解析 `@crazx/dsh-mcp-client@0.1.5-rc.1.zw.N`，Desktop 安装时仍以 `@deepseek-ai/dsh-mcp-client` 名称 alias 到该包。
- 加一条负向检查：若组装时解析到官方 rc.1 mcp-client，应立即失败，不能让 UI 永久停在 Connecting。

## 5. Desktop runtime 与构建脚本

### 5.1 `scripts/source-deps.mjs`

- `OFFICIAL_VERSION` 更新为 `0.1.5-rc.1`。
- fork 版本改为同一精确 `0.1.5-rc.1.zw.N`，或使用显式包映射；禁止单一模糊 fallback 产生混合层。
- source package discovery 覆盖 `packages/*/*`、`vendor/*`、`apps/*` 和 `native/system`，优先从 workspace manifest 发现 owner。
- `dsh-compaction-hierarchical` 的 stock `dsh-compaction-basic` 测试边保持官方 rc.1，以证明插件本身的兼容路径；Desktop runtime 的 fork stock basic 另行验证。
- unlink 后重新生成所有插件 package.json/lock，再 link 到 `c7da3280b9` 及后续 toolbar 提交验证。

### 5.2 `scripts/prepare-runtime.mjs`

- bump `SCRIPT_REV`。
- `FORK_MODIFIED` 与最终 `publish-fork.mjs --list` 完全一致。
- 每个 fork 包只接受本次指定的精确 `.zw.N`；移除逐包向下寻找旧 zw 的行为。
- dependencies 使用 `npm:@crazx/...` alias。
- peerDependencies 保留原 `@deepseek-ai/*` key，并写入精确可满足的 fork semver；不要改名为 `@crazx/*` peer key。
- runtime manifest、tools dependency 和 source clone 统一使用 Harness 要求的 `pnpm@11.7.0`，不再依赖环境中的 pnpm 10。
- runtime pin 最后更新到新 fork tag 的不可变 SHA。

### 5.3 原生与 Electron

原生包没有从 alpha.1 到 rc.1 的改名：仍为 `native/system` 和 `@deepseek-ai/node-addon-system*` `0.1.2`。工作重点是发现、打包和运行验证，不修改坐标。

新增真实 Electron one-node smoke：

- 用打包后的 Electron 和 `ELECTRON_RUN_AS_NODE` 启动 sidecar，而不是 tools Node 24。
- 验证随机端口 readiness URL/token、关闭和进程树清理。
- 在打包产物中实际 import `@deepseek-ai/node-addon-system` 并调用 flock 能力。
- macOS 验证没有第二个 Dock identity，LSUIElement helper 和 dock guard 正常。

## 6. 插件兼容矩阵

| 插件 | 结论 | 必须实施 |
|---|---|---|
| `dsh-branding` | API 兼容 | 用 `DSH_CLIENT_TITLE=Oh My DSH` 作为部署主路径；补中英文/自定义 title 测试，或收窄 README 承诺 |
| `dsh-compaction-hierarchical` | 阻断 | 完成 V3 system head、真实 compaction transaction、usage、package surface 和 pack 验证 |
| `dsh-desktop-bridge` | 阻断 | 恢复 toolbar；通知改从 `ctx.uiSession.pendingInteractions` 取权威状态；移除 feature row 的 `immediately:true` 和空 invariant |
| `dsh-fs-observation-log` | 阻断 | 使插件真正激活；修复 fork-cut 证据越权、SessionId 文件名碰撞/header 校验、路径语义和物理日志上限 |
| `dsh-mcp-settings` | 阻断 | 强制 fork mcp-client status；删除空 invariant；补真实三行 composition 与状态生命周期测试 |
| `dsh-model-efforts-editor` | 高优先 | dispose 清理 DOM mark/class；把 CSS 字符串中的 `//` 改为合法注释；覆盖单独加载和双插件顺序 |
| `dsh-model-image-input` | 高优先 | dispose 清理 DOM mark/class；验证 stock 未保存 draft 的覆盖风险和 revision conflict |
| `dsh-ohmymemo` | 阻断 | 不能用 `ToolExecution.parent` 判定 subagent；按 Session origin/delegation metadata 鉴权；修复跨 route effort 继承 |
| `dsh-provider-balance` | 阻断 | `credentials/updated` 改为 `credentials/reference-updated`；迁移到 `settings.models.provider-card` Slot，退休 DOM parser |
| `dsh-reasoning-efforts` | 高优先 | thinking-format mirror 加入 upstream 支持的 `baseten`，增加目录一致性测试 |
| `dsh-send-while-running` | 阻断 | Slot 组件改用 `useSession`/`useInput`，使用 `attachmentIds`，不得依赖 Slot owner 不提供的 props |
| `dsh-thread` | 阻断 | 六处 `Session.events` 改为一次性 `snapshotEvents()`；修正 client/host manifest 依赖并补真实 Host+Client 回归 |
| `dsh-usage-stats` | 阻断 | 删除不存在且未使用的 `dsh-client-runtime` inject/peer/dev/externals；修复 SlotRegistry 测试类型；更新 shipped roster 13→14 |
| `dsh-web-search-toggle` | 阻断 | `api-remotes` 改为 `@deepseek-ai/dsh-api-gateway/client` augmentation/inject/dev+peer；TSX 纳入 typecheck |

所有插件都要把 devDependency 和 lock 更新到目标 rc.1/fork 层。旧 prerelease peer 范围如 `>=0.0.1-rc.1 <1`、`>=0.1.1-rc.1 <1`、`>=0.1.2-alpha.3 <1` 不满足 `0.1.5-rc.1`；统一提升到 `>=0.1.5-alpha.1 <1` 或有意要求 rc 的 `>=0.1.5-rc.1 <1`。

## 7. 关键插件的详细行为要求

### 7.1 Desktop bridge

- macOS 展开和折叠 sidebar 时始终恰好有一个可达的 sidebar toggle 和 New Session。
- toolbar 或明确的 overlay fallback 中必须保留更新与通知控件。
- pending interaction 通知由 `dsh-client-ui-session` 权威 store 驱动，不读取 SessionSummary 中不存在的字段。
- fullscreen/rightbar/traffic-light clearance、plain Web inert gate、dispose/HMR 均需浏览器验证。

### 7.2 Thread

- 六处全日志读取替换为 `snapshotEvents()`；同一决策内只捕获一次快照，避免跨时刻读取不一致。
- manifest 增加 client `ui-layout`、`ui-settings-general`，Host 增加 runtime-required `system-prompt`、`session-projection` peer/dev edge。
- `sidebar.workspaces.sessionListView` 当前不存在；若分组视图不是发布验收项，删除死代码并记录限制，不以本地类型声明冒充 Slot 注册。
- 验证 draft sealing、purity、title lookup、redelivery/reconcile、exactly-two injected messages、restart 无重复。

### 7.3 Send while running

- 组件实现 `PropsRuntime<'conversation.input.right'>` 所需注入面，通过标准 hooks 订阅 session/input。
- 文本或 attachment 存在且普通 session 正在运行时，stock Send 旁只出现一个插件 Stop。
- idle、empty、removed、subagent、blocked 等状态不得重复或误显示；点击只 cancel 一次。

### 7.4 FS observation log

- 在 bundle Host composition 中安装一个进程级实例，或由安装器为每个支持 preset 生成用户自有 preset；禁止编辑 shipped preset。
- 选择 Host 单实例时，确认 untagged Host listener 在 Agent scoped dispatch 中有效，不额外添加错误的 `{ global: true }`。
- 默认禁用或删除 ancestor healing，直到证据记录能绑定到 fork cut；父会话 fork 后新增的 read 不得授权子会话 edit。
- 文件名使用完整 opaque SessionId 的非碰撞 hash，并验证 sidecar header.id 与请求 id 一致。
- 对齐空白/相对/`~` 的 `DSH_HOME` 解析、symlink+`..` target resolve 语义，以及 JSONL 物理记录/字节上限。

### 7.5 OhMyMemo

- `ToolExecution.parent` 是 PTC transport token，不代表 subagent。鉴权只看 Agent Session 的 origin/delegation metadata。
- direct root 和 root PTC 子分发允许写；实际 subagent 和 nested subagent 按策略拒绝。
- 默认模型 effort 只在 provider/model route 相同的情况下继承；切换 route 时仅使用显式且验证通过的 effort，否则省略。
- Store、Manager、API 保持 Host 单实例；Tools 和 Context 是否全局启用必须形成产品决策。推荐放入用户自有的 OhMyMemo-enabled preset，使 minimal/restricted preset 不被强制注入五个工具和 capsule。
- 修正 Typert sourceLocation、方法数量文档和缺失的 system-prompt peer。

## 8. 实施顺序

1. **P0 Fork 基座**：从 `c7da3280b9` 建实施分支，恢复 toolbar/layout/conversation/test-runtime，完成 compaction 和 todo guard 的剩余测试及 package 修正。
2. **P0 Desktop 阻断插件**：修复 thread、send、usage-stats、web-search-toggle、provider-balance、MCP status 解析。
3. **P0 安全与权限**：修复 FS fork-cut/ID 隔离和 OhMyMemo PTC/subagent 权限；决定其 preset 所有权。
4. **P1 生命周期与一致性**：修复两个模型编辑器 dispose、efforts CSS、reasoning `baseten`、bridge notification store。
5. **Fork 发布**：统一 manifests 为 rc.1，运行构建/测试/hygiene/dry-run，发布完整 `.zw.N` 集合，逐包 `npm view` 验证后打 tag。
6. **Desktop 依赖迁移**：更新 `source-deps.mjs`、所有插件 package/lock、`prepare-runtime.mjs` 和 pnpm 版本；先 source-link 验证，再 frozen registry install。
7. **Runtime 组装**：运行 prepare/assemble，检查无官方 fork 副本、无混合 zw 层、native 包和三方插件只出现一次。
8. **数据和打包验证**：复制旧 Home，打开 alpha.1 产生的 Session V3 并继续 append；验证 settings/credentials/presets/memory/FS evidence；执行 Electron one-node smoke。
9. **最后切 pin**：仅在上述全部通过后更新 `runtime/revision.json`，再构建签名包并执行升级/回滚演练。

## 9. 验证矩阵

每个插件至少覆盖四种安装面：

- A：旧 alpha fork 回归。
- B：官方 rc.1；对依赖 fork MCP status/toolbar 的插件应明确失败或标记不支持。
- C：目标 merged/published rc.1 fork。
- D：从 registry 和插件 tarball 组装的干净 Desktop Home，不使用 source link。

每个安装面执行适用项：

- frozen install 和 resolved package identity。
- `pnpm run typecheck`、unit/component tests、build、`pnpm pack --dry-run`、publint。
- 通过真实 Loader 加载 cordis patch/preset，检查无 pending、missing、duplicate service。
- Host+Client 行为、HMR/dispose、restart/persistence、多 Agent/preset scope。
- 安全拒绝场景和已有用户数据升级。

建议命令：

```sh
# Harness
pnpm --version
node scripts/publish-fork.mjs --list
pnpm run typecheck
pnpm exec vitest run packages/compaction/compaction-basic/tests packages/guard/todo-completion-guard/tests
pnpm run build
node scripts/publish-fork.mjs 1 --dry-run

# 发布后逐包验证
npm view @crazx/dsh@0.1.5-rc.1.zw.1 version

# Desktop
pnpm run unlink:source
pnpm run link:source
pnpm run plugins:check
node --test scripts/shipped-plugins.test.mjs
node scripts/prepare-runtime.mjs
pnpm run desktop:smoke
pnpm run check
pnpm run desktop:build
```

发布后还必须检查：

- `runtime/build/<sha>/dsh/node_modules/.pnpm` 中不存在同一 fork package 的官方和 `@crazx` 双份实现。
- 每个 fork 包版本为同一 `.zw.N`。
- 14 个 shipped plugin 均被发现；usage-stats 不注入 test runtime。
- MCP 的三行、OhMyMemo 选定的行、FS Host 行和各 Client Slot 只装载一次，dispose 后全部撤回。
- 打包 Electron 能加载 native system/flock，sidecar 正常退出且无孤儿进程。

## 10. 数据迁移与回滚

Session 格式在两个基线中均为 V3，不创建 V4，不移动、覆盖或删除已提交 generation。升级测试使用 Home 副本：读取 alpha.1 生成的 V3 JSONL，继续 append 和 flush，确认旧文件保留且新写入可重启读取。

保留并验证以下数据：

- `sessions`、credentials、settings、用户 presets。
- OhMyMemo Markdown store 和 storage-domain 数据。
- Web Search foreign patch 内容。
- FS evidence；若采用 hashed SessionId 文件名，提供一次可重复、带 header 校验的迁移，旧文件只读保留直到验证完成。

回滚策略：

1. 发布前不改 runtime pin，直接继续使用 `98bcf0c6`。
2. 新 runtime 组装保留独立 `runtime/build/<sha>`，失败时恢复旧 `revision.json` 并重新组装，不覆盖旧 build。
3. 插件 schema/storage 变更必须向后可读；没有经过迁移验证的写入不得在正式 Home 首次启动时执行。
4. 签名包升级演练使用 Home 副本；确认回滚到旧包仍可打开原有数据后才进入正式发布。

## 11. 发布验收条件

以下条件全部满足才可宣布兼容完成：

- fork 基于 `c7da3280b9`，toolbar 和所有保留 fork 能力已移植并有真实 composition/UI 生命周期测试。
- 最终 `publish-fork.mjs --list`、实际 npm 发布集合和 Desktop alias 集合完全一致，版本统一为一个 `.zw.N`。
- Harness typecheck、聚焦测试、build、hygiene、translation/archive/generated checks 和 dry-run publish 通过。
- 所有插件使用 rc.1/fork frozen locks；不存在 alpha DSH 包和不接受 rc prerelease 的 peer range。
- 14 个插件逐一通过目标 runtime 的 typecheck/test/build/pack/Loader 验证，表中阻断项全部关闭。
- Desktop scratch Home 和旧 Home 副本都能启动；Session V3、settings、credentials、presets、memory 和受支持的 FS evidence 可继续使用。
- 真实 Electron one-node、native addon、macOS toolbar/notification、Windows 安装面和进程清理 smoke 通过。
- `runtime/revision.json` 指向已发布并打 tag 的不可变 fork SHA，不指向裸 upstream commit 或未发布 merge commit。
- 最终 `git status --short` 仅包含计划内 tracked 变更，并保留审计前已有的 9 个 usage-stats preview 未跟踪文件。
