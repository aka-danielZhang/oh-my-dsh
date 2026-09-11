# 设置·定时任务设计方案

2026-09-11 · 状态：已实施（M1–M3 完成，实现决策见 `2026-09-11-dsh-scheduled-tasks.md`；M4 桌面随包与发版待评审）。
同日二次改版（入口由设置一级菜单改为侧栏时钟按钮、调度由「仅每天」扩到五类、编辑器对齐 composer）见本文 §18，该节覆盖 §2.1 / §6 / §7 / §8.1 / §13 的相应描述。

## 1. 结论

在「设置」中新增一级菜单「定时任务」，由新的出树双面插件 `dsh-scheduled-tasks` 提供。页面统一展示两类任务：

1. **用户任务**：用户创建，支持标题、每日执行时间、任务指令、运行/暂停、编辑和删除。
2. **系统任务**：其他插件贡献的只读投影。首个系统任务是 OhMyMemo 的「梦境记忆」，固定置顶且不可编辑、暂停或删除。

核心边界如下：

- 通用定时任务由 `dsh-scheduled-tasks` 持久化、调度并创建独立 Agent Session。
- OhMyMemo 继续独占自己的配置、timer、跨进程 lease、Run 和审计；定时任务插件只读取 `ohMyMemoUi.overview()`，绝不复制或接管梦境调度。
- 记忆页关闭梦境记忆时，统一页显示「已暂停」；记忆页开启后显示「运行中」；实际提取期间另显示「执行中」。统一页不提供任何可改变梦境状态的控件。
- 不修改 Harness fork。UI 使用现有 `settings.section`，Host 使用现有 Agent、Workspace、Permission、Jobs、Storage Domain 和 Timer 服务。
- 不复用 stock `@deepseek-ai/dsh-schedule` 作为执行内核。它是 Session-local reminder，不是全局后台任务。

## 2. 用户可见范围

### 2.1 一级入口

- Slot：`settings.section`
- id：`scheduled-tasks`
- order：`13`
- 中文：`定时任务`
- 英文：`Scheduled tasks`

`order: 13` 让它位于当前「使用统计」（11）和「记忆」（14）之间。它不是侧栏中的新主导航，也不放进「通用设置」的单行偏好。

### 2.2 页面结构

页面沿用现有设置页的紧凑布局：

1. 页头：标题「定时任务」、说明「按计划自动执行任务。」、刷新图标、主按钮「新建任务」。
2. 非阻断反馈：加载、刷新和保存错误，以及一次性状态播报。
3. 单一任务列表：系统任务固定在前，用户任务按 `createdAt` 升序稳定排列。
4. 编辑态：从列表整页切换到表单，不使用行内展开或嵌套弹窗。

首版不按状态分 Tab。状态切换后任务不应突然换组或跳位。

### 2.3 任务行

每行展示：

- 标题；
- 主状态：`运行中` 或 `已暂停`；
- 调度摘要，例如 `每天 02:00 · Asia/Shanghai`；
- 任务指令，最多两行截断；
- 最近执行摘要：上次执行时间、结果，执行中时显示 spinner；
- 行级操作。

用户任务操作：

- 运行/暂停开关；
- 编辑图标；
- 删除图标，删除前二次确认。

系统任务不渲染禁用开关、编辑或删除按钮。禁用按钮既难以获得解释，也容易被误判为故障；使用常驻文案说明权限边界。

### 2.4 梦境记忆默认项

固定展示内容：

| 字段 | 值 |
|---|---|
| 标题 | 梦境记忆 |
| 类型 | 系统任务 |
| 指令摘要 | 整理近期对话并沉淀为长期记忆 |
| 调度 | 从 `overview.dream.scheduleLocalTime/timeZone` 读取 |
| 主状态 | `enabled=false` → 已暂停；`enabled=true` → 运行中 |
| 单次状态 | `dream.status=running` → 执行中 |
| 控制能力 | 不可编辑、不可暂停、不可删除、不可手动执行 |
| 提示 | 由记忆设置管理，不能在此暂停。 |

