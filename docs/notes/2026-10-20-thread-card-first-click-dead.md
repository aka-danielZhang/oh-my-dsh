# Thread 交接卡片首击失效：null-Link 守卫挡住唯一不需要 Link 的动作（2026-10-20）

## 现象

用户在交接卡片上点「继续创建」没有任何反应：没有 spinner、没有报错、没有状态变化。卡片越新越必然如此——草稿刚生成、Link 尚未诞生时，第一次点击必死。

自动触发 Thread 交接本身不是事故：`src/tool.ts` 的 `THREAD_HANDOFF_GUIDANCE` 明确要求「刚完成一个有意义的阶段且后续阶段已显现时，即使用户没有要求也准备交接」，且 Thread 面板就是确认环节、不另行追问；该 Tool 只写惰性草稿，不创建任何 Session。真正的问题是草稿卡片的按钮点了没反应。

## 根因

`d6ec33ea`（0.3.0-rc.1「交接 saga 拆分正交 checkpoint」）把点击路径的开头改成 `if (link === null) return`。守卫的正当目的，是保护 `redeliver` / `clone` / `cancel` / `open-target` 这些必须解引用 `link.linkId` 的动作；但它同时挡住了唯一**不需要** Link 的动作——`continue-creation`。

于是形成鸡生蛋死锁：

1. 草稿由 `prepareDraft` 写入草稿表，此时**不存在** Link；`ThreadLink` 只在 `gateway.authorize()` 里诞生（初始 `target.phase: reserved`）。
2. 卡片挂载时 `refresh()` 按 `draftId` 找 Link，找不到 → `link` 保持 `null`。
3. 渲染却恰好在这个状态把主按钮设成 `continue-creation`。
4. 点击进入 `runAction`，第一行 `link === null` 静默返回。
5. 真正能干活的 `runDrive()` → `drive()` 第一步就是 `gateway.authorize()`（以确定性 `linkId` 幂等复核已存在的 Link），它才是创建 Link 的入口，但在该状态下不可达。

同一死态也会在 `loadState()` 传输失败时出现：挂载 effect 的 `refresh().catch(() => {})` 把错误吞掉，`link` 永远停在 `null`。重构前的按钮直接调 `face.continue(request)`（同样以 authorize 开头、不需要 Link），旧版可点，回归点确认在 `d6ec33ea`。

## 修复

收窄守卫而不是删除它：

- `src/recovery.ts` 新增纯逻辑——`FRESH_DRAFT_PRIMARY`（null-Link 卡片的主动作）、`drivesWithoutLink(action)`（判断是否可免 Link 执行）、`resolveCardView(link)`（null → 草稿视图，否则走 `deriveRecoveryView`）。卡片渲染什么与点击能否执行从此收进同一份可测的纯逻辑。
- `src/client/index.tsx` 的 `runAction` 在 `link === null` 分支里只放行 `drivesWithoutLink(action)` 去走 `runDrive()`，其余动作保持静默保护；渲染改用 `resolveCardView(link)`。
- 静默失败顺带治好：`loadState()` 失败留下的死按钮，现在点击会走 `drive`，出错经既有 `setError` 可见化（符合「空不发声、缺即报错」）。

## 验证

- `pnpm run test`：67 项全过；新增 3 条回归测试——null-Link 主动作可免 Link 执行、其余 7 个动作全部需要 Link、有 Link 时视图与 `deriveRecoveryView` 逐字段一致。
- `pnpm run build`：client bundle 内含收窄后的 `runAction` 守卫，`lib/recovery.js` 导出新纯函数。
- `pnpm run typecheck`：本机 `node_modules` 处于 link:source 姿态，7 条既有 `Context` 增强报错；改动前后错误集合完全一致（仅行号位移），无新增错误。
- 未做组件级点击测试：`tests/` 没有 React 渲染环境，本次以「纯函数不变量 + 构建产物核对」代替。

## 遗留

- 「初次 `refresh()` 未落定」与「确认无 Link」仍是同一个 `null`：挂载窗口期的连点会重复 `drive`（幂等，无副作用），后续可拆成 `undefined | null` 两态让按钮短暂 disabled。
- 组件级回归（真实点击 `continue-creation` 触发 drive）需要引入 React 测试环境，暂未建立。
- 本次只落源码修复，`dsh-thread` 仍为 0.3.0-rc.2；随包版本 bump（`version` + `dsh.desktop.ship.pin` + `docs/plugins-catalog.md`）属于下一次 release 提交。
