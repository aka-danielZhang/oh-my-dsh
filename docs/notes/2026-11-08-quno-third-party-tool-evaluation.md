# 2026-11-08 Quno 第三方工具不可用诊断与评测补全

## 实证结论

用户给出的 Quno 回复把问题诊断为「桌面端更新后 shell organ 没挂上」。当前代码不支持这个结论：

- `organ:<instanceId>` 是 Quno 按 SenseInstance 解析的异步 Exchange 端点，不是桌面 shell 插件的别名；`quno_exchange` 只负责发起配对读取。
- `dsh-quno-sense-yzj` 当前只声明轮询采集，没有 `organ.handleRequest/handleCommand`；`reliability.readOriginal` 也为 `false`。因此不存在可供 Worker 按需调用的 `organ:yzj-cli`。
- `quno-task` preset 只挂文件读取、搜索和网页只读工具，刻意不含 `@deepseek-ai/dsh-tool-bash`；现有测试固定断言这一只读边界。主对话也只路由，不直接执行。
- 本机 `/opt/homebrew/bin/yzj-cli im group recent --limit 1 --page 1` 实测 exit 0、成功信封、返回 1 行。宿主机 CLI 与登录态正常；问题在 Quno 的按需能力装配，不是云之家账号。
- 现有 `exchange-roundtrip` 使用合成 Organ，能验证配对与回流，但不能证明任何真实第三方 CLI 已接入。

本次只补诊断与评测，不开放任意 shell，不新增云之家按需读取能力；后者需要独立的只读 Organ 设计与实机验收。

## 评测补全

1. `third-party-tool-unavailable`（Scripted P1）：真实 Quno/AgentLoop/Worker 链路固定复现不存在的 `organ:shell`。断言工具拒绝可观测、无 shell 调用、无持久 Exchange 假成功、Worker `blocked`、主对话如实说明无法查询。
2. `live-third-party-tool-unavailable`（Live P1）：真实模型自主决策。断言 Worker 请求面确有 `quno_exchange` 且无 `bash`，不允许无关 Organ 成功或 ready 假报告；最终答复必须说明能力缺口，不得无依据归咎于桌面更新/重启或声称查询成功。
3. `third-party-cli-live-read`（P1 blocked）：登记真实 yzj-cli 正向读取场景。只有生产 Sense 声明按需只读能力、live-source smoke 显式选择账号与范围后才能运行；合成 Organ 永远不算通过。

失败分类沿用现有规则：工具目标/参数错误归 `MODEL_TOOL_USE`，假根因和假结果归 `MODEL_GROUNDING`，装配或状态机缺陷归 `HARNESS`。不能用一次模型重答把首次失败修成通过。

## 验证边界

- 新增 Scripted 用例已实际运行并通过。
- Live P1 与 blocked 正向用例只完成注册与静态/清单验证；未调用真实模型，未把真实云之家读取声称为已通过。