「设置」Section 当前只向子页面下发 `close()`，不提供跨 Section 的 `openSection(id)`；该能力只存在于 onboarding owner。首版不做 DOM click 或 CSS 类名锚定。梦境行提示用户从左侧进入「记忆」；若后续上游把 `openSection` 加到 `SettingsSectionOwnerProps`，再把提示升级为「前往记忆设置」按钮。

在 Desktop 正式组合里 `dsh-ohmymemo` 与本插件均随包安装，因此梦境项是默认常驻项。单独安装 `dsh-scheduled-tasks` 而没有 OhMyMemo 时，不伪造一个不可用的外部插件任务。

## 3. 状态语义

主状态只回答「以后是否还会按计划触发」：

```text
运行中 --用户暂停--> 已暂停
已暂停 --用户开启--> 运行中
```

单次执行状态另行表达：

| `activity` | UI | 含义 |
|---|---|---|
| `idle` | 无额外标识 | 当前没有执行 |
| `running` | 执行中 | 本次 Agent 正在处理 |
| `waiting-input` | 等待确认 | Agent 等待审批或用户输入 |
| `success` | 最近成功 | 最近一次正常结束 |
| `error` | 最近失败 | 最近一次执行失败，任务仍保持运行中 |
| `cancelled` | 已取消 | 本次执行被取消，未来调度不受影响 |
| `skipped` | 已跳过 | 同一任务上一轮未结束，未重叠启动 |
| `unavailable` | 状态暂不可用 | 系统任务 Provider 查询失败 |

不能用同一个「运行中」同时表达 enabled 和 active run。暂停只阻止未来触发，不中断已经开始的执行；执行期间暂时禁止编辑和删除。取消当前执行、立即运行和运行历史均留到后续版本。

OhMyMemo 的状态映射是只读函数，不写回任何数据：

```ts
scheduleState = overview.dream.enabled ? 'enabled' : 'paused'
activity = overview.dream.status === 'running'
  ? 'running'
  : mapLastResult(overview.dream.lastResult)
```

## 4. 为什么不直接复用 stock Schedule

Harness 已有 `@deepseek-ai/dsh-schedule`，但其契约与本需求不同：

- 事实源是某一 Session 的 `schedule/change` 事件；
- 只在原 Session 仍 live 时投递，cold Session 不做工作；
- 到期后向原 Session 排入普通 follow-up，而不是创建独立后台 Session；
- v1 仅支持 `after`、`at` 和固定秒数 `every`，没有每日本地日历时刻、Cron 或全局 admission；
- active catalog 表示 reminder，不表示独立任务及其运行结果。

依据：Harness `docs/subsystems/schedule.md` 的 Durable records、Fixed-rate input、Active views 和 Live delivery 章节。

因此两者保持正交：

| 能力 | stock Schedule | 本设计 |
|---|---|---|
| 所有权 | Session-local | Host 全局 |
| 触发结果 | 原会话 follow-up | 新建独立 root Session |
| 冷启动 | 原会话 cold 时不运行 | Host 启动后重建全局 timer |
| 日历语义 | 无 | 每天 `HH:mm`，固定 IANA 时区 |
| 管理面 | 会话内 active reminder | 设置一级任务列表 |
| OhMyMemo | 不适用 | 只读 managed task 投影 |

不要把两类数据合并，也不要把 `schedule/change` 扫描成通用任务列表。

## 5. 插件与服务边界

### 5.1 新插件

按仓库脚手架创建，禁止手写 manifest：

```sh
pnpm run plugin:new -- dsh-scheduled-tasks --face dual \
  --description "设置·定时任务：全局每日 Agent 任务与系统任务目录"
```

建议 Host 行：

| 行 | 职责 | 关键依赖 |
|---|---|---|
| `scheduled-tasks-core` | Domain、用户任务 CRUD、全局 scheduler、Jobs、managed Provider registry | storageDomain、timer、jobs、agents、agentPresets、permissionPresets、workspaceRegistry、sessionTitle、agentDefaultModel |
| `scheduled-tasks-ohmymemo` | 注册梦境记忆 managed Provider | scheduledTasks、ohMyMemoUi |
| `scheduled-tasks-api` | Typert Remote descriptors | typert、scheduledTasks |

