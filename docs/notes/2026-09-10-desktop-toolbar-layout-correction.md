# Desktop toolbar 布局修正方案

2026-09-10 · bridge 0.2.0-rc.16 / runtime `v0.1.5-alpha.1+zw.3` · 状态：**已实施并通过 desktop:dev 实机验收**

## 结论

本轮只修改 `dsh-desktop-bridge`，不再修改 DSH fork。

现有 fork 已提供两个必要能力：`ui-layout` 的真实 `shell.toolbar` 首行，以及 `ui-conversation` 把原 Session Header 投入 toolbar host 的 Portal。它们已经解决“顶部控件作为 overlay 遮挡正文”的根问题。截图中的后退/前进、Workspace pill、运行面刷新图标及整条 sidebar 色带均由 bridge 自己渲染或着色，可以在插件内删除和重排。

纯 stock DSH 加插件无法可靠移动原 Session Header，因为 stock 没有真实 toolbar 行和标题迁移入口；继续用 `shell.overlay`、绝对定位或 DOM 搬运会重新引入遮挡、点击和 HMR 生命周期问题。但当前桌面 runtime 已有正确的 fork 接口，因此这次不需要新增任何 fork API。

## 最终实机定稿

本节覆盖下文实施前方案中关于“新会话常驻”“Update/Notify 位于 trailing”“controls 绝对定位”和“固定双按钮 clearance”的早期假设；下文保留为问题分析和演进记录。

- `controls` 是第一列内的 in-flow grid item，顺序为侧栏开关、条件更新、通知、收起态新会话。新会话展开态由 `display:none!important` 隐藏，收起态才显示；`!important` 用来压过同等 specificity、后声明的 rail-button `display:inline-flex`。
- `main` 复用 AppFrame subgrid 的 `2 / -1` 轨道；收起态按真实控件数避让：通常三按钮使用 176px，更新按钮存在时由 `:has([data-desktop-update-button])` 切到 204px，两种情况都在最后一个按钮后留 8px。
- portalled Session Header 分成两个语义簇：标题、创造模式、模型选择和 Session 日志紧跟会话列左缘；Thread 等 `header.utilities` 经 `margin-left:auto` 固定在右端，rightbar corner 紧随其后。内容动作内部使用 8px，Thread 到 corner 使用与左侧工具栏图标一致的 2px。
- toolbar 根保持 drag region；交互后代统一 `-webkit-app-region:no-drag!important`。`main` 自身 `pointer-events:none`，center/trailing host 恢复 `pointer-events:auto`，避免布局盒吞掉侧栏开关、新会话或 portalled action 的点击。
- Back/Forward、Workspace pill 和 toolbar 内运行面切换入口永久删除；品牌区右键的运行面菜单保留。rightbar corner 的 stock 正负 margin 在 toolbar 内归零。
- 最终验证：`pnpm run typecheck`、106 个 node:test、16 个 Vitest 浏览器组件测试和 `pnpm run build` 全部通过；多轮真实 Electron 截图与点击验收通过。

## 当前问题定位

1. 顶部 `‹` / `›` 来自 `DesktopToolbar` 对 fork `ISessions.canBack/canForward/back/forward` 的消费。按钮在没有历史时按设计 disabled，所以看起来“完全点不了”；该能力并非用户需求，应从 UI 和 bridge 注入面删除。
2. 右侧 `oh-my-dsh` 是 bridge 从 Workspace mirror 推导的 `WorkspacePill`，并非会话消息或原生标题。它脱离侧栏上下文后像一条跑到右边的消息，应删除。Workspace 仍由左侧栏和 blank Hero 的原生 workspace 控件表达。
3. 右侧刷新图标是 `dsh_desktop_switch_surface` 的入口，不是刷新。图标语义错误且功能已经有“右键侧栏品牌区”入口，应从 toolbar 删除，保留 `surface-menu.ts` 的原入口。
4. toolbar 根节点整体使用 `--dsw-specific-sidebar-fill`，造成一条横跨窗口的深色带。展开侧栏时，顶部没有延续“侧栏列 / 会话列”的视觉分区。
5. 当前 toolbar 是一层全宽 flex，标题只是在剩余空间内伸缩，没有跟随 AppFrame 的实际 sidebar track。侧栏展开、收起或拖宽时，标题不与下面的会话列左边界建立稳定关系。

## 目标布局

### 侧栏展开

