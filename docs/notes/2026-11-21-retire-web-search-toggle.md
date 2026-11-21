# 退役 Web Search 开关插件（2026-11-21）

## 背景

`dsh-web-search-toggle`（2026-08-20 新写，0.2.0-rc.14 起随桌面发货，最后版本 0.1.5）解决两个上古痛点：

1. 没配 `DEEPSEEK_API_KEY` 时 `web_search` 仍对模型可见，调用即报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`——一个会踩的假工具；
2. `tool-web` 行的 `search` 开关是组合层 config，GUI 没有入口，改用 MCP 搜索（web-search-prime 等）的人无处关闭原生工具。

机制是「设置→通用」一行开关：关闭时往 `$DSH_HOME/cordis.patch.yml` 写受管块 `- id: tool-web / disabled: true`，并由 Host 侧 `system-prompt/assemble` 过滤 + `ctx.tools.guard` 跨 Agent Preset 生效。

## 为什么现在必须退役（0.2.2 的两处底座改动）

两条生效通路各断一条，且都不报错：

- **web 工具改成 per-preset 组合**。`dsh-web-app/cordis.patch.yml` 自己已经把全局 `tool-web` 行 `disabled: true`，真正的 `tool-web` 行在 `presets/{standard,cordis,ptc}.patch.yml` 里。插件关的是全局那一行 → 对 preset 内的行毫无作用。
- **`system-prompt/assemble` 瀑布不再携带 `tools`**。`packages/core/system-prompt/src/index.ts` 的 `assemble()` 传下去的 `PromptPresentation` 只有 `{sections, contexts, variables}`，`tools` 在瀑布之后才 `return { ...transformed, tools }` 回填。插件过滤 `assembly.tools` 的那一半因此空转，撤不掉 schema。
- 0.2.2 升级轮只做了类型面适配（`tools?` 可选 + 抑制函数透传未知成员，见 `docs/harness-bump/0.2.2-rc.3/README.md`），没有处理「schema 撤不掉」的后果。

实测（2026-11-21，runtime `v0.2.2-rc.3+zw.1`，桌面 0.4.0-rc.10 实机）：

| 检查 | 结果 |
|---|---|
| 开关 UI | 正常渲染「已关闭 + 密钥已配置」，Host 网关行活着 |
| home patch | 受管块在位（2026-09-02 写入，之后未变） |
| 新会话 `request/header` | `web_search` 仍被声明；`Tool.listTools` 同样在列 |
| 实际调用 | `Error: Web Search is disabled in General settings.`（guard 还在） |

即：**模型看得见、一调就报错**——正是本插件当初要消灭的假工具，被底座改版反过来重造了。

同时上游已经原生覆盖两个初衷：

- `dsh-tool-web` 每 step 按 `ctx.web.searchReady()/fetchReady()` 裁剪：选中的 provider 没有凭据就不把 `web_search` 交给模型（官方 README「Search and fetch readiness」）；
- `@deepseek-ai/dsh-client-ui-settings-web-search` 提供官方「插件 → 网页搜索与获取」页：provider 菜单、计费方式、结果数、legacy key 都在这里配，插件那行「密钥已配置」是冗余信息。

结论：**整包删除，不设替代能力**。唯一丢失的是「彻底关掉原生 web_search」这一偏好；新版只能在 preset 层做（覆盖 shipped preset 的 `tool-web` 行），已超出本插件「全局 home patch 开关」的能力边界。

## 关联面核查（退役前）

- **插件间依赖：无**。没有任何 `plugin/*/package.json` 依赖它，也没有插件 import 它的实现符号；其余包只在注释里把它当「host-gateway + client pair」范本引用。
- **脚手架**：`scripts/new-plugin.mjs` 原先把 `dual` 形态的蓝本写作本包（pin 实际取自 fs-observation-log / branding，不读本包），已把蓝本名一并改指 `dsh-usage-stats`。
- **壳**：随包清单以包内 `dsh.desktop.ship` 为单一事实源，`src/` 对插件名零硬编码（`grep find_web_search_toggle` 为空），删除包即退出安装事务；只需在 `src/install.ts` 的 `RETIRED_DESKTOP_PACKAGES` 登记。
- **runtime / fork**：无依赖。它只消费官方 `tool-web` / `system-prompt` 面。
- **CI / 发版**：workflow 走 `shipped-plugins.mjs --print`，无逐包硬编码；tarball hash 与版本键由包子段推导（`webSearchToggleTarball` / `webSearchToggleVersion` 随包消失）。
- **文档**：AGENTS roster、README 表、`docs/plugins-catalog.md`（成员沿革 + 随包清单段）、`docs/plugin-monorepo.md`（随包计数与脚手架蓝本）、`docs/electron-shell-contract.md`（安装事务与退役枚举）、`docs/packaging-playbook.md`、`docs/runtime-distribution.md` 同步。

## 落地

**仓内**

- 删 `plugin/dsh-web-search-toggle/`；根 `.gitignore` 去掉其 `lib/` 条目。
- `src/install.ts`：`RETIRED_DESKTOP_PACKAGES` 增加 `{ package: 'dsh-web-search-toggle', destRel: 'plugins/dsh-web-search-toggle' }`，复用既有判定式下船事务（语义同 `dsh-thread` / `dsh-scheduled-tasks`）。
- 脚手架与断言：`scripts/new-plugin.mjs` 蓝本改 `dsh-usage-stats`；`scripts/shipped-plugins.test.mjs` 的精确集断言去掉该包、tarball 键推导用例换 `model-image-input.tar.gz`；`src/profile-repair.test.ts` 的 fixture 换 `dsh-model-image-input`。
- 随包集合变化必须随下一次桌面 Release 下发（bump 仓根 `package.json`、推 `v<semver>`）；本次提交只改集合与文档，不代替发布。
- 文档与 CHANGELOG 见上；历史不改写——`docs/notes/2026-08-20-web-search-toggle.md`、`2026-08-21-web-search-toggle-preset-scope.md`、`2026-08-21-web-search-toggle-desktop-delivery.md`、既有 CHANGELOG 条目与历史 tag 原样保留。

**已装机用户下船**

壳的首启 Profile 事务只做幂等 `plugin add`、从不 `remove`，所以仅删仓内目录不够。登记进 `RETIRED_DESKTOP_PACKAGES` 后，桌面自己装的那一份会被判定并清理（改写 manifest 去掉依赖与 `dsh.profile.bundles` 条目、删 `node_modules` 链接、提交后删解压副本）；从 registry 或用户目录装回的副本一律保留，用户仍可自行 `plugin add`。

**用户侧残留：home patch 受管块**

`$DSH_HOME/cordis.patch.yml` 里的受管块属于用户 home 数据，壳的下船事务不碰。它现在无害（目标行本来就被 web-app 禁用），但建议清掉：

```sh
# 手工删除 BEGIN/END 标记之间的 3 行（含标记本身）
$EDITOR ~/.dsh/cordis.patch.yml
```

不把这段清理写进壳事务：安装事务对 home patch 只做只读校验（供 `--dump-config` 一致），让它改写用户 home 会引入新的破坏面。

**删除后行为**

guard 随插件消失，`web_search` 从「一调就报错」恢复为真正可用（走当前选中的 provider，默认 DeepSeek Search API、按设置页的计费方式计费）。需要继续用 MCP 搜索的人可以在 preset 层撤掉 `tool-web` 行。

## 回退

下船事务可经 shadow-CAS + journal 回滚；用户可随时终端 `plugin add dsh-web-search-toggle` 装回（需要联网或本地包，桌面不再自动安装）。回到旧版桌面会重新随包装回，下一次启动再清——与 `dsh-scheduled-tasks` / `dsh-thread` 一致。

## 验证

- `node --test scripts/shipped-plugins.test.mjs`（含精确随包集断言）。
- `pnpm run desktop:typecheck`、`pnpm run desktop:test`（profile-repair 与 install 相关套件）。
- 全仓 grep 复核：`dsh-web-search-toggle` / `webSearchToggle` 只余历史 note、CHANGELOG、本 note 与 runtime-distribution 的事故叙述。
