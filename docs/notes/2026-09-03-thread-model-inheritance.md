# dsh-thread 0.2.0-rc.7：承接会话继承来源会话的模型选择

## 背景与问题

用户反馈：Thread 交接创建的承接会话用的是「新建会话默认模型」，而不是来源会话正在用的模型。

根因在 `authorize` 的继承面：0.2.0 只继承了来源会话的 **agent preset**（`sourceSession.header.agentPreset`），
create plan 里没有模型字段，目标会话由 `agents.ensureSession` 创建后自然落在部署默认模型上。
模型选择（provider/model/reasoningEffort）是 per-session 的 durable 状态，与 preset 正交，
此前从未进入 Thread 的继承契约。

## 机制调研（0.1.2-alpha.3 运行时）

- 模型选择的 durable 载体是 Session 事件 **`model/selection`**（SessionEventMap 由
  `dsh-api-session-controller/types` 增强）；`modelSelection` 投影 fold 该事件为 `pending`，
  fold `request/header` 为 `lastUsed`。
- session-controller 的 `AgentService.selectionFor(agent)` **懒安装**时先读投影：
  `pending !== null` 即用作 `current`，否则退回最近 request header、再退回全局默认。
  因此只要在目标会话首次 prompt 组装前 append 一条 `model/selection`，首轮就会用它；
  不需要碰任何内存缓存。
- **刻意不使用 `sessionRemote.selectModel`**：那条链除了改会话自身选择，还会
  `agentDefaultModel.saveSelection(selected)` 把它存成**新建会话的全局默认模型**，
  并写 per-route effort 记忆——那是「用户显式切换模型」的手势语义。继承不是用户手势，
  每次 Thread 交接都重写全局默认是不可接受的副作用。
- 有效的来源选择 = 投影的 `pending ?? lastUsed`（「来源会话下一轮会用什么」）。

## 决策

1. **authorize 时读来源投影并钉在 Link 上**：`sessionProjections.stateOf(sourceSession,
   'modelSelection')` → `pending ?? lastUsed`；经 `llm.resolveCallConfig` 验证并归一化
   （provider/model/effort），路由已不可用时授权直接失败
   （`source-model-unavailable: provider/model`），绝不静默降级回默认模型——确认面板
   承诺什么，目标会话就拿到什么。来源无任何选择记录（从未选过、从未跑过）时
   `model: null`，目标沿用部署默认，与来源的实际行为一致。
2. **activate 在 final pristine check 之后、首次 inbox mutation 之前同步 append
   `model/selection`**：与 inject 同一不可分割窗口（无 await）；同选择重复 append 由
   事件级幂等保护挡掉（重试不产生重复语义，投影 fold 对 sameSelection 不动状态）。
   `model/selection` 不在 `FORBIDDEN_PRISTINE_EVENTS` 内，pristine 契约无需放宽。
3. **fold 补 `models` 记录**：`foldEvent` 解释 `model/selection` 事件，Link 的 fold
   保持「目标会话 Thread 可解释事件」的无损性质；trace 增加 `model-selection` 步。
4. **schema 向后兼容**：`ThreadLink.model` 与 `fold.models` 均带 default（null / []），
   rc.6 及更早的存量 Link 原样可解析（有回归测试）。
5. gateway inject 增加 `sessionProjections`、`llm`（host 半，web 组合恒在）。

## 边界

- 若授权后、激活前用户删了该 provider 配置：append 仍成功（只是事件），首轮 prompt
  以 model-unavailable 失败，错误诚实可见；不回写默认。
- 继承的是**授权时刻**的来源选择快照，钉在 Link 上；重试/重授权沿用首次快照
  （与 title/preset 同语义，幂等于 durable 记录）。
- 卡片/面板暂不展示将继承的模型（后续可加）；本版只保证行为正确。
