# 2026-11-14 Quno 单助理对话与 Worker 检查交互/架构设计

> 状态：**当前合并版，已完成一轮自审修订。2026-11-15 已按本文 P0/P1 范围实施（见 [实施记录](2026-11-15-quno-worker-session-impl.md) 与 `docs/quno-bot-design.md` §18.4）；P2/P3 未动。**
>
> 本文是 Quno Router/Worker 交互与程序设计的唯一当前版本，保留「主消息流只有 Quno、工作列表进入原生 Worker 会话、可返回主对话」的产品定稿，并补齐 UI 规格、示例代码、焦点与响应式规则、加载/空/错态、inspect 客户端与 Host 边界及具体程序接口。
>
> 实施时必须同 PR 更新 [`docs/quno-bot-design.md`](../quno-bot-design.md) 的 §2、§4、§5、§8、§10、§13、§15，并另写实施记录。

## 1. v2 自审结论与修订摘要

| v1 的缺口 | 自审发现的问题 | v2 修订 |
|---|---|---|
| 工作入口只写「顶栏或右栏」 | 实施者仍需决定位置和层级 | 固定为 Quno 会话顶栏 `conversation.session.header.utilities` 的「工作」按钮，右栏作为列表容器 |
| 列表到会话的导航不够明确 | 是否先经过任务详情页会产生两套路径 | 列表行直接进入 Worker 原生会话；任务摘要作为会话内折叠信息，不再强制中间页 |
| 没有视觉规格 | Worker 标签、任务标题、状态和活动容易挤成技术列表 | 任务标题为主、Worker 标签为辅、状态独立右列；列表而非卡片墙 |
| 缺少焦点规则 | 键盘进入/返回后可能丢焦点 | 定义入口焦点、行焦点、返回焦点和缺失页焦点 |
| 缺少加载/空/错/窄屏规则 | 真实刷新和移动端容易把加载误写成没有任务 | 增加完整状态矩阵与 ≤720px / ≤480px 行为 |
| inspect 只有原则 | CSS 隐藏输入框不能阻止写入，且可能误伤程序输入 | 给出 Client 与 Host 双侧示例：只拦用户提交，不拦程序事件 |
| Worker 别名只说稳定派生 | 容易误把别名当路由 ID | 明确 `workerId=ticketId`，`workerLabel` 仅展示，任何操作都按 ticketId |
| 没有示例组件 | 容易写出嵌套按钮、手写 hook、第二份状态 | 给出纯 props TSX、token CSS、纯投影和导航示例 |
| 历史数据口径不完整 | 可能为追求界面干净而篡改历史 | 不删除旧日志；只改变新投影和新消息，旧工具卡可隐藏但原文保留 |
| 验收偏功能链路 | 可能工具全绿但 UI 仍泄漏、不可达或串会话 | 增加 DOM、键盘、读屏、窄屏和真实导航验收 |

## 2. 产品与视觉方向

### 2.1 一句话设计原则

**主对话保持安静，工作信息在专门的位置被认真呈现。** 不在消息流里证明系统很忙，而在「工作」里让用户随时看清谁在做、做到哪、结果是什么。

### 2.2 视觉上的唯一强调点

唯一强调是「工作入口上的真实活动计数」。它告诉用户当前有事情正在进行，但不泄露 Worker 细节。其余区域保持克制：

- 不用渐变、装饰性卡片墙、Worker 头像或新吉祥物；
- 不用大面积进度条、虚假步骤数和不断闪烁的状态点；
- 不把每次工具调用变成消息；
- 任务标题永远比 Worker ID 更醒目；
- 状态不仅靠颜色，必须有文字。

### 2.3 色彩与 token

生产实现只使用现有 `--dsw-*` 与 `--quno-*`，不把下列参考 hex 写进组件。它们用于说明明暗两态的层级关系：

| 角色 | 浅色参考 | 深色参考 | 生产映射 |
|---|---|---|---|
| 主画布 | `#FFFFFF` | `#17191C` | 现有 Conversation 背景 |
| 列表/选中层 | `#F5F6F8` | `#1E2125` | `--dsw-alias-bg-layer-1/2` |
| 主文字 | `#24282E` | `#E8EAED` | `--dsw-alias-label-primary` |
| 次文字 | `#66717D` | `#A3ACB7` | `--dsw-alias-label-secondary/tertiary` |
| 分隔线 | `#E4E8EC` | `#33383F` | `--dsw-alias-border-l1` |
| Quno 强调 | `#48669D` | `#7A96C8` | 现有 `--quno-accent` |

