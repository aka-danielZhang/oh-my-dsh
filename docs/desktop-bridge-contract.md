# dsh-desktop-bridge 插件契约

> 本文从 AGENTS.md 迁出（2026-09-13 文档瘦身），是桥插件环境探测、IPC 命令表、日志汇行与功能面的权威文档。**加/改 IPC 命令 = 先改本文命令表，再改两侧。** 壳侧实现要点见 `docs/electron-shell-contract.md`。

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
| `dsh_desktop_download_update` | — | 单飞执行重新检查→逐 chunk 下载→签名校验；校验后的包仅暂存在当前壳进程内，完成后推进到 `ready`，不安装、不重启。被 `dsh_desktop_cancel_update` 取消时正常返回（不报错），状态回到 `available`。**切过是原子的**：`ready` / `install_update` 只在「本版 shell zip + 对应 runtime」都已落盘并校验后成立；缺 zip 路径、缺 `runtime-revision.json`、runtime 预置失败一律 `failed`，留在旧版可重试，绝不带着新壳旧 runtime 或缺失 runtime 重启。**mac 增补（2026-08-31 起，2026-09-09 改走 npm）**：`check_update` 一经 `available` 即按该版 `runtime-revision-<platform>-<arch>.json` **后台预拉** runtime（npm/pnpm 源优先，GitHub 回落），用户点下载时多半已是缓存命中，但仍要等预置完成才 `ready`。预拉/预置走 `@crazx/dsh-desktop-runtime-<triple>-<i>` npm 分片（`DSH_RUNTIME_REGISTRY` / 用户 `.npmrc` / npmmirror / npmjs）再回落 GitHub `runtime-<sha>-<platform>-<arch>.tar.gz`，校 sha256 并解压到 `runtime/<sha>/`；取消会 abort 进行中的 curl。Windows NSIS 自带 runtime tar，不预置。 |
| `dsh_desktop_cancel_update` | — | 取消进行中的下载（仅 `preparing`/`downloading` 相位生效，其余幂等 no-op）：壳取消该次 `checkForUpdates` 结果携带的 electron-updater `CancellationToken`，下载回卷后状态回到 `available`（保留 version 与 notes），可重新下载。归档 0.2.x Tauri 无此命令，插件 invoke 失败按「下载继续」软失败处理。 |
| `dsh_desktop_install_update` | — | 只接受 `ready` 状态。Electron：消费已校验包并安装，然后自动重启（成功即进程替换）。归档 Tauri 若判定下一版是 Electron（或 `latest.json` 已失效），改为打开 GitHub Releases 下载页，不安装。 |
| `dsh_desktop_switch_surface` | — | 运行面切换（2026-08-28 起，见「功能面」M2 运行面切换条）：**不带渲染端入参**——壳弹原生右键菜单（「切换运行面…」），菜单项触发壳侧全流程：目录选择器（默认开在 `$DSH_HOME/profiles`）→ 校验 → 确认 → 首次切换跑随包插件事务 → 重启 sidecar → 窗口重载。归档 Tauri 无此命令，插件 invoke 失败只记日志。 |

加命令 = 先改本表，再改两侧。

### 日志汇行（dsh-desktop-log-sink）

桥包随 bundle 层挂载第二个行 `dsh-desktop-log-sink`（`exports["./log-sink"]`，host-only），解决 harness web 组合里 `ctx.logger` 无出口的问题：内建 sink 只有 1000 条内存环形缓冲，console exporter 未挂载，logger 流量不进 stdout，壳的 `desktop-*.log` 与终端 `web-*.log` 都抓不到它。

