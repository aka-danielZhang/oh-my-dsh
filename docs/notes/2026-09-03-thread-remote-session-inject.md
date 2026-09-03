# 2026-09-03 Thread client inject 漏声明 `remote.session`，apply 即抛 "without inject"

## 症状

0.3.0-rc.29（随包 dsh-thread 0.2.0-rc.5）启动即弹「Failed to load plugins / dsh-thread：
failed to apply loader entry a9b2bbb6 (dsh-thread): cannot get property "remote.session"
without inject」，Thread 面板/工具/设置行全部未挂载。

## 根因

rc.5 把创建/改名改走 typed Remote `ctx.remote.session.create/rename`
（见 `2026-09-03-thread-remote-session-create.md`），但 client 入口的
`export const inject` 只声明了 `'remote'`，没有声明 `'remote.session'` 子路径。

cordis 4 的 service 解析机制（读自 vendor/cordis `reflect.ts` 与 npm cordis
4.0.1，两边一致）：

1. 每个 Remote namespace 由 gateway 挂成**独立的 cordis service**，服务名是点号整键
   `remote.<namespace>`（`remoteServiceKey()`），不是 `remote` 服务实例上的普通属性。
2. `ctx.remote` 返回的 service 实例带 `{ associate: 'remote' }` tracker 的 traceable
   代理；访问 `.session` 时代理查 `ctx.reflect.props['remote.session']` 命中，把读取
   转发回 `ctx['remote.session']` 严格 get。
3. 严格 get 沿**调用方 fiber 的 parent 链**找 `fiber.store[prop]`。而 fiber 的 store
   只在 `notify()` 里对 `name in fiber.inject` 的 fiber 做 `_checkImpl` 回填——没在
   inject 里声明过的服务，任何祖先 fiber 的 store 里都不会有。
4. 走到根 fiber 仍无 impl → 抛 `cannot get property "remote.session" without inject`。

对照 runtime 0.1.2-alpha.3 实测：session-controller 自身声明
`inject = ["typert","remote","remote.commands","remote.session","remote.subagents"]`；
`ui-plan`（`remote.commands`）、`ui-goal`（`remote.goals`）、`ui-message-feedback`
（`remote.messageFeedback`）等 stock 消费者全是同一姿势。dsh-thread 是唯一漏声明的。

`ctx.get('remote.thread')` / `ctx.get('sessions')` 不受影响：`ctx.get()` 走 reflect
全局 store 的非严格读取，不经 fiber 链回溯，这也是 apply 里对 thread 命名空间用
`ctx.get` 做存在性探测能成立的原因。

**为什么 typecheck/测试都没拦住**：`Context['remote']` 的 TS 类型把 `session` 声明为
namespace 属性，类型层面 `ctx.remote.session` 完全合法；单测全是纯函数，不进 cordis
loader。这是纯运行时契约，只有真实 client loader 能暴露。

## 修法

client 入口 inject 补上点号子路径（stock 同款）：

```ts
export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.session', 'settingsScope']
```

副作用是良性的：声明后 cordis 会在 `remote.session` 就绪前把 entry fiber 停在
INACTIVE，namespace 由 api-remotes client 组装 `$mount`（实测 0.1.2 runtime 的
`dsh-api-remotes/lib/client.js` 挂 15 个 namespace，`session` 含 16 个描述符），
loader 的依赖停等是既有机制，无死等风险。

## 验证

- `tsc --noEmit`、`node --test`（35/35）、`tsdown` 全绿。
- 打包 runtime（`~/.dsh-desktop/runtime/613fd43f…`，0.1.2-alpha.3+zw.2）+ scratch
  home 冒烟：`plugin add` 修复后副本 → `dsh web` 启动 → 启动模块表含
  `dsh-thread/client.js`，实际下发的 bundle inject 数组带 `"remote.session"`。
- 已装机副本 `~/.dsh-desktop/plugins/dsh-thread/lib/client.js` 同步替换为修复产物
  （旧副本与本仓 rc.5 树逐字节一致、仅 client.js/map 不同，替换即精确修复）。

## 遗留

- 桌面 0.3.0-rc.29 安装包内 `src/resources/thread.tar.gz` 仍是坏副本；壳的解压以
  tarball sha256 `.ok` 寻址，已装机用户不会被重新解压覆盖，但**新装机/换机**装到
  rc.29 仍会复现。随下一个桌面 Release（带 rc.6 的 tarball）自然修复。
