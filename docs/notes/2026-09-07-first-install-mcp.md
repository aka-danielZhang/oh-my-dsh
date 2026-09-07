# Desktop 首装与 MCP 菜单

## 问题

rc.32 扩展为 11 包但仍排除了 MCP Settings；旧机器的 MCP 来自手工安装，不能证明新机器首装完整。发布冒烟又在解包目录解析裸源码插件的 `tsx/esm`，该目录没有 loader，导致 Release 失败。已有 DSH 数据首次由 Desktop 接管时，确认对话框调用 `shippedPluginRefs(false)`，打包后无源码 `plugin/`，因此会在 sidecar 启动前失败。

## 修正

- 保留并验证同工作区已有的冒烟修正：裸源码入口从 runtime cwd 解析 tsx。
- 贯穿 packaged 参数至接管名单读取。开发构建也从 manifest 清单生成，不再只构建历史五包或吞掉失败。
- MCP Settings 0.2.6 改用 Cordis Context、ui-settings SettingsScope、api-gateway Remote 与 ui-renderer；去掉旧 client-runtime 的运行时声明。npm 类型检查替代旧 tsconfig references，Vitest 对发布的 Host 依赖执行 SDK mock，浏览器注册测试执行真实发布工厂。
- Zod 移至 devDependencies 并内联，`files: lib` 包含生成的共享 chunk。MCP 三行 bundle 与 settings namespace 不变；通过 `dsh.desktop.ship` 纳入默认安装事务。
- 冒烟解包后调用壳的真实安装事务，再跑一次幂等检查与 dump-config。`DSH_DESKTOP_RUNTIME` 可指定同 revision 的本地 assembled runtime 用于诊断。

## 验证

- MCP 类型检查、构建、60 项测试通过；壳 116 项测试通过。
- 12 包从 tarball 解包、Host 导入、真实首次安装事务、重复启动幂等与 dump-config 通过。
- 本地 arm64 `.app` 使用当前壳和 12 个仓内新打 tarball；runtime 沿用已安装包内同一 pinned SHA 的归档并核对 sha256，不重新组装或改动用户 runtime。
- 隔离 HOME / DSH_HOME 首启，实际 Electron one-node sidecar 成功；设置显示 MCP，点入后显示服务器列表、刷新和添加服务器，空目录为 0 项，日志无插件错误。未使用用户凭据或连接外部 MCP。
- 同一 `.app` 接管另一份已有根 patch、尚无 Web Profile 的隔离目录，经过 existing-data consent 分支后成功进入 active，保留根 patch 并启动 sidecar；覆盖此前打包路径错误的分支。

本地 `--dir --publish never` 验证包未签名，不含正式发布的 updater 配置；不用于验证自动更新。没有推送 tag、更新 GitHub Release 或覆盖 `/Applications`。
