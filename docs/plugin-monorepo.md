# 插件 monorepo 规范与 npm 依赖纪律

> 本文从 AGENTS.md 迁出（2026-09-13 文档瘦身），是插件落点、发版、迁入、跨包纪律与 npm 依赖纪律的权威文档。发布操作流程（tag、latest 指针、secrets）见 `docs/release-runbook.md`；打包流程见 `docs/packaging-playbook.md`。

## 插件 monorepo 规范

本仓是「个人 DSH 扩展 + 桌面壳」的单一事实源。插件与桌面同仓，是为了一次 checkout、一次 harness rc bump 过全树，同时保留各自的发布节奏。对照：[dataelement/dsh-desktop](https://github.com/dataelement/dsh-desktop) 把 DSH 钉在 npm 上、用仓根 `patches/` 改上游压缩产物——那是壳侧补丁模型，不是插件布局，不学。

### 落点

- **新插件目录一律经脚手架生成**：`pnpm run plugin:new -- <dsh-name> [--face host|client|dual] [--id <rowId>] [--description <text>] [--preset-owned]`（`scripts/new-plugin.mjs`）。三种形态从仓内在售插件蒸馏：`host`（蓝本 dsh-fs-observation-log）、`client`（蓝本 dsh-branding：空 host apply + `exports["./client"]` 浏览器半）、`dual`（蓝本 dsh-web-search-toggle）；`--preset-owned` 生成 install-only 空 patch + `preset-snippet.yml`（行归 agent preset）。脚本同时把 `plugin/<name>/lib/` 追加进根 `.gitignore`，devDeps 钉在生成时从蓝本包实时读取（基线 bump 后脚手架自动跟随，fallback 表在脚本内单点维护）。**手搓 manifest 禁止**（exports/dsh 块/peer range/tsdown 客户端契约三份样板极易漂移）；生成后仍需人工补：description、README、`docs/notes/` 决策记录、本清单行。决策见 `docs/notes/2026-08-21-plugin-scaffold-script.md`。
- 每个插件一个目录：`plugin/<package.json name>/`。目录名必须等于未加 scope 的包名，因为 `dsh plugin --profile web add <path>` 按这个路径装包，entry id 也是这个名字。
- 一个目录 = 一个可 `plugin add` 的安装单元，自带 `package.json`、`dsh.bundle`/`cordis.patch.yml`、源码、测试。mcp-settings 那种「一包三行」（manager / inventory / ui）仍是**一个**目录、一份 patch，不是三个目录。
- 桥插件不能当容器：它的 apply 在非桌面环境必须零副作用；mcp-settings / provider-balance 在终端 `dsh web` 也要工作。塞进 `dsh-desktop-bridge` 会把「桌面门控」和「始终挂载」搅在一个 fiber 里。
- 不要再套 `plugin/packages/`，不要把插件放到仓根与 `src/` 平级，不要放进 fork 的 `packages/`。

### 发版

- 插件与桌面**锁步禁止**。各包 `package.json` 的 `version` 独立走动。
- **何时打桌面 `v*`**：壳 / IPC / 打包 / runtime 解压 / 标题带更新 / desktop-owned 随包插件升版 → 必须 bump 仓根 `package.json` 并推 `v<semver>`。纯插件且不在 desktop-owned 清单（如 mcp-settings、provider-balance、branding）→ 只打 `<包名>-v<semver>`。壳没变不要发桌面版。同一天能合并的壳修复合成一版，避免同事连下两次约 450MB。
- **旧桌面 Release 附件禁止删**（尤其 zip + `.blockmap`）。Mac 差分要拉上一版 blockmap；删了下一次热更会整包。
- **版本号策略（0.2.0-rc.1 起，学 harness 的 rc 节奏）**：桌面走 semver 预发布段——大功能进 `0.N.0-rc.x`，稳定后摘 `-rc` 出 `0.N.0`，纯修复走 `0.N.M+1`；插件各自 semver，同样允许 `-rc.N`；fork 标识走 `+zw.N` build metadata（semver §10，排序忽略不影响升级链）。**刻意不**在桌面版本里嵌 harness 基线（`0.1.0-rc.7.desktop.1` 这类嵌套段合法但小于已发的 0.1.3，首个新版即断更新链）；基线由 `runtime/revision.json` 记录。**GitHub Release 不勾 prerelease**——`releases/latest` 端点排除 prerelease，勾了 updater yml 即 404、自动更新断链；`-rc` 只体现在版本号语义。壳侧 `autoUpdater.allowPrerelease = false`（不要让 electron-updater 因 semver `-rc` 去刮 `releases.atom`：失败的空 `v*` tag 会毒死已装的 -rc 客户端）。release.yml 有防呆：tag 版本 ≠ 仓根 `package.json` 版本即 fail。
- Git tag 无斜杠三分家：桌面 `v<semver>`（例 `v0.2.0-rc.2`，经典风格）；插件 `<包名>-v<semver>`（例 `dsh-provider-balance-v0.4.2`；包名都是 `dsh-*` 起，天然不与 `v*` 冲突，workflow 按「最后一个 `-v`」切名与版本）；**runtime fork 标签 `v<基线>+zw.<补丁>`**（例 `v0.1.0-rc.7+zw.1`——semver build metadata 标识 zw fork，行业标准做法，基线升级时 `+zw.N` 递增；历史 `desktop/v0.1.0/1` 标签仍有效可fetch，revision.json 钉 ref 字符串）。GitHub Release 按 tag 分流，互不覆盖附件。**latest 指针纪律**：Electron 自动更新端点是 `releases/latest/download/latest-mac.yml` / `latest.yml`。0.3.x desktop Release `make_latest: true` 独占 latest，并额外放一份 cutover `latest.json` 给仍在轮询旧端点的 0.2.x（只通知换壳，不能热更新）。插件 Release 一律 `make_latest: false`（release.yml 已内置；网页手动发插件 Release 时同样不得设为 latest）。
- **随包插件与 runtime 基线的同步纪律（2026-09-10 rc.45 事故）**：随包插件消费 fork 新能力（新 Slot/新服务方法）时，**同版 `runtime/revision.json` 必须指向声明该能力的 fork tag**——插件侧对 API 做 duck-check 只能防「方法缺席」，**新 Slot 的注册失败是 fail loud 的，必须在注册点 try/catch 降级**（桥 rc.15 的 `shell.toolbar` 注册是范本：失败=该能力缺席+legacy fallback 保持，绝不拖垮整插件）；「新插件+旧 runtime」的每个组合插件都必须完整存活，且**验证矩阵必须包含旧 runtime 组合**（dev 验收跑新源码 sidecar 会掩盖此面）。违反组合的发布事故无法经更新入口自愈（更新按钮在插件里），用户只能手动下载。
- 安装面保持 `dsh plugin --profile web add <repo>/plugin/<name>`（file: / git 路径均可）。**插件 npm 双通道（2026-08-21 起）**：allowlist 插件（`dsh-mcp-settings`、`dsh-provider-balance`）随 `dsh-*-v*` tag 额外发 npm，安装面多一条裸包名 `dsh plugin --profile web add <name>`（`dsh plugin` 原样转发 pnpm，天然支持 registry 包）；其余插件仍只走 git tag 分发。npm 通道契约：workflow 的 npm channel gate 是唯一 allowlist 事实源；tag 版本已上 npm 则跳过（幂等，重跑安全）；npm 发布在 GitHub Release **之前**，失败即中止（fail loud，不出「tarball 有、npm 无」的半发布态）；token 走 repo secret `NPM_TOKEN`（npm 账号 danielzhang688，与 fork 仓 publish-fork 同一 token）；有 build script 的包（mcp-settings）先按 CI 同款 baseline checkout + 锚 + install + build 再 publish。⚠️ `dsh-provider-balance` 的 npm 包名原由 CalvinQin 注册（其 0.2.0），danielzhang688 无写权限——owner 侧 `npm owner add danielzhang688 dsh-provider-balance` 之前，该包的 npm 步骤会 403 fail loud（属预期，权限补齐后重跑即可）。**对 harness 的依赖**则一律 npm（「npm 依赖纪律」一节），与 fork 的 npm 发布纪律（fork FORK.md）互为两面。

### 迁入既有插件仓

- `git subtree`（或 `--allow-unrelated-histories`）保留历史，禁止拷贝文件了事。
- 源仓工作区必须干净：未提交的发版改动先在源仓落地（mcp-settings 0.2.3 的 credentials 竞态就是这种）。
- 迁入后源仓 archive 为只读，不再双写。
- 迁入当天**不上**仓根 `pnpm-workspace.yaml`：桥锁 pnpm 10，mcp-settings 锁 pnpm 11。各包继续自己的 `pnpm install`；workspace 收敛是独立 PR。
- 迁入当天不统一测试/构建工具链。第二步再把裸 `client.js` 分发（provider-balance）收进桥的 tsdown 纯度门。
- **harness 依赖一律 npm**（「npm 依赖纪律」一节）：插件 devDependencies 钉 registry 版本（`@deepseek-ai/*` 官方包在公共 npm；fork 修改面包的自有 scope 版，见 fork FORK.md「发布纪律」）。**源码 link: 依赖是仅限本地调试的显式 posture**，只能经 `pnpm run link:source` / `unlink:source`（`scripts/source-deps.mjs`）进出，不得提交、不得作为默认形态。不能指望 tsx 套用 checkout 的 tsconfig paths——桌面 runtime 的 tsx 4.23+ 只对 tsconfig include 内的文件生效，bare specifier 走纯 Node 上溯解析（2026-08-19 桌面崩溃循环的根因，见 `docs/notes/2026-08-19-log-sink-race-and-plugin-peer-resolution.md`；这也解释了为何 link posture 仍需包内 node_modules 物化）。

### 跨包纪律

- **开发插件接入已安装 Desktop 前必读**：[Desktop 插件接入与故障恢复](docs/desktop-plugin-integration.md)。禁止以复制构建文件、手改正式 Profile 或在正式插件目录临时安装依赖，替代 runtime 基线适配、同实例依赖链接和隔离产物验证。源码 `ship: true` 不会改变旧客户端包内的随包清单；Host 多入口与 Client 都须验证。文档任务不授权修改正式 Profile、记忆库或发布新版本。
- 跨插件只走 slot 与 ctx 服务，禁止 import 另一插件的实现符号；harness 包只做 type-only import（构建时擦除）。
- 决策记录一律 `docs/notes/`（仓根），不跟包走。包内 README 只写该包的安装与行为。

## npm 依赖纪律

### 2026-09-07 首装补充契约

- Desktop 0.3.0-rc.38 随包模型图片输入与档位编辑器均为 0.1.3。读取 `ctx.remote.settings` 必须同时声明 `remote` 与 `remote.settings`；子服务声明不隐含父服务权限。packaged smoke 必须执行两插件的实际 client bundle，以独立 provider fiber 和组装运行时 Cordis 检查启动、重复挂载、卸载及缺失声明反例，不能只检查 Host 入口和静态 inject 字符串。
- Desktop 0.3.0-rc.34 起随包清单为 12 个；`dsh-ohmymemo` 加入后为 13 个；rc.45 起 `dsh-usage-stats` 加入后为 14 个；rc.51 起 `dsh-copy-session-id` 加入后为 15 个；rc.53 起 `dsh-scheduled-tasks` 与 `dsh-settings-icons` 加入后为 17 个。实际集合仍以 `dsh.desktop.ship` 为单一事实源；MCP 暂缓入包的旧决策已被当前基线迁移与验证取代。rc.33 因 Windows 安装冒烟失败未正式发布。
- mcp-settings 类型检查、测试与构建不再依赖相邻源码树；使用 npm 发布的当前 gateway / renderer / settings 入口，Host Zod 内联且共享 chunk 随包。其三行 bundle 契约不变。
- 已打包壳在首次接管确认阶段也必须读取 resources 中的 `shippedPlugins`，不可回退读取 `plugin/` 源码名单。开发启动同样按名单构建，有 build 脚本则运行、失败即中止，无脚本则跳过。
- packaged profile 冒烟必须调用真实 `runDesktopPluginInstall` 事务并检查重复运行幂等；裸 TS host entry 的 tsx loader 从 assembled runtime cwd 解析。详情见 `docs/notes/2026-09-07-first-install-mcp.md`。
- 安装事务添加插件后先在 staging 内刷新锁文件，再显式冻结安装验证；Windows pnpm 目录 add 可能未将新的 link spec 写入锁文件。已有 Profile 的事务前冻结检查和保护数据校验不得放松。

npm 版本依赖是**唯一常态**；源码依赖仅限本地调试，且只能经专门命令进出：

- **默认（提交态）**：所有包的 `@deepseek-ai/*` 依赖钉 registry 版本。上游未修改包直接用官方 `@deepseek-ai/*@0.1.5-rc.2`（含 `lib/types`；本仓基线随 `runtime/revision.json`，2026-09-12 起 rc.2）；fork 修改面包保留原 `@deepseek-ai/*` key，以 npm alias 指向 `@crazx/*@0.1.5-rc.2.zw.1`。fork 候选尚未发布时只能做 source-linked 验证，不能声称 registry/frozen-install 通过。alpha.1 升级决策见 `docs/notes/2026-09-09-harness-0.1.5-alpha.1-adaptation.md`，rc.2 同步记录见 `docs/harness-bump/0.1.5-rc.2/README.md`。
- **调试（本地态）**：`pnpm run link:source [pkg ...]` 动态发现每个受管插件的 `@deepseek-ai/*` devDep 与当前 Harness package owner，重写为 `link:../deepseek-harness/<subpath>`（锚由 `plugin:setup` 建）并重装；`pnpm run unlink:source` 恢复 registry 版本。fork 候选尚未发布、因此不能安装时，用 `pnpm run unlink:source -- --no-install` 只恢复 manifest；这不构成 registry/frozen-install 验证。仅有 `dsh-compaction-hierarchical` 的 superclass `dsh-compaction-basic` 固定 official baseline，以测试旧/新 stock 的 capability delegation。
- **禁止**：手写 link:/file:/`../` 依赖并提交；以源码 posture 发版；绕过映射脚本私接源码；把 `--no-install` 的 manifest 恢复宣称为 registry 验证。发布与 CI 检查在 registry posture 下进行。

