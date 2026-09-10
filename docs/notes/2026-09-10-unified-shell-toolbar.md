# 统一桌面 toolbar（shell.toolbar Slot + Session Header 双 host Portal）

2026-09-10 · 取代「收起态会话标题避让 rail 控件」（同日撤销）与 rc.11–rc.13 的分段拖拽条/内容顶边方案 · 状态：**已实施（bridge 0.2.0-rc.14 重写语义 + fork bump/0.1.5-alpha.1-adapt 三包），待 desktop:dev 实机验收与合并发版**

## 为什么废弃前一方案

rc.12「内容顶到窗口上沿」把 session header、右栏页签条塞进 28px 顶部带，随后连环补丁：分段拖拽条挖洞（rc.11）、收起态 80px 让灯（rc.13）、ResizeObserver 动态避让（rc.14 首版，评审后又补节点重绑）。补丁链的共同根因是**布局层级错了**——带内控件不是布局的一部分，靠 overlay 叠加 + 测量避让永远在追着 DOM 跑。方向性结论：

> 新增一条真正参与 AppFrame 布局的统一 toolbar，把现有 Session Header 通过 React Portal 投射进去。不再使用 `shell.overlay` 做工具栏，也不再给标题算动态 `padding-left`。

## 架构

```text
┌ traffic lights ┬ sidebar ┬ back ┬ forward ┬ new ┬ session title ┬ workspace ┬ actions ──┬ surface ┬ update ┬ notify ┬ corner ┐
├──────────────────────────────────── 统一 38px toolbar（grid 第一行，跨全列）──────────────────────────────────────────────────────┤
│ sidebar column │                        conversation body                        │ details/rightbar body                          │
```

### 1. fork ui-layout：`shell.toolbar` Slot + 两行 AppFrame

- `SlotMap` 新增 `'shell.toolbar': { kind: 'single'; scope: 'session-maybe' }`——single（唯一占用者）、session-maybe（占用者拿到 sessionId/useSession/useSessions/useWorkspaces 标准 shares，无 session 时不卸载）。
- AppFrame：`grid-template-rows: auto minmax(0, 1fr)`；新增首个流内子元素 `toolbarRow`（`grid-column: 1 / -1; grid-row: 1`），三列显式 `grid-row: 2`（杜绝 auto-placement 歧义）。**无占用者时 auto 行高为 0**——普通 Web、Windows、Linux 布局与单行时代逐像素一致。
- `LayoutController`（ctx.layout）扩展 toolbar-host 注册表：`setToolbarHosts` / `releaseToolbarHosts`（**引用等值身份保护：stale release 不清新 pair**）/ `getToolbarHosts` / `onToolbarHosts`。只传 DOM Element，不序列化、不进 Host RPC。

### 2. fork ui-conversation：Session Header 双 host Portal

- apply 世界 `ctx.get('layout')` **可选**订阅 toolbar-host 注册表，镜像进包内 browser-local store（`skeleton/toolbar-hosts.ts`）；Header 组件 `useSyncExternalStore` 消费。
- hosts 在场且非 blank：`createPortal` 把 titleCluster（breadcrumbs + actions）与 utilities 投进 `centerHost`，把 rightbar corner（保留 `data-conversation-header-corner` 锚）投进 `sessionEndHost`；header 本体 `display: contents`（`.headerPortalled`）——**正文只留 View tabs 行，无 tabs 时正文 header 精确零高**（无残留 padding/border）。
- hosts 缺席（bridge 卸载、旧 runtime、HMR 切换间隙）：立即回到原位渲染，不复制业务组件，第三方 header contribution（lineage/actions/utilities/corner 子 slot）全部照常。

### 3. bridge：`DesktopToolbar`

- 占用 `shell.toolbar`（id `desktop-toolbar`），38px——中线 y19 与 `trafficLightPosition {x:16,y:10}` 灯排同线。
- Leading：86px 原生灯区、侧栏切换、**后退/前进**（见 §4）、新会话（常驻，collapsed-only 气泡及其动画删除）。
- Center：`centerHost` cell + Workspace pill（从 Session/Workspace mirror 推导，无归属不渲染——不做死控件；可点击 switcher 留待后续，不移动 hero picker 的 DOM）。
- Trailing：运行面切换（直接触发 `dsh_desktop_switch_surface` 原生菜单，与 brand 右键同命令）、更新、通知、`sessionEndHost` cell。
- 根背景 `-webkit-app-region: drag`；button/`a[href]`/input/textarea/`[role=button]`/`[role=tab]` 统一 no-drag。**普通模式的分段拖拽条（drag-strip.ts）整体删除**。
- Host cell 通过 `ToolbarHostPublisher` 的 callback ref 发布：bridge 端（只发布/释放自己那对）+ fork 端（release 仅在 `current === hosts` 时生效）**两道独立身份栅栏**，旧 HMR disposer 永不误删新 host。
- `data-shell-toolbar-on` 标记挂 `documentElement`（挂载/卸载随 fiber），titlebar.ts 的旧规则用它门控——根标记与 toolbar 组件的 `data-desktop-toolbar` DOM 属性刻意不同名，避免属性选择器在探针/样式里误配 `<html>`。

### 4. fork session-controller：transient selection history