- apply 注册一个 `ctx.logger` Exporter：每条消息一行 JSON（`{sn, ts, name, type, text[, backfill]}`；`text` 经 `Logger.format` 展开 printf 占位与 Error 栈，对象用 `util.inspect` 防循环引用），追加写入 `logger-<yyyymmdd-HHMMSS>.log`。级别 default=DEBUG（全量）。目录解析与 `web:log`/壳完全一致（`DSH_WEB_LOG_DIR` → `$DSH_HOME/logs`），`logger-latest.log` 软链指向最新（unix-only）。
- 挂载时先从环形缓冲 backfill 启动早期消息（记录标 `backfill: true`）；进程级状态（文件路径 + sn 水位）放 `globalThis`，HMR 重挂载按水位去重、同一文件续写不新建。
- 写盘失败为尽力而为：报一次 stderr（被壳 tee 捕获）后自闭，绝不把异常抛回日志调用方。
- 该行随桥 bundle 层生效，终端 `dsh web`（同一 web profile）也会启用——刻意如此：终端同样没有 logger 出口。文件与 `web-*`/`desktop-*` 同家族，不轮转，手动清理。

### 功能面

M1（已实现）：

1. **外链路由** —— document 捕获阶段 click 监听：`target=_blank` 的锚点、跨源 http(s) 锚点、`mailto:`/`tel:` → `preventDefault` + `dsh_desktop_open_external`。同源无 target 的锚点、`#`、`javascript:`、`blob:`/`data:` 一律放行（SPA 内部导航）。判定是纯函数 `classifyAnchor`（`src/client/links.ts`），单测覆盖。
2. **消息通知** —— 桥内 `src/client/notifications.ts`：订阅 `ctx.sessions.list`，`diffAttention` 出边（只认**两侧都在的**会话：`running: true→false` 或 `pendingInteraction: 无→有`；两种边同时只发「等待输入」）。首样、空 before、以及列表灌入的新 idle 行一律不出边——否则每次启动/切工作区会把历史会话刷进通知中心。行首次进入列表后 `TURN_DONE_BIRTH_GRACE_MS`（1.5s）内的 `running true→false` 视为新建/打开时的 agent 附着脉冲，也不出 turn-done（真实首回合几乎总更长；`await-input` 不受宽限）。窗口隐藏、失焦、或边属于非当前会话时发 `dsh_desktop_notify`（带 `sessionId`）；当前会话且窗口聚焦不发。每条边都进进程内通知中心（`notify-inbox.ts`，最多 30 条，不落盘）：macOS 标题带铃铛、其他平台右上角；点开列表，点一条 `sessions.open(id)`。标题用 `displayTitle`，正文走 `desktop-bridge` 文案。点击系统横幅同样回跳。
3. **web 端指示** —— `shell.overlay`（加性 list 槽，全帧浮层）注册 `desktop-badge` 条目：右下角小 pill「web端」，点击以 `dsh_desktop_open_external` 打开当前 origin（复制会话到系统浏览器）。样式只用 `--dsw-*` 语义 token，绝不写字面色。
4. **标题带更新入口** —— 仅经 `shell.overlay` 插件实现：挂载 3s 后首查，之后每 2h 强制刷新；离线、无端点或已是最新版时完全静默。macOS 发现新版后在左上角标题带的侧栏开关旁出现 22px 下载小按钮（收起态的 `+` 新会话气泡仍在其右侧）；其他平台保留右上角 fallback。**点击按钮才弹下载窗并开始下载**（不再发现即后台自动下载）：headless Modal 内为图标块 + 「正在下载 v{version}」标题 + 进度条（`dsh_desktop_update_status` 120ms 轮询的字节进度，`total` 未知时退化为不定态滑动动画）+ 「取消下载」（经 `dsh_desktop_cancel_update` 回到 `available` 可重下；归档壳无此命令则软失败、下载继续）；遮罩/Escape 只收起窗、下载继续、按钮原位旋转、再点即重开；下载失败窗内给「关闭 / 重试」（重试先强制 recheck 再下载）。签名校验完成进入 `ready`：窗内切换为「稍后 / 重启以更新」并展示本版更新说明（`electron-updater` 的 release notes 为事实源），用户中途收起过窗也会在 ready 瞬间自动重开；只有确认「重启以更新」才消费暂存包、安装和重启。检查、下载、安装各自单飞，下载需用户点击、安装需用户确认。**mac 发现更新即后台预拉 runtime**（npm/pnpm 源优先），点下载仍须等「瘦 zip + 对应 runtime」都就绪才 `ready`（原子切过，语义见 `dsh_desktop_download_update` 行）；弹窗图标块恒为静态 app logo（`src/client/update-logo.tsx`，从 `src/icons/icon-src.svg` 内联），忙碌旋转只留在 22px 带内按钮上。0.2.x Tauri 用户不能经旧 `latest.json` 升到 0.3.x，须从 GitHub Releases 下载。

