# Quno 交互补全（2026-10-27）

本文记录 2026-10-27 对 Quno 交互稿的落地方案与实施结果：哪些按稿实现、哪些按真实接缝调整，以及为了「不伪造运行状态」而固定的文案与契约。方案评审结论见 `docs/quno-bot-design.md` §20；实现以代码为准。

## 背景

交互稿提出：Sense 详情钻取、三栏接入向导、右栏任务详情、会话头胶囊概要、按回合绑定的主动汇报卡、关注完结分组。核对 `v0.2.1-rc.2+zw.7` 源码后确认：

- 这些交互都能用现有接缝承载，不需要新增 Electron IPC、不需要重写 WorkspaceBrowser/WelcomeHero、不需要改 AgentLoop；
- 唯一必须在「稿子」与「真实接缝」之间做取舍的是：独立居中的首开欢迎画布、原生侧栏 Quno 行的副标题与徽标（都需要 fork 加法接缝），本次**不做**；
- 另有一批稿子文案与真实语义不符（游标/首次同步/重试/缺口），实现时按真实语义改写，而不是照抄。

## 决策

1. **侧栏保持原生**：Quno 入口仍是 `main` + `sidebar.panellist` 的原生面板行；不实现稿子里的 36px 区头、34px 工作区行、32px 会话行。搜索、视图、菜单、拖拽全部保留 stock。
2. **胶囊留在会话头工具区，点击出概览浮层**：`conversation.session.header.utilities` 里的胶囊从「点击直接展开右栏」改为「点击展开三行概要（动态/关注/任务），点某行带 `view` 参数打开右栏」。外部点击、Escape、右栏展开都会关闭浮层。
3. **三栏向导走应用内大 Modal**：`shell.overlay` + `min(1120px, viewport-64px)`，左类型 / 中表单 / 右「接入后会发生什么」。原生 800px 设置弹窗容纳不下三栏；也不挂 `settings.onboarding`（那是全局首次启动流程）。
4. **Sense 详情复用右栏面板**：动态列表行变成真正的按钮，进入详情后返回恢复列表；参数 `{ senseId, view }` 支持胶囊/设置直达；实例被删或类型未加载时显示「实例不存在」，不崩溃。
5. **表单字段驱动**：`configFields` 扩展 `min/max/step/options/multiple/discover/advanced`；跨字段规则（日历 file/directory）仍由 Host 校验并原样回传错误；没有字段声明的第三方 Sense 保留原始 JSON 模式。
6. **`probe` 与同步分离**：新增 `probeSense`，只调用 factory 的 `probe`；不重启实例、不改 `configRevision`、不动 checkpoint、不写健康、不报告同步成功。
7. **选项发现是通用 Host 能力**：`senseOptions({ type, field, config, page, limit })`，只允许声明了 `discover: true` 的字段；传入草稿配置（不要求整份配置合法）；Host 负责边界、去重、脱敏与错误分类。云之家实现 `im group recent`，`groupType != 2` 的会话显示但禁用并给出真实原因。
8. **汇报卡绑定 Turn**：Host 已在 `user/message.source` 持久化 `notificationId`；客户端注册一个 `ConversationNodeDefinition`，把带 `quno-notify`/`quno-task` source 的消息折成一个**隐藏的 Chat node**，`ChatNodeStore.turnDataSource(turn, 'quno-notice')` 按回合回读。于是不再有「一小时后按钮消失」「相邻两条汇报串卡」；重新加载后仍能渲染。历史通知超出 30 条快照时用 `noticeDetail` 按需读取。
9. **任务取消纪律**：新增 `cancel`（`abandon` 成为别名）。先持久化取消意图，再 dispose 子任务；所有晚到的完成/失败/中断结果在写状态前检查 durable status，取消后不改状态、不再发完成通知；重复取消幂等；重启对账不会复活已取消任务。
10. **密钥不出 Host**：`state()` 对声明 `secret: true` 的字段下发 `null` 并给出 `secretSet`；编辑时 `null` 表示「保持不变」，Host 在校验前回填存储值；显式清空传空字符串。浏览器永远拿不到明文。

## 未做 / 延期

