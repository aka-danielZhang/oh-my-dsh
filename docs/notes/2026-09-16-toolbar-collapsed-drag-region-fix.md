# 统一 toolbar 收起态无法展开：drag 区盖住 no-drag 控件簇（2026-09-16）

## 现象

用户报告（0.3.1-rc.6 安装包，macOS）：左上角收起/展开按钮点击收起后，再也无法展开。状态机本身健康——`ctx.layout.toggleSidebar` 双向翻转、rail hider observer 对 `data-sidebar-collapsed` 的响应、React 对 inline grid-template 的回写全部正常（CDP 驱动 DOM 点击可反复收起/展开）。

## 根因

两层命中问题叠加：

1. **CSS 层（真根因）**：收起态下首轨道被 rail hider 归零，`[data-desktop-toolbar-main]`（`grid-column:2/-1`）的盒子从 x=0 铺满整行工具栏。它没有显式 region，从 toolbar 根**继承** `-webkit-app-region:drag`；而 `-webkit-app-region` 的区域组合按绘制顺序生效——DOM 在后的 drag 盒子会盖住 DOM 在前的 rail 按钮 `no-drag!important` 洞。展开态 main 盒从会话列边（≥264px）起步、不覆盖控件簇，所以「展开→收起」永远可点；收起态盒子左缘为 0、盖住 86px 灯区后的整簇控件（toggle/更新/通知/新会话），原生鼠标按下被浏览器进程当窗口拖拽吞掉，点击事件根本不进页面。此形态在本仓有先例：0.2.0-rc.14 时代 update-indicator 的「28px 拖拽条偷走 no-drag 按钮点击」。
2. **验证层（为什么没拦住）**：
   - e2e 探针的收起循环用 `element.click()`（合成 DOM click），CDP `Input.dispatchMouseEvent` 同理——都不走浏览器进程的拖拽区命中测试，对这类回归结构性失明（实测：CDP 按住工具栏拖拽区拖动，窗口不动，证明注入事件绕过 OS 拖拽管线）。
   - 探针在进入收起循环**之前**就死于过时断言 `buttons.length >= 4`：rc.18 起 `UpdateControl` 无更新态渲染 null，常驻按钮只有 3 枚，探针自 rc.18 后从未跑到收起循环；rc.4–rc.6 的发版验证又只覆盖 sidecar 启动（typert/Electron 指纹事故挤占了注意力），无一带真实指针的实机点验。

## 修复

- `rail.ts`（bridge 0.2.0-rc.20）：收起态避让 `padding-left:176/204px` → `margin-left:176/204px` + `padding-left:0`。内容几何逐像素不变（margin 与 12px 基础 padding 相加等价旧值）；`transition` 同时列 margin-left/padding-left（同曲线同时长，总避让的动画与旧单 padding 滑动完全一致）；关键不变量：**main 盒左缘（176/204）≥ 控件簇右缘（168/196），drag 盒子不再覆盖任何 no-drag 洞**——此修法与区域组合语义（按序覆盖抑或 no-drag 恒优先）无关，任何实现下都成立。
- 探针（preload.cjs）：按钮数断言改条件化（≥3 且必须含侧栏开关，更新按钮按条件渲染不再强制）；收起循环新增几何断言（收起态 main 盒左缘 ≥ 控件簇右缘，违例报错文案直指 drag 覆盖类回归）与 toggle computed `webkitAppRegion === 'no-drag'` 断言——这是合成点击够得着的最大代理不变量。
- 单测（rail.test.ts）：收起避让断言改 margin 形态，并加负向断言禁止 `padding-left:176/204px` 回潮（附回归说明）。

## 遗留

- 合成输入永远测不到原生拖拽命中；后续若引入 Playwright `_electron`（其点击同样绕过）也无解，只有真实指针（人工点验或带辅助权限的 HID 注入）可验此类回归。发布 runbook 的实机点验清单可考虑加一行「收起→展开」。
- 待发桌面版（desktop-owned 插件变更按硬规则需发 `v*`）携带 rc.20。
