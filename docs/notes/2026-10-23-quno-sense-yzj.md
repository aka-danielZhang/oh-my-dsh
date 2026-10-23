# 2026-10-23 Sense 编写最小面定稿 + 云之家群聊 Sense 设计

## 决策

1. **Sense 编写最小面**：一个 Sense = 三个文件（package.json / cordis.patch.yml / src/index.ts）+ 一个 `pnpm pack` 压缩包；definition 只声明真实用到的字段，reliability 诚实报低合法，factory 只必需 `start(runtime)`。以 `dsh-quno-sense-feed` 为蓝本；`plugin:new --face sense` 模板列为演进项。落地为 `docs/quno-bot-design.md` §6.10。
2. **新增 `dsh-quno-sense-yzj`**：云之家群聊消息 Sense，poll 默认 10 分钟，经宿主机 `yzj-cli` 只读命令采集（`im message list` 的 msgId cursor 翻页）。设计全文在 `docs/quno-bot-design.md` §6.11。

## 关键判断

- **「基座无双向消息 API」阻塞解除**：yzj-cli 的 `im message list` 群聊历史包含自己发出的消息，「等你回复 vs 你已回应」可判；且凭据/登录态全由 yzj-cli 承担，Sense 不碰 token。桌面 sidecar 的 PATH 分层本就覆盖 yzj-cli 这类 host CLI（electron-shell-contract），打包态无额外配置。
- **可靠性声明诚实版**：`checkpoint: cursor`、`replay: bounded`（窗口未知）、`changeCoverage: sampled`（编辑/撤回不可观测）、`gapDetection: partial`——不按理想能力虚报。
- **建基线不回放历史**：首轮 `type newest` 只钉游标，符合订阅语义「从现在开始」，避免首装即事件洪水。
- **明确不做**：不发送消息、不标已读、不采私聊（v1）、不承诺实时（poll 10min × 三种节奏）。

## 影响面

仅文档：`docs/quno-bot-design.md`（§6.10/§6.11 新增、§16 阶段 B 注记、§19 沿革）。`dsh-quno-sense-yzj` 待实现；实现时按 §6.10 最小面 + `plugin:new` 脚手架起手，验收走 Sense 接入门禁 S01–S14（§15.3）。
