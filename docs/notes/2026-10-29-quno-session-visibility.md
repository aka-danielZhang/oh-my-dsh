# Quno 主会话与后台会话统一隐藏

## 决策

Quno 的永久主会话、分析会话和委派子会话均不出现在普通工作区树、扁平列表或搜索结果中。主会话仍由 Quno 原生入口打开，后台会话仍从任务卡或运行记录进入；`quno_recall`、Host 搜索、Workspace 成员关系和 durable Session 日志不受显示过滤影响。

现有 `origin: 'subagent'` 过滤继续负责后台会话。fork 的 `UiWorkspace` 新增通用 `registerSessionVisibilityFilter`：每次注册返回幂等 disposer，注册/注销发布版本变更，三种视图统一重算。Quno 客户端注册 `agentPreset === 'quno'` 的过滤，不在共享 WorkspaceBrowser 中写死 Quno 分支，也不以 CSS 伪装过滤。该注册不随 Quno 总开关 disposal，避免关闭助手后主会话重新落入 work 列表；旧 runtime 没有此方法时仅新增主会话过滤不生效，其余功能不变。

## 理由

- 主会话不是 subagent，不能复用原生 origin 规则，也不能为了隐藏而伪造 origin。
- DOM/CSS 无法同时覆盖分组计数、扁平成员、搜索结果与排序状态。
- 通用注册点把可见性规则留在功能插件内，避免共享 UI 层认识 Quno preset。

## 验证

- fork 聚焦套件 180 项通过：注册/重复注册/幂等注销、工作区树、扁平列表、本地与 Host 内容搜索、版本变更重算，以及 subagent 原生过滤。
- `dsh-quno` 全套 135 项、`pnpm run typecheck` 与 `pnpm run build` 通过，覆盖 Quno preset 判定和其他 preset 不受影响。
- Cordis Client Runner 116 项通过，API 目录包含新注册方法；fork `pnpm run build:artifacts` 后接 `pnpm run build:check` 通过。

## 发布状态

本能力已随 fork `v0.2.1-rc.2+zw.8` 发布，14 个 `@crazx/*` 的 `0.2.1-rc.2.zw.8` 包均已核验；发布 Workspace tarball 的 JS 与类型声明包含新注册方法。本次按用户要求不改 desktop 版本，也不更新 `runtime/revision.json`；桌面后续消费时必须钉到包含该能力的 fork tag，当前 zw.7 不会获得主会话新增过滤。
