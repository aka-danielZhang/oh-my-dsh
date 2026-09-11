# dsh-copy-session-id：接管会话头部「⋯」菜单，增加复制会话 ID

2026-09-11 · 新插件 + 桌面随包 · 状态：已落地（0.3.0-rc.51 随桌面发货）

## 1. 背景与诉求

用户报 OpenCode Go 的 `MissingSessionID` 400（见
`2026-09-10-opencode-go-session-headers.md`）时需要把**当前会话 ID**
交给网关排查，但界面上没有取用入口：会话头部右上角的「⋯」菜单里只有
官方 `session-log-export` 提供的「下载 Session 日志」一项。

诉求：点「⋯」时菜单里多一个「复制会话 ID」选项。**不是**在头部再加一个
独立按钮。

## 2. 落点调研

- 「⋯」按钮不是通用控件：它就是 `@deepseek-ai/dsh-session-log-export`
  的 `SessionLogDownloadHeaderAction`（`moreButton` + `IconEllipsisOutline16`），
  注册在 ui-conversation 的加性 list 槽
  `conversation.session.header.utilities`，cell id `session-log-download`。
- 该槽当前占用者只有两个：`open-in-app`（order -10）与
  `session-log-download`（默认 order 0、priority 0）。
- 槽契约（`SlotCore.register`）对 list 槽的规定：**同一 id 且同一
  priority 会直接抛错**（`already has an entry with id "…" — register at a
  different priority to shadow it (lowest renders)`）；priority 升序排列、
  每个 cell 取**最小 priority 的存活条目**渲染，被压住的条目留在 ledger 上，
  压它的条目让位（dispose）后自动回归。
- 会话 ID 不来自槽的 owner props：inject 工厂（`InjectParams<K>`）在
  `scope: 'session'` 的槽上收到框架解析好的 `sessionId`（类型为
  `string`），组件 props 里没有它。

## 3. 方案

**接管 + 重渲染**，而不是新增按钮：

1. 以 `id: 'session-log-download'` + **`priority: -1`** 注册同一 cell，
   压住官方条目；
2. 组件重渲染它顶掉的东西：同款 28px「⋯」按钮、菜单里的
   「下载 Session 日志」项（走官方控制器）、下载状态弹层；
3. 菜单第一项是新的「复制会话 ID」；
4. 下载能力经 **cordis 服务** `sessionLogDownload` 消费（官方插件
   `ctx.provide('sessionLogDownload', controller)`），结构鸭子校验
   （`store.getSnapshot/subscribe` + `download/dismiss`），不 import
   官方插件实现；服务缺席或形状漂移时降级为「仅复制」菜单。

复制走浏览器两级载体：`navigator.clipboard.writeText` →
隐藏 textarea + `execCommand('copy')`，失败只记日志。

### 为什么必须 priority -1

首版（动态插件原型）沿用「同 id 覆盖」的直觉，按默认 priority 0 注册——
在 pin 住的运行时上这是**抛错**路径（同 id 同 priority），注册不会生效。
改为 `priority: -1` 后才是契约认可的抢占姿势，且天然可逆：本插件 fiber
dispose 时官方条目立即回归，卸载即恢复原样。

### 与其它被顶掉能力的边界

- 官方 `/export` 命令路径仍会调同一个 controller，其状态发布到同一
  store——本插件重渲染的状态弹层因此同样能显示它（弹层订阅 store，
  不依赖谁触发下载）。
- 弹层语义与官方一致（准备中/成功/失败 + 关闭）；额外在成功后 5s 自动关闭。

## 4. 实现要点

- `src/client/index.ts`：`inject = ['slots', 'locale', 'timer']`；
  `slots.inject` 等槽声明、`slots.register` 注册；per-session inject 工厂
  下发 `buildSessionLogActions(ctx, sessionId, defer)`——控制器一律在
  **调用时** `ctx.get` 惰性解析，挂载顺序不敏感。
- `src/client/menu.tsx`：手写菜单（不 import ui-primitives，保持 client
  bundle 零 `@deepseek-ai/*` 值导入，唯一 require 是
  `react`/`react/jsx-runtime`）；遮罩点击 / 菜单项点击 / Esc 关闭；
  `aria-haspopup/expanded/busy` 齐备。
- `src/client/copy-text.ts`：载体注入式结构切片，单测覆盖三级回退。
- `src/client/stylesheet.ts`：样式表预打 `data-plugin`/`data-plugin-css`
  并去重（2026-09-08 桥接样式认领事故的既有防线）；选择器全部落在
  `.dsh-csid-*` 自有命名空间，颜色只用 `--dsw-alias-*` 语义 token；
  「⋯」按钮照抄官方 `.moreButton` 尺寸与色（28px / 15px glyph /
  label-secondary / interactive-bg-hover）保证接管像素中性。
- 时延（复制反馈 1.6s、成功弹层 5s 自动关闭）走 Cordis `timer`
  （`ctx.timer.timeout`，disposer 交给 React effect 清理），不用裸
  `setTimeout`。

## 5. 验证与交付

- 包内 `pnpm run typecheck / test / build` 全绿（9 个单测：两级载体回退、
  鸭子校验、样式安装去重与命名空间、双语字典键对齐、双半加载面）。
- 随桌面发货：`dsh.desktop.ship: true`（tarball `copy-session-id.tar.gz`
  → `~/.dsh-desktop/plugins/dsh-copy-session-id/`，pin 0.1.0），
  由 Desktop `v0.3.0-rc.51` 携带。
- 运行时基线无需升版：所用槽与服务在 pin 住的 `v0.1.5-rc.1+zw.2`
  上均为官方既有能力。
