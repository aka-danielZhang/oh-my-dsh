# AGENTS.md

oh-my-dsh 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）的桌面化 monorepo：出树插件与 Electron 壳同仓、独立发版。两个平面：

- **`plugin/<name>/`** —— 可独立安装、独立打 tag 的 DSH 插件包（一行式 roster 见下；完整版本沿革见 [docs/plugins-catalog.md](docs/plugins-catalog.md)）。
- **Electron 壳** —— spawn harness sidecar、端口分配、就绪检测、窗口加载。壳层不含业务逻辑；harness 不感知壳的存在（契约见 [docs/electron-shell-contract.md](docs/electron-shell-contract.md)）。0.2.x Tauri 壳已删除。

规范层级：[README.md](README.md) 记录「为什么」（技术选型）；本文件记录「契约索引与硬规则」；`docs/*.md` 是各主题的权威契约文档；代码是实现。

> **维护纪律**：本文件只放文档索引、一行式 roster 与硬规则。契约细目以对应 docs 文档为权威，**改契约必须同 PR 改对应 docs 文档**；只有增删主题文档、增删插件、增删硬规则时才需要更新本文件。

## 文档索引（权威契约）

| 主题 | 权威文档 |
|---|---|
| 插件成员完整沿革、desktop-owned 随包清单 | [docs/plugins-catalog.md](docs/plugins-catalog.md) |
| 插件 monorepo 规范（落点/发版/迁入/跨包）+ npm 依赖纪律 | [docs/plugin-monorepo.md](docs/plugin-monorepo.md) |
| 桥插件契约（环境探测/IPC 命令表/日志汇/功能面） | [docs/desktop-bridge-contract.md](docs/desktop-bridge-contract.md) |
| Electron 壳契约与实现要点（sidecar/DSH_HOME/窗口/e2e） | [docs/electron-shell-contract.md](docs/electron-shell-contract.md) |
| 运行时分发、FORK_MODIFIED、基线锁定、打包决策 | [docs/runtime-distribution.md](docs/runtime-distribution.md) |
| Conventions 与 Git worktree 约定 | [docs/conventions.md](docs/conventions.md) |
| 打包手册（构建/签名/公证） | [docs/packaging-playbook.md](docs/packaging-playbook.md) |
| 发布 runbook（tag/latest 指针/secrets） | [docs/release-runbook.md](docs/release-runbook.md) |
| 开发插件接入已安装 Desktop（接入前必读） | [docs/desktop-plugin-integration.md](docs/desktop-plugin-integration.md) |
| Harness 基线升级 playbook | [docs/harness-bump/README.md](docs/harness-bump/README.md) |
| 决策记录（日期命名，非平凡变更必写） | `docs/notes/` |

## 文档维护规则

1. **单点事实源**：一个主题只有索引表中那一份权威文档。跨文档引用一律用相对路径链接，禁止复制段落；docs 之间不引用「AGENTS.md 某节」（会漂移），直接链到主题文档。
2. **AGENTS.md 只在三种情况更新**：增删插件（同步 roster 一行）、增删主题文档（同步索引表）、增删硬规则。**版本沿革、事故细节、契约细化一律不进本文件**；体量红线 200 行，超出就把细节下沉到主题文档。
3. **契约变更**：同 PR 改对应主题文档（桥 IPC → `desktop-bridge-contract.md`；壳行为 → `electron-shell-contract.md`；落点/依赖 → `plugin-monorepo.md`；runtime/打包决策 → `runtime-distribution.md`）。
4. **插件版本沿革与随包版本**：只改 `docs/plugins-catalog.md` + 包内 README；包内 README 只写安装与行为。
5. **决策与事故**：在 `docs/notes/` 新建日期命名文件，旧 note 不改写（修订以新 note 为准并在文中注明）。
6. **流程类手册**：发布 → `docs/release-runbook.md`；打包 → `docs/packaging-playbook.md`；插件接入 → `docs/desktop-plugin-integration.md`；基线升级 → `docs/harness-bump/README.md`，每次升级的一次性记录归档 `docs/harness-bump/<基线>/`。
7. **新插件落地 checklist**：`plugin:new` 脚手架 → 补包内 README → `docs/notes/` 决策记录 → `plugins-catalog.md` 加沿革 → 本文件 roster 加一行。

## Repository layout

```
plugin/<name>/               一个可独立发版的 DSH 插件包（目录名 === package.json name）
  dsh-desktop-bridge/        桌面门控桥 + 日志汇（契约见 docs/desktop-bridge-contract.md）
src/                         Electron 壳（main / preload / sidecar / profile CAS；图标与 DMG 背景）
scripts/                     壳层与工具脚本：prepare-runtime.mjs、prepare-desktop-bundle.mjs、build-electron.mjs
docs/                        权威契约文档 + packaging-playbook.md + notes/（决策记录住仓根，不跟包走）
```

`CLAUDE.md` 是指向本文件的 symlink（与 DSH 仓库同惯例）：改 AGENTS.md，不要改链接。

## 插件 roster（一行式）

