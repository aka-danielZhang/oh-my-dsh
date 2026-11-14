# 侧栏视觉语言统一（2026-10-28）

判断：侧栏的问题不是结构，而是视觉语言不统一（玻璃按钮、蓝紫材质、渐变发光 Quno 标、6px 版本徽章、hover 与选中几乎一样）。方案：**浅色冷灰纸面 / 深色石墨玻璃，雾蓝只作身份强调**。功能、导航、WorkspaceBrowser 行为不动。

## 本轮落地

### Quno 自有标识（本仓，已完成）

- `plugin/dsh-quno/src/client/quno-mark.tsx`：渐变圆盘 + 内高光 + 外阴影 → **纯色雾蓝圆盘 + 白色几何 Q + 极轻内描边**，无外阴影；data URI 同步（消息头像/欢迎/Hero/面板同源）。
- 主题 token：`--quno-mark-bg` / `--quno-mark-ring`，浅色 `#48669D`，深色 `#4E6DA4`（白 Q 对比度保持）；欢迎块不再传阴影。
- typecheck / build / 98 tests 通过。

### 共享侧栏视觉（fork worktree，首轮）

worktree：`../deepseek-harness-sidebar-visual`，分支 `feature/sidebar-visual`，提交 `7fb540e922`。

- `ui-theme/src/styles/design-platform.css`：新增/改定 sidebar 专用 token——
  - 浅色：fill `#F7F8FA`、elevated `#FFFFFF`、hover `#EEF1F5`、selected `#E6ECF5`、border `#DDE2E9`、text `#181B20`、muted `#626B77`、accent `#48669D`；
  - 深色：fill `#17181B`、elevated `#232529`、hover `#24272C`、selected `#293448`、border `#34383F`、text `#F1F3F6`、muted `#AAB2BD`、accent `#8EA9D2`。
- `ui-sidebar/SidebarRoot.module.css`：品牌 13/18/600、版本徽章 10/16/500 中性色（不再黑底白字）；新会话改为安静抬升控件（elevated + 1px 描边 + 发丝阴影，深色无阴影，去 darwin 白色玻璃覆盖）；固定行 hover/selected 分开并加 140ms 过渡。
- `ui-workspace/rows/Rows.module.css`：工作区 14/20/500、会话 13/20/400、时间 11/16 tabular、folder 用 accent、archived 用 muted、focus-visible 2px 环、`:focus-within` 显示行操作、搜索/selected 用 sidebar token。
- `WorkspaceBrowser.module.css`：搜索类 hover 改用 sidebar hover token。
- `prefers-reduced-motion` 下取消过渡。

## 未完成 / 阻塞

- 新 worktree 的完整构建被环境阻塞：`build:native-system` 找不到 Node-API headers（`~/.dsh-desktop/sidecar-node/.../DSH Node.app/Contents/include/node` 不存在）；`tsc -b tsconfig.client.json` 还缺 codegen 生成的 `ClientRemote` 声明（pluginMarket/pluginInventory/remoteAccess/directoryPicker 等，属于 fresh worktree 未 bootstrap）。这些是**环境问题**，不是 CSS 改动。
- 因此尚未产出验收截图矩阵（浅/深、展开/rail、hover/selected/focus、三种宽度）。
- 共享侧栏改动需要走 fork 运行时发布：`@crazx/*` 修改包发 `<上游版本>.zw.N` → fork tag `v0.2.1-rc.2+zw.N` → 本仓 `runtime/revision.json` 钉住 → 桌面发版。本仓 Quno 若依赖新 token，同版钉住该 runtime。

## 验收清单（待执行）

浅/深 × 展开/rail × work/Quno × hover/selected/focus × 搜索展开/菜单/拖拽 × 264/280/420px；正文对比度 ≥4.5:1；焦点环/图标 ≥3:1；选中保留 `aria-current`；行为回归（搜索/视图/新会话/菜单/固定/归档/拖拽/折叠/Quno 入口）。
