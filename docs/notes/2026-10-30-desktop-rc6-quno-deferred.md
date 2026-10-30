# 2026-10-30 — v0.4.0-rc.6 不随 quno：三件套 ship 翻 false

## 背景与决定

- `dsh-quno` 与 `dsh-quno-sense-calendar` / `dsh-quno-sense-feed` 于 2026-10-23 落仓时即标 `dsh.desktop.ship: true`（catalog 随包清单同日入册），但 quno 仍在快速迭代（工作区留有大量未提交 WIP），未达随桌面交付门槛。
- 2026-10-30 决定：`v0.4.0-rc.6` 只交付 fork runtime 对齐（revision 钉 `v0.2.1-rc.2+zw.7`、`FORK_MODIFIED` 扩员 `dsh-client-ui-workspace` / `dsh-cordis-client-runner`）与随包插件现状，**不携带 quno 三件套**——三包 manifest 翻 `ship: false`，catalog 随包清单同 PR 改写。
- `dsh-quno-sense-yzj` 本就未标 ship（见 `2026-10-23-quno-sense-yzj-impl.md`「留给发版决定」），本次维持原状。

## 影响

- `prepare-desktop-bundle` / `check-shipped-plugins` / 首启安装事务均按 manifest 的 `dsh.desktop.ship` 扫描，quno 三包自动出局，workflow 无需改动。
- 代价：quno 的 typecheck/test/build 退出 CI 的 shipped 集合，期间本地自行跑（`cd plugin/dsh-quno && pnpm run test`）。
- dev 路径不受影响：`pnpm desktop:dev` 挂仓内 `plugin/<name>`，与 ship 标记无关。
- 已打插件 tag（`dsh-quno-v0.2.1` 等）不受影响；插件 tag 本就不替代桌面 Release。

## 回随包的步骤

1. 三包 manifest 翻回 `ship: true`（yzj 若同轮回随包，需补标并确认首启事务）。
2. catalog 随包清单同步改写 + 新决策 note。
3. 发新桌面 `v*`——独立插件 tag 不交付桌面用户。
