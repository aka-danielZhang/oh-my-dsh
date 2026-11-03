# 退役 Thread 交接插件（2026-11-03）

## 背景

`dsh-thread`（0.2.0 起随桌面发货，最后版本 0.3.0-rc.2）是 2026-08-21 自建的双面插件：在阶段边界准备有界 Handoff Draft，经用户确认后在同一 Workspace 创建承接 Session；bundle 层全局注入 `thread_handoff` 工具，另有「设置→通用→Thread」总开关、会话头入口、持久胶囊浮层与侧栏「Thread 分组」视图。

2026-10-23 的 Quno 决策 6 修订把它定性为**能力整体不需要**——不是用 Quno 委派替换其体验，不存在能力承接，也没有平价验收门槛（`docs/notes/2026-10-23-quno-thread-retirement.md`）。三个多月的真实使用没有建立使用习惯：跨会话接续靠用户重新描述或直接开新会话即可，额外的 Draft 确认链路反而增加回合负担，因此本次随桌面 0.4.0-rc.8 整体下船。

## 关联面核查（退役前）

- **插件间依赖：无**。没有任何 `plugin/*/package.json` 依赖 `dsh-thread`，也没有插件 import 它的实现符号（跨包只允许 slot 与 ctx 服务）。唯一耦合是 `dsh-quno` 的三处防御字符串——`thread_handoff` 专属退役文案 guard、`HIDE_GLOBAL_TOOLS` 里的同名项、preset 引导里的一句「不要使用 thread_handoff」。它们不是依赖：Quno 的路由 guard 本身拒绝一切非 `MAIN_ROUTING_TOOLS` 调用，插件删除后 `restrict` 对不存在的名字本来就 catch 跳过。本次一并删除，避免留死字符串。
- **preset**：工具在插件 bundle 层全局注入，stock preset 未挂 `dsh-thread/tool`；用户自建的 `standard-thread` preset 属用户数据（见下「用户数据」）。
- **壳**：随包清单以包内 `dsh.desktop.ship` 为单一事实源，壳代码对插件名零硬编码；只需在 `src/install.ts` 的退役表登记、同步 roster 断言。
- **CI / 发版**：workflow 走 `shipped-plugins.mjs --print`，无逐包硬编码清单；`runtime/revision.json` 的插件 hash/版本由扫描生成，无需手改。
- **运行时**：无 fork 侧依赖。`thread_handoff` 只是插件注册的普通工具，harness 不感知。

## 落地

**仓内**

- 删 `plugin/dsh-thread/`（自含 pnpm 包，根 workspace 未收编）；`.gitignore` 去掉其 `lib/` 条目。
- `src/install.ts`：`RETIRED_DESKTOP_PACKAGES` 增加 `{ package: 'dsh-thread', destRel: 'plugins/dsh-thread' }`，复用既有的判定式下船事务。
- 测试：`scripts/shipped-plugins.test.mjs`（roster 断言去掉该包，并补「退役包不得因残留 `ship:true` 复活」一条；顺带把 Quno 三件套补进断言——此前工作区已加包但断言未同步）、`src/plugins.test.ts`（改断言 roster 不含该包）。
- `scripts/prepare-desktop-bundle.mjs`：打包注释去掉 `thread.tar.gz` 一行。
- 文档：AGENTS roster、README roster、`docs/plugins-catalog.md` 成员沿革（改为退役条目）与随包清单段、`docs/plugin-monorepo.md` 随包计数、`docs/electron-shell-contract.md` 退役包枚举、`docs/quno-bot-design.md` §16/§16.1 执行状态。
- 历史不改写：`plugin/dsh-thread` 的全部 note（`2026-08-21-session-thread.md` 至 `2026-10-20-thread-card-first-click-dead.md`）、既有 CHANGELOG 条目与 tag `dsh-thread-v0.2.0-rc.*`/`v0.3.0-rc.*` 原样保留。

**已装机用户下船（复用既有壳侧事务）**

壳的安装事务只做幂等 `plugin add`、从不 `remove`，所以仅删仓内目录会让老用户的 `~/.dsh-desktop/plugins/dsh-thread/` 解压副本与 profile 依赖/bundle 记录继续生效。`dsh-thread` 直接进 `RETIRED_DESKTOP_PACKAGES`，语义与 `dsh-scheduled-tasks` 完全相同：

1. 判定该包是不是**桌面自己装的那一份**——依赖 spec 是 `link:<shellRoot>/plugins/dsh-thread`（目标可存在，或已悬空）、`node_modules/dsh-thread` 解析进该目录、或只剩一条解析不到的 `dsh.profile.bundles` 条目。
2. 命中时在同一 shadow-CAS 事务内改写 manifest（删依赖与 bundle 条目）、删 `node_modules` 链接，走 frozen → 非 frozen → frozen install 与 `--dump-config` 校验，提交后删解压副本。
3. 不写 marker：旧版桌面重启把桌面副本装回来也只是桌面自己的状态，下一次启动再清；用户从 registry 或自己目录装回的副本一律保留。

**用户数据处置（保守策略）**

- Thread Link / 关系数据（storage domain `dsh_thread`，落 `~/.dsh/storages/`）原地保留、不删不迁移；插件下船后 UI 不再展示，留作只读历史。
- 用户自建 `~/.dsh/.agent-presets/standard-thread/`（若存在）属用户数据：插件不代删。其中若仍挂 `dsh-thread/tool`，该 preset 会因包解析不到而加载失败——需要继续使用的用户自行删掉那一行或整个目录。
- 会话日志里的历史 `thread_handoff` 调用与交接卡保持原样（作为会话历史的一部分）。

**回退**

下船事务可经 shadow-CAS + journal 回滚；用户随时可终端 `plugin add dsh-thread` 自行装回（桌面不会再自动安装，也不会清除用户自装副本）。桌面回退到旧版会重新随包装回，下一次启动再清——与 `dsh-scheduled-tasks` 一致。

## 验证

- `node --test scripts/shipped-plugins.test.mjs`（9 项全绿）。
- `pnpm run desktop:test`、`pnpm run desktop:typecheck`。
- 全仓 grep 复核：`dsh-thread` / `thread_handoff` / `thread.tar.gz` 只剩历史 note、CHANGELOG 与本 note 的引用。
