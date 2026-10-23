# 2026-10-23 Quno「连成一体，安静对话」视觉落地

## 决策

按用户提供的视觉提案（「连成一体，安静对话」，源文件 `~/.codex/visualizations/2026/10/23/01a16789-ae9c-78d2-ba12-08afc006ea07/quno-design/`，含 Quno-design-proposal.md 与两张设计图）落地 Quno 视觉，全部在 dsh-quno 皮肤作用域内实现，不新 fork、不改 stock 组件。落地中途用户两次纠偏：

1. **页签方案否决（四次修订）**：先做了 work/Quno 页签 → 提为首分区 → 又做成「两个面板」（commit 3febd942/4d61fc63）——用户最终裁定「不用搞这个页签了，直接在自动化任务下面加一个按钮即可」。页签与两个面板全部回退（alternate 视图、`data-quno-side` 声明权、皮肤第 7/9/10 块删除），侧栏回归 stock 原样。
2. **Quno 入口 = 原生面板行**：`main` 槽注册 `quno-entry` 页 + `sidebar.panellist` 同 id 条目（order 30，排在自动化任务之后），壳自持按钮/标签/选中态，样式天然协调。注册的页面是**交接页**而非目的地：挂载即 `ensureMain()` → `openSession()` → `selectPanel(null)` 切回对话视图；总开关关闭时行随门控整体消失。
3. **安静对话页**（QUNO_CSS 第 7 块，`[data-quno-main]` 作用域）：头部收敛一行（会话标题行退场，「对话/轨迹」右移与身份同行）；头像缩至 26px、连续输出与工具过程后不重复插头像；已完成过程行退场（`:not(:has([data-chat-running]))` 保住运行中状态），回复组以 24px 上间距分区；用户气泡冷灰（`--dsw-specific-bubble` 作用域覆盖）；消息列与输入框统一 `min(800px, 100%)` 居中；发送钮雾蓝 `#48669D`；调色板 `--quno-*` 暗色双写。
4. **回复底部只留复制与用量**：赞/踩/分支按钮退场（按 stock aria-label 中英双字典值隐藏，fail-open）。第一版复制钮文字标签竖排、图标被压扁——修正为保持 stock 图标盒、放宽为「图标 + 文字」横排（`width: auto` + gap，不断开图标）。

## 未落地（如实记录）

- **回复首部名字标签**：mock 中头像旁的「Quno」名字因 chat 流的分组虚拟化（reasoning group 包裹、伪元素不渲染）无法用纯 CSS 稳定挂到每轮首段，需要 fork 座位或上游 hook；本轮以头像承担身份标记。
- **「对话/轨迹」140ms 指示线平移、右栏 220ms 平移淡入**：stock 组件自有行为，皮肤不接；两视图滚动位置保留为 stock 既有能力。
- **右栏 320–360px 宽度与窄窗覆盖抽屉**：stock 右栏自有尺寸体系，未动。

## 影响面

`plugin/dsh-quno/src/client/ui.tsx`（QUNO_CSS 第 7 块：调色板 + 安静对话页；页签/面板/动效块删除）、`entry-panel.tsx`（新：交接页 + 行图标）、`index.tsx`（门控面：alternate 注册替换为 `main` + `sidebar.panellist`）、`locales.ts`（删 alternate 专属孤儿键）、`docs/quno-bot-design.md`（§13.2 四次修订、§13.8 二次修订、§13.9 结构、§15.1、§19）。实机验证：入口行原生协调、点击直达主对话、复制钮图标+文字、work 侧栏原样；typecheck 干净、84/84 测试、构建通过。
