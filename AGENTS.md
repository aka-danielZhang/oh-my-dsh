# AGENTS.md

oh-my-dsh 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的桌面化 monorepo：出树插件与 Electron 壳同仓、独立发版。两个平面：

- **`plugin/<name>/`** —— 可独立安装、独立打 tag 的 DSH 插件包。成员：`dsh-desktop-bridge`（桌面门控：外链路由、原生注意力通知、桌面指示）、`dsh-mcp-settings`（2026-08-19 subtree 迁入）、`dsh-provider-balance`（2026-08-19 subtree 迁入，纯 DOM 注入）、`dsh-reasoning-efforts`（2026-08-20 新写，host-only：给手写 llm-pi-ai 模型补 `reasoningEfforts` 声明；0.2.0 起规则可附带 `compat` 开关（`supportsReasoningEffort`/`thinkingFormat`，zai 系路由自动探测为关、必须显式声明档位才上线），efforts 与 compat 两片按「缺什么补什么」独立判定、目录继承只豁免 efforts 片，契约见包内 README，决策见 `docs/notes/2026-08-20-reasoning-efforts.md` 与 `docs/notes/2026-08-27-reasoning-efforts-compat-fill.md`）、`dsh-web-search-toggle`（2026-08-20 新写，双面：通用设置页「Web Search」开关——DEEPSEEK_API_KEY 状态提示 + home patch 持久化 + Host assembly/guard 跨 Agent Preset 关闭原生 `web_search`，契约见 `docs/notes/2026-08-20-web-search-toggle.md` 与 `docs/notes/2026-08-21-web-search-toggle-preset-scope.md`）、`dsh-compaction-hierarchical`（2026-08-20 新写，host-only：继承 stock compaction 事务，以有界 map-reduce 让小上下文模型压缩大历史；0.1.3 起作为官方 upstream/既有用户 preset 的兼容 Provider 保留，Oh My DSH 默认由 fork stock basic 接管；契约见包内 README，决策见 `docs/notes/2026-08-20-hierarchical-compaction.md` 与 `docs/notes/2026-08-22-stock-hierarchical-compaction.md`）、`dsh-branding`（2026-08-21 新写，browser-only：占用 `sidebar.brand.name` 替换字标为 "Oh My DSH"+"Harness" pill 并重写 document title——**始终挂载、无桌面门控**，终端/浏览器/桌面同一条路；决策见 `docs/notes/2026-08-21-branding-plugin.md`）、`dsh-fs-observation-log`（2026-08-21 新写，host-only：持久化 `fs/observed` evidence 到 `$DSH_HOME/fs-observation-log/`，进程重启/fork 后在 edit/write 前置阶段按「版本 token 仍相等」恢复观察记录，消除 `FS_NOT_OBSERVED` 误伤且不削弱 stock guard——preset 行挂载、patch 刻意为空、零 harness 运行时 import；契约见包内 README，决策见 `docs/notes/2026-08-21-fs-observation-log.md`）、`dsh-model-image-input`（2026-08-21 新写，browser-only：以 dsh-provider-balance 同类纯 DOM 注入姿势，在 stock「设置→模型→供应商→自定义设置」的每条已保存 pi-ai 模型行内插入图片输入按钮；非原生三态菜单（跟随默认/仅文本/文本+图片）固定 196px、向左对齐并按实际高度上下翻转，经 `settingsScope` + revision-fenced `settings.mutate` 写整组 `models` 数组、即时生效；中英文 aria/action 双锚排除 DeepSeek 卡片，DOM 失配 fail-invisible，client 半零 `@deepseek-ai/*` 值导入；契约见包内 README，决策见 `docs/notes/2026-08-21-dsh-model-image-input.md`）、`dsh-send-while-running`（2026-08-22 新写，browser-only：占用已声明加性槽 `conversation.input.right`（list、replaceRisk none）；0.2.0 起按钮是**补位 Stop**——0.1.2-alpha composer 的 `primaryStops` 加了 `(empty || blocked)` 项，普通会话 running 且草稿有内容时 stock 主按钮保持 Send 且整行无 Stop，本插件在该状态渲染红色 Stop（点击走 stock 同款 `sessions.scope(id).get('conversation').cancel()`，经注册定义的 per-session `inject` 下发、点击时惰性 `ctx.get('sessions')`），草稿清空 stock 主按钮翻回 Stop 即自动退场、永不重复；0.1.x 的孪生 Send 姿态作废（stock 已原生 running 发送，孪生只会重复）；可见性排除 continuable 子会话与 removed；0.1.1 起的全局「任何状态把 Stop 染主题柔和红」recolor 保留（锚 `button:has(> svg > rect)`，本插件按钮在 slot wrapper 内染不进来、自带同款红）；按钮 `order:1` + `:has()` 作用域把 stock 主按钮 `order:2`，卸载即回到 stock 布局，锚点只用 `[data-slot]` 接缝与 `button:last-of-type`（不引 stock CSS-module 类名）；ui-conversation/locale/runtime 仅 type-only import（client bundle 唯一 require 是 react/jsx-runtime，无需 runtime peer 链接），无桌面门控，终端/浏览器/桌面同一条路；契约见包内 README，决策见 `docs/notes/2026-08-22-dsh-send-while-running.md` 与 `docs/notes/2026-09-03-stop-while-running-rework.md`）、`dsh-model-efforts-editor`（2026-08-27 新写，browser-only：dsh-model-image-input 同类纯 DOM 注入姿势，在 stock 模型设置卡每条 pi-ai 模型行内注入推理档位按钮与内联编辑弹层——三态（跟随默认 / 不推理 / 自定义档位+线上值）+ Z.ai compat 勾选（`supportsReasoningEffort`/`thinkingFormat: zai`），经 `settingsScope` + revision-fenced `settings.mutate` 写整组 models 数组即时生效；上游 stock 刻意不提供 provider 级 effort 控件而 composer 选择器又依赖已有声明，本插件补上 per-model 编辑入口；锚定规则与 fail-invisible 边界同 model-image-input；契约见包内 README，决策见 `docs/notes/2026-08-27-dsh-model-efforts-editor.md`）、`dsh-thread`（2026-08-21 新写，preset-owned 双面插件：Thread 模式在依赖前序结果但属于不同阶段/产物的边界准备有界 Handoff Draft，只有直接用户确认才在同一 Workspace 创建承接 Session——0.2.0 起承接会话继承来源会话 preset，`standard-thread` preset 下线，bundle 层全局挂载 `thread_handoff` 工具行并由「设置→通用→Thread」开关（settings 命名空间 `dsh-thread`，默认开）统一门控工具注入与全部 UI；稳定 `threadId` 关联普通 Session，Header 右侧 utility 图标在对话正文右上角切换持久大胶囊浮层（只由该图标关闭；blank 空日志新会话既不渲染入口按钮也不渲染浮层），展示完整关系导航（会话 8 行/页分页并自动跟随当前会话所在页）和按 Session 切换的显式产物列表（产物 5 卡/页分页），无 Thread 时为居中引导空态而非裸段落，且不占用原生 `details`；侧栏经 fork `sidebar.workspaces.sessionListView` 视图环提供「Thread 分组」列表视图；契约见包内 README，决策见 `docs/notes/2026-08-21-session-thread.md`、`docs/notes/2026-08-25-thread-panel-empty-state-pagination.md`、`docs/notes/2026-08-25-thread-toggle-sidebar-grouping.md` 与 `docs/notes/2026-09-01-thread-card-state-and-settings-row.md`）
- **Electron 壳** —— spawn harness sidecar、端口分配、就绪检测、窗口加载。壳层不含业务逻辑；harness 不感知壳的存在。业务集成只特殊对待桥插件（gate + IPC）；分发层另按本文件的 desktop-owned 清单打包/安装层次压缩与 Web Search 开关，但不读取其 Provider/策略业务。0.2.x Tauri 壳已删除，只留 `scripts/tauri-cutover-latest-json.mjs` 给仍在轮询旧端点的客户端。

规范层级：[README.md](README.md) 记录「为什么」（技术选型）；本文件记录「契约与约定」（怎么做）；代码是实现。冲突时以本文件为准。改契约必须同 PR 改本文件。

## Repository layout

```
plugin/<name>/               一个可独立发版的 DSH 插件包（目录名 === package.json name）
  dsh-desktop-bridge/        桌面门控桥 + 日志汇（本文件「插件契约」一节）
    src/index.ts             host half：surface 插件，空 apply
    src/log-sink.ts          日志汇 host 行：ctx.logger → 每启动一个 JSONL 文件（见「日志汇行」）
    src/invariant.ts         伙伴不变量说明
    src/client/              browser half：env 探测 + 三个桥 + shell.overlay 桌面指示 + 标题栏融合
    tests/                   node:test 单测（纯函数）
src/                         Electron 壳（main / preload / sidecar / profile CAS；图标与 DMG 背景）
scripts/                     壳层与工具脚本：prepare-runtime.mjs、prepare-desktop-bundle.mjs、build-electron.mjs
docs/                        packaging-playbook.md + notes/（决策记录住仓根，不跟包走）
```

`CLAUDE.md` 是指向本文件的 symlink（与 DSH 仓库同惯例）：改 AGENTS.md，不要改链接。

## 插件 monorepo 规范

本仓是「个人 DSH 扩展 + 桌面壳」的单一事实源。插件与桌面同仓，是为了一次 checkout、一次 harness rc bump 过全树，同时保留各自的发布节奏。对照：[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) 把 DSH 钉在 npm 上、用仓根 `patches/` 改上游压缩产物——那是壳侧补丁模型，不是插件布局，不学。

### 落点

