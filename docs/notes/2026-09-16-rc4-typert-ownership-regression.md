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

## 补章（同日第三轮）：rc.5 仍崩 — Electron 运行时指纹被上游原生模块拒绝

- **现象**：rc.5 sidecar 报 30 条目 failed to import + `user patch-layer watching requires the Cordis HMR service` 崩溃；终端用系统 node 直跑同一 runtime/home 完全正常。
- **根因**：上游 0.1.6 profile 解析器（`feat(cli): force runtime resolution in pkg builds`）经 `node-addon-require-builtin` 原生绑定取 Node 内部模块加载器；该绑定按**精确运行时指纹**放行——Electron 仅 43.0.0/44.0.0/45.0.0-alpha.6，纯 Node 22/24/26。壳钉的 Electron 37（Node 22.21.1/Electron V8）被拒 → 插件解析全灭。上游自家桌面 lockfile 锁 **electron@44.0.0 精确版**（非 ^44，44.3.0 同样被拒——实测验证）。
- **修复**：壳 `electron` 37.2.6 → **44.0.0（精确钉）**、electron-builder ^26.15.3；实机验证（Electron-as-node + 已装 zw.3 runtime + 真实 home）：0 import 失败、provider-balance 等插件全部服务、补丁监听正常。桌面 `v0.3.1-rc.6`。
- **为什么 rc.5 没拦住**：desktop:smoke 与 e2e 都跑在**系统 node** 下，而该缺陷只在 Electron 内嵌 node 上显形。教训入 playbook：**涉及 sidecar/runtime 的验证必须在打包 Electron 的 ELECTRON_RUN_AS_NODE 下复跑**。
- **遗留（P1）**：0.1.6 下标题栏会话头 portal（⋯ 菜单）未随工具栏组合出现，e2e 探针 toolbar buttons 3<4；另 preload 探针的 count 分支补了布局 dump。

## 补章二：rc.6 发布时的诚实基线

- 本轮 plugins:check 揭出 `dsh-compaction-hierarchical` 对 0.1.6 的 4 个行为测试红（engine.test：one-shot 溢出回退/原子 map 终止/输出预留不兼容/模型上限直路由）——**此前轮次的门绿是假绿**：插件经 `dsh` 符号链接 typecheck/test 到 fork 主 checkout 的 lib/，而主 checkout lib 在基线升级后未重建（停留 0.1.5 形状）。教训：**基线升级轮必须先重建 fork 主 checkout（pnpm run build）再跑插件门**，已入 playbook。
- toolbar 会话头 portal 缺失（3<4）与上述压缩边界并列为本轮两笔已知债，均不阻塞启动。
