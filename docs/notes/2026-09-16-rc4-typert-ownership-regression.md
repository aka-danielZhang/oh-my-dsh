# rc.4 sidecar 启动回归：typert manifest 归属校验（2026-09-16）

## 现象

`v0.3.1-rc.4` 安装后桌面 sidecar 启动即崩：`typert-loader: @crazx/dsh-api-session-controller TYPERT manifest names package "@deepseek-ai/..." — the manifest must be owned by the package that exports it` → 31 个插件条目激活失败 → `user patch-layer watching requires the Cordis HMR service` → 退出码 1。

## 根因

- 上游 0.1.6 的 `dsh-typert-loader` **新增** `validateTypertManifest`：`manifest.package` 必须等于导出方真实包名（从解析到的 package.json 读，pnpm alias 下即 `@crazx/...`）。
- fork 的 `publish-fork.mjs` 只重写 package.json 的 `name`；生成产物 `lib/typert.host.js` / `lib/typert.remote-client.js` 由 typert-generator 在 fork 工作区构建时烙上 `@deepseek-ai/...`，0.1.5 无此校验所以历代 zw 层未炸。
- 单一根因级联：typert 行抛错 → boot graph 纤维树坍塌（31 条 failed to import）→ HMR 服务行未激活 → app-boot `watchUserPatches` 抛错。

## 为什么没拦住

发版验证跑了 plugins:check / desktop:typecheck / desktop:test / prepare-runtime，但**跳过了 `desktop:smoke`**（playbook 写「按改动面取舍」，基线升级轮选错了取舍——smoke 的打包 profile 实启正是唯一能暴露 runtime 组装层启动失败的门）。CI release.yml 亦不含 smoke。

## 修复

- fork `v0.1.6-alpha.1+zw.3`（2c8853d51b）：publish-fork 组装 staging 时把 typert 产物内嵌所有权重写为 fork scope（`rewriteTypertOwnership`，含 spec；tarball 抽查确认重写生效）。
- 本仓 `v0.3.1-rc.5`：revision 钉 zw.3、全树 `.zw.2`→`.zw.3` sweep；验证含 **desktop:smoke**（17 插件 × 4 preset 双启全过）。

## 教训（已回填 playbook）

- 基线升级轮 `desktop:smoke` 从「按改动面取舍」升为**必跑**；release.yml 未来可考虑加 smoke job（后续项）。
- publish-fork 对「生成产物内烙包名」类的上游新校验要敏感：代发改名只动 manifest 不够，凡是代码生成时嵌名的产物都要在 staging 重写。