Client 只注册一个 `settings.section`。三个 Host 行相互独立：OhMyMemo adapter 等待依赖时，用户任务 core 与 UI API 仍可工作。

### 5.2 Managed Provider registry

`scheduledTasks` Service 提供 effect-owned 注册接口：

```ts
interface ManagedTaskProvider {
  id: string
  order: number
  title: string
  instructionSummary: string
  sourceLabel: string
  capabilities: {
    editable: false
    pausable: false
    deletable: false
    runnable: false
  }
  snapshot(signal: AbortSignal): Promise<ManagedTaskState>
}

interface ManagedTaskState {
  schedule: {
    kind: 'daily'
    localTime: string
    timeZone: string
    timeZonePolicy: 'fixed-iana' | 'host-local'
  }
  scheduleState: 'enabled' | 'paused'
  activity: TaskActivity
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  nextRunAt: number | null
  detail: string | null
}
```

规则：

- Provider id 使用反向域式命名，梦境为 `system.ohmymemo.dream`。
- `registerManaged()` 返回 disposer，停止或更新插件时立即移除投影。
- managed task 不进入用户任务 Domain，不参与 core timer，不创建 Run，不接受 core CRUD。
- `list()` 分别读取每个 Provider；单个 Provider 失败只生成该行的 `unavailable` 状态，不拖垮用户任务列表。
- 静态标题、摘要和 capabilities 在注册时钉死；动态状态每次查询重新读取，不缓存成第二事实源。
- 梦境当前跟随 Host ambient local time，adapter 必须如实标记 `timeZonePolicy: 'host-local'`，不能伪装成固定时区。

OhMyMemo adapter 只调用已经存在的 `ohMyMemoUi.overview()`。首版不需要改 `dsh-ohmymemo`。

## 6. 用户任务数据模型

使用 Storage Domain `dsh_scheduled_tasks`，版本从 1 开始：

```ts
interface ScheduledTaskRecord {
  version: 1
  id: string
  revision: number
  owner: 'user'
  title: string
  instruction: string
  schedule: {
    kind: 'daily'
    localTime: string       // HH:mm
    timeZone: string        // explicit IANA Area/Location
  }
  enabled: boolean
  execution: {
    workspacePath: string   // absolute path
    agentPreset: string
    permissionPreset: string
    model: null | {
      provider: string
      model: string
      reasoningEffort?: string
    }
  }
  createdAt: number
  updatedAt: number
}

interface TaskRuntimeRecord {
  version: 1
  taskId: string
  activeRunId: string | null
  activeJobId: string | null
  lastScheduledFor: number | null
  nextRunAt: number | null
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastResult: TaskRunSummary | null
}

interface TaskRunAudit {
  version: 1
  runId: string
  taskId: string
  definitionRevision: number
  trigger: 'scheduled' | 'catch-up'
  scheduledFor: number
  sessionId: string | null
  fence: number
  commitIntent: 'claimed' | 'session-created' | 'terminal'
  startedAt: number
  finishedAt: number | null
  status: 'claiming' | 'running' | 'success' | 'error' | 'cancelled' | 'skipped'
  detail: string | null
}
```

Domain 表：`tasks`、`runtime`、`runs`。`runs` 首版只为审计和恢复保留，UI 只读取 `lastResult`。

约束：

- title：trim 后 1..100 字符；允许重名，以 id 区分；
- instruction：trim 后 1..8000 字符；
- localTime：严格 `HH:mm`；
- timeZone：创建时钉住 IANA zone，不能依赖进程后来变更的 ambient zone；
- workspacePath：绝对路径，创建和每次执行前都经 Workspace Registry 验证；
- 最多 100 个用户任务；
- 所有 mutation 带 `ifRevision`，冲突返回稳定错误并让 Client 重读，不做静默 last-write-wins；
- API 不返回内部 storage path、锁信息或任意 live 对象。

这些数据不放入 `settings.yaml`。可变列表、Run 状态和审计不是简单偏好项，Storage Domain 更符合其生命周期与恢复要求。

## 7. 创建与编辑表单

