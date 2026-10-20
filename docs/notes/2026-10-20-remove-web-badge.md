# 删除右下角「web端」按钮，活性哨兵改走 html 标记

状态：已实施（2026-10-21，与「更新入口迁侧栏头部」同发 bridge 0.2.0-rc.23 / 桌面 0.4.0-rc.5）。验证结论见文末。

## 背景与根因

- 现状：右下角常驻 pill「web端」是 `dsh-desktop-bridge` 的 `DesktopBadge`（`plugin/dsh-desktop-bridge/src/client/badge.tsx`），注册在 `shell.overlay` 槽，`position:absolute; right:16px; bottom:16px`，点击经 `dsh_desktop_open_external` 在系统浏览器打开当前 origin。它是早期（M1/e2e 时代）「桥存活证明 + 在浏览器打开会话副本」的入口，桌面体验完整后已无存在价值，用户要求删除。
- **关键耦合（调查中确认，勿漏）**：壳的 e2e 探针（`src/preload.cjs` 的 `startE2eProbe`）把 `[data-desktop-badge]` 当作「web UI 就绪 + 桥已激活」的启动哨兵——`root && badge` 同时出现才继续探针流程，90 秒超时的失败原因即 `badge DOM missing`。直接删组件而不改探针，会让所有 e2e 跑挂（超时 fail）。

## 方案设计

删除 badge 组件及其注册；新增一个**不可见常驻标记**接替「桥已激活」的哨兵职责：桥在桌面态 apply 时给 `document.documentElement` 打 `data-dsh-desktop-bridge="1"`（effect 化，fiber 卸载即移除），探针就绪信号从 badge DOM 换成该标记。

- 为什么保留标记而不直接放宽探针条件：badge 原设计职责之一就是探针的桥活性证明；`save_file` IPC 往返虽也能隐式证明（桥未加载则下载不被拦截、探针超时），但失败路径慢且含混（区分不了「桥没加载」与「save 慢」）。一个 data 属性成本近零，保留「立等可知」的活性信号。
- 删除后 `shell.overlay` 槽桥侧不再注册，官方 UI 无其他消费者受影响。

## 实施清单

### 桥侧（dsh-desktop-bridge，与「更新入口迁侧栏头部」同一版本 0.2.0-rc.23）

1. 删除 `src/client/badge.tsx` 整文件。
2. `src/client/index.ts`：
   - 删 `shell.overlay` 注册块、`DesktopBadge`/`BadgeInjected` import、`injected` 工厂（仅 badge 消费）；
   - 保留 `callOpenExternal`（外链路由仍用）；
   - 新增 bridge 活性标记 effect（probe 为 shell 态时执行）：设置 `document.documentElement.dataset.dshDesktopBridge = '1'`，返回卸载函数删除该属性；幂等，遵守「注册即 effect」纪律。
3. `src/client/locales.ts`：删 `badge.text` / `badge.openBrowser` 两键（zh、en 各一对）；`DesktopBridgeKey` 随之缩窄。
4. 测试：现有套件无 badge 用例（已核对 `tests/`），无需删；可为标记 effect 补一个设置/清除单测（可选）。

### 壳侧（src/preload.cjs，必须与桥侧同 PR）

1. `startE2eProbe` 的就绪查询：`document.querySelector('[data-desktop-badge]')` → `document.documentElement.dataset.dshDesktopBridge === '1'`（或等价选择器 `html[data-dsh-desktop-bridge]`）。
2. 90 秒超时失败原因文案：`badge DOM missing` → `bridge marker missing`。
3. 注释同步：「the badge proves the bridge is alive」改述为标记哨兵语义，避免后来者按旧注释找回 badge。

### 文档（同 PR）

- `docs/desktop-bridge-contract.md`：功能面第 3 条「web 端指示」整条删除；第 63 行桥注册槽清单去掉 `shell.overlay`（badge），补一句活性标记约定（`html[data-dsh-desktop-bridge]` 是桥激活的稳定信号，探针依赖它）。
- `docs/plugins-catalog.md` bridge 沿革加一行。
- 本 note 转正为决策记录。
- 顺带核对 `AGENTS.md` 命令节「探针走 gate→badge DOM→save_file IPC 往返」的旧描述是否仍指向 badge（rc.21 后探针已改官方姿态断言，此处若残留 badge 字样一并修正——AGENTS 只在硬规则/索引变化时改，此句属命令节事实修正，允许）。

## 风险与注意

- 唯一实质风险就是探针耦合本身：若壳与桥不同 PR 发布，旧壳（等 badge）配新桥（无 badge）的组合会让 e2e 超时——但正式发版走桌面 Release 锁步（壳与随包插件同包），实际不会出现错配；开发联调时需同时 checkout 两侧。
- 标记名 `data-dsh-desktop-bridge` 需与 fork/官方命名空间不冲突（`data-desktop-*` 前缀已是桥的自留惯例，沿用 `data-desktop-bridge-live` 亦可，实施时定一个即可，contract 文档记为准）。

## 验收标准

1. 桌面内右下角无 pill；DOM 无 `[data-desktop-badge]`；`html` 根带 `data-dsh-desktop-bridge`。
2. `DSH_DESKTOP_E2E_PROBE=1 pnpm desktop:dev` 与 `... DSH_DESKTOP_E2E_EXIT=1` 全绿（探针经新标记正常启动、save_file 往返 ok）。
3. scratch home 实机挂载：桥正常加载（标记在），外链路由、下载桥、更新入口、原生通知全部存活。
4. `pnpm plugins:check` 绿；壳 `pnpm run desktop:test` 绿。

## 发版

与「更新入口迁侧栏头部」合并为桥 0.2.0-rc.23 一个版本、一次桌面 `v*` Release（v0.4.0-rc.5）。本方案不依赖 fork tag，若需先行单独发版亦可独立成立（此时 revision 钉版不动）。

## 落地与验证（2026-10-21）

- 标记名最终取 `data-dsh-desktop-bridge`（`document.documentElement.dataset.dshDesktopBridge = '1'`），effect 化、随 fiber 卸载移除；探针条件 `root && documentElement.dataset.dshDesktopBridge === '1'`，超时文案 `bridge marker missing`。桥契约文档与壳契约、AGENTS 命令节、packaging-playbook 的探针描述同步改写。
- `shell.overlay` 上游仍有其他消费者（`ui-settings-general` 的 `host-release-change` 等），本插件撤出自己的 additive 条目不影响它们；`sidebar.toggle.badge` 的角标改由「更新入口迁侧栏头部」方案一并接管。
- 桥侧同时删掉仅 badge 使用的 `injected` 工厂与 `callOpenExternal` 的 badge 调用点；`callOpenExternal` 本身保留（外链路由捕获阶段仍在用）。
- 验证：`DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1` scratch home 跑通（`DSH_E2E_OK` / exit 0）——探针经新标记正常启动、官方姿态断言与 save_file 往返全过；桌面内 DOM 无 `[data-desktop-badge]`、`html` 带标记。同一轮 e2e 也覆盖了「更新入口迁侧栏头部」的落位，两者共用一次验证。
- 仍需人工一次：确认桌面右下角视觉上再无 pill（自动化只断言了哨兵与探针链路）。
