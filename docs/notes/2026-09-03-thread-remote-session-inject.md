# dsh-thread 缺 `remote.session` inject（2026-09-03）

## 现象

`0.3.0-rc.29` / `dsh-thread` 0.2.0-rc.5 浏览器半报 `cannot get property "remote.session" without inject`，loader 行失败，界面起不来。Host sidecar 本身是活的。

## 原因

rc.5 为对齐 harness 0.1.2（删了 `connection.api`）改走 `ctx.remote.session.create/rename`。`ctx.remote.session` 是独立 inject 键，和 `remote` 不是一回事。`inject` 只写了 `remote`，fiber 在 `remote.session` 到位前跑 apply。

同族先例：`docs/notes/2026-08-20-rc45-runtime-resolution-and-plugin-contracts.md`（client 入口缺 inject）。

## 修法

`plugin/dsh-thread/src/client/index.tsx` 的 `inject` 加上 `'remote.session'`。
