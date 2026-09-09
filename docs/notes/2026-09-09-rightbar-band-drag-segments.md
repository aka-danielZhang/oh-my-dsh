# 右侧栏绝对面板 × 顶部拖拽带：分段拖拽条与面板下移

2026-09-09 · dsh-desktop-bridge 0.2.0-rc.11

## 问题

桌面端（macOS 隐藏式标题栏）更新到 runtime 0.1.5-alpha.1 后出现：

1. 右侧栏（dockkit 面板）停靠时，其页签条上的控制按钮（向右分栏/全屏显示侧栏/收起侧栏/关闭）**悬停高亮闪失、点击被吞**——稳定复现；
2. 右侧栏最大化时，页签头整体压在左上角**红绿灯下**（丑且同样不可点）。

## 根因（实机 DOM 证据）

- 0.1.5-alpha.1 的右侧栏面板是**绝对定位**表面：`div.panel[data-sidebar-right-panel="push"]`，`position:absolute; top:0; inset:0 0 0 -<w>px`，相对于零宽的 `rightbarCol` 定位。栏目的 `padding-top:28px`（标题带预留）只影响常规流内容，**管不到绝对定位面板**，所以它的页签条（`[data-dockkit-strip]`）落在 y≈1–38 的标题带里。
- 桥插件的窗口拖拽面是一条 1920px 整宽透明条（`shell.overlay` 条目，`-webkit-app-region:drag`），overlay 层 z-20 压在所有栏目之上。带内按钮在 CSS 命中测试里就落在拖拽条上，OS 层面该区域又是拖拽区：悬停被拖拽判定抢走（高亮闪失），点击被当成拖窗口（点击失灵）。
- 最大化时面板 `left` 归零、页签头到左上，撞红绿灯。
- 浏览器端没有拖拽条，所以只在桌面端出现。

## 否决的方案（都实机验证过）

- **按钮级抬升**（`position:relative; z-index:30; no-drag`）：按钮处于各自的层叠上下文里，z-index 30 出不了局部上下文，仍被 overlay z-20 压住——命中测试依旧落在拖拽条上。
- **栏目自身拖区**（栏目 `drag` + 直接子元素 `no-drag`）：Chromium 的拖拽区计算未按预期扣除子树，整个窗口变成拖拽区，全局不可点。已回滚。

## 方案

1. **分段拖拽条**（`src/client/drag-strip.ts`）：不再铺整宽条。reconciler 量出 `[data-sidebar-right-panel]` 内与顶部 28px 带相交的可交互元素（button/a/[role=button]/[role=tab]/input/textarea/contenteditable；跳过 hidden/opacity 0），矩形外扩 6px、合并、对视口宽度取补，得到空隙段；每段一个 `data-desktop-drag-seg` div（`pointer-events:auto` + `app-region:drag` + 归档 Tauri 的 `data-tauri-drag-region`），<12px 的碎段丢弃。宿主 div 本身 `pointer-events:none`，按钮上方从此没有覆盖物。变更监听：body subtree MutationObserver（100ms 防抖）+ resize + 2s 兜底轮询；卸载全量回收。
   - 洞只给右栏面板挖：会话滚动区里被裁剪的内容（如滚动到顶部的卡片按钮）虽然几何上可能压带，但不可命中，不该占洞。
2. **面板下移**（`titlebar.ts`）：`[data-sidebar-right-panel]{top:28px!important}`（!important 压过内联 `inset` 的 top:0），bottom 不变所以高度自然收缩 28px。停靠/浮动/最大化各模式下页签头都让出标题带，与三栏内容顶边齐平，最大化时也不再撞红绿灯。
3. 整宽 `desktop-drag-strip` 条删除，组件改为只渲染宿主 div、经 slot `inject` 闭包把节点交给 apply 世界的 reconciler（组件不做订阅机械）。

## 边界

- 锚点 `[data-sidebar-right-panel]` / dockkit 数据属性是右侧栏包（dsh-client-ui-sidebar-right，不进 fork 源码树）的稳定数据面；其结构变更需同步本模块（与 rail.ts 的 nth-child 锚点同性质）。
- 面板滑入滑出动画期间洞随矩形移动，100ms 防抖 + 2s 轮询收敛；动画中间态洞略偏但无功能影响。
- 归档 Tauri 壳经段上的 `data-tauri-drag-region` 保留空隙拖拽。
- 未来若有别的绝对定位面板进标题带，需在 `BAND_PANEL_SELECTOR` 登记其锚点。

## 验证

- `tests/drag-strip.test.ts`：区间合并/裁剪/最小握持宽度；`tests/titlebar.test.ts`：分段 CSS 与面板下移规则断言。98 全过。
- 实机动态插件 POC（同算法）命中测试：带内 7 个按钮 elementFromPoint 全部从「落在拖拽条」翻为「落在按钮自身」；用户确认按钮悬停/点击恢复、窗口拖拽保留。
