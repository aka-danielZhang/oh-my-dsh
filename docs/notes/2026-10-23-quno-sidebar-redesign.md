# 2026-10-23 Quno UI 交互改版：联系人式侧栏 + 右栏状态面板 + 任务卡联动

## 决策

按产品要求重做 Quno 交互面，落地为 `docs/quno-bot-design.md` §13 的全面重写：

1. **左栏改版**：占用 `sidebar.workspaces`（single/root，上游稳定槽）自绘「Quno / 会话」页签。Quno 页签下每个 Quno 是联系人式消息对象，点击 `ensureMain` → `openSession` 直接进唯一主对话；cwd 固定默认、用户不可见不可选。总开关关闭即 dispose，stock 浏览区原样回归。
2. **主对话铬件净化**：`conversation.session.header.utilities` 挂 null 渲染条目给 quno 主会话打 `data-quno-main` 标记，CSS 按 `[data-slot]` 接缝隐藏模型/权限/plan/hero workspace/preset 控件与面包屑；会话头 preset 标签以同 id + `priority: -1` 遮蔽（copy-session-id 先例），非 quno 会话渲染简易等价文本。
3. **右栏 Quno 面板**：`sidebarRightTabs.register` + keyed `sidebar.right.pane.tab`（ui-schedule 两段式先例），三视图「动态（Sense）/ 关注 / 任务」；进入 quno 主会话自动 `openTab('qunoPanel')`（「换掉右侧栏」语义）；push/fullscreen/float/折叠全吃 dockkit 原生能力。
4. **收起态胶囊**：`shell.overlay` 常驻小胶囊（dsh-thread 先例），仅在 quno 主会话在场渲染，实时显示运行任务数/待办事项数/Sense 健康点，点击展开面板。
5. **任务卡联动**：`quno_task` 卡片「打开」改为 `ctx.sidebarRight.openTab('qunoPanel', { params: { taskId, view: 'task' } })`（ui-schedule `openTaskDetail` 同款）；任务详情含实时日志（jobs Remote）与「查看完整子会话」入口，决策 7 的「默认隐藏、点击可见」闭环。

## 事实更正（重要）

旧 §13 依据的两个「事实」经源码核实不成立，已在 §13/§18（偏差 #11）更正：

- **`sidebar.workspaces.sessionListView` 槽在 fork 源码中不存在**——只以一份自称 implemented 的未合入 note 存在（`git log -S` 全分支无提交）；dsh-thread 与 dsh-quno 对该槽的注册均永不触发，Quno 侧栏入口**从未实际渲染**。发货运行时 FORK_MODIFIED 也不含 ui-workspace。
- **`registerMessageProjection` 不是 UI 通道**——它是 Host 侧把自定义事件投影为 LLM 可见消息的 seam（唯一在册消费者是 compaction-image-offload）；消息内联卡的实际通道是 `tool.call.toolview` 与 `conversation.chat.turnTail`。

## 关键取舍

- 占用 `sidebar.workspaces` 是**全局替换**：会话页签为自绘精简列表，首批明确缺口 = 搜索、工作区新建/连接对话框、行右键菜单、拖拽排序，后续按反馈补。
- 备选的 panellist + `main` keyed 面板（插件/自动化任务先例）风险最低，但 Quno 会成为「一页应用」而非「消息对象」，不选。
- Remote 增 `events.recent` / `tasks.list`；实时性升级路径为 typert stream，v1 用 15s 轮询不阻塞。

## 影响面

仅文档：`docs/quno-bot-design.md`（§13 重写、§15.1 验收增四行、§16 增「交互改版」项、§18 偏差 #11、§19 沿革）。无代码变更；实现排期属「交互改版」阶段。
