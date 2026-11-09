# Quno 视觉对齐交互稿（2026-10-27）

对照 `quno-ui-spec.html`（v1.0，s01–s09）把 Quno 自有表面收敛到稿子的视觉规格；记录已对齐项、稿子与真实接缝的差异，以及唯一需要 fork 的剩余项。

## 已对齐

- **品牌 Q 标**：渐变圆盘 + 几何 Q 环，统一用于侧栏入口 glyph、会话头身份、首开欢迎、面板标题与消息头像（CSS 用同一 SVG 的 data URI），尺寸 14–46px。
- **卡片规格**（汇报卡 / 任务卡 / 面板卡）：16px 圆角（面板 10px）、1px 边框、左缘 3px 状态条；头部「标签 · 标题 · 时间/状态」；正文 14px/1.7（面板 12px）；来源 chips；动作行右对齐。
- **汇报卡**：标签、主题、时间、正文、来源 chips（由关联事项的 topicKey 映射为 日历/订阅源/云之家群聊/委派任务）、逐事项操作行；过期态显示「已过期」并隐藏操作。
- **任务卡/任务详情**：状态条随 running/done/failed/interrupted 变色；计划、指令、结果、产物 chips、取消/续跑/子会话入口。
- **面板**：标题带 Q 标；关注事项卡带状态 chip（进行中/等待/已延后/已完成/已过期）、摘要、来源 chip、证据 chip；Sense 详情改为「头部卡 + 状态/覆盖能力/缺口/配置/首轮/权限/新鲜度」分区与 kv 行；`auth-required` 显示 yzj-cli 登录卡。
- **胶囊**：会话头右上工具区的一枚胶囊（按 2026-10-28 方案回调，不再浮在消息列右侧），点击出概要浮层；三行分别显示任务/关注/来源的具体条目与数量，底部提示「点击明细行 → 右栏面板展开对应视图」。
- **程序消息去重**：`quno-notify` / `quno-task` 的注入消息在 Chat 目标上用 `exclusive` 认领，不再渲染成用户气泡；汇报卡就是它的可见形态。
- **首开**：保留 stock headline 与 composer（稿子 §s01 也保留，并注明「已知残留」），只把 Quno 欢迎块换成品牌标与稿子字号。

## 与稿子/真实接缝的差异（未做）

1. **侧栏 Quno 行副标题与徽标**：稿子为「26px 头像 + Quno·状态点 + 『4 条关注 · 1 个任务进行中』+ 右侧 4」。原生面板行只渲染 16/18px glyph + 单行 label；zw.7 的 `SidebarPanelMetadata` 仅 `{id, order, label}`。需要 fork 增加通用元数据（`description` / `badge` / `tone`）并在 SidebarRoot 渲染，再按运行时发版流程发 zw 层。插件侧可先保持兼容，不动侧栏结构。
2. **空态直达面板**：稿子 s01 的右上角开关打开 Quno 面板；真实 app 的右栏开关由 dockkit 管理，Quno 面板入口是胶囊/任务卡。空会话没有 header utilities 席位，因此无内容时无法从空态打开面板（与「无内容不渲染」一致）。
3. **s02 的实际内容**：稿子是静态数据。真实 app 需要模型完成汇报回合才会出现 tail 卡片；无凭据时回合以 `MISSING_CREDENTIAL` 结束，没有 tail，卡片不出现（这是诚实行为，不是绑定失效）。

## 验证

- `dsh-quno` typecheck / build / 98 项测试通过。
- 首开截图（headless CDP，暗色 1765×705）确认：侧栏/会话头/欢迎块均为新 Q 标，布局与稿子 s01 一致。
- 胶囊浮位与汇报卡需要在有模型凭据的会话中验（本轮 scratch 无 key，回合失败，tail 不渲染）。

## 2026-10-27 补充：默认工作区/模型与首屏居中

- **主会话默认加入工作区**：`ensureMain` 新增可选 `workspaceId`；客户端取侧栏第一个工作区的 id，Host 在未收到 id 时回退到 `workspaceRegistry.list()[0]`（再退到 cwd）。这样 stock composer 不再停在「选择一个工作区开始」的 inert 态，进来即可输入。
- **默认模型**：模型来自 profile 的 `llm-pi-ai`/默认 agent 设置，不是 Quno 硬编码；Quno profile 的 `modelProvider/model` 仍只用于分析回合。演示环境缺模型时 composer 会显示「请选择模型」，属于环境缺配置而非 Quno 逻辑。
- **首屏**：stock headline（探索未至之境 + 预览版）与 hero 工作区选择按钮在 Quno 主对话里隐藏；欢迎块通过覆盖 stock `.heroOptions` 的 `margin-left:auto` 居中到 composer 卡片中心（实测 slot 中心 1021 vs composer 1019）。
- **胶囊**：锚点改为 scroll region 中心 + `--dsh-chat-content-width/2 + 12`，不再依赖不存在的 flow 槽标记；无空间时回退头部工具区。

## 2026-10-28 方案回调

- 胶囊回 `conversation.session.header.utilities`，删除 fixed 测量与浮位回退。
- Hero 恢复 stock 结构（headline/鱼标/工作区 chip），Quno 欢迎块只占 options 接缝；不再隐藏 headline、不再做 slot/composer 中心对齐。
- 设置收敛为单页表单（同日再修订：无页签，基本/通知/角色与模型/感知来源/高级 + 主对话行，字段级自动保存）；关注、任务、运行迁入右栏四视图（动态/关注/任务/运行），「立即检查」随运行视图走。
- 证据与事件原文按 `reliability.readOriginal` 与 `EventWire.pruned` 门控；不可读时只展示摘要与血缘。