- `SelectionHistory`（独立纯类，单测覆盖）：有界 50、连续重复去重、回退后新选择截断 forward 尾、`prune(sessionId)` 剔除已删会话并保持光标逻辑位。
- manager 集成：`select`/`selectSubagent`/`clearSelection` 记录（**clear 也入史**；回放期间抑制记录）；`back()` 逐级跳过不可达条目（已删且无 retained address 的 prune 后继续）；列表 remove mutation（实时 + 拉取回放两路）触发 prune。
- `ISessions` 扩 `canBack/canForward/back/forward`。bridge 端全部结构化 duck-check：旧 runtime 上按钮禁用、操作 no-op，不炸。

## 兼容与降级

- **无 toolbar（fork 未升级 / bridge 未挂载）**：titlebar.ts 的旧规则（侧栏 28px 带 + 收起态固定 80px）以 `html:not([data-shell-toolbar-on])` 门控继续生效——rc.13 行为即 fallback。
- **fullscreen rightbar 不变**：仍 `fixed inset:0` 真接管（z-40 盖住 toolbar，toolbar 保持 mounted 不可见，退出走面板按钮）；首个 pane strip 让灯 + 自带拖拽语义原样保留。
- **保留不变**：收起侧栏真实 0px + 原生 toggle 隐藏（rail.ts）、更新/通知/新会话/运行面现有业务回调、手写 style 的 `data-plugin`/`data-plugin-css` 所有权纪律。
- **不再渲染假按钮**：没有 Terminal 能力就不画 Terminal；Help 无真实目标暂不渲染；`More` 菜单不做 DOM 克隆，若要统一菜单需先立 typed command/menu seam。

## 响应式

- `>=1100px`：完整标题、Workspace 文本、全部真实 actions。
- `768–1099px`：Center 弹性截断（ellipsis），不缩字号。
- `<768px`：back/forward 与 Workspace pill 隐藏；灯区、toggle、新会话、标题、Trailing 保留。
- 更新/通知动态出现只压缩 Center，永不换行。

## 版本与处置

- bridge `0.2.0-rc.14` 版本号保留、**语义重写**为本方案（首版动态避让从未产生外部分发产物）；supersede 提交删除 `installRailClearance`/`RAIL_CLEARANCE_VAR`/动态 padding/`drag-strip.ts`，不重写已推送历史。
- 旧决策 `2026-09-10-collapsed-header-clears-rail-controls.md` 标记「已撤销、未发布」。
- fork 改动住 `bump/0.1.5-alpha.1-adapt`；发布时升下一版 fork revision（`+zw.3`），dsh-desktop 各包 devDeps 随之 bump 后，bridge 的结构化声明（`ToolbarRuntimeShares`/host registry/history duck）收紧为真类型。
- `v0.3.0-rc.45` 桌面 tag 继续挂起，随其余改动合并发版。

## 发布事故与修复（rc.45 → rc.46）

**rc.45 事故**：rc.45 发版携带 toolbar 版 bridge 0.2.0-rc.14，但 `runtime/revision.json` 仍钉 `v0.1.5-alpha.1+zw.1`——旧 runtime 的 ui-layout 未声明 `shell.toolbar`，桥的 `slots.register` fail loud，**整个桥 client fiber 加载失败**（外链路由/下载/通知/更新入口全灭；更新入口在桥里，事故无法经更新自愈，用户只能手动下载）。

**三个叠加缺口**：
1. 实现缺口——hosts/history 都做了结构化 duck-check，但 slot 注册本身没防御（`(ctx.slots.register as Function)` 只绕过类型，cordis 运行时校验照炸）；且 `data-shell-toolbar-on` 标记 effect 挂在注册之前，注册失败标记仍会设置、错误关闭 fallback 规则。
2. 发版缺口——发 rc.45 时未把 revision.json 同步指向含 `shell.toolbar` 基座的 fork。
3. 验收盲区——dev 验收的 sidecar 跑 fork 新源码（slot 存在），「新插件+旧 runtime」组合从未被测过。

**修复（rc.46）**：
- bridge 0.2.0-rc.15：`shell.toolbar` 注册包 try/catch——旧 runtime 上注册失败仅 warn 降级（无工具栏、标记不设置、rc.13 fallback 保持、桥其余能力全部存活）；标记 effect 移到注册成功之后。新增回归 spec `toolbar-degradation.client.spec.tsx`（模拟 slot 未声明的 cordis 环境：桥存活、badge 照常、无标记、降级 warn；新 runtime 用例：toolbar 注册+标记设置）。
- revision.json → `v0.1.5-alpha.1+zw.3`（fork tag，含完整基座）。**插曲**：fork 首提交 `dfe18674e8` 因 stash 栈跨 worktree 与并行会话交错只提交了 3 个新文件（既有文件修改全部滞留工作树），`98bcf0c6e9` 补全——zw.3 tag 钉在补全提交上。
- 纪律沉淀（AGENTS 发版节）：随包插件消费 fork 新 Slot 时同版 revision 必须指向声明它的 fork；新 Slot 注册必须 try/catch 降级；验证矩阵必须含旧 runtime 组合。

## 验收矩阵（desktop:dev 实机）

宽度 1400/1100/767/600 × sidebar 展开/收起 × 无 Session/普通 Session/Subagent × 长中英文标题 × 多 tabs × 更新可用 × 通知未读 × rightbar closed/push/fullscreen。自动断言：toolbar 单行、灯区不相交、Center/Trailing 不重叠、正文起点=toolbar 底边、无重复标题、无 tabs 时 header 零高、按钮可点、空白可拖窗、fullscreen 不露 toolbar。Portal 生命周期 `null → host A → host B → null`、旧 disposer 不清新节点、bridge/ui-layout/ui-conversation 乱序 HMR。
