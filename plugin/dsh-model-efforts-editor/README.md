# dsh-model-efforts-editor

在 stock「设置 → 模型 → 供应商 → 自定义设置」的每条已保存 pi-ai 模型行内注入一个**推理档位按钮**（dial 图标），点开一个内联编辑面板：选择推理档位组合、给每档填线上值、勾选 Z.ai 线缆格式，一键写回 `settings.yaml` 的 `llm-pi-ai` 用户层。browser-only，纯 DOM 注入。

## 为什么需要它

`reasoningEfforts` / `compat.supportsReasoningEffort` 是 llm-pi-ai 模型条目的字段，但 stock 模型设置页**刻意不提供编辑入口**（上游注释：effort 是 per-model 能力，不该做 provider 级控件）；composer 的档位选择器又只在模型声明了档位时才出现——手写模型的死循环。上游 [discussion #843](https://github.com/deepseek-ai/deepseek-harness/discussions/843)。本插件补上这个入口后，改模型档位不再需要手工编辑 `settings.yaml` 或重新发版。

三态语义与 llm-pi-ai 的解析规则一致：

- **跟随默认**（undeclared）——删除声明，回到目录继承；
- **不推理**（`false`）——钉死非推理；
- **自定义档位**——勾选要提供的档位并填线上值；`off` 留空 = 支持「关」但不发送参数。

「Z.ai 线缆格式」勾选写入 `compat: {supportsReasoningEffort: true, thinkingFormat: "zai"}`——zai 系路由自动探测两者为关，不显式声明档位就不会上线（GLM-5.3 起思考恒开、不再接受关闭）。

## 安装

```sh
dsh plugin --profile web add <repo>/plugin/dsh-model-efforts-editor
```

桌面版随包分发、首启自动装进 web Profile，无需手动执行。卸载即回 stock 布局。

## 行为边界

- 只在带「获取可用模型」动作的卡片（即 pi-ai 手写模型卡）注入，DeepSeek 目录卡天然排除；
- 行与存储行的锚定沿用 dsh-provider-balance / dsh-model-image-input 的姿势：卡片行 id 序列必须精确等于某路由的存储序列，改未保存草稿或目录路由不可编辑（fail-invisible，DOM 失配只是按钮不出现）；
- 写入走 typed `remote.settings.mutate` 整组 models 数组 op（携带读时 revision；0.1.2 起的姿势——上游已移除 `connection.api` 门面），即时生效，无需重启；
- 已有声明按整键替换（本插件的职责就是设这个键），compat 之外的兄弟字段原样保留。

## 开发

```sh
pnpm install && pnpm run typecheck && pnpm run test && pnpm run build
```

决策记录：仓根 `docs/notes/2026-08-27-dsh-model-efforts-editor.md`。
