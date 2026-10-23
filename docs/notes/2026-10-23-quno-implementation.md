# Quno 三期落地记录（2026-10-23）

## 背景

Quno 的设计在 2026-10-22 由三份提案合并为 `docs/quno-bot-design.md`（唯一权威），2026-10-23 定稿七项产品决策、并把 dsh-thread 退役确定为独立动作。本次按设计落地一期/二期/三期，全部在插件平面完成：壳、桥、harness loop、IPC 零改动。

## 落地内容

- **包**：`plugin/dsh-quno`（dual）、`plugin/dsh-quno-sense-calendar`（host-only）、`plugin/dsh-quno-sense-feed`（host-only），三者均 `dsh.desktop.ship: true`。
- **Host**：专用 SQLite（WAL、`synchronous=FULL`、单 pid 锁）、事件/批次/订阅/游标/投递/关注/运行/任务/通知 outbox 全表；代际化 ingress（批次 receipt、身份冲突、checkpoint CAS、旧代际拒写、单事务）；路由；无模型预检的到期队列；隐藏受限分析会话；关注事项 revision CAS；统一通知 outbox（安静时段、最小间隔、每小时上限、dry-run、去重、崩溃对账、重投）；只读子任务；Typert `quno` Remote（10 个方法）。
- **Preset**：`quno`（工具 + 激进压缩）与 `quno-task`（只读 + guard）在 Host 启动时经 `ctx.get('agentPresets').register` 程序化注册。
- **浏览器**：设置页五页签（配置/来源/关注/运行/任务）、侧栏 Quno 入口、`quno_task` 任务卡、回合尾反馈按钮、15 秒轮询快照。
- **Senses**：日历（本地 `.ics`，UID + 修订快照差分，显式撤回与缺口）与订阅源（RSS/Atom，ETag/Last-Modified，条目内容哈希）。

## 关键决策与偏差

1. **profile 行而非 preset-owned**。浏览器半边必须在 profile 挂载；`dsh-agent-preset` 在 profile 根不可直接解析，YAML preset 行无法稳定落地，因此 `dsh-quno` 用 profile 行 + 程序化 preset，`preset-snippet.yml` 不随包。
2. **三个 Host 服务**：`quno`（面向主对话/Remote）、`qunoSenses`（注册表）、`qunoIngress`（代际化写入口）。Sense 运行时只拿 `ingress`、`checkpoint`、`limits`、`logger`、`signal`，没有调度/通知/存储能力。
3. **Typert 显式绑定**。`QunoHost` 不是 `TypertRemoteService` 子类，必须 `bindTypertRemote(this, 'quno')`，否则 gateway 报 `has no visible typertRemote binding`；wire 方法名与实现名不一致的（`ensureMain`/`actAttention`/`mute`）用描述符的 `implementation` 指向 `*ForClient`，运行期已验证。
4. **分析会话**经 `ctx.agents.create({meta:{origin:'subagent'}})` 创建、`tools.restrict({allow:[]})` + 3 个只读工具、`presentAs('native')`；输出从 `sessionQuery` 的持久化事件读取（测试用 live snapshot 回退）。
5. **真实 Sense 选型**：日历 + RSS/Atom。基座没有双向消息源插件，「建议消息」Sense 延后；两个已落地的 Sense 都能离线验证，避免把未验证的 API 假设写进首版。
6. **通知频控按已投递计数**。最初按「已生成通知」计数，积压场景下一次生成 N 条 pending 就触发小时上限、所有通知被推到下一小时；改为 `inbox-durable` 起计数后才符合「每小时最多 3 条打扰」的语义。
7. **deferred 可再领取**。`deferred` 到达 `eligible_at` 后必须能被 claim，否则「稍后再提醒」永不触发；`listReadyDeliveries`/`countReadyDeliveries`/`claimDeliveries` 一并覆盖。
8. **压缩用 stock `compaction-basic`**。本 fork 的该 Provider 已带层次压缩，Quno 只给参数（阈值 0.5、保留 8%）+ command-compact + tool-result pruner；不另造 Provider。
9. **主对话**用 `sessionController.create({cwd, agentPreset:'quno'})`，`cwd` 为空回退 homedir；不强制挂 workspace，侧栏入口由 Quno 自己的 slot 提供。
10. **回合尾反馈**按 1 小时可操作通知窗口工作——turn-tail props 不含触发消息来源，无法按消息精确匹配。

