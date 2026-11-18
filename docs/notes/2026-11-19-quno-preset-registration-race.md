# 2026-11-19 Quno 预设注册竞态：`Unknown agent preset: quno`

> 状态：**已修复（本 PR）**。关联：[Quno 开发说明](../quno-bot-design.md)（preset-owned 落点，§1 落点与 §15/§18 的实现记录）。本文记录现象、根因、修复与残留风险。

## 现象

打开 Quno 主会话报 `Unknown agent preset: quno`，外层被包装成 `gateway/internal`。会话文件本身完好，`agentPreset: "quno"` 仍在。**重启 Desktop 后依旧复现**（07:51 重启仍然命中），并非偶发一次。

## 根因

两处独立缺陷叠加，任意一处都让预设在整个进程生命周期内不存在：

1. **依赖没声明**：`dsh-quno` 的 `inject` 只列了 `agents/sessions/tools/systemPrompt/sessionPersistence/sessionQuery/jobs/timer`，没有 `agentPresets`。而 loader 建 entry 走 `Promise.all`（`cordis-plugin-loader` 的 `EntryGroup.update`），**没有顺序保证**；`agent-preset-registry` 又是在 profile patch 层追加的条目。于是 `apply` 可能在注册表就绪前执行，`ctx.get('agentPresets')` 拿到 `undefined`。
2. **失败只降级**：`service.ts` 的 `start()` 里 `registerQunoPresets` 抛错只 `warn` 后继续 `start()`，并把 `started` 提前置真；没有任何重试或后补路径。日志里同一进程随后仍打 `dsh-quno: started`，看起来「起来了」，实际预设从来没有声明过。

重启不是修复：竞态每次启动独立掷骰（历史 33 次启动 1 次命中，随后连续两次命中），恢复与否取决于调度顺序。

## 修复

| 位置 | 改动 |
|---|---|
| `src/index.ts` | `inject` 增加 `agentPresets`（硬依赖）。fiber 会在注册表挂载前保持 pending，注册不再与 loader 并发时序挂钩。 |
| `src/service.ts` `start()` | 预设注册提到 `store.open()` **之前**：锁冲突等 store 故障不再连带丢掉预设；注册失败改为 `throw`（阻断启动），不再带病继续。 |
| `src/service.ts` `start()` | `started` 改为全部成功后才置真；失败启动不再被静默闩死。 |
| `tests/preset-registration.test.ts` | 回归断言 `inject` 必须含 `agentPresets`。 |

## 验证

- `pnpm run typecheck`、`pnpm test`（239 例）、`pnpm run build` 全绿。
- 产物导出核对：`lib/index.js` 的 `inject` 含 `agentPresets`。

## 残留风险

- **同机多实例**：`~/.dsh/quno/quno.lock` 用 pid + 心跳（`LOCK_STALE_MS` 10 分钟）判活。另开一个 Desktop 实例会在 `store.open()` 抛 `another Quno Host (pid …) owns …`，第二个实例整体起不来。这是设计上的单写者保护，不是本竞态；处理方式是保证同一时刻只有一个 Desktop 实例，而非重试。壳层是否要加单实例锁另议。
- 链式故障表现曾与预设缺失完全一致（都只剩 `Unknown agent preset`），修复后锁冲突的报错本身即区分依据。
