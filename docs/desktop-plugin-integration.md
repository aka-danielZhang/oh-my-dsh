# Desktop 插件接入与故障恢复

面向把开发分支中的插件加入已安装 Desktop 的维护者和 Agent。插件可以独立安装，但「源码测试通过」「plugin add 成功」「复制到插件目录」都不等于已经满足正式客户端的运行条件。

## 先区分两种接入方式

- **随 Desktop 发布**：在 Desktop 源仓声明 `dsh.desktop.ship`，经构建、依赖链接、隔离安装和实际启动验证后发布新 Desktop。已安装客户端依据包内 `runtime-revision.json` 的 `shippedPlugins` 清单管理插件，不扫描任意新建目录。
- **用户额外安装**：插件必须自行满足当前 Desktop 的运行时基线和依赖解析条件。先在隔离环境验证，再经用户确认修改正式 Profile。它不会因为被放进 `~/.dsh-desktop/plugins/` 就自动获得随包插件的依赖链接和升级保障。

开发 checkout、已安装 `.app`、解压运行时、Web Profile 是不同对象。修改前明确目标，不能把本地开发分支的成果当作已发布客户端能力。

## 2026-09-08 OhMyMemo 故障

`desktop-20260908-195237.log` 中的外层提示是：

```text
harness sidecar for profile web exited before printing a dsh web launch URL
```

这只说明 Host 启动失败，具体错误在其后的 Loader 异常链中：

```text
ohmymemo-tools   -> lib/tools.js   -> Cannot find package '@deepseek-ai/dsh-tools'
ohmymemo-context -> lib/dream.js   -> Cannot find package '@deepseek-ai/dsh-session'
ohmymemo-manager -> lib/manager.js -> Cannot find package '@deepseek-ai/cordis'
```

现场核对结果：

- Web Profile 已登记 `dsh-ohmymemo` bundle，依赖指向 `link:.../.dsh-desktop/plugins/dsh-ohmymemo`。
- 插件有构建后的 `lib/`，但自己的 `node_modules` 仅提供 `yaml`，没有上述 Harness peers。
- 三个包在 Desktop 固定运行时中均存在，但从插件所在目录无法解析。Node ESM 按导入文件的实际路径解析依赖，不会因为启动进程的 cwd 在 runtime 中，就借用另一棵目录的 `node_modules`。
- 已安装应用的 `shippedPlugins` 不包含 OhMyMemo；`findDesktopPlugins()` / `ensurePluginRuntimeLinks()` 只处理随包清单，不会自动修复这份额外插件。

因此这是 **Host 插件的依赖未接通**，不是端口问题，也不是 rc.37 的浏览器 `remote` inject 问题。失败发生在打印 launch URL 之前，反复重启不会补齐依赖。

另有两项待验证风险，不能与本次已确认的直接原因混为一谈：安装副本的 `version` 为 `0.2.0`、`dsh.desktop.pin` 却为 `0.1.0`；其开发依赖主要在 `0.1.2-alpha.3`，Desktop 则使用 `v0.1.2-rc.1+zw.2`。补上几个链接并不能证明 API、服务和数据格式均兼容。

## 不要这样操作

- 不要直接修改已签名 `.app` 的 `app.asar`、插件 tarball 或 revision manifest。这样既绕过发布验证，也可能破坏签名和内容哈希。
- 不要把 `lib/` 复制进 `~/.dsh-desktop/plugins/`、登记 bundle 后，就认定安装完整；也不要手造 `.ok` 标记让未验证目录冒充受管缓存。
- 不要在正式插件目录执行无版本约束的 `pnpm install` 来消除报错。新装的 Cordis / Service / Typert 副本即便版本相同，也可能因物理模块实例不同而分裂注册表。
- 不要只验证 `lib/index.js`。一个包可能有 tools、context、manager、api 等多个 Host 入口及独立 Client 入口。
- 不要把 `--dump-config` 成功或 HTTP 首页返回 200 当成完整加载成功；前者不证明所有插件能导入，后者不证明浏览器插件能激活。
- 不要清空 `~/.dsh`、删掉记忆库，或删除正式 runtime 缓存来强制测试。插件装配错误不需要以丢失数据为代价处理。

## 正确接入流程