形态：host-only / browser-only / dual。完整版本沿革、决策链接与 desktop-owned 随包版本见 [docs/plugins-catalog.md](docs/plugins-catalog.md) 与各包 README。

| 插件 | 形态 | 职责（一句） |
|---|---|---|
| `dsh-desktop-bridge` | dual | 桌面门控桥：外链路由、原生注意力通知、下载桥、标题带更新入口、日志汇 |
| `dsh-mcp-settings` | dual | 设置页 MCP 服务器管理（manager/inventory/ui 三行一包） |
| `dsh-provider-balance` | browser-only | 供应商剩余额度可视化（纯 DOM 注入） |
| `dsh-reasoning-efforts` | host-only | 给手写 llm-pi-ai 模型补 `reasoningEfforts` 声明与 compat 开关 |
| `dsh-web-search-toggle` | dual | 设置页 Web Search 开关 + Host 跨 preset 关闭原生 web_search |
| `dsh-compaction-hierarchical` | host-only | 有界 map-reduce 层次压缩（官方 upstream/既有 preset 兼容 Provider） |
| `dsh-branding` | browser-only | 侧栏字标替换为 "Oh My DSH" 并重写 document title（始终挂载） |
| `dsh-fs-observation-log` | host-only | 持久化 `fs/observed` evidence，重启后恢复观察记录 |
| `dsh-model-image-input` | browser-only | 模型设置行内注入图片输入开关（纯 DOM 注入） |
| `dsh-send-while-running` | browser-only | running 且有草稿时渲染补位红色 Stop；全局 Stop 染主题红 |
| `dsh-model-efforts-editor` | browser-only | 模型设置行内推理档位三态编辑 + Z.ai compat 勾选 |
| `dsh-thread` | dual | Thread 模式跨会话 Handoff Draft（preset-owned，设置总开关门控） |
| `dsh-ohmymemo` | dual | OhMyMemo 用户长期记忆（一条记忆一个 md，tools + capsule + 梦境提取） |
| `dsh-usage-stats` | dual | 设置页「使用统计」：JSONL 事实源 + 手写 SVG 图表 |
| `dsh-copy-session-id` | browser-only | 会话头「⋯」菜单加「复制会话 ID」并重渲染下载日志项 |
| `dsh-scheduled-tasks` | dual | 定时任务：五类调度、一任务一长期 session、侧栏时钟入口 |
| `dsh-settings-icons` | browser-only | 设置导航三枚语义图标（usage-stats/mcp/memory） |

## 硬规则速览

每条只记结论；背景、事故与完整契约在链接文档。

**落点与结构**（→ [docs/plugin-monorepo.md](docs/plugin-monorepo.md)）

- 新插件一律 `pnpm run plugin:new` 脚手架生成，**手搓 manifest 禁止**。
- 目录名 === 未加 scope 的包名；一个目录 = 一个可 `plugin add` 的安装单元。
- 桥插件不能当容器：非桌面环境 apply 必须零副作用。

**发版**（→ [docs/release-runbook.md](docs/release-runbook.md)、[docs/plugin-monorepo.md](docs/plugin-monorepo.md)）

- 插件与桌面**锁步禁止**；壳 / IPC / 打包 / desktop-owned 插件变了才发桌面 `v*`。
- Git tag 三分家：桌面 `v<semver>`、插件 `<包名>-v<semver>`、runtime fork `v<基线>+zw.<补丁>`；latest 指针永远属于桌面 Release，旧 Release 附件禁删。
- 独立插件 tag 不能替代 desktop Release；随包清单以包内 `dsh.desktop.ship` 为单一事实源（→ [docs/plugins-catalog.md](docs/plugins-catalog.md)）。
- 随包插件消费 fork 新能力时同版 `runtime/revision.json` 必须钉到声明该能力的 fork tag；新 Slot 注册必须 try/catch 降级（rc.45 事故）。

**依赖**（→ [docs/plugin-monorepo.md](docs/plugin-monorepo.md)、[docs/runtime-distribution.md](docs/runtime-distribution.md)）

- `@deepseek-ai/*` 依赖钉 registry 版本是**唯一常态**；`link:source` 仅限本地调试、不得提交、不得以其发版。
- runtime 全树锁定 fork 追踪的单一上游线；升级只走「fork 合并 upstream → 发 zw 层 → 本仓 bump revision」，一切修改在同级 worktree 进行（→ [docs/harness-bump/README.md](docs/harness-bump/README.md)）。

**跨包与代码**（→ [docs/plugin-monorepo.md](docs/plugin-monorepo.md)、[docs/conventions.md](docs/conventions.md)）

- 跨插件只走 slot 与 ctx 服务，禁止 import 另一插件实现符号；harness 包只做 type-only import。
- 注册即 effect：所有监听/订阅/slot 注册随 fiber 卸载回收；可选服务 `ctx.get()` 处理 undefined。
- 决策记录一律 `docs/notes/`（日期命名）；包内 README 只写安装与行为。
- 开发插件接入已安装 Desktop 前必读 [docs/desktop-plugin-integration.md](docs/desktop-plugin-integration.md)；禁止手改正式 Profile 替代验证。

