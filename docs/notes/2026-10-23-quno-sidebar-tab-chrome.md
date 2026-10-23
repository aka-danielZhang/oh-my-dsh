# 2026-10-23 Quno 侧栏页签样式与主对话铬件修订

## 修订

按产品反馈（参照分段 pill 页签截图）修订 `docs/quno-bot-design.md` §13，两点：

1. **主对话铬件保留模型选择器**（修订 `2026-10-23-quno-sidebar-redesign.md` 第 2 条的「全隐藏」口径，旧 note 不改写以本文为准）：Quno 主对话 = 正常对话框——模型选择器、权限、Plan、附件等 composer 常规件**全部保留**；只移除**工作区**（hero/空态选择器、面包屑工作区路径）与**模式**（agent preset 控件与标签）。「模式」界定为 agent preset；权限/Plan 属常规件。cwd/工作区/preset 的默认值由 `ensureMain` 与 `quno` preset 固定，模型默认固定但用户可在对话面改。
2. **页签条样式与新会话语义**：页签条为 fork WorkspacesRegion 渲染的 chrome（`sidebar.workspaces.alternate` 接缝），Quno 侧不自绘页签；样式规格（分段 pill、32px 行高、激活段抬升底色、与侧栏行几何/token 对齐、rail 态 W/Q 切换钮）作为 fork 侧验收项写入 §13.2。stock 新会话按钮（SidebarRoot，页签条之上）常驻不动，语义定稿为**只向 work 会话体系新增**；Quno 页签无新建入口；停在 Quno 页签创建会话后自动切回 work 页签（fork 侧验收项）。

## 影响面

仅文档：`docs/quno-bot-design.md`（§13.1 Quno 页签口径、§13.2 样式规格与新会话语义、§13.3 保留/隐藏表、§15.1 验收两行、§19 沿革）。无代码变更。