主字段满足本次需求：

1. `标题`：必填。
2. `执行时间`：首版固定「每天」+ `HH:mm`；旁边显示创建时钉住的 IANA 时区。
3. `任务指令`：必填，多行文本。
4. `状态`：运行中 / 已暂停。

执行任务还必须有运行上下文。将以下字段放在「运行方式」区域，不隐藏其实际影响：

- 工作区：必填，默认当前 Workspace；
- Agent 预设：默认当前默认预设，保存时钉住具体 id；
- 权限：默认当前默认权限预设；
- 模型与推理强度：默认「跟随默认」，也可钉住具体 route。

模型为「跟随默认」时每次 Run 解析当时完整默认选择；固定 route 不可用时本次 Run fail loud，不静默换模型。Agent 预设或权限预设不存在时同样失败并保留任务运行状态。

表单行为：

- 保存失败保留草稿；
- 字段错误就地显示，提交后聚焦首个错误；
- 有未保存修改时返回或取消需要确认；
- 编辑期间不改变已持久化任务；保存一次提交完整快照；
- 执行中的任务不可编辑或删除；暂停不会取消当前执行。

## 8. 调度与执行

### 8.1 时间语义

- 首版仅支持每天一次 `HH:mm`，按任务创建时钉住的 IANA 时区解释；
- 每次计算下一个本地日历边界，不以固定 24 小时递增；
- 因 DST 跳时而不存在的本地时间取该日跳变后的第一个合法时刻；重叠时间取较早 instant，一天最多触发一次；
- Host 启动、系统唤醒、任务修改后都重新计算最近边界和 next boundary；
- 只补最近一个漏跑边界，且必须在 12 小时 catch-up window 内；更早的漏跑不回放；
- 暂停任务不补跑暂停期间的边界；重新开启只从开启时刻之后计算。

### 8.2 全局 timer

core 只维护一个 one-shot timer，指向所有 enabled 用户任务中最早的 `nextRunAt`。timer 唤醒后重新读取时钟和持久状态，收集 due tasks，再为下一边界重新 arm；不为每个任务永久保留 interval。

同一时刻多个任务按 `scheduledFor`、`createdAt`、`id` 稳定排序。首版全局并发上限为 2，其余进入进程内有界队列；进程退出时未 claim 的项不算已执行，重启后仍由边界恢复处理。并发上限、catch-up window、任务上限、指令上限和 run timeout 都进入插件 Config，不散落硬编码。

### 8.3 跨进程与重叠

桌面与终端可能共享同一个 `DSH_HOME`，因此每次 claim 必须经过 per-task 跨进程 maintenance lease：

1. 取得 task-scoped 原子目录锁，锁身份包含 pid、进程启动标识和随机 nonce；
2. 持锁后刷新或重开 Domain，消除 open-time snapshot；
3. 复核任务仍 enabled、边界未被 `lastScheduledFor` 消费、没有 active Run；
4. 持久写入带单调 fence 的 claim intent，再启动 Job/Agent；
5. terminal 时先写 fenced terminal intent，再幂等前滚 audit、runtime 和 cursor；
6. 释放 lease。

同一任务不允许重叠。上一轮仍在 `running` 或 `waiting-input` 时，当前边界写一条 `skipped` audit 并推进 `lastScheduledFor`，不排队补执行。不同任务可在全局并发上限内并行，长任务不能持有全局锁阻塞其他任务。

实现时不能直接复制 OhMyMemo 当前的 terminal 双写方式。当前 `manager.ts` 仍先写 audit 再写 state，两次写之间存在崩溃窗口；通用 scheduler 应从 v1 就使用持久 `commitIntent` 和 fence token，把 `claimed → running → terminal` 的恢复路径定义完整。

### 8.4 Agent Session

每次用户任务 Run 创建一个普通 root Session，参考 Harness `packages/webhook/webhook/src/session.ts` 的成熟事务：