1. **锁定目标版本**：记录 Desktop 版本、包内 runtime ref/SHA、来源仓库及提交、插件版本。检查 API 基线及 fork alias 的实际消费名称；`@crazx/*` 实现可能以 `@deepseek-ai/*` 键安装，不能只凭包名或 semver 推断兼容。
2. **在源仓完成适配**：区分 type-only import、构建时内联库与实际外部依赖。Host 外部 imports 必须能从解压插件的真实路径解析，共享 Harness 服务必须使用宿主同一物理实例。Client 还需验证平台模块和 inject，访问 `ctx.remote.settings` 时声明根服务与子服务两项。
3. **检查发布清单**：随包插件的 `version` 与 `dsh.desktop.pin` 一致，归档包含全部入口及共享 chunk。通过现有 `listShippedPluginSpecs()`、`linkPluginRuntimeDeps()` 和安装事务接入，不另写临时拷贝流程代替分发链。
4. **使用隔离环境**：新建测试 `DSH_HOME`，桌面验证同时隔离 OS Home 和 Electron user-data，防止壳缓存、单实例锁和正式客户端互相影响。Unix 示例见打包手册；Windows 用独立测试账号或虚拟机隔离 `%USERPROFILE%` 和应用数据。不要让多个进程共享正式记忆库。
5. **测试实际产物**：从发布 tarball 解压，使用目标平台组装 runtime 和真实依赖链接执行 `pnpm run desktop:smoke`。覆盖全部 Host 入口、真实安装事务、重复启动，以及所有内置 Agent 预设。对新增 Client 功能另测完整页面加载和实际设置读写；现有模型插件的定向 Client 冒烟不会自动覆盖 OhMyMemo。
6. **补插件专项验证**：OhMyMemo 至少检查五个 Host 行、Memory 设置页、`memory_*` 工具、存储恢复和重启。用临时记忆和会话数据验证；调度或模型调用需单独控制，不能在正式数据上试运行后台提取。
7. **验证升级与回退**：在隔离目录中的既有 Profile 快照上验证升级，检查 sessions、settings、credentials、其他插件和记忆数据未被覆盖。任何绝对路径、软链接、Store root 覆盖都必须先改为隔离测试目标。
8. **再交付**：随包能力通过新 Desktop Release 交付；额外插件须有经验证的安装/更新/卸载方案、备份及用户确认。不要把临时补链当成可维护的发布方案。

现有 `runtimeLinkPlan()` 会把 peer 缺失当作可跳过项，以兼容不同基线。因此「链接函数执行成功」仍不等于 Host 依赖完整，必须以实际入口导入和启动结果为准。若要改自动预检或安装器，应另做实现与回归测试；本文本身不提供自动拦截。

## 已经无法启动时

1. 退出 Desktop 及相关 DSH 进程，保留失败日志，避免反复启动触发 Store 恢复或后台任务。
2. 备份受影响 Profile 的配置与锁文件、home patch、settings、记忆数据及其实际自定义 root。不要向外发送 credentials、聊天或记忆正文来排障。
3. 核对失败插件的所有 bundle/patch/preset 引用及安装来源。优先在隔离副本中，用与 Desktop 匹配的 CLI 验证移除该插件的操作。不要直接删插件目录，留下指向不存在路径的 bundle。
4. 经用户确认后，只撤回这次插件接入引入的依赖与装配引用，或恢复经过核对的安装前 Profile 快照；同步验证锁文件。保留后续用户改动，不能整份覆盖未知来源的旧备份。
5. 保留 `$DSH_HOME/ohmymemo/` 及自定义记忆目录。卸载代码不等于删除记忆；待插件适配和迁移验证完成后再接回。
6. 验证 Host 正常输出 launch URL、页面完成插件加载、MCP 和 Agent 预设正常，再做一次完整退出重启。

不要假设桌面壳会自动回滚用户额外安装的插件。壳自己的 Profile 事务恢复不等于任意 `plugin add` 的全局恢复机制。

## 相关实现与文档

- [插件清单和依赖链接](../scripts/shipped-plugins.mjs)
- [已打包客户端的清单解析](../src/plugins.ts)
- [隔离安装和预设冒烟](../scripts/smoke-packaged-profile.mjs)
- [打包验证手册](packaging-playbook.md)
- [发布手册](release-runbook.md)
