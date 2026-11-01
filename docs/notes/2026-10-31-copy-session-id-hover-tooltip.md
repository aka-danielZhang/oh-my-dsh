# 2026-10-31 dsh-copy-session-id：原生 title 换插件自渲染 Tooltip

> 状态：**已实施并验证**（typecheck / node:test / tsdown build 通过）。只动 `plugin/dsh-copy-session-id`，不涉及 runtime、壳与其他插件。

## 现象与根因

「复制会话 ID」菜单项上悬浮提示一闪即逝，且鼠标无法移入提示框。排查确认菜单渲染、`:hover` 样式与遮罩均正常，根因在该项的原生 `title={String(sessionId)}`：

- `title` 提示由浏览器/Electron 自己管理，不是插件的 DOM 元素；
- 不可交互——鼠标一旦移向提示框就离开菜单项，提示随即消失；
- 显示时长与消失时机不受插件控制。

## 方案

移除原生 `title`，改为插件渲染、状态机控制的 Tooltip（`menu.tsx` + `tip-placement.ts` + `.dsh-csid-tip`）：

- `mouseenter`/`mouseleave`/`focus`/`blur` 驱动单个 `tipPending`（hide/null）状态，延时统一走插件已有的 `defer`（即 cordis `timer`），不引入裸 `setTimeout`；提示**即时显示**（与相邻菜单项的悬停高亮同拍），关闭宽限 150ms。初版曾加 250ms 悬停意图延迟防误触，实测快速划过时毫无反馈、体感「不好使」，改为即时。
- **保持范围是整个打开的菜单，且菜单内任何位置都触发显示**（真实输入日志定位后的第二版）：用户实测「闪一下就没」的根因是手停在复制项边缘（底边 81.8px 上下 77–89px 抖动），每次滑出项即触发 mouseleave→150ms 关闭；进一步日志显示指针落在菜单 padding 条上时命中的是菜单而非按钮，观感为「有的位置灵、有的位置不灵」。最终形态：menu 级 `onMouseEnter` 即时显示并取消待关闭、`onMouseLeave` 才武装关闭；复制项自身只保留 focus/blur 键盘路径。菜单内任何位置（items、边缘、padding、间隙、下载项上）都显示并保持，只有同时离开菜单与提示框超过 150ms 才关闭。
- 触发项与提示框作为同一悬浮整体：移入提示框取消待关闭计时，跨间隙不闪烁、可移入阅读。
- `createPortal` 渲染到 `document.body`，`position: fixed`，`z-index: 910`（veil 900 < 菜单 901 < **910** < 状态对话框 920）。
- 放置逻辑为纯函数 `placeSessionIdTip`（item 左侧、垂直居中、双轴 viewport 收敛），独立模块可测；放左侧是因为 item 上方是锚按钮、下方是下载项，两侧都会把可悬浮的提示压进鼠标路径。
- `role="tooltip"` + 触发项 `aria-describedby`（仅在提示挂载时输出），键盘 focus 即时显示、blur 走宽限关闭；`user-select: text` 允许直接选取长 ID。
- 菜单关闭即重置 hover 状态，避免下次打开闪现旧提示。
- 维持 client bundle 零 `@deepseek-ai/*` 值导入约束：`react-dom` 本就是 `CLIENT_EXTERNALS` 平台外部模块（与 dsh-quno 的 portal 先例一致），仅新增 devDep `@types/react-dom`。

## 落点

- `src/client/tip-placement.ts`（新增）：`placeSessionIdTip` + `TIP_GAP_PX`/`TIP_MARGIN_PX`。
- `src/client/menu.tsx`：移除 `title`；`SessionIdTip` portal 组件；hover 状态机两个 effect。
- `src/client/stylesheet.ts`：`.dsh-csid-tip` 规则。
- `tests/dsh-copy-session-id.test.ts`：放置纯函数 3 例 + tip 层级断言（介于菜单与对话框之间）。
- `package.json`/`pnpm-lock.yaml`：devDep `@types/react-dom ~18.3.7`。
- 包内 README 行为段与 client half 的 requires 清单同步。

## 验证

- `pnpm run typecheck`、`pnpm test`（含新增用例）、`pnpm run build` 全过；选择器命名空间守卫测试确认 `.dsh-csid-tip` 合规。
- 实机行为以 CDP 真实鼠标事件验证：悬停即时出现（实测 ~28ms）、菜单内扫动/边缘抖动不闪断、移入提示框保持、移出菜单 150ms 后关闭。

## 环境坑：desktop:dev 重链 peers 后插件独立 typecheck 假报错

桌面壳启动时会把 desktop-owned 插件的 `@deepseek-ai/*` runtime peers 重链进 `runtime/build/<sha>/dsh` 的 fork 层（启动日志 `skip runtime peer …`，避免插件在运行实例里解析不到同物理实例的 fork 包）。被重链的包（如 `dsh-client-ui-slots` → runtime 的 `@crazx/…zw.9`）携带 runtime 自己以 file: tarball 安装的 cordis，与插件 lockfile 的 registry `cordis@4.0.5` 形成**两个物理实例**——类型增强合并到 runtime 那份，插件 `index.ts` 的 `ctx.slots`/`ctx.timer` 因此假报 TS2339。pnpm 元数据视该状态为「已最新」，`pnpm install --force` 不会还原；需 `rm -rf node_modules && pnpm install` 回到 lockfile 态后再跑插件本地 typecheck/test。实机行为验证不受影响（壳重链态正是运行实例所需）。