| 项 | 原因 |
|---|---|
| 独立居中的首开欢迎页 | `conversation.hero.options` 是紧凑选项区，不是独立画布；需要 fork 加法接缝，本次不改运行时 |
| 原生侧栏 Quno 行带副标题/未读徽标 | 槽只提供图标与单行标签；用 CSS 伪装或再占一个槽都会破坏原生语义 |
| 任务「第几步 / 工具调用 5/8 / 单轮 120s」实时步骤 | 现有委派数据没有步骤状态机；8 次工具与 120 秒是分析预算，不能套到子任务。详情只展示真实状态、静态计划、耗时、结果、产物 |
| 完全只读的子会话 transcript 视图 | `openSession` 打开的是正常会话（composer 可用）；按钮文案改为「查看子会话（只读执行权限）」，执行权限才是真实的只读边界 |
| 事件全文/大负载进快照 | `eventDetail` 按需读取、payload 有界（8KB），主对话与 15 秒轮询不变 |

## 诚实文案规则（实现固定）

- 「检查点版本」而不是「游标」：只显示 `v{revision}`，不暴露 opaque 原始值。
- 「最后成功同步」旁必须给缺口/覆盖范围提示：成功 ≠ 完整捕捉。
- `nextRetryAt === null` 显示「未安排（失败后采集循环会自行退避重试）」，不是「不再重试」。
- `healthy + stale` 显示「连接正常，但数据可能陈旧」。
- gaps 文案是「最近记录的缺口」，不是「当前未解决缺口」。
- 首轮语义按类型声明 `firstSync`：`baseline-only`（云之家）、`snapshot-events`（本地日历）、`current-window-events`（订阅源）、未声明为 `unknown`。
- 创建成功只说明「已保存，正在首次同步」；健康以真实结果更新。
- 探测结果只说明可达性，不写成同步成功。

## 落点

- Host：`src/types.ts`（声明扩展）、`src/contracts.ts`（schema）、`src/senses.ts`（probe/options/secret 回填）、`src/api.ts`（wire + 掩码 + 详情）、`src/service.ts`（四个新 Remote 方法 + 取消）、`src/tasks.ts`（cancel + 晚到防护 + plan）、`src/store.ts`（tasks.plan、findNotice）。
- Remote：`src/api-types.ts`、`src/typert.remote-client.ts`（`probeSense`/`senseOptions`/`noticeDetail`/`eventDetail`）。
- 客户端：`sense-detail.tsx`、`sense-form.tsx`、`sense-onboarding.tsx`、`task-detail.tsx`、`report-turn.ts`、`report-actions.tsx`、`panel.tsx`、`capsule.tsx`、`settings.tsx`、`right-tab.ts`、`store.ts`、`locales.ts`、`index.tsx`。
- Sense 包：yjz 增 `listOptions` + 首轮语义 + 字段元数据；日历/订阅源补 `firstSync` 与数值边界。

## 验证

- `dsh-quno`：typecheck / build 通过；测试 94 项（新增 probe、选项发现、密钥掩码、取消与晚到 settle、计划持久化、右栏参数、字段元数据契约）。
- `dsh-quno-sense-yzj`：typecheck / build 通过；测试 18 项（新增最近会话解析、可选项禁用原因、声明元数据）。
- `dsh-quno-sense-calendar` / `dsh-quno-sense-feed`：typecheck / build 通过；各 7 项测试通过。
- 实机冒烟（scratch `DSH_HOME`，未污染真实 `~/.dsh`）：`dsh plugin add` 四个包 → `dsh web --port 4871` 正常启动并创建 `$DSH_HOME/quno/quno.sqlite`；三个 Sense 声明（含新 `firstSync`/字段元数据）全部注册成功（`sense_types` 表含 `quno/calendar`、`quno/feed`、`quno/yzj-im`）；boot graph 含 `dsh-quno/client.js`，组合请求返回 200 且产物包含 `quno-onboarding` 与 `quno-notice`。
- 冒烟发现并修复的既有问题（两处）：
  1. `package.json#exports` 缺 `./task-guard`，而 `quno-task` preset 的 `quno-task-guard` 行按 `dsh-quno/task-guard` 解析——link/打包安装下该行「never started」。已补 export 并用 `import('dsh-quno/task-guard')` 验证。
  2. `dsh.client.inject` 缺 `@deepseek-ai/dsh-client-ui-conversation`、`-ui-chat`、`-ui-workspace`：`ctx.get('uiConversation')` 与 `openSession` 都依赖它们先挂载，否则汇报卡绑定会静默失效。已补齐（与 ui-plan/ui-schedule 的 inject 口径一致）。
- 桌面侧既有壳探针与实机交互验证留给发布前按 `docs/quno-bot-design.md` §15 执行。
