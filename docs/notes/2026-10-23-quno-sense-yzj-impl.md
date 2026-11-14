# 2026-10-23 dsh-quno-sense-yzj 实现落地

## 范围

按 `docs/quno-bot-design.md` §6.10（Sense 最小面）与 §6.11（云之家群聊 Sense 设计）实现首个「消息」来源 Sense。

## 落点

- `plugin/dsh-quno-sense-yzj`（0.1.0，host-only；`cordis.patch.yml` 一行 `quno-sense-yzj`，`plugin:new` 生成骨架）。
- 声明：类型 `quno/yzj-im`、事件 `im.message.created` / schema `quno.yzj-im.message/v1`、poll 默认 600s / 最小 60s、`maxEventsPerCheck 200`、reliability 五项（`cursor` / `bounded` / `sampled` / `partial` / `readOriginal: false`）。
- 只读命令面：`contact user get`（探活）、`im message list`（基线 + 增量）；不发送、不标已读、v1 不采私聊。

## 与设计一致的实现点

- 首轮 `--type newest --limit 20` 只钉基线游标、不回放历史；增量 `--msg-id <cursor> --type new`，每页 20 条（CLI 上限）、每群最多 5 页，翻到 `data.more` 为假或达配额。
- 事件身份 `yzj:<groupId>:<msgId>`，`revision` 同为 `msgId`；checkpoint 为每群 `{cursor, pinnedAt, seen[], syncedAt}` 的 JSON 文档，游标只在批次 ACK 后推进。
- 多群按 checkpoint 最旧优先轮询；本轮未轮到或未翻完的群停在各自已 ACK 游标顺延下一轮，不跳数据。
- 健康分类两层：进程级退出码优先（3→`auth-required`、4→`unavailable`、2/5→`degraded`），API 级 `errorCode`（10000400/93001/43001）二次归类；成功判定为 exit 0 且信封 `success: true`。

## 实现偏差（4 条）

1. **probe 只判「CLI 能否执行」，不把未登录算作 probe 失败**。若登出态就 probe 失败，实例会进 `failed` 并耗尽重试，登录后必须手工重建；现在登出态实例照常 `running`、健康报 `auth-required`、`nextRetryAt` 为空，登录后下一轮自动回 `healthy`。CLI 缺失仍 probe 失败（`lifecycle: failed` + `start-failed`），两类错误由此分开。
2. **增量页方向未文档化，实现补了自我保护**。仅有时间戳能证明升序时才续页；判不出方向（缺时间戳）时游标只推进到本页**最旧**一条——宁可重复（去重环 + eventKey 幂等兜底），绝不跳过——并显式报 gap；确认是倒序页时停在本页最新一条、剩余顺延下一轮并报 gap。设计原文只写「翻页至 more 为假或达配额」，未覆盖方向未知。
3. **`type old` 回翻未实现**。`replay: bounded` 仍按来源能力声明（§6.11 口径）；采集器当前只前向，未来做重读时再用。
4. **`mentionedMe` 恒为 `null`**。@ 结构无 CLI 文档背书，归入登录态首验项。

## 验证

- 单测 16 项全过：声明字段、配置校验、信封解析、字段映射（`msgId`/`fromOpenId`/`msgType`/`sendTime`）、方向判定、基线钉游标、单页/多页增量、倒序页 gap、方向未知保守推进、去重环、配额顺延、空群首消息、两层健康分类。
- `pnpm run typecheck` / `build` 通过（产物 `lib/index.js` 23.7 kB，零 `@deepseek-ai/*` 运行时导入）。
- **真实 CLI**（本机 `yzj-cli 0.1.5`，登出态）：跑一轮 `runCheck` → `auth-required` / `auth-credentials_missing` / detail 带 `auth login --device`，**零批次提交**（游标不动、不会把登出漏成空批次）。
- **真实服务**（`QunoSensesService` + 真 SQLite store）：注册 → 建实例 → `running` + `auth-required`；把 `yzj-cli` 从 PATH 摘掉后 → `lifecycle: failed` + `unavailable` + `errorCode: start-failed`。
- **scratch profile**（`DSH_HOME=$(mktemp -d)` + `dsh plugin --profile web add` + `dsh web`）：boot 后 `sense_types` 表出现 `quno/yzj-im | 1 | 0.1.0`，说明声明通过了真实 zod 契约与注册路径。
- **未验证**：登录态下的消息项字段与「群聊历史包含自己发出的消息」——需用户执行 `yzj-cli auth login` 后按 §6.11「登录态首验」复核。

## 未决

- **`dsh.desktop.ship` 未标**。要随桌面发货，需在包内加该字段（prepare / CI / 首启事务自动扫），并把本插件加进 `docs/plugins-catalog.md` 的随包清单与首启安装；本次未动，留给发版决定。
- **登录态首验**：验不下来则按 §6.11 降级为单向感知（只判「等你回复」），并回滚 §18 偏差 #5 的阻塞解除表述。
