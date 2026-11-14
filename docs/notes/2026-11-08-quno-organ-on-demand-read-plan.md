# 2026-11-08 Quno 按需只读查询能力修复方案（云之家 organ 接入）

> 状态：**方案定稿（待决问题已全部关闭，见 §7），未实施。** 诊断与评测补全见同日 [2026-11-08-quno-third-party-tool-evaluation.md](2026-11-08-quno-third-party-tool-evaluation.md)。实施时另立 impl note（不改写本文），并同 PR 更新 [docs/quno-bot-design.md](../quno-bot-design.md) 对应小节（见 §6）。

## 1. 问题与结论复述

用户看到的 Quno 回复把「无法查询云之家」归因为「桌面端更新后 shell organ 没挂上」。诊断已证实该归因错误：`organ:*` 是 Quno 按 Sense 实例路由的异步 Exchange 端点，与桌面 shell 插件无关；宿主机 `yzj-cli` 实测正常。真实根因是三层叠加：

1. **能力从未存在**：云之家 Sense 只声明轮询采集，没有任何按需查询能力。
2. **模型无从发现**：不存在任何把「已挂载 organ 端点」告诉模型的表面，端点名只能靠猜。
3. **拒绝不可指导**：拒绝错误不列出真实可用端点，模型只能编造解释（桌面更新、organ 掉线）。

## 2. 根因分层（代码级，已核实）

- **G1 能力缺口**：`dsh-quno-sense-yzj/src/index.ts` 的 definition 无 `organ` 字段，`reliability.readOriginal: false`，`runtime.modes: ['poll']`。不存在可供 Worker 或主对话按需调用的云之家查询。
- **G2 发现面缺口**：Sense 实例 id 形如 `sense-<时间戳>-<随机6>`（`dsh-quno/src/senses.ts:299`），模型不可能猜中。`quno_read`（Worker）只返回 Ticket/订阅/Trigger，不列 organ；主对话的 `quno_read`/`quno_status` 同样不列。两处 `quno_exchange` 的描述还给出虚构示例「如 organ:calendar」（`preset.ts:916`、`worker-tools.ts:316`）——示例本身就不存在。**这是「模型乱猜 organ:yzj-cli / organ:shell」的直接机制成因。**
- **G3 门控口径错位**：`service.ts:567 organAdvertises` 只校验「该 id 是已挂载 SenseInstance」，**不校验其类型是否声明 organ 能力**。对真实 yzj 实例 id，工具层会返回「已发起读取请求」，随后 `deliverExchange`（`service.ts:639-648`）发现无 handler，`failExchange('capability-unavailable', retryable=false)`。失败会如实回流（`engine.ts:1305-1337` 插入 Input「异步读取失败：capability-unavailable」），不造假，但「先成功后失败」的两段式语义有误导性。
- **G4 非回归**：`quno-task` preset 无 `@deepseek-ai/dsh-tool-bash`、主对话 `HIDE_GLOBAL_TOOLS` 隐藏 bash，均为 [2026-10-31-quno-preset-tool-restriction.md](2026-10-31-quno-preset-tool-restriction.md) 定稿的设计边界，有测试固定。不是桌面构建丢插件，也不应回加。

**已就位、无需重建的机制**：`OrganCapabilities.handleRequest/handleCommand` 签名（`core/model.ts:144-173`）；contracts 对 `organ` 字段的 passthrough（`contracts.ts:236`）；`senses.organCapabilitiesForInstance` 查找（`senses.ts:563`）；ExchangeRecord 全状态机与超时/失败/晚到语义（[2026-11-01-quno-trigger-organ-and-exchange.md](2026-11-01-quno-trigger-organ-and-exchange.md)）；失败→Input 回流。修复是**填能力、补发现面、收紧门控**，不是新架构。

## 3. 修复原则

1. **不给 Worker 加 shell**。查询能力以结构化白名单 schema 暴露（op 枚举 + 参数校验），不接受自由 argv；bash 通道即使加白名单也等价于结构化面但保留更大攻击面，且违背 10-31 只读边界定稿。
2. **能力声明与发现面同补**：能查的东西必须能被模型发现；否则对模型而言等于不存在，只会继续猜。
3. **拒绝必须可指导**：`unknown-responder` 错误列出当前真实可用 organ（含 label）；列表为空时明确说「当前没有任何可应答的 organ」。
4. **声明诚实**：`readOriginal` 与 `organ` 能力变更必须反映真实支持面，设计文档同 PR 改写。

## 4. 变更方案

### F1 `dsh-quno-sense-yzj`：声明 `organ.handleRequest`（最小只读白名单）