进行中、成功、警告、失败只使用 `--dsw-alias-state-*`。不要为 Worker 另造一套状态色。

### 2.4 字体与排版

沿用 DSH 系统字体，不新增字体依赖：

- 页面标题：16px / 600 / 24px；
- 任务标题：14px / 600 / 20px；
- Worker 标签与活动：12px / 400 / 18px；
- 状态标签：12px / 500 / 18px；
- 正文与结果：14px / 400 / 22px；
- 诊断 ID：11px / ui-monospace / 16px，仅在诊断区使用。

不使用全大写眉题，不用等宽字体装饰普通状态，不用「一个单词换色」制造标题。文字左对齐；长标题最多两行后截断，完整标题放 `title` 与可访问名称中。

## 3. 信息架构与导航状态

```text
Quno 主会话
  │ 点击顶栏「工作」
  ▼
工作列表（右栏；窄屏全宽）
  │ 点击某个 Worker 行
  ▼
Worker 原生会话（inspect）
  │ 点击「返回 Quno」
  ▼
回到同一个 Quno 主会话
```

导航状态只属于 Client，不进入 Quno SQLite：

```ts
type QunoNavigation =
  | { view: 'main'; workPanelOpen: boolean }
  | { view: 'worker'; ticketId: string; returnContext: ReturnContext }

interface ReturnContext {
  mainSessionId: string
  workPanelOpen: boolean
  scrollAnchor: string | null
  entry: 'work-button' | 'worker-list'
}
```

- 进入 Worker 只改变当前查看绑定，不触发 launch/resume/stop/retry。
- 返回 Quno 以持久 `mainSessionId` 为准，returnContext 只负责视图恢复。
- returnContext 可放窗口级 sessionStorage；丢失时仍能返回主会话，只是无法恢复滚动位置。
- 普通 work 会话不使用这套导航状态。

## 4. 主会话 UI

### 4.1 布局

```text
┌────────────────────────────────────────────────────────┐
│ Q  Quno                                      工作  2   │
├────────────────────────────────────────────────────────┤
│ 用户：我给黄仰纯发了啥？                               │
│                                                        │
│ Q  我查一下你们的一对一消息，找到后告诉你。            │
│                                                        │
│ 用户：顺便帮我看看今天有没有会议改期。                 │
│                                                        │
│ Q  我一起核对，完成后分别告诉你。                      │
├────────────────────────────────────────────────────────┤
│ 发消息给 Quno…                                         │
└────────────────────────────────────────────────────────┘
```

消息流中没有 Worker 名称、任务卡、工具卡、内部队列或执行参数。「工作」位于顶栏，不是消息节点。

### 4.2 「工作」按钮

- 无任务时仍显示「工作」，不显示数字 badge，点击后展示空态与使用说明。
- 有进行中任务时显示数量；需要你处理的数量优先于普通进行中数量，但不能叠加成两个 badge。
- 有「需要你」时使用 warn token；普通进行中使用现有 Quno accent；全部结束时不显示 badge。
- 可访问名称必须包含状态，例如「查看工作，2 项需要你处理」。
- 点击只切换右栏，不改变消息流，不滚动到某条历史消息。

示例（纯 props，不创建手写 hook）：

```tsx
interface WorkEntryButtonProps {
  activeCount: number
  needsYouCount: number
  expanded: boolean
  workLabel: string
  onToggle: () => void
  t: (key: 'workNeedsYou' | 'workActive', args: { n: number }) => string
}

export function WorkEntryButton(props: WorkEntryButtonProps) {
  const label = props.needsYouCount > 0
    ? props.t('workNeedsYou', { n: props.needsYouCount })
    : props.t('workActive', { n: props.activeCount })
  return (
    <button
      type="button"
      className="quno-work-entry"
      aria-label={label}
      aria-expanded={props.expanded}
      aria-controls="quno-work-panel"
      onClick={props.onToggle}
    >
      <span aria-hidden="true">{props.workLabel}</span>
      {props.activeCount > 0 && <span className="quno-work-entry__count">{props.activeCount}</span>}
    </button>
  )
}
```