1. 预解析并验证 Workspace、Agent preset、Permission preset 和模型 route；
2. `ctx.agents.create({ sessionId, meta: { cwd, agentPreset }, agentOptions, setup })`；
3. mount 指定 Agent preset；
4. attach Workspace；
5. 应用 Permission preset；
6. 设置标题 `[定时] <任务标题> · <本地时间>`；
7. 以 `source.kind = 'scheduled-task'` 的 plugin-origin user message 提交原始 instruction；
8. 监听 Agent/Session terminal 状态并结算 Job 与 Run。

instruction 作为用户文本消息传入，不拼成 shell 命令，不做字符串插值，也不把 title、路径或时间混入指令正文。Session 出现在普通历史中，用户可查看结果、处理审批或继续对话。

权限为「变更前确认」时，Agent 可以进入 `waiting-input`；这是正常状态，不得绕过审批。该状态会阻止同一任务的下一次重叠启动。真正无人值守的任务应选择只读或用户明确授权的权限预设。

## 9. Remote API

Typert namespace：`scheduledTasks`。所有输入/输出使用 strict schema 和 owned JSON：

| 方法 | 作用 |
|---|---|
| `list()` | 返回用户任务和 managed task 合并后的列表快照 |
| `catalog()` | Workspace、Agent preset、Permission preset、模型/effort 选择项 |
| `create(request)` | 创建用户任务 |
| `update(request)` | 按 task revision 修改完整快照 |
| `setEnabled(request)` | 行级运行/暂停，按 revision fenced |
| `remove(request)` | 删除用户任务，执行中拒绝 |

首版没有 `runNow()`、`cancelRun()`、`history()`。OhMyMemo id 传给任意 mutation 都返回稳定 `TASK_MANAGED_READ_ONLY`，而不是依赖 Client 隐藏按钮作为安全边界。

Client controller 使用现有 `createSnapshotStore` 模式：首载并发拉取 `list + catalog`，Section 挂载期间 3 秒单飞轮询 `list()`；刷新失败保留旧列表。每个 mutation 使用 generation guard，失败重读并保留明确错误。

## 10. 安全与隐私

- 任务 instruction 可能包含敏感信息，不写普通日志、Job label 或错误 detail；日志只记录 taskId、runId 和分类错误。
- Remote 返回 instruction 是设置页编辑所需的受权数据，不向 Session projection 或其他页面广播。
- 固定模型、preset、permission、workspace 在执行前逐项重新验证；不可用即失败，不猜测替代项。
- 调度器不自动扩大权限，不把审批策略改为 never，不向 Agent 注入额外工具。
- managed Provider 只返回最小状态叶子，禁止序列化 OhMyMemo Service、Run、Store 或 Session live object。
- 删除只删除定义与未来调度，不删除已经创建的 Session 和 Run audit。
- 任务、runtime 和 audit 的持久记录使用 strict versioned schema；未知版本或损坏记录隔离并 fail visible。

## 11. OhMyMemo 当前风险与接管禁令

本方案第一阶段到可交付版本都只聚合 Dream，不接管其执行，原因不仅是所有权，还包括当前实现中的恢复边界：

- `manager-domain.ts` 仍是 state/runs 两表 v1；
- terminal 路径先写 audit 再写 state，两个持久写之间存在崩溃窗口；
- `overview()` 主要读取本进程 state，另一 Host 完成 Run 后当前进程可能短暂陈旧；
- 手动 Run 跨过每日边界时，现有 `reconcileSchedule()` 在 current Run 分支直接 arm 下一边界，需专项验证是否吞掉当日 scheduled boundary。

因此：

1. 通用页只读调用 `overview()`，允许 3 秒轮询下的短暂最终一致；
2. Provider snapshot 带 `observedAt`，超过阈值时 UI 可标「状态可能已过期」；
3. 不把 dream config、cursor、Run audit 或 state 复制进通用 Domain；
4. 不给 Dream 再 arm 第二个 timer；
5. 将来若要中央接管，必须先在 OhMyMemo 内完成 fenced commit、新鲜状态读取和跨边界竞争测试，再做带 cutover checkpoint 的一次性迁移；不能双 scheduler 并存。

## 12. 错误与恢复

