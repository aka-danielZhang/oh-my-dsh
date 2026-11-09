# 2026-10-23 Quno 消息头像改占列首行槽，与复制按钮分轴

## 裁定（二次，取代首轮口径）

首轮落地按「头像左缘对齐复制按钮左缘」实现（`left: calc(-1 * var(--quno-avatar-hang))`，hang=6px，恰好抵消 stock 动作行的 `margin-left: -6px`），结果头像正落在复制按钮正上方。用户两次反馈后明确：头像应在**消息气泡之外**、且在**复制按钮垂直线的左侧**——即两者必须分列两轴，不是同轴对齐。

## 落地（QUNO_CSS 块 1 与安静对话页 7.7）

- **头像行槽 0..26px**：`::before` 的 `left` 由 `calc(-1 * var(--quno-avatar-hang))` 改为 `0`，删除已无第二使用者的 `--quno-avatar-hang`；头像不再悬出列缘，与正文留 10px。正文 indent 36px 不动（与输入框列对齐是红线）。
- **动作行随正文缩进**：新增 `[data-quno-main] [data-turn-tail] { padding-left: var(--quno-avatar-indent); }`。stock `.actions` 自带的 `-6px` 与按钮自身 6px 内边距互抵，图标左缘落回正文左缘 36px；按钮盒左缘 30px，恒在头像右缘 26px 右侧。
- **接受的副作用**：`conversation.chat.turnTail` 槽内的 Quno 主动汇报卡随 root padding 左缩 36px，与正文左对齐（原贴列左缘）。
- **fail-open 口径不变**：两处锚都是 stock 属性（`data-chat-flow-kind` / `data-turn-tail`）与按钮盒几何，stock 改内边距或行距时最坏是重新贴紧几像素，不产生遮挡。

## 几何（800px 列，CSS px）

头像 0–26｜按钮盒 30–58（图标 36–53）｜正文左缘 36。

## 验证

`pnpm run typecheck` 与 `pnpm run build` 通过，`lib/client.js` 含两条新规则；视觉效果以重载窗口后实机为准。设计文档同步：`docs/quno-bot-design.md` §13.8 消息头像条、§13.9 第 7 块、§15.1 对话皮肤验收行。