注意：`activeCount` 包含 needsYou，避免 2 项需要你和 2 项进行中在视觉上被误解为 4 项。

## 5. 工作列表 UI

### 5.1 宽屏布局

```text
┌──────────────────────────────┐
│ 工作                    2 项 │
│                              │
│ 需要你                       │
│ 查询我与黄仰纯的消息         │
│ Worker 02f803ec              │
│ 等待确认联系人       需要你  │
│                              │
│ 进行中                       │
│ 整理今天的日程变化           │
│ Worker 91ac04be              │
│ 正在读取日历         进行中  │
│                              │
│ 已结束                       │
│ 汇总本周订阅动态             │
│ Worker b714c20a              │
│ 今天 12:40           已完成  │
└──────────────────────────────┘
```

列表不是卡片墙。每行使用细分隔线或足够留白，不加阴影，不显示 Chevron 装饰来代替明确的「查看会话」可访问名称。

### 5.2 行结构与交互

每行是一个主按钮，内部不能有嵌套的停止/重试按钮：

```tsx
interface WorkerRowProps {
  workerLabel: string
  taskTitle: string
  activityText: string | null
  statusText: string
  tone: 'idle' | 'active' | 'warn' | 'ok' | 'error'
  onOpen: () => void
}

export function WorkerRow(props: WorkerRowProps) {
  return (
    <button
      type="button"
      className="quno-worker-row"
      data-tone={props.tone}
      onClick={props.onOpen}
      aria-label={`${props.taskTitle}，${props.workerLabel}，${props.statusText}，查看会话`}
    >
      <span className="quno-worker-row__title">{props.taskTitle}</span>
      <span className="quno-worker-row__worker">{props.workerLabel}</span>
      {props.activityText !== null && <span className="quno-worker-row__activity">{props.activityText}</span>}
      <span className="quno-worker-row__status">{props.statusText}</span>
    </button>
  )
}
```

- 整行都可点击，键盘 Enter/Space 与鼠标一致。
- 停止/重试放在 Worker 会话头或独立的行尾菜单，不能嵌套在主按钮里。
- 标题最多两行；Worker 标签单行；活动最多一行。
- 状态文字始终存在，不只显示色点。
- 点击后不再先打开任务详情页，直接进入该 Worker 原生会话。

### 5.3 状态文案

| 状态 | 列表文案 | 活动区域 |
|---|---|---|
| accepted | 已分配 | 等待执行资源 |
| running | 进行中 | 真实活动或「正在处理」 |
| waiting | 等待中 | 等待后续事件 |
| needs-you | 需要你 | 显示一个简短问题 |
| done | 已完成 | 最近完成时间 |
| failed | 未完成 | 简短原因 + 可重试 |
| cancelled | 已停止 | 最近停止时间 |
| dropped | 无需处理 | 最近结束时间 |

### 5.4 加载、空、错误与缺失

| 情况 | UI | 禁止 |
|---|---|---|
| 首次加载 | 三行骨架，保留分组位置 | 写「还没有任务」 |
| 后台刷新失败 | 保留旧列表，顶部非阻塞「更新失败」+ 重试 | 清空列表 |
| 没有任务 | 「还没有工作。告诉 Quno 你想做什么，它会在这里安排。」 | 显示 Worker 骨架或技术说明 |
| 全部已结束 | 不显示「进行中」空组 | 显示 0 badge |
| Worker 不存在 | 「这段执行记录不可用」+ 返回 Quno | 自动创建新会话 |
| executorSessionId 缺失 | 「执行会话尚未分配」+ 当前状态 + 返回 | 打开主会话冒充 Worker |
| 权限/读取失败 | 「无法读取这段执行记录」+ 原因 + 重试 | 把失败说成没有记录 |

## 6. Worker 原生会话 UI

### 6.1 会话头

```text
┌────────────────────────────────────────────────────────┐
│ ‹ 返回 Quno                         停止任务           │
│ 查询我与黄仰纯的消息                                   │
│ Worker 02f803ec                         进行中         │
│ 只读查看，任务仍由 Quno 处理                           │
├────────────────────────────────────────────────────────┤
│ 原生任务输入 / assistant 文本 / 工具调用与结果         │
│ ...                                                    │
└────────────────────────────────────────────────────────┘
```

