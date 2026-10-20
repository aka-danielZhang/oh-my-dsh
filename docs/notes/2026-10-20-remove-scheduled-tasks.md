# 移除定时任务插件（2026-10-20）

## 背景

`dsh-scheduled-tasks`（0.1.0–0.1.4）是 2026-09-11 自建的双面插件：侧栏会话区标题行的时钟按钮进入「定时任务」面板，五类调度（hourly 第 N 分 / daily / weekdays / weekly / monthly 号数）在到点时创建独立长期 session 执行指令，另有暂停/恢复、立即运行与每次执行的历史记录。

当时上游 `@deepseek-ai/dsh-schedule` 只有 after/at/every 三类提醒，且 cold session 不投递，所以刻意正交自建。今天随桌面升级的 `0.2.1-rc.2` 基线已经补齐 cold 恢复、daily/weekly/cron 与全局 Automation 管理 UI（侧栏入口 + 管理页），两套「自动化任务」入口在同一个侧栏里长期并存、命名与职责撞车，这正是删除的理由。

## 决策

插件整体删除，功能由上游「自动化任务」接管，不保留任何替代自研入口。

**随插件退役的能力（上游至今没有）**

- 一个任务绑定一个**独立长期后台会话**执行（钉工作区/模型/权限，不污染当前对话）——上游只把提醒投递回原会话。
- 暂停/恢复、立即运行。
- 每次执行的历史记录（`runs` audit + 跳转会话）。
- hourly「第 N 分」与 monthly「每月 n 号」两类规则（可用 cron 表达式等效表达）。

**保留且零影响**：OhMyMemo 记忆。插件对它的耦合严格单向——只有 `src/ohmymemo.ts` 把梦境任务显示成面板里一行只读投影（`ctx.get('ohMyMemoUi')` 可选读取、60 秒放弃、fail soft）；OhMyMemo 侧从不引用 `scheduledTasks` 服务，梦境提取的 timer/lease/storage domain/对账全部自有。删除后唯一可见变化是那张只读行随面板消失，记忆工具、capsule 注入与梦境提取照常。数据路径也零交叠（`~/.dsh/ohmymemo/` vs `dsh_scheduled_tasks` domain 与 `~/.dsh/scheduled-tasks/locks/`）。

## 落地

**仓内**

- 删 `plugin/dsh-scheduled-tasks/`（自含 pnpm 包，根 workspace 未收编）。
- `scripts/shipped-plugins.test.mjs` 的 roster 断言去掉该包；`.gitignore` 去掉其 `lib/` 条目。
- 文档：AGENTS roster、README roster、`docs/plugins-catalog.md` 成员沿革（保留退役说明）、`docs/plugin-monorepo.md` 随包计数 17 → 16。
- 历史不改写：`docs/notes/2026-09-11-scheduled-tasks.md`、`2026-09-11-dsh-scheduled-tasks.md` 与既有 CHANGELOG 条目原样保留；git tag `dsh-scheduled-tasks-v0.1.3/0.1.4` 按规则保留。
- 动态消费面无需改动：CI/release workflow 走 `shipped-plugins.mjs --print`，Electron 壳对插件名零硬编码，`runtime/revision.json` 不涉及。

**已装机用户下船（本次的壳侧新逻辑）**

壳的安装事务只做幂等 `plugin add`、从不 `remove`，所以仅删仓内目录会让老用户的 `~/.dsh-desktop/plugins/dsh-scheduled-tasks/` 解压副本与 profile 里的依赖/bundle 记录继续生效、旧插件与新 Automation 长期并存。`src/install.ts` 因此在同一 shadow-CAS 事务里增加下船：

1. 在真实 Profile 上判定该包是不是**桌面自己装的那一份**——依赖 spec 是 `link:<shellRoot>/plugins/dsh-scheduled-tasks`（目标可存在，或已因删目录而悬空）、`node_modules/<pkg>` 解析进该目录、或只剩一条解析不到的 `dsh.profile.bundles` 条目；三条任一命中即为桌面副本。
2. 命中时在 shadow 内改写 manifest（删依赖与 bundle 条目，等于 `dsh plugin remove` 之后再补上它不做的 bundle 清单修正）、删 `node_modules` 链接，然后走原有的 frozen → 非 frozen → frozen install 与 `--dump-config` 校验，提交后删解压副本。
3. **不写 marker、没有「只跑一次」**：一旦清掉，下一轮就不再有候选。反过来，旧版桌面（≤0.4.0-rc.2 的随包清单仍含该包）只要重启就会把解压副本重新装回——那也是桌面自己的副本，下一次启动照样清掉，不需要额外状态，也没有竞态窗口（rc.3 的一次性 marker 设计会被这条路径绕过，rc.4 改为本判定并已实测）。
4. 从 registry 或用户自己目录 `plugin add` 回来的副本不是桌面副本，一律保留——桌面不与用户抢这个包。

退役包从 `preserved` 依赖清单里排除，否则事务内的「受保护依赖 realpath 不变」校验会把下船判成篡改；用户自己那份仍在 `preserved` 里被校验必须存活。没有该包的 Profile 完全跳过（不产生事务）。

**用户数据处置（保守策略）**

不自动删任何用户数据，只在本文与 Release notes 写明路径：

- `~/.dsh/storages/dsh_scheduled_tasks.json`（任务定义 + runs 审计）——保留；
- `~/.dsh/scheduled-tasks/locks/`（空锁目录）——保留；
- 历史 `[定时] <标题>` 会话（`sched-*`）——必须保留：这是执行历史，且继续作为梦境提取的证据来源被正常扫描。

## 代价与边界

- 接受上述四项能力退役；产品判断是上游「自动化任务」的重叠面（定时触发、日历规则、管理页、持久化）已经足够，独有价值里只有「独立长期会话执行」高频。
- 侧栏与设置页回到单一「自动化任务」入口。
- 下船是判定式的：旧版桌面重启装回的桌面副本会被再次清掉；用户自己装的那份不会。

## 验证

- `pnpm run desktop:typecheck`、`pnpm run desktop:test`（新增五条下船单测：桌面副本整事务下船、旧版重启复活后再清、registry 安装不候选、shell root 外的 link 安装保留、陈旧链接/悬空链接清理）。
- 根级 `pnpm run plugins:check`。
- scratch/实机 `DSH_DESKTOP_E2E_PROBE=1 pnpm desktop:dev`：侧栏只剩上游「自动化任务」一个入口，OhMyMemo 设置页与梦境提取正常；安装日志出现 `retire dsh-scheduled-tasks from web`。
- 旧 Profile 实机：升级后 `~/.dsh/profiles/web/package.json` 不再含该依赖与 bundle 条目，`~/.dsh-desktop/plugins/dsh-scheduled-tasks/` 消失；再次启动直接跳过（`skip plugin add`），不产生事务；模拟旧版重启把桌面副本装回后，再启动仍会清掉。

## 发版

随包清单变更 = 桌面发 `v*`（壳 + desktop-owned 集合都变了）。首版 `v0.4.0-rc.3` 用「一次性 marker」下船，发布后发现旧版桌面重启会把副本装回、marker 会永久放过它，因此 `v0.4.0-rc.4` 改为上述判定式下船并作为本次实际交付版本。Release notes 说明：功能由上游「自动化任务」接管、退役能力清单、孤儿数据路径。`runtime/revision.json` 无需改动（不消费 fork 新能力，0.2.1-rc.2 基线已含 Automation）。
