# 移除应用内通知中心（2026-10-20）

## 背景

桌面运行态下，侧栏底部「更多」之上常驻桥插件的一枚广播图标按钮（`sidebar.footer.action` 的 `desktop-notify` 条目）：点开是当前进程内的通知列表，有未读时按钮右上角出现小圆点。用户实机反馈该入口「好像是一个消息，但感觉没啥用」——它记录的正是用户刚刚在窗口里亲眼看着跑完的回合；未读圆点提醒的是已经看过的内容，反而构成骚扰，而真正需要被提醒的失焦/后台场景早已由原生系统横幅覆盖。

## 决策

应用内通知链路整体移除，**不保留任何替代入口**：

**保留（行为不变）**

- `src/client/notifications.ts` 的安装器：仍是注意力边检测 + 原生横幅（`dsh_desktop_notify`）的唯一消费方。
- `src/client/attention.ts`：边检测纯函数，横幅仍依赖。
- 壳侧 `src/ipc.ts` 的 `NOTIFY_CLICK_CHANNEL`、`src/preload.cjs` 的事件白名单、Electron `Notification` 点击聚焦并向页面发 `dsh-desktop-notify-click`：横幅点击回跳 `sessions.open(id)` 不变。
- locale 的 `notify.turnDone` / `notify.awaitInput`：横幅正文文案。

**删除**

- `src/client/notify-center.tsx`（侧栏底按钮 + 向上弹出列表）与 `src/client/notify-inbox.ts`（进程内 inbox：最多 30 条、不落盘、未读计数、相对时间）。
- 客户端入口 `src/client/index.ts` 的 inbox 创建、`record` 探针、`notifyInjected` 与 `sidebar.footer.action` 的第二个注册；侧栏底只剩更新入口。
- `notify.center` / `notify.empty` / `notify.clear` / `notify.justNow` / `notify.minutesAgo` / `notify.hoursAgo` 六个 locale key（zh/en 同删）。
- `installNotifications` 的 `record?:` 选项：删掉 inbox 后无任何生产消费者；`installNotifications` 的单测改为断言 fake `invoke` 收到的 `dsh_desktop_notify` 参数（`surface: () => ({ hidden: true, focused: false })` 强制每条边都发横幅），断言覆盖面不变。
- 两套专属测试：`tests/notify-center.client.spec.tsx`、`tests/notify-inbox.test.ts`。

## 代价与边界

- **接受**：窗口聚焦时回合完成不再有任何留存记录（当前设计里这是通知中心的唯一独有价值）。除原生横幅外，应用内没有「通知历史」可查。
- 防灌入纪律不变：首样、空 before、列表灌入的新 idle 行仍不出边，历史会话不会变成启动时的横幅轰炸；新建/打开会话 1.5s 内的 running 脉冲仍被宽限过滤。
- 壳侧零改动：IPC 命令表、preload 事件白名单、Electron 通知后端都保持原样。

## 验证

- `cd plugin/dsh-desktop-bridge && pnpm run typecheck && pnpm run test && pnpm run build`。
- 根级 `pnpm run plugins:check`。
- `DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 pnpm desktop:dev`：探针不依赖通知按钮，应照常通过。
- 实机：侧栏底只剩「更多」（有更新时才出现更新按钮）；窗口失焦跑完一个回合 → 系统横幅照发、点击回跳会话；`git diff --check` 干净。

## 发版

桥是 desktop-owned 随包插件：版本 bump 到 `0.2.0-rc.22` 并打 `dsh-desktop-bridge-v0.2.0-rc.22` tag，桌面随下一次 `v*` Release 带出新桥；`runtime/revision.json` 无需改动（不消费 fork 新能力）。
