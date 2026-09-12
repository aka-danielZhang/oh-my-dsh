# dsh-scheduled-tasks 实现决策记录

2026-09-11 · 配套设计：[2026-09-11-scheduled-tasks.md](2026-09-11-scheduled-tasks.md)（语义、验收矩阵以设计文档为准；本文记录实现层取舍与偏差澄清）。

## 落点与形态

- 新插件 `plugin/dsh-scheduled-tasks/`，dual 面，脚手架生成后扩展为三行 bundle patch：
  - `dsh-scheduled-tasks`（core 行）：`ScheduledTasksService extends TypertRemoteService`（`super(ctx, 'scheduledTasks')` 构造即 provide），CRUD + 全局调度器 + managed registry。**行 id = 包名**，loader 由此服务本包 `client.js`（同 dsh-usage-stats 主行）。
  - `scheduled-tasks-ohmymemo`（adapter 行）：梦境记忆只读投影。
  - `scheduled-tasks-api`：strict Typert 注册（`invocations: TYPERT_REMOTE.descriptors`，绕开装配 runtime 下 @Remote 标记模块实例分裂导致端点 404 的坑，dsh-usage-stats 同款）。
- 数据 Storage Domain `dsh_scheduled_tasks` v1：`tasks`（定义）/ `runtime`（每任务游标 + fence）/ `runs`（fenced run audit）。runtime 记录比设计 §6 多两个字段：`activeSessionId`（waiting-input 观察与崩溃归因）与 `fence`（每任务单调计数器直接落 runtime，audit 冗余存自身 fence）。

## Host 实现决策

1. **无需 schemastery**：cordis loader 对 class 行恒以 `new Class(ctx, config)` 实例化（cordis lib index.js:1066），`static Config` 只用于校验；core 行 constructor 直接 `validateScheduledTasksConfig(rawConfig)`（手写、fail loud），不引入 schemastery 依赖。
2. **sessionId 在 claim 时预生成**：`mintRunIds()` 同时产出 runId 与 `sched-` 前缀 sessionId 并写入 claim audit。崩溃落在 launch 事务的任何一点，audit 都能归因同一个 session（`launch.ts` 只是消费这个 id），恢复路径据此结算 `interrupted` 且绝不重放该边界。
3. **崩溃恢复语义**（设计 §8.3/§12 的落地）：`claimed` / `session-created` 孤儿 → 结算 `error`（detail 区分两阶段，session-created 提示 session 可能残留），`lastScheduledFor` 已在 claim 时推进，该边界视为已消费；`commitIntent: 'terminal'` 但前滚未完成 → 幂等重放前滚；fence 不匹配的陈旧写直接丢弃。
4. **DST gap 的实现语义**：`wallTimeToInstant` 两次 offset 迭代收敛失败（spring-forward gap）时取候选中的较大者——即「不早于跳变结束的等价墙钟时刻」（如 NY 02:30 → 03:30），保证当日恰好一次；fall-back 重叠取较早 instant（两次迭代自然收敛到 EDT 侧）。测试钉死 NY 2026-03-08 / 2026-11-01 两个用例。设计 §8.1「跳变后第一个合法时刻」接受此实现口径（仍在跳变后同日、当日一次）。
5. **refreshDomain 必须 close-before-open**：storage facility 只在旧 handle `close()` 完成后释放域名，`bindDomain(await open(...))` 的参数先求值会 `already-open`（首启实测踩坑）。现在 `refreshDomain` 先置空句柄 → `await old?.close()` → 再 open，并用 `refreshTail` promise 链串行化并发刷新；teardown disposer 排空 mutation tail 后关闭 domain。
6. **并发上限即有界队列**：`reconcile` 只启动 `maxConcurrentRuns` 个 due 任务，剩余 due 不推进 `lastScheduledFor`；run 结算后的 `reconcile('wake')` 把它们捡起。进程退出时未 claim 的边界不算已执行，重启后仍由 catch-up 恢复（与设计 §8.2 的队列语义等价，无需显式队列结构）。
7. **Model route 预验证**：create/update 时（`verifyExecution`）与每次 launch 时都 `llm.resolveCallConfig` 验证；「跟随默认」在 launch 时解析 `agentDefaultModel.currentSelection()` 全量快照。固定 route 不可用 → 本次 Run error，不静默替代（设计 §7）。
8. **首请求前钉模型**：采用 webhook 的 `installInitialModelSelection` 姿态（拦截 `agent/request` 至首个 durable request header），而非 dsh-agent 的 `installModelSelection`——后者带 durable 模型切换 notice，是给会话中途换模型用的，不适合创建时钉选。