- definition 增加 `organ: { handleRequest }`，payload 为 §5 的 op 枚举 schema。未知 op 或参数越界 → `failExchange('unsupported-op' | 'invalid-args', retryable=false)`；不进入 CLI 重试。
- 实现复用本包 `spawnCli`（超时、无 shell、stdout 8MB cap、abort 响应）与 `classifyRun` 失败分类；auth 类失败 → `failExchange('auth-required', false)`，与健康面的 `auth-required` 态一致，不吞。
- 结果走 `completeExchange(result)`，自然进入 responded → Ticket Input「异步读取结果」回流；**不改回流路径**。
- `--profile` 由 Sense config 决定，payload 不得指定。
- `readOriginal` **维持 `false`**（2026-11-08 定稿，§7.3）：该声明的真实语义是「入库载荷即可读原文」——UI 证据可读性门控只看声明与事件是否 `pruned`（`client/attention-view.tsx:200-212`、`client/panel-state.ts:303-316`），展示的是 Quno 已入库的事件载荷，不存在 organ 往返；`organ.readOriginal` 槽位（`core/model.ts:147`）当前零调用方。yzj 入库 `data.text` 截断在 2000/4000 字符（`round.ts:1626`、`:1638`），编辑/撤回不可观测，声明 true 不诚实。`handleRequest` 与该声明正交：Worker 按需查询拿到的是实时窗口重读，不改变入库载荷是否完整。

### F2 发现面：organ 端点可被发现（主对话与 Worker 两端）

- Worker 的 `quno_read` 输出增加 `organs: [{endpoint, label, type, capabilities, health}]`，数据源 `store.listSenseInstances` + 类型定义 organ 面 + 实例健康态。
- 主对话在同源的 `quno_read`（或 `quno_status`）增加同列表；`QUNO_GUIDANCE` 的「需要的读取用 quno_exchange 发起」一句补「先用 quno_read 查可用 organ 端点，不要猜端点名」。
- 两处 `quno_exchange` 描述删除虚构示例，改为「用 quno_read 查到的 organ:<instanceId>」。

### F3 门控收紧：`organAdvertises` 语义修正

- 改为「instance 存在 **且** 其类型声明与本次 kind 匹配的 `handleRequest`/`handleCommand`」。无能力实例在工具层即拒，消除「已发起读取请求」之后 `capability-unavailable` 的两段式误导。
- 两处 `quno_exchange`（`preset.ts` 主对话、`worker-tools.ts` Worker）共用该判定；拒绝文案附可用 organ 列表（endpoint + label），主对话转述用 label 不用 id。

### F4 评测激活与新增（衔接已注册入口，见同日诊断 note §评测补全）

- **激活 `third-party-cli-live-read`**（现为 blocked）：前置 = F1–F3 落地 + 生产 profile 存在真实云之家实例 + live-source smoke 显式选择账号与读取范围。断言链：用户真实请求 → 主对话 `quno_task` → Worker `quno_read` 发现 `organ:<instanceId>` → `quno_exchange`（op=im.message.list）→ 结果 Input 回流 → Worker `ready` 报告引用真实消息 → 主对话转述无虚构。合成 organ 不算通过。
- **新增 Scripted**：
  - `organ-discovery`：Worker 从 `quno_read` 拿到端点清单并成功对真实注册的 organ 类型发起（可用测试 double 的类型声明，但端点发现链路为真）。
  - `organ-whitelist-reject`：未知 op、越界 limit、写意图 payload 均被 `failExchange` 且 reason 明确、不产生 CLI 进程。
- **`live-third-party-tool-unavailable` 语义更新**（F2 落地后）：乱猜端点名仍必须被拒，但拒绝信息应引导到真实端点；归因桌面更新、虚构成功仍判 `MODEL_GROUNDING`。
- **不变量回归保留**：`quno-task` 仍无 bash（preset-composition 断言不动）；`third-party-tool-unavailable` 原有断言全部保留。

## 5. yzj 只读查询白名单 v1

| op | 参数（上限） | 映射 CLI | 说明 |
|---|---|---|---|
| `im.group.recent` | `limit≤20, page≤10` | `im group recent --limit --page` | 最近会话目录 |
| `im.group.search` | `keyword≤64` | `im group search --keyword` | 按名找群 |
| `im.message.list` | `groupId, limit≤50, page≤20` | `im message list --group-id …` | 群/私聊窗口内重读（Worker 侧原文来源；与 UI 的 readOriginal 声明无关） |

