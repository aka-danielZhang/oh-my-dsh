# DSH Provider Balance

在 DeepSeek Harness（DSH）Web 界面中显示模型供应商的剩余配额，两个入口：

- **输入框旁的胶囊**：紧挨上下文用量圈圈，跟随当前会话选中的模型 —— 切到哪家供应商就显示哪家的余量（余额型显示金额，窗口型固定显示 5 小时剩余百分比）；无适配器的供应商不显示。点开看周/月/工具明细。
- **模型设置页的行内徽标**：设置 → 模型 里每个已配置供应商的行上（名称与「编辑」按钮之间）一颗紧凑胶囊，点击向下展开详情面板；无适配器的供应商不渲染，卸载本插件后行恢复原样。**纯插件 DOM 注入实现，宿主零改动**：MutationObserver 监听页面，在每行「编辑」按钮所属操作区前插入一个外源容器，把 `ProviderBalanceRowBadge` 组件经独立 `react-dom/client` root 挂载进去——供应商路由 id 从编辑按钮的无障碍名（`编辑 {displayName} ({provider})`）解析，宿主 React 树不被触碰，上游原版 harness 即可运行。误判防护：解析不出的行不注入；注入了但无适配器的供应商徽标渲染为空，视觉零影响。

已接入六家供应商 + 一类自动判别网关：

- **zai-coding-cn**（智谱 GLM Coding 套餐，国内 `open.bigmodel.cn`，兼容国际 `api.z.ai`）
- **kimi-coding**（Kimi Code / 月之暗面 Coding 套餐，`api.kimi.com`，API Key 形态 `sk-kimi-xxx`）
- **opencode-go**（OpenCode Go 订阅，`opencode.ai/zen/go`，API Key 形态 `sk-opencode-...`）
- **deepseek-official**（DeepSeek 官方按量付费，`api.deepseek.com`，预付余额型）
- **moonshot-platform**（Moonshot 开放平台按量付费，`api.moonshot.cn`，预付余额型）
- **xai**（xAI Management API，`management-api.x.ai`，预付额度型）
- **Sub2API 系网关**（自动判别：路由 baseURL + 该路由 apiKeyEnv 探测 `/v1/usage`）

**胶囊跟随当前会话选中的模型**：切到哪家供应商就显示哪家的余量（余额型显示金额，窗口型显示百分比）；无适配器的供应商不显示。

## 官方接口结论（zai / GLM Coding Plan）

