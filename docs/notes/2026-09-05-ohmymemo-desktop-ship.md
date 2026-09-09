# 2026-09-05 — OhMyMemo 随桌面发货

## 决策

用户拍板：`dsh-ohmymemo` 标记 `dsh.desktop.ship: true`（pin 0.1.0），成为第 8 个桌面自有插件。桌面的 .app 携带 `ohmymemo.tar.gz`，首启/升级安装事务把它与既有七包作为同一 Profile 事务 `plugin add` 到 `plugins/dsh-ohmymemo/`；tarball hash 与版本记入 revision manifest（`ohmymemoTarball` / `ohmymemoVersion`）。tarball/dest/env 全部走 `scripts/shipped-plugins.mjs` 默认派生，未改 workflow。

## 依据

- 记忆是跨会话的宿主级能力（Host 五行：store/tools/context/manager/api），属于壳的运行面直接依赖，不是可选 profile 插件。
- 插件自带 typecheck/test/build（148 测试），满足 prepare 对每个发货包的验证要求；`pnpm pack` 产物含 lib+patch+README，可走桌面解压安装路径。
- link: 安装（开发姿态）与桌面发货共存：本机当前 web profile 的 link 安装在下次桌面安装事务中会被同名包取代（realpath 一致则跳过）。

## 已知边界

- 首个随桌面发布的版本为 0.1.0（含梦境自动转正式、模型/强度选择、readSurface 修复）；下一次 desktop Release 需 bump 仓根 `package.json` 并走既有发布流程。
- 维护会话出现在普通会话列表（平台无隐藏 API）——已文档化的产品行为。