M2（下载桥与 i18n 已实现；其余规划，先改本表再动手）：

- ~~下载桥~~（已实现）：捕获 `a[download]` 点击（同源 http(s) 与 `blob:`，纯函数 `classifyDownload` 判定）→ fetch blob → base64 → `dsh_desktop_save_file`；invoke 失败回退 `location.href` 导航下载。
- ~~badge 文案接 `ctx.locale` 双语~~（已实现，namespace `desktop-bridge`）。
- ~~标题栏融合（macOS）~~（已实现，0.2.0-rc.14 起统一 toolbar 取代带内补丁链）：壳建窗用 `hiddenInset` + `trafficLightPosition`（见 docs/electron-shell-contract.md「壳实现要点·窗口」）；桥插件在 `platform === 'macos'` 时（纯函数 `shouldFuseTitlebar`，`src/client/titlebar.ts`）注入一条 CSS——首条 `html,body{overflow:hidden;}` 把文档根锁成不可滚。0.2.0-rc.14 起**桌面标题带 = ui-layout `shell.toolbar` Slot 的真实第一行**（AppFrame `grid-template-rows: auto minmax(0,1fr)`，toolbar 行 `grid-column:1/-1`，无占用者首行 0 高、普通 Web/Win/Linux 布局逐像素不变）：桥以 `desktop-toolbar` 条目独占该 Slot（`src/client/toolbar.tsx`），38px 单行（中线 y19 与灯排同线）、根背景 `-webkit-app-region:drag`、交互子元素（button/`a[href]`/input/textarea/`[role=button]`/`[role=tab]`）no-drag——**拖动窗口不再需要分段拖拽条（rc.11 的 drag-strip.ts 整体删除）**。三分区（0.2.0-rc.16 定稿）：Controls = 86px 灯区 + 侧栏开关 + 条件更新 + 通知 + 仅收起态新会话；Main = centerHost + trailing，centerHost 内左侧为标题/动作、最右为 Thread utilities，trailing 仅承接 rightbar corner——fork ui-conversation 的 session header 经 `createPortal` 把 titleCluster（breadcrumbs+actions）与 utilities 投入 `centerHost`、rightbar corner（`data-conversation-header-corner` 锚保留）投入 `sessionEndHost`（恒最右），header 本体 `display:contents` 故**正文只留 View tabs 行、无 tabs 时正文 header 精确零高**（无重复标题、无残留 padding/border）；运行面切换不再占 toolbar，继续由 brand 右键触发 `dsh_desktop_switch_surface`；Back/Forward 与 Workspace pill 均删除。portal host 经 `ToolbarHostPublisher`（`toolbar-hosts.ts`）的 callback ref 发布进 `ctx.layout` 的注册表（fork LayoutController 新增 `setToolbarHosts`/`releaseToolbarHosts`/`getToolbarHosts`/`onToolbarHosts`，**release 按引用等值身份保护**——旧 HMR disposer 永不清掉新 host，bridge 端 publisher 与 fork 端 registry 两道独立栅栏）；ui-conversation 以可选 `ctx.get('layout')` 订阅并镜像进包内 browser-local store，Header 用 `useSyncExternalStore` 消费——**hosts 缺席（旧 runtime/bridge 卸载/HMR 间隙）header 立即原位渲染**，不复制业务组件、第三方 header contribution 照常。降级：titlebar.ts 的旧规则（侧栏列 28px 带 inset、收起态 header 固定 80px 让灯）以 `html:not([data-desktop-toolbar])` 门控保留——toolbar 挂载即标记 `documentElement`，降级态等于 rc.13 行为。右栏分流语义保留：push/float 从 toolbar 行下方开始（第二行），fullscreen 保持原生 `position:fixed; inset:0` 真接管全窗（z-40 盖住 toolbar，toolbar 保持 mounted 不可见，退出走面板自己的按钮），首个 pane `[data-dockkit-strip]` 让灯排 + strip 自带 drag（rc.13 定稿语义原样）。历史（0.2.0-rc.11–rc.13：分段拖拽条、内容顶到上沿、挖洞放宽、收起态 80px/动态避让）仅作背景，实现已删除或门控化，决策见 `docs/notes/2026-09-10-unified-shell-toolbar.md`（含被撤销的 `docs/notes/2026-09-10-collapsed-header-clears-rail-controls.md`、既有的 `docs/notes/2026-09-09-rightbar-band-drag-segments.md` 与 `docs/notes/2026-09-09-band-content-top-design.md`）。
- ~~收起侧栏整列隐藏 + 标题带控制钮（macOS）~~（已实现，0.2.0-rc.14 起控制钮迁入统一 toolbar）：Overlay 标题栏下，ui-layout 的「收起」仍是 56px 控制轨（`SIDEBAR_COLLAPSED`，rail 里有 logo/新建会话/设置图标）——这条 rail 垫在红绿灯正下方成为无交互死条。桥插件在 `platform === 'macos'` 时（与标题栏融合同一门控）把收起列压到 0 宽，并隐藏侧栏 logo 行里的原生 toggle（**BrandWordmark 保留显示**，锚点 `div[data-slot='sidebar']>div>div:first-child>button:last-child`——`data-slot` 是 slot 系统文档化的稳定锚点，Tooltip 无包裹 DOM，logoRow 的最后一个按钮即原生 toggle）：桌面全窗口**只保留一个侧栏开关**——统一 toolbar Leading 区的常驻双向 toggle（0.2.0-rc.13 及之前是 `shell.overlay` 绝对定位条目 `desktop-rail-controls`（`top:8px;left:86px`）+ 仅收起态滑入的新会话气泡，rc.14 随 toolbar 迁移并删除气泡位移动画；0.2.0-rc.16 起新会话仍在 controls DOM，但仅 `[data-sidebar-collapsed]` 时显示，展开态由侧栏主按钮独占该动作）。机制：列宽在 frame 的 inline `grid-template-columns`（`<sidebar>px minmax(0,1fr) <details>px`），纯 CSS `!important` 覆盖整条模板会丢 details 动态宽度，故用 MutationObserver 在 `data-sidebar-collapsed` 期间把第一轨改写为 `0px`（纯函数 `collapseRailTemplate`，只认「`<num>px` 开头且后随轨道」的模板形状，失配原样放行、功能退化为原生 rail；React 重渲染重写 style 后 observer 同 microtask 再纠正，无闪烁；frame 自带 grid 轨道 transition，收起 56→0 / 展开 0→280 均为平滑动画；React 不回读 DOM style 做 diff，外部改写稳定）；toggle 调 `ctx.layout.toggleSidebar()`——**点击时惰性 `ctx.get('layout')`**，绝不在注册时读取：slots.inject 在 ui-layout 声明落地（其 fiber 启动途中、尚未 ACTIVE）即触发，而 strict `ctx.get` 只服务 ACTIVE 提供方，注册时读取会拿到 undefined 导致按钮永不出现（2026-08-19 实踩，缺席仅 warn 并忽略点击）；新会话调 `ctx.uiWorkspace.startSession()`；会话后退/前进调 `ctx.sessions` 的 history face（结构化 duck-check，旧 runtime 上禁用）；样式全在 `railCss()`、只用 `--dsw-*` token。已知边界：DOM 锚点依赖 ui-layout 的 `data-sidebar-collapsed` 属性与 inline 三轨模板（ui-layout 结构变更需同步 rail.ts）；收起态下 rail 的 workspace 浏览/设置入口不可达（新会话由 toolbar 补齐，其余需展开后用）。
- ~~通知点击回跳~~（已实现）：Electron `Notification` 点击聚焦主窗口并 `sessions.open(id)`（应用身份 `dev.dsh.desktop`）。归档 Tauri 无 `on` 通道，只发横幅不回跳。
- ~~运行面切换~~（已实现，2026-08-28）：右键点击侧栏品牌区（whale 图标或 Oh My DSH 字标，锚点是 `[data-slot="sidebar.brand.mark"]`/`[data-slot="sidebar.brand.name"]` 槽包装，收起/展开两态都在）→ 桥捕获 `contextmenu`（`src/client/surface-menu.ts`，与外链/下载同一 document 捕获模式）→ `dsh_desktop_switch_surface` IPC（**不带渲染端入参**，目录只能由壳侧选择器给出）→ 壳弹原生菜单「切换运行面…」→ 目录选择器（默认 `$DSH_HOME/profiles`，选别处以「必须是 profiles 直接子目录」拒绝，软链接入的外部目录合法）→ `validateSurfaceDir`（存在且是目录、bundles 含 `@deepseek-ai/dsh-web-app`、可读写；缺 web bundle 提示先终端补层）→ 原生确认框（说明：回合中断、窗口自动重载、会话/设置/凭据保留；首切提示将装随包插件）→ `runDesktopPluginInstall` 对该 profile 跑同一 shadow-CAS 事务（`install.ts`/`profile-repair.ts` 已从写死 `web` 泛化为 profile 参数；`profile-repair` 的 journal 仍是 home 级单飞，恢复时从事故 journal 的 `realProfile` 推回目标 profile，无 journal 时扫描所有 profile 的 marker）→ kill → `--profile <name>` respawn → waitReady → `loadURL`。**活动运行面按 home 持久化在 `~/.dsh-desktop/active-profiles/<home-hash>.json`（scratch home 的 e2e 不污染真实 home 的下次启动），只在新 sidecar 就绪后落盘**；未就绪自动 respawn 旧运行面回滚并原生报错。boot 时活动运行面失效（被终端删/改坏）→ 原生提示并回退 web。随包插件进每个被切到的运行面，保证切换后 bridge 仍在、能切回来。决策见 `docs/notes/2026-08-28-runtime-surface-switch.md`。
- 托盘 / 未读角标（壳读 DOM title 或插件显式上报）。

### 组合与 slot 纪律（沿用 DSH client 约定的最小子集）

- UI 只经 `ctx.slots.register(...)` 组合；本插件只注册已声明的加性槽 `shell.overlay`（badge/拖拽条/带内 rail 控件，更新入口嵌在 rail 控件内），声明洞一律禁止。品牌字标等"始终挂载"关注点不归桥（见 docs/plugins-catalog.md 的 `dsh-branding` 条）。
- 跨包只走 slot 与 ctx 服务，禁止 import 其他插件的实现符号；harness 包只做 type-only import（构建时擦除）。
- 注册即 effect：所有监听、订阅、slot 注册经 `ctx.effect()` / register 返回的 disposer，卸载/HMR 全量回收。
- 文案中文（M2 起接 `ctx.locale` 双语）；代码注释英文。
- 无硬编码 tunable：可调项（如通知开关）是 `Config` 字段，从 cordis.yml `config` 进来，非法值 fail loud。
