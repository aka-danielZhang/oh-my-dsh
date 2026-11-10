# 2026-11-10 — 插件依赖改链守卫（desktop:dev 遗留的半混合依赖图）

## 现象

Quno Collector 重构的验证中，跑过一次 `DSH_DESKTOP_E2E_PROBE=1 pnpm desktop:dev` 之后，`pnpm run plugins:check` 在 `dsh-ohmymemo` 的 `tests/dsh-contract.test.ts` 失败 8 项（`restrict(allow: [])`、`HarnessError`、`concludeTurn` 等）；`dsh-quno` 的评测器同期出现 `Context` 缺 `[symbols.isolate]` 的类型双实例冲突。主仓的 ohmymemo 自 2026-10-30 一次 desktop:dev 起即处于同样状态（9 项失败）。

## 根因

`scripts/shipped-plugins.mjs` 的 `linkPluginRuntimeDeps()` 在 desktop:dev 时把每个随包插件的 `@deepseek-ai/*` runtime peers 改链到开发 runtime（worktree 里是 harness checkout，主仓里是 `runtime/build/<sha>`）。这是有意的：sidecar 必须与插件共用同一份模块实例。但链接在应用退出后保留，且**只改 peers**——传递依赖仍解析到包自己 `.pnpm` 里的 registry 副本。于是插件目录里的测试跑在半混合依赖图上：两份 cordis 并存，按 symbol 判定的作用域检查（`tools.restrict()` 要求 agent 作用域）跨实例失效。

排查确认这**不是**产品问题：
- 报错文案 `requires a scoped context` 在官方 rc.2 包里同样存在，是上游 2026-07 起的既有语义，zw.9 没有改它；
- ohmymemo 生产路径在 `ctx.agents.create({ setup: (agentCtx) => agentCtx.tools.restrict(...) })` 里调用，`agentCtx` 本身就是 agent 作用域；
- 真实桌面最近 15 次会话日志里没有这条报错；
- 按锁文件干净重装（恢复纯 registry 依赖图）后，ohmymemo 240/0、全仓 20 包全绿。

## 决策

- 新增 `scripts/plugin-links.mjs`：`--check` 扫描 `plugin/*`，manifest 非 `link:` 的 `@deepseek-ai/*` 依赖若解析到包自身 `node_modules/.pnpm` 之外（或链接已断）即列出并退出 1；`--restore` 对这些包按各自锁文件干净重装（`rm -rf node_modules` + `pnpm install --frozen-lockfile`）后复查。
- `pnpm run plugins:check` 先跑 `--check`：半混合状态下直接报错并给出 `pnpm run plugins:restore-links`，不再让测试在不可信的依赖图上给出误导性结论。
- `link:source` 调试态在 manifest 里声明 `link:`，属主动选择的状态，跳过。
- 不改 desktop:dev 的改链行为本身：退出时自动复原对被杀进程不可靠，而下一次 desktop:dev 启动本就会重新改链；在「跑测试」这一侧把关，成本最低、信号最清楚。
- `scripts/plugin-links.test.mjs` 进 CI（与其它 scripts 测试同列）。

## 现状

worktree 已恢复并通过守卫。主仓（`~/workspace/dsh-desktop`）只读扫描查出 12 个插件处于改链状态；未替用户改动主仓环境——合并后在主仓跑一次 `pnpm run plugins:restore-links` 即可（下一次 desktop:dev 会照常重新改链，这是开发态的预期）。
