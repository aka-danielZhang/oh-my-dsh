# 2026-10-23 Quno 对话面皮肤标准 + 对话内胶囊

## 决策

按产品反馈（右栏不应自动展开、胶囊应在对话框内、对话面要有 Quno 自己的风格与头像）修订 `docs/quno-bot-design.md` §13：

1. **右栏默认收起**：移除「进入 quno 主会话自动 openTab」的 watcher 语义；面板打开入口只有两个——对话内胶囊与任务卡点击（§13.4）。
2. **胶囊迁入对话框**：从 `shell.overlay` + `position:fixed`（不随对话列、右栏展开时错位）迁至 `conversation.input.dock`（list/session，composer 卡上方整宽行，随列宽、永不被右栏盖住）；行内右对齐胶囊形态，无内容时行塌陷（§13.5）。
3. **Quno 对话皮肤**（新 §13.8/§13.9）：身份三件套——消息头像（`[data-quno-main]` 下 `data-chat-flow-kind="assistant-step"` 的 CSS `::before`，28px + 流式呼吸）、会话头身份（`conversation.header.leading`，显式 priority:-1，非 quno 渲染 null）、首开欢迎块（`hero.options`）。卡片统一规格与 token 作用域规则入 §13.8；组件清单、QUNO_SKIN_CSS 结构、实现期 delta 入 §13.9。
4. **不整体接管对话框**（对「可能不能沿用 DSH 对话框」的正式回答）：三条接管路径（chat.node 遮蔽 / conversation.session 接管 / composer chain 接管）逐一评估并否决——纯度门禁止复用 stock 渲染组件、带 children 的 single 槽遮蔽后 dispose 不可恢复（releaseChildren 无引用计数）、`renderSlot` 有调用方授权。皮肤化是唯一严肃路径；深度接管的前提是 fork 先解决子槽释放语义。

## 勘误（随本次一并落实）

- `conversation.empty.workspace` 槽在本基线不存在——旧 §13.3 与 QUNO_CSS 中该选择器为死代码，实现期删除（§13.3 勘误条）。
- QUNO_CSS 现行隐藏 `conversation.input.model/permission/plan` 的规则与「保留 composer 常规件」口径冲突，实现期移除（§13.3/§13.9）。

## 影响面

仅文档：`docs/quno-bot-design.md`（§13.1/§13.3/§13.4/§13.5 修订，§13.7 总表更新，§13.8/§13.9 新增，§15.1 验收行更新，§19 沿革）。代码 delta 已列入 §13.9「实现期修正项」。
