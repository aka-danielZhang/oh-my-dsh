# 2026-09-08 — efforts/image-input 客户端写入迁移 typed `remote.settings`

## 症状

用户手动添加 `gpt-6-astra` 后在「设置 → 模型 → 自定义设置」的推理档位编辑器（dsh-model-efforts-editor）里勾选档位点「应用」，弹层报「写入失败：Cannot read proper…」。与模型新旧无关——**任何模型**的写入都同样失败；读路径（弹层打开、路由匹配、勾选回显）全部正常。

## 根因

- 桌面 runtime 自 0.1.2 线起移除了 client 侧 `connection.api` 门面（本仓现基线 `v0.1.2-rc.1+zw.2`，alpha.3 时期即已移除）：`ctx.get('connection')` 仍返回 handle（`isLoopback`/`generation`/`state`/`rpc`/`reconnect`/…），但 **`.api` 不存在了**（实测 runtime 树 `dsh-client-connection/lib/client.js` 的 handle 构造）。
- `dsh-model-efforts-editor@0.1.1` 与 `dsh-model-image-input@0.1.1` 的写入路径都是 `connection.api.settings.mutate(payload)` → `connection.api` 为 `undefined` → 读 `.settings` 抛 `TypeError: Cannot read properties of undefined (reading 'settings')` → 被弹层截断显示为「Cannot read proper…」。RPC 从未发出。
- 读路径没事：`settingsScope` 服务由 `dsh-client-ui-settings` 继续提供，快照/订阅不变。
- 这与 dsh-thread 0.2.0-rc.5/6 踩过并修掉的同一断点（见 AGENTS.md thread 行与 `docs/notes/2026-09-03-thread-remote-session-*.md`）——efforts/image-input 当时漏迁。

## 修法（对齐 thread 的成熟姿势）

两个插件 client 半同改：

1. **调用**：`connection.api.settings.mutate({ns, ops, expectedRevision?})` → typed Remote `ctx.remote.settings.mutate(ns, ops, expectedRevision)`（位置参数；`RemoteResult` 信封 `{ok:true,value}|{ok:false,error:{code,message}}`，失败抛 `code: message`）。类型增强来自 `import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'`。
2. **inject**：`['locale', 'settingsScope', 'connection']` → `['locale', 'settingsScope', 'remote.settings']`。cordis 4 把每个 Remote namespace 挂成独立服务 `remote.<namespace>`（提供方是 `dsh-api-gateway` client 半），点号子路径必须显式声明，否则 apply 抛 `without inject`。
3. **Context 类型**：`ClientContext`（`dsh-client-runtime/client`）随包下线，改 `Context`（`@deepseek-ai/cordis`）。`ctx.settingsScope` 类型改由 `dsh-client-ui-settings/client` 声明。
4. **package.json**（在远端已迁的 0.1.2-rc.1 devDeps 钉法之上）：
   - 版本 0.1.1 → 0.1.2；
   - 移除 `dsh-client-runtime` devDep（npm 上 0.1.1-rc.2 后停发，且其旧 peer 闭包会拖出从未发布的 `dsh-compact` 导致 install 404）；新增 `@deepseek-ai/dsh-api-settings-controller@0.1.2-rc.1`（`./remote` 类型入口）；
   - peerDeps 移除 `dsh-client-runtime`，新增 `dsh-api-gateway >=0.1.2-alpha.3`、`dsh-client-ui-settings/locale/ui-slots >=0.1.0-rc.8`（desktop 壳按 peer 链接 runtime 物理包，floor 必须 ≤ runtime 实际版本）；
   - `dsh.client.inject`（client manifest 的平台模块表）：`["@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings"]`。
   - tsdown `CLIENT_EXTERNALS` 不动：thread（0.1.2 线实证可用）的镜像表仍含 `dsh-client-runtime/client`——loader 的平台模块表仍应答它，只是 npm 包停发；两个插件对它本来就只有 type import，构建前擦除。
5. image-input 的旧契约单测「inject must declare connection」改为断言 `remote.settings`。

## 验证

- 两包 `pnpm install && pnpm run typecheck && pnpm test && pnpm run build` 全绿（typecheck 对 `0.1.2-rc.1` 真实类型闭包通过，`ctx.remote.settings` 类型成立——与 runtime `v0.1.2-rc.1+zw.2` 同线）；
- 产物 `lib/client.js` 调用点确认为 `settingsRemote.mutate(PI_AI_NS, [op], revision)`，无 `connection.api` 残留（仅注释提及）。

## 发货注意

- 修复随 **desktop `v0.3.0-rc.36`** 发货（desktop-owned 清单里的 model-image-input / model-efforts-editor 升到 0.1.2）；已装旧桌面的写入按钮在升级前保持坏。终端改 Profile 会被壳的事务 CAS 判为外来改动，不要手动 `plugin add` 热修已装 Profile。
- `dsh-reasoning-efforts`（host 半补声明）与 `dsh-web-search-toggle`/`dsh-mcp-settings` 不受影响：前者纯 host，后两者 inject `connection` 只消费仍存在的 `state`/`generation`，不碰 `.api`。
- 工作区曾有一份未发布的 thread 0.2.0-rc.7（模型继承）改动，不在本次发布范围，已存档于 `parking/local-work-20260908` 分支。
