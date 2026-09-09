# 桌面端内容顶到窗口上沿（消灭 28px 空带）设计方案

2026-09-09 · 叠加在 dsh-desktop-bridge 0.2.0-rc.11（分段拖拽条）之上 · 状态：**已实施（bridge 0.2.0-rc.13，含文末 rc.13 修订），待实机验收与随壳发布**

## 背景与目标

rc.11 修复了右侧栏按钮被拖拽条吞点击/悬停的问题，但保留了「三栏内容一律下移 28px」的标题带预留，中间对话栏上方出现一条空带，用户感知不佳。本方案让**内容顶到窗口上沿**（macOS 原生工具栏式布局），同时守住三条底线：

1. 红绿灯（x≈16–70，y≈6–20）不遮任何内容；
2. 带内所有控件悬停/点击正常（不被拖拽区吞）；
3. 顶部空隙仍可拖窗。

仅影响 macOS 标题栏融合（`shouldFuseTitlebar`）；Windows/Linux 保留原生标题栏，零变化。归档 Tauri 壳经段上 `data-tauri-drag-region` 保留拖拽。

## 关键事实（实机测量，0.1.2 运行时 + Electron 37）

- frame 结构：`div:has(> [data-shell-overlay])` 的前三个子元素是侧栏/中间/右栏网格列；收起态由 frame 的 `data-sidebar-collapsed` 标记。
- 右侧栏面板是绝对/固定定位表面：`div[data-sidebar-right-panel]`，模式值 `"push"`（停靠，absolute，top:0）/ `"fullscreen"`（**fixed inset:0，z-index:40**）/ 代码中另有 `"float"`。栏列 padding 对 absolute/fixed 无效——这就是 rc.11 要单独压它 28px 的原因。
- 页签条锚点 `[data-dockkit-strip]`（高 37px）；面板控制钮（向右分栏/全屏显示侧栏/收起侧栏/关闭）都在 strip 内。
- 会话头部有稳定槽包装 `[data-slot="conversation.session.header"]`（title/actions/utilities/tabs 都在其中）。
- 层叠：overlay 层 z-20；push 面板 z-10（在 overlay 之下，拖拽段会盖住它的带内按钮，所以必须挖洞）；fullscreen 面板 z-40（反过来盖住 overlay，其带内区域天然在段之上）。
- 拖拽区是 OS 级命中（`-webkit-app-region`），元素被段覆盖即吞点击；z-index 抬升穿不过层叠上下文，栏目级 drag+子级 no-drag 会让整个窗口变拖拽区（均已在 rc.11 排查中实机否决）。

## 设计

### 1. 栏列 padding 只留首栏（titlebar.ts）

```
div:has(> [data-shell-overlay])>div:nth-child(1){box-sizing:border-box;padding-top:28px;}
```

- 侧栏内容必须让红绿灯（展开态灯排在侧栏 surface 上方）；中间/右栏不再下移，session header、右栏 strip 进入顶部带。
- 侧栏 surface 仍从顶边铺开（padding 只推内容），视觉不变。

### 2. 右栏面板按模式分流（titlebar.ts）

```
[data-sidebar-right-panel="fullscreen"]{top:28px!important;}
```

- `push`/`float`：**不偏移**，头部顶到 y=0，与中间 header 同线。
- `fullscreen`：~~保留 28px 下压。原因是该模式 z-40 盖住 overlay 层——若 top:0，面板会盖住 rail 控件（侧栏开关/通知/新会话，overlay z-20 内，层叠出不去）且页签条撞红绿灯；保留 top:28 则灯排、rail 控件、拖拽带全部留在上方正常工作。bottom 仍为 0，高度自然收缩。~~ **rc.13 修订否决，改为真接管全窗，见文末修订节。**

### 3. 挖洞范围放宽到全文档（drag-strip.ts）

