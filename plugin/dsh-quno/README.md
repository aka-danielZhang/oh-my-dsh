# dsh-quno

Quno 是 DSH 里的**常驻个人助理**：它把外部变化（日历、订阅源，以及后续任何采集器）变成一条可回放的 Trigger 流，在永久主对话里按 Thread 合批判定，只在确有实质变化时打扰用户；用户随口说的事、被动感知到的事、委派出去的只读工作都落在同一个地方。

一个 `dsh-quno` 包同时提供 Host 与浏览器两半：

- **Host**：专用 SQLite（`~/.dsh/quno/quno.sqlite`）、Collector 注册与 Host 调度（run ctx commit 与 Intake 同事务、per-run generation 栅栏、健康推导）、2 秒有界 pass + 持久 Effect outbox、主对话 Eval Router、Ticket/Assignment/WorkerRun、关注事项、统一通知 outbox（安静时段/频控/去重/重启对账）、`quno` 与 `quno-task` 两个程序化 agent preset，以及 Typert `quno` Remote。
- **浏览器**：设置页 Quno 面板（配置/来源/关注/运行/任务五个页签）、侧栏原生 Quno 入口行、右栏 Quno 面板（动态/关注/任务三视图；采集器详情钻取、关注完结分组、事件详情、任务详情与取消）、正文右上悬浮胶囊（Portal 到对话内容容器；点击出任务/关注/动态概要，按行打开右栏）、三栏接入向导（`shell.overlay`，创建与编辑同一表单）、按 Turn 绑定的主动汇报卡、`quno_task` 任务卡。

完整设计见 [docs/quno-bot-design.md](../../docs/quno-bot-design.md)。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-quno
```

Host 行常驻；`quno` 的 agent preset 由 Host 在启动时**程序化注册**（`ctx.get('agentPresets').register`），不走 YAML preset 行。安装后即可在侧栏打开 Quno 主对话；首次打开会创建一条独立会话并绑定。

## Behavior

- **不轮询模型**：每 2 秒的有界 pass 只推进到期状态；只有 pending Trigger、到期 Eval 或待执行 Effect 才会产生模型调用，静默同步零成本。
- **主对话绑定**：所有主动通知都发往同一条主对话；投递前先落 message id，再 `followup` + `flush`，重启后用持久化日志核对是否真正展示，不确定的会重新投递。
- **主对话只路由**：主 preset 不提供 shell、文件、网页、Skill、Goal 等直接执行工具。Human Turn 用 `quno_task` 委派；Eval Turn 用 `quno_eval` 读取候选、`quno_eval_decide` 提交决定；结果经 Worker Report → Router relay 回流后只转述。追问进度或结果时用 `quno_task status/result` 读取持久 Ticket，支持跨重启查询。
- **自动准入**：`config.acceptMode` 默认 `observe`（评估 inferred 工作但只记录 `would_accept`，不建自动 Ticket）；`autoSourceIds` 显式列出来源并设为 `auto` 后才会自动接收。Eval/Notification 回合在 Host 工具层禁用记忆写入、提醒与执行。
- **会话列表过滤**：Quno 主会话与 `quno-exec-*` Executor 会话均不出现在普通工作区、扁平列表或搜索中；仍可从 Quno 入口、任务卡和运行记录打开。支持 `uiWorkspace.registerSessionVisibilityFilter` 的 runtime 负责隐藏主会话，旧 runtime 仅缺少这项新增过滤，其余功能不变。
- **安静时段与频控**：默认 22:00–08:00 静默、同主题最小间隔 10 分钟、每小时最多 3 条；`quno_mute` 可临时让出。
- **反馈**：通知/任务卡提供「已处理 / 稍后 / 关闭」；自然语言反馈由主对话模型调用 `quno_attention` 吸收。汇报卡按携带 `notificationId` 的那条消息绑定到所属 Turn，重载后仍可操作；历史通知按需读取（`noticeDetail`）。
- **只读委派**：每个 Ticket 复用稳定的 `quno-exec-<ticketId>` 只读子会话（`quno-task` preset，无 shell、无写工具）；Worker 用 `quno_worker_report` 结构化返回结论、产物与待答问题，Report 经 Router relay 进入通知 outbox。停止/重试先落库再处理激活，晚到写入不会改回状态。
- **结构化只读 CLI**：Worker 用 `quno_cli_call` 调用插件登记的能力（capability + operation + 声明参数），结果在**同一回合**返回，本地短查询不必走异步 Exchange。授权与校验在 Host 的 `qunoCli` broker 内：只放行 `access: 'read'`、按 Ticket `Mandate` 快照授权、参数闭表校验（`profile`/`argv` 进不来）、并发/超时/输出上限强制，全程不经 shell。能力必须先从 `quno_read.cliCapabilities` 发现；采集实例暂停不影响显式授权的只读查询。异步 `quno_exchange` 只留给真正远端/异步的采集器查询面，其失败与过期都会带原因回流并被唤醒一次。
- **采集器接入**：字段驱动表单（数值边界、静态选项、多值、远程选项、密钥留空保持）；云之家「最近群聊」经 `collectorOptions` 发现，仅多人群选可选。接入向导只承诺「已创建，正在首次同步」，健康以真实结果更新。
- **真实探测**：`probeCollector` 只检查可达性，不重启实例、不改配置版本、不推进检查点、不写健康，也不代表同步成功。
- **数据归 Quno**：会话消息仍在 DSH 会话日志里；Quno 只持久化事件、关注、通知、任务与调度状态，可整体删除 `~/.dsh/quno/` 重置。

## Config

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `~/.dsh/quno` | Quno 数据目录（SQLite + 锁文件） |
| `name` | `Quno` | 显示名 |
| `timeZone` | 系统时区 | 安静时段/每日预算使用的时区 |
| `checkIntervalSec` | `300` | 定时检查上限；有事件时由 ingest 立即触发，不必等定时器 |
| `dryRun` | `false` | 试运行：照常判定与记录关注，但不投递任何主动通知 |

修改 config 会让下一次 pass 按新配置运行；acceptMode 变化会向 live Ticket 写 PolicyInput 并重排 in-flight Eval。

## Development

```sh
cd plugin/dsh-quno
pnpm install
pnpm run typecheck
pnpm run test        # 契约、存储/ingress、调度、真实 AgentLoop、采集器门禁与调度单测
pnpm run build       # lib/index.js + lib/preset.js + lib/task-guard.js + lib/client.js
```

`lib/client.js` 是 ModuleLoader 闭包产物（`window.__ModuleLoader__.load`），平台模块 external；构建契约在 `tsdown.config.ts`，与 harness 的 `PLATFORM_MODULES` 同步。

## Design notes

- 设计：`docs/quno-bot-design.md`（单一事实源）。
- 落地决策与偏差：`docs/notes/2026-10-23-quno-implementation.md`。
- 交互补全（2026-10-27）：`docs/notes/2026-10-27-quno-interaction-completion.md`。
- 仓库级规范：根 `AGENTS.md`（插件 monorepo、依赖纪律、client bundle 契约）。
