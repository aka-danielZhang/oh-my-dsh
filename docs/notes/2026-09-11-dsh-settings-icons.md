# 设置导航图标：为什么是 DOM 装饰，以及怎么锚定

日期：2026-09-11
插件：`plugin/dsh-settings-icons`（0.1.0，browser-only）

## 需求

设置面板左侧导航里，**使用统计** / **MCP 服务器** / **记忆** 三行都显示同一个兜底齿轮，与各自语义无关，视觉上也分不出彼此。要求换成三枚「好看、且一眼能认出是什么」的图标，并在创造模式里先看效果。

## 关键约束：stock 设置壳不提供图标位

两个事实决定了实现形态（源码：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`）：

1. 导航图标由壳按 **section id 硬编码**：

   ```ts
   function navIcon(id: string) {
     if (id === 'models') return <IconDataOutline16 … />
     if (id === 'agent-presets') return <IconAgentPresetOutline16 … />
     if (id === 'plugins') return <IconPersonalizationOutline16 … />
     return <IconSettingsOutline16 … />   // ← usage-stats / mcp / memory 都落这里
   }
   ```

2. `settings.section` 的注册选项只有 `id` / `order` / `label`（见 `Slots.listSubTree` 的 `selected.catalog.registration`），**没有 icon 选项**；`SlotRegistry.entries()` 虽是公开读面，但它是只读投影，改不了壳的渲染。

因此「把图标放上去」只有三条路：

| 方案 | 结论 |
|---|---|
| 改 fork 的 `ui-settings-general`，给 `settings.section` 加 `icon` 选项 | **否决**。为一个纯视觉需求改 fork 源码并重发 zw 层，波及面远大于收益；与本仓「能不改 fork 就不改」的既有取舍不一致 |
| 三个插件各自装饰自己那一行 | **否决**。`dsh-usage-stats` / `dsh-mcp-settings` / `dsh-ohmymemo` 都在随桌面发货清单里，三处复制同一套观察器与图标表，跨插件又不能 import 彼此实现，三份漂移是迟早的事 |
| **一个 browser-only 插件统管三行（采用）** | 单包、单份图标语言、单处卸载还原；与 `dsh-provider-balance` / `dsh-model-image-input` 同属「装饰 stock 设置界面」的既有姿势 |

## 锚定：用 ledger 标签，不用顺序

装饰 DOM 的第一个问题是「怎么确定这是哪一行」。候选锚点与取舍：

- **`nth-child` 顺序**：创造模式预览阶段用过（`nav > div:last-child > button:nth-child(3)`），能用但只对「当前已装插件集合」成立；任何插件增减 section 都会错位，而错位是**静默画错行**。否决。
- **硬编码中英文文案**：文案改一次就失效，且要维护两种语言。否决。
- **读同一份 ledger，按 label 文本匹配（采用）**：壳的导航行就是

  `entries('settings.section').map(e => ({ id, order, label: resolveSlotLabel(e.options.label) }))` 投影出来的，本插件用**同一个 `ctx.slots` 读面**取同样的 `id → label`，再在 nav 里按 `textContent` 精确匹配（两侧都 trim）。前提与壳完全同源，所以：

  - section 没装 → ledger 里没这个 id → 跳过；
  - 导航文本与注册标签不一致（壳改版）→ 匹配不上 → **整条不画**（fail-invisible），绝不错画；
  - locale 切换 → 插件重注册 → ledger 版本推进 → 标签重取，中英文都按当时的真实文本匹配（代码里零硬编码文案）。

  匹配还带 `claimed` 集合，两个 section 撞文案时不会双画同一行。

## 绘制：mask 而不是换节点

glyph 是 React 渲染的 `<svg>`。**不替换节点**（会打乱 React 的位置型 reconcile），改为：

- 在已挂载的 glyph 元素上写 `background-color: currentColor` + `mask-image: url("data:image/svg+xml,…")`（前缀 `-webkit-mask-*` 与非前缀两套都写——旧 Chromium/WebKit 只认前缀版）；
- 用它自己的子元素（stock 的 `<path>`）设 `display="none"` 藏起来；
- 颜色走 `currentColor`，所以 hover / 选中态 / 深浅色**自动**跟随设置壳，插件不碰任何 theme token；
- 标记 `data-dsh-sicons="<id>"` 打在 **glyph 元素自身**：React 一旦换掉该元素（新一轮 render 或缺省分支变化），标记随旧节点消失，下一次扫描自动重画；若只打在其父按钮上，就会出现「父节点还在、样式已被换掉、于是再也不重画」的静默失效。

写盘记录 `style` 与每个子元素 `display` 的原值，卸载/stop 时逐项还原——包括把 React 中途换过的旧节点的记录剪掉（`isConnected` 判定）。

## 图标本身

三枚共用 16×16 viewBox、圆头圆角描边、无填充、无自带颜色，按用户逐轮反馈收敛：

- **使用统计**：三根递增柱 + 一条基线。第一版带柱体边框 + 趋势折线，在 16px 下元素过多，收敛成 4 条线。
- **MCP**：一枚独立插头（双插脚 + 圆角插头体）。第一版画成「插头接端口 + 连接线」的拓扑，像接线图；第二版去掉线，只留插头本体。
- **记忆**：左右脑轮廓 + 中缝 + 每侧两条脑沟。刻意不用数据库圆柱（`IconDatabaseOutline16` 已被「记忆」页内部复用，做导航图标会与页内语义打架）。

三枚同为一套 mask 数据 URI，源码里以可读 SVG 书写、运行时 `encodeURIComponent` 编码，避免手写百分号编码不可审。

## 验证

- `pnpm run typecheck` / `pnpm test`：9 个 node:test + jsdom 用例覆盖投影、按标签匹配、只画命中行、后挂载重扫、React 换节点后重画、ledger 缺失时不画（fail-invisible）、版本记忆（ledger 未变不重复投影）与卸载精确还原。
- 发布前用创造模式在同一套真实 DOM 上验收过三枚图标的实际观感（先按顺序锚点验证视觉，再落成按标签锚定的正式实现）。

## 未做

- 不覆盖 `models` / `agent-presets` / `plugins` 等其他分区（壳已有各自图标）；扩展新目标只需往 `NAV_ICON_TARGETS` 加一项。
- 不做桌面门控：终端 `dsh web`、浏览器、桌面壳同一条路。