- **新插件目录一律经脚手架生成**：`pnpm run plugin:new -- <dsh-name> [--face host|client|dual] [--id <rowId>] [--description <text>] [--preset-owned]`（`scripts/new-plugin.mjs`）。三种形态从仓内在售插件蒸馏：`host`（蓝本 dsh-fs-observation-log）、`client`（蓝本 dsh-branding：空 host apply + `exports["./client"]` 浏览器半）、`dual`（蓝本 dsh-web-search-toggle）；`--preset-owned` 生成 install-only 空 patch + `preset-snippet.yml`（行归 agent preset）。脚本同时把 `plugin/<name>/lib/` 追加进根 `.gitignore`，devDeps 钉在生成时从蓝本包实时读取（基线 bump 后脚手架自动跟随，fallback 表在脚本内单点维护）。**手搓 manifest 禁止**（exports/dsh 块/peer range/tsdown 客户端契约三份样板极易漂移）；生成后仍需人工补：description、README、`docs/notes/` 决策记录、本清单行。决策见 `docs/notes/2026-08-21-plugin-scaffold-script.md`。
- 每个插件一个目录：`plugin/<package.json name>/`。目录名必须等于未加 scope 的包名，因为 `dsh plugin --profile web add <path>` 按这个路径装包，entry id 也是这个名字。
- 一个目录 = 一个可 `plugin add` 的安装单元，自带 `package.json`、`dsh.bundle`/`cordis.patch.yml`、源码、测试。mcp-settings 那种「一包三行」（manager / inventory / ui）仍是**一个**目录、一份 patch，不是三个目录。
- 桥插件不能当容器：它的 apply 在非桌面环境必须零副作用；mcp-settings / provider-balance 在终端 `dsh web` 也要工作。塞进 `dsh-desktop-bridge` 会把「桌面门控」和「始终挂载」搅在一个 fiber 里。
- 不要再套 `plugin/packages/`，不要把插件放到仓根与 `src/` 平级，不要放进 fork 的 `packages/`。

### 发版

- 插件与桌面**锁步禁止**。各包 `package.json` 的 `version` 独立走动。
- **何时打桌面 `v*`**：壳 / IPC / 打包 / runtime 解压 / 标题带更新 / desktop-owned 七包升版 → 必须 bump 仓根 `package.json` 并推 `v<semver>`。纯插件且不在 desktop-owned 清单（如 mcp-settings、provider-balance、branding）→ 只打 `<包名>-v<semver>`。壳没变不要发桌面版。同一天能合并的壳修复合成一版，避免同事连下两次约 450MB。
- **旧桌面 Release 附件禁止删**（尤其 zip + `.blockmap`）。Mac 差分要拉上一版 blockmap；删了下一次热更会整包。
- **版本号策略（0.2.0-rc.1 起，学 harness 的 rc 节奏）**：桌面走 semver 预发布段——大功能进 `0.N.0-rc.x`，稳定后摘 `-rc` 出 `0.N.0`，纯修复走 `0.N.M+1`；插件各自 semver，同样允许 `-rc.N`；fork 标识走 `+zw.N` build metadata（semver §10，排序忽略不影响升级链）。**刻意不**在桌面版本里嵌 harness 基线（`0.1.0-rc.7.desktop.1` 这类嵌套段合法但小于已发的 0.1.3，首个新版即断更新链）；基线由 `runtime/revision.json` 记录。**GitHub Release 不勾 prerelease**——`releases/latest` 端点排除 prerelease，勾了 updater yml 即 404、自动更新断链；`-rc` 只体现在版本号语义。壳侧 `autoUpdater.allowPrerelease = false`（不要让 electron-updater 因 semver `-rc` 去刮 `releases.atom`：失败的空 `v*` tag 会毒死已装的 -rc 客户端）。release.yml 有防呆：tag 版本 ≠ 仓根 `package.json` 版本即 fail。
- Git tag 无斜杠三分家：桌面 `v<semver>`（例 `v0.2.0-rc.2`，经典风格）；插件 `<包名>-v<semver>`（例 `dsh-provider-balance-v0.4.2`；包名都是 `dsh-*` 起，天然不与 `v*` 冲突，workflow 按「最后一个 `-v`」切名与版本）；**runtime fork 标签 `v<基线>+zw.<补丁>`**（例 `v0.1.0-rc.7+zw.1`——semver build metadata 标识 zw fork，行业标准做法，基线升级时 `+zw.N` 递增；历史 `desktop/v0.1.0/1` 标签仍有效可fetch，revision.json 钉 ref 字符串）。GitHub Release 按 tag 分流，互不覆盖附件。**latest 指针纪律**：Electron 自动更新端点是 `releases/latest/download/latest-mac.yml` / `latest.yml`。0.3.x desktop Release `make_latest: true` 独占 latest，并额外放一份 cutover `latest.json` 给仍在轮询旧端点的 0.2.x（只通知换壳，不能热更新）。插件 Release 一律 `make_latest: false`（release.yml 已内置；网页手动发插件 Release 时同样不得设为 latest）。
- 安装面保持 `dsh plugin --profile web add <repo>/plugin/<name>`（file: / git 路径均可）。**插件 npm 双通道（2026-08-21 起）**：allowlist 插件（`dsh-mcp-settings`、`dsh-provider-balance`）随 `dsh-*-v*` tag 额外发 npm，安装面多一条裸包名 `dsh plugin --profile web add <name>`（`dsh plugin` 原样转发 pnpm，天然支持 registry 包）；其余插件仍只走 git tag 分发。npm 通道契约：workflow 的 npm channel gate 是唯一 allowlist 事实源；tag 版本已上 npm 则跳过（幂等，重跑安全）；npm 发布在 GitHub Release **之前**，失败即中止（fail loud，不出「tarball 有、npm 无」的半发布态）；token 走 repo secret `NPM_TOKEN`（npm 账号 danielzhang688，与 fork 仓 publish-fork 同一 token）；有 build script 的包（mcp-settings）先按 CI 同款 baseline checkout + 锚 + install + build 再 publish。⚠️ `dsh-provider-balance` 的 npm 包名原由 CalvinQin 注册（其 0.2.0），danielzhang688 无写权限——owner 侧 `npm owner add danielzhang688 dsh-provider-balance` 之前，该包的 npm 步骤会 403 fail loud（属预期，权限补齐后重跑即可）。**对 harness 的依赖**则一律 npm（「npm 依赖纪律」一节），与 fork 的 npm 发布纪律（fork FORK.md）互为两面。
- 壳的 release 只携带其运行面直接依赖的桌面自有插件，不按 `plugin/*` 无差别收包。当前集合是 bridge 0.2.0-rc.9（`bridge.tar.gz` → `~/.dsh-desktop/bridge/`；0.2.0-rc.3 起标题栏融合 CSS 首条规则 `html,body{overflow:hidden;}` 锁死根滚动；0.2.0-rc.4 起安装确认框展示 CHANGELOG 抽取的更新说明；0.2.0-rc.5 起 IPC 载体为 `window.__DSH_DESKTOP_IPC__`，兼容归档 Tauri 的 `__TAURI_INTERNALS__`；0.2.0-rc.6 起系统通知带 sessionId，点击回跳 `sessions.open`；0.2.0-rc.7 起新建/打开会话的 agent 附着脉冲不出 turn-done；0.2.0-rc.8 起更新入口改为点击弹窗下载——进度条 + 取消下载（新增 `dsh_desktop_cancel_update` IPC）+ ready 后「稍后 / 重启以更新」，不再发现即后台自动下载，决策见 `docs/notes/2026-08-28-update-download-dialog.md`；0.2.0-rc.9 起弹窗图标块为静态 app logo（`update-logo.tsx`），旋转只留在带内按钮；同版壳侧修复更新退出序列 veto 并加 slim 运行时预置，决策见 `docs/notes/2026-08-31-update-restart-fix.md`）、层次压缩兼容 Provider 0.1.3（`compaction-hierarchical.tar.gz` → `~/.dsh-desktop/plugins/dsh-compaction-hierarchical/`）、Web Search 开关 0.1.4（`web-search-toggle.tar.gz` → `~/.dsh-desktop/plugins/dsh-web-search-toggle/`）、模型图片输入 0.1.1（`model-image-input.tar.gz` → `~/.dsh-desktop/plugins/dsh-model-image-input/`；无需 runtime peer 链接——client bundle 零 `@deepseek-ai/*` 值导入、host 半空 apply）与运行中补位 Stop 0.2.0（`send-while-running.tar.gz` → `~/.dsh-desktop/plugins/dsh-send-while-running/`；同为零值导入的 browser-only 形态、无 peer 链接；0.1.1 起 Stop 按钮任何状态染主题柔和红，与蓝 Send 视觉区分；0.2.0 起适配 0.1.2-alpha composer——`primaryStops` 加 `(empty || blocked)` 后普通会话 running+有草稿时整行无 Stop，插件在该状态渲染补位红色 Stop、点击走 stock 同款 `sessions.scope(id).get('conversation').cancel()`，孪生 Send 姿态作废，决策见 `docs/notes/2026-09-03-stop-while-running-rework.md`）、模型档位编辑器 0.1.1（`model-efforts-editor.tar.gz` → `~/.dsh-desktop/plugins/dsh-model-efforts-editor/`；同为零值导入的 browser-only 形态、无需 peer 链接——dsh-model-image-input 同类纯 DOM 注入，在 stock 模型设置卡每条 pi-ai 模型行内提供推理档位内联编辑：三态跟随默认/不推理/自定义档位+线上值 + Z.ai compat 勾选；决策见 `docs/notes/2026-08-27-dsh-model-efforts-editor.md`）与 Thread 交接 0.2.0-rc.6（`thread.tar.gz` → `~/.dsh-desktop/plugins/dsh-thread/`；显式跨会话 Handoff 双面插件：bundle 层全局挂载 `thread_handoff` 工具 + 通用设置总开关（settings 命名空间 `dsh-thread`，默认开）+ 看板/侧栏分组/卡片 UI；host 半按 package.json `dependencies`/`peerDependencies` 链到 assembled runtime（缺 dependency 即 fail loud）防模块身份分裂；0.2.0-rc.3 起 host bundle 内联 zod（zod 归 devDeps + tsdown `deps.onlyBundle`，web-search-toggle 同款）——桌面解包姿态无 node_modules、仅有该链接表，裸 `zod` import 会让 loader entry 全挂、boot 即死（rc.23/rc.24 无法启动的根因），且 typert codec 走 duck check、内联副本合法；0.2.0-rc.4 起对齐 0.1.2 删除的 `settingsNamespace()`——`register` 直接收命名空间字符串（wst 0.1.4 同款；rc.25/rc.26 仍无法启动的第二层根因，rc.27 才是 Thread 进包后首个可启动版，rc.23–rc.26 用户均需手动下载）；0.2.0-rc.5 起适配 0.1.2-alpha.3 运行时——上游移除 `connection.api` 门面后，创建/改名改走 typed Remote `ctx.remote.session.create/rename`（outward `ctx.sessions.create` 仍不收 `agentPreset`，不满足 preset 继承契约），`dsh-client-runtime` 下线涉及的 `ISessions`/`SettingsScope`/`useSessions` 合并改从 `dsh-api-session-controller`（crazx 别名）、`dsh-client-ui-settings`、`dsh-client-ui-session`、`dsh-client-ui-renderer` 进口，devDeps 全量钉 0.1.2-alpha.3 基线含类型闭包（防 pnpm 自动 peer 拖入 rc.8 旧副本致类型静默塌缩）；0.2.0-rc.6 起 client 入口 inject 补声明 `remote.session` 点号子路径——cordis 4 把每个 Remote namespace 挂成独立服务 `remote.<namespace>`，`ctx.remote.session` 经 traceable 代理回读 `ctx['remote.session']` 时只沿声明过该名的 fiber 链解析，未声明即 apply 抛 `without inject`（stock session-controller/ui-plan 同款声明；typecheck 对此失明，`Context['remote']` 类型把 session 声明成普通属性）；决策见 `docs/notes/2026-08-21-session-thread.md`、`docs/notes/2026-09-02-thread-desktop-owned.md`、`docs/notes/2026-09-02-thread-zod-inline.md`、`docs/notes/2026-09-02-packaged-profile-smoke.md`、`docs/notes/2026-09-03-thread-remote-session-create.md` 与 `docs/notes/2026-09-03-thread-remote-session-inject.md`）：prepare 对七包分别 typecheck/test/build、记录 tarball hash，并额外把 Web Search / model-image-input / send-while-running / model-efforts-editor / thread 的版本写进 revision manifest；壳首启原子解压并把七包作为同一事务幂等 `plugin add` 到 web Profile。层次压缩的根 patch 刻意为空，安装只保证用户 preset 可在隔离 `compaction` realm 解析该 Provider，不替用户改 shipped/default preset；Web Search 插件持久化 home patch，并以 Host assembly/guard 对所有 Agent Preset 执行开关策略。随 `.app` 发货的插件在自己的 `package.json` 标 `dsh.desktop.ship: true`（可选 `tarball` / `dest` / `env` / `pin`）；prepare、壳解压、`plugin add`、CI 检查与 packaged `--dump-config` 冒烟都扫这个字段。新插件不要改 workflow。独立插件 tag 不能替代 desktop Release。

