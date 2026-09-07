# 创造模式首装失败：修复 fork 发布依赖名

## 根因

Desktop rc.34 的公开 runtime 与本地安装包内容一致。fork npm 发布脚本把依赖键改成 `@crazx/*`，但 JS import 和内置 preset YAML 仍引用 `@deepseek-ai/*`。Profile fallback 按 CLI manifest 的依赖键建链接，导致创造模式无法解析 `@deepseek-ai/dsh-tool-cordis`。再次启动仍无法补出原名链接，重启不是修复。

## 修复归属

fork [PR #14](https://github.com/aka-danielZhang/deepseek-harness/pull/14) 修复发布脚本：包自身发布到 `@crazx`，普通依赖保留原名并以 `npm:@crazx/<pkg>@<version>` 指向 fork；peer 保留原名和 fork semver，由宿主提供同一实例。发布脚本在打包和写 registry 前执行六项依赖名回归测试。

Desktop rc.36 消费 `v0.1.2-rc.1+zw.2` 对应的 11 个 npm 修改包。插件业务代码与独立版本不变，插件的开发类型依赖不因本次纯发布元数据修复而全量重装。rc.35 的 Windows 构建因测试探针使用盘符路径而被拦截、未正式发布；探针改用标准 file URL，不改业务加载器。

## 防回归

`smoke-packaged-profile.mjs` 保留真实桌面插件安装事务、重复安装幂等和 dump-config 检查，并调用 `smoke-agent-presets.mjs`：

- 使用同一个隔离 DSH Home 启动真实组装 CLI 两次，监听端口由系统分配。
- 检查 `standard`、`ptc`、`minimal`、`cordis` 均为正常的内置模式。
- 逐个创建 Agent、挂载 preset，检查工具非空且创造模式有 `cordis_inspect_list`，最后逐个销毁 Agent。不发送模型请求。
- 探针写出结果后触发 CLI 的正常关闭处理；父进程等待退出，超时或异常退出均失败，超时有强制清理兜底。

旧 rc.34 runtime 的负对照在首次启动准确失败于原始 `tool-cordis` 解析错误；不是仅检查设置菜单存在，也不依赖开发仓库的 node_modules 补齐依赖。

新 npm 版本组装后的首次与再次启动均通过：Standard 27、PTC 27、Minimal 3、创造模式 34 个工具。12 个随包插件的真实安装事务与幂等重入检查也通过。