**桥与壳**（→ [docs/desktop-bridge-contract.md](docs/desktop-bridge-contract.md)、[docs/electron-shell-contract.md](docs/electron-shell-contract.md)）

- 加/改 IPC 命令 = 先改命令表文档，再改壳与插件两侧。
- 壳薄无业务：业务集成只特殊对待桥插件（gate + IPC）。
- 壳与 sidecar 日志：`~/.dsh/logs/desktop-<时间戳>.log`（`desktop-latest.log` 软链）；`~/.dsh-desktop/logs/` 只落 `install.log`。

## Commands

前置：Node 22+、pnpm；类型检查与构建另需 DSH 源码 checkout（发现顺序：`$DSH_CHECKOUT` → 本仓同级 `../deepseek-harness` → `~/workspace/deepseek-harness` 惯例位，验证标准 `$DSH/docs/architecture.md` 存在）。

```sh
pnpm run plugin:setup     # 根级：建 plugin/deepseek-harness 锚（link:source 与 mcp-settings 用）+ 桥自己的 dsh 锚
pnpm run plugin:new -- <dsh-name> [--face host|client|dual] [--id <rowId>] [--preset-owned]
                          # 新插件脚手架：plugin/<name>/ 下生成 package.json/cordis.patch.yml（或
                          # preset-snippet.yml）/tsconfig/tsdown/源码骨架/node:test，并把 lib/ 追加进
                          # 根 .gitignore；devDeps 钉读自蓝本包。用法详见 docs/plugin-monorepo.md「落点」
pnpm run plugins:check    # 全树：plugin/* 每包跑自己的 typecheck/test/build（--if-present，跳过 symlink 锚）
pnpm run link:source      # 调试：受管插件 devDeps 切 link: 源码（见 docs/plugin-monorepo.md「npm 依赖纪律」；不可提交）
pnpm run unlink:source    # 恢复 registry 版本（提交态）

cd plugin/dsh-desktop-bridge
pnpm install          # 安装 devDeps（tsdown/typescript/tsx/react 类型）
pnpm run typecheck    # tsc --noEmit（harness 包 import 经 dsh 链接解析到源码）
pnpm run build        # tsdown：lib/index.js + lib/invariant.js + lib/client.js
pnpm run test         # node --import tsx --test（纯函数单测）
pnpm run watch        # tsdown --watch（配合 dsh web 的 client-hmr 热替换）
```

mcp-settings 在包内自带 pnpm 11（packageManager）与 vitest 工具链，`cd plugin/dsh-mcp-settings && pnpm install && pnpm test` 独立可用；provider-balance 无构建步骤（裸源码分发，收敛进 tsdown 纯度门是后续项）。

### 实机挂载验证（scratch home，勿污染真实 `~/.dsh`）

```sh
export DSH_HOME=$(mktemp -d)
cd $DSH_CHECKOUT
pnpm dsh plugin --profile web add <repo>/plugin/dsh-desktop-bridge
pnpm dsh web --port 3987 &
curl -s localhost:3987/ | grep -o 'dsh-desktop-bridge[^\"]*'   # boot graph 应含本插件行
curl -sI localhost:3987/plugins/dsh-desktop-bridge/client.js   # 应 200
```

### 壳的运行与端到端验证（M1 起）

```sh
# 前置：Node 22+、pnpm 与 DSH checkout（发现顺序见 docs/electron-shell-contract.md）
pnpm desktop:dev                # Electron 壳：spawn sidecar → 就绪 → 开窗
# e2e（探针走 gate→badge DOM→save_file IPC 往返，结论打在 stdout；EXIT 变体自动退出）
DSH_DESKTOP_E2E_PROBE=1 pnpm desktop:dev
DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 pnpm desktop:dev; echo "exit=$?"
```

壳的 sidecar 默认跑在真实 `~/.dsh`（与终端同源）；harness 输出落 `~/.dsh/logs/desktop-<时间戳>.log`（`desktop-latest.log` 软链指最新，`DSH_WEB_LOG_DIR` 可覆盖），`~/.dsh-desktop/logs/` 只落 `install.log`。浏览器内验证桌面行为以 `window.__DSH_DESKTOP__` 手工注入为辅助手段。

## Conventions 速览（全文 → [docs/conventions.md](docs/conventions.md)）

- ESM；client bundle 走 tsdown 纯度门（非基线 `@deepseek-ai/*` 值 import 构建报错）；纯函数与副作用安装分离。
- 手写 `<style>` 注入必须预打 `data-plugin` + `data-plugin-css` 并幂等（防 HMR 跨插件误删）。
- 空不发声、缺即报错；文案中文（接 `ctx.locale` 双语）、代码注释英文；文件恰好一个行尾换行，`git diff --check` 干净。
- **worktree**：建在仓库同级目录 `../<repo>-<topic>` + 分支 `feature/<topic>`；依赖各自安装；合并后 `git worktree remove` + `prune`，不 `rm -rf`；跨 worktree 只经 git。