### 迁入既有插件仓

- `git subtree`（或 `--allow-unrelated-histories`）保留历史，禁止拷贝文件了事。
- 源仓工作区必须干净：未提交的发版改动先在源仓落地（mcp-settings 0.2.3 的 credentials 竞态就是这种）。
- 迁入后源仓 archive 为只读，不再双写。
- 迁入当天**不上**仓根 `pnpm-workspace.yaml`：桥锁 pnpm 10，mcp-settings 锁 pnpm 11。各包继续自己的 `pnpm install`；workspace 收敛是独立 PR。
- 迁入当天不统一测试/构建工具链。第二步再把裸 `client.js` 分发（provider-balance）收进桥的 tsdown 纯度门。
- **harness 依赖一律 npm**（「npm 依赖纪律」一节）：插件 devDependencies 钉 registry 版本（`@deepseek-ai/*` 官方包在公共 npm；fork 修改面包的自有 scope 版，见 fork FORK.md「发布纪律」）。**源码 link: 依赖是仅限本地调试的显式 posture**，只能经 `pnpm run link:source` / `unlink:source`（`scripts/source-deps.mjs`）进出，不得提交、不得作为默认形态。不能指望 tsx 套用 checkout 的 tsconfig paths——桌面 runtime 的 tsx 4.23+ 只对 tsconfig include 内的文件生效，bare specifier 走纯 Node 上溯解析（2026-08-19 桌面崩溃循环的根因，见 `docs/notes/2026-08-19-log-sink-race-and-plugin-peer-resolution.md`；这也解释了为何 link posture 仍需包内 node_modules 物化）。

### 跨包纪律

- 跨插件只走 slot 与 ctx 服务，禁止 import 另一插件的实现符号；harness 包只做 type-only import（构建时擦除）。
- 决策记录一律 `docs/notes/`（仓根），不跟包走。包内 README 只写该包的安装与行为。

## npm 依赖纪律

npm 版本依赖是**唯一常态**；源码依赖仅限本地调试，且只能经专门命令进出：

- **默认（提交态）**：所有包的 `@deepseek-ai/*` 依赖钉 registry 版本。上游未修改包直接用官方 `@deepseek-ai/*`（公共 npm 已发布到 `0.1.2-alpha.5`，含 `lib/types`；本仓基线随 `runtime/revision.json`）；fork 修改面包用其自有 scope 的发布版（当前为 `0.1.2-alpha.5.zw.1`，见 fork 仓 FORK.md「发布纪律」）。
- **调试（本地态）**：`pnpm run link:source [pkg ...]` 把受管插件的 `@deepseek-ai/*` devDeps 重写为 `link:../deepseek-harness/<subpath>`（锚由 `plugin:setup` 建）并重装；`pnpm run unlink:source` 恢复 registry 版本。映射表（registry 版本 ↔ 源码子路径）在 `scripts/source-deps.mjs` 单点维护，新依赖进映射表才算受管。
- **禁止**：手写 link:/file:/`../` 依赖并提交；以源码 posture 发版；绕过映射表私接源码。发布与 CI 检查在 registry posture 下进行。
- 遗留迁移：`dsh-desktop-bridge` / `dsh-mcp-settings` 的 `@deepseek-ai/*` devDep 已钉 registry，但桥自有 `dsh` 锚与 mcp-settings 的 tsconfig project references 还在，按本纪律迁入 `source-deps.mjs` 受管后删除各自 setup 锚——迁移完成前不得新增同类形态。

## 插件契约（dsh-desktop-bridge）

插件是标准 DSH 双面包：`package.json` 带 `dsh.client`（browser half 发现）与 `dsh.bundle`（`dsh plugin add` 激活层）manifest；node half `src/index.ts` 空 apply，唯一作用是让 Loader 行合法（浏览器半经 `exports["./client"]` 发现，参照 `@deepseek-ai/dsh-client-ui-directory-picker-native` 的形态）。

### 环境探测与门控

- 门控信号是 `window.__DSH_DESKTOP__`（壳在 webview 初始化脚本注入）：`{ version: 1, shell: string, platform: string }`。`version` 不认识的整数 → 按 1 处理并 `logger.warn`。
- IPC 走 `window.__DSH_DESKTOP_IPC__.invoke(cmd, args)`（Electron preload 注入），可选 `on(event, handler)` 订阅壳 → 页面事件（当前仅 `dsh-desktop-notify-click`）。归档 Tauri 壳仍提供 `__TAURI_INTERNALS__.invoke`，可不提供 `on`。`__DSH_DESKTOP__` 存在而两者皆缺 = 壳契约违约，apply 直接 throw（fail loud，client fiber 失败由 boot 审计上报，不殃及其他插件）。
- 两者皆缺（普通浏览器、终端 `dsh web`）→ apply 立即返回，零注册零副作用：插件恒可挂载、恒无害。

### webview → shell IPC 命令表

壳（Rust 侧）必须注册下列 custom command；插件是唯一调用方：

