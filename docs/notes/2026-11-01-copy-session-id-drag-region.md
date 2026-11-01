# 2026-11-01 dsh-copy-session-id：复制行 hover 闪断的真根因是 macOS 拖拽区覆盖

> 状态：**已实施并验证**（typecheck / node:test 9 例 / tsdown build / `git diff --check` 通过）。只动 `plugin/dsh-copy-session-id`，不涉及 runtime、壳与其他插件。本 note 修订 `docs/notes/2026-10-31-copy-session-id-hover-tooltip.md` 的结论：tooltip 方案作废，10-31 的排查记录保留作历史。

## 现象与真根因

「⋯」菜单的「复制会话 ID」行 hover 高亮一闪即逝、持续悬停保持不住，点击像点到背后窗体（失焦、偶发触发窗口拖拽）；末位的「下载 Session 日志」行一切正常。10-31 曾按「原生 `title` 提示闪断」处理并实现了插件自渲染 tooltip（见 10-31 note），但 tooltip 是在治症状——真正的根因与悬停提示无关：

**Electron 的 app-region 命中几何按文档序（绘制序）合成，后绘的 `drag` 矩形盖掉先绘的 `no-drag`**（与 bridge 0.2.0-rc.20 收起态修复同一规律，见 `docs/notes/2026-09-16-toolbar-collapsed-drag-region-fix.md`）。菜单原先内联渲染在 session header 内，darwin 顶部标签条拖拽带的 `drag` 矩形在文档序中位于其后，正好盖回菜单首行（复制行）——指针事件被窗口拖拽层吞掉，hover 与 click 都到不了 DOM。下载行是菜单最后一笔，其 `no-drag` 恰为该区域末态，故不受影响。

## 方案

菜单与点击遮罩 `createPortal` 到 `document.body`（10-31 的 tooltip 已建立 react-dom portal 先例，`react-dom` 本就是 CLIENT_EXTERNALS 平台外部模块）：

- body 层的 `no-drag` 盒成为文档序最后一笔，任何后续 in-root `drag` 矩形都盖不到它；两行菜单项的 Electron 区域恒为 `no-drag`。
- 菜单改 `position: fixed`：`top = rect.bottom + 6px`、右缘对齐锚点；`useLayoutEffect` 打开即定位（首帧 `visibility: hidden` 防闪位），rAF 循环跟踪锚点（侧栏拖宽不触发 window resize）。
- 顺带移除复制项的原生 `title`：悬停反馈统一为行高亮，与下载行一致（2026-10-31 的 tooltip 实验代码整体不保留）。
- 零 `@deepseek-ai/*` 值导入约束不变，bundle require 面为 `react` / `react/jsx-runtime` / `react-dom`。

## 落点与版本

- `src/client/menu.tsx`（portal + 定位）、`src/client/stylesheet.ts`（fixed 定位）、包内 README（行为与 requires 清单）。
- `package.json` / `pnpm-lock.yaml`：devDep `@types/react-dom ~18.3.7`。
- 版本 0.1.0 → 0.1.1，`dsh.desktop.ship.pin` 同步；desktop-owned 插件，随 Desktop `v0.4.0-rc.7` 交付，沿革见 `docs/plugins-catalog.md`。

## 验证

- DevTools 逐元素扫 Electron 区域：复制行与下载行最终区域均为 `no-drag`；菜单 `parentElement === BODY`。
- 实机：复制行持续悬停 2s 高亮保持，点击即复制、不再失焦；侧栏拖宽后菜单位置跟随。
- `pnpm run typecheck`、`pnpm test`（9 例）、`pnpm run build`、`git diff --check` 全过。
