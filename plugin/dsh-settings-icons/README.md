# dsh-settings-icons

在 stock「设置」面板的左侧导航里，把 **使用统计** / **MCP 服务器** / **记忆** 三行原本共用的兜底齿轮，换成各自语义的线性图标。

browser-only，纯 DOM 装饰：不占 slot、不改设置壳、不动主题 token，卸载逐项还原。

## 为什么是 DOM 装饰

- stock `ui-settings-general` 的 `navIcon(id)` 是一张硬编码表，只认 `models` / `agent-presets` / `plugins`，其余 section 一律渲染同一个 `IconSettingsOutline16`；
- `settings.section` 的注册面只有 `id` / `order` / `label`，没有图标位。

所以插件能用的唯一杠杆就是装饰已挂载的那一行。本包把每一次写入都记录下来（`style` 原值、子元素 `display` 原值、标记属性），stop/卸载时精确还原。

## 行为

- **目标**：`usage-stats` → 三柱 + 基线；`mcp` → 双插脚插头；`memory` → 左右脑轮廓。三枚共用 16×16 viewBox 与 1.2–1.4px 圆头描边。
- **锚点**：读与设置壳**同源**的 `settings.section` ledger（`ctx.slots.getVersion` / `entries`，投影方式与 ui-settings-general 一致）拿到每个 section 的实时 `label`，再按文本匹配导航按钮。
- **fail-invisible**：label 读不到、或 nav 里没有对应文本的行，整条不画；绝不错画到别的行。面板关闭时不做任何事。
- **跟随主题**：图标是 data-URI `mask-image` 画在 stock 已挂载的 glyph 元素上，颜色取 `currentColor`，因此 hover、选中态与深浅色都由设置壳自己的前景色决定。
- **locale**：ledger 版本在注册/注销/locale 重注册时都会推进，标签随之重取，中英文都按当时的真实导航文本匹配（代码里没有任何硬编码文案）。
- **重绘**：glyph 元素被 React 换掉后由 MutationObserver 重画——标记打在 glyph 元素自身，而不是它的父按钮。重画在观察回调（微任务）内同步执行、先于浏览器绘制，因此每次打开设置面板**不会先闪一帧齿轮**；导航未挂载时扫描直接返回，行投影按 ledger 版本记忆，逐批次扫描成本可忽略。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-settings-icons
```

bundle patch 会为每个安装该插件的 profile 挂上 `dsh-settings-icons` 行。

## Client half

`lib/client.js` 是 ModuleLoader 闭包产物（`window.__ModuleLoader__.load`），**零 `@deepseek-ai/*` 值导入**：bundle 内没有任何 `require`，不需要 runtime peer 链接；`lib/index.js` 是空 host 半，只让 Loader 行合法。

## 不做的事

- 不改 `dsh-usage-stats` / `dsh-mcp-settings` / `dsh-ohmymemo` 三个包，也不 import 它们的实现符号（跨插件只走 slot 与 ctx 服务）。
- 不硬编码中英文导航文案，不按导航顺序（`nth-child`）定位。

## Design notes

- 决策记录：`docs/notes/2026-09-11-dsh-settings-icons.md`（仓根）
- 契约：仓根 `AGENTS.md`（插件 monorepo 规范、npm 依赖纪律、client bundle 构建契约）