```text
┌ traffic lights ─ sidebar toggle ─ new ────┬ session title / actions ───────────── update notify corner ┐
│              sidebar                      │ conversation body                                             │
│          [新会话主按钮]                    │                                                               │
└───────────────────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

- toolbar 第一段与侧栏同宽、同背景，保留侧栏开关和新会话两个有效按钮。
- 会话标题从会话列左边界后 12px 开始，随侧栏拖宽实时移动。
- 右侧只保留真实全局状态：有更新时的更新按钮、通知按钮、Session Header corner。

### 侧栏收起

```text
┌ traffic lights ─ sidebar toggle ─ new session ─ session title / actions ─── update notify corner ┐
│                                conversation body full width                                      │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- sidebar track 继续由现有 `installRailHider` 归零，正文列占满窗口宽度。
- 侧栏开关移到灯区右侧；由于侧栏主按钮不可见，旁边补一个新会话图标。
- 标题紧跟两个按钮之后，不与灯区或按钮重叠。
- toolbar 仍是 AppFrame 的真实第一行，正文从其底边开始，不存在透明 overlay 点击层。

### 空白会话和无会话

- 保持 stock 语义：blank Session Header 不显示标题；不伪造 session id 或 workspace 名补空。
- toolbar 仍保留侧栏开关和新会话按钮。
- 更新和通知按各自现有状态显示。

## 插件实现

### 1. 精简 `DesktopToolbar`

修改 `plugin/dsh-desktop-bridge/src/client/toolbar.tsx`：

- 删除 `WorkspacePill`、`useWorkspaces` 读取和 `sessionId` 依赖。
- 删除 Chevron 图标、`canBack`、`canForward`、`back`、`forward`。
- 删除 `IconRefreshOutline16`、`switchSurface` 和 toolbar 内运行面入口。
- DOM 收敛为三个区域：`controls`、`centerHost`、`trailing`。
- `controls` 只含 sidebar toggle 和新会话两个有效按钮，两种侧栏状态都保留，不再用 disabled 或条件导航项制造布局抖动。
- `trailing` 只含 `UpdateControl`、`NotifyCenter`、`sessionEndHost`。
- 所有图标按钮继续保留本地化 `aria-label` / `title`，点击回调继续走现有 typed/structural 服务，不做 DOM click 转发。

建议 DOM：

```text
[data-desktop-toolbar]
  [data-desktop-toolbar-controls]
    toggle button
    new-session button
  [data-desktop-toolbar-main]
    [data-desktop-toolbar-center]  <- centerHost
    [data-desktop-toolbar-trailing]
      update
      notify
      [data-desktop-toolbar-end]   <- sessionEndHost
```

### 2. 让 toolbar 复用 AppFrame 三列

修改 `plugin/dsh-desktop-bridge/src/client/rail.ts`，不增加 JS 测量器：

- 将 `[data-shell-toolbar-row]` 设为三列 `subgrid`，稳定的 `[data-slot='shell.toolbar']` wrapper 使用 `display:contents`，让 `[data-desktop-toolbar]` 成为 subgrid 的直接布局项并跨 `1 / -1`。
- `controls` 是从左侧 86px 灯区之后开始的固定定位簇，不参与标题宽度计算；`main` 放在 grid column `2 / -1`。
- 展开态 `main` 从真实 sidebar track 右边界开始，侧栏拖宽和 concession 动画会由 subgrid 自动传递。
- 收起态的第一 track 已被现有 rail hider 改成 `0px`；此时通过祖先的 `data-sidebar-collapsed` 给 `main` 增加 `86px + 两个 26px 按钮 + gap` 的固定左侧 clearance。该 clearance 与列动画同步，并在 `prefers-reduced-motion` 下关闭过渡。
- toolbar 根使用 `--dsw-alias-bg-base`；用占据 grid column 1 的非交互伪元素绘制 `--dsw-specific-sidebar-fill`，让展开态顶部延续 sidebar 段，收起后该 `0px` track 自动消失。删除整条 toolbar 的 sidebar 背景，消除贯穿全窗的黑带感。
- `controls` / `main` 均为 38px 固定高度、单行、`min-width:0`；title host 可收缩并 ellipsis，trailing 不收缩、不换行。
- toolbar 根背景保持 `-webkit-app-region:drag`；所有 `button`、链接、输入、role button/tab 保持 `no-drag`。额外对 `controls` 和 portalled Session Header 的可交互后代做命中验证，不能依赖视觉上可见来判断可点。
- 小宽度只做内容优先级降级：标题截断，更新/通知/corner 保留；不再存在需要隐藏的 back/forward 和 Workspace pill。