`collectBandHoles` 从「仅 `[data-sidebar-right-panel]` 内」放宽为「文档内所有与 28px 带相交的可交互元素」（button / a[href] / [role=button] / [role=tab] / input / textarea / contenteditable；仍跳过 visibility:hidden 与 opacity:0、过小矩形），洞外扩 6px 合并取补、<12px 碎段丢弃的逻辑不变。

- 中间 header 的 utilities/actions/tabs（分栏、日志、轨迹、线程胶囊图标等）顶进带内后必须挖洞，否则重蹈 rc.11 之前整宽条吞点击的覆辙。
- 会话滚动区在新布局下位于 header 之下，内容滚不进带；即使未来布局变化导致被裁剪内容几何压带，后果只是多挖一块洞（拖拽面积略减），功能无损。
- reconciler 触发不变：body subtree MutationObserver（100ms 防抖）+ resize + 2s 兜底轮询；卸载全量回收。

### 4. 收起态红绿灯水平避让（titlebar.ts）

侧栏收起时首轨压 0 宽，中间栏从 x=0 起，其 header 左侧内容会撞灯排：

```
div[data-sidebar-collapsed]:has(> [data-shell-overlay]) [data-slot="conversation.session.header"]{padding-left:80px;}
```

- 80px 与 rail 控件 `left:86px` 同一标线。展开态（x≥280）无需避让，不加规则。
- **待实机确认的边界**：无 header 的视图（hero 空态、会话未选中）在收起态是否有内容压灯；hero 为居中布局，预期无碍，实测若有再按同姿势补规则。

### 5. 不变项

- `html,body{overflow:hidden}` 根滚动锁、rail.ts 收起列机制、rail 控件布局、badge、更新入口。
- `titlebar.tsx` / `index.ts` 结构沿用 rc.11（slot `inject` 闭包下发 `mount`，组件不做订阅机械）。

## 影响面与测试

变更文件（均在 `plugin/dsh-desktop-bridge`）：

- `src/client/titlebar.ts`：CSS 三处（首栏 padding、fullscreen 限定、收起态避让）；
- `src/client/drag-strip.ts`：挖洞选择器放宽 + 注释；
- `tests/titlebar.test.ts`：断言更新；`tests/drag-strip.test.ts`：区间纯函数不变，可补一条「洞来自任意压带元素」的 collectBandHoles 语义说明性测试（DOM 桩）。

发布：bridge 升 0.2.0-rc.12；属 desktop-owned 清单 → 需随壳发一版桌面（bump 仓根 + `v<semver>` tag，同一天壳修复可合并发）。AGENTS.md 发版条目与本文件同步更新。

## 实机验收清单

1. 展开态：header 顶到上沿；header 全部按钮悬停稳定、点击响应；标题文字区/控件空隙可拖窗。
2. 收起态：header 左侧让出灯排；rail 控件可用；新会话气泡正常。
3. 右栏停靠：页签条顶到上沿，四个控制钮正常。
4. 右栏 fullscreen：面板从 y=28 起，不撞灯；rail 控件可见可用；带区可拖。
5. 右栏关闭：无多余洞，带区可拖。
6. hero 空态（无会话）：各态无压灯、无内容被吞。
7. 回归：外链路由、下载桥、通知、运行面切换、更新弹窗不受影响（本次未触碰，但过一遍）。

## 风险

- reconciler 有 ≤100ms 的跟随延迟，模式切换瞬间点击带内按钮理论上可能被段吞一次——与 rc.11 同级，可接受。
- `[data-sidebar-right-panel]` / `[data-dockkit-strip]` / `[data-slot="conversation.session.header"]` / `data-sidebar-collapsed` 均为稳定锚点（数据属性与槽包装，非哈希类名）；右侧栏包或 ui-layout 结构变更时需同步（与既有 rail 锚点同性质）。
- ~~fullscreen 保留 top:28 是对「z-40 盖住 overlay」的让步，视觉上 fullscreen 面板比中间栏内容低 28px——fullscreen 下中间栏不可见，无对比突兀。~~ **已被 rc.13 修订否决**：实机效果是面板掉到第二行、与中间栏 header 叠看，不符合全屏语义；rc.13 改为真接管 + 页签条让灯排 + 页签条自带拖拽。

