# 更新入口迁至侧栏头部（topStrip toggle 旁），收起态走角标

状态：已实施（2026-10-21，fork `v0.2.1-rc.2+zw.4` / bridge 0.2.0-rc.23 / 桌面 0.4.0-rc.5）。实施偏差与验证结论见文末。

## 背景与根因

- 现状：更新下载按钮（`dsh-desktop-bridge` 的 `UpdateControl`，`plugin/dsh-desktop-bridge/src/client/update-indicator.tsx`）注册在官方 `sidebar.footer.action` 列表槽，被官方 `ui-sidebar` 渲染在侧栏底部 footerActions 区、「更多」按钮（`settings-account` 注册的 ⋯/头像菜单入口）正上方，视觉上像「更多」的附属按钮，语义突兀。
- 历史：rc.14–rc.20 时代更新入口在自研统一工具栏顶部；rc.21「官方 darwin 姿态」（`docs/notes/2026-10-19-official-darwin-posture.md`）退役自研 chrome 后迁入 `sidebar.footer.action`，该位置是迁移过渡产物。
- 结构约束：官方 0.2.1-rc.2 基线在顶部区域（darwin topStrip / logoRow 的 toggle 旁）没有任何可注册槽；`sidebar.toggle.badge` 仅收起态且是按钮内角标位，`shell.leading` 仅 darwin 收起态挂载，均承载不了展开态的完整按钮；topStrip 无稳定 data 锚点（类名为 CSS-module hash），DOM 注入违背仓纪律「只锚 documented slot seams」。

## 方案设计

fork `ui-sidebar` 新增一个窄槽 `sidebar.header.action`（single），渲染在侧栏头部、toggle 按钮**左邻**；桥把更新按钮从 footer 槽迁到新槽；收起态由官方 `sidebar.toggle.badge` 槽渲染小角标接管（rail 宽 56px 放不下第二个按钮，角标点击穿透给 toggle，展开后操作）。

- 展开态（全平台）：`[品牌 … 更新按钮][toggle]`，低频系统入口不占工作流区；有更新才渲染（维持 rc.18 条件可见形态），平时顶部干净。
- 收起态（全平台）：toggle 上角标（available/ready/failed 小圆点，downloading 微进度环）；`wide=false` 时 header 槽返回 null。
- 降级：旧 runtime（SlotMap 无新槽）上注册失败仅 warn，回落注册现状 `sidebar.footer.action`（rc.22 行为），角标槽（上游 0.2.1-rc.2 已有）照常注册。

## 实施清单

### fork 侧（deepseek-harness fork，同级 worktree，按 docs/harness-bump/README.md）

1. `packages/client/ui-sidebar` 回到 fork 发布面（fork 发布面 10 → 11 包）。
2. `src/client/contract/slots.ts`：
   - SlotMap 声明 `'sidebar.header.action': { kind: 'single'; scope: 'root'; owner: SidebarHeaderActionOwnerProps }`；
   - `SidebarHeaderActionOwnerProps { wide: boolean }`（与 footer.action 同形）；
   - `SidebarRootComponentProps` 的 `PropsRenderSlots` 联合补该槽。
3. `src/client/SidebarRoot.tsx` 两个渲染点（DOM 顺序均为 header 在前、toggle 保持最右）：
   - darwin topStrip：children 从 `[toggle]` 改 `[renderSlot('sidebar.header.action', { wide }), toggle]`；
   - 非 darwin / 无平台标记的 logoRow：toggle 左邻同款插入（windows-titlebar 展开态即获得位置；其收起态 logoRow height 归零，由角标接管）。
4. 发 fork tag `v0.2.1-rc.2+zw.<N>`；fork 面清单与发布记录同步。

### 桥侧（dsh-desktop-bridge，版本 0.2.0-rc.23 起）

1. `src/client/index.ts`：
   - 注册 `sidebar.header.action` → `UpdateControl` 的 header 形态，整个 `ctx.slots.inject(...)` 包 try/catch；成功时不再注册 footer 槽；
   - catch（旧 runtime 无此槽）→ 降级注册 `sidebar.footer.action` 现状形态；
   - 新增注册 `sidebar.toggle.badge` → `UpdateBadge` 角标（同样 try/catch；上游 0.2.1-rc.2 起自带该槽）。
2. `src/client/update-indicator.tsx`：
   - `UpdateControl` 接 `SidebarHeaderActionOwnerProps`：`wide=true` 渲染现有 22px 按钮（交互/弹窗/状态机全不动），`wide=false` 返回 null；no-drag 规则沿用现有 `UPDATE_CONTROL_CSS`（topStrip 为拖拽区，`-webkit-app-region:no-drag!important` 已备）；
   - 新增 `UpdateBadge`：可见条件同 `isUpdateIndicatorVisible`；available/ready/failed 渲染小圆点、downloading 渲染微型进度环（`updatePercent`）；绝对定位叠 toggle 右上角，`pointer-events:none` 让点击穿透给 toggle（点角标 = 展开侧栏）；样式只用 `--dsw-*` 语义 token，手写 `<style>` 预打 `data-plugin`/`data-plugin-css` 并幂等（2026-09-08 HMR 事故纪律）；
   - footer 降级形态保留现实现不动。
3. devDeps：`@deepseek-ai/dsh-client-ui-sidebar` 钉到 fork tag；同版 `runtime/revision.json` 钉同一 tag（rc.46 纪律：随包插件消费 fork 新能力必须钉到声明该能力的 fork tag）。
4. 测试（`tests/update-control.client.spec.tsx` 或新文件）：header 形态 wide true/false 两态；角标四相位渲染；降级路径（header 槽注册抛错 → footer 注册生效）。

### 壳侧（src/）

