# Oh My DSH

[![CI](https://github.com/aka-danielZhang/oh-my-dsh/actions/workflows/ci.yml/badge.svg)](https://github.com/aka-danielZhang/oh-my-dsh/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/aka-danielZhang/oh-my-dsh?display_name=tag)](https://github.com/aka-danielZhang/oh-my-dsh/releases/latest)

> [!IMPORTANT]
> **非官方声明**：Oh My DSH 是一个**个人爱好项目**，与 DeepSeek 及 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方团队**没有任何隶属、合作或授权关系**。DeepSeek Harness 是其原作者的独立开源项目，本项目只是在它之上的第三方桌面发行版与插件合集。
>
> *Oh My DSH is an unofficial hobby project. It is not affiliated with, associated with, or endorsed by DeepSeek or the DeepSeek Harness project.*

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供的原生桌面发行版：一个 Electron 壳承载完整的 Harness runtime，并用一组独立插件补齐易用性短板。

> [!WARNING]
> **0.2.x（Tauri）不能自动升级到 0.3.x。** 请从 [Releases](https://github.com/aka-danielZhang/oh-my-dsh/releases/latest) 下载新安装包。两条更新通道不兼容。

## 特性

**底层方式：Electron + 独立 Sidecar。** 窗口是 Chromium，业务仍是 `dsh web` 本身；sidecar 用 `ELECTRON_RUN_AS_NODE` 共用同一份 Node，不另带第二份运行时：

- **开箱即用**：runtime 随安装包内置（含固定版本的 CLI），无需预装 Node、pnpm 或 DSH；跑在本地随机回环端口，由 Electron 窗口加载。
- **薄壳无业务**：壳层不含任何业务逻辑，Harness 不感知壳的存在；桌面增强全部由插件组合实现。
- **与终端同一数据面**：桌面与终端 `dsh` 共享同一份数据目录，会话、设置、凭据同源可见，是同一账号的两个入口。
- **干净的进程生命周期**：sidecar 全树随壳启动与回收，不留孤儿进程。
- **正规分发**：macOS Developer ID 签名 + 公证、Windows NSIS 免管理员安装，应用内提供检查更新与确认式自动升级。

## 插件

[`plugin/`](plugin/) 下每个目录都是一个可独立安装、独立发版的 DSH 插件：

> **已安装 Desktop 的插件接入**：以下命令会修改所选 DSH Home 的 Web Profile；默认与 Desktop 共享数据。开发分支插件须先验证运行时基线、全部入口和宿主依赖链接，不能只复制到 `~/.dsh-desktop/plugins/` 就接入正式客户端。操作前阅读 [Desktop 插件接入与故障恢复](docs/desktop-plugin-integration.md)。

```sh
dsh plugin --profile web add <repo>/plugin/<name>   # git / 本地路径均可
dsh plugin --profile web add <name>                 # mcp-settings 与 provider-balance 已发布 npm
```

| 插件 | 能力 |
|---|---|
| [`dsh-branding`](plugin/dsh-branding) | 侧栏品牌字标替换为 "Oh My DSH"，浏览器标题同步重写 |
| [`dsh-compaction-hierarchical`](plugin/dsh-compaction-hierarchical) | 官方 upstream 与既有用户 preset 的分层压缩兼容 Provider；Oh My DSH 默认由 fork stock basic 自动处理超长历史 |
| [`dsh-copy-session-id`](plugin/dsh-copy-session-id) | 会话头「⋯」菜单加「复制会话 ID」 |
| [`dsh-desktop-bridge`](plugin/dsh-desktop-bridge) | 桌面集成桥：外链走系统浏览器、后台完成/等待输入的原生通知、下载保存、macOS 融合标题栏与应用内更新入口；非桌面环境自动静默 |
| [`dsh-fs-observation-log`](plugin/dsh-fs-observation-log) | 持久化文件观察记录并在重启后恢复，减少编辑前不必要的重复读取 |
| [`dsh-mcp-settings`](plugin/dsh-mcp-settings) | Web 设置中的 MCP 服务器管理页：编辑、启停、连接状态 |
| [`dsh-model-efforts-editor`](plugin/dsh-model-efforts-editor) | 模型设置行内编辑推理力度档位（三态）与 Z.ai compat 勾选 |
| [`dsh-model-image-input`](plugin/dsh-model-image-input) | 在模型设置的每一行内为自定义模型开启图片输入 |
| [`dsh-ohmymemo`](plugin/dsh-ohmymemo) | OhMyMemo 用户长期记忆：一条记忆一个 Markdown 文件，会话后台自动提取与召回，设置页提供记忆空间管理 |
| [`dsh-provider-balance`](plugin/dsh-provider-balance) | 各供应商剩余额度可视化 |
| [`dsh-reasoning-efforts`](plugin/dsh-reasoning-efforts) | 为手动添加的 OpenAI 兼容模型补推理力度选项 |
| [`dsh-scheduled-tasks`](plugin/dsh-scheduled-tasks) | 定时任务：五类调度模式，一任务一个长期会话，侧栏时钟入口 |
| [`dsh-send-while-running`](plugin/dsh-send-while-running) | 会话运行中也能继续发送新消息 |
| [`dsh-settings-icons`](plugin/dsh-settings-icons) | 设置导航补三枚语义图标（使用统计 / MCP / 记忆） |
| [`dsh-thread`](plugin/dsh-thread) | Thread 模式的跨会话 Handoff Draft：接续上一会话的草稿继续工作 |
| [`dsh-usage-stats`](plugin/dsh-usage-stats) | 设置页「使用统计」：用量摘要卡、活动热力图、模型用量与质量图表 |
| [`dsh-web-search-toggle`](plugin/dsh-web-search-toggle) | 设置页一键开关原生 Web Search |

除桌面集成桥外，其余插件在终端 `dsh web` 下同样可用。各插件的形态（host-only / browser-only / dual）、完整版本沿革与 desktop-owned 随包清单见 [docs/plugins-catalog.md](docs/plugins-catalog.md)。

## 下载

前往 [GitHub Releases](https://github.com/aka-danielZhang/oh-my-dsh/releases/latest)：macOS `.dmg`（Apple Silicon）、Windows `setup.exe`。

## 文档

**使用与接入**

- [Desktop 插件接入与故障恢复](docs/desktop-plugin-integration.md) — 开发插件接入正式客户端前的验证、依赖边界和安全恢复
- [OhMyMemo 记忆空间指南](docs/ohmymemo-memory-space.md) — 长期记忆的范围、状态、视图与目录地图

**架构与契约**（完整索引见 [AGENTS.md](AGENTS.md)）

- [AGENTS.md](AGENTS.md) — 仓库契约索引、硬规则与本地开发命令
- [插件目录册](docs/plugins-catalog.md) — 插件成员完整沿革与 desktop-owned 随包清单
- [插件 monorepo 规范](docs/plugin-monorepo.md) — 落点、发版、迁入与 npm 依赖纪律
- [桥插件契约](docs/desktop-bridge-contract.md) — 环境探测、IPC 命令表与日志汇
- [Electron 壳契约](docs/electron-shell-contract.md) — sidecar、DSH_HOME、窗口与 e2e
- [运行时分发](docs/runtime-distribution.md) — runtime 打包、FORK_MODIFIED 与基线锁定
- [Conventions](docs/conventions.md) — 代码约定与 Git worktree 约定

**流程**

- [Packaging Playbook](docs/packaging-playbook.md) — 构建、签名与公证
- [Release Runbook](docs/release-runbook.md) — 发布流程
- [Harness 基线升级](docs/harness-bump/README.md) — 基线升级 playbook
- [Design Notes](docs/notes/) — 关键决策记录

## License

MIT
