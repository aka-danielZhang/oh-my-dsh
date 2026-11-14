# Quno 胶囊改挂正文容器（2026-10-29）

胶囊此前注册在 `conversation.session.header.utilities`，因此必然出现在会话头右侧按钮行：这不是 CSS 错位，而是挂载点决定的。在 header 内继续用 absolute/fixed/负边距修补，会随侧栏宽度、右栏 Dock 和会话头高度漂移，浮层也可能被头部 stacking context 截断。本次改的是**挂载点**，不是坐标。

## 决策

1. **注册不动，DOM 换位**。仍注册 `conversation.session.header.utilities`（它提供 `sessionId`、preset 投影与会话级生命周期），但槽内只渲染隐藏 sentinel；可见胶囊用 `createPortal` 渲染到本会话的 `[data-conversation-content]`。该容器 `position: relative`、在会话头之外、包含滚动区与 composer，随左右栏和窗口自然变化。
2. **锚点校验（`capsule-anchor.ts`）**。从 sentinel 起：自身是否已在 content 内 → 最近的 `[data-slot="main.conversation"]` 内的 content → 逐级向上找；候选必须 `data-conversation-session === sessionId` 且不在 `[data-sidebar-right-session]` 内。拒绝右栏嵌入副本与其他保留会话；找不到就不渲染，不退回 header。
3. **定位**：`position: absolute; top: 8px; right: 12px; z-index: 6`；浮层 `top: calc(100% + 6px)`、宽 `min(300px, 正文宽 − 24)`、高 `min(420px, 正文高 − 64)`。不写 fixed 坐标、不读 `window.innerWidth`。
4. **显隐状态机（`view-model.capsuleVisibility`）**：`hidden-not-quno / no-face / no-content / no-anchor / right-panel / navigation / visible-collapsed / visible-flyout`。右栏按**当前 Session** 判断（`[data-sidebar-right-session="<sid>"][data-sidebar-right-open]`），并检测 `[data-dockkit-float]` 内的 `[data-quno-panel]`（保留挂载 ≠ 可见）；其他会话的右栏不影响本会话。
5. **点击即隐藏**：点行 → 关浮层 → `navigationHidden` 立即隐藏胶囊 → `openTab('qunoPanel', { params: { view } })`；右栏可见后由 `hidden-right-panel` 接管，关闭后恢复。`openTab` 抛错时恢复胶囊并显示非阻塞提示。
6. **浮层**：非模态 `role="dialog"`；点击外部/Escape 只关浮层，Escape 把焦点还给触发按钮；行内只显示计数与一条真实摘要；正文 < 480px 时胶囊退化为「Q 标 + 合计数字」，浮层仍完整；`prefers-reduced-motion` 关闭入场动画。
7. **清理**：会话切换、preset 变化、正文容器重建、插件卸载都清理 Portal、Resize/Mutation observer、document 监听与导航隐藏状态；无全局单例。

## 明确不做

- 不改 fork、不新增槽位、不新增 IPC；
- 不使用 fixed / 负边距 / 读取窗口宽度算坐标；
- 不把浮层做成 menu（行是普通按钮，Tab 顺序自然）。

## 验证

```sh
cd plugin/dsh-quno
pnpm run typecheck   # 通过
pnpm run test        # 134 项通过（新增 capsule-anchor 与胶囊状态机/摘要测试）
pnpm run build       # 通过
```

浏览器集成核对（真实组件 + 原生 DOM 接缝 + 主题 CSS，headless Chrome）：

- 胶囊不在 header 槽的可见 DOM 中；`[data-conversation-content]` 内存在胶囊根节点；
- 相对正文容器偏移 `top=8`、`right=12`；浮层宽 300px；
- 浮层 `role=dialog`，三行（任务·1／关注·2／动态·1 个异常）带真实摘要；
- Escape 关闭浮层且焦点回到触发按钮；
- 点击「关注」行 → `openTab('qunoPanel', { params: { view: 'attention' } })`，胶囊立即消失；
- 本会话右栏加 `data-sidebar-right-open` 期间保持隐藏，移除后恢复；
- 只有其他 Session 的右栏展开时，本会话胶囊不受影响。

已知边界：锚点依赖原生 `[data-conversation-content]` / `data-conversation-session` 属性；接缝若改名则胶囊不渲染（fail-open，不落回 header），契约见 `docs/quno-bot-design.md` §13.5。