智谱没有在公开 API 文档里写这两个端点，但它们就是官方订阅管理页在用的接口，社区
（[OpenTokenUsage](https://github.com/PowerUserZ/OpenTokenUsage/blob/main/docs/providers/zai.md)、
[CodexBar](https://github.com/steipete/CodexBar/blob/main/docs/zai.md)、
[glm-quota-line](https://www.npmjs.com/package/glm-quota-line)）均采用，且实测可用（2026-08 验证）：

| 端点 | 作用 |
|---|---|
| `GET {base}/api/monitor/usage/quota/limit` | 三种窗口的用量百分比与重置时间 |
| `GET {base}/api/biz/subscription/list` | 套餐名（如 "GLM Coding Max"）、续费日期 |

- `base`：国内 `https://open.bigmodel.cn`（`bigmodel.cn` 裸域同样响应）；国际 `https://api.z.ai`。
- 鉴权：`Authorization: Bearer <API Key>`（裸 key 也可）；key 即调用 `/api/paas/v4` 用的同一把。
- 响应 `data.limits[]`：
  - `type: "TOKENS_LIMIT", unit: 3, number: 5` → **5 小时窗口**，`percentage` 为已用百分比，`nextResetTime` 为 epoch 毫秒；
  - `type: "TOKENS_LIMIT", unit: 6, number: 1` → **周窗口**（同上字段）；
  - `type: "TIME_LIMIT"` → **工具/网页搜索月额度**（`usage` 总量、`currentValue` 已用、`remaining` 剩余、`usageDetails[]` 按 search-prime/web-reader/zread 细分）。
- `data.level` 为套餐档位（lite/pro/max）。

> 注意：`TOKENS_LIMIT` 只给百分比，不给 token 绝对值；`TIME_LIMIT` 给绝对次数。

## 官方接口结论（Kimi Code / api.kimi.com）

同样是官方控制台在用、未公开文档化的接口（社区参考：[OpenTokenUsage kimi.md](https://github.com/PowerUserZ/OpenTokenUsage/blob/main/docs/providers/kimi.md)、
[kimi-code-usage](https://github.com/Golden0Voyager/kimi-code-usage)；2026-08 实测可用）：

| 端点 | 作用 |
|---|---|
| `GET https://api.kimi.com/coding/v1/usages` | 周额度 + 5 小时窗口额度 + 套餐档位 |

- 鉴权：`Authorization: Bearer <API Key>`；key 是 **Kimi Code 控制台**（非 platform.kimi.com 开放平台）创建的 `sk-kimi-xxx`，两种 key 不互通。
- 响应结构（配额值为字符串数字）：
  - `usage` = **周窗口**（`limit`/`remaining` 配额点数 + `resetTime` ISO 时间）；
  - `limits[]` 中 `window.duration=300, timeUnit=TIME_UNIT_MINUTE` 的一项 = **5 小时窗口**；
  - `user.membership.level` = 档位（`LEVEL_BASIC`/`LEVEL_INTERMEDIATE`/`LEVEL_ADVANCED`，映射 basic/pro/max）；
  - `parallel.limit` = 并发上限。
- 注意：Kimi 给的是**配额点数**（quota points），不是 token 数也不是百分比；插件换算成剩余百分比展示。
- ⚠️ 窗口**耗尽时 `remaining` 字段被整体省略**（2026-08-19 实测：5h 窗口 100/100 时 detail 只剩 `limit`/`used`/`resetTime`）：适配器此时用 `limit - used` 反推剩余；`used`/`remaining` 皆缺的窗口按不可读丢弃——绝不能把缺失当满额（0.4.2 之前的 NaN→limit 回退曾把耗尽的 5h 窗口显示成剩余 100%）。
- key 引用环境变量 `KIMI_CODING_API_KEY`。

## 官方接口结论（OpenCode Go / opencode.ai）

OpenCode Go 订阅（$10/月）有官方但未写入公开文档的用量接口（社区参考：[cc-switch #6433](https://github.com/farion1231/cc-switch/issues/6433)、[dsh-opencode-go-usage](https://github.com/xiaoqi20/dsh-opencode-go-usage)）：

| 端点 | 作用 |
|---|---|
| `GET https://opencode.ai/zen/go/v1/usage` | 5h 滚动 / 周 / 月三窗口用量 |

- 鉴权：`Authorization: Bearer <API Key>`；key 是 OpenCode Go 的 Anthropic 兼容 key（`sk-opencode-...`），env 名 `OPENCODE_GO_API_KEY`。
- 实现注意：host 插件会把 `quotaBase` 裁成 origin，故适配器 base 只能是 `https://opencode.ai`，路径必须带 `/zen/go/v1/usage`（0.4.2 曾把 `/zen/go` 放在 base 上，裁切后打到 `/v1/usage` → 404）。
- 响应 `usage.{rolling, weekly, monthly}`，每项 `{status, percent, resetsAt}` —— `percent` 为**已用**百分比（0-100），`resetsAt` 为 ISO 时间；`status != "ok"` 时面板行尾提示。
- 与 GLM/Kimi 不同：只有百分比，无任何绝对计数；**有月窗口**（紫色进度条）。
- chat 路由：多数模型走 OpenAI 兼容协议，`baseURL: https://opencode.ai/zen/go/v1`（GLM/Kimi/DeepSeek/MiMo 系），部分走 `/v1/responses`（grok、gpt）或 `/v1/messages`（MiniMax/Qwen 系）。

## 官方接口结论（DeepSeek / api.deepseek.com）

唯一一家**正式写进公开文档**的（[查询余额](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)）：

| 端点 | 作用 |
|---|---|
| `GET https://api.deepseek.com/user/balance` | 预付余额（CNY/USD，赠金/充值拆分） |

- 鉴权：`Authorization: Bearer <API Key>`，env 名 `DEEPSEEK_API_KEY`；DSH 自带 `deepseek-official` 路由（llm-deepseek 包）用同一把 key。
- 响应：`is_available`（余额是否可调用）+ `balance_infos[]`（`currency`/`total_balance`/`granted_balance`/`topped_up_balance`，字符串金额）。
- **余额型而非窗口型**：没有 5h/周重置，胶囊直接显示金额（如 `¥4.93`），面板余额行展示总额与赠金/充值拆分。
- 计费规则不进面板（会随官方调价过期），以[价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)为准。

## 官方接口结论（Moonshot 开放平台 / api.moonshot.cn）

| 端点 | 作用 |
|---|---|
| `GET https://api.moonshot.cn/v1/users/me/balance` | 预付余额（赠金/充值拆分，CNY） |

- 鉴权：`Authorization: Bearer <开放平台 API Key>`（`sk-...`，platform.moonshot.cn 申请），env 名 `MOONSHOT_API_KEY`。
- ⚠️ 与 Kimi Code 订阅是**两个产品、两把 key**：`sk-kimi-...`（api.kimi.com）在 moonshot.cn 无效（实测 `Invalid Authentication`）。
- 响应：`{code:0, data:{available_balance, granted_balance, topped_up_balance, currency}}` —— 与 DeepSeek 同构。
- 属文档化接口（Moonshot 平台 API 文档"查询余额"）；响应形状按文档实现。

## 官方接口结论（xAI / management-api.x.ai）

| 端点 | 作用 |
|---|---|
| `GET https://management-api.x.ai/v1/billing/teams/{team_id}/postpaid/invoice/preview` | 预付额度 + 本周期已用（USD 分） |

- ⚠️ 需要 **Management Key**（console.x.ai → Settings → Management Keys，需 Management Keys Read 权限）——与推理用的 `xai-...` key **不是同一把**；env 名 `XAI_MANAGEMENT_KEY`。
- team_id：默认团队用 `"default"`（控制台 URL 即 `/team/default/`）；非默认团队设 `XAI_TEAM_ID`。
- 响应：`coreInvoice.prepaidCredits.val`（USD 分，记账负数表示剩余，如 `-4500` = $45.00）、`prepaidCreditsUsed.val`（本周期已用）、`billingCycle`。
- 官方文档：[Management API / Billing](https://docs.x.ai/developers/rest-api-reference/management/billing)；推理 API 本身无余额端点。
- 另注：`cli-chat-proxy.grok.com/v1/billing` 是 Grok CLI 订阅额度（Grok Build），与 API 预付余额是两回事，不适用。

## 安装

1. 在 DSH web profile 目录建立指向本仓库的包链接（一次性）：

   ```sh
   mkdir -p ~/.dsh/profiles/web/node_modules
   ln -sfn /Users/danielwei_zhang/workspace/dsh-provider-balance \
     ~/.dsh/profiles/web/node_modules/dsh-provider-balance
   ```

   > ⚠️ 用 `pnpm install` 的 `file:` 依赖装出来的是**硬链接副本**：编辑器原子替换写文件后
   > 副本与仓库脱钩，进程会一直跑旧代码。开发时务必用上面的软链方式；若已用 `file:` 安装，
   > 删掉 `node_modules/dsh-provider-balance` 目录再建软链即可。

2. 从 harness checkout 启动（`--patch` 必须放在 web 应用自有 flag 如 `--port` 之前）：

   ```sh
   cd ~/workspace/deepseek-harness
   pnpm dsh web --patch ~/workspace/dsh-provider-balance/cordis.yml
   ```

3. 刷新 `http://127.0.0.1:3080`，输入框工具行右侧（模型选择器左边）会出现余量胶囊。
   **胶囊跟随当前会话选中的模型**：窗口型固定显示 5 小时剩余百分比，余额型显示金额；
   切到没有适配器的供应商（如 openai）时胶囊消失。
   点击展开详情：各窗口进度条（蓝 5h / 绿周 / 紫月或工具）、重置倒计时、套餐档位、手动刷新。
   同时，设置 → 模型 页每个已配置供应商的行上会出现同数据的紧凑徽标（纯插件 DOM 注入，
   无需 harness 侧任何槽位或源码改动）。

### 持久挂载（可选）

把 overlay 内容并入 `~/.dsh/profiles/web/cordis.patch.yml`（同样的 insert 行），之后裸
`pnpm dsh web` 即生效，无需 `--patch`。

## 凭据解析顺序

1. DSH `credentials` 服务（`ctx.get('credentials').resolve(apiKeyEnv)`）；
2. 进程环境变量（默认 `ZAI_CODING_CN_API_KEY`）；
3. `$DSH_HOME/.credentials.yaml` 文件直读（credentials-local 的托管层）。

Key 只在 Host 侧使用，浏览器只收到聚合后的百分比/次数 JSON，永远不会看到密钥。

**换 key 即时生效**：服务句柄按次解析（不在 apply 时捕获，本插件可能先于 credentials
服务激活），文件层每次重读不缓存；同时插件监听 `credentials/reference-updated` 事件，一旦某个
ref 被改写，对应供应商的快照立即作废，下一次轮询（≤5 分钟）或点面板的刷新按钮即用新 key
重新拉取，无需重启进程。

## 配置（cordis.yml `config`，全部可选）

```yaml
- id: dsh-provider-balance
  name: dsh-provider-balance
  inject: [webServer]
  config:
    sources:
      - id: zai-coding-cn        # 必须等于 DSH provider 路由 id（胶囊按它匹配当前模型）
        kind: zai-coding          # GLM Coding 适配器
        apiKeyEnv: ZAI_CODING_CN_API_KEY      # 缺省用适配器默认
        quotaBase: https://open.bigmodel.cn   # 国际版填 https://api.z.ai
      - id: kimi-coding
        kind: kimi-coding         # Kimi Code 适配器
        # apiKeyEnv / quotaBase 缺省用适配器默认（KIMI_CODING_API_KEY / api.kimi.com）
      - id: opencode-go
        kind: opencode-go         # OpenCode Go 适配器
        # 缺省 OPENCODE_GO_API_KEY / https://opencode.ai/zen/go
      - id: deepseek-official
        kind: deepseek-official   # DeepSeek 官方余额适配器（文档化接口）
        # 缺省 DEEPSEEK_API_KEY / https://api.deepseek.com
      - id: moonshot-platform
        kind: moonshot-platform    # Moonshot 开放平台余额（注意：与 Kimi Code 是两把 key）
        # 缺省 MOONSHOT_API_KEY / https://api.moonshot.cn
      - id: xai
        kind: xai                  # xAI Management API 预付额度（需 Management Key）
        # 缺省 XAI_MANAGEMENT_KEY / https://management-api.x.ai（team 用 default 或 XAI_TEAM_ID）
    refreshMinIntervalMs: 60000   # 上游最小抓取间隔（缓存 TTL）
    requestTimeoutMs: 15000
    route: /provider-balance/quota
```

HTTP 接口：`GET /provider-balance/quota?provider=<路由id>[&refresh=1]` 返回该供应商的
单条快照（`sources` 数组一个元素）；不带 `provider` 返回全部源。

## 故障排查（胶囊显示 `!`）

`!` = 该供应商最近一次刷新失败且没有可回退的旧快照。两条线索可追查：

1. **悬浮提示**：hover 胶囊直接显示错误原因（如「上游接口返回错误: upstream HTTP 429」）；
   点击展开面板也有同一行错误。
2. **刷新事件接口**：`GET /provider-balance/quota?events=1[&provider=<路由id>]` 返回每个源
   最近 30 次刷新记录（时间、成败、耗时、`via` 凭据来源层、错误码），不含任何密钥。

此外每次失败还会向宿主进程 stdout 打一行
`provider-balance: <源> refresh failed (<错误码>): <详情>`。

客户端轮询策略：失败时先每 30 秒快速重试（最多 3 次），仍失败才退回 5 分钟慢轮询 ——
一次网络抖动不会让 `!` 挂 5 分钟。

## 添加新供应商

Host 侧是适配器注册表，新增一家供应商只需要：

1. 在 `src/index.ts` 写一个适配器对象：`{ credential, base, async read(getJson) }` ——
   `read` 里用 `getJson(path)`（已带鉴权与超时）拉上游接口，把响应映射到
   `{ plan?, session?, weekly?, tools? }` 的统一窗口形状；
2. 在 `ADAPTERS` 注册 kind，在 `DEFAULT_SOURCES` 加一行 `id（路由 id）→ kind`。

凭据解析、传输、按源缓存/TTL/并发合并/stale 降级、HTTP 路由全部是共享管道，不需要动。
Client 侧零改动 —— 胶囊按当前模型的路由 id 自动匹配新源。

## 架构

```
src/index.ts        Host 半：适配器注册表（ADAPTERS：每上游一个 {credential, base, read}）
                    + 共享管道（配置校验、凭据三层解析、鉴权传输、按源缓存/TTL/
                    并发合并/stale 降级）→ webServer 挂 /provider-balance/quota JSON 路由，
                    支持 ?provider=<路由id> 过滤。key 不进日志/响应。
client/client.js    浏览器半：手写 __ModuleLoader__ bundle（react、react-dom/client 与
                    dsh-client-ui-primitives 从冻结模块表 require）。共享的徽标核心
                    （取数 hook + 弹层面板 hook + ProviderBalanceBadge 渲染体）之上两个
                    薄组件：输入框胶囊订阅共享 modelDirectories directory（ModelSelect 的
                    同一 store）跟随会话当前模型；设置行徽标经 MutationObserver 定位
                    provider 行（路由 id 取自编辑按钮 aria-label），插外源容器并以独立
                    React root 挂载，静止于每行。无适配器的供应商不渲染。注册
                    conversation.input.right 槽位条目 + zh/en 词典；行徽标为纯 DOM
                    注入，不占任何槽位；5 分钟轮询。
package.json        dsh.client 声明（platform: web + inject 面向
                    locale/ui-conversation）与 exports["./client"]。
cordis.yml          本地开发 overlay。
```

注入点说明：上下文圈圈（ContextMeter）是 `ui-conversation` 内部组件、无独立槽位；
扩展点中离它最近的是工具行右端列表槽 `conversation.input.right`（渲染于模型选择器之前、
圈圈之后），走正式槽位注册。Models 设置页的行内徽标没有可用的宿主槽位（上游
ui-settings-models 不声明行级座位），因此走 DOM 注入：徽标组件经 `react-dom/client`
（冻结模块表内建可用）挂进外源容器，路由 id 取自编辑按钮 aria-label，MutationObserver
扫描合并为 50ms 一次、每轮重申容器位置以扛宿主 reconcile，行消失即卸载对应 root，
离开设置页后 DOM 零残留。配色复用 `--dsw-alias-*` / `--dsw-static-amber/red` 主题令牌，
暗色模式自动适配。

## 已知边界

- 三家的配额接口都未在公开文档中承诺；上游变更时只需改对应适配器的 `read`，其余不动。
- 百分比来自上游（GLM/OpenCode 直接给已用百分比；Kimi 由配额点数换算）。
- 每个浏览器标签页各自轮询（5 分钟），Host 侧 TTL 保证上游压力恒定。
- OpenCode Go 的 key 尚未存入 DSH 凭据库时，切到该供应商的模型会显示 `missing-key` 提示；
  在 Web 设置 → Models 页录入 `OPENCODE_GO_API_KEY`（或加入 `~/.dsh/.credentials.yaml`）后即恢复。

## License

MIT