| 命令 | 入参 | 语义 |
|---|---|---|
| `dsh_desktop_open_external` | `{ url: string }` | 系统浏览器打开 http(s)/mailto 链接。invoke 被拒时插件回退 `window.open(url, '_blank', 'noopener')` 并 `logger.warn`。 |
| `dsh_desktop_notify` | `{ title: string, body: string, sessionId?: string }` | 原生系统通知（回合完成 / 等待输入）。fire-and-forget，拒绝只记日志。Electron 点击横幅聚焦主窗并向页面发 `dsh-desktop-notify-click`（带 `sessionId`），桥插件 `sessions.open(id)`。 |
| `dsh_desktop_save_file` | `{ name: string, base64: string }` | 下载桥：把 base64 字节写入用户下载目录（文件名去路径成分，重名自动加 `-N` 后缀），返回落盘绝对路径。M2 起存在。 |
| `dsh_desktop_check_update` | — | 查询更新端点（M3 起）：有更新返回 `{ update: { version, notes } }`，无则 `{ update: null }`；同时推进共享更新状态；未配置/不可达时返回错误文案（软失败，后台指示器静默）。 |
| `dsh_desktop_update_status` | — | 返回进程级更新状态快照：`idle/checking/current/available/preparing/downloading/ready/installing/restarting/failed`；下载态含 `downloaded` 累计字节与可选 `total`，`ready` 表示签名校验完成、正等待用户确认，并携带本版 `notes`（可空）。 |
| `dsh_desktop_download_update` | — | 单飞执行重新检查→逐 chunk 下载→签名校验；校验后的包仅暂存在当前壳进程内，完成后推进到 `ready`，不安装、不重启。被 `dsh_desktop_cancel_update` 取消时正常返回（不报错），状态回到 `available`。**mac 增补（2026-08-31 起）**：zip 校验后、宣告 `ready` 前追加 slim 运行时预置——从下载的 zip 读 `runtime-revision.json`，若 `runtime/<sha>/.ok` 未命中则**异步**预拉 `runtime-<sha>-<platform>-<arch>.tar.gz` 到 `runtime-tarballs/` 缓存并校 sha256（相位保持 `downloading`、按 `.part` 字节上报进度、total 未知），预置失败则整体 `failed`（留在旧版、可重试，绝不带着缺失运行时重启）；取消会同时 abort 预拉的 curl。Windows NSIS 自带 runtime tar，不预置。 |
| `dsh_desktop_cancel_update` | — | 取消进行中的下载（仅 `preparing`/`downloading` 相位生效，其余幂等 no-op）：壳取消该次 `checkForUpdates` 结果携带的 electron-updater `CancellationToken`，下载回卷后状态回到 `available`（保留 version 与 notes），可重新下载。归档 0.2.x Tauri 无此命令，插件 invoke 失败按「下载继续」软失败处理。 |
| `dsh_desktop_install_update` | — | 只接受 `ready` 状态。Electron：消费已校验包并安装，然后自动重启（成功即进程替换）。归档 Tauri 若判定下一版是 Electron（或 `latest.json` 已失效），改为打开 GitHub Releases 下载页，不安装。 |
| `dsh_desktop_switch_surface` | — | 运行面切换（2026-08-28 起，见「功能面」M2 运行面切换条）：**不带渲染端入参**——壳弹原生右键菜单（「切换运行面…」），菜单项触发壳侧全流程：目录选择器（默认开在 `$DSH_HOME/profiles`）→ 校验 → 确认 → 首次切换跑七包事务 → 重启 sidecar → 窗口重载。归档 Tauri 无此命令，插件 invoke 失败只记日志。 |

加命令 = 先改本表，再改两侧。

### 日志汇行（dsh-desktop-log-sink）

桥包随 bundle 层挂载第二个行 `dsh-desktop-log-sink`（`exports["./log-sink"]`，host-only），解决 harness web 组合里 `ctx.logger` 无出口的问题：内建 sink 只有 1000 条内存环形缓冲，console exporter 未挂载，logger 流量不进 stdout，壳的 `desktop-*.log` 与终端 `web-*.log` 都抓不到它。

- apply 注册一个 `ctx.logger` Exporter：每条消息一行 JSON（`{sn, ts, name, type, text[, backfill]}`；`text` 经 `Logger.format` 展开 printf 占位与 Error 栈，对象用 `util.inspect` 防循环引用），追加写入 `logger-<yyyymmdd-HHMMSS>.log`。级别 default=DEBUG（全量）。目录解析与 `web:log`/壳完全一致（`DSH_WEB_LOG_DIR` → `$DSH_HOME/logs`），`logger-latest.log` 软链指向最新（unix-only）。
- 挂载时先从环形缓冲 backfill 启动早期消息（记录标 `backfill: true`）；进程级状态（文件路径 + sn 水位）放 `globalThis`，HMR 重挂载按水位去重、同一文件续写不新建。
- 写盘失败为尽力而为：报一次 stderr（被壳 tee 捕获）后自闭，绝不把异常抛回日志调用方。
- 该行随桥 bundle 层生效，终端 `dsh web`（同一 web profile）也会启用——刻意如此：终端同样没有 logger 出口。文件与 `web-*`/`desktop-*` 同家族，不轮转，手动清理。

### 壳实现要点（M1，`src/`）