## Adapter 行 fail-soft（对设计 §5.1 的修正）

设计原案 adapter 行 `inject: ['scheduledTasks', 'ohMyMemoUi']`。实测本仓 runtime 对 pending entry 是 **fail loud**（`dsh: 1 entry did not activate` 直接拒绝整个 profile 启动），会拖垮 core——正是设计 §15.4 明令禁止的。修正为：

- `inject: ['scheduledTasks', 'timer']`（均为必有服务）；
- `ohMyMemoUi` 在 apply 内 optional 读取，缺席时以 `ctx.timer.interval` 每秒重试（60s 放弃）——兼顾「dsh-ohmymemo 同批安装但激活顺序不定」与「单独安装本插件时零伪造零等待」；
- 拿到服务后 `registerManaged`，disposer 随 fiber 撤销投影。

## Client 实现决策

- ~~`settings.section` 注册 id `scheduled-tasks`、order 13、`label: () => t('nav')`~~ → **当日二次改版已撤除**，见下节。
- 样式按设计 §13 手写 `<style>`（`data-plugin` + `data-plugin-css` 标记、幂等插入），不用 CSS Modules 构建链；类名统一 `dsh-stask-*` 前缀；颜色只用 `--dsw-*` token；760px 容器查询切单列。
- 行级 Switch 乐观更新，失败重读回滚；删除用两步确认按钮（4s 超时复位），不引入嵌套弹层；CAS 冲突自动重读并在编辑态合并最新快照。
- 轮询单飞（inflight guard）+ 编辑态暂停轮询（避免表单被刷新打断）；aria-live 只对真实动作（保存/删除/开关/冲突）播报一次。
- `waiting-input` 活动状态的 Host 检测（扫描 `approval/asked`/`approval/decided` 事件对）首版未做，活跃 run 一律报 `running`；UI 词汇表与行渲染已支持该状态，补检测是纯 Host 增量。

## 二次改版（2026-09-11：五类调度 + 侧栏入口 + composer 化编辑器）

设计与验收口径见 `2026-09-11-scheduled-tasks.md` §18；此处只记实现取舍。

### 调度规则泛化

- `schedule.ts` 从「daily 边界」泛化为一套 `ScheduleRule` 走子：`hourly` 按墙钟小时逐格走，其余四类按墙钟日期走（`firesOn` 判据），前进/回退共用同一循环（`MAX_DATE_STEPS = 400`、`MAX_HOUR_STEPS = 48` 上限，越界 fail loud 而不是静默给错边界）。原 `nextDailyBoundary` / `latestDailyBoundary` 被 `nextBoundary` / `latestBoundary` 取代，导出面收敛。
- 迁移零成本：持久化仍用 `localTime` 字符串，`daily` 成员字段集不变（`kind` + `localTime` + `timeZone`），**domain 不 bump version、无 preprocess 迁移**；新增 `hourly.minute` / `weekly.dayOfWeek` / `monthly.dayOfMonth` 三个判别分支。`managedTaskStateSchema` 不能再 `.extend()` 判别联合，改为独立的 `managedScheduleSchema`（五个成员各带 `timeZonePolicy`）。
- `scheduleSpecError()` 是服务层对 wire 的第二道闸（Remote 描述符已用 zod 解析），保证直接调用 service 也得到稳定 `TASK_VALIDATION` 文案；`scheduleRule()` / `scheduleFromSpec()` 负责两个方向的形状转换，都在 contract.ts，client 只 type-only 引用。
- session 标题后缀改用 `scheduleLabel(rule)`（如 `[定时] 每日仓库巡检 · 每天 02:00`、`· 每周一 09:00`），不再假设 `localTime` 存在。

### 入口与预设

- Client 入口两件套：`main` 座 keyed 注册（`key: 'automation'`，`inject` 下发 face/t）+ 侧栏会话区标题行的时钟按钮（`entry.ts`）。为此新增 type-only 依赖 `@deepseek-ai/dsh-client-ui-layout`（devDep 钉 0.1.5-rc.1、peer range 同步补），`dsh.client.inject` 的 `dsh-client-ui-settings` 换成 `dsh-client-ui-layout`。
- 装饰按钮的存活策略：`MutationObserver`（60ms 合并）+ `window.resize`，每轮扫描重新解算 `left/top`（以被锚定行的 `getBoundingClientRect` 为坐标系，间距取该行实测的两个 stock 控件间隙，缺实测值回落 8px）；按钮只 `appendChild` 到行末，React 不受干扰；锚点找不到就移除按钮退场。卸载时删按钮、还原行的 `position`、断开 observer。
- 面板挂载期间在 `document.documentElement` 上写 `data-dsh-stask-panel`（卸载即删），按钮据此决定「切到面板」还是「回会话」并显示按下态——不读别的插件状态、不引额外服务。
- `agentPreset` 固定 `standard`：Client 请求恒带，UI 不给预设选择（也不占位显示）；Host 侧保持通用校验，不做特判——策略单点在 Client。