`subgrid` 直接继承 AppFrame 当前的实际三列，包括侧栏拖宽、右栏 push 以及 rail hider 写入的 `0px`。这样无需把 layout geometry 加到 Slot owner props，也无需 MutationObserver 再测一遍 sidebar 宽度。

若实机目标 Electron/WKWebView 对 `subgrid` 支持不符合预期，停止插件实现并采用唯一的最小 fork 备选：给 `shell.toolbar` owner props 增加 `{ sidebarCollapsed, sidebarWidth }`，由 AppFrame 在 `renderSlot` 处下发。不得退回 overlay、绝对定位标题或 DOM reparent。

### 3. 精简 apply 注入面

修改 `plugin/dsh-desktop-bridge/src/client/index.ts`：

- 删除 `historyApi()` 和注入给 toolbar 的四个 history 回调。
- 删除 toolbar 的 `switchSurface` 回调。
- 保留 `installSurfaceMenu(document, invoke, logger)`，运行面切换继续通过侧栏品牌区右键触发。
- 保留 `ToolbarHostPublisher`、`shell.toolbar` 注册的旧 runtime try/catch 降级，以及注册成功后才设置的 `data-shell-toolbar-on`。
- 保留更新、通知、侧栏切换、新会话、下载、外链和系统通知行为。

### 4. 清理文案和类型

修改 `plugin/dsh-desktop-bridge/src/client/locales.ts`：

- 删除 `toolbar.back`、`toolbar.forward`、`toolbar.surface`。
- 保留 `rail.toggle`、`rail.newSession` 和 `toolbar.label`。

同步收紧 `DesktopToolbarInjected` 与组件 props；不再要求 session-controller 的 selection-history 结构。

## DSH fork 处置

本轮不改 fork，不发新的 fork tag，不改 `runtime/revision.json`。

保留：

- `ui-layout`: `shell.toolbar` Slot、AppFrame 真实第一行、toolbar host registry。
- `ui-conversation`: 原 Session Header 的双 host Portal 与无 host 原位回退。

暂不删除：

- `session-controller` 已发布的 `SelectionHistory` 与 `ISessions.back/forward`。bridge 不再消费后它们只是未使用 API，不影响当前 UI。为了删四个不可见方法单独发 fork/runtime/desktop 全链版本，风险高于收益。

后续随正常 harness 基线升级时再评估移除 selection-history；移除前先全仓检索消费者并按 fork 的 API 变更规则处理，不作为本次视觉修正的发布阻塞项。

## 文件清单

本次实现预计修改：

- `plugin/dsh-desktop-bridge/src/client/toolbar.tsx`
- `plugin/dsh-desktop-bridge/src/client/rail.ts`
- `plugin/dsh-desktop-bridge/src/client/index.ts`
- `plugin/dsh-desktop-bridge/src/client/locales.ts`
- `plugin/dsh-desktop-bridge/tests/rail.test.ts`
- `plugin/dsh-desktop-bridge/tests/toolbar-degradation.client.spec.tsx`（仅在测试桩类型需要同步时修改）
- 新增 `plugin/dsh-desktop-bridge/tests/toolbar.client.spec.tsx`
- `plugin/dsh-desktop-bridge/README.md`
- `AGENTS.md` 中 bridge 当前行为摘要
- `CHANGELOG.md` 和版本字段仅在实机验收通过、准备随 Desktop 发布时更新

明确不修改：

- `runtime/src/packages/**`
- `runtime/revision.json`
- Electron `src/main.ts` / `src/preload.ts` / `src/ipc.ts`
- `surface-menu.ts` 与壳侧 `dsh_desktop_switch_surface` IPC

## 自动化验证

### 组件测试

新增 `toolbar.client.spec.tsx`，直接渲染组件并断言：

1. 只出现 sidebar toggle 和 new-session 两个 bridge 控件。
2. 不出现 Back、Forward、Workspace、Surface switch。
3. toggle/new-session 点击各调用一次对应回调。
4. center/end callback ref 挂载与卸载仍交给 `ToolbarHostPublisher`。
5. Update / Notify / corner 容器仍存在，不因删除右侧项目改变顺序。

### CSS/纯函数测试

更新 `rail.test.ts`，断言：