- 第一行只有返回和按状态允许的任务命令。
- 第二行任务标题，第三行 Worker 标签与状态。
- 「只读查看，任务仍由 Quno 处理」是一行静态说明，不是警告，不重复播报。
- 不显示「新建会话」「继续对话」「模型/权限/Plan」。

示例：

```tsx
interface WorkerSessionHeaderProps {
  taskTitle: string
  workerLabel: string
  statusText: string
  canStop: boolean
  onBack: () => void
  onStop?: () => void
  backLabel: string
  stopLabel: string
}

export function WorkerSessionHeader(props: WorkerSessionHeaderProps) {
  return (
    <header className="quno-worker-header">
      <div className="quno-worker-header__actions">
        <button type="button" onClick={props.onBack}>{props.backLabel}</button>
        {props.canStop && <button type="button" onClick={props.onStop}>{props.stopLabel}</button>}
      </div>
      <h1>{props.taskTitle}</h1>
      <div className="quno-worker-header__meta">
        <span>{props.workerLabel}</span>
        <span>{props.statusText}</span>
      </div>
    </header>
  )
}
```

### 6.2 会话正文

- 使用 DSH 原生 Conversation/Chat 与工具卡，不重写 Markdown、流式输出或工具渲染。
- 保留滚动、复制、轨迹切换、分页和公开工具数据。
- 不渲染 composer、附件、队列编辑、模型/权限/preset 控件。
- 不显示用户输入框或「可以继续追问」的暗示。
- 隐藏 system prompt、凭据、环境变量和私有 reasoning；技术 ID 可在诊断区显示。

### 6.3 焦点规则

- 打开工作列表：焦点移到列表标题或当前选中行，不能落到消息流旧位置。
- 进入 Worker：焦点移到「返回 Quno」，用户按 Tab 自然进入会话内容。
- 返回 Quno：焦点回到「工作」按钮；若从列表独立全宽页返回，则先回到该行所在的工作列表，再按用户动作返回主会话。
- Worker 不存在：焦点放在「返回 Quno」，而非空白正文。
- 鼠标点击不强制抢焦点；键盘导航必须保留可见 focus ring。

## 7. 响应式、动效与可访问性

### 7.1 响应式

| 宽度 | 行为 |
|---|---|
| `> 1100px` | 主会话 + 320–420px 右栏；Worker 会话使用主内容区全宽 |
| `721–1100px` | 右栏 300–360px；Worker 行活动文字可缩短，状态保留 |
| `≤ 720px` | 工作列表变全宽覆盖层；Worker 会话头两行；返回始终在第一行 |
| `≤ 480px` | 「工作」按钮保留文字与计数但隐藏装饰图标；Worker 标签可截断，不能隐藏任务标题和状态 |

不允许横向滚动。长 groupId/sessionId 只能在诊断区 `overflow-wrap: anywhere`，不能撑破布局。

### 7.2 动效

- 工作列表展开使用现有右栏动画，不另加页面级 reveal。
- 行选中可有 120ms 背景变化；不做逐行 fade/slide。
- 状态变化不闪烁、不脉冲；`prefers-reduced-motion` 时全部取消过渡。
- 后台刷新不移动当前焦点和滚动位置。

### 7.3 读屏与键盘

- 工作列表使用语义化 `ul/li`，每行一个 button。
- 状态文本变化使用局部 `role="status"`，只在状态实际变化时播报一次，不按轮询重复播报。
- badge 必须有完整可访问名称，数字本身不够。
- focus-visible 使用现有交互 token 的 2px 外描边，不能只改背景。
- Escape 不作为唯一返回方式；若支持 Escape，必须先让原生菜单/弹层处理，不能覆盖 DSH 默认行为。

## 8. 示例样式

以下示例说明选择器与 token 用法，不要求逐字采用：