## 修订（rc.13 方案）：fullscreen 真正接管全窗

**起因**：rc.12 落地后实机验收发现——fullscreen 保留 `top:28px` 的结果是面板整体「掉到第二行」：中间栏 header 仍露在 y0–28，下方才是全宽面板，两行 chrome 叠看，语义上也不是用户预期的「全屏」。原方案「fullscreen 保留下压」的取舍被否决，改为**真·全屏接管 + 页签条让灯排 + 页签条自带拖拽**。

### fullscreen 目标态

- 面板恢复原生 `position:fixed; inset:0`（**删除 rc.12 的 `[data-sidebar-right-panel="fullscreen"]{top:28px!important}`**，`titlebar.ts:78`）：面板盖住整个窗口，包括中间栏 header、rail 控件与拖拽段——这才符合「全屏」语义。
- **让灯排**：`[data-sidebar-right-panel="fullscreen"] [data-dockkit-pane]:first-of-type [data-dockkit-strip]{padding-left:80px;}`——红绿灯（x≈16–70）下只压 strip 背景（非交互），页签从 x=80 起（与 rail 控件 `left:86px` 同标线）。分栏后有两个 pane 时只让第一个（`:first-of-type`），其余 strip 不加。锚点 `[data-dockkit-pane]` / `[data-dockkit-strip]` 是 dockkit 包的稳定数据属性（已核实：tab 是 `role="tab"` div，关闭是 `button`，均有 `data-dockkit-tab` / `data-dockkit-tab-close`）。
- **拖拽面**：面板 z-40 盖住 overlay（z-20），拖拽段在 fullscreen 下整体失效，因此把拖拽面直接交给页签条：
  ```
  [data-sidebar-right-panel="fullscreen"] [data-dockkit-strip]{-webkit-app-region:drag;}
  [data-sidebar-right-panel="fullscreen"] [data-dockkit-strip] :is(button, a[href], [role="button"], [role="tab"], input, textarea, [contenteditable="true"]){-webkit-app-region:no-drag;}
  ```
  strip 背景（空隙）拖窗；页签（role=tab）、关闭钮、控制钮 no-drag 正常点击。挖洞 reconciler 无需改动（段在面板之下，挖不挖都不影响命中；fullscreen 下段本就够不到）。
- **rail 控件取舍**：fullscreen 期间 rail 控件（侧栏开关/通知/新会话）与更新入口被面板盖住不可用——可接受：fullscreen 是专注态，退出走面板自己的「全屏/分栏/关闭」按钮；左栏在面板后面展开也无意义。不为其提升 z-index（层叠出不去 overlay 层，硬抬只能动 overlay 根，风险大于收益）。

### 非 fullscreen 模式

push/float 维持 rc.12 现状（top:0 顶到上沿 + 全文档挖洞）。rc.12 其余规则（首栏 padding、收起态 header 让灯排、分段拖拽条）全部不变。

### 变更与验收增量

- 变更仅 `titlebar.ts`：删 fullscreen top 规则、加两条 fullscreen strip 规则；`tests/titlebar.test.ts` 更新断言（断言不再有 fullscreen top 偏移、有 strip drag/no-drag 与首个 pane 让灯规则）。bridge 升 0.2.0-rc.13，AGENTS.md 发版条目同步。
- 验收在 rc.12 清单上改第 4 条并追加：
  4'. 右栏 fullscreen：面板盖住全窗（中间栏 header 不再露出）；页签条左端让出红绿灯；页签切换/关闭、分栏、退出全屏各钮悬停稳定且可点；页签条空隙可拖窗；分栏成两个 pane 后仅左侧 strip 让灯。
  4''. 退出 fullscreen 回 push：rc.12 第 3 条行为不变；rail 控件恢复。
