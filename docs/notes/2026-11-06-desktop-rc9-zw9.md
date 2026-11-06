# 2026-11-06 Desktop 0.4.0-rc.9 仅升级 runtime 至 zw.9

## 范围

Desktop `0.4.0-rc.9` 只更新 Harness fork runtime 与必要的组装清单，不交付 Quno 或任何 Quno Sense，不改变随包插件集合和版本。

- runtime：`v0.2.1-rc.2+zw.9`，SHA `2453734d4d2bccb52f1bc01813dc82cca566d59b`。
- `dsh-client-ui-slots` 加入 FORK_MODIFIED：槽声明的额外注册选项随条目 options 透传。
- zw.9 同时带入 zw.8 的贡献式会话可见性过滤，以及面板行对一类 Conversation 的归属推导。
- 原工作区存在未提交的 Quno 重构；发布在独立 worktree 从 `origin/main` 进行，不携带这些改动。

## 验证

- `pnpm desktop:typecheck`、`pnpm desktop:test`（148 项）及发布/roster 脚本测试（15 项）通过。
- `pnpm desktop:prepare` 完成：16 个既有随包插件检查与构建通过，Quno/Quno Sense 不在清单。
- Harness `zw.9` 全量构建 9 个门禁通过；`pnpm desktop:smoke` 完成 dump-config、安装事务、幂等重启与两轮 preset 挂载，结果为 `ok (16 shipped plugins against v0.2.1-rc.2+zw.9)`。
