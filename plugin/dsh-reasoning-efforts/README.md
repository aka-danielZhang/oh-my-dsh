# dsh-reasoning-efforts

给 `llm-pi-ai` 手工声明模型的**推理档位自动补齐**插件（host-only）。

## 为什么需要它

自定义 OpenAI 兼容路由（如 sub2api 网关代理的 Grok、手写声明的 Z.ai coding 路由）在 `settings.yaml` 里手工声明模型时，通常不带 `reasoningEfforts`——Web GUI 没有这个字段的编辑入口，网关的 `/models` 列表也不携带任何推理元数据（上游 [discussion #843](https://github.com/deepseek-ai/deepseek-harness/discussions/843)）。于是 llm-pi-ai 把这些模型解析为非推理模型，Composer 的模型选择器完全不出现「推理等级」面板。

部分供应商还要再多一层：zai 系路由（provider id / baseURL 自动探测）的分发对 thinking 参数有专属拼法（`thinking.type` + `reasoning_effort`），且 `compat.supportsReasoningEffort` 自动探测为 **false**——只声明 `reasoningEfforts` 也不会真正把档位发上线；GLM-5.3 系列更是已拒绝 `thinking.type: "disabled"`。这类模型需要显式补 `compat`。

本插件在挂载时、以及每次 `llm-pi-ai` 设置提交之后，给缺失声明的模型补上：

1. 用户层已显式声明的内容**绝不覆盖**——efforts 按整个 `reasoningEfforts` 键判（含 `false`），compat 逐字段判；
2. 按序匹配组合行 `config.rules`（first-match-wins）；
3. 当前适配器对该路由/模型**已提供档位**（目录继承，如 `openai` 路由的 `gpt-5.1`）→ 跳过 efforts 片（compat 片照常补）。

写入走 `settings.mutate` 的路径寻址 set op（携带读时 revision，并发编辑会被 `SETTINGS_CONFLICT` 拒绝而不是被覆盖），只增不删——移除一个声明请手工编辑 `settings.yaml`。

## 安装

```sh
dsh plugin --profile <profile> add <this-repo>/plugin/dsh-reasoning-efforts
```

随包 `cordis.patch.yml` 自带两组默认规则：先钉住 grok 路由的 `*-non-reasoning`（`efforts: false`），再给 `grok` / `grok-latest` / `composer*` 填 xAI 官方线缆档位 `low/medium/high`；另有 GLM-5.3 线规则（`glm-5.3` 及 `-flash` 等 `-` 后缀变体）：官方三档 `low/high/max`（5.3 起思考恒开、不再支持关闭）+ zai compat 双开关。`grok-imagine*`、`glm-4*` / `glm-5.0-*` 等旧线模型不匹配任何规则、保持原样。

## 配置

规则在组合行的 `config` 里（编辑 profile 的 patch 层或 `dsh plugin add` 后的行）：

```yaml
- id: dsh-reasoning-efforts
  name: dsh-reasoning-efforts
  config:
    rules:
      - routes: [grok]           # 精确路由 id（settings providers 字典键）
        include: non-reasoning   # 模型 id 正则；命中即用本规则
        efforts: false           # 钉死非推理（选择器不出现）
      - routes: [grok]
        include: '^(grok$|grok-latest$|composer|grok-4|grok-composer)'
        exclude: fast            # 可选：exclude 胜过 include
        efforts:                 # 档位 -> 发给网关的线上值
          low: low
          medium: medium
          high: high             # 也可以 high: ultra 做网关映射
      - routes: [zai-coding-cn]  # compat 可选：声明了才参与补齐
        include: '^glm-5\.3'
        efforts:
          low: low               # GLM-5.3 官方三档：low/high/max（默认 max）
          high: high
          max: max
        compat:
          supportsReasoningEffort: true   # 不写这个，zai 分发不发 reasoning_effort
          thinkingFormat: zai             # 换 thinking/reasoning_effort 的线上拼法
```

约束（挂载时 fail-loud 校验，镜像 llm-pi-ai 自己的解析规则）：

- efforts：档位键只能是 `off/minimal/low/medium/high/xhigh/max`；只有 `off` 可以留空（`off:` = 支持、不发参数）；其余档位必须给非空线上值；至少声明一个 `off` 之外的档位；`efforts: false` 表示非推理模型。
- compat：字段只能是 `supportsReasoningEffort`（布尔）与 `thinkingFormat`（`openai/deepseek/openrouter/together/baseten/zai/qwen/chat-template/qwen-chat-template/string-thinking/ant-ling` 之一）；未知字段拒绝——llm-pi-ai 对不认识的开关 fail-loud，写进去会把整条路由打挂而不是被忽略。

## 行为边界

- 补齐后立即生效（llm-pi-ai 每次操作重读 profiles），无需重启；
- 「缺什么补什么」：efforts 与 compat 两片独立判定，可单独成为候选（例如模型已手工声明 efforts 只缺 compat 时，只补缺失的 compat 字段，已声明的拼法原样保留）；
- 插件自身的写入会再触发一轮空填充（已补的模型不再是候选），循环自然终止；
- 目录继承跳过的只是 efforts 片——适配器已经报得出档位的模型（如内置目录模型）不会被规则降级重写，但其缺失的 compat 开关仍会补上；
- 修改规则不会撤销已写入的声明——一旦进了用户层就是显式声明，归门卫 1 保护；
- settings 提供方只读（无可写持久层）时警告一次并跳过。

## 开发

```sh
pnpm install && pnpm run setup   # 建 dsh -> $DSH_CHECKOUT 符号链接
pnpm run typecheck && pnpm run test && pnpm run build
```
