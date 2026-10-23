# 2026-10-23 Quno 侧栏改版二次修订：work / Quno 页签制（fork 接缝）

## 决策修订

用户看了第一版落地（占用 `sidebar.workspaces` 主槽 + 自绘「Quno / 会话」页签 + 精简会话列表）后纠偏：**「新会话」「插件」「自动化任务」应当与既有会话同属一个页签（work），Quno 独享一个页签（Quno）**。据此推翻第一版的「全局替换」取舍：

- work 页签 = stock WorkspaceBrowser **原样**（搜索、工作区树/单列、行菜单、对话框、拖拽俱在），第一版缺口清单（搜索/右键/拖拽等）整体作废。
- Quno 页签 = 联系人视图（头像 + 名字 + 状态 + 待关注徽标 + 任务/关注子行）。
- brand/新会话/插件/自动化任务等壳层行常驻，不随页签切换。

## 技术路线（fork 接缝）

插件侧无扩展点：`sidebar.workspaces` 是 single 槽，占位即整体替换；且 profile 启动的插件客户端走裸 ModuleLoader、**没有**动态 runner 的 shadowing facade（实验复现：不显式 `priority: -1` 注册即与 stock 占位者同优先级冲突抛错）。故走 fork（满足 FORK.md「确认无扩展点可用」门槛）：

- fork `v0.2.1-rc.2+zw.6`（commit 7206f5527a）为 ui-workspace 增 **`sidebar.workspaces.alternate`** 槽（list/root）+ WorkspacesRegion 包装：无备选时区域与 stock 逐字节等价；有备选时出现「work / <标签>」页签条并按页签挂载；备选 dispose（总开关关）即整体回落。ui-workspace 467 项测试 + 新增 region spec 全绿，client catalog 再生成，全仓 build 过。
- 发布：`@crazx/dsh-client-ui-workspace` 与 `@crazx/dsh-cordis-client-runner` **首发 zw.6**（zw.5 一次发布因主仓 lib 陈旧被打回，已 `npm deprecate` 并以 zw.6 重发——教训：`publish-fork` 打包的是主 checkout 的构建产物，合并后必须先整仓 build 再 publish，该纪律待写回 fork 发布文档）。
- 下游对齐：dsh-desktop `runtime/revision.json` → zw.6，`prepare-runtime.mjs` FORK_MODIFIED 与 `source-deps.mjs` FORK_PACKAGES/FORK_VERSION 同步增补，全插件 overrides 再生成。

## 影响面

`docs/quno-bot-design.md` §13（work/Quno 制）、§15.1 验收四行、§16 交互改版阶段、§18 偏差 #12–#15、§19 沿革；`plugin/dsh-quno` 侧栏注册改接缝槽、任务卡主按钮改面板联动、Remote 增 `eventsRecent`、TaskWire 增 plan/prompt。实施与实机验证记录见 `2026-10-23-quno-sidebar-impl.md`。
