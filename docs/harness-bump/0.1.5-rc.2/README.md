# DeepSeek Harness `0.1.5-rc.2` 升级落地记录

> 小步上游同步：上游仅 4 个提交（feedback/file refinements backport + release 提交），无插件代码适配。本记录同时收录 fork 仓两处流程意外及其处置。

## 1. 上游变更面

- 同步基线：`dsh-v0.1.5-rc.1`（fork `v0.1.5-rc.1+zw.2`）→ `dsh-v0.1.5-rc.2`（fb2c4b9e69）。
- 实质内容：`ui-message-feedback` 客户端重构（对称提交反馈）、`ui-primitives` 的 `CodeFileIcon` 从内联 491 行组件改为 artwork manifest + 生成模块（48 个代码/配置类别导入图形）、`ui-deliverables` 卡片网格规格细化；其余为全量 package.json 版本 bump。
- 与 fork 修改面（ui-layout/ui-conversation/compaction/pi-ai 等 14 包）几乎不相交，零 API breaking。

## 2. fork 仓同步（worktree `feature/upstream-0.1.5-rc.2`）

- merge `dsh-v0.1.5-rc.2` → `4fdfad4ef0`。冲突 8 处全部为文档/i18n 配对：`ui-primitives`/`ui-deliverables` 的 zh（取上游新行为描述 + 保留 fork 术语「持有方/会话/轮次/省略号」），6 个 sidecar 哈希用 `verify-translation-pairing --write --all` 再生（805 对全绿）。
- 聚焦测试：root typecheck、`test:gui` 5343 通过、compaction 241、llm（含 pi-ai）1201。注意：worktree 需单独 `native/system` 下 `pnpm build:native` 构建 flock 绑定，否则 `llm-retry` persistence 测试报缺 `system.node`（环境性，非合并问题）。

## 3. 意外一：origin/master 停在 alpha.1 旧发布线

- 远端 master 停在 2026-09-09 的 `16c9af4a1e`（alpha.1 era：「Merge dsh-v0.1.5-alpha.1」+「fix(publish-fork): alias fork peers in every manifest field」）；rc.1 起的 fork 线（feat/rc1-toolbar-port，zw.1/zw.2 从分支 tag 发布）从未落 master。
- 对齐合并（`-X ours`）后旧线代码经**自动合并**污染 41+ 个源文件（compaction-basic、todo-completion-guard、mcp-client、web-log、snapshots 等），pre-push typecheck 拦截（`hierarchical.ts` TS2554/TS6133）。教训：**`-X ours` 只裁决冲突，挡不住自动合并；合并旧远端线后必须立刻全树 typecheck + 受影响包测试**，不能只看 `publish-fork --list`。
- 处置：源码整体恢复到 rc.2 合并树（`06d8ff58b6`），仅保留 origin 的历史笔记文件（peer-alias note 等，mermaid 块按 en 对齐）；fork master 现与发布线一致。

## 4. 意外二：上游只 bump 改动包的 manifest

- 上游 rc.2 发布提交只改了变更过的包，`dsh-todo-completion-guard` 停在 `0.1.5-rc.1`；`publish-fork.mjs --base 0.1.5-rc.2` 断言 fail fast（「tag/manifest drift」），**发生在任何 publish 之前，无半发布态**。
- 处置：fork 侧补 `chore(todo-completion-guard): align manifest version to 0.1.5-rc.2 baseline`，删除失败 tag 后在修复提交上重打 `v0.1.5-rc.2+zw.1`（7f3abc07cb）。以后每次基线 bump 需核对 14 个 FORK_MODIFIED 包的 manifest 是否全部随上游升到新基线。

## 5. 发布

- npm：CI `npm-release.yml` 发布 14 包 `@crazx/*@0.1.5-rc.2.zw.1`，`npm view` 逐一核验在线（registry 传播有分钟级延迟，逐包确认）。
- runtime pin：`runtime/revision.json` → `v0.1.5-rc.2+zw.1` / `7f3abc07cb…`。

## 6. oh-my-dsh 适配

- 版本钉全树 bump：35 个 manifest/pnpm-workspace/scripts 文件 `0.1.5-rc.1`→`0.1.5-rc.2`（official）、`0.1.5-rc.1.zw.2`→`0.1.5-rc.2.zw.1`（@crazx 面）；`source-deps.mjs` OFFICIAL/FORK 常量同步；17 个插件 lockfile 按 pnpm 11.7 再生。
- 插件零代码改动（plugins:check 全绿确认）；无插件 tag。
- 验证：`plugins:check` 15 插件 typecheck+test+build EXIT:0；`prepare-runtime.mjs` 本地组装成功（内置漂移/重复/基线扫描全过）；desktop:typecheck/test 通过。
- 桌面发版：`v0.3.0-rc.52`。