1. toolbar row 采用 subgrid、slot wrapper 使用 `display:contents`、toolbar root 跨三列。
2. controls 固定在灯区右侧，main 在 conversation/rightbar tracks；sidebar 背景伪元素只占第一 track。
3. 收起态 controls 左移、main 预留灯区和两个按钮宽度。
4. toggle 和新会话在展开/收起两态都存在，且不进入 drag hit region。
5. 会话段为 base 背景，sidebar 段为 sidebar 背景，不出现字面颜色。
6. 所有可交互元素继续 `app-region:no-drag`。
7. toolbar 固定 38px、无 wrap，center 可收缩，trailing 不收缩。

保留并运行：

- `toolbar-hosts.test.ts`: HMR 旧 disposer 不释放新 host。
- `toolbar-degradation.client.spec.tsx`: 旧 runtime 无 `shell.toolbar` 时桥的其他能力仍存活，fallback marker 不误设。
- titlebar / rail hider / surface-menu 现有测试。

### 包级检查

在 `plugin/dsh-desktop-bridge` 运行：

```sh
pnpm run typecheck
pnpm run test
pnpm run build
```

构建后检查 `lib/client.js` 不再包含 Back/Forward/WorkspacePill/IconRefresh 或 selection-history 调用。

## 实机验收

必须用当前 GUI 的真实 Desktop shell 和 runtime `v0.1.5-alpha.1+zw.3`，不能以独立 Vite 页面代替。先确认 bridge watch/build 链确实把新 `lib/client.js` 送入现有 sidecar；没有 watcher 时按仓库 desktop 开发流程重启 sidecar，不承诺 HMR。

矩阵：

- 窗口宽度：1908、1400、1100、768、600。
- 侧栏：展开、收起、拖到最小/默认/较宽。
- Session：无会话、blank、普通、subagent、超长中英文标题、多 View tabs。
- 右栏：closed、push、float、fullscreen。
- 动态项：无更新/有更新、通知 0/有未读。
- 主题：亮色、暗色。

每个状态检查：

1. `‹` / `›` 不存在，右侧 workspace pill 和刷新图标不存在。
2. 展开态标题左边与下面 conversation column 左边对齐；拖动侧栏时同帧跟随，无跳变。
3. 收起态 conversation body 横向占满；标题位于灯区、toggle、新会话之后。
4. traffic lights 与任何 Web 控件 bounding boxes 不相交。
5. toggle 和新会话通过真实点击可用；用 `document.elementFromPoint` 验证命中目标是按钮而非 drag layer。
6. title/actions/utilities/update/notify/corner 不重叠、不换行；长标题只截断自身。
7. toolbar 空白处可拖窗，任一按钮及 portalled action 点击不触发窗口拖动。
8. 正文顶部等于 toolbar 底边；不存在被透明 overlay 覆盖的区域，首条消息和滚动条可从顶部正常交互。
9. blank/无会话不显示伪标题；展开/收起不产生重复标题。
10. fullscreen rightbar 完整覆盖 toolbar，退出后 toolbar 和 Portal 恢复。

建议保存 1908x183 的同尺寸顶部截图，以及 1400x900 的展开/收起全窗截图用于前后对比。

## 发布顺序

1. 只在 bridge 源码完成组件/CSS/测试修改，保持 `runtime/revision.json` 不动。
2. 包级 typecheck/test/build 通过后跑 Desktop 实机矩阵。
3. 用户确认视觉和交互后 bump bridge 到下一版本（预计 `0.2.0-rc.16`），同步 README、AGENTS 和 CHANGELOG。
4. bridge 属于 `dsh.desktop.ship: true`，必须随下一版 Desktop `v*` 发布；不能只打独立插件 tag 替代已安装 Desktop 的更新。
5. 发布前按 `docs/release-runbook.md` 和 `docs/packaging-playbook.md` 完成 runtime、随包插件 tarball、packaged profile 与旧 runtime 降级检查。

## 否决项

- 不恢复 `shell.overlay` 顶部工具条。
- 不用固定 `margin-left: 272px` 猜侧栏宽度。
- 不复制 Session title 文本或重写 header actions；继续 Portal 原组件，避免双状态源。
- 不用 MutationObserver 搬运 header DOM。
- 不把运行面切换伪装成刷新按钮。
- 不为已经决定删除的 Back/Forward 留 disabled 占位。
- 不在本轮为了清理未使用 history API 单独升级 fork/runtime。
