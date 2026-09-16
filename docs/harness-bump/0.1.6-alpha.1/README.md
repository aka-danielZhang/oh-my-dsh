# DeepSeek Harness `0.1.6-alpha.1` 升级落地记录

> 大版本跳跃：上游自 rc.2 合并点起 800 个提交（约 36 万行），含 composer 命令菜单、asar runtime、MCP 资源提供方（`mcp-resources`）与连接生命周期重构、VFS 修复、sticky collapsible headers 等。

## 1. fork 仓同步（worktree `feature/upstream-0.1.6-alpha.1`）

- merge `dsh-v0.1.6-alpha.1`（0a15e36e7f）→ `d4080f6b19`，26 处冲突：20 处文档/i18n 配对（取上游生成物 + `gen-cordis-catalog` 再生成 + `--write --all` 重录，936 对全绿）、6 处代码。
- **流程事故**：批量 `git checkout --theirs` 清文档冲突时，把 5 个已手工合并、但索引仍处冲突态的代码文件一并打回上游版（connection.ts、client/modules、ui-conversation 会话骨架、tool-cordis 目录、gen 脚本），fork 的 status 事件/portal/scoped-republish 短暂丢失。根因：**冲突态文件在工作区已解但未 `git add` 时，`--diff-filter=U` 仍然列出它们**。已用文件级三方合并（`git merge-file`，base=fb2c4b9e69）重做并逐文件立即 stage（修复提交 ed04ee3166）。教训回填 playbook：**每解一个冲突立即 `git add`，绝不批量留到最后**。

## 2. 冲突解法要点（后续同型冲突参照）

- `scripts/gen-cordis-catalog.ts` + `tool-cordis/api-catalog.ts`：双方各自追加目录条目 → keep-both；上游新增三张分类表（`TYPE_LINK_EXEMPTIONS`/`LINK_MAP`/`EVENT_SCOPE_PAGE`）需要补 fork 条目：`McpClientStatus`（exemption）、`ReasoningEffortId: 'llm-streaming.md'`、`'mcp-client': 'tools.md'`。
- `mcp-client/connection.ts`：上游重构生命周期（`settleFailedGeneration`/`closeClient`/`waitForClose`），fork 的 `publish()` 状态发射移植到新结构——发射点语义保持：初始 connecting、sync swap 计数、connected、reconnect 计时器、give-up 双发射（决策 + 排队注销）、!quiesced 失败、dispose 首尾。`!quiesced` 的发射折进上游 helper 内部。
- `client/modules/src/index.ts`：fork 的 `exactPackageSpecifier`/`parseDshClient` **已被上游收编**进 `src/client/manifest.ts`（import 即可），仅 `manifestOwnsLoaderPackage`（scoped-republish 所有权匹配）未收编，作为本地函数恢复。
- `ui-conversation/ConversationSession.tsx`：会话头 toolbar portal 自动合并成功，仅 import 行冲突；fork 原 `useEffect` 用法被上游重构吸收，去死导入。

## 3. fork 仓的测试适配（非生产代码变更）

- 上游改了 MCP SDK 导入面：`Client` 从 `@modelcontextprotocol/sdk/client/index.js` 改为 **`@modelcontextprotocol/client`**，transport 构造移入 `./transport.ts` 的 `createTransport`；sync 面从 `request('tools/list')` 改为 `getServerCapabilities()` + `listTools()`，listChanged 从 `setNotificationHandler` 改为构造参数 `onChanged`（fire-and-forget）。fork 的 `status.spec.ts` 假件整套重接（mock 路径、MockClient 补 `transport`/`getInstructions`/`getServerCapabilities`/`listTools`/`callTool`、onChanged 触发 + `vi.waitFor`），`exactOptionalPropertyTypes` 下字面量不得写显式 `onclose: undefined`。
- 新上游包 `ui-sidebar-terminal` 的 spec 桩补 `useToolbarHosts: selector => selector(null)`（fork toolbar 标准属性，rc.1 轮 27 个 fixture 的延续）。

## 4. 验证与发布

- fork：root typecheck ✓；`test:gui` 391 文件 5585 通过 ✓；compaction+llm+mcp+extensions+guard 2093 通过 ✓（status 14/14）。
- manifest 基线核对：14 个 FORK_MODIFIED 包中又是只有 `todo-completion-guard` 落后（上游只 bump 改动包）——本次在打 tag **前**于 worktree 内补齐（7e5d4b27be），CI 一次通过，未空跑。
- 发布：tag `v0.1.6-alpha.1+zw.1`（d21e18434b）发布 14 包 `.zw.1`；随后发现上游打包缺陷追加 `zw.2`。

## 4.5 意外三：上游 tarball 依赖声明被发布管线剥掉