- e2e 探针（`src/preload.cjs`）：现有 `assertSidebarCycle` 以 aria-label 找 toggle，不受影响；无更新按钮断言（条件渲染，不强制）。可选增强：`[data-desktop-update-button]` 存在时断言其位于侧栏列顶部区域。

### 文档（同 PR）

- `docs/desktop-bridge-contract.md` 功能面第 4 条重写：侧栏底 → 侧栏头部（topStrip/logoRow toggle 旁）+ 收起态角标 + 降级链；第 63 行槽清单同步。
- `docs/plugins-catalog.md` bridge 沿革加一行（注明 fork 依赖与 revision 钉版）。
- 本 note 转正为决策记录。

## 风险与注意

- fork 面 +1 包：上游升级时该窄补丁需 rebase（两个 renderSlot 点 + 一条声明，预期冲突面小）。
- topStrip 拖拽区与按钮并存：no-drag 已有，但 rc.20 教训表明合成点击绕过原生拖拽命中测试、e2e 对此类回归失明——上线前须手工真实鼠标验证一次「按钮可点且不引发窗口拖拽」。
- 角标 `pointer-events:none` 设计：上游当前无 `sidebar.toggle.badge` 消费者，穿透行为安全；若未来官方启用该槽需复核。

## 验收标准

1. 展开态有更新：topStrip 出现 `[更新按钮][toggle]`；点击后的检查/下载/取消/ready/重启全链路与 rc.22 行为一致。
2. 收起态有更新：toggle 右上角角标；点击 toggle 展开，顶部按钮可操作。
3. 无更新：按钮与角标全静默，顶部与 rail 零残留。
4. 旧 runtime 降级：按钮回到「更多」上方原位（footer 槽），无 crash、仅一条 warn；角标不渲染。
5. `pnpm plugins:check` 绿；壳 `pnpm run desktop:test` 绿；`DSH_DESKTOP_E2E_PROBE=1 pnpm desktop:dev` 绿；scratch home 实机挂载验证通过。

## 发版

桥随桌面 `v0.4.0-rc.5` 一处发（desktop-owned，不单独打插件 tag；属随包清单变化，锁步纪律见 docs/release-runbook.md）。依赖顺序：fork tag 先发 → 桥 devDeps/revision 钉版 → 桥发版 → 桌面 Release。

## 落地与验证（2026-10-21）

**实际顺序**：fork `24a4ae31` → tag `v0.2.1-rc.2+zw.4`（发布面 10 → 11 包，npm `@crazx/*@0.2.1-rc.2.zw.4`）→ 桥 devDeps（`dsh-client-ui-sidebar` + `dsh-api-session-controller` 同步 zw.4）与 `runtime/revision.json` 钉版 → 桥/壳实现 → 桌面 `v0.4.0-rc.5`。

**与原方案不同的三处（都是实施中查出的事实）**：

1. **降级不能靠 `try/catch` 包 `slots.inject`**：`slots.inject` 对「槽从未声明」的语义是**等待**，不会抛错；旧 runtime 上 `inject('sidebar.header.action')` 只是永不回调，既不降级也不警告。落地改为在 `sidebar` 声明回调里读 `slots.spec('sidebar.header.action')`——它是 `sidebar` 的子槽，随同一次声明提交，因此「此处没有声明」即等于「这个 runtime 没有该槽」——再决定注册 header 还是 footer；两处注册各自 try/catch 兜底（header 抛错也回落 footer）。
2. **`sidebar.toggle.badge` 上游已有消费者**：`ui-settings-general` 在该槽注册了惰性官方角标（读 `globalThis.dshDesktop.updates`，本壳不提供该载体，渲染恒为 null）。single 槽同优先级再注册会**抛错**，且最低优先级渲染，所以桥必须用 `priority: -1` 覆盖它——方案原文「上游当前无消费者」不准确。
3. **两个 renderSlot 点必须平台互斥**：darwin 只走 topStrip、非 darwin 只走 logoRow（与 toggle 同款条件），否则 darwin 展开态会出现两个更新按钮。

**其他落地细节**：收起态 header 控件直接卸载（返回 null），角标无法共享其状态，因此角标自带轮询（静默 1s / 忙碌 150ms，`dsh_desktop_update_status` 只读快照）；两张手写 `<style>` 均预打 `data-plugin`/`data-plugin-css`（`dsh-desktop-bridge/update-control`、`.../update-badge`），顺带把 rc.10 起就漏标的 control 样式表补上标记；角标 `pointer-events:none` + `role="img"`，点击穿透给 toggle，读屏把更新状态并入开关的可访问名。

**验证**：ui-sidebar 52 项（含新增「header 座在 toggle 左邻、收起态 wide=false」两例与快照更新）；桥 16 项组件 spec + node:test 全套；`desktop:typecheck` / `desktop:test`（148 项）绿；`runtime/build/24a4ae31...` 组装通过；`DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1` scratch home 实机 `DSH_E2E_OK` exit 0（探针经新桥标记启动、官方姿态与侧栏折叠/展开循环、save_file 往返全过）。

**未自动覆盖、需人工一次**：真实鼠标点击头部更新按钮、确认它不引发窗口拖拽（rc.20 教训：合成点击绕过 `-webkit-app-region` 命中测试，e2e 对此类回归失明）；以及有更新时的视觉核对（顶栏 `[更新][toggle]` 间距、收起 rail 角标位置）。`pnpm plugins:check` 在 `dsh-ohmymemo` 处红——与本方案无关（其 `tests/dsh-contract.test.ts` 的 `tools.restrict()` 契约断言与当前 harness 源不匹配，本地把 harness checkout 的 `lib/` 重建后才暴露；插件运行期代码走 `agentCtx.tools.restrict`，不受影响），发布走 `DSH_DESKTOP_PREPARE_MODE=build` 的构建门。
