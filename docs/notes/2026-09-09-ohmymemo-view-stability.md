# OhMyMemo 视图稳定性：配置更新不再重写未变化的派生视图 + 陈旧目录自动重试

2026-09-09 · dsh-ohmymemo 0.2.2 · 随 Desktop 0.3.0-rc.41 发布

## 事故

记忆设置页连续写入三次配置（19:47:39/41/43 三条 `config-updated` journal）后，点击 `views/user-profile.md` 报内部英文错误 `gateway/internal: memory file index changed; refresh before reading`，须手动点刷新才能打开。记忆数据本身无损。

## 根因（两条叠加）

1. **配置无关的视图重写**：每次 store 订阅事件（含 `config-updated`）都触发 `rebuildViews`，而 `rebuildViews` 无条件 `publishView` 每个视图文件——视图头部的 `generated_at` 取当次时间，即使数据零变化也会改变文件内容 → 文件 hash 变 → `listDisplayFiles` 的目录 `generation`（路径+hash 摘要）变。
2. **前端容错缺口**：页面持有的目录 `generation` 因此过期，`readDisplayFile` 按安全设计拒绝读取（`OHMYMEMO_TREE_STALE`，generation 不一致与文件 hash 变动两处守卫）；`controller.read()` 没有把这个正常并发场景当作可恢复——直接把 Remote 内部错误码原样展示给用户。

## 修复

- **`views.ts`**：落盘前与磁盘内容做「掩去 `generated_at` 行」的等值比对（`/^generated_at: .*$/m`），一致则跳过写——`generated_at`、文件 hash、浏览器目录 generation 全部稳定。真实变化（含 `valid_until` 在新一代时间点过期使条目退出视图）仍在掩码行之外产生差异、照常重写；手编视图永不匹配、照常被覆盖（原语义不变）。返回值语义从「写入的路径」放宽为「确保存在的路径」。
- **`client/controller.ts`**：`read()` 首次失败若为 `OHMYMEMO_TREE_STALE`，自动 `remote.tree()` 重取目录、按新 generation 重试一次，成功后把新目录采纳进 state；二次仍失败或文件真的离开目录才走错误展示。`unwrap` 抛出的 Error 附带 `code` 属性（取自 RemoteResult 错误分支），分支判断不再解析 message。

## 取舍

- 不在 host 侧为「跳过写」记 journal：视图是可重建派生物，落盘差异本就不进审计。
- 重试只做一次：目录持续变动（正在写入记忆）时第二次失败交还给错误提示，避免循环追新。
- generation 守卫本身保留——它是「读到与目录不一致内容」的最后防线，只把恢复路径补上。

## 测试

- `tests/views.test.ts`：无数据变化的二次 rebuild 逐字节不变且保留旧 stamp；数据变化照常重写换新 stamp；valid_until 跨代过期仍触发重写。
- `tests/client-controller.test.ts`：首次 read 陈旧 → 重取目录 → 按新 generation 重试成功、state 采纳新目录；二次仍陈旧 → 错误上报。

## 发布

bridge 0.2.0-rc.13 与本修复同乘 Desktop 0.3.0-rc.41（`v0.3.0-rc.41`）。
