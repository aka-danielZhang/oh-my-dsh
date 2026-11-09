# 2026-11-08 Quno 按需只读查询落地（云之家 organ F1–F4）

实施 [2026-11-08-quno-organ-on-demand-read-plan.md](2026-11-08-quno-organ-on-demand-read-plan.md) 的 F1–F4。方案与决策不改写，本文只记落地事实与偏差。

## 落地内容

- **F1 `dsh-quno-sense-yzj`**：新增 `src/organ.ts`——`parseOrganPayload`（封闭 op 白名单 + 参数校验，纯函数）、`boundOrganList`（条数与单字段 4000 字符截断，截断如实标注）、`registerOrganInstance`（运行实例注册表：instanceId → profile，factory `start` 注册 / `stop` 注销）、`handleOrganRequest`（复用 `spawnCli` + `classifyRun`，共享 `takeToken` 每分钟预算）。definition 声明 `organ: { handleRequest }`（惰性绑定 spawnCli）；`reliability.readOriginal` 维持 `false`。
- **F2 发现面**：`QunoHost.organEndpoints()`（`OrganEndpointView`：endpoint/label/type/capabilities/health；只列声明了 exchange handler 的实例，列表成员与门控放行口径一致）→ 两端 `quno_read` 输出增加 `organs`（主对话 `readObjects` 概览分支 + Worker 工具）；`QUNO_GUIDANCE` 与两处 `quno_exchange` 描述改为「从 quno_read 的 organs 取端点，不要猜」。
- **F3 门控**：`organGateAdvertises(organ, kind)` 纯函数——instance 挂载 **且** 类型声明对应 kind 的 handler；主对话 `requestExchange` 与 Worker `resolveExchangeResponder` 共用；拒绝文案附「endpoint（label）」目录，空列表明确说「当前没有任何可应答的 organ」。消除「已发起读取请求 → capability-unavailable」两段式误导：无能力实例在工具层即拒。
- **F4 评测**：新增 Scripted `organ-discovery`（Worker 经 `quno_read.organs` 发现真实挂载端点并成功交换）与 `organ-whitelist-reject`（未知 op/越界 limit/写意图 payload 全部 `failExchange` 且原因回流，fixture 以 §5 contract double 驱动；白名单矩阵本体由 yzj 包内测试钉死）；`live-third-party-tool-unavailable` 语义更新（工具面放宽为 quno_read/quno_exchange 二者其一，新增 `refusal-guides-discovery` 语义）；`third-party-cli-live-read` 保持 blocked，激活前置改为「生产 profile 存在真实云之家实例 + live-source smoke 显式选择只读账号与读取范围」。

## 与方案的偏差（均在方案预留的复核条款内）

1. **`im.message.list` 白名单去掉 `page`**：实测 yzj-cli 该子命令无 `--page`（分页走 `--msg-id` 游标与 `--type`），v1 只回最新窗口（limit≤50）。方案 §5 表格的 page≤20 按其自身的「argv 以实测为准」条款修正。
2. **失败重试口径**：`auth-required` / `degraded` / `cli-missing` 不可重试；`rate-limited` 与网络类 `unavailable` 走引擎现有 3 次指数退避。方案只钉死 auth 与 rate-limited 两类，其余为实施取舍。
3. **拒绝 reason 自描述**：unsupported-op / invalid-args 的 reason 带可用 op 清单与上限值，回流 Input 直接可指导，模型无需二次猜测。

## 验证

- **yzj**：typecheck + node:test 54 绿。新增 `tests/organ.test.ts`：白名单拒绝矩阵（写意图/未知 op/越界/未知参数/payload 带 profile）、零 CLI 进程断言、输出截断、分类失败映射（auth/ENOENT/网络/坏信封）、预算共享（耗尽即拒且 retryable）、超时继承。
- **quno**：typecheck + node:test 180 绿。新增 `tests/organ-gate.test.ts`：门控 kind 矩阵、发现面投影（只列 exchange-facing 实例）、注册表对未知 id 解析为拒绝。
- **eval**：scripted 全量 **21 绿 + 8 blocked**（`pnpm run eval` 全绿）；`organ-discovery` / `organ-whitelist-reject` 均 pass；`exchange-roundtrip`、`third-party-tool-unavailable` 等既有用例无回归。
- `pnpm run plugins:check` 全绿。

## 文档

- `docs/quno-bot-design.md` 同 PR 四处更新：「感知靠 Sense/Organ」补按需查询面；yzj 能力表 `readOriginal` 行理由改写（修正初稿口径）+ 新增「按需读取」小节；organs 适配层职责行补白名单纪律；§15.1「第三方工具不可用」行补发现面/门控/白名单拒绝语义；评测计数 18+8 → 21+8。

## 后续（不在本 PR）

- 发版：`dsh-quno` 与 `dsh-quno-sense-yzj` 各自独立插件 tag `<包名>-v<semver>`（release runbook），不与桌面锁步。
- DoD 剩余项：`live-third-party-tool-unavailable` 用真实模型实测一次（拒绝文案含真实端点引导）；激活条件满足后实跑 `third-party-cli-live-read`；实机 smoke（scratch home 下 Worker 查询真实群消息并回流）。
