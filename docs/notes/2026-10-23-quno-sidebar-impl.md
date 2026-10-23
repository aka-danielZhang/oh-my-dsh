# 2026-10-23 Quno 交互改版实施记录（work/Quno 制，偏差与实机证据）

按 `docs/quno-bot-design.md` §13（2026-10-23 work/Quno 修订版）落地 `plugin/dsh-quno`，设计修订见 `2026-10-23-quno-work-quno-tabs.md`，偏差 #11 前史见 `2026-10-23-quno-sidebar-redesign.md`。

## 落地面

- **Host**：Remote 增 `eventsRecent`（第 11 方法，`listRecentEvents` 有界查询，result codec passthrough）；`TaskWire` 扩 `plan`/`prompt`（panel 详情用，prompt 截 2000 码元、不劈代理对）。
- **Client**：
  - `sidebar.workspaces.alternate` 注册（id `quno`，label 接 locale）→ 联系人视图（在场状态在线/静默/暂停/未绑定/丢失 + 待关注徽标 + Sense 警示点 + 任务/关注子行）。
  - 总开关门控：`config.enabled === false` 时 dispose 全部门控注册（alternate/右栏面板/胶囊/铬件标记），stock 区域原样回归；设置页/任务卡/回合尾不门控（历史卡片可读，面板动作降级跳子会话）。
  - 铬件净化：`data-quno-main` 标记双席位（`header.utilities` + `hero.options`，owner token 认领安全交接）；接缝 CSS 隐藏模型/权限/plan/hero+空态工作区/面包屑；`agent-preset` 同 id `priority: -1` 遮蔽（非 quno 会话渲染简易等价文本）。
  - 右栏面板：两段式注册（kind `qunoPanel`，`keepMounted`），三视图动态/关注/任务；`SidebarRightTabParamsMap` 增 `qunoPanel: { taskId?, view? }`；自动 openTab 带 600ms 有界重试（面板 store 未就绪时 openTab 抛）。
  - 收起态胶囊：`shell.overlay` id `quno-panel-pill`，折叠判定走 `data-sidebar-right-open` 的 MutationObserver（attributes + childList，见偏差 #15）。
  - 任务卡：主按钮「在面板中打开」（openTab + params），次按钮「查看完整子会话」；服务缺席降级跳子会话。
- **测试**：新增 `tests/client-view.test.ts` 7 项（presence/counts/pill 谓词/params 收敛/eventLine/开关门控）；78 → 84 项全绿。另修 `tests/tuning.test.ts` 一次偶发失败：125 事件突发用例的少数源在随机 UUID 排序 + LIMIT 窗口下可能整窗缺席（非本改版引入），改为少数源先入使断言确定性成立（测试意图不变，注释说明）。

## 实机验证（scratch `DSH_HOME` + 隔离 headless Chrome + CDP DOM 断言）

- boot graph 含 `dsh-quno/client.js`；`quno/state`、`quno/eventsRecent` 每 15s 轮询往返。
- 浏览区：work/Quno 页签条出现；work 页签 stock 逐字节原样（搜索/添加工作区按钮俱在）；Quno 页签联系人视图渲染。
- 联系人点击 → `ensureMain` → 主对话打开，`data-quno-main` 标记落位，空态工作区选择与 hero 控件 `display:none`（computed style 断言）。
- 右栏：进入主对话自动展开 Quno 面板（动态/关注/任务渲染）；折叠 → 胶囊出现（Q + 计数，右上角 60/14），点胶囊 → 面板重开。
- settings 页、任务卡、回合尾按钮回归正常。

## 偏差与教训（对应 §18 #12–#15）

1. **#12 boot 插件无 shadowing facade**：`cordis-client-runner` 的自动负优先级只在动态 runner（运行时插件管理器）路径存在；boot 插件 single 槽注册必须显式 `priority`。本插件最终不占主槽，教训沉淀为纪律。
2. **#13 work/Quno 制**：用户纠偏推翻主槽占用方案，fork zw.6 接缝落地（见 `2026-10-23-quno-work-quno-tabs.md`）。
3. **#14 Remote 面**：只增 `eventsRecent`；`tasks.list` 未单开（state 快照已含 50 条任务 + plan/prompt 扩列）；任务详情运行日志 follow（`ctx.jobs`）未接，以子会话入口呈现。
4. **#15 胶囊展开判定**：右栏展开时面板节点可能连同 `data-sidebar-right-open` 属性一起新插入（React commit），纯 attribute 的 MutationObserver 收不到——observer 需同时观察 childList。另修一处 React #310（钩子位于条件返回之后，可见性翻转即崩，崩溃面为 `shell.overlay` 整槽条目）。
5. 残留（v1 接受）：空态首屏 composer 占位文案仍提「选择一个工作区开始」（基座 stock，位于 `conversation.composer.bar`，输入功能不受影响）。

## 发布

- fork：`v0.2.1-rc.2+zw.6` 已推送，13 个 @crazx 包随 zw.6 发布（zw.5 的 ui-workspace / cordis-client-runner 已 deprecate）。
- dsh-quno：0.2.0（本 note 同批 tag `dsh-quno-v0.2.0`）。
- dsh-desktop：revision.json / FORK_MODIFIED / FORK_PACKAGES 已对齐 zw.6；桌面 Release 打包时机由用户与另一会话（dsh-quno-sense-yzj）协调。