```css
.quno-work-entry__count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11px;
  text-align: center;
}

.quno-worker-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  width: 100%;
  min-height: 64px;
  padding: 10px 4px;
  border: 0;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  text-align: left;
}

.quno-worker-row:hover { background: var(--dsw-alias-bg-layer-1); }
.quno-worker-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.quno-worker-row__title { font-size: 14px; font-weight: 600; line-height: 20px; }
.quno-worker-row__worker,
.quno-worker-row__activity { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.quno-worker-row__status { grid-column: 2; grid-row: 1 / span 2; align-self: center; font-size: 12px; }

.quno-worker-header { position: sticky; top: 0; z-index: 2; background: var(--dsw-alias-bg-layer-1); }
.quno-worker-header__actions { display: flex; justify-content: space-between; gap: 8px; }
.quno-worker-header__meta { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; }

@media (max-width: 720px) {
  .quno-worker-row { min-height: 60px; }
  .quno-worker-header__meta { flex-wrap: wrap; }
}
```

## 9. 程序设计

### 9.1 单一 WorkerProjection

所有视图都从 Ticket + 最新 Assignment + 当前/最近 WorkerRun + Report + Session 活动计算，不新增 WorkerRecord：

```ts
type WorkerPresentationStatus =
  | 'accepted' | 'running' | 'waiting' | 'needs-you'
  | 'done' | 'failed' | 'cancelled' | 'dropped'

interface WorkerProjection {
  workerId: string             // 永远等于 ticketId
  workerLabel: string          // 仅展示，不用于路由或授权
  taskTitle: string
  assignmentId: string
  executorSessionId: string
  status: WorkerPresentationStatus
  activityKind: string | null
  lastActivityAt: number | null
  resultRevision: string | null
  canStop: boolean
  canRetry: boolean
  canAnswer: boolean
  canOpenSession: boolean
}
```

`workerLabel` 可由 ticketId 的稳定短哈希派生，例如 `Worker 02f803ec`；它不保证跨系统唯一，也不是权限凭证。所有 Remote 命令只接受 ticketId。

### 9.2 状态投影示例

```ts
function projectWorkerStatus(input: {
  ticketEnded: string | null
  hasQuestion: boolean
  hasActiveRun: boolean
  reportState: string | null
}): WorkerPresentationStatus {
  if (input.ticketEnded === 'stopped') return 'cancelled'
  if (input.ticketEnded === 'completed') return 'done'
  if (input.ticketEnded === 'failed') return 'failed'
  if (input.ticketEnded === 'dropped' || input.ticketEnded === 'closed') return 'dropped'
  if (input.hasQuestion) return 'needs-you'
  if (input.hasActiveRun || input.reportState === 'progress') return 'running'
  if (input.reportState === 'waiting' || input.reportState === 'ready') return 'waiting'
  if (input.reportState === 'blocked' || input.reportState === 'failed') return 'needs-you'
  return 'accepted'
}
```

persistent Ticket 的 ready 不直接等于 done；它只产生新的 `resultRevision`，列表可显示「有新结果」，由 Ticket/Thread 结束规则决定最终 done。

### 9.3 导航示例

```ts
async function openWorker(ticketId: string) {
  const detail = await remote.workerDetail(ticketId)
  if (detail.ticketId !== ticketId) throw new Error('worker identity mismatch')
  if (detail.executorSessionId === null) {
    navigation.showMissingWorker(ticketId)
    return
  }
  const returnContext = navigation.captureMainContext()
  await workspace.openSession(detail.executorSessionId, { interactionMode: 'inspect' })
  navigation.enterWorker({ ticketId, returnContext })
}

async function backToQuno() {
  const mainSessionId = store.currentMainSessionId()
  const context = navigation.currentReturnContext()
  await workspace.openSession(mainSessionId, { interactionMode: 'interactive' })
  if (context !== null) navigation.restoreMainContext(context)
  navigation.clearWorkerContext()
}
```

- `workerDetail` 必须在 Host 根据 ticketId 解析 executorSessionId，客户端不能传任意 sessionId。
- `openSession` 失败时不进入 worker 状态，显示真实错误并留在原页面。
- `enterWorker` 只记视图，不写领域库。
- 返回时先打开主会话，再恢复滚动和右栏，避免恢复到错误会话。

### 9.4 inspect 客户端与 Host 示例

**Client：**

```tsx
function ConversationInputRegion({ interactionMode }: { interactionMode: string }) {
  if (interactionMode === 'inspect') return null
  return <StockConversationComposer />
}

function visibleQueueRows(rows: InboxRow[], isInternalSource: (source: MessageSource) => boolean) {
  return rows.filter(row => !isInternalSource(row.source))
}
```