### 编辑器（对齐 composer，全量重写）

- 新增 `chips.tsx`（Chip / WorkspaceChip / ModelChip / PermissionGlyph / InstructionText）、`ScheduleRow.tsx`（字段下拉 + 双列时间滚轮 + 摘要）、`AutomationPage.tsx`，删除旧的 `ScheduledTasksSection.tsx` 与 `lang.ts`（新页面不需要语言分支，全部走 `ctx.locale`）。
- 图标全部 import `ui-primitives`（chevron / 文件夹 / 勾 / 加号 / 刷新 / Switch）；唯一内联的是权限盾牌三态字形（`ui-conversation` 未导出）。Switch 换成 stock `Switch` 原语，删掉自绘开关与其 CSS。
- 时间滚轮：菜单 `left/right: 0` 与触发器等宽、两列 `flex: 1 1 0` 等宽、`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`、打开时 `scrollTop` 居中当前项（`position: relative` 的列内用 `offsetTop`，不用会连带滚页面的 `scrollIntoView`）。
- 任务行的运行次数 pill 改为诚实的「上次执行 <相对时间>」/「尚未执行」：Host 契约没有 run 计数，`lastAttemptAt` 是唯一事实源。
- 工作区菜单保留 hero picker 的「添加工作区…」底行，但点击只播报「请在对话框的工作区选择器里添加工作区」——本插件没有 directory flow 的占用者，摆一个会坏掉的按钮更糟。

## 跨插件边界

- 不 import dsh-ohmymemo 任何符号：adapter 行内 structural 声明 `DreamOverview` 最小叶子（dream 子对象 12 字段）。
- `source.kind: 'scheduled-task'` 经 `declare module '@deepseek-ai/dsh-llm'` 的 `MessageSourceMap` 扩展声明（webhook/types.ts 范本），纯类型侧扩展，不改 fork。

## 依赖解析教训（`docs/desktop-plugin-integration.md` 实证）

Node ESM 按导入文件实际路径解析依赖：插件 devDep 的 `@deepseek-ai/dsh-storage-domain`（npm 副本）内部 import `@deepseek-ai/dsh-storage` 与 `@deepseek-ai/dsh-invariants`，二者必须作为本插件显式 devDeps 存在（`autoInstallPeers: false`），否则 Host 启动即 `Cannot find package`（与 2026-09-08 OhMyMemo 故障同构）。本次同样补齐 `dsh-scope` / `dsh-system-prompt`。

## 验收状态

首轮（2026-09-11 上午）：typecheck / 18 项单测（boundary 10、lease 4、contract+descriptor 4）/ build 全过；隔离 `DSH_HOME`（/tmp/dsh-stask-home，scratch profile + 钉定 runtime `v0.1.5-rc.1+zw.2`）实测：Host 三行激活、`client.js` combo 200、`list/create/setEnabled/catalog` 全链路通、CAS 冲突与 managed 拒绝按预期、重启后任务定义/暂停状态/revision/nextRunAt 完整保留、无 dsh-ohmymemo 时列表无伪造系统任务。

二次改版（同日）：typecheck / 29 项单测（boundary 18：五类规则 + gap/overlap 一次性 + 月度跳过 + catch-up；lease 4；contract+descriptor 7：五类 spec 往返、越界与外来形状拒绝、legacy daily 记录仍可解析、descriptor 六方法）/ build 全过；client bundle 仅 `require` react / react/jsx-runtime / `dsh-client-ui-primitives`；隔离实例 API 冒烟见下节。

### 三次微调（同日，GUI 评审后）