| 场景 | 行为 |
|---|---|
| 首次加载失败 | 页面错误态 + 重试 |
| 刷新失败 | 保留旧列表，页头下非阻断提示 |
| OhMyMemo 查询失败 | 仅梦境行显示「状态暂不可用」 |
| CAS 冲突 | 重读最新记录，提示「任务已在其他窗口更新」 |
| Workspace 不存在 | 本次 Run error，任务仍运行中 |
| preset/model/permission 不可用 | 本次 Run error，不静默回退 |
| Host 休眠/退出 | 12 小时内只补最近一次边界 |
| 重叠边界 | 记录 skipped，不启动第二个 Agent |
| 进程在 claim 后崩溃 | 下次持 lease 按 commitIntent 恢复或明确结算 interrupted |
| Provider 卸载 | managed 行从 registry 移除；用户任务不受影响 |

失败不会自动暂停任务。自动暂停会隐藏持续性问题，也会把 transient provider 故障变成持久行为改变。

## 13. 响应式与可访问性

- 列表使用 `ul/li`；不把整行做成按钮，避免嵌套交互控件。
- 宽屏使用 `minmax(0, 1fr) auto` 内容/操作两列；容器小于 560px 时改为单列，操作区另起一行。
- 指令摘要可以 line-clamp，标题和状态不得截断到不可辨识；编辑态显示完整指令。
- 状态点仅装饰，必须同时显示状态文字；不能只用颜色表达。
- 图标按钮使用现有 primitives 中的图标，均有 Tooltip 与 `aria-label`。
- switch 的 accessible name 带任务标题，例如 `暂停「每日仓库检查」`。
- loading/spinner 使用 `role=status`，错误使用 `role=alert`，保存和状态变化用 `aria-live=polite` 只播报一次。
- 轮询结果只有真实状态转换才播报，不能每 3 秒重复播报。
- 所有交互有 `focus-visible`，遵守 `prefers-reduced-motion`。
- 样式只用 `--dsw-*` token；手写 style tag 预打 `data-plugin`/`data-plugin-css` 并幂等插入。

## 14. 实施顺序

### M1：统一目录与 Dream 投影

- 用脚手架创建 `plugin/dsh-scheduled-tasks/`；
- 提供 `scheduledTasks` Service 与 managed Provider registry；
- 完成 Typert `list()` 和 Client 设置一级页；
- 添加 OhMyMemo adapter，只读映射 `ohMyMemoUi.overview()`；
- 先验证 Dream 默认可见、开关状态映射和不可变权限。

### M2：用户任务 Host

- 定义 strict Domain schema、task/runtime/run 表和 per-task 跨进程 lease；
- 完成 CRUD、daily boundary、catch-up、single timer、claim/recovery 和 overlap policy；
- 复用 webhook Session creation 姿态创建普通 root Agent Session；
- 增加 catalog/create/update/setEnabled/remove Remote。

### M3：用户任务 Client

- 实现列表、两层状态、行级开关、编辑和删除；
- 实现列表/编辑整页切换、字段校验和未保存确认；
- 实现中英文 locale、容器查询和可访问性；
- 实现 3 秒单飞轮询和 managed Provider 局部降级。

### M4：桌面集成与文档

- 评审通过后标记 `dsh.desktop.ship: true`，由现有随包扫描链自动纳入 Desktop；
- 更新插件 README、根 `AGENTS.md` 插件清单和本设计状态；
- 按 `docs/release-runbook.md` 更新 Desktop 版本、CHANGELOG 与 revision manifest；
- 在 scratch `DSH_HOME` 做旧 runtime 组合和 packaged Profile 冒烟，禁止直接改正式 Profile。

## 15. 验收标准

### 15.1 纯函数与 Host 测试

- daily boundary 覆盖普通日、DST gap/overlap、跨日和机器时区变化；
- 固定 IANA zone 不受 Host ambient zone 改变；
- 12 小时 catch-up 只取最近边界，暂停期不补跑；
- 多任务只 arm 最早 timer，due 排序稳定；
- 同任务不重叠，跨进程只允许一个 claim；
- claim、Agent 已创建、audit 已写等崩溃点均可恢复且不重复执行；
- create/update/toggle/delete 的 revision fence 与 strict schema；
- managed task 的所有 mutation 均被 Host 拒绝；
- OhMyMemo enabled/status/time 的映射准确，Provider 失败局部降级；
- fixed route/preset/workspace 不可用时 fail loud；
- instruction 不进入日志和 Job label。