`isInternalSource` 由 Quno 仅注册到自己的主会话，匹配 `presentation='internal'` 与旧 Quno source kind；不能全局隐藏其他插件的程序消息，真实用户排队消息必须保留。

**Host / Session Controller：**

```ts
async function submitUserMessage(binding: SessionBinding, message: UserMessage) {
  if (binding.interactionMode === 'inspect') throw new Error('session-read-only')
  await binding.appendUserMessage(message)
}

async function submitProgramInput(binding: SessionBinding, input: ProgramInput) {
  await binding.appendProgramInput(input)
}
```

`submitProgramInput` 代表 Host 自己的 TicketInput、Worker 输出、工具结果和 flush，inspect 不得拦截。普通 work 会话默认 interactive，行为不变。

若现有绑定无法承载 interactionMode，按 fork 流程增加通用字段与提交门，不得只靠 CSS 声称完成。

### 9.5 主对话沟通准入

- `quno_task` 在主会话 tool view 返回 null；其 meta 可供工作列表使用。
- progress 与无问题 waiting 不进入主对话，只更新 WorkerProjection。
- ready、failed、带 question 的 blocked/waiting、cancelled 才进入主对话；persistent 只对新 resultRevision 汇报。
- `quno-eval`、`quno-report`、`quno-notify`、`quno-task` 等内部输入由 ConversationNodeDefinition 独占隐藏，保留 Turn 绑定。
- QueueDock 对程序 source 做展示过滤，真实用户排队消息保持原行为。
- Assessor 投递前重读 Ticket；取消或被后续结果取代的旧 Report 不再发送。

## 10. 模块落点

| 模块 | v2 改造 |
|---|---|
| `core/engine.ts` | 保持领域事实，不为 UI 新增 Worker 状态 |
| `app/assessor.ts` | 按沟通准入过滤 progress/waiting，重验取消和 resultRevision |
| `app/executor.ts` | 保持执行与 onChange；导航不得调用 launch/resume |
| `api-types.ts` | 增量 WorkerProjection、workerDetail 与诊断类型 |
| `api.ts` | 统一投影、按 ticketId 解析 executorSessionId、执行 TaskCommand |
| `preset.ts` | 第一人称，只接话/澄清/结果，不展开 Worker 计划 |
| `client/index.tsx` | 注册工作入口、工作列表、Worker 会话头；主会话 quno_task tool view 改空 |
| `task-list.tsx` | 改为纯 Worker 行列表，行直接打开会话，无嵌套按钮 |
| `task-detail.tsx` | 摘要变成会话内可选折叠，不再是必经中间页 |
| 新导航模块 | returnContext、openWorker、backToQuno、焦点与缺失处理 |
| `report-turn.ts` | 内部 source 的隐藏与 Turn 绑定 |
| `locales.ts` | 全部 UI 文案、可访问名称、状态与空错态，中英双语 |
| DSH QueueDock | 通用程序输入展示过滤 |
| DSH Conversation/SessionController | 通用 inspect interactionMode 与提交门 |

不需要 taskActivity Remote，不自绘 transcript，不新增 Electron 业务 IPC。

## 11. 异常、恢复与隐私

- Worker 不存在、session 缺失、打开失败、返回失败都是独立状态，不静默回退到错误会话。
- 进入/离开 Worker 不改变 WorkerRun，不取消活跃 turn。
- 结果在 Router 忙时排队，当前回合结束后处理；重启按 messageId 去重。
- Worker 已完成未 relay 时只恢复 relay，不重新执行。
- inspect 只拦用户提交，不拦 TicketInput、Worker 输出、工具调用和 flush。
- 普通 work 列表与搜索继续隐藏 Quno/Executor 会话。
- 诊断信息按需加载，不把完整 Session 放进工作列表轮询。
- 取消与完成竞争时取消优先；晚到证据保留但不重新打开工作。

## 12. 实施顺序

### P0：主对话降噪

- quno_task 主会话 tool view 改空；
- 内部输入入队前/入队后隐藏；
- 第一人称接话与结果；
- progress/waiting 不再进入主对话；
- 完成、失败、问题、取消的正确表达。

### P1：工作列表与原生会话

- WorkerProjection 与列表；
- 顶栏工作按钮和 badge；
- inspect interactionMode 与 Host 提交门；
- 直接进入 Worker 会话与返回；
- 焦点、加载/空/错/缺失、窄屏。

