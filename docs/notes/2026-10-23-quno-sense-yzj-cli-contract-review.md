# 2026-10-23 云之家群聊 Sense 设计（§6.11）按 yzj-cli 实测评审修订

对 `docs/quno-bot-design.md` §6.11 的评审与实测复核（本机 yzj-cli 0.1.5，登出态）。结论落回 §6.11 正文，本 note 留决策轨迹。

## 评审成立并采纳

1. **`--limit` 上限 20**：`im message list --limit` 默认 10、范围 1–20（skill 参考文档）；实测 `--limit 50` 不被 CLI 本地拦截（exit 3 鉴权而非 exit 2 参数错），越界值透传服务端、行为未定义。命令面写死 20；配额改为「每页 20 × 每群 5 页 = ≤100 条/群/次」，多群按 checkpoint 最旧优先轮询，未轮到/未翻完的群停在各自游标顺延下一轮。评审「`maxEventsPerCheck` 200 只够 2 群、永远追不上」系过头表述——只有持续入流超实例配额才追不上，且表现为 sourceLag 增长、经健康面可见；真正缺陷是原文没把配额按群说清。
2. **健康分类两层化**：CLI 失败契约是「stdout 空 + stderr 单行错误信封 + 退出码按 `error.type` 派生」。实测登出态 `contact user get` → exit 3、`type=authentication`/`subtype=credentials_missing`、**无 errorCode**——原文只认 errorCode 10000400/93001 会把本地未登录漏成「未知错误」，最坏被当空批次提交（游标不动、用户以为没消息）。正文改为进程级优先（exit 3→`auth-required`、4→`unavailable`、2/5→`degraded`），API 级 errorCode 作二次归类；成功判定 = exit 0 + 信封 `success: true`（stdout 非空不是充分条件）。
3. **`readOriginal: true` 说过头**：im 面无消息详情/搜索命令（skill 参考明示），`--msg-id` 只支持前后窗口重读、不保证精确取回锚点原文。评审建议改 `bounded`，但契约里 `readOriginal` 是 boolean（`plugin/dsh-quno/src/types.ts`、`contracts.ts` 的 `z.boolean()`），`bounded` 是 `replay.kind` 的值域、填了过不了 schema 校验——采纳其精神、换药方：报 `false`（§6.10「诚实报低合法」），窗口重读仅作运行时尽力手段，不构成声明能力。

## 评审漏掉、本次顺手修正

- §6.11 原表头「均支持 `--jq`」对 `im group search` 过 claim：CLI 的 `--jq` 支持清单只有 `im（message list、group recent）`，不含 `im group search`。

## 待验证项（登录态首验）

- 「群聊历史包含自己发出的消息」与消息项字段（senderOpenId、@ 结构）均无 yzj-cli 文档背书，登出态无法实测 → §6.11 标为登录态首验项，列为实现里程碑第一步；验不下来降级为单向感知（只判「等你回复」），并回滚 §18 偏差 #5 的阻塞解除表述。
- 原 note `2026-10-23-quno-sense-yzj.md` 中「群聊历史包含自己发出的消息」的既成事实表述，以本 note 与 §6.11 正文为准（旧 note 不改写）。

## 附带采纳

- `yzjProfile`（默认 `default`）进 configFields：yzj-cli 全局 `--profile <name>` 提供独立凭据/配置空间，对齐 §6.2「多账号 = 多实例」。
- 运行环境依赖补 node-shim 失效形态（`electron-shell-contract.md` 点名：shim 死路径会表现为「云之家未登录」），probe 需区分「CLI 不可用」与「未登录」，不误导排障方向。