- **sidecar 启动**：按 `findRuntime` 解析出的 runtime 启动 sidecar——打包态为 `ELECTRON_RUN_AS_NODE=1 <electron> [--import hide-dock --import spawn-guard --import tsx/esm] <cli> --profile <name> --port <N> --no-open`（`web` 子命令只是 `--profile web` 的别名；默认运行面 web，切换后按 `active-profile.json`）（macOS one-node 另注入 Dock 守卫：harness 的 `detached` spawn 经 `dsh-pgrp` 只建进程组、不 `setsid`，避免 Launch Services 把 bash/node-shim 登记成 Dock 上的通用 `exec` 图标；`node-shim` 同样 `--import` hide-dock。编译失败则退回原行为）（dev 未打包时：选中组装树带 `.electron-abi` 或 `DSH_ELECTRON_ONE_NODE=1` 同样一份 Node；否则暂用 `runtime/tools/node`）。不经 pnpm。macOS sidecar 作为 GUI 的普通子进程启动，可执行文件是 `~/.dsh-desktop/sidecar-node/<sha12>/DSH Node.app`（LSUIElement + LSBackgroundOnly 的 69KB Electron stub 副本，`Contents/Frameworks` 软链到壳的 Frameworks；复制后必须 ad-hoc codesign，否则 Hardened Runtime 的 Developer ID stub + 改过的 Info.plist 会被 SIGKILL、sidecar 日志空、120s 超时；签失败则退回主程序）——Launch Services 不再把 one-node sidecar 登记成第二颗 Oh My DSH Dock 图标。不依赖本机 clang。退出时按 PPID 走树杀，不用 `kill(-pgid)`（子进程与窗口同组）。Linux 仍 `detached` 进独立进程组。终止信号打树；Windows 走 `taskkill /T`。`~/.dsh-desktop/sidecars.json` 清扫孤儿。**PATH 分层**：profile `plugin add/install` 只在 runtime tools 之后继承进程 PATH；仅长驻 `dsh web` sidecar 再于 runtime tools 之后、继承 PATH 之前补入实际存在的 Homebrew、`~/.local/bin`、pnpm/npm/cargo 等常见 host CLI 目录，让 Finder/Dock 启动也能解析插件调用的宿主 CLI，同时 release runtime 的自带 pnpm 始终排在用户 shim 之前；源码 dev fallback 仍按开发者继承 PATH 解析 pnpm。one-node 的 `node` 是 `~/.dsh-desktop/node-shim/<electronPath sha12>/node`（`ELECTRON_RUN_AS_NODE=1` exec 当前壳二进制）——按二进制分目录，禁止测试或 desktop:dev 把打包壳的共享脚本改写成 `/Applications/Electron.app` 这种死路径；目标二进制不存在则拒绝落盘。host CLI（`yzj-cli` 等 `#!/usr/bin/env node`）走同一份 shim，死路径会直接变成「云之家未登录」。**runtime 解析顺序见「运行时分发决策·壳的 sidecar 解析顺序」**（`$DSH_DESKTOP_RUNTIME` → `runtime/revision.json` 钉的 `runtime/build/<sha>`（repo 存在该树时优先＝dev 主路径）→ 钉 sha 缺失且 `runtime/build/` 恰好一棵完整组装树则用那棵并 warn（多棵不猜，防错树）→ 资源解压树（仅 release；`release_runtime_dir` 带 `debug_assertions` 守卫，dev 构建永不消费——`~/.dsh-desktop` 解压树可能属于另一安装的旧 revision，2026-08-20 黑屏第二案根因，详见 `docs/notes/2026-08-20-rc45-runtime-resolution-and-plugin-contracts.md`）→ 源码 checkout 兜底）；源码兜底的 checkout 发现：`$DSH_CHECKOUT` → 本仓同级 `../deepseek-harness` → `~/workspace/deepseek-harness` 惯例位（校验 `docs/architecture.md` + `apps/cli/src/bin.ts`），与 `scripts/setup-plugins.mjs`/各包 `scripts/setup.mjs` 的候选序一致。
- **DSH_HOME 所有权**：默认共享真实用户 home 下的 `.dsh`（Unix `$HOME/.dsh`，Windows `%USERPROFILE%\.dsh`）——桌面与终端是同一账号的两个面（会话历史、工作区、settings、credentials 全部同源可见）。`$DSH_HOME` env 可强制隔离。`~/.dsh-desktop/` 只放壳私有编排数据：`logs/install.log`、`profile-adoptions/<home-hash>/` 经短期跨进程 append lock 串行化的追加式接管状态（损坏记录隔离保留、同 revision 歧义降为 `ConsentRequired`，不得永久阻断启动）、`profile-backups/<home-hash>/<backup-id>/` 可恢复 Web Profile 快照、`active-profiles/<home-hash>.json` 当前活动运行面（按 DSH_HOME 键控；运行面切换见「功能面」M2 条）；**sidecar 的 harness 输出走 fork 的 `web:log` 约定**：每次启动一个 `$DSH_HOME/logs/desktop-<yyyymmdd-HHMMSS>.log` + `desktop-latest.log` 软链（与终端 `web-*` 同目录、前缀区分，`DSH_WEB_LOG_DIR` 可覆盖目录；软链 unix-only，Windows 尽力而为、失败则只有 per-boot 文件）。⚠️ 并发注意：harness 对同一 DSH_HOME 没有多进程锁；单用户下基本安全（会话是 per-session JSONL，JSON storages 是整文件 last-wins 原子写），但同一会话同时被两个面驱动是未定义行为；协调式单实例是壳 M2 项。**首次接管现有共享 Home 的授权边界**：恢复完壳自己遗留的 Profile 事务后、任何新 mutation 前检查接管状态；既有 Home 必须原生提示 `备份并继续 / 查看变更 / 退出`，说明只更新共享 Web Profile，并保留 sessions、credentials、settings、`.agent-presets`、home patch、其他 profiles 与其他插件；空 Home 不提示但先落 `Adopting` 记录并以 `ProfileExpectation::Missing` 双重检查，防下一次把 Desktop 自建数据误认作用户既有数据，也防检查后终端新建 Profile 的 TOCTOU；发现该竞态则转 `ConsentRequired`、退出并在下一次重新提示。确认后把当前 `profiles/web` 配置（排除可重建 `node_modules`）持久备份到壳私有目录，复制前后校验源身份，安装事务再以该身份做 CAS；已运行过旧版 Desktop 的用户只能诚实备份“当前 Web Profile”，不宣称是历史 pre-Desktop 状态。每次启动把 bridge、compaction 与 web-search-toggle 作为**同一个 Profile 事务**幂等安装（三者目标 realpath 均一致时跳过）：壳在真实 `DSH_HOME` 同级创建等深、同卷的 shadow home，复制 web Profile 的全部配置但不复制 `node_modules`，并把 home 根 `cordis.patch.yml` 只读复制到 shadow 供完整配置校验；在 shadow 中执行旧闭包 frozen install → 三包 `plugin add` → 新闭包 frozen install → 原依赖 realpath/受保护配置/`--dump-config` 校验；全部成功后才以 immutable journal + append-only phase records + rename 提交整棵 `profiles/web`。失败时真实 Profile 不动；提交中断由下一次启动按 durable phase 与 profile marker 确定回滚或收尾；另一个桌面进程持有 journal 或提交前及 `real -> backup` 后检测到真实 Profile 配置、home patch 或 `node_modules` 顶层身份被终端改动时回滚并 fail loud；backup 删除前再复核一次。安装失败必须在 sidecar 启动前原生展示 `重试 / 恢复已保存备份 / 退出`（无备份则没有恢复项），所有 native dialog backend 失败都按退出处理，consent/破坏性动作的默认焦点也是退出；`DSH_DESKTOP_DIALOG_DEFAULT` 自动选择仅在 debug build 或 `DSH_DESKTOP_E2E_PROBE=1` 生效；恢复先追加 `RestorePending` 并绑定当前 Profile 身份，再把快照复制到 shadow、frozen install、完整校验后走同一 journal 提交，因崩溃重启时只收尾已匹配的快照或按 CAS 重试，绝不覆盖恢复请求之后的终端修改（当前 Profile 已删除时允许以 `Missing` CAS 重建）；若终端已产生新内容或恢复持续失败，用户可显式“保留当前 Profile”转 `RestoreAbandoned`，下次重新授权，不能形成永久重试死循环。备份损坏/缺失必须原生 fail loud，可保留当前 Profile 并转 `ConsentRequired`，但不得静默使用或删除该备份；后续清理也保留校验不通过的旧目录。成功转 `Restored`、提示后退出，下次启动重新征求授权。所有其他致命启动错误也必须原生可见，不能只写 stderr。bridge 与 web-search-toggle 的 bundle 层进入 web Profile；compaction 的空 bundle 层只登记可解析包。Windows 原生进程读 `%USERPROFILE%`，不用 Git Bash 的 `$HOME=/c/Users/...`（那不是 Win32 路径）。
- **端口**：`net.createServer().listen(0, '127.0.0.1')` 取随机口，就绪探测 `GET /`（webserver 的 SPA index 路由）状态 2xx（500ms 间隔，120s 超时；tsx 冷启动慢）。
- **窗口**：就绪后建 `BrowserWindow`（1400×900）加载 `http://127.0.0.1:<port>`；preload 注入冻结的 `window.__DSH_DESKTOP__`（platform = macos/windows/linux）与 `window.__DSH_DESKTOP_IPC__.{invoke,on}`。macOS 用 `titleBarStyle: 'hiddenInset'` + `trafficLightPosition: { x: 16, y: 10 }`（圈中线约 y19 对齐带内开关 `top:8/22`，红灯左缘 x16 对齐侧栏字标线）。桥拖拽条写 `-webkit-app-region: drag`（可与归档的 `data-tauri-drag-region` 双写）。其他平台保留原生标题栏。**后台保留（macOS）**：红灯/关窗 `preventDefault` + `hide()`，webview 与 sidecar 不停（通知中心与系统横幅仍活）；`window-all-closed` 不 quit。Dock 点击 / `activate` 调 `revealMainWindow`（show 已有窗，或按上次 URL 重建）。真正退出只走 Cmd+Q / `before-quit`：`setAppQuitting` 后才允许 destroy，再 `killSidecar()`。**更新退出序列（2026-08-31 重启失败案根因）**：electron-updater 的 `quitAndInstall` 文档明确「先关所有窗口、之后才发 `before-quit`」——若只有 `before-quit` 置 `setAppQuitting`，keep-alive 的 close veto 会把更新序列的关窗全部拦成 hide，进程永不终止，ShipIt 一直等不到退出（实测闲置 78 分钟直到用户手动退出）。`main.ts` 必须监听**原生** `autoUpdater` 的 `before-quit-for-update`（关窗之前发出）提前置 `setAppQuitting(true)`。Windows/Linux 无托盘，关窗仍杀 sidecar 并退出（托盘是 M2 项）。纯函数 `shouldRetainBackground`（`src/keep-alive.ts`）。**unpackaged 不解压插件 tarball**（`extractPlugin` 打包态才跑）：dev 走仓内 `plugin/<name>`，避免 `~/.dsh-desktop/bridge` 旧 revision 盖住工作区。
- **IPC 能力**：preload `contextIsolation` + `ipcMain.handle` 注册本表九条命令（外加 e2e `dsh_desktop_e2e_report`）；不经 Tauri capability。
- **命令后端**：open_external 走 `shell.openExternal`，先做 scheme 白名单（http/https/mailto/tel）；notify 走 Electron `Notification`（Windows `app.setAppUserModelId('dev.dsh.desktop')`），点击聚焦主窗口并 `webContents.send('dsh-desktop-notify-click', { sessionId })`。
- **sidecar 监护**：Unix 上 sidecar `detached` 进独立进程组，终止信号打 `-pgid`——一次内核调用原子覆盖 sidecar 全树；Windows 走 `taskkill /T` 树杀。退出统一走 **SIGTERM→3s→SIGKILL 阶梯，且等整棵 pid 树清空才返回**（插件拉起的孙进程可能比根晚死几秒并占着固定端口，运行面切换的下一个 spawn 要重绑）；`waitReady` 读到子进程已退出（exitCode/signalCode）即快速失败，不再耗尽 120s 探测预算。防孤儿第二道保险——**stale-sidecar 注册表** `~/.dsh-desktop/sidecars.json`：spawn 时记录 `{sidecar/shell pid + 启动时刻, port, log}`，每次启动先清扫再 spawn。清扫**只作用于注册表内 pid**（绝不按进程名扫表，终端 `dsh web` 不可能被误伤）；pid 复用由启动时刻等值比较挡住。
- **e2e 探针**：`DSH_DESKTOP_E2E_PROBE=1` 时壳在页面加载后注入探针 JS（gate→app-root→badge DOM→save_file IPC 往返），verdict 经 IPC 命令 `dsh_desktop_e2e_report`；配 `DSH_DESKTOP_E2E_EXIT=1` 自动退出：0 通过 / 2 失败 / 3 超时。另设 `DSH_DESKTOP_E2E_SURFACE=<profile 目录>` 时探针改走运行面切换：bridge 右键命令直跑（跳过原生菜单与目录选择器，确认仍走 `DSH_DESKTOP_DIALOG_DEFAULT`），切到新 sidecar 就绪后壳自报 verdict。

### 功能面

M1（已实现）：

1. **外链路由** —— document 捕获阶段 click 监听：`target=_blank` 的锚点、跨源 http(s) 锚点、`mailto:`/`tel:` → `preventDefault` + `dsh_desktop_open_external`。同源无 target 的锚点、`#`、`javascript:`、`blob:`/`data:` 一律放行（SPA 内部导航）。判定是纯函数 `classifyAnchor`（`src/client/links.ts`），单测覆盖。
2. **消息通知** —— 桥内 `src/client/notifications.ts`：订阅 `ctx.sessions.list`，`diffAttention` 出边（只认**两侧都在的**会话：`running: true→false` 或 `pendingInteraction: 无→有`；两种边同时只发「等待输入」）。首样、空 before、以及列表灌入的新 idle 行一律不出边——否则每次启动/切工作区会把历史会话刷进通知中心。行首次进入列表后 `TURN_DONE_BIRTH_GRACE_MS`（1.5s）内的 `running true→false` 视为新建/打开时的 agent 附着脉冲，也不出 turn-done（真实首回合几乎总更长；`await-input` 不受宽限）。窗口隐藏、失焦、或边属于非当前会话时发 `dsh_desktop_notify`（带 `sessionId`）；当前会话且窗口聚焦不发。每条边都进进程内通知中心（`notify-inbox.ts`，最多 30 条，不落盘）：macOS 标题带铃铛、其他平台右上角；点开列表，点一条 `sessions.open(id)`。标题用 `displayTitle`，正文走 `desktop-bridge` 文案。点击系统横幅同样回跳。
3. **web 端指示** —— `shell.overlay`（加性 list 槽，全帧浮层）注册 `desktop-badge` 条目：右下角小 pill「web端」，点击以 `dsh_desktop_open_external` 打开当前 origin（复制会话到系统浏览器）。样式只用 `--dsw-*` 语义 token，绝不写字面色。
4. **标题带更新入口** —— 仅经 `shell.overlay` 插件实现：挂载 3s 后首查，之后每 2h 强制刷新；离线、无端点或已是最新版时完全静默。macOS 发现新版后在左上角标题带的侧栏开关旁出现 22px 下载小按钮（收起态的 `+` 新会话气泡仍在其右侧）；其他平台保留右上角 fallback。**点击按钮才弹下载窗并开始下载**（不再发现即后台自动下载）：headless Modal 内为图标块 + 「正在下载 v{version}」标题 + 进度条（`dsh_desktop_update_status` 120ms 轮询的字节进度，`total` 未知时退化为不定态滑动动画）+ 「取消下载」（经 `dsh_desktop_cancel_update` 回到 `available` 可重下；归档壳无此命令则软失败、下载继续）；遮罩/Escape 只收起窗、下载继续、按钮原位旋转、再点即重开；下载失败窗内给「关闭 / 重试」（重试先强制 recheck 再下载）。签名校验完成进入 `ready`：窗内切换为「稍后 / 重启以更新」并展示本版更新说明（`electron-updater` 的 release notes 为事实源），用户中途收起过窗也会在 ready 瞬间自动重开；只有确认「重启以更新」才消费暂存包、安装和重启。检查、下载、安装各自单飞，下载需用户点击、安装需用户确认。**mac 的 `ready` 前置包含 slim 运行时预置**（语义见 `dsh_desktop_download_update` 行），使重启后的首启命中本地 tar 直接解压、不再阻塞在隐形大文件下载上；弹窗图标块恒为静态 app logo（`src/client/update-logo.tsx`，从 `src/icons/icon-src.svg` 内联），忙碌旋转只留在 22px 带内按钮上。0.2.x Tauri 用户不能经旧 `latest.json` 升到 0.3.x，须从 GitHub Releases 下载。

