# Harness 基线兼容适配 Playbook（上游同步）

官方 DeepSeek Harness（母仓 `deepseek-ai/deepseek-harness`）发布新 release 后，把 fork（`aka-danielZhang/deepseek-harness`）与 Oh My DSH 同步到新基线的标准流程。本目录下每个 `<基线>/README.md` 是该次升级的一次性落地记录；本文件是可复用的流程契约。

配套文件：发版产物与 tag 约定见 [release-runbook.md](../release-runbook.md)；插件依赖纪律见 AGENTS.md「npm 依赖纪律」；worktree 通用规范见 AGENTS.md「Git worktree 约定」；上游线锁定纪律见 AGENTS.md「基线锁定（上游线纪律）」。

## 0. worktree 纪律（硬性，fork 仓与本仓一致）

- **一切修改不在主 checkout 直接进行**。在仓库同级目录建 worktree：`git worktree add -b feature/<topic> ../<repo>-<topic>`。目录名 `<repo>-<topic>`、分支名 `feature/<topic>`，两仓 topic 一致，建议 `upstream-<新基线去 v 前缀>`（如 `upstream-0.1.5-rc.2`）；同名分支已存在（重试场景）则去掉 `-b` 复用。禁止仓内嵌套 worktree；清理只走 `git worktree remove`，禁止 `rm -rf`。
- **worktree 依赖独立**：进入后各自按包内流程 `pnpm install`（fork 仓在根装、本仓跑 `plugin:setup` + 各插件装），再构建与测试。两个全新 worktree 已知坑：fork 仓的 `native/system` 需单独 `pnpm build:native`，否则 `llm-retry` persistence 测试报缺 `system.node`；本仓的 `dsh-usage-stats` 浏览器测试吃构建产物 `lib/client.js`，`plugins:check` 前先跑一次该插件 `pnpm run build`（主 checkout 靠 gitignore 的旧产物掩盖了这一步）。

- **合并陈旧远端分支后必须立刻全树 typecheck + 受影响包测试**（0.1.5-rc.2 轮教训）：`git merge -X ours` 只裁决内容冲突，**可自动合并的旧代码 hunk 照样混入**——fork 旧 master 对齐时污染了 41+ 源文件，`publish-fork --list` 与文档配对检查均无法发现，最终靠 pre-push typecheck 拦截。
- **worktree 内读写（含本目录的 `<基线>/README.md` 落地记录与 `docs/notes/` 决策记录）一律落在 worktree**，不把主仓 checkout 当事实源；跨 worktree 只经 git（分支/合并），不直接互拷文件。
- **发布动作（npm publish、打 tag、push tag）一律在合并回 main 之后、在 main 上执行**；绝不从 worktree 分支直接发版。
- **清理有门槛**：合并且发布全部成功后才 `git worktree remove ../<repo>-<topic>` + `git worktree prune`；任何失败保留 worktree 现场并报告其路径与分支名，便于人工接手。

## 1. 检查上游新版本

- 查 GitHub API 最新 release（`curl -s https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/latest`），并以 `git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git` 拉全量 tag 兜底（防只有 tag 没有 Release 对象）。
- 读本仓 `runtime/revision.json` 的 `ref`（如 `v0.1.5-rc.1+zw.2`），`+zw.N` 之前的 semver 是当前跟随的上游基线。
- 无新于当前基线的 release/tag → 记录对比结论后结束，不做任何变更、不建 worktree。

## 2. fork 仓：合并上游 + 发新 zw 层

1. 在 fork 仓建 worktree（§0）。
2. fetch upstream → 在 worktree 分支 merge 上游新 tag → 解决冲突时**保留全部 zw 补丁** → worktree 内装依赖、跑聚焦测试（根 typecheck、client 聚合、`test:gui`、`test:web` replay、compaction 等按 FORK.md 与上轮基线记录裁剪）。
3. 测试全绿后把 worktree 分支合并回 fork main；在 fork main 上按 FORK.md「发布纪律」执行 publish-fork 流程：zw 层号在当前基础上 +1，修改包以 `@crazx/*` 的 `<新基线>.zw.<新层号>` 发 npm。
4. 打 tag 前核对发布面每个包的 manifest `version` 已等于新基线（上游 release 提交只 bump 改动过的包，fork 修改面里未被动到的包会停留在旧基线，`publish-fork --base` 会在 CI 上 fail fast——先在本地 `node scripts/publish-fork.mjs --dry-run` 暴露，避免空跑一轮 CI）。随后在 main 上打 tag `v<新基线>+zw.<新层号>` 并 push，触发 npm 发布；`npm view` 逐一核验新包在线（registry 传播有分钟级延迟，逐包确认再进下一阶段）。若 CI 断言失败：修 manifest 后**删除失败 tag 并在修复提交上重打**（fail fast 发生在任何 publish 之前，无半发布态）。
5. npm 发布失败或测试不过 = 整体中止，不带病进入下一阶段。

## 3. 本仓：兼容适配

1. 在本仓建 worktree（§0，与 fork 同 topic）。
2. 更新 `runtime/revision.json` 钉新 fork tag 与 sha。
3. 按 AGENTS.md「npm 依赖纪律」bump 各插件 devDeps 的 `@deepseek-ai/*` 基线：fork 修改面走 `@crazx` npm alias 指向新 zw 版；非 fork 面钉 fork manifest 声明的版本，禁止 `^range` 漂移。
4. 对照上游 changelog/diff 逐插件排查 breaking change（slot、ctx 服务、类型、client bundle 构建契约、settings API），逐一做兼容修复；新 Slot 注册必须 try/catch 降级，保证「新插件 + 旧 runtime」组合下每个插件完整存活。
5. worktree 内 `pnpm run plugins:check` 全树 typecheck/test/build 通过；`node scripts/prepare-runtime.mjs` 重组装 runtime 并验证（内置漂移/重复/基线扫描必须全过）；desktop:typecheck / desktop:test / desktop:smoke 按改动面取舍。
6. 有改动的插件在本 worktree 内一并 bump version；决策记入 worktree 内 `docs/harness-bump/<新基线>/README.md` 与 `docs/notes/<日期>-*.md`（随分支合并进 main）。

## 4. 合并回 main + 发版

1. 把本仓 worktree 分支合并回 main。
2. 在 main 上推有改动插件的 `<包名>-v<semver>` tag 与桌面 `v<semver>` tag（触发 `release.yml`）。tag 版本必须与合并后 main 上对应 `package.json` 完全一致（CI 有防呆）。
3. 桌面版本节奏：semver 预发布——大功能 `0.N.0-rc.x`、稳定摘 `-rc`、纯修复 `0.N.M+1`。红线：GitHub Release 不勾 prerelease；插件 Release `make_latest: false`；旧 Release 附件禁止删除。
4. 发版前终检：`revision.json` 已指向含所有被消费能力的 fork tag；desktop-owned 随包插件清单（`dsh.desktop.ship`）与版本一致；验证矩阵包含旧 runtime 组合。
5. CI 全绿、Release 揭稿核验通过后，按 §0 清理两仓 worktree。

## 5. 全局纪律

- 任何一步失败即停止并报告具体原因与已完成的进度（含两仓 worktree 路径与分支名），绝不静默降级、跳过或宣称未验证的通过。
- 发布是外发动作：凭据缺失、权限 403、CI 防呆拦截等无法自行解决的阻塞，报告并等待人工处理，绝不带病重试到通过为止。
