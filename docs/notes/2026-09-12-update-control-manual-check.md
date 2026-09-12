# 2026-09-12 更新入口常驻 + 显式确认下载（bridge 0.2.0-rc.17）

## 事故：用户观感「自动检查更新→下载→重启更新好像坏掉了」

2026-09-12 早晨，用户报告左上角更新入口坏了。排查结论：**链路本身没坏，坏的是「可发现性」**。

时间线（`~/.dsh-desktop/logs/updater.log`）：

- 09-11 10:39 rc.48 → rc.49 经应用内「下载→重启以更新」成功（最后一次 in-app 更新）。rc.50/rc.51/rc.52 均为用户手动 DMG 安装。
- 09-12 08:07 应用以 rc.52 启动，08:08 启动检查：当时 latest 仍是 rc.52，正确返回 current。
- 09-12 08:43 CI 发布 rc.53。下一次自动检查要到 10:08（2h interval），期间：
  - rc.16 的更新控件 `isUpdateIndicatorVisible` 在 `status === 'current'` 时**完全不渲染**——左上角没有任何可点的东西，也没有手动「检查更新」途径；
  - 壳窗口隐藏时 Chromium 对后台页面节流，2h interval 可能进一步延后（09-11 夜间的检查时间戳就有 ±2min 漂移）。

于是「发新版了但应用毫无反应、也没处点」＝用户观感的「更新坏了」。

## 决策

bridge client 半（`update-indicator.tsx`）三处改动，壳 IPC 不变：

1. **控件常驻**：更新控件在任何相位都渲染（此前 current 隐藏）。idle/current 显示
   `IconRefreshOutline16`「检查更新」，点击强制 `dsh_desktop_check_update`
   （壳侧 `claimUpdateCheck` 本就接受 current→checking，无需改壳）。
2. **查无新版**：不弹窗，控件短暂显示 ✓「当前已是最新版本」（4s 后回落）。
3. **发现新版 → 先弹窗再下载**：点击不再直接开始 ~100MB 下载，而是弹「发现新版本
   v{version}」对话框展示更新说明，「下载更新」按钮确认后才走既有
   `download_update`。防误触（对齐「破坏性/重操作需确认」的交互约定）；
   failed 的「重试」保持 re-check 后直连下载的既有路径（那是恢复被中断的下载）。
4. **visibilitychange 补检**：回到页面且距上次检查 ≥30min 则强制补检一次，
   兜住后台节流吞掉的 interval。

## 影响面

- 单位测：`update-control.client.spec.tsx` 全部交互用例改为「available 弹窗 → 下载按钮」两步；
  新增手动检查两用例。`toolbar.client.spec.tsx` 常驻控件断言。`isUpdateIndicatorVisible` 助手删除。
- 收起态 main lane 避让宽度恒为 204px 档（原 `:has([data-desktop-update-button])` 条件恒真），无布局跳动。
- 交付：随 bridge 0.2.0-rc.17 进下一版 Desktop Release（rc.54）；当前 rc.52 客户端
  在自动检查撞上 rc.53 后仍按 rc.16 行为工作（发现即弹窗开下），不受影响。

## 同日撤销（bridge 0.2.0-rc.18）

用户实机看到常驻的「检查更新」刷新按钮后否决：**只想修 bug，不想改交互流程**。
rc.18 将 `update-indicator.tsx` / `locales.ts` / `updates.ts` 与三份测试整体还原到
rc.16（`72c54a8`）逐字节一致，仅 package.json 版本走动——即恢复：

- 控件仅在 available / busy / failed（或 requested && failed）时出现，平时完全隐藏；
- 发现新版点击即弹窗并直接开始下载，完成后「稍后 / 重启以更新」；
- 后台检查 = 启动 3s 首查 + 2h interval（visibilitychange 补检一并撤销）。

教训：此插件的用户对该工具栏的改动极敏感，「修 bug」请求一律不做顺手的 UX 顺延；
静默可用性问题如需处理，先单独提案再动手。