M2（下载桥与 i18n 已实现；其余规划，先改本表再动手）：

- ~~下载桥~~（已实现）：捕获 `a[download]` 点击（同源 http(s) 与 `blob:`，纯函数 `classifyDownload` 判定）→ fetch blob → base64 → `dsh_desktop_save_file`；invoke 失败回退 `location.href` 导航下载。
- ~~badge 文案接 `ctx.locale` 双语~~（已实现，namespace `desktop-bridge`）。
- ~~标题栏融合（macOS）~~（已实现）：壳建窗用 `hiddenInset` + `trafficLightPosition`（见「壳实现要点·窗口」）；桥插件在 `platform === 'macos'` 时（纯函数 `shouldFuseTitlebar`，`src/client/titlebar.ts`）注入一条 CSS——首条 `html,body{overflow:hidden;}` 把文档根锁成不可滚，随后 `div:has(> [data-shell-overlay])>div:nth-child(-n+3)` 各加 28px `padding-top`——并注册第二个 `shell.overlay` 条目 `desktop-drag-strip`（`-webkit-app-region: drag`，可与归档的 `data-tauri-drag-region` 双写）。视觉结果：侧栏 surface 从窗口顶边铺开，红绿灯直接压在侧栏色块上。
- ~~收起侧栏整列隐藏 + 标题带控制钮（macOS）~~（已实现）：Overlay 标题栏下，ui-layout 的「收起」仍是 56px 控制轨（`SIDEBAR_COLLAPSED`，rail 里有 logo/新建会话/设置图标）——这条 rail 垫在红绿灯正下方成为无交互死条。桥插件在 `platform === 'macos'` 时（与标题栏融合同一门控）把收起列压到 0 宽，并隐藏侧栏 logo 行里的原生 toggle（**BrandWordmark 保留显示**，锚点 `div[data-slot='sidebar']>div>div:first-child>button:last-child`——`data-slot` 是 slot 系统文档化的稳定锚点，Tooltip 无包裹 DOM，logoRow 的最后一个按钮即原生 toggle）：桌面全窗口**只保留一个侧栏开关**——红绿灯右侧、28px 标题带内的常驻双向 toggle，收起时其旁滑入仅收起态可见的新会话气泡（`src/client/rail.ts` + `rail-controls.tsx`）。机制：列宽在 frame 的 inline `grid-template-columns`（`<sidebar>px minmax(0,1fr) <details>px`），纯 CSS `!important` 覆盖整条模板会丢 details 动态宽度，故用 MutationObserver 在 `data-sidebar-collapsed` 期间把第一轨改写为 `0px`（纯函数 `collapseRailTemplate`，只认「`<num>px` 开头且后随轨道」的模板形状，失配原样放行、功能退化为原生 rail；React 重渲染重写 style 后 observer 同 microtask 再纠正，无闪烁；frame 自带 grid 轨道 transition，收起 56→0 / 展开 0→280 均为平滑动画；React 不回读 DOM style 做 diff，外部改写稳定）；按钮是第三个 `shell.overlay` 条目 `desktop-rail-controls`（order 5，`top:8px;left:86px;height:22px;gap:8px` 红绿灯右侧、与下移后的灯排同线（中线均为 y≈19；与绿灯圈右缘留约 12px），z-index 1 压过拖拽条——占约 26px 带内区域不再可拖窗，与原生工具栏按钮同理）：toggle **常驻**、双向（收起/展开同钮同图标，无入场动画）；发现更新后紧接出现下载小按钮，点击弹出下载窗（进度条 + 字节进度 + 取消下载；遮罩/Escape 仅收起、下载继续，ready 时自动重开为「稍后 / 重启以更新」确认，契约见 M1 第 4 条）；新会话气泡**仅收起态**，用 `opacity/transform/visibility` 过渡（`display` 无法动画）在其旁从 `translateX(12px)` 滑入（delay .18s 接在侧栏滑动后），展开时反向淡出，`prefers-reduced-motion` 去过渡；容器恒 `pointer-events:none`，toggle 恒可点、气泡仅可见时可点：toggle 调 `ctx.layout.toggleSidebar()`——**点击时惰性 `ctx.get('layout')`**，绝不在注册时读取：slots.inject 在 ui-layout 声明落地（其 fiber 启动途中、尚未 ACTIVE）即触发，而 strict `ctx.get` 只服务 ACTIVE 提供方，注册时读取会拿到 undefined 导致按钮永不出现（2026-08-19 实踩，缺席仅 warn 并忽略点击）；新会话调 `ctx.workspaces.startSession()`（无参 = 侧栏按钮同款语义；inject 加 `workspaces`）；图标用 ui-primitives 的 `IconPanelLeftOutline16` / `IconNewChatOutline16`（与 rail 原图标一致），样式全在 `railCss()`、只用 `--dsw-*` token。已知边界：DOM 锚点依赖 ui-layout 的 `data-sidebar-collapsed` 属性与 inline 三轨模板（ui-layout 结构变更需同步 rail.ts，与 `nth-child` 锚点同性质）；收起态下 rail 的 workspace 浏览/设置入口不可达（新会话由带内按钮补齐，其余需展开后用）。
- ~~通知点击回跳~~（已实现）：Electron `Notification` 点击聚焦主窗口并 `sessions.open(id)`（应用身份 `dev.dsh.desktop`）。归档 Tauri 无 `on` 通道，只发横幅不回跳。
- ~~运行面切换~~（已实现，2026-08-28）：右键点击侧栏品牌区（whale 图标或 Oh My DSH 字标，锚点是 `[data-slot="sidebar.brand.mark"]`/`[data-slot="sidebar.brand.name"]` 槽包装，收起/展开两态都在）→ 桥捕获 `contextmenu`（`src/client/surface-menu.ts`，与外链/下载同一 document 捕获模式）→ `dsh_desktop_switch_surface` IPC（**不带渲染端入参**，目录只能由壳侧选择器给出）→ 壳弹原生菜单「切换运行面…」→ 目录选择器（默认 `$DSH_HOME/profiles`，选别处以「必须是 profiles 直接子目录」拒绝，软链接入的外部目录合法）→ `validateSurfaceDir`（存在且是目录、bundles 含 `@deepseek-ai/dsh-web-app`、可读写；缺 web bundle 提示先终端补层）→ 原生确认框（说明：回合中断、窗口自动重载、会话/设置/凭据保留；首切提示将装七包）→ `runDesktopPluginInstall` 对该 profile 跑同一 shadow-CAS 事务（`install.ts`/`profile-repair.ts` 已从写死 `web` 泛化为 profile 参数；`profile-repair` 的 journal 仍是 home 级单飞，恢复时从事故 journal 的 `realProfile` 推回目标 profile，无 journal 时扫描所有 profile 的 marker）→ kill → `--profile <name>` respawn → waitReady → `loadURL`。**活动运行面按 home 持久化在 `~/.dsh-desktop/active-profiles/<home-hash>.json`（scratch home 的 e2e 不污染真实 home 的下次启动），只在新 sidecar 就绪后落盘**；未就绪自动 respawn 旧运行面回滚并原生报错。boot 时活动运行面失效（被终端删/改坏）→ 原生提示并回退 web。七包进每个被切到的运行面，保证切换后 bridge 仍在、能切回来。决策见 `docs/notes/2026-08-28-runtime-surface-switch.md`。
- 托盘 / 未读角标（壳读 DOM title 或插件显式上报）。

### 组合与 slot 纪律（沿用 DSH client 约定的最小子集）

- UI 只经 `ctx.slots.register(...)` 组合；本插件只注册已声明的加性槽 `shell.overlay`（badge/拖拽条/带内 rail 控件，更新入口嵌在 rail 控件内），声明洞一律禁止。品牌字标等"始终挂载"关注点不归桥（见 roster 的 `dsh-branding`）。
- 跨包只走 slot 与 ctx 服务，禁止 import 其他插件的实现符号；harness 包只做 type-only import（构建时擦除）。
- 注册即 effect：所有监听、订阅、slot 注册经 `ctx.effect()` / register 返回的 disposer，卸载/HMR 全量回收。
- 文案中文（M2 起接 `ctx.locale` 双语）；代码注释英文。
- 无硬编码 tunable：可调项（如通知开关）是 `Config` 字段，从 cordis.yml `config` 进来，非法值 fail loud。

## 壳（Electron）契约要点

壳对插件只有两个义务：preload 注入 `window.__DSH_DESKTOP__` 与 `window.__DSH_DESKTOP_IPC__.invoke`（见上），实现 IPC 命令表（见上）。其余职责不变：spawn harness sidecar（`dsh web`，随机回环端口）、`GET /` 就绪检测（host.describe 是 RPC 方法名，不是 HTTP 路由）、窗口加载 `http://127.0.0.1:<port>`。生产形态把本插件经 `dsh plugin --profile web add` 装进随包 profile（自带 `dsh.bundle` 层，无需 `--patch`）。归档 Tauri 壳仍可用 `__TAURI_INTERNALS__.invoke` 作为兼容载体。

