# 2026-10-30 Quno 侧栏入口导航回归与旧 runtime preset 覆写

> 状态：**问题记录 + 临时对策**。入口回归未修（根因未定位到代码行），本文给出全部取证与复现路径；旧 runtime 覆写 preset 已实证。修好后把对策收敛回 `docs/quno-bot-design.md` §13.2/§13.7。

## 1. 现象

点击侧栏「Quno」行：行高亮（panellist 选中态）但主区无任何变化——`main` keyed 槽的 `quno-entry` 交接页从不渲染，`ensureMain → openSession → selectPanel(null)` 交接链不执行。同屏「Plugins」「Automation tasks」 行导航正常。

## 2. 取证（2026-10-29 深夜，浏览器实机）

- **静默失败**：点击全程无 window error、无 console.error、无 DOM mutation（MutationObserver 50ms 采样 aria-current 始终 null）。`layout.selectPanel` 的 "main panel not registered" 守卫未触发 → `ctx.slots.entries('main')` 里 key 为 `quno-entry` 的条目**存在**（raw entries）。
- **keyed 槽 abdicate 机制吻合**：`ui-slots` 的 `reportEntryError` 对 single/keyed/list 槽一次性把崩溃条目从 cell 退休（`entriesOfSlot` 投影排除、raw entries 保留）——与「hasMainPanel 真、渲染投影空、retainMainPanels 复位」的全部观测吻合。疑似交接页首渲染崩溃一次后永久 abdicate；boot 插件的 entry 崩溃只有 dynamic runner 监听 `onEntryError`，**无任何用户可见出口**。
- **全新环境复现**：`mktemp` 全新 DSH_HOME + 全新 `dsh plugin add dsh-quno` + 当前 checkout 构建（`450ef07f`，client libs 13:10 / dsh-quno lib 13:18）——点击同样无反应。**与用户数据无关，是构建级回归。**
- **对照**：`ui-schedule` 的 main 面板（注册形态与 quno 完全一致的 plain-function inject）工作正常；工作区树点击会话行（同走 `uiWorkspace.openSession`）正常且 Quno 皮肤完整（`data-quno-main="main"`、头部身份、安静皮肤全在）。
- demo2 环境（旧会话 `f44bdf87`）树内点开一切正常；当晚 demo 截图里入口「好用」很可能是布局恢复的既有打开态，而非点击导航在工作。

## 3. 第二个问题：旧 runtime 打开会话会覆写 agentPreset

已安装 Desktop 的 runtime 为 `0.2.1-rc.2.zw.4`（打包早于 quno 客户端开发），`ctx.uiWorkspace` 服务在其中**不存在**（全 runtime 无该字符串）——旧 app 上入口必坏。更糟的是实证到：旧 runtime 打开 `agentPreset: "quno"` 的主会话时追加了 `agent-preset/selected: "cordis"` 事件（会话日志 seq 3，时间与点击吻合），**把 quno preset 覆写掉**，此后 `data-quno-main` 永不生效、stock 铬件全部回来。checkout runtime 无此行为。

结论：**旧 Desktop app 不能再用于打开 Quno 主会话**（会破坏 preset）；在发布带新 runtime 的 Desktop 之前，Quno 只在 checkout 起的 web 端使用。

## 4. 临时对策（已实施）

1. `plugin/dsh-quno/src/client/entry-panel.tsx` 加 `EntryCrashBoundary`：交接页渲染崩溃改为屏幕可见（下次复现时直接给出错误文本）。
2. `plugin/dsh-quno/src/client/index.tsx` **暂停 `registerSessionVisibilityFilter` 注册**（注释保留）：主对话回归工作区树可见，走「树内点会话」路径——该路径已验证全链路正常。入口修好后连同本对策一起还原。
3. 使用环境：checkout web（`DSH_HOME=~/.dsh tsx apps/cli/src/bin.ts web --port 4871`）为主；demo2（`/tmp/quno-demo2-ttoq6E`，端口 4872）已同样装上 yzj 0.2.0 focused 实例。

## 5. 跟进项

- 定位交接页首渲染崩溃原因（候选：`QunoEntryPanel` 依赖的注入面在当前构建下的求值差异；建议给 ui-slots 增加 boot 插件 entry 崩溃的 console 出口，这类静默 abdicate 太难查）。
- 修复入口导航后：还原可见性过滤、删除本对策、更新 §13.2。
- 发新 Desktop Release 带新 runtime 后，旧 app 才能重新成为 Quno 宿主。
