# 2026-10-30 Quno 入口导航回归——根因定位与修复

> 修订 `2026-10-30-quno-entry-navigation-regression.md`：该文的「silent abdication」理论**不成立**，本文以实机取证给出真根因与修复；该文的临时对策已按其清单收敛。设计文档 §13.2/§13.7 的措辞收敛仍待作者完成。
>
> **2026-10-30 二次修订（zw.9 实机）**：§2 的顺序修复本身成立，但**不充分**——`dsh-quno` 客户端 `inject` 未声明 `layout`/`uiWorkspace`，服务提供晚于插件 apply 时 `ctx.get('uiWorkspace')` 在整个会话内都是 `undefined`，`openSession` 静默无效（面包屑 `after-open` 正常、当前会话不变）。修法与复现证据见 [Quno 侧栏选中态 §8.1](2026-10-30-quno-sidebar-selection-state.md)。

## 1. 根因（修正上文理论）

上文取证推断「`main` keyed 槽首渲染崩溃 → ui-slots 一次性退休条目（abdicate）」。实机 CDP 取证（已安装 Desktop `v0.4.0-rc.6`，runtime `09a144fd`＝zw.7）**推翻**了它：

- `QunoEntryPanel` 挂载并完整执行了交接链——`window.__qunoDebug` 面包屑（组件内已埋）每击显示 `before-open → after-open → after-back` 全序，`openSession(主会话 id)` 调用成功、无 `threw`、无 console 输出、`EntryCrashBoundary` 从未触发。「静默 abdicate」没有任何证据。
- 真根因：**时序**。`openSession` 走 `ctx.get('uiWorkspace').openSession`，而该调用发生时主区仍是本交接面板（`main` keyed 槽选中态）——workspace/conversation 视图不在激活位，`openSession` 落不了位；随后 `backToConversation`（`layout.selectPanel(null)`）把布局交还，显示的自然是「原来的对话页面」。对照组（树内点会话行）之所以一直正常，正因为点击时 workspace 视图处于激活位。

## 2. 修复

`plugin/dsh-quno/src/client/entry-panel.tsx`：交接顺序换为 **`backToConversation()` 先、`openSession(sessionId)` 后**（代码内注释已注明原因与日期）。实机验证：点侧栏「Quno」行 → `data-quno-main="main"` 立即生效、头部出现「Quno／对话／轨迹」身份与视图签、正文切入 Quno 主会话。

## 3. 可见性过滤按清单还原（带版本差说明）

`plugin/dsh-quno/src/client/index.tsx` 的 `registerSessionVisibilityFilter` 注册已恢复（上文对策 2 撤销）。**版本差**：该方法是 fork `450ef07f`（feat(workspace): support contributed session visibility）引入，**晚于 `v0.2.1-rc.2+zw.7` tag**——桌面 runtime 的 `dsh-client-ui-workspace` 构建里没有它，duck-check 使注册在桌面静默跳过（主会话暂时仍留在工作区树，无害）；等 fork 出下一层（含 450ef07f）并 bump 桌面 runtime 后自动生效。

## 4. 桌面宿主结论（取代上文 §3 的部分结论）

`v0.4.0-rc.6`（runtime zw.7）实机：树内/入口两条路径打开 Quno 主会话均无上文 §3 的 preset 覆写（`data-quno-main` 正常生效、安静皮肤在）——「旧 Desktop 不能再作 Quno 宿主」的限制随 rc.6 发布解除；入口回归与本修复与宿主版本无关（构建级），但 rc.6 是首个可安全作 Quno 宿主的桌面版。

## 5. 遗留

- `docs/quno-bot-design.md` §13.2/§13.7 按本文措辞收敛（作者完成）。
- fork 下一层（含 450ef07f）发布后，桌面可见性过滤自动生效；届时工作区树不再出现 Quno 主会话行，入口是唯一入口。
- 上文建议的「ui-slots 给 boot 插件 entry 崩溃加 console 出口」仍有价值（本次虽证明非崩溃，但静默失败类问题缺出口的诊断成本已被证实）。