### 15.2 Client 测试

- `settings.section` 注册/卸载、order 与双语标签正确；
- 梦境记忆固定首行，无开关、编辑、删除和整行点击入口；
- 用户任务显示标题、时间、指令、主状态和单次状态；
- 行级乐观切换失败可回滚，CAS 冲突可重读；
- 编辑态校验、草稿保留、未保存确认和删除确认；
- 旧列表在刷新失败时保留；OhMyMemo 失败不影响用户列表；
- 560px 以下无重叠、横向滚动或文字溢出；
- 键盘、焦点、Tooltip、aria-live 和 reduced-motion 通过。

### 15.3 真实 GUI

使用隔离 `DSH_HOME` 和当前 GUI 的同代 runtime 验证：

1. 设置左侧出现「定时任务」，位置在使用统计和记忆之间；
2. 默认显示梦境记忆；记忆页开关能驱动其「已暂停/运行中」投影；
3. 定时任务页不能改变梦境任务，梦境实际运行时显示「执行中」；
4. 创建每日任务后重启 Web/Desktop，定义、状态和 next run 均保留；
5. 到时只创建一个带正确 workspace/preset/permission/model 的 Session；
6. 桌面与终端共享 Home 时不会双跑；
7. desktop 与 390px/560px 窄屏截图没有重叠、截断或空白内容。

### 15.4 构建与组合

- 插件 typecheck、单测和 build 全通过；
- client bundle 无意外 Node/runtime 值导入；
- scratch Profile 完整安装、冷启动、HMR 重挂、卸载无重复 Service/Slot/样式；
- 新插件 + 旧 runtime 组合 fail soft，尤其 managed adapter 行等待依赖时不得拖垮 core；
- packaged Profile 实际运行 Client bundle，不能只检查静态 inject 字符串。

## 16. 首版明确不做

- Cron、每周、每月、一次性、多计划或自定义时区编辑器；
- 搜索、筛选、批量操作、拖拽排序、复制任务；
- 立即运行、取消本次执行、完整运行历史、结果内嵌预览；
- 自动重试、失败自动暂停、通知策略、并发策略 UI；
- 把 Session-local stock reminders 收进列表；
- 在统一页修改 OhMyMemo 时间、模型、开关或取消梦境 Run；
- 将 OhMyMemo scheduler 迁入通用 scheduler；
- 修改 Harness fork 或用 DOM 注入模拟跨设置页导航。

## 17. 后续扩展顺序

1. 运行历史与打开结果 Session；
2. 立即运行和取消当前 Run；
3. 每周/一次性日历规则；
4. 通知与失败重试策略；
5. 上游设置 Section 导航 API 成熟后增加「前往记忆设置」；
6. 更多插件通过 managed Provider registry 暴露系统任务。

只有在 daily 规则、跨进程单飞、崩溃恢复和权限等待都完成真实 GUI/packaged smoke 后，才扩展 Cron 或多计划，避免把未闭环的执行语义放大。

## 18. 2026-09-11 二次改版（五类调度 + 侧栏入口 + composer 化编辑器）

本节是实机评审后的修订，覆盖前文冲突处；语义与验收仍以本文其余章节为准。

### 18.1 入口：撤除设置一级菜单（覆盖 §2.1）

- `settings.section` 注册（id `scheduled-tasks`、order 13）**撤除**；「设置」里不再有定时任务菜单。
- 新入口是**侧栏会话区标题行里、搜索按钮左边的时钟按钮**，点击切到主面板 `automation`；同一个按钮再点回会话（按 `data-dsh-stask-panel` 标记判断按下态）。面板本身注册在 layout 的 keyed `main` 座（`key: 'automation'`），因此 `ctx.layout.selectPanel` 与其它面板同一条路。
- 该行**没有 action seat**（`ui-workspace` 只声明 `sidebar.workspaces` 与其 directoryFlow），所以按钮以「自有 class + 中英双语 aria 锚 + 只追加不插队 + 全可逆」的装饰姿势注入，与仓库既有 DOM 侧插件（`dsh-settings-icons` 等）同纪律。锚点缺失（侧栏折叠成 rail、或组合里没有会话浏览区）⇒ 不画，绝不画错位置。