## Commands

前置：Node 22+、pnpm；类型检查与构建另需 DSH 源码 checkout（发现顺序：`$DSH_CHECKOUT` → 本仓同级 `../deepseek-harness` → `~/workspace/deepseek-harness` 惯例位，验证标准 `$DSH/docs/architecture.md` 存在）。

```sh
pnpm run plugin:setup     # 根级：建 plugin/deepseek-harness 锚（link:source 与 mcp-settings 用）+ 桥自己的 dsh 锚
pnpm run plugin:new -- <dsh-name> [--face host|client|dual] [--id <rowId>] [--preset-owned]
                          # 新插件脚手架：plugin/<name>/ 下生成 package.json/cordis.patch.yml（或
                          # preset-snippet.yml）/tsconfig/tsdown/源码骨架/node:test，并把 lib/ 追加进
                          # 根 .gitignore；devDeps 钉读自蓝本包。用法详见「插件 monorepo 规范·落点」
pnpm run plugins:check    # 全树：plugin/* 每包跑自己的 typecheck/test/build（--if-present，跳过 symlink 锚）
pnpm run link:source      # 调试：受管插件 devDeps 切 link: 源码（见「npm 依赖纪律」；不可提交）
pnpm run unlink:source    # 恢复 registry 版本（提交态）

cd plugin/dsh-desktop-bridge
pnpm install          # 安装 devDeps（tsdown/typescript/tsx/react 类型）
pnpm run typecheck    # tsc --noEmit（harness 包 import 经 dsh 链接解析到源码）
pnpm run build        # tsdown：lib/index.js + lib/invariant.js + lib/client.js
pnpm run test         # node --import tsx --test（纯函数单测）
pnpm run watch        # tsdown --watch（配合 dsh web 的 client-hmr 热替换）
```

mcp-settings 在包内自带 pnpm 11（packageManager）与 vitest 工具链，`cd plugin/dsh-mcp-settings && pnpm install && pnpm test` 独立可用；provider-balance 无构建步骤（裸源码分发，收敛进 tsdown 纯度门是后续项）。

### 实机挂载验证（scratch home，勿污染真实 `~/.dsh`）

```sh
export DSH_HOME=$(mktemp -d)
cd $DSH_CHECKOUT
pnpm dsh plugin --profile web add <repo>/plugin/dsh-desktop-bridge
pnpm dsh web --port 3987 &
curl -s localhost:3987/ | grep -o 'dsh-desktop-bridge[^\"]*'   # boot graph 应含本插件行
curl -sI localhost:3987/plugins/dsh-desktop-bridge/client.js   # 应 200
```

### 壳的运行与端到端验证（M1 起）

```sh
# 前置：Node 22+、pnpm 与 DSH checkout（发现顺序见「壳实现要点」）
pnpm desktop:dev                # Electron 壳：spawn sidecar → 就绪 → 开窗
# e2e（探针走 gate→badge DOM→save_file IPC 往返，结论打在 stdout；EXIT 变体自动退出）
DSH_DESKTOP_E2E_PROBE=1 pnpm desktop:dev
DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 pnpm desktop:dev; echo "exit=$?"
```

壳的 sidecar 默认跑在真实 `~/.dsh`（与终端同源）；harness 输出落 `~/.dsh/logs/desktop-<时间戳>.log`（`desktop-latest.log` 软链指最新，`DSH_WEB_LOG_DIR` 可覆盖），`~/.dsh-desktop/logs/` 只落 `install.log`。浏览器内验证桌面行为以 `window.__DSH_DESKTOP__` 手工注入为辅助手段。

## Conventions

- ESM（`"type": "module"`）；插件包名无 scope，目录名 === `package.json` `name`，随仓分发（见「插件 monorepo 规范」）。
- client bundle 构建契约（banner/footer/externals）从 DSH `packages/client/tsdown.client.ts` 蒸馏：产物是 `window.__ModuleLoader__.load({id, factory})` 闭包；externals = 平台模块表**rc.8 起的隐式基线**（react/cordis/ui-slots/ui-primitives + runtime 豁免——rc.8 把 `web-react`/`ui-attachment`/`schema-form` 移出 PLATFORM_MODULES 改为普通内联库，并新增按包 `dsh.client.external` 声明机制；桥的镜像表见 `plugin/dsh-desktop-bridge/tsdown.config.ts` 注释）；非基线 `@deepseek-ai/*` 值 import 一律构建报错（纯度门）。基线 bump 时该镜像表必须跟着 `PLATFORM_MODULES` 核对。
- 纯函数与副作用安装分离：判定/diff 逻辑无 DOM 依赖可单测；安装函数薄壳包 effect。
- 空不发声、缺即报错：可选服务 `ctx.get()` 处理 undefined；配置缺引用在能定位的最早点 throw。
- 组件不做订阅机械（useSyncExternalStore 等）；快照流消费在 apply 世界订阅、经闭包注入。
- 文件恰好一个行尾换行；`git diff --check` 干净。
- 非平凡变更加 Agent Note（`docs/notes/`，日期命名）记录决策与理由。

## Milestones

仓库整体（README 详述）：M1 Tauri 原型（脚手架 + sidecar + 端口 + 就绪 + 窗口）→ M2 对齐 dataelement 行为 → M3 平台化（签名/更新/安装包）→ M4 系统 WebView 回归。

### 运行时分发决策（已定，M3 实现）

**runtime 整树不发 npm**（它是自包含安装产物：CLI 树 + node/pnpm 二进制）。fork 的 GitHub 仓库仍是源码事实源，但**对 fork 修改面的消费走 npm**（fork FORK.md「发布纪律」：修改包以自有 scope 发 `<上游版本>.zw.<N>`）：`prepare-runtime.mjs` 对 FORK_MODIFIED 集合的 overrides 指向 `npm:@crazx/<pkg>@<版本>.zw.<N>`（npm 上不存在时 fail loud，先在 fork 仓发 zw 版再组装），其余包仍从 fork clone 打 tarball 钉本地。发包以 **`v<基线>+zw.<补丁>` 标签**为锚（semver build metadata 标识 zw fork；历史 `desktop/vX.Y.Z` 标签等价有效）：`runtime/revision.json` 钉 `{repo, ref: v<基线>+zw.<n>, sha}`，fork 侧 `git tag v<基线>+zw.<n> <sha> && git push origin <tag>` 后更新本文件。当前：`v0.1.2-alpha.5+zw.1`（harness 基线 0.1.2-alpha.5；zw 层 1＝基线升 alpha.5——合入官方 alpha.4 的 Session 按需读取 API / `send_message` / 默认 `web_fetch`，以及 alpha.5 的 projection-cache 跨版本读兼容；fork 既有 +zw 补丁保留，仍发 11 个修改包。上一层 `v0.1.2-alpha.3+zw.2`＝`dsh-client-modules` 认出 `@crazx` 换 scope；再上一层 `v0.1.1-rc.2+zw.1`＝基线升 rc.2——图片管线 Files API 上传/归一化、权限默认值 revert，仍发 11 个修改包。上一层 `v0.1.1-rc.1+zw.2`＝`dsh-compaction-basic` 加入发布集，stock Provider 获得自动有界层次 fallback，共发 11 个修改包；再上一层 `v0.1.1-rc.1+zw.1`＝基线升 rc.1，仍发 10 包；再上一层 `v0.1.0-rc.8+zw.4`＝publish-fork 修复 vendor 线 workspace 依赖改写——`@crazx/*` 曾把 schemastery/cordis-plugin-* 等钉到 fork 基线版本，peer 边绕过 overrides 直查 registry 即 404，zw.2/zw.3 均带毒、zw.2 仅因本地 tarball 恰好全覆盖而侥幸出货，zw.4 按目标包真实版本线改写并顶替 zw.3；层 3＝基线升 rc.8 + `dsh-tool-cordis` 补进 FORK_MODIFIED + publish 基线断言改 `--base`；层 2＝frontend-static content-length）。FORK_MODIFIED 消费面以 fork 仓 `node scripts/publish-fork.mjs --list` 为准（基线 bump 后跑一次核对），本文件只记当前快照。

组装（`node scripts/prepare-runtime.mjs`，SHA 键控缓存，同 SHA 秒级）：持久部分克隆 fetch 标签 → `pnpm install --frozen-lockfile` + `pnpm run build`（`.prepare-runtime-ok` 标记缓存）→ **publish 路径打本地 tarball**（`pnpm pack` 全部 234 个 `@deepseek-ai/*` 包，workspace: 协议按发布规则重写；平台特定原生包 landlock-linux 跳过回退 npm；`FORK_MODIFIED` 名单内的包打包失败即中止）→ 生成的 runtime manifest 以 `pnpm.overrides` 把全树钉到本地 tarball（**必须 `--no-frozen-lockfile`，frozen 模式会静默忽略 overrides**；`pnpm deploy --legacy` 对本 workspace 丢 vendored 传递依赖，不可用）→ `runtime/build/<sha>/{dsh,tools}`（dsh = CLI 树，tools = node 24.9.0 + pnpm 二进制）。

