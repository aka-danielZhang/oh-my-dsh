# 2026-09-03 — dsh-send-while-running 0.2.0：孪生 Send 改造为补位 Stop

## 触发

用户报告：「红色暂停按钮左侧的 model 选择消失了，没法选模型，偶发」。排查结论是**误会**：截图状态是
`primaryStops` 之外唯一会「红 Stop + 蓝 Send 同框」的组合——**运行中的 continuable 子会话**
（`interruptible = running && continuable` 的独立 Stop 染红 + 子会话主按钮保持 Send）。
模型选择器在子会话上是 stock 刻意隐藏的（`ModelSelect` 的
`available = sessions.subagentAddress(sessionId) === undefined`，被寻址子会话两个模型入口都不给，
理由是 Agent-bound RPC 会绕过 direct-parent continuation 路径激活持久化历史）。红色来自本插件 0.1.1
的「任何状态把 Stop 染红」全局 recolor，让 stock 控件看起来像插件加的按钮。

## 排查中发现的真问题

桌面当前 runtime（`613fd43f…`，`@deepseek-ai/*` 0.1.2-alpha.3）的 composer 把
`primaryStops` 从 `running && subagent === null` 改成了
`running && subagent === null && (empty || blocked)`。后果：

1. 主会话运行中**只要有草稿**，stock 主按钮保持 Send——本插件 0.1.x 的孪生 Send 与 stock Send
   **重复**（两颗一样的蓝圆），插件的存在前提（「运行中主按钮翻成 Stop、没法发送」）失效；
2. 同状态下整个 trailing row **没有 Stop**——想中断必须先清空草稿，这是 0.1.2 composer 的真空缺。

## 决策

用户选定「改造成补 Stop」：保留插件与座位，把孪生 Send 换成该状态缺失的 **Stop**。

- **可见性** = `running && subagent === null && !removed && (draft 非空 || 有图片)`——恰好是
  stock 主按钮为 Send 且无任何 Stop 的状态；草稿清空后 stock 主按钮翻回 Stop，本按钮自动退场，永不重复。
  continuable 子会话继续排除（它们有 stock 独立 Stop）。
- **中断路径** = stock stop prop 的原路径：`sessions.scope(id).get('conversation').cancel()`。
  经注册定义的 per-session `inject` 下发（渲染器对 session 槽位条目以 `inject(sessionId)` 注入 props），
  点击时惰性 `ctx.get('sessions')`（rail.ts 的惰性读取纪律），失败吞掉与 stock 一致。
  插件 `inject` 声明补 `'sessions'`（客户端运行时核心服务，恒在）。
- **不改全局染红**：`button:has(> svg > rect)` 的 recolor 原样保留（用户偏好）。本插件按钮在 slot
  wrapper 内、不是 trailing row 的直接 button 子节点，染不进来，所以自带同款红色（red-500/400 主题分档）。
- **布局**：`order: 1` + `:has()` 作用域把 stock 主按钮推 `order: 2`（[model][meter][stop][send]），
  仅在本按钮挂载时生效；类名改 `dsh-stop-while-running`（旧 `.dsh-send-while-running` 语义已失真），
  style 标记改 `data-dsh-stop-while-running`。锚点纪律不变（只用 `[data-slot]` 接缝 + 结构锚，不引
  stock CSS-module 类名）。
- **已接受边界**：座位看不见 composer 的 routability block；「运行中 + 被阻断 + 有草稿」会短暂出现两颗
  Stop——运行中的回合 implies 路由可服务，重叠至多瞬态。
- **版本/发版**：0.1.1 → 0.2.0（行为转向）；`dsh.desktop.ship.pin` 同步 0.2.0，随下一次桌面 Release
  出货；发版前桌面内已装的 0.1.1 提取目录若手工替换 lib 验证，下次桌面更新会按 tarball hash 覆回。

## 对「模型选择器消失」的处理

不改代码：子会话隐藏模型座位是上游设计（模型选择绑定 Agent 路由），本仓不在 DOM 层绕过。
若未来要在主会话上复现「模型座位整个没了且刷新才恢复」，那是另一条路径（`single` 槽位条目 crash 后
abdicate 成死格，console 会有 `slot entry crashed in 'conversation.input.model'`），届时按
`ui-model-selection` 的 `directoryFor` no-scope 抛错排查。

## 0.2.0 定稿补记：中断路径全链路类型对齐 stock

首版实现用手写结构类型鸭子匹配 `sessions.scope(id).get('conversation').cancel()`。定稿改为与
stock stop prop 完全同构的**真类型路径**：`SessionId`/`ISessions` 自 `dsh-client-runtime/client`
type-only 导入，`IConversation` 自 `dsh-client-ui-conversation/client` 导入（其会话作用域
Context merge 让 `scope(id).get('conversation')` 直接拿到 `IConversation` 类型），`scopedConversation`
辅助函数镜像 ui-conversation apply.ts 的同名 helper（差异一点：座位侧对 scope 不可解析取
soft no-op 而非 throw——fail-invisible 姿态）。`cancel(): Promise<void>` 签名与 stock 一致、失败照吞。
插件 `inject` 收回 `['slots','locale']`：sessions 在点击时惰性 `ctx.get`（不过度声明硬依赖，
rail.ts 的惰性读取纪律）。类型基线仍是 devDeps 钉的 0.1.1-rc.2；该路径在 0.1.2-alpha.3 部署运行时
行为同一（stock 自身 stop 接线即此路径，已从部署包内逐字核对）。