### P2：活动与复杂状态

- 真实活动标签；
- persistent resultRevision；
- 多 Worker 并发、长任务、重试和结果未送达状态；
- 键盘、读屏与完整浏览器验收。

### P3：后续独立项

- 长 CLI Job、外部写与审批、Typert stream、全文轨迹搜索。

## 13. 验收矩阵

| 层 | 必须通过 |
|---|---|
| 主消息流 | 无 Worker/子会话/requestId/工具参数/内部队列；只有接话、必要澄清、结果 |
| 工作入口 | 计数正确，needsYou 不重复计数；空态也可进入；键盘和读屏名称完整 |
| 工作列表 | Worker 与任务一一对应；状态真实；刷新失败不清空旧列表；无横向滚动 |
| Worker 会话 | 打开正确 executorSessionId；原生内容；无 composer；程序事件继续追加 |
| 返回导航 | 主会话、草稿、滚动、右栏、焦点恢复；进入返回不触发 launch/resume/stop |
| inspect | 用户提交在写日志前拒绝；不能编辑队列、改模型权限或拖入附件 |
| 结果 | ready/failed/question 只呈现一次；取消后无晚到完成；重启不重复 |
| 可访问性 | 键盘全程可用、focus-visible、状态不只靠颜色、reduced-motion 生效 |
| 响应式 | 1100/720/480px 三档无布局破裂，长 ID 不撑破 |
| 隐私 | 无 token/env/system prompt/私有 reasoning；伪造 sessionId 不能读其他任务 |

### 必加真实评测

- `main-conversation-no-worker-leak`；
- `work-entry-count-and-empty-state`；
- `worker-list-open-and-return-keyboard`；
- `worker-inspect-reject-submission-while-events-continue`；
- `worker-navigation-does-not-restart`；
- `worker-result-once-after-restart`；
- `worker-list-narrow-and-long-content`；
- `worker-missing-session-no-auto-create`。

其中主对话无泄漏、Worker 往返、inspect 拒绝提交、返回状态恢复是 P0。

## 14. v2 最终自审

- **是否仍有子对话信息进入主消息流？** 没有。工作入口和计数在顶栏，Worker 详情只在工作列表与 Worker 会话。
- **是否必须经过任务详情页？** 不经过，列表行直接进入原生会话，减少路径分叉。
- **是否用假 transcript 代替真实会话？** 没有，复用 DSH 原生 Conversation/Chat。
- **是否只靠 CSS 实现只读？** 不是，Client 隐藏交互，Host 在写日志前拒绝用户提交。
- **inspect 是否误伤 Worker 运行？** 不拦程序输入、工具结果、Worker 输出和 flush。
- **Worker 标签是否成为第二身份？** 没有，标签只展示，路由与授权只用 ticketId。
- **是否有第二份 Worker 状态？** 没有，WorkerProjection 可从持久记录重算。
- **是否有嵌套按钮、颜色唯一状态、手写业务 hook？** 示例均避免；组件只收纯 props 和回调。
- **是否覆盖空、错、加载、缺失、窄屏、键盘和读屏？** 已补齐。
- **是否保留历史证据？** 保留，不改写旧日志，只调整投影。
- **是否把返回导航变成业务副作用？** 没有，导航只改变查看绑定，不触发执行命令。
- **是否能直接伪造 sessionId 读其他会话？** 不能，Host 从 ticketId 解析目标并校验归属。

## 15. 最终定稿

1. 主消息流只有用户与 Quno，没有任何子对话或 Worker 技术信息。
2. 顶栏「工作」是唯一入口；列表以任务标题为主、Worker 标签为辅，直接打开原生 Worker 会话。
3. Worker 会话是原生只读检查，不是可编辑子对话；「返回 Quno」始终可见。
4. 进入/返回只改变查看绑定，不重启执行；返回后主会话身份、草稿、滚动、右栏和焦点连续。
5. 主对话只在接话、必要澄清、实质结果、失败和取消时发声；其他过程只在工作中呈现。
6. 所有视图统一 WorkerProjection，禁止第二份状态、第二套 transcript 和第二套消息队列。
7. UI 必须同时通过真实链路、DOM、键盘、读屏、窄屏和异常恢复验收，不能只以工具测试全绿作为交互完成标准。