## 验证

- `dsh-quno`：78 个测试通过。覆盖契约、store/ingress 故障注入、完整管线（ingest→route→preflight→claim→analyze→commit→notify→present）、真实 AgentLoop + 脚本化适配器、Sense 门禁 S01–S14、调优模拟（125 条积压有界批次/公平/主题合并/小时上限/时间驱动复查/保留期）。真实挂载演示还暴露了一个模型侧问题：模型偶尔把 `nextReviewAt` 算成错误的 epoch 毫秒；Host 原本会以 `invalid-change` 拒绝并让事件保持 pending，现补了一次**语义修正回合**（提交校验失败 → 带错误原因重问一次 → 再提交），并在输出契约与修正提示中明确「时间字段是 13 位 Unix epoch 毫秒」。
- `dsh-quno-sense-calendar`：7 个测试（ICS 解析、浮动时区、all-day、窗口过滤、probe）。
- `dsh-quno-sense-feed`：7 个测试（RSS/Atom 解析、CDATA/实体、304、429 分类）。
- `typecheck` + `build`：三个包全绿；Host 入口 6 个、client bundle 225 kB。
- 实机（scratch `DSH_HOME`，`dsh web --port 3987`）：boot graph 含 `dsh-quno/client.js`（combo 200）；`quno/state`、`ensureMain`（`quno` preset 挂载成功）、`updateConfig`、`mute`、`checkNow`、`createSense` 全部经 Typert Remote 往返；两个 Sense running/healthy，各产生 1 条事件、共 2 条待处理投递；SQLite/锁落在 `$DSH_HOME/quno/`。
- 打包：`pnpm pack` 的三个 tarball 安装进全新 scratch profile 后可正常加载、注册 Sense、创建主对话。
- 主对话：发一条普通消息后，会话头为 `agentPreset: "quno"`，请求头含 29 个工具（Quno 五个 + stock）与 Quno 中文 persona/system prompt；回合在模型边界以 `MISSING_CREDENTIAL` 结束（该 scratch home 没有 API key）。
- 该 scratch home 没有模型凭据，思考回合按设计失败发声（`analyzer-error`，投递保持 pending）；真实模型输出的闭环由 `tests/analyzer-agent.test.ts` 覆盖。

## 实机演示（2026-10-23，真实 `~/.dsh` Profile）

在用户当前桌面 Profile 里通过 `plugin_manager install_bundle` 热装三个包（link 到工作区），Host 立即生效并完成了一次真实闭环：创建 `quno` 主对话 → 演示日历 `.ics` 两轮变更 → 两次分析提交、两条关注事项 → 一条主动汇报在 08:00 安静时段结束后投递进主对话（`quno-notify`，状态 `presented`），主对话模型随即回复。客户端 bundle 已进入 boot graph；当前桌面构建没有 fork 专属的 `sidebar.workspaces.sessionListView` 槽，因此侧栏列表视图未出现，设置页「Quno」入口与主对话按钮可用。

## 已知限制 / 后续

- 建议消息 Sense 未落地（无基座 API）；RRULE 不展开；feed 不携带凭据。
- 通知的「已展示」以用户消息 id + 下一事件为证据，极端并发下可能误判，恢复矩阵按不确定重投处理。
- 真实数天的误报/漏报调参与指标观察（§15）仍需上线后进行。
- dsh-thread 退役（§16.1）未执行：属独立桌面 Release 动作，与 Quno 进度解耦。
- dsh-quno 的 UI 只在 bundle/boot graph 层验证，未做浏览器点击回归；后续用真实 GUI 补。