硬边界：枚举外 op 一律拒绝；任何 send、已读回执、成员管理、文件下载、审批操作类命令**永不进白名单**；每次请求一个 CLI 进程，超时沿用 `CALL_TIMEOUT_MS`；输出截断后标注 truncated。按需查询与轮询**共享** instance 级 `REQUESTS_PER_MINUTE` 预算，不单设按需配额（2026-11-08 定稿）；预算耗尽时 `failExchange('rate-limited', retryable=true)`，走 Exchange 现有的 attempts<3 指数退避（`engine.ts:1290-1303`），不得绕过限速器。具体 argv 参数以 [2026-10-23-quno-sense-yzj-cli-contract-review.md](2026-10-23-quno-sense-yzj-cli-contract-review.md) 与当前 CLI 版本实测为准，实施时复核。

## 6. 文档与流程义务（AGENTS.md 规则映射）

- **契约同 PR**：`docs/quno-bot-design.md` 四处——yzj 能力表（`readOriginal` 行维持 `false`，理由改写为「入库载荷截断（2000/4000 字符）且编辑/撤回不可观测，不构成可读原文；按需结构化查询（handleRequest）另行支持，与本声明正交」）；organs 适配层职责（现 :845 一带补 handleRequest 白名单纪律）；eval 场景表（现 :889 行的激活条件更新）；「感知靠 Sense/Organ」能力面描述补按需查询。
- **决策记录**：本文为方案；实施另立日期命名 impl note，不改写本文与诊断 note。
- **发版**：`dsh-quno`（F2/F3，quno_read 输出与门控属包内 API 面）与 `dsh-quno-sense-yzj`（F1）各自独立插件 tag `<包名>-v<semver>`；不与桌面锁步（壳/IPC/打包未动）。
- **测试纪律**：yzj 包内 node:test 覆盖白名单拒绝与参数裁剪；quno 包内覆盖发现面与门控收紧；`pnpm run plugins:check` 全绿后才进 live 评测。

## 7. 决策定稿（2026-11-08，全部关闭）

1. **endpoint 命名：保持 `organ:<instanceId>`，不加 `organ:<type>` 别名**。`--profile` 使一个类型多实例（多账号）是受支持的常态，别名恰在多实例时失效或需歧义裁决；可猜性由 F2 发现面根治，模型本就不该猜。Exchange 契约里 endpoint 是持久身份（`ExchangeRecord.responder`），一物双名会让日志与配对记录漂移。主对话/Worker 的转述与拒绝文案一律带 label。
2. **主对话直查：两端保留，口径分工**。主对话 `quno_exchange` 定位为单次证据补读（Eval 回合核对原文、用户直接问一句的原文核对）；多步、要汇总的工作一律委派 Worker——guidance 已是该纪律，不改边界。机制已就绪：router 侧 exchange 失败走 `router-relay`（`engine.ts:1306-1314`），response 作为自动回合输入回流；共享速率预算天然限住主对话侧滥用。live 正向验收只认 Worker 委派路径，避免双通过口径。
3. **readOriginal：v1 维持 `false`，连声明都不升**（修正本 note 初稿「升声明、UI 维持摘要优先」的倾向）。初稿误以为按需查询能支撑「证据可点开」；核实后该声明描述的是入库载荷的完整性，与 `handleRequest` 正交，而 yzj 入库载荷是截断的（见 F1 末条）。若后续要让 yzj 证据可点开原文，两条路择一另立设计：(a) 入库载荷保全文（受 `LIMITS.maxEventBytes` 64KB 约束）；(b) 把零调用方的 `organ.readOriginal` 接成 UI 原文点开的实时重读通道，与 UI 一并设计验收。均不在本方案范围。

（速率预算同日定稿为共享，见 §5 硬边界。至此本方案无待决问题。）

## 8. 实施验收清单（DoD）

- [ ] yzj/quno 两包 typecheck + test 全绿；`plugins:check` 通过。
- [ ] Scripted 新增两用例 + 原 `third-party-tool-unavailable`、`exchange-roundtrip` 全绿。
- [ ] `live-third-party-tool-unavailable` 实测一次（真实模型），拒绝文案含真实端点引导。
- [ ] 满足激活条件后实跑 `third-party-cli-live-read`，证据含真实 CLI argv、Exchange responded、Worker ready 报告与主对话转述；在此之前它保持 blocked，不计入通过数。
- [ ] `quno-bot-design.md` 四处同 PR 更新（清单见 §6）；impl note 落档。
- [ ] 实机 smoke：真实 profile 下 Worker 查询一条真实群消息并回流（scratch home 验证，不污染真实 `~/.dsh` 的前提下用生产实例 id 属实机范畴，按 desktop-plugin-integration 纪律执行）。
