# dsh-mcp-settings

[English](README.md) | 中文

这是一个可安装的 DeepSeek Harness bundle，包含通过 Web 设置管理 MCP 服务器的三个插件。

| Cordis 行 | 入口 | 职责 |
|---|---|---|
| `dsh-mcp-settings-manager` | `dsh-mcp-settings/manager` | 拥有 `mcp.servers`，为每个已启用服务器启动或停止内置 MCP client fiber，并发布合并后的连接状态。 |
| `dsh-mcp-settings-inventory` | `dsh-mcp-settings/inventory` | 提供只读 `mcpInventory/list` Remote。 |
| `dsh-mcp-settings-ui` | `dsh-mcp-settings` + `./client` | 提供 MCP 设置页、表单/JSON 编辑、启停开关、状态轮询和工具数量。 |

bundle 会把这三个插件行插入兼容的 Web profile。该 profile 不能同时挂载另一套由设置驱动的 MCP manager 或 MCP 设置 UI。已有 `mcp.servers` 用户设置不会被删除。

## 环境要求

- 匹配的 DeepSeek Harness 开发版本；它的 `web` profile 必须已经提供 `package.json` 中列出的 DSH peer 包。
- fork runtime `v0.1.2-alpha.5+zw.1`（该 tag 发出前可用已发布的 `@crazx/dsh-mcp-client@0.1.2-alpha.3.zw.2`），或其他会发出 `mcp-client/status` 的 Harness 构建；官方 `dsh-mcp-client` 不发出该事件。
- Node.js `^22.19.0 || >=24`。
- 从 GitHub 直接安装时使用 pnpm 10 或更高版本。

## 从 GitHub 安装

DSH 插件通过 bundle 分发。`dsh plugin add` 会把包安装进 profile，并把它的 `dsh.bundle` 层加入 profile manifest；不需要额外的启用脚本。

```sh
dsh plugin --profile web add github:aka-danielZhang/dsh-mcp-settings
```

该命令只安装 bundle，不会安装或升级 Harness 拥有的 peer 包；因此必须按上述要求使用匹配的 Web profile。

Git 安装会运行仓库的 `prepare` 脚本生成 `lib/`。pnpm 默认阻止依赖构建脚本；如果第一次安装提示 build 被忽略，请把提示中的准确包名加入 `~/.dsh/profiles/web/pnpm-workspace.yaml`，然后重试：

```yaml
allowBuilds:
  "dsh-mcp-settings@https://codeload.github.com/aka-danielZhang/dsh-mcp-settings/tar.gz/<commit-sha>": true
```

这项授权允许安装期间执行包代码。安装不受你控制的源码时应锁定 commit：

```sh
dsh plugin --profile web add github:aka-danielZhang/dsh-mcp-settings#<commit-sha>
```

安装后重启 `dsh --profile web`，打开“设置 > MCP”；原有 `mcp.servers` 列表会继续使用。

检查组合结果：

```sh
dsh --profile web --dump-config
```

输出应包含 `dsh-mcp-settings-manager`、`dsh-mcp-settings-inventory` 和 `dsh-mcp-settings-ui`。

## 安装本地 checkout

```sh
git clone https://github.com/aka-danielZhang/dsh-mcp-settings.git
cd dsh-mcp-settings
dsh plugin --profile web add file:.
```

全局安装了 `dsh` 时，也可以使用这些可选快捷脚本：

```sh
pnpm run plugin:add
pnpm run plugin:dump
pnpm run plugin:remove
```

DSH CLI 是权威安装路径；这些脚本不会直接修改 profile 文件。

## 配置 MCP 服务器

使用“设置 > MCP”。manager 读取与内置实现相同的 `mcp.servers` 设置命名空间。凭据保存在 Harness 凭据服务中；HTTP 条目通过 `authorizationCredentialRef` 生成 Bearer 认证头，stdio 条目通过 `envCredentialRefs` 把目标环境变量映射到凭据引用，因此密钥无需进入 MCP 设置文档。引用名必须符合可移植环境变量格式 `[A-Za-z_][A-Za-z0-9_]*`。

配置 `authorizationCredentialRef` 后，解析得到的 Bearer 值是权威来源，会替换 `headers` 中任意大小写形式的 `Authorization` 项。收到 `credentials/reference-updated` 事件时，仅重启使用该引用的服务器，因此轮换凭据无需修改 MCP 设置即可作用于下一次进程启动或连接。

UI 支持 stdio 与 Streamable HTTP、表单与 JSON 编辑、凭据引用、直接启停以及实时状态/工具数量。保存已启用服务器后立即查询一次，随后每两秒查询，直到连接成功或经过 60 秒。后台轮询只更新实时状态发生变化的行；手动刷新仍保留完整加载反馈。

## 移除

```sh
dsh plugin --profile web remove dsh-mcp-settings
```

重启 Web profile。bundle 插入的插件行会消失，用户设置保持不变。

## 开发

类型检查和测试遵循 DSH 仓库外插件约定：在相邻目录 `../deepseek-harness` 保留一个 Harness checkout。

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git ../deepseek-harness
cd ../deepseek-harness && pnpm install
cd ../dsh-mcp-settings
pnpm install
pnpm run typecheck
pnpm test
pnpm run bundle
pnpm run smoke
```

实时开发时，先把本地 checkout 安装到 Web profile，保持 `dsh web` 运行，再在另一个终端启动本插件的 bundle watcher：

```sh
pnpm run plugin:add
pnpm run dev:web
```

`dsh web` 始终挂载 Client HMR 接收端。watcher 会重建这个仓库外插件的 Host 和 Client bundle；运行中的 Host 发现 bundle revision 变化后，会让浏览器插件自动热替换，无需刷新页面。Harness 根目录的 `pnpm run dev:web` 只监视仓库内 `packages/*/*` 的 Client 插件，不能替代本插件自己的 watcher。

`prepare` 使用自包含的 `tsdown.config.ts` 与 `tsconfig.prepare.json`，因此 GitHub 安装方不需要相邻 Harness checkout；类型检查与测试需要它。

GitHub CI 会在没有 Harness checkout 的情况下验证消费端安装、bundle、JavaScript 语法和打包产物。完整类型检查与测试针对匹配的相邻 Harness fork 树运行。源码 checkout 开发态把 `@deepseek-ai/dsh-mcp-client` 钉到带状态事件的 `@crazx` npm alias，防止 Node 静默加载官方构建，导致已连接服务器仍一直显示为连接中。

## 兼容性

当前兼容的 DeepSeek Harness 基线：**fork `v0.1.2-alpha.5+zw.1`**。manager 会在本地镜像重连默认值与服务器名 pattern，但实时状态仍依赖 fork 的 `mcp-client/status` 事件。因此源码 checkout 的 devDependency 把 `@deepseek-ai/dsh-mcp-client` alias 到 `@crazx/dsh-mcp-client@0.1.2-alpha.3.zw.2`，直到 npm 上有 `0.1.2-alpha.5.zw.1`；生产 profile 也必须提供同样带状态事件的 peer。

该 bundle 替换当前 DeepSeek Harness RC 版本线提供的扩展点，并复用内置 `@deepseek-ai/dsh-mcp-client`。DSH 仍处于预发布阶段；这些扩展点变化时，需要一起更新 peer 范围、Typert descriptor 和 bundle patch。

## 来源与许可

实现迁移自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 中 MIT 许可的 MCP manager、MCP inventory 和 MCP Settings 包。详见 [LICENSE](LICENSE)。