- `@deepseek-ai/dsh-client-ui-primitives@0.1.6-alpha.1`（官方）的 lib 引 `structuredPatch`（`diff` 包），但发布产物 `dependencies: null`（上游仓内 manifest 有 `diff: ^9.0.0`，是发布管线剥的）——上游自己的 workspace 靠提升侥幸可用，pnpm 隔离安装（插件、runtime 组装）全部炸：vite `Failed to resolve import "diff"`。
- 修法（两段式）：先走了 fork 显式代发名单 `scripts/publish-fork-extra.json`（源码 diff 永远看不见「上游产物缺陷」）→ `v0.1.6-alpha.1+zw.2`（71e3b8c96c）以 15 包整层重发 `.zw.2`，FORK.md 记了机制；随后确认 `diff` 只是 ui-primitives 新外部依赖族的新成员（shiki/clsx/anser/katex/micromark 同族早就在消费者 devDeps 里钉着），按既有先例回退到消费侧补钉（bridge/usage-stats/mcp-settings devDeps + `diff: ^9.0.0`），extra 名单清空、机制保留。
- 消费侧连锁：`dsh-desktop-bridge` 0.2.0-rc.19、`dsh-usage-stats` 0.1.4（vitest `server.deps.inline` 正则放宽为 `/@(deepseek-ai|crazx)\//`——crazx 包不 inline 则 lib 的 `.module.css` 在 Node 侧炸 + devDeps 补 diff）。

## 4.6 意外四：dsh-mcp-settings 测试套整体迁移（新 SDK 面 + mock 链路失效）

- 上游 0.1.6 把 MCP SDK 换成新包 `@modelcontextprotocol/client@2.0.0`（ESM），`dsh-mcp-client` 的 lib 以外部化 CJS 引用它——vi.mock 与 vite alias 都拦不到 externalized CJS 的 require(esm) 链路，旧 SDK mock 全数失效（真 SDK 被拉起 → `SdkError: Connection closed`）。
- 且 manager/inventory 的驱动面变了：`getServerCapabilities()`/`listTools()` 取代 `request('tools/list')`，listChanged 从 `setNotificationHandler` 改为构造参数 `onChanged`（fire-and-forget），transport 构造移入 lib 内联的 `createTransport`。
- 修法：**在 importer 边界整体替换**——`vitest.config.ts` 的 `resolve.alias` 把 `@deepseek-ai/dsh-mcp-client` 指向 `tests/mcp-client-fake.ts` 可控假件（cordis 消费面 name/inject/apply/Config 四件套；Config 必须实现 Standard Schema 的 `Config["~standard"].validate`，inject 必须声明 `["tools"]` 否则 ctx.tools 拒访；工具定义 output 需 `{ schema, render }`）。测试改为驱动假件事件（连接/drop/respawn），凭据断言从「SDK 构造参数」改为「假件收到的 composed config」——manager 侧凭据合并逻辑的覆盖不变。60/60 全绿。
- 教训：externalized CJS 依赖的 mock 只有三条路——deps.optimizer 预打包（会把真依赖烤死）、noExternal（本仓 vitest 4.1.8 未生效）、importer 边界 alias（本次采用，最稳）。

## 5. oh-my-dsh 适配

- `runtime/revision.json` → `v0.1.6-alpha.1+zw.2` / `71e3b8c96cb761dfa3a3007e08ec372d98eecb91`；35 个钉版文件 bump（official `0.1.5-rc.2`→`0.1.6-alpha.1`，fork 面 →`.zw.2`，ui-primitives 换 @crazx alias）；17 个插件 lockfile 再生。
- 插件逻辑零改动；两个插件因 vitest inline 正则修复 bump（见 §4.5）。
- `dsh-ohmymemo` devDeps 补 `@deepseek-ai/dsh-sandbox`（0.1.6 的 dsh-tools 新增该 peer，autoInstallPeers off 下必须显式供，与 mcp-settings 同款）。
- 桌面发版：`v0.3.1-rc.4`。

## 6. 追加修复（2026-09-16 下午）：rc.4 sidecar 启动回归

`v0.3.1-rc.4` 装机即崩：0.1.6 typert-loader 新增 manifest 归属校验，`@crazx/dsh-api-session-controller` 的生成产物 `lib/typert.host.js`/`typert.remote-client.js` 内嵌 `@deepseek-ai` 名字被拒 → 31 条目激活失败 → HMR 缺失 → app-boot 退出。根因、修复（fork `v0.1.6-alpha.1+zw.3`：publish-fork staging 重写 typert 所有权）与「smoke 必跑」教训见 `docs/notes/2026-09-16-rc4-typert-ownership-regression.md`；桌面修复版 `v0.3.1-rc.5`。
