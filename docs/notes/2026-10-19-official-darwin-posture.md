# 采纳官方 darwin 桌面姿态，退役自研统一工具栏

日期：2026-10-19/20。修订 `docs/notes/2026-10-19-rightbar-top-and-dpb-opacity.md`（同日早前的右栏顶到顶 fork 补丁随本决策整体撤销——官方姿态原生达成同一结果）。上下文：0.2.1-rc.2 基线升级（`docs/harness-bump/0.2.1-rc.2/README.md`）。

## 决策

用户要求：右侧栏/顶部 chrome 直接用官方设计方案，不保留自研；自留面收敛为「复制会话 ID」（`dsh-copy-session-id`，官方会话头 ⋯ 菜单项，本就是插件零改动）与 Thread 按钮（`dsh-thread`，官方 `conversation.session.header.utilities` 槽，零改动）。

**壳侧（本仓）**：

1. preload 打 `data-platform=darwin` + 镜像全屏态（对齐官方 apps/desktop 的 preload-platform）；window.ts 用 hiddenInset + trafficLightPosition{16,18} + vibrancy' sidebar' + visualEffectState'active' + 透明底，附最小化兜底（electron#25368）。
2. 桥卸掉全部自研 chrome：`toolbar.tsx`/`rail.ts`/`titlebar.ts`/`toolbar-hosts.ts` 删除；更新入口与通知中心迁官方 `sidebar.footer.action` 列表槽（全平台统一，通知面板向上弹）；badge 留 `shell.overlay`。折叠态重开/新会话由官方 `shell.leading`（HeaderLeadingControls）提供。
3. e2e 探针断言改官方姿态（标记/无工具栏/拖拽行/折叠循环）。

**fork 侧（deepseek-harness）**：

1. ui-layout、ui-conversation、test-support/client-runtime 的工具栏适配（shell.toolbar 槽、ToolbarHosts portal、38px 行、收起抑制）整体回退到上游 0.2.1-rc.2 原始态；同日早前的右栏顶到顶三条 CSS 补丁一并消失（官方单主行网格下右栏本就 top:0）。
2. 新增一个窄补丁（`dsh-client-shortcuts`，发布面回到 10 包）：`detectEnvironment` 的 desktop runtime 判定从「有平台标记」改为「平台标记 **且** `window.dshDesktop` 键盘桥存在」。理由：官方把 `data-platform` 同时当视觉与 runtime 信号，desktop runtime 要求原生键盘桥（菜单加速键、before-input 拦截、chord），我们的壳不实现它；能力探测解耦后，壳可以采纳 darwin 布局而保持 web 键盘语义（DOM 派发 + localStorage 持久化——已在 web 姿态验证多月的路径）。其余 `dshDesktop` 消费方（settings-account 的 deviceInfo、chat 的 transcript view）本就是能力探测，不受影响。

## 代价与边界

- 自研工具栏的会话头 portal、New Session 收起气泡、条内更新/通知位全部退役；功能不丢（更新/通知迁侧栏底，重开/新会话走官方 leading 座）。
- web 键盘语义下无双键 chord 与菜单加速键（web 姿态同款限制）；sidebar-browser guest 的原生键转发不可用（iframe 内键走 DOM 冒泡）。
- `--dsw-specific-menu` 在 darwin 标记下全局解析为 94% 近不透明（官方值），余额胶囊弹窗透明问题顺带全局缓解（provider-balance 的实心底仍保留作双保险）。
- fork 发布面 12→10 包（撤销 ui-layout/ui-conversation/test-runtime）再 +1（shortcuts）= **10 包**。

## 验证

- fork：typecheck 5/5 绿；shortcuts dom spec 更新后过；全量套件跑绿（后台确认）。
- 壳：desktop:typecheck 0 错、desktop:test 142/142；桥 typecheck/test 绿（rail/titlebar/toolbar 三套测试随实现删除）。
- 实启：首启发现 shortcuts 构造抛「Desktop keyboard bridge unavailable」→ 29 项连锁未激活（正是 runtime 耦合的证据，促成本 fork 补丁）；补丁后待复验。

## 后续

- 若日后想要官方原生键盘体验（加速键/chord），路径是在壳实现 `window.dshDesktop.keyboard` + shortcuts IPC（apps/desktop keyboard.ts 的 261 行可作蓝本），fork 补丁自动退化为无操作（桥存在即 desktop runtime）。
- content-length Discussion 仍待用户确认后上推。
