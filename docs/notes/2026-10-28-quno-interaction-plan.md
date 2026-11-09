# Quno 交互方案收敛（2026-10-28）

按用户 2026-10-28 的设计方案收敛实现。原则：不改 AgentLoop、不新增 Quno 业务 IPC、不重写 WorkspaceBrowser、默认不改 fork/SQLite；只有「独立居中 Hero」或「富状态原生侧栏行」才单独立项。

## 结构变化

1. **设置收敛为单页表单**（同日二次修订）：无内部页签；基本/通知/角色与模型/感知来源/高级五个分组 + 底部主对话行；删除设置里的 `AttentionTab / RunsTab / TasksTab` 分支与「立即检查」按钮。字段级自动保存（串行、最小 patch、失败保留草稿）。
2. **右栏四视图**：`QunoPanelView = 'sense' | 'attention' | 'task' | 'runs'`；运行视图承载分析运行（思考）与通知列表 + `checkNow()`，与任务列表分开。
3. **胶囊回会话头工具区**：`conversation.session.header.utilities` 行内胶囊 + 概要浮层；删除 2026-10-27 的 fixed 浮位测量与回退。
4. **首开回 Hero 接缝**：恢复 stock headline / 鱼标 / 工作区选择，Quno 欢迎块只占 `conversation.hero.options`；不隐藏 headline、不做 slot 与 composer 的中心对齐。逐像素居中另立通用 Hero 接缝议题。
5. **证据可读性**：`EventWire` 补 `sourceId`；近期事件行与关注证据按来源 `reliability.readOriginal` 与 `pruned` 门控，不可读时只展示摘要/quote 与血缘；`eventDetail` 已在 `pruned` 时只给索引。
6. **主会话默认工作区**（2026-10-27 末补充，保留）：`ensureMain` 接受 `workspaceId`；客户端取侧栏第一个工作区，Host 端回退 `workspaceRegistry.list()[0]`，再退 cwd。composer 因此不再停在 inert 的「选择一个工作区开始」。

## 已符合、未改动的方案项

- 向导：`shell.overlay` 三栏 Modal，设置·来源与右栏「＋接入」共用一个控制器；脏表单关闭确认。
- 汇报卡：按 Turn 绑定 `notificationId`，`noticeDetail` 按需读取；不用「最近一小时」匹配。
- 任务：`plan` 只静态展示；子会话只读执行权限；取消幂等且晚到结果不覆盖 `cancelled`。
- Sense：`state()` 下运行模式/五项可靠性/权限/配额；`probeSense` 只探测；`senseOptions` 字段级发现；原始 checkpoint 与密钥不下发。
- 刷新：15 秒共享轮询 + 命令后刷新；通知/事件/任务活动按需有界缓存。
- 样式：皮肤限 `[data-quno-main]`；`--dsw-* / --quno-*` token；平台 Modal/React/ui-primitives。

## 验收

- 设置恰好「配置 / 来源」两页签（实测 `["配置","来源"]`）。
- 右栏 tab 条实测 `["动态","关注","任务","运行"]`；「立即检查」只在运行视图。
- 胶囊在会话头，点击出路层三行，面板展开后退场。
- 97+ 单测、typecheck、build 通过（`plugin/dsh-quno`）。
