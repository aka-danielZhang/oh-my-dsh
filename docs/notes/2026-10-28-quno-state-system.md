# Quno 状态体系与界面协调性改造（2026-10-28）

按用户同日技术方案落地：先修状态，再修样式；不新增 IPC、不改 runtime、不改 `WorkspaceBrowser`、不新增数据库字段、不为视觉加轮询。契约同步在 `docs/quno-bot-design.md` §13.4–§13.6、§13.10、§13.11。

## 决策

1. **异步读取是值，不是 `undefined`**。`src/client/store.ts` 新增 `AsyncValue<T> = loading | ready | missing | error`：
   - `missing` 只由 Host 明确返回 `null` 产生，传输失败一律 `error`；
   - 最近事件独立 `eventsStatus` / `eventsError`，后台失败保留旧列表，不改写成空数组；
   - `noticeDetails` / `eventDetails` 缓存缓存的是 `AsyncValue`，仍限 40 条；
   - 每个详情 id 带请求序号，旧响应不覆盖新请求（缓存淘汰后重读的乱序有回归测试）。
2. **页面状态由纯函数决定**。新增 `src/client/panel-state.ts`：动态页 `loading / load-failed / install-guide / first-connect / all-paused / syncing / empty / list`，任务三组、运行/任务/关注状态与文案键、Sense 行状态优先级、创建阶段、投递异常、来源原文可读门控。组件只渲染已决定的状态。
3. **展示原语收敛**。新增 `src/client/panel-primitives.tsx`：`PanelListRow`、`PanelSection`、`DetailHeader`、`DetailSection`、`StatusLabel`、`Callout`、`PanelEmpty`、`InlineEmpty`、`MissingState`、`LoadingRows`、`SegmentedTabs`。`QunoCard` 退回「对话内汇报/任务卡」；左色条只留在对话。
4. **右栏拆页**。`panel.tsx` 只保留页签与导航；新增 `sense-list.tsx`（动态）、`attention-view.tsx`、`task-list.tsx`、`runs-view.tsx`、`run-detail.tsx`、`event-detail.tsx`。运行页不再堆通知正文，`runId` 真正打开运行详情。
5. **详情分层**。Sense 详情默认只给身份/状态/上次成功/配置摘要/当前异常/主操作，诊断信息折叠，停用与删除进独立危险区；任务详情按状态条件渲染，无计划/无产物不留空标题。
6. **设置与向导**。设置组改为标题 + 留白 + 分隔线（来源实例仍是独立描边行），摘要改由 `configFields` 声明驱动（`sense-summary.ts`，密钥永不进入摘要），保存成功短暂出现后消失；向导去掉类型卡实例数，选项按钮用字段语义并把 `type + field + 草稿配置 + page` 作为丢弃旧响应的键，密钥四态、脏关闭「继续编辑/放弃修改」、创建结果按真实阶段展示。
7. **主题**。消息头像改为明/暗两份 data URI，由 `--quno-mark-message-image` 切换；胶囊去阴影、浮层用 `--quno-elevation`（暗色独立取值）；状态 chip 的底色统一改为 `color-mix(状态 token 14%)`，不再用固定 RGBA；补充列表 hover、焦点环与骨架动效。

## 明确不做

- 不新增 Host 方法或字段：运行与通知在 wire 上没有关联 id，因此运行详情不展示「关联通知」，而不是用时间窗猜。
- 不改 `noticeDetail` 语义；`missing` 判定仍以 Host 的 `null` 为唯一依据。
- 未做逐状态截图矩阵：本轮以 typecheck / 单测 / build 与桌面探针为准，视觉逐项验收留待实机走查。

## 验证

```sh
cd plugin/dsh-quno
pnpm run typecheck   # 通过
pnpm run test        # 126 项通过（新增 client-store / panel-state / sense-summary 三组）
pnpm run build       # 通过
```

实机（scratch `DSH_HOME`，未碰正式 Profile）：

- `dsh plugin --profile web add …/plugin/dsh-quno` + `dsh web --port 39870`：boot graph 含 `dsh-quno/client.js`，bundle 200（461 KB，含本轮新文案）；
- headless Chrome 经 CDP 打开该实例：页面正常渲染，`Runtime.exceptionThrown` 与 `console.error` 均为空；
- `DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 pnpm desktop:dev` → `DSH_E2E_OK`，exit 0。

两点环境事实：

1. `desktop:dev` 会把插件 `node_modules` 切到 link 源码姿态，此时 `typecheck` 会因 testkit 的 cordis 身份不一致报错；`pnpm install --force` 恢复 registry 姿态后复跑全绿。这是流程噪音，不是代码问题。
2. 根级 `pnpm run plugins:check` 在 `plugin/dsh-desktop-bridge` 处失败：`plugin/deepseek-harness` 锚指向旧的 `deepseek-harness-0.1.5-alpha.1-adapt`，Context 增强缺失（`locale`/`slots`/`uiWorkspace` 等）。与本轮改动无关，`dsh-quno` 自身的 typecheck/test/build 已单独全绿。

## 深色模式返工（同日二次修订）

用户实机截图暴露三处问题，均已修：

1. **关注卡主操作白底白字**：暗色主题的 `--dsw-alias-brand-primary` 是 `neutral-bluish-50`（近白），而手写按钮用了「brand 底 + `#fff` 字」。所有手写按钮改回平台 `Button`：primary = `button-primary-fill` + `label-primary-foreground`，outline = `border-l3`，ghost = 透明 + hover 交互色。
2. **证据行打印裸 eventId**：`point.quote ?? point.eventId` 会在没有摘录时把内部 ID 显示出来。改为「有摘录显示摘录，可读时补『查看原文』，两者都没有就不渲染」；`sourceId`/`instanceId` 一律经 `sourceDisplayName` / `instanceDisplayName` 解析，缺口行兜底「未知来源」，不再误报「来源已删除」。
3. **页签选中态不可见**：选中样式原本用 `bg-layer-2`，它在暗色里与面板底色只差几个色阶。改为 `interactive-bg-hover` + 品牌色下划线 + 600 字重。

同期一并收口：

- 表面层级：关注卡改 `bg-layer-2`（暗色下比 `layer-1` 更浅，才是「浮起」）；胶囊浮层 `bg-layer-2 + border-l2 + --quno-elevation`；来源行 `border-l2 + bg-layer-1`。
- 输入框对齐平台字段：`0.5px border-l4 + bg-layer-1`，不再用 `bg-base` 在弹窗里挖深井。
- `info` callout 改中性层色（暗色下白色 8% 会被读成警告）。
- 危险区：「停用」用 outline 按钮；「删除 / 确认删除」用 error token 的危险样式（含 hover 与禁用态），不再是无边框纯文本。
- 运行：已结束但没记录 `finishedAt` 的运行不再无限计时（`runDurationOf`），列表与详情都显示「无耗时」而不是越滚越大的时长。
- 状态 chip 的 idle 底色改为按自身文字色 12% 混合，避免与卡片底色融在一起。

验证：127 项测试（新增 `runDurationOf`）；另用 `ui-theme` 真实主题 CSS + 组件 SSR，在 headless Chrome 里明/暗两套截图核对关注卡、Sense 详情、运行页与页签选中态（Button 以等价 token 样式渲染，其余为真实组件输出）。
