# 2026-09-07 桌面安装包扩展随包插件名单（7 → 11）

## 背景与新现象

多位用户反馈：全新环境直接装 Desktop（无既有 `~/.dsh`）后，「预安装的插件没了，只剩壳和部分插件」。排查确认安装链路本身健康——`~/.dsh-desktop` 解压、`plugin add`、profile 事务提交全部成功，profile 里装的 7 个插件与 rc.28→rc.31 的 `dsh.desktop.ship` 名单逐一致物。

## 根因：分发名单本来就只有 7 个

缺失的 5 个（branding、fs-observation-log、mcp-settings、provider-balance、reasoning-efforts）从 rc.28 起就**从未**声明 `dsh.desktop.ship`，历来靠手动 `dsh plugin add`（npm 双通道或 git 路径）安装。老机器上的「全量插件」是手动装出来的；新环境没有 `~/.dsh`，桌面安装器又只管名单内的 7 个，落差由此而来。这不是安装 bug，是名单决策跟不上实际预期——用户把「plugin/ 目录全集」当成了「随包分发集」。

## 决策

四个插件入包（`dsh.desktop.ship: true`）：branding、fs-observation-log、provider-balance、reasoning-efforts。三项标准 tsdown 布局零配置入包；两处机制泛化：

- `shipped-plugins.mjs` 新增 `dsh.desktop.pack` 覆盖 `packEntriesFor` 的 `package.json + lib` 默认（lib 无条件默认保持不变——那是给 tsdown 插件的防陈旧契约）；provider-balance 为 npm 裸源码形态（`main: ./src/index.ts`，runtime tsx 直载），显式 `pack: [package.json, src, client, cordis.yml, cordis.bundle.yml, README.md]`，与 npm `files` 一致。
- `buildDesktopPlugins` 与 `check-shipped-plugins` 的 `pnpm run` 补 `--if-present`，无构建脚本不再是硬失败。

### mcp-settings 暂缓（本次不入包）

mcp-settings 0.2.5 的 tsc/vitest 解析体系锚在旧 harness 基线上，`#35` 把基线 bump 到 `v0.1.2-rc.1+zw.1` 后整体失配，实测两棵树都无法通过：

- **fork 树（rc.1+zw.1）**：`packages/client/runtime` 已被重组移除（`SlotRegistry` 迁至 `packages/client/ui-renderer`、`SettingsScope` 迁至 `packages/client/ui-settings`、`ClientContext` 即 vendor/cordis 的 `Context`），tsconfig 的 `references` 指向不存在路径（tsc -b TS6053 硬失败）；且基线 `tsconfig.base.client.json` 已无 `paths`，`dsh-client-runtime/client`、`dsh-client-locale/client`、`dsh-invariants`、`dsh-system-prompt` 等 specifier 无处解析。
- **上游树（dsh-v0.1.2-rc.1）**：反向缺失 fork 独有的 `vendor/cordis`、`vendor/schemastery`、`packages/mcp/mcp-client`、`packages/runtime-diagnostics/invariants`（ci.yml 首跑实测红）。

移植 = 重建 specifier→新布局的解析表 + tsconfig references 重写 + 测试别名同步，属插件级独立工程；且 0.2.5 的运行时代码未在 rc.1 runtime 上验证过，不宜在未验证状态下随包推给全员。移植完成前继续 `dsh plugin add dsh-mcp-settings`（npm 双通道），名单测试已把这一例外与理由固化成断言。

## 防回归

- `shipped-plugins.test.mjs` 名单断言更新为 11 个；新增裸源码插件 pack 覆盖断言；mcp-settings 的暂缓例外连同理由写成断言，防止「顺手加回名单」绕过移植。
- `smoke-packaged-profile` 是名单驱动的（fresh home → add 全部 → dump-config 逐包断言），provider-balance 的 src 形态首次进打包冒烟。
- runtime 不动（revision.json 未变），CI 组装缓存键不变。

## 已知边界

- 老环境手动装过的插件与随包版本可能不一致：`pluginAlreadyInProfile` 以 realpath 判等，不同则按桌面版本覆盖（与既有升级语义一致）。
- provider-balance 无 required deps；新增四个插件的 peers 由 `ensurePluginRuntimeLinks` 从 runtime 树链接（可选缺失 warn 跳过），缺失会 fail loud 的只有 required deps，smoke 先行兜底。