### 18.2 调度：五类规则（覆盖 §6 / §8.1 的「仅每天」）

- 规则：`hourly`（每小时第 N 分）/ `daily` / `weekdays`（周一至周五）/ `weekly`（ISO 周几 1–7）/ `monthly`（1–31 号），墙钟时间仍然严格 `HH:mm` 并钉住创建时的 IANA 时区。
- 记录表示沿用 `localTime` 字段：`daily` 成员的字段集与扩展前**完全一致**，因此既有 v1 记录无需迁移即可解析（domain 不 bump version）。
- DST 语义不变并补两条边界说明：spring-forward gap 顺延到跳变后的等价墙钟时刻；fall-back overlap 取较早 instant。`hourly` 在 gap 中塌陷到同一 instant 的两个候选、以及在 overlap 中重复的墙钟小时，都只触发**一次**——边界每次都以「严格晚于 now」重算，同 instant 不会二次入队。
- `monthly` 遇到当月没有该日期（如 2 月的 31 号）整月跳过，不折算到月末。`hourly` 的补跑窗口与其余规则一致：12h 内只补最近一次漏跑。
- §17 的「daily 闭环后再扩多计划」闸门由用户评审后显式放行：新增的只是**固定墙钟**的四种形态，不引入 cron 表达式、也不做「自定义」输入；执行语义（跨进程单飞、崩溃恢复、重叠跳过）未变。

### 18.3 执行上下文：预设固定标准模式（覆盖 §7）

- 任务固定以 `agentPreset: 'standard'` 运行；编辑界面**不提供**预设选择（也不再显示不可点的提示 chip）。Host 侧仍按通用校验（预设必须可解析），策略钉在 Client：请求恒带 `standard`。

### 18.4 编辑器视觉：对齐 composer（覆盖 §13 的页面视觉描述）

- **调度行**：类型下拉 + 周几/号数 + 双列时间滚轮 + 行尾摘要（`<摘要> · <时区>`）。时间滚轮与它的触发器等宽、两列等宽、隐藏滚动条，打开时把当前值滚到列中间。
- **指令框**：22px 胶囊 + `--dsw-specific-input-major` + `--dsw-elevation-soft`（描边变量显式绑 `--dsw-alias-border-l2`），auto-grow（36px 地板 / 340px 顶），无 resizer，底栏就是 composer 的 `.row`（`space-between` + 12px gap + `padding: 2px 8px 6px`）。
- **底栏芯片**：工作区 = stock hero `WorkspaceChip`（r16、`0 8px`、16px 文件夹 + 12px chevron）配 hero picker 的目录菜单（文件夹行 + 尾部 ✓ + 0.5px l2 分隔线 + 固定「添加工作区…」）；权限 = composer 芯片（r24、`0 4px 0 8px`、13/20/500）+ stock 盾牌字形与词表（仅可查看 / 工作区内修改 / 完全权限）；模型 = composer 芯片 + **两级菜单**（「模型」/「推理等级」），触发面显示「模型 · Default」。
- 所有下拉共用 stock Menu 卡片（r20、`--dsw-specific-menu`、`--dsw-elevation-prominent`、40px 行）；图标路径全部取 `ui-primitives`，文案全部走 `ctx.locale` 中英双语，颜色只用 `--dsw-*` token。
- 任务行的「已运行 N 次」改为诚实的「上次执行 <相对时间>」/「尚未执行」——Host 契约里没有 run 计数。
- 任务列表改**整宽单列卡片**：右上「⋯」菜单承载操作（立即运行 / 暂停·恢复 / 编辑 / 红色删除），行内不再摆开关按钮；配套新增 Remote `runNow`（manual 触发：暂停中的任务可立即跑、运行中拒绝、不推进调度游标），刷新与创建按钮换 stock `Button`（toolbar / primary）。
