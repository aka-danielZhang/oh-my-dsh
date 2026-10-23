# dsh-quno

Quno 是 DSH 里的**常驻个人助理**：它把外部变化（日历、订阅源，以及后续任何 Sense）变成一条可回放的事件流，在用户主对话之外做低成本整理，只在确有实质变化时把结论投递进主对话；用户随口说的事、被动感知到的事、委派出去的只读调研都落在同一个地方。

一个 `dsh-quno` 包同时提供 Host 与浏览器两半：

- **Host**：专用 SQLite（`~/.dsh/quno/quno.sqlite`）、Sense 注册与代际化 ingress/ACK、无模型预检的到期队列、隔离的隐藏分析会话、关注事项、统一通知 outbox（安静时段/频控/去重/重启对账）、委派只读子任务、`quno` 与 `quno-task` 两个程序化 agent preset，以及 Typert `quno` Remote。
- **浏览器**：设置页 Quno 面板（配置/来源/关注/运行/任务五个页签）、侧栏「work / Quno」页签（work 为基座浏览区原样，Quno 为联系人视图，总开关关闭即原样回归）、右栏 Quno 面板（动态/关注/任务实时视图，进入主对话自动展开）、收起态实时胶囊（运行任务/待关注计数，点击展开）、`quno_task` 任务卡（点击在右栏面板定位该任务）与回合尾反馈按钮。

完整设计见 [docs/quno-bot-design.md](../../docs/quno-bot-design.md)。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-quno
```

Host 行常驻；`quno` 的 agent preset 由 Host 在启动时**程序化注册**（`ctx.get('agentPresets').register`），不走 YAML preset 行。安装后即可在侧栏打开 Quno 主对话；首次打开会创建一条独立会话并绑定。

## Behavior

- **不轮询模型**：只有存在待处理事件、到期复查或当前关注事项时才启动分析回合（静默同步零模型调用）。
- **主对话绑定**：所有主动通知都发往同一条主对话；投递前先落 message id，再 `followup` + `flush`，重启后用持久化日志核对是否真正展示，不确定的会重新投递。
- **安静时段与频控**：默认 22:00–08:00 静默、同主题最小间隔 10 分钟、每小时最多 3 条；`quno_mute` 可临时让出。
- **反馈**：通知/任务卡提供「已处理 / 稍后 / 关闭」；自然语言反馈由主对话模型调用 `quno_attention` 吸收。
- **只读委派**：`quno_task` 启动 `quno-task` 只读子会话（无 shell、无写工具），产物以约定的 `{"artifacts":[...]}` 行返回。
- **数据归 Quno**：会话消息仍在 DSH 会话日志里；Quno 只持久化事件、关注、通知、任务与调度状态，可整体删除 `~/.dsh/quno/` 重置。

## Config

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `root` | `~/.dsh/quno` | Quno 数据目录（SQLite + 锁文件） |
| `name` | `Quno` | 显示名 |
| `timeZone` | 系统时区 | 安静时段/每日预算使用的时区 |
| `checkIntervalSec` | `300` | 定时检查上限；有事件时由 ingest 立即触发，不必等定时器 |
| `dryRun` | `false` | 试运行：照常分析与记录关注，但不投递任何主动通知 |

修改 config 会让下一次检查按新配置运行；正在进行的回合不受影响。

## Development

```sh
cd plugin/dsh-quno
pnpm install
pnpm run typecheck
pnpm run test        # 契约、存储/ingress、管线、真实 AgentLoop、Sense 门禁、调优模拟
pnpm run build       # lib/index.js + lib/preset.js + lib/task-guard.js + lib/client.js
```

`lib/client.js` 是 ModuleLoader 闭包产物（`window.__ModuleLoader__.load`），平台模块 external；构建契约在 `tsdown.config.ts`，与 harness 的 `PLATFORM_MODULES` 同步。

## Design notes

- 设计：`docs/quno-bot-design.md`（单一事实源）。
- 落地决策与偏差：`docs/notes/2026-10-23-quno-implementation.md`。
- 仓库级规范：根 `AGENTS.md`（插件 monorepo、依赖纪律、client bundle 契约）。
