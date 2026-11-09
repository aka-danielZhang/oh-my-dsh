# Quno 设置项使用盘点与主对话入口收敛（2026-10-29）

本次逐项核对设置页字段从浏览器草稿、Remote、SQLite 到实际运行消费的路径，并移除设置页底部「主对话」行。主对话仍由侧栏 Quno 原生入口创建或打开，`ensureMain` 与持久绑定不变。本文取代 `2026-10-28-quno-settings-single-page.md` 中「底部主对话行」的页面结构约定；旧 note 保留为历史。

## 核心设置项

「生效」只表示存在真实运行消费，不代表该字段作用于所有会话。

| 设置项 | 结论 | 实际消费与边界 |
|---|---|---|
| 总开关 `enabled` | 生效 | Scheduler 停止分析与 Outbox 停止主动投递；客户端门控入口同步收起，Sense 继续采集。 |
| 检查间隔 `checkIntervalSec` | 生效 | Scheduler 安排后续检查；已有 timer 在下次对账时采用新值。 |
| 时区 `timeZone` | 生效 | 安静时段、每日预算的本地午夜与分析提示时间。 |
| 通知策略 `mode` | 生效 | Runner 在「有意义的变化」与「每个有效运行汇总」之间选择通知候选。 |
| 安静时段开关与起止时间 | 生效 | Outbox 计算暂缓投递与解禁时间。 |
| 最小间隔 `minGapSec` | 生效 | Outbox 以上一条已投递通知时间限频。 |
| 每小时上限 `maxPerHour` | 生效 | Outbox 统计滚动一小时内已投递通知。 |
| 提前唤醒 `allowUrgentWake` | 未生效 | 没有 Scheduler 提前唤醒路径；它只在 Outbox 的安静时段例外判断中出现。 |
| 紧急消息突破安静时段 | 实际不可达 | 该判断还要求 `notice.payload.urgent === true`，但当前两个通知生产者都没有写入 `urgent`。 |
| 演练模式 `dryRun` | 部分生效 | Runner 会抑制分析汇报；委派任务完成通知绕过该判断，开启前已 pending 的通知也不会被统一拦截。 |
| 名称 `name` | 生效（展示） | 会话头与欢迎语使用；不进入模型 prompt。 |
| 模型 `modelProvider/model` | 部分生效 | 只选择后台分析会话的模型，不改变主对话或委派子任务的模型。 |
| 推理档位 `reasoningEffort` | 部分生效 | 只传给后台分析会话的模型选择。 |
| 职责与语气 `persona` | 未生效 | 仅落库并回显到设置页；没有任何 prompt 或运行逻辑读取。主对话仍使用静态 Quno guidance。 |
| 长期职责 `instructions` | 部分生效 | 只注入后台分析 prompt，不进入主对话或委派子任务 prompt。 |
| 每轮最多事件 | 生效 | Scheduler 据此扫描并选择本轮 Delivery。 |
| 每轮上下文字符 | 生效但非严格总上限 | 只裁剪分析 prompt 的新事件区，且该区至少保留 4000 字符；不是整个模型请求的严格字符上限。 |
| 每日模型运行上限 | 生效 | Scheduler 在创建分析运行前按本地日计数拦截。 |
| 感知来源创建/编辑 | 生效 | 经校验持久化，并以新 generation 重启实例；字段由对应 Sense 消费。 |

## 随包 Sense 字段

| Sense | 字段结论 |
|---|---|
| 日历 | `directory/file/timeZone/intervalSec/lookaheadDays/maxFiles` 均真实消费；`freshnessThresholdSec` 被声明但未进入校验后的配置，Host 因而不可能读到，未生效。 |
| RSS/Atom | `url/label/intervalSec/maxItems` 均真实消费；`freshnessThresholdSec` 同样在校验结果中丢失，未生效。 |
| 云之家群聊 | `groupIds/yzjProfile/intervalSec/maxPagesPerGroup/freshnessThresholdSec` 均真实消费；最后一项由 Host 的健康快照读取。 |

## 本次变更范围

只移除设置页的主对话入口及其专用注入、文案，修正丢失主会话时仍指向设置页的错误提示。上述其他未生效或部分生效项本次只盘点，未擅自删除或改变行为，后续应分别决定「补齐实现、收窄文案还是移除字段」。
