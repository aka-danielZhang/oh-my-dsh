# 手写 `<style>` 注入未打 `data-plugin` 被 HMR 连坐删除（2026-09-08）

## 问题

用户报告桌面端（macOS，0.3.0-rc.38）左上角出现一个"飘在边上"的灰色圆角控件：桥插件的 `desktop-rail-controls`（侧栏开关 + 通知中心 + 新会话气泡）失去全部定位/复位样式，退化成 static 块堆在 overlay 层 `(0,0)`，按钮露出浏览器默认灰底，原生红绿灯（壳钉在 `trafficLightPosition {x:16,y:10}`）叠压其上；同帧可见的连带症状：品牌行的原生侧栏开关重新露出（隐藏规则同表）、三列 28px 标题带 padding 消失（titlebarCss 失效）。badge/拖拽条等 inline-style 组件全部正常——说明不是插件没跑，而是**两张 `<style>` 表（railCss/titlebarCss）从页面里消失了**。

经动态 Cordis 插件直读线上 DOM（computed style + head 全量样式枚举 + styleSheets 扫描）定位到系统性根因，与任何单个插件的结构无关。

## 根因链

1. **手写注入的 `<style>` 没打 `data-plugin`。** stock 插件 CSS 由构建时模板（dsh `tsdown.client.ts` 的 CSS emission）预打 `data-plugin` / `data-plugin-css`；桥插件的 `installRailCss`/`installTitlebarCss` 只写了自己的 `data-desktop-*` 标记。
2. **client-modules 的 `claimStyles(id)` 启发式**：每次 client bundle 物化结束时，把文档里**所有** `style:not([data-plugin])` 认领给当前物化的插件（`data-plugin=id`，HMR 簿记用）。apply 期注入的样式逃过自己物化时的认领，被之后任意一个物化的插件认领走——认领方与样式真正的主人无关。
3. **桌面壳里 HMR 常驻**：client-hmr 无条件订阅 `/plugins/events` SSE；host 侧对 clientModules 图里**每一行** bundle 做 stat 轮询，不需要 `dev:web`。本仓 profile 中 `dsh-ohmymemo` 符号链接到同级 worktree（`dsh-desktop-ohmymemo`），当晚 18:28 / 21:16 的 tsdown 重建各触发一次 `rebuilt('dsh-ohmymemo')` → 页面热重载 ohmymemo → `removeOwnedStyles('dsh-ohmymemo')`。
4. **两拍击杀**：第一次重载时 `claimStyles` 把桥的两张表误记到 ohmymemo 名下；第二次重载时 `removeOwnedStyles` 把它们当 ohmymemo 的资产删除。桥的 fiber 不重跑，样式永不恢复，直到整页重载。

**铁证**：诊断时 head 里 ohmymemo 自己的 `.omm-root` 表挂着 `data-plugin=dyn/diag-1`——它重载后重新插入、无人认领，直到诊断插件物化时被记到 diag-1 名下。同一机制反向坐实。`send-while-running` 的手写表当时被认领到 `@deepseek-ai/dsh-client-ui-jobs` 名下，仅因 stock 包永不重建而幸存。

## 决策

**插件侧打标（本 PR，四个包）**：`dsh-desktop-bridge`（rail + titlebar）、`dsh-send-while-running`、`dsh-model-efforts-editor`、`dsh-thread` 的手写 `<style>` 注入全部补上 `data-plugin` / `data-plugin-css` 与插入幂等守卫——与 dsh-model-image-input 已有的免疫写法、stock 构建模板完全同款：

```ts
style.dataset.plugin = '<包名>'
style.dataset.pluginCss = '<包名>/<标识>'   // 同时是幂等去重键
if (doc.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
```

打标后的表只会被**本插件自己的** rebuilt 清除，而那次重载的 apply 会重新插入，闭环自洽；`claimStyles` 对已打标元素不再认领。thread 的改动只落 main 源码**不 bump 版本**：thread 的当前事实源在 `feature/session-thread` worktree（main 落后于已发货 rc.7），版本合并由那条线负责。

**不做 harness 侧改动**：`claimStyles`/`removeOwnedStyles` 的启发式对「bundle 模块作用域注入」是自洽的，缺口只在 apply 期注入者未遵守打标约定；约定已有 stock 模板背书，修约定执行面（打标）比修机制面（认领/删除逻辑）影响小得多。若上游愿意，可以让 `removeOwnedStyles` 只删物化时记录进 `record.styles` 的表，而不是按 `data-plugin` 整列清除。

## 行为边界

- 打标不改变样式内容与生效时机；幂等守卫只在「同 tagId 已存在」时空转（返回 no-op disposer），与 stock emission 的防重语义一致。
- 桌面 profile 里已安装的旧构建仍是易感版本，需随下一次桌面发货（或手动 `plugin add` 开发安装，见 `docs/desktop-plugin-integration.md`）才获得免疫；在那之前 ohmymemo worktree 每次热构建仍可能再删一次（重载窗口即恢复）。
- main 上 `plugin/dsh-thread` 的 host 半 typecheck 失败（`gateway.ts` 引用 `snapshotEvents`）为既有漂移，与本改动无关，归 session-thread 线收敛。

## 验证

- 单测：bridge 92/92（新增 `installRailCss`/`installTitlebarCss` 打标 + 去重两组）、swr 16/16（installer 断言改打标 + 新增去重例）、mee 10/10、thread 35/35 全绿；typecheck 与 tsdown build 四包通过（thread host 半 typecheck 失败为既有问题，已验证与本改动无关——stash 后同样失败）。
- 实机：重启桌面 app 后标题带控件应回到 `(86,8)` 带内位、`+` 仅收起态出现、品牌行原生开关隐藏；随后用 ohmymemo worktree 触发一次热构建，桥样式应保持完好。