壳的 sidecar 解析顺序：`$DSH_DESKTOP_RUNTIME` → **`runtime/revision.json` 钉的 `runtime/build/<sha>`**（repo 存在该树时优先——dev 主路径；`findRuntime` 把它排在资源解压树之前，防 `~/.dsh-desktop` 里属于另一安装的旧 revision 劫持 dev）→ **钉 sha 缺失且 `runtime/build/` 恰好一棵完整组装树**（用那棵并 warn；多棵不猜）→ **包内资源解压树**（仅 release。`~/.dsh-desktop/runtime/<sha>` 的 `.ok` 与 `runtimeTarball` 哈希一致则复用，不要求 `.app` 里仍有 `runtime.tar.gz`。OTA zip 在 sha 未变时剥掉该 tar：缺 tar 且缓存未命中则按 `runtime-<sha>-<platform>-<arch>.tar.gz` 从该次 desktop Release 补拉并校 sha256。dev 构建不消费 resources 解压树。`~/.dsh-desktop/runtime/<sha>/{dsh,tools}` 仍由 bundled/downloaded tar 原子解压，`.ok` 标记完整；bridge、层次压缩与 Web Search 开关分别按 manifest 中自己的 tarball hash 解压到 `~/.dsh-desktop/{bridge,plugins/dsh-compaction-hierarchical,plugins/dsh-web-search-toggle}`。解压包不带 `node_modules`：壳在 `plugin add` 后把 bridge 的 Cordis、compaction 的六个 Harness peers 以及 web-search-toggle 的 Host/Client Harness peers 链到 runtime 树的同一 physical package，避免缺依赖与模块身份分裂；链接指向旧 runtime revision 或悬空时自愈重指，dev package 的真实依赖目录不动。`.ok` 按各 tarball 的 sha256 内容寻址；runtime tar 缓存键另含 assembly script revision 与签名 posture，因此同 runtime git sha 的受管重组装也会传播。若手工修改缓存树却不更新这些键，必须删 `src/resources/runtime.tar.gz{,.sha}` 后重跑 prepare）→ 本地 fork 源码（dev 兜底，tsx；Electron 进程内走一份 Node）。e2e 已对 bundled runtime 与资源解压分支（强制 miss dev 路径）验证 `DSH_E2E_OK`。

**FORK_MODIFIED 的 npm 消费细节**：fork 集合不仅走 `pnpm.overrides` 的 `npm:` 别名，还作为 runtime manifest 的**直接依赖**声明——pnpm 的别名 override 只约束普通依赖边，**hoist 兜底（`.pnpm/node_modules`）与 peer 解析不受别名约束**，上游新版本（如 rc.8 匹配 `^0.1.0-rc.7`）会从这些路径漏进官方无修复副本（2026-08-20 黑屏第三案根因）；直接依赖必然解析别名，hoist/peer 随之绑定 crazx 副本。组装后有 fail-loud 扫描：树里残留任何 fork 包的官方 registry 副本即中止。**overrides 必须写在 pnpm-workspace.yaml，不得写在 package.json `pnpm` 字段（2026-08-20 zw.4 发布案，`docs/notes/2026-08-20-pnpm11-overrides-ignored.md`）**：pnpm 11 删除了 package.json `pnpm.overrides` 支持且**静默忽略**——本地 pnpm 升 11 后的组装里 overrides 整表失效，186 个包全走官方构建而版本号相等、扫描按版本放行完全失明；同版本双模块实例分裂 unique-symbol 注册表（bash 工具 `undefined (reading 'prepare')`、typert 远端路由 404 即其切面）。配套：runtime package.json 钉 `packageManager`（组装不随 shell pnpm 漂移）；全部打包 tarball 进直接依赖（file:/alias overrides 都够不着 peer 边，直接依赖给 peer 解析供 root 级实例）；`autoInstallPeers: false`（堵「未决 peer 按 range 从 registry 自动装」旁路）；allowBuilds 对 buildable tarball 直依赖按 `name@file:` 全限定键显式表态；扫描第三桶——同包 `file+` 实例与 registry 实例并存即中止（**按实例来源分桶，不按版本号**；pack-skip 原生包 registry-only 单例合法）。

**基线锁定（上游线纪律）**：runtime 全树钉在 fork 追踪的**单一上游线**——`prepare-runtime.mjs` 把每个非 fork 的 `@deepseek-ai/*` 包 override 到 **fork 树自己 manifest 声明的版本**（vendored 框架线如 schemastery 3.x、原生包 landlock 0.1.1 各按其真实版本线，不套 dsh rc 节奏），skipped natives 同样钉死不浮。**上游发新版不自动跟进**：混两条上游线（rc.7 骨架 + rc.8 末梢）会让 `unique symbol` 注册表跨模块实例失效（`undefined (reading 'prepare')`、credentials 服务"未挂载"——2026-08-20 rc.5 混装案）且静默发生。上游线的移动只经一条路径：**fork 仓合并 upstream → 跑聚焦测试 → 发新 zw 层 → 本仓 bump revision 重组装**——给 fork 留适配兼容时间，官方包永远"协同上游依赖的版本"更新，绝不 `^range` 自由漂移。组装后的 fail-loud 扫描同时检查两件事：fork 包无官方副本、树内 `@deepseek-ai/*` 无偏离 fork manifest 版本的第二上游线。

**已知残留（插件自带 `@deepseek-ai/*` 模块副本，注册表按模块实例分裂）**：profile 里 link: 到本仓工作区的插件（mcp-settings 等）在装配 runtime 下报 "no credentials service mounted"——插件自带独立 cordis 模块副本（其 node_modules 的 registry cordis ≠ runtime 树 cordis，不同 store 路径），Service 注册表按模块实例隔离。源码 `dsh web` 无此问题恰因两者 cordis 同路径（link 到 checkout）。**web-search-toggle 的 `/api/webSearchToggle/*` 404 是同类第二案（2026-08-20，机理定案与修法见 `docs/notes/2026-08-20-pnpm11-overrides-ignored.md`「遗留」节）——已修（插件侧 0.1.1）**：`@Remote` markers 存 typert-protocol 模块级 WeakMap，插件自带 rc.7 副本与 runtime rc.8 实例互不可见（字符串键服务与 binding 跨实例可见，唯独方法枚举不可见，症状隐蔽；tsx 4.22 源码统一解析故源码上无此问题，tsx 4.23 纯 Node 上溯故命中插件副本）。**插件侧修法＝out-of-tree Remote 插件的通用姿势**：Host 行 apply 里把与浏览器端共享的 `TYPERT_REMOTE.descriptors` 经 `ctx.typert.register()` 注册成 Host strict contribution（见 `plugin/dsh-web-search-toggle/src/typert.host.ts`）——strict 路径不依赖 marker 发现，跨实例问题整个绕开；registry 的 `validateCodec` 是 duck check（只验 `schema.parse`），插件自带/内联 zod 副本合法；apply 必须返回 disposer（register 的内部 effect 绑在 registry 的 ctx 上，调用方负责随 fiber 卸载回收）；host bundle 内联 zod（git 安装无 devDeps）。插件 devDeps 升版**无效**（不同物理路径仍是不同实例）。fork 侧正解（未来 harness PR，非本插件所需）：`bindTypertRemote()` 让 binding 携带「从声明模块读取 markers」的闭包——binding 跨实例可见而 WeakMap 不可见；旧装饰器数据封死在旧模块里无法单边兼容，升级协议后插件同步重发。

### 打包（M3 已落地，手册：`docs/packaging-playbook.md`）

`pnpm desktop:build` 一键出平台安装包：macOS `.app` + `.dmg`（aarch64；签名+公证目标 **< 250MB**，含 Chromium）与 Windows NSIS `*-setup.exe`（x86_64，currentUser）。**runtime 必须在目标 OS 上组装**（native 模块布局），缓存键含 `platform-arch` 与 Electron ABI。资源走 **tarball** 而非散目录，解压到 `~/.dsh-desktop`。`desktop:prepare` 构建七包 → runtime 组装 → `.electron-abi` 已等于当前 Electron 则跳过 rebuild → 打 `src/resources/{runtime.tar.gz,runtime-revision.json,bridge.tar.gz,...}`（runtime tar **不含** `tools/node`）。electron-builder **Mac 只打 DMG**；`scripts/slim-mac-updater-zip.mjs` 从已签 `.app` 打瘦 zip（剥 `runtime.tar.gz`）、重签、写 `.blockmap` 与完整 `latest-mac.yml`（不得沿用 builder 可能指向 dmg 的 yml）。CI 可设 `DSH_DESKTOP_USE_CACHED_PLUGIN_LIBS=1` 在 lib cache 命中时跳过八包 build；GHA 另缓存已签名的 `src/resources/runtime.tar.gz`（key 带 `-signed`，无宽 restore-keys）。平台 job 把产物直传 **draft** Release；`desktop-publish` 只合成 notes/`latest.json` 再揭稿，不经 400MB artifact 往返。DMG / Windows NSIS 仍自带 tar（离线首装）。同一次 Release 另附 `runtime-<sha>-<platform>-<arch>.tar.gz`。分发：macOS Developer ID + 公证（公证扫描会钻进 tar.gz，Mach-O 打 tar 前逐个签名）；Windows Authenticode 有则签、空则跳过。**自动更新（0.3.0-rc.1 起）**：`electron-updater` + GitHub Releases `latest-mac.yml` / `latest.yml`。`autoUpdater.disableDifferentialDownload` 必须保持 `false`。Mac 差分缓存是 `~/Library/Caches/oh-my-dsh-updater/update.zip`（DMG 首装没有这份文件，第一次热更一定整包；清缓存会使下一次再整包）。检查走 `/releases/latest` 的 yml（带 sha512）；可选 `DSH_UPDATE_MIRROR` 只重写 `/releases/download/` 大文件，失败回落 GitHub。`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 与系统代理生效，不读 `~/.gitconfig`。已装 0.2.x（Tauri / `latest.json`）不能热更新过来，须手动下载。发布流水线 `.github/workflows/release.yml`（tag 触发），发布手册 `docs/release-runbook.md`。0.2.x Tauri 树已删除，不再进 release。

插件（本文件「功能面」的 M1/M2）；壳在 `src/`，开发只需 Node 22+ / pnpm。
