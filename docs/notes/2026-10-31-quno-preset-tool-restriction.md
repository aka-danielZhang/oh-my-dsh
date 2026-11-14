# 2026-10-31 Quno 主对话工具限制：allow-list 事故与 deny 定稿

## 症状

Quno 主对话（`quno` preset）最新一轮里，模型按要求尝试委派，`quno_task`、`quno_attention` 连续返回 `UNKNOWN_TOOL`；请求头（seq 495）只剩 `memory_forget / memory_remember / memory_update`，全部 `quno_*` 工具消失。更早一轮则是主对话持有 `quno_task` 却直接执行了 61 次 `bash`。

## 根因（机制与当初判断的出入）

`plugin/dsh-quno/src/preset.ts` 里为「主对话只路由」加的过滤是：

```ts
const available = ctx.tools.schemas().map(schema => schema.name).filter(tool => allowed.has(tool))
ctx.tools.restrict({ allow: available })
```

当初判断是「restrict 引用了 scope-local 名字 → 校验抛错 → preset 装配失败回滚」。实际机制不同：

- cordis 的 service accessor 是 traceable shadow，`ctx.tools.schemas()` 的 `scope` 参数为 undefined → **返回全局视图**。allow 名单 ∩ 可见工具后只剩 `memory_*` 这类**全局**工具，`restrict` 校验（只认全局可限制名）通过，**没有抛错，也没有回滚**。
- preset row 的 restriction 落在 **preset generation scope 层**。对加入该 preset 的 agent 而言，generation 层注册的 `quno_*`、`ask_user_question`、`present`、`schedule_*` 都属于「继承面」，必须通过 `layers.every(layer => layer.admits(name))`——allow-list 只放行 `memory_*`，于是本 preset 自己的工具被从所有加入 agent 的模型视图里整体过滤。`UNKNOWN_TOOL` 与「请求头只剩 memory_*」由此而来。
- 早期 61 次 `bash` 则是宿主 dsh-base 行全局注册的执行工具（`tool-bash`、`tool-fs` 等）直接漏进主对话——这正是当初想挡的东西，但 allow-list 挡的方式错了。

教训：**静态单测（`applyQunoPreset` 直接打在 agent ctx 上）复现不了这条链**——agent ctx 上 row 工具是「自有层」，不受 admits 过滤，allow-list 恰好只挡继承的全局 `bash`，测试全绿。

## 定稿方案（`plugin/dsh-quno/src/preset.ts`）

1. **删除 allow-list restrict**，永不恢复。正确性由 `tools.guard` 保证：非 `MAIN_ROUTING_TOOLS` 的调用一律返回「Quno 主对话只负责委派，不能自行调用 X；请改用 quno_task」；`thread_handoff` 保留专属退役文案 guard（先注册，文案优先命中）。
2. **隐藏与正确性分离**：新增 `HIDE_GLOBAL_TOOLS`（bash/pwsh、tool-fs 系列、glob/grep、job_*、skill、subagent 系列、todo_write、web_search/web_fetch、goal、workflow/ralph、thread_handoff），**逐名独立** `restrict({ deny: [name] })`，名字在本组合不是全局工具时 catch 跳过；`tools/change` 监听重试迟到注册。动态 MCP 名单不可穷尽，由 guard 兜底。**绝不把 `quno_*` 或任何 preset 层工具名传给 restrict。**
3. **装配健康检查**：per-request 的 `systemPrompt.tools` provider 按 `context.scope` 用 `ctx.tools.schemas(scope)` 校验五个必需工具；缺失时 `logger.error`（不抛错，抛错会打断每个回合且用户无从得知原因）。scope 不做 mount 时静态检查——`scopeOf` 直接读 setup ctx 在 dev/test 双拷贝下不可靠（见下）。
4. **回归测试走真实组合拓扑**：`tests/preset-composition.test.ts` 用 `createScope` + `bindScopeParent`（`AgentPresetRegistry.activate/join` 的同款原语）把真实 preset row 挂进 generation scope，agent 经 assembly 钩子 join，断言：五个 `quno_*` + sibling row 工具 + 全局 `memory_*` 对模型可见、全局 `bash` 被隐藏、可见但非路由的动态工具被 guard 拒绝且不执行、`quno_task` start/status/result 全链路真实走通。该测试在旧代码下失败（工具全被过滤），在新代码下通过。

## 附带发现：dev/test 环境的 dsh-scope 双拷贝

本仓插件包的 devDeps 被 `runtime/build` 符号链接接管，而 `@deepseek-ai/dsh-agent-loop-testkit` 依赖链解析到 registry store 的另一份 `dsh-scope@0.2.1-rc.2`。`kScope` 是 `Symbol("dsh.scope")`（非 `Symbol.for`），两份实例的 scope tag 互不可见：插件代码若直接 `import { scopeOf } from '@deepseek-ai/dsh-scope'`，在测试/`link:source` 环境永远读不到 runtime 写的 tag。因此：

- `src/` **不直接 import `dsh-scope`**（本次已回退该 import）；需要 scope 语义时优先走服务 API（如 `systemPrompt.tools` provider 的 `context.scope`）。
- 测试确需 scope 原语时，从被测 runtime 的解析链取：`createRequire(createRequire(resolve('dsh-agent-loop-testkit')).resolve('dsh-tools')).resolve('dsh-scope')`（注意 testkit 对 dsh-scope 是 peer，直接从 testkit resolve 会回落到插件自己的拷贝）。`tests/preset-composition.test.ts` 顶部有现成写法。

## 验收

- `pnpm run typecheck` + 全量 143 测试通过（含新增拓扑回归）。
- 重建后重启 Desktop：sidecar 正常启动（`dsh web: http://127.0.0.1:49531/`），无 preset/broken 告警；`lib/preset.js` 含新逻辑、不含 allow-list。
- 实机最终验收（用户在原主对话继续使用）：请求头重新出现全部 `quno_*`；一个执行型请求只产生一次 `quno_task` 并立即应答「已交后台」；子任务真实创建、完成后回流，`status/result` 可读。