- **刷新控件**：撤掉手绘方形按钮，改 stock `Button`（`variant="toolbar"` + `size="md"` + `Tooltip` + `IconRefreshOutline16`，刷新中转圈、`prefers-reduced-motion` 降级），与 usage-stats 等设置页插件同一套控件语言；「创建定时任务」同批换成 stock `Button variant="primary" size="md"`。
- **任务卡**：从双列网格改**整宽单列列表**（模板区仍为网格）：标题 + 右上「⋯」披露菜单（立即运行 / 暂停·恢复 / 编辑；分隔线以下固定红色「删除」），描述两行截断，底部左绿 pill（时钟字形 + 调度摘要 + 下次运行）右灰 pill（上次执行/尚未执行）。
- **`runNow`（manual 触发）**：Remote 第七个方法。语义：显式点击即意图——暂停中的任务也能立即跑；运行中拒绝（`TASK_BUSY`）；**不推进 `lastScheduledFor`**（调度游标属于边界走子，手动跑不吞掉错过的边界）；claim 照走 lease + fence + commitIntent，audit/summary 的 `trigger` 枚举加 `manual`（向后兼容存量记录）。service `runNow` 在 mutation 队列内只做检查与 fire-and-forget 的 claim，绝不 await 整个 run（队列不能被一次 agent run 占住）。`claimAndRun` 对 manual 分支：跳过 enabled/cursor 两个守卫、重叠改 warn 不写 skipped。
- 任务卡的行内 Switch/编辑/删除随之移除（菜单即唯一操作面）；「⇄ 刷新中」态用 `refreshing` 驱动。
- **六次改版（同日）：会话绑定模型**。应用户要求把「每次触发新建 session」改为**一个任务绑定一个长期 session**：首跑创建（webhook 事务原样），后续触发复用本进程 live agent（`agents.get`）或 `agents.resume` 恢复持久会话，重设权限预设与标题后以 plugin-origin 消息追加本轮指令；run 结束后仅 dispose 本轮新建/恢复的 handle（复用从不 dispose 别人的）。`runtime.sessionId` 首个 claim 时绑定并持久化（`.default(null)` 存量免迁移），claim 决定 session id 故崩溃归因不变；工作区只在创建时生效——update 拒绝变更（`TASK_VALIDATION`），编辑页工作区芯片锁定。**历史页**：编辑页增设「设置 / 历史」页签，历史为运行记录表（触发时间/来源/状态/时长 + 行内 ⋯：跳到会话/删除记录）；wire 新增 `listRuns`/`deleteRun`（共九方法），`deleteRun` 拒绝删除执行中的记录（`TASK_BUSY`）、新增 `TASK_RUN_NOT_FOUND`；跳到会话 = `layout.selectPanel(null)` + `sessions.open(sessionId)`。
- **七次微调（2026-09-12）：入口锚定回退**。rc.55 正式版装上后按钮不出现——静态版入口锚定 `button[aria-label="搜索会话"]` 在真实 fork DOM 里失配（stock `Tooltip` 包裹/文案变体），而预览版同一按钮用「会话标题文本 → 上溯含 ≥2 按钮的行」一直正常。修复：aria 锚为主、「会话/Sessions/工作区/Workspaces 标题文本」回退（复用预览已验证路径），行定位统一走 `rowOf`（最近含 ≥2 按钮祖先，Tooltip 包裹层不夺位）；插件升版 0.1.1（pin 同步，满足 shipped-plugins 的 pin === version fail loud 契约）。发布链路核实结论：代码 rc.53 起在 main、随包清单含本插件、rc.55 安装事务正常解压注册——按钮缺失是客户端入口锚定问题，与发布产物无关。

- **五次微调（同日）**：删除确认从「两步确认按钮」改为**确认弹窗**（stock `Modal` + 描述「将删除「{标题}」及其后续调度；执行记录会保留，操作不可撤销」+ 取消/红色删除，Esc 与遮罩关闭）——⋯ 菜单出现后两步按钮的第二次点击要重开菜单，交互不成立；确认按钮用 `--dsw-alias-state-error-primary` 填充。决策修订：早前「不引入弹层」的取舍作废。
- **四次微调（同日）**：任务卡回**双列网格**并整卡可点（`role=button` + 悬浮描边，点击/回车进编辑；⋯ 菜单在卡片内 `onClick` 停止冒泡，菜单操作不会误触编辑）；灰 pill 改「已运行 N 次」——runtime 记录加 `runCount`（`.default(0)`，存量行免迁移、domain 不 bump version），claim 时递增并随 wire row 下发；managed 卡不提供计数与操作。

- 待人工 GUI 验收：侧栏时钟按钮位置与按下态、主面板页面视觉（含窄屏）、编辑表单交互（调度行/时间滚轮/指令底栏芯片）、记忆页开关驱动梦境投影（需同装 dsh-ohmymemo 的组合）、真实触发创建 Session 的端到端（需可用模型路由）。
