# dsh-scheduled-tasks

定时任务：全局 Agent 任务与系统任务目录。入口是**侧栏会话区标题行里、搜索按钮左边的时钟按钮**（2026-09-11 二次定稿：原来的「设置 → 定时任务」一级菜单已撤除），点开主面板 `automation` 呈现任务页；由三部分组成：

1. **用户任务**：标题、五种调度（每小时第 N 分 / 每天 / 每工作日 / 每周 <周几> / 每月 <n> 号，严格 `HH:mm`，创建时钉住 IANA 时区）、任务指令、运行/暂停、编辑与删除。执行固定使用**标准模式（standard）**预设，不在界面上提供预设选择。每次触发通过 webhook 同款事务创建一个普通 root Agent Session（挂载 `standard` 预设、附着工作区、应用权限预设、钉住模型路由、设置标题、以 plugin-origin 消息提交指令）。
2. **调度内核**：单 timer 指向所有启用任务的最早边界；五类规则的边界计算都在固定 IANA 时区里做（spring-forward gap 顺延到跳变后、fall-back overlap 取较早 instant 且只触发一次、每月 31 号在 2 月整月跳过而不折到月末）；12 小时窗口内只补最近一次漏跑；每任务跨进程目录锁（pid + 启动标识 + nonce，绝不按时间偷锁）；fence + commitIntent（`claimed → session-created → terminal`）崩溃恢复；同任务重叠记 `skipped` 不排队；全局并发上限默认 2。
3. **managed Provider registry**：其他插件注册只读系统任务投影（首个为 dsh-ohmymemo 的「梦境记忆」，只读调用 `ohMyMemoUi.overview()`，绝不复制其配置或接管其调度）。managed id 传给任意 mutation 由 Host 返回 `TASK_MANAGED_READ_ONLY`。

数据存 Storage Domain `dsh_scheduled_tasks`（`tasks` / `runtime` / `runs` 三表，version 1，strict schema），不在 settings.yaml。`daily` 成员的字段集与扩展前一致（`localTime` + `timeZone`），因此既有记录无需迁移即可解析。任务指令不进日志、Job label 或错误 detail。

设计文档：`docs/notes/2026-09-11-scheduled-tasks.md`；实现决策：`docs/notes/2026-09-11-dsh-scheduled-tasks.md`（含多类调度与入口改版）。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-scheduled-tasks
```

The bundle patch mounts three rows: `dsh-scheduled-tasks` (the `scheduledTasks` service; this row's id equals the package name, so the loader serves this bundle's `client.js`), `scheduled-tasks-ohmymemo` (the read-only dream-memory projection; fails soft when dsh-ohmymemo is absent), and `scheduled-tasks-api` (strict Typert registration).

## Row config（可选）

```yaml
- id: dsh-scheduled-tasks
  config:
    maxConcurrentRuns: 2      # 全局并发上限（1..8）
    catchUpWindowMs: 43200000 # 补跑窗口（默认 12h）
    leaseTimeoutMs: 5000      # 每任务锁等待
    runTimeoutMs: 7200000     # 单次 run 超时（默认 2h）
    claimTimeoutMs: 5000
```

## Client half

`lib/client.js` is the ModuleLoader closure artifact (window.__ModuleLoader__
.load) with platform modules externalized — the build contract lives in this
package's `tsdown.config.ts`; keep `CLIENT_EXTERNALS` in sync with the
harness `PLATFORM_MODULES` baseline when it moves.

Two registrations, both effect-scoped to the plugin fiber:

- **`main` panel** (`key: 'automation'`): the layout's keyed central seat, so `ctx.layout.selectPanel('automation')` drives it like any other panel; the occupant is `AutomationPage` with the Remote face and the locale seat injected.
- **Sidebar entry** (`src/client/entry.ts`): the session browser's header row declares no action seat, so the clock button is appended there as decoration (own `dsh-stask-entry` class, bilingual `aria-label` anchors, appended last so React's reconciliation never fights it, everything reversible). It toggles the panel — the same button returns to the Conversation — and reads its pressed state from the `data-dsh-stask-panel` marker the page publishes while mounted. Anchor missing (collapsed rail, or a composition without the session browser) ⇒ nothing is drawn.

The editor's instruction block and toolbar mirror the shipped composer
(`InputBar.module.css`; the PermissionSelect/ModelSelect triggers; the shared
Menu card) using `--dsw-*` tokens only, and the workspace picker reuses the hero
WorkspaceChip's geometry plus the hero picker's directory menu.

## Tests

```sh
pnpm run typecheck && pnpm test && pnpm run build
```

Pure-function coverage lives in `tests/`: fixed-IANA boundaries for all five
schedule kinds (DST gap/overlap, day/week/month rollover, host-zone
independence), the bounded catch-up window, the per-task lease (mutual
exclusion, liveness-proven steal, nonce-guarded release), wire schemas
(including the legacy `daily` record shape), and the Typert descriptor set.

## Design notes

- 设计与验收矩阵：`docs/notes/2026-09-11-scheduled-tasks.md`（repo root）。
- 实现决策记录：`docs/notes/2026-09-11-dsh-scheduled-tasks.md`（repo root）。
- Contracts live in the repo root `AGENTS.md` (plugin monorepo rules, npm
  dependency discipline, client bundle build contract).
