# OpenCode Go 请求头适配方案（x-opencode-session / User-Agent）

2026-09-10 · 调研 + 实施方案 · 状态：待落地

## 1. 背景

OpenCode Go（`https://opencode.ai/zen/go`，$10/月订阅的开放模型网关）对第三方编程 Agent 提出三条客户端要求（[官方文档](https://opencode.ai/docs/go/)）：

1. 发送典型的编程 Agent 流量；
2. 使用自身专属的 user agent 标识（例如 `my-coding-agent/1.0`），而不是通用的 SDK 或 HTTP 库名称；
3. **为每段对话在 `x-opencode-session` 请求头中发送稳定的会话 ID**，以便优化路由和提示词缓存。

官方文档「Known Problematic Clients」一节明确点名 DeepSeek Harness：

> **DeepSeek Harness** — Session information arrives on some model paths, but is missing on others. We recognize its native header; the remaining work is to send it across all adapters. Discussion #5495.

即：OpenCode 已经能识别 harness 发出的会话头，但只有部分模型路径带上了；剩余工作是让**所有**适配路径都发送。

## 2. 现状调研结论（基于 pin 住基线 `v0.1.5-alpha.1+zw.3` 与 pi-ai 0.85.1 源码）

请求链路：`agent-loop` → `dsh-llm` → `dsh-llm-pi-ai`（PiAiAdapter）→ pi-ai `streamSimple` → OpenAI/Anthropic SDK → 线上。

### 2.1 会话 ID 在 harness 内部一直是有的

- `packages/core/agent-loop/src/agent.ts:614`：每次 LLM 调用固定携带 `sessionId: this.session.id`（harness 会话 ID，一段对话一个、稳定）。
- `packages/llm/llm-pi-ai/src/adapter.ts:384`：adapter 把它透传给 pi-ai：`sessionId: String(options.sessionId)`。

### 2.2 但 pi-ai 是否把 sessionId 写成请求头，按 API 路径分裂（这就是 OpenCode 说的"部分路径缺失"）

pi-ai 0.85.1（当前基线已带的版本，且自带 `opencode-go` 目录路由，baseUrl `https://opencode.ai/zen/go[/v1]`）三条 API 路径的行为：

| API 路径 | Go 模型 | 会话头现状 |
|---|---|---|
| `openai-responses` | gpt-5.6-luna、grok-4.6、muse-spark-* | ✅ 目录 compat `sessionAffinityFormat: "openai-nosession"` → 发送 `x-client-request-id: <sessionId>`（`openai-responses.js` createClient） |
| `openai-completions` | deepseek-v4 系、glm-*、kimi-*、longcat、mimo、hy3/hy4、minimax-m2.7 等**大多数 Go 模型** | ❌ `sendSessionAffinityHeaders` 默认 `false`（`openai-completions.js:1309`），什么都不发 |
| `anthropic-messages` | minimax-m3、qwen3.6/3.7/3.8 系 | ❌ `sendSessionAffinityHeaders` 默认 `false`（`anthropic-messages.js:124`），什么都不发 |

harness 侧无法经配置打开这两个开关：`llm-pi-ai/src/config.ts` 的 `compatProfile` schema（254–281 行）**不含** `sendSessionAffinityHeaders` / `sessionAffinityFormat` 字段，写了会被校验拒绝。

OpenCode 已识别的"harness 原生头"即 `x-client-request-id`（responses 路径在发）。文档要求的 `x-opencode-session` 则目前**任何路径都不发**——pi-ai 0.85.1（npm 最新版）全库无此字符串。

### 2.3 User-Agent 现状：实质上已合规

- pi-ai 先放自己的 `User-Agent: pi (<os> ...)`（`pi-user-agent.js`），但 harness attribution 头**最后合并**且由 `attributionHeaders()` 强制为 `user-agent: deepseek-harness/<version> (+https://github.com/deepseek-ai/deepseek-harness)`（`packages/llm/llm/src/attribution.ts`、`adapter.ts:205 requestHeaders()`）。下游 `Headers` 构造大小写不敏感、后写胜，线上值是 harness 的。
- profile 配置里的 `headers`（`config.ts:151`，settings JSON 手写）可以携带任意头，**但 `user-agent` 是保留名，会被过滤**（attribution 必胜，这是上游 2026-06-21「mandatory app attribution」的刻意设计）。
- `deepseek-harness/x.y.z (+url)` 本身就是"具体编程 Agent 的 UA"而非通用 SDK 名，OpenCode 文档能把 DeepSeek Harness 列名出来也证明他们正在按这个 UA 识别。**UA 一项本期可以零改动**；是否换成 oh-my-dsh 品牌是产品决策，见 §4.4。

### 2.4 插件路径的核实结论（2026-09-10 修订：插件可行，社区已有实现）

初版判断「插件做不到」**过于武断，已修正**。核实结果：

- **缝隙存在且可用**：`llm/stream` waterfall（`llm/src/index.ts:72`）的 listener 能读到 `GenerateOptions`（含 provider、sessionId）。虽然 options 被冻结、无 headers 字段，但配合 patch 一次 `globalThis.fetch`（pi-ai 的 OpenAI/Anthropic SDK 默认走全局 fetch）即可完成注入。
- **并发关联的正解是 AsyncLocalStorage**：把下游 async iterable 包一层、每次 `iterator.next()` 在 `als.run(store)` 中执行，SDK 的 fetch 由这些 pull 驱动、天然继承 store——主会话与子 Agent 并发同模型也不串。比「(model, 时序) 查表」的关联设计严格更优。
- **社区现成实现**：npm `dsh-opencode-session@0.1.0`（2026-09-08 发布，纯 ESM 零依赖，216 行）正是该架构，默认复用 DSH 会话 id、仅作用于 `opencode`/`opencode-go` 路由，卸载即还原 fetch。**评审结论：可作为过渡方案，用户自行 `dsh plugin --profile web add dsh-opencode-session` 安装；不进桌面随包清单（第三方 host 代码的供应链边界）。**
- 采纳前需在我们基线上验证两点：① ALS 上下文经「waterfall → adapter 生成器 → pi-ai → SDK promise 链 → undici」全链传播（作者声称在 0.1.2-rc.1 实测通过，我们 pin 的是 0.1.5-alpha.1+zw.3）；② 其 `ctx.on('llm/stream', …, { prepend: true })` 未加 `global: true`（harness 自身 invariant listener 用 `{ global: true, prepend: true }`），非 global listener 能否看到 llm 服务 fiber 上的 waterfall 取决于 cordis 事件拓扑，需实测。
- 仍留下的结构性脆点（fork 方案不受其影响）：依赖 pi-ai/SDK 永远走全局 fetch（上游改注入即静默失效）；fetch patch 的还原以「当前值仍是自己」为条件，多插件叠 patch 时卸载顺序敏感。
- **重要佐证**：官方 `dsh-llm-deepseek` 适配器本就把 sessionId 映射为传输层头（`llm-deepseek/src/adapter.ts:546` 发 `x-deepseek-harness-session-id`）——OpenCode 文档所说「识别其原生头」即指它。「adapter 将 sessionId 映射为 provider 头」在代码库内有先例，本方案的 fork patch 是同款行为的补全，不是新发明。

### 2.5 其它已排除的路径

- **纯配置写死 `x-opencode-session`**（profile `headers`）：只能全路由一个静态值，所有对话共享一个"会话"，违背 per-conversation 语义，且对提示词缓存路由无意义。只能算敷衍合规，不推荐。
- **本地代理/插件改包**：请求到达 adapter 之前没有任何会话标识可辨（completions/anthropic 路径连 pi-ai 的亲和头都不发），代理无法推导会话 ID；只能改 UA。引入长期维护的 MITM 组件，不推荐。
- **等 pi-ai 上游**：pi-ai 没有 `x-opencode-session` 概念，0.85.1 已是最新；且其 compat 开关在 harness schema 不暴露。不可控，不作为主路径（可作为长期上游贡献另行提 PR）。

## 3. 目标

1. 所有指向 `opencode.ai` 路由的 LLM 请求（三条 API 路径全覆盖），携带 `x-opencode-session: <harness 会话 ID>`；同一会话多轮一致，不同会话不同；子 Agent 会话用各自会话 ID（语义正确）。
2. 同时保留/补发 OpenCode 已识别的 `x-client-request-id`（防御性，避免他们识别规则变动）。
3. 非 opencode 路由（DeepSeek 官方、zai 等）**不得**带上这些头（会话 ID 不外泄给无关第三方）。
4. UA 维持 harness attribution（默认合规）；品牌覆写作为可选项评估。
5. 无会话 ID 的调用方（若有轻量路径不传 sessionId）保持现状不注入，不报错。

## 4. 方案

> 过渡选项（非本方案交付物）：社区插件 `dsh-opencode-session`（见 §2.4）今天即可自装解 400；fork 补丁上线后退役之。本方案仍为主路径：确定性注入、无全局 fetch 补丁、可上游化。

### 4.1 主方案（推荐）：fork 改 `dsh-llm-pi-ai`，新增路由级配置 `sessionAffinityHeaders`

配置驱动、通用（任何需要会话亲和头的网关都能用）、无第三方硬编码进适配器。

**配置形态**（settings `llm-pi-ai` section）：

```jsonc
{
  "providers": {
    "opencode-go": {
      "apiKeyEnv": "OPENCODE_API_KEY",
      "sessionAffinityHeaders": ["x-opencode-session", "x-client-request-id"]
    }
  }
}
```

**语义**：该路由每次请求时，若 `GenerateOptions.sessionId` 存在，把列表中每个头名写为 `String(sessionId)`；不存在则不写。注入点在 adapter（`streamWithSnapshot` 组 `headers` 处），对三条 API 路径统一生效——pi-ai 三个 createClient 都把 harness 传的 `optionsHeaders` 最后合并。

### 4.2 变更清单（fork 仓 `deepseek-harness`，包 `packages/llm/llm-pi-ai`）

1. **`src/config.ts`**
   - `PiAiProviderProfile` 增字段：`sessionAffinityHeaders?: string[]`，JSDoc 写明「值为每次请求的会话 ID；仅写已显式声明的头名；保留名（user-agent）拒绝」。
   - zod profile schema 增：`sessionAffinityHeaders: z.array(z.string())`（可选，缺省 undefined）。
   - 校验：复用/扩展 `assertValidHeaders`——数组每项必须是合法 Fetch 头名（`new Headers([[name, 'x']])`），且**拒绝 attribution 保留名**（当前即 `user-agent`；实现上直接复用 `attributionHeaders()` 的键集判定，避免名词漂移）。
   - `resolveProfiles` 透传并不可变拷贝（`headers` 同款写法：`...rest.sessionAffinityHeaders === undefined ? {} : { sessionAffinityHeaders: [...rest.sessionAffinityHeaders] }`；注意 `rest` 展开已带上字段，这里只是防御别名）。
2. **`src/adapter.ts`**
   - 新增内部函数（或扩展 `requestHeaders` 签名）：
     ```ts
     function requestHeaders(
       headers: Readonly<Record<string, string>> | undefined,
       sessionAffinityHeaders: readonly string[] | undefined,
       sessionId: string | undefined,
     ): Record<string, string> {
       return {
         ...filteredProfileHeaders,          // 现状：滤保留名
         ...attributionHeaders(),            // 现状：attribution 必胜
         ...sessionId === undefined          // 新增：会话亲和头最后写
           ? {}
           : Object.fromEntries((sessionAffinityHeaders ?? []).map(name => [name, sessionId])),
       }
     }
     ```
   - `streamWithSnapshot` 调用点（现 388 行）改为传入 `profile.sessionAffinityHeaders` 与 `options.sessionId === undefined ? undefined : String(options.sessionId)`。
   - 头名保持配置原样（HTTP 头名大小写不敏感；harness 惯例用小写，文档示例用小写）。
3. **`src/discovery.ts`**：不改。discovery 是路由级配置时动作、无会话上下文；UA attribution 已有。
4. **测试**（包内既有 node:test 体系）：
   - schema：接受合法数组；拒绝非法头名；拒绝 `user-agent`（大小写混合也拒）。
   - adapter：构造带 `sessionAffinityHeaders` 的 profile，mock pi-ai 出口（包内已有同类测试基建，照抄现有 header 断言用例），断言三条路径的 `options.headers` 均含两个头且值=会话 ID；`sessionId` 缺省时不含；未配置字段的路由不含。
   - 回归：attribution `user-agent` 仍必胜 profile headers。
5. **README/包内文档**：补字段说明与 opencode-go 配置示例。

### 4.3 发布与落地面（跨仓，严格按既有纪律）

1. **fork 仓**：上述改动进 `master`（基于当前 pin 的 `v0.1.5-alpha.1+zw.3` 后继），`llm-pi-ai` 首次进入 fork 修改面。
   - `node scripts/publish-fork.mjs --list` 确认发布集含 `dsh-llm-pi-ai`；
   - 打 fork tag `v0.1.5-alpha.1+zw.4`（或当时基线对应的下一个 zw.N），走 `npm-release.yml` 发布 `@crazx/dsh-llm-pi-ai`；
   - peer 纪律由发布脚本保证（peer 保留 `@deepseek-ai/*` 原名 + semver；`@earendil-works/pi-ai` 是普通外部依赖，无别名问题）。
2. **oh-my-dsh 仓**：
   - `runtime/revision.json` 钉新 fork tag/sha；
   - `scripts/prepare-runtime.mjs` 的 `FORK_MODIFIED` 名单加 `dsh-llm-pi-ai`（与 FORK.md「改动面即发布面」同源检查）；
   - 相关 devDeps 以 npm alias 指 `@crazx/dsh-llm-pi-ai`（按「npm 依赖纪律」一节既有做法）；
   - 重备 runtime（`prepare-runtime.mjs`），确认组装树里 adapter 产物含新逻辑。
3. **用户配置**：settings `llm-pi-ai.providers["opencode-go"]` 增 `sessionAffinityHeaders`（见 §4.1 示例）。手写路由（baseURL 自指 opencode 兼容网关的）同理可配。
4. **桌面发版**：runtime 基线变化 → 按 release-runbook 发桌面版（这属于壳/runtime 变更，必须 bump 仓根版本并推 `v*` tag）。
5. **上游回馈（可选但建议）**：把该能力给 deepseek-harness 上游提 PR/Discussion，回应 opencode Discussion #5495；社区已有同方向 PR（profile 加 `sessionHeader` 字段、注入 `GenerateOptions.sessionId`，测试已全绿但未合并）——上游化时字段命名向官方收敛，配置迁移成本由我们承担。上游若采纳，fork 日后可退场。

### 4.4 User-Agent 决策点（需你拍板）

- **U0（推荐，零改动）**：维持 `deepseek-harness/<ver> (+url)`。已是具体 Agent 标识、非通用 SDK 名，OpenCode 文档按此识别本客户端。
- **U1**：fork 放开保留名过滤，允许 profile `headers["user-agent"]` 逐路由覆写。与上游「mandatory app attribution」设计正面冲突，fork 偏差变大，且让部署侧能静默抹掉归因——不建议。
- **U2**：attribution 支持部署前缀（`oh-my-dsh/<ver> deepseek-harness/<ver> (+url)`，RFC 9110 多 product token 合法）。要改 `dsh-llm` 的 APP_IDENTITY 消费面，影响所有提供商路由，单独立项评估，不混入本期。

### 4.5 可选增强（本期不做，记录备查）

- 对目录自带路由 `opencode-go` 在 adapter/catalog 层**默认启用** `x-opencode-session`（用户零配置）。代价：第三方约定渗进通用适配器，且默认行为变化需要更显眼的契约说明。若后续桌面用户普遍接入 Go 再评估。
- 推动 pi-ai 上游为 opencode-go 路由原生支持 `x-opencode-session`（类似其 `sendSessionAffinityHeaders` 机制）。

## 5. 验收项

1. **单测全绿**：§4.2-4 所列新增用例 + 包内既有测试不回归。
2. **本地抓包实证**：把 `opencode-go` 路由 `baseURL` 指到本地 echo server（如 `node -e` 起一个回显请求头的 HTTP 服务），跑一条会话消息：
   - 三条 API 路径（completions / responses / anthropic-messages 各挑一个模型）请求头均含 `x-opencode-session` 与 `x-client-request-id`，值 = 当前 harness 会话 ID；
   - 同一会话第二轮请求头值一致；新建会话值不同；
   - 请求头不含重复的 `User-Agent` 歧义（大小写两个键只生效一个，值为 harness attribution）。
3. **真实端点冒烟**：配置真实 `OPENCODE_API_KEY`，对 `glm-5.3-flash`（completions）与 `minimax-m3`（anthropic）各发一条短消息，HTTP 200 正常出流。
4. **隔离性**：DeepSeek 官方路由发一条消息，抓包确认无 `x-opencode-session`/`x-client-request-id`。
5. **设置 UI 往返**：在「设置→模型」里编辑该路由的其它字段保存后，`sessionAffinityHeaders`/`headers` 不丢失（schema 已声明，理论上往返保留，实测确认一次）。
6. **桌面矩阵**：新 runtime + 旧插件、旧 runtime + 新配置（字段缺省=不注入，静默无害）两向验证；packaged smoke 过。
7. **文档同步**：fork FORK.md 修改面说明、本仓 AGENTS.md 相关行、用户侧配置片段（README 或 notes 内示例）。

## 6. 风险与备注

- **会话 ID 语义**：值为 harness 会话 ID（随机 ULID 类标识，无用户敏感语义）；仅发往显式配置该字段的路由。fork 派生会话（fork/thread 承接）是新会话 ID，符合「每段对话」语义。
- **压缩/标题生成等辅助调用**：走同一 agent-loop 的带同会话 ID；不走 agent-loop 的轻量调用若无 sessionId 则按目标 5 不注入，可接受。
- **OpenCode 识别规则漂移**：同时发 `x-opencode-session`（文档要求）与 `x-client-request-id`（其现行识别）即为双保险；两者皆纯增量头，不影响网关正常处理。
- **基线漂移**：本文调研基于 zw.3 pin 与 fork checkout（当时已合 0.1.5-rc.1）。落地时若基线已推进，`adapter.ts`/`config.ts` 行号以当时源码为准，契约不变。
