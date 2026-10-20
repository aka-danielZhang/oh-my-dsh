# 右侧栏顶到顶（fork ui-layout）与余额胶囊弹窗不透明（provider-balance）

日期：2026-10-19/20。上下文：0.2.1-rc.2 基线升级收尾、fork zw 层首发前（`docs/harness-bump/0.2.1-rc.2/README.md`）。

## 问题 A：官方右侧栏顶到窗口顶，我们从工具栏下方起步

官方 0.2.x 客户端把右侧栏面板（`ui-sidebar-right`）绝对锚定在右栏列 `top:0` —— 官方没有工具栏行，列的顶就是窗口顶，所以面板一路顶到顶，收起时会话头 corner 位浮出展开按钮（`data-sidebar-right-expand`）。

fork 的 `shell.toolbar` 三行网格把三个列钉在 row 2，面板只能从 38px 工具栏下方起步——用户看到的"魔改"即此。展开按钮本身一直在（桥把会话头 end 集群 portal 进工具栏尾端），缺的只是面板的高度。

**改法（fork `ui-layout/AppFrame.module.css`，commit `fb98997c4b`）**：

1. `.toolbarRow` 由 `grid-column 1/-1` 改 `1/-2`：工具栏止于右栏左缘；右栏轨道收零时工具栏仍达窗口右缘。桥工具栏骑在 row 包裹层的 subgrid 上，车道零 JS 跟随。
2. `.rightbarCol` 由 `grid-row 2` 改 `1/-2`：面板锚到窗口顶（官方姿态）；工具栏座位空置时 row 1 高度为零，纯 web 姿态与上游布局恒等。
3. `.handle` `grid-area` 同步改 `1/1/-2/-1`：上游 `1/1/2/-1` 假设 row 1 是整个主轨，fork 的 row 1 是 38px 工具栏带——两条列宽 resize handle 一直只有 38px 高（本轮实测发现的隐性回归，非本次需求但同文件顺手修复）。

**不需要动桥代码**：面板绘制在 later-DOM 的定位列内且 z-index 10，天然盖过工具栏行；拖拽区在桥工具栏元素自身上，面板区域不可拖拽符合预期。

**验证**：CDP 实测面板 rect top 0（改前 39）、工具栏宽 770 = 面板左缘、handle 高 847（改前 39）；浅色截图确认接缝干净、面板自带 header。

## 问题 B：余额胶囊弹窗浅色模式半透明

根因：面板底色用的 `--dsw-specific-menu`，generic-web 姿态下解析为 `--dsw-menu-surface-fill = #f8f9fa94`（58% alpha）。设计体系里这个填充要配 `--dsw-menu-backdrop-filter` 背景模糊（MenuSurface 组件负责），接近不透明的 `rgba(248,249,250,0.94)` 覆盖值只挂在 `html[data-platform='darwin']` 上（官方桌面 preload 打标，我们的 Electron 壳按纯 web 走）。手写面板没有模糊层，58% 直接透字。

**改法（`plugin/dsh-provider-balance/client/client.js`）**：弹窗底色改实心 `#f8f9fa`（暗色 `[data-ds-dark-theme]` 下 `#303136`）——即 darwin 覆盖值/menu-group-header token 的全透明度等价色。不动全局平台标记：为一张弹窗把整个 shell 切到 darwin 姿态（侧栏振动模糊、透明 frame）代价远超收益。

**验证**：实启 computed background = `rgb(248, 249, 250)`（无 alpha 通道），截图确认文字全部清晰、无透字。

## 备注

- provider-balance 是裸源码分发（无构建步），profile 经 symlink 直连本仓 plugin 目录，源码即生效。
- 调查中发现但未处理：胶囊弹窗在 provider prop 身份变化时自动收起（`useEffect(() => setOpen(false), [provider])`），右栏动画期间状态churn 会立刻关掉弹窗——真实点击路径未见受影响，留观。
