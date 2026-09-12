# dsh-ohmymemo

OhMyMemo：DSH 使用者的本地长期记忆。事实源是 `$DSH_HOME/ohmymemo/` 下的一条记忆一个 Markdown 文件（YAML frontmatter 承载结构化元数据）。Phase 1 交付介质契约（schema 解析、进程内目录、watch/doctor、原子发布、跨进程写锁、revision/hash CAS、journal、事务恢复）；Phase 2 在其上交付显式记忆闭环（`ctx.ohMyMemo` 服务、写工具、检索排序、有界 views、pre-step capsule 注入）；当前版本另交付默认关闭的每日梦境记忆提取、Run 审计与取消、设置中的只读记忆空间，以及完整记忆生命周期（读时衰减、夜间确定性维护、`auto_consolidation` 门控的 Curator）。0.3.0 起交互面改为**索引优先**：读路径全面文件化（views 全量索引 + `read`/`grep` 按需读取正文），模型工具面收敛为三个写工具（`memory_search`/`memory_get` 退役，service 层方法保留供 UI/dream/内部使用），写入引发的 capsule 替换注入只在 turn 边界对账并豁免本会话自写。设计全景见 `docs/notes/2026-09-03-ohmymemo-memory.md`，实现决策见 `docs/notes/2026-09-03-ohmymemo-store-phase1.md`、`docs/notes/2026-09-03-ohmymemo-phase2.md`、`docs/notes/2026-09-04-ohmymemo-dream-memory-and-ui.md`、`docs/notes/2026-09-08-ohmymemo-lifecycle.md` 与 `docs/notes/2026-09-12-ohmymemo-index-first-interaction.md`。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-ohmymemo
```

Installing the package mounts five Host rows through the bundle patch and one Client row through `dsh.client`（Store 与 Manager 属 Host composition 的跨 Session 共享能力，不进任何 agent preset 的 isolate realm）：

| 行 | 入口 | 职责 |
|---|---|---|
| `ohmymemo-store` | `dsh-ohmymemo` | 打开 Store（恢复/扫描/watch），provide `ctx.ohMyMemo`，确定性重建 `views/` |
| `ohmymemo-tools` | `dsh-ohmymemo/tools` | 三个 `memory_*` 写工具（remember/update/forget）+ 索引用法与写入纪律提示段；peer 依赖钉运行时副本 |
| `ohmymemo-context` | `dsh-ohmymemo/context` | `agent/pre-step` 索引指针 capsule 注入；仅 turn 首步对账，本会话自写豁免 |
| `ohmymemo-manager` | `dsh-ohmymemo/manager` | 每日 one-shot 调度、受限提取 Agent、Run 状态/审计、Jobs 镜像与取消 |
| `ohmymemo-api` | `dsh-ohmymemo/api` | 六个 strict Typert Remote 操作的 Host descriptors |
| `memory`（Client） | `dsh-ohmymemo/client` | 设置页概览、梦境记忆控制和只读 Markdown 记忆空间 |

## 介质契约（Phase 1）

- **目录布局**：`scopes/user|workspaces/<ws>/{semantic,episodic/YYYY/MM,procedural}/mem_<ulid>.md`、`inbox/candidates/`、`archive/<scope>/<kind>/`、`tombstones/tomb_<ulid>.yaml`、`journal/YYYY/MM.jsonl`、`.state/transactions/`、`.state/locks/writer.lock/`、`views/`（Phase 2）、`.cache/`。
- **原子发布**：同目录临时文件（0600）→ 写入 → fsync → `rename` → 目录 fsync；发布前重新解析校验，拒绝写入不可解析内容。目录 0700。
- **跨进程写锁**：`.state/locks/writer.lock` 目录以原子 `mkdir` 抢占，持锁者记录 pid + 进程启动标识 + nonce；陈旧判定只认「进程不存在或启动标识不匹配」，绝不按时间回收；等待有界，超时抛 `OHMYMEMO_BUSY`——全库无 last-writer-wins 路径。
- **CAS**：更新必须携带 `ifRevision`（可加 `ifHash`）；锁内重读磁盘。外部手编以磁盘为准：journal 记 `external-edit-detected` 并刷新目录，并发 Tool 写按 CAS 失败拒绝，不覆盖。
- **journal**：`journal/YYYY/MM.jsonl` 每行一条元数据（id/revision/scope/key/hash/来源定位），永不携带正文。
- **事务恢复**：多文件 mutation（supersede/promote/forget）先落 `.state/transactions/` 标记再执行；重启恢复按每个 op 的磁盘 hash 判定 done/not-done/conflict——全 done 收尾、全未动回滚、部分完成则从磁盘可推导地前滚（唯一的内容写入总是 op1），hash 冲突保留标记交 doctor。forget 的 tombstone 先于正文删除落盘，是崩溃安全的读取屏障。
- **fail closed**：frontmatter 损坏、未知 schema 版本、重复 ID、single-key 多 active、超限大小的记录一律隔离出召回（保留原文件），doctor 给出可定位诊断；疑似凭据正文直接拒绝写入（`OHMYMEMO_SECRET_REFUSED`），敏感匹配器是防误写策略而非 DLP。
- **scope 解析**：workspace scope 以 realpath 关联稳定 `ws_<ulid>`（`scope.yaml`），已有 `dsh_workspace_id` 关联优先；路径无法规范化时不自动创建。

## Store API（Phase 2 的构建面）

`OhMyMemoStore`（`src/store.ts`）：`open/close`、`create/update/supersede/promote/forget`、`readRecord(id)`（按 ID 回读原始 Markdown）、`doctor()`、`subscribe(change)`、`catalog`。错误带稳定 `OHMYMEMO_*` code（`BUSY`/`CAS_REVISION`/`CAS_HASH`/`SINGLE_KEY_CONFLICT`/`TOMBSTONE_BARRIER`/`SECRET_REFUSED`…）。

## Config

cordis.yml 行配置（非法值 fail loud）：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `root` | 绝对路径 | `$DSH_HOME/ohmymemo` | Store 根覆盖（测试/开发用） |
| `watch` | boolean | `true` | 是否监听外部编辑（平台不支持时降级并报诊断） |
| `lockTimeoutMs` | int 100–120000 | `5000` | 写锁有界等待 |
| `watchDebounceMs` | int 10–2000 | `120` | watcher 去抖窗口 |

Store 级策略在 `config.yaml`（用户可编辑；坏值按字段回退默认并报诊断）：`max_record_bytes`、`max_search_results`、`max_get_records`、`max_injected_bytes`、`capsule_top_entries`（默认 5，capsule 每个作用域内联的 top-N 一行摘要条数）、`index_entry_summary_chars`（默认 120，索引行摘要宽度）、`index_max_entries`（默认 200，单个索引文件行数上限，超出截断并在脚注计数）、`candidate_retention_days`、`capture_mode`、`allow_inference_candidates`（默认 `false`）、`dream_schedule_local_time`（默认 `02:00`）与三个读时衰减水位线 `decay_horizon_days_semantic/procedural/episodic`（默认 365/180/90 天；非法值逐字段回退默认）。设置页以 config hash 做 CAS 更新这两个梦境记忆字段；若源文件包含未知或非法字段则拒绝整文件重写，避免 UI 丢失未来版本配置。

`ohmymemo-manager` 行配置拥有每次提取的硬上限：Session 数、消息数、transcript bytes、候选数、模型输出 tokens、运行时限、补跑窗口、浏览文件数与读取 bytes；非法值在组合加载时 fail loud。默认配置见 `src/manager.ts` 的 `Config`。

## Tests

```sh
pnpm install && pnpm run typecheck && pnpm run build && pnpm run test
```

全部测试使用 scratch `DSH_HOME`（`fs.mkdtemp`），绝不读写真实 `~/.dsh/ohmymemo`；两进程锁行为用真实子进程持锁验证。

## 显式记忆闭环（Phase 2，交互面 0.3.0 索引优先）

- **读路径 = 文件**（0.3.0）：capsule 只注入「索引指针 + top-N 一行摘要」；正文由 Agent 用 `read`/`grep`/`glob` 按需自取。`memory_search`/`memory_get` 从模型工具面退役——每多一个工具参数就是一类新的 schema 失败面（0.2.3 `score` 漏声明、中文 tag 硬失败均属此类），而读文件本就是 Agent 的自然动线。service 层 `search/get` 方法保留（dream/curator/UI 内部使用），sensitive 正文的 redact 语义不变。
- **全量索引**：`views/index-user.md` 与 `views/index-workspace-<ws>.md` 收录全部 `active + normal + 未 quarantine + validity window 内` 的记忆（**不要求 pinned**），按 decayWeight 降序、行数上限 `index_max_entries`（超出脚注计数）；每行格式 `[id] (kind · key · importance X) 摘要 → scopes/…/mem_x.md`，与 capsule 的 top 行共用 `composeIndexLine`。人读视图（`user-profile.md` 等）保持 pinned 语义不变，浏览器记忆树不受影响（其视图清单是固定 spec 列表）。
- **Tools（三个写工具）**：`memory_remember`（显式写入，来源绑定 `exec.agent`，subagent 写拒绝，凭据 fail closed；tags 尽力规范化——无法规范化的字符（如中文）丢弃而非报错，全空等同未传；可选 `validUntil`——仅事实本身有期限时设置，裸日期展开为当日 UTC 结尾）、`memory_update`（`ifRevision` 必填、**从记忆文件 frontmatter 读取**；`ifHash` 选填——显式携带时才校验 hash，Store 校验前以磁盘现状重读，外部手编以磁盘为准；content=supersede 新 ID+归档、`resolution: dispute/reactivate`、confirm/元数据原地修订）、`memory_forget`（tombstone 先行，物理删正文）。
- **capsule**：每 turn 首步前置注入索引指针——权限声明前置（记忆是数据不是指令）、打印 Store 根路径、每作用域一行「索引文件路径（全量 N 条）」+ top `capsule_top_entries` 行摘要；digest 相同不重复注入，变更注入显式替换消息。**震荡消除**：注入决策只在 turn 首步做（turn 中途的 digest 变化一律推迟到下一 turn 首步）；写工具成功后经 service 把「本会话写入产生的新 digest」记入 per-session 有界豁免集，对账命中豁免则只更新缓存、不注入（跨会话/外部写入仍替换注入）。fail-open 语义不变：读面/存储异常跳过本次胶囊并告警。
- **views**：人读视图与 Agent 索引随变更重建，`generated: true` 头 + digest，可随时删除重建；重建走「掩去 generated_at 的等值比对」no-op 跳过，索引文件同样稳定（config-only 重建不改字节）。
- **读取屏障与 CAS**：tombstone 一旦落盘即按 `memory_ids` 屏蔽 service search/get/capsule/浏览器读取——屏障语义自 0.3.0 起为「索引/capsule/UI 不召回」，`grep scopes/` 理论上可撞见延迟删除的残留正文（窗口很短，与「用户可直接看文件」语义一致）；记录修订的 CAS 见上（hash 降为选填后，revision 仲裁以锁内磁盘重读为准）；写锁内 reconciliation 同步重读 `config.yaml`，跨进程陈旧策略不会被执行。
- **事务与退出加固**：事务 marker 是不可信本地输入——严格 schema/ID-文件名绑定/store 内路径 allowlist/symlink 拒绝，逃逸 marker 只会被隔离报告；全部物理 op 在 marker 落盘前预检为零写入状态，`before_hash` 竞态以零持久写入中止，不再留下永久冲突标记。Store `close()` 不再强制释放写锁/维护租约（在飞回调自行释放，进程中途退出由 pid+启动标识陈旧判定兜底）；Manager 收敛为单一 drain-first teardown（先中止活动 Run、等队列排空再关 domain），`startRun` 在执行期复查接受状态，排队中的启动不会逃逸 drain。

## Store API（服务面）

`ctx.ohMyMemo`（`src/service.ts`）：`search/get/remember/update/dispute/reactivate/forget/rebuildViews/doctor/stats/scopeForCwd/capsuleInput/curatorCatalog/runLifecycleMaintenance/refreshEvidence/mergeMemories/subscribe`。错误带稳定 `OHMYMEMO_*` code。

## 记忆生命周期（2026-09-08）

核心原则：**capsule 里的位置是挣来的，不是永久的；Markdown 库是便宜的；归档 ≠ 删除**。衰减读时算（零写盘），归档写时批（夜间一次）；LLM 只做语义判断，expire 由代码规则主裁；confirmed 与 sensitive 永不衰减、永不过期；views（人看）全量，capsule（模型看）衰减后。决策记录见 `docs/notes/2026-09-08-ohmymemo-lifecycle.md`。

- **读时衰减**（capsule 准入，纯函数）：`weight = importance × decay(age, H)`，`age = now − (last_evidenced_at ?? created_at)`（刻意不用 `updated_at`——元数据修订不是「事实仍真」的证据）。曲线：age ≤ H/2 全额，线性降至 0.2（age = H），线性降至 0（age = 2H）；weight = 0 直接出 capsule（仍在库、仍可 `memory_search` 命中）。`valid_until` 已过 / `valid_from` 未到的检查进 `isCoreViewEntry(entry, now)`——capsule 与 views 共用同一闸门，翻转即刻生效（digest 变化触发下一回合替换注入）。recency 衰减只进 capsule 排序，不进 views。
- **夜间确定性维护段**（无 LLM）：dream run 提取段之后、结算之前插入——① `candidate_expires_at` 已过的候选确定性删除（journal `candidate-expired`）；② `valid_until` 已过或未 confirmed 且 age ≥ 2H 的 active 记录归档为 `status: expired`（`archive/` + journal `memory-expired`，事务化 write-derived 移动、崩溃可前滚）。归档**绝不走 tombstone**：墓碑是防复活屏障，过期必须允许用户日后再提及时重新入库（`hasMemoryKey` 与候选查重均已收窄到 active/disputed，旧归档不挡新入库）；`memory_get` 按 id 仍可读归档条目。维护段在无新证据的 Run 也执行；失败记入审计 detail，不毒化提取结果。
- **Curator**（`auto_consolidation` 门控，默认关）：同一维护 Agent 的第二个 followup turn（不新建 Session）。输入 = active 目录元数据 NDJSON（active、normal、未 confirmed；按 weight 升序、最老的先看，截断至 `curatorMaxEntries`）+ 与提取器同一证据窗口。输出 refresh/merge/keep 提议，全部经代码护栏裁决：refresh 必须引用证据窗口内的 `sessionId+seq+quote` 精确子串；merge 双方必须同 scope+kind 且在目录中（confirmed/sensitive 不在目录、不可触碰）；merge 走 supersede 机器（absorbed 归档 + survivor `supersedes` 回链，journal `memory-merged`）；refresh 为就地修订（revision++、刷 `last_evidenced_at`、来源追加，journal `memory-refreshed`）。不确定一律 keep；Curator 失败 = 部分成功，记审计 detail，不计入提取器死信连胜。提取 prompt 同步支持可选 `valid_until`（仅时间性事实设置）并透传入库。
- **审计后兼容**：Run summary/audit 新增 `expiredMemories`/`expiredCandidates`/`curatorRefreshed`/`curatorMerged`/`curatorRejected` 均带 `.default()`，旧持久化记录不挡 boot。

## 梦境记忆与设置

- **调度**：默认关闭；开启后按 Host 本地时区每天在 `dream_schedule_local_time` 运行（设置页可直接修改），使用 one-shot timer 在每次边界重算下一次时间，覆盖 DST 与休眠漂移；36 小时默认补跑窗口只补最近一个漏过的边界。提取模型与推理强度可在设置页选择（`dream_model_provider`/`dream_model`/`dream_effort`，留空跟随默认模型；强度以路由声明的档位为准）。
- **单飞与取消**：进程内只允许一个 Run，跨进程另持有 `.state/locks/dream-memory.lock`；持锁后重新打开 manager storage domain，并把 interrupted-run 恢复、边界复核、认领、提取、审计与 cursor/state 提交包在同一次 lease 中。活动 Run 镜像到 Jobs 供状态和取消，不把 Jobs 当持久事实源。设置页提供“立即整理”与活动 Run 取消。
- **来源**：只读取非 subagent、非维护 Session 中 `surfaceOp === 'append'` 且 `source.kind === 'user'` 的 direct-human `user/message`；排除 fork seed、replacement 节点、疑似凭据和维护 Session。每个 Session 使用可取消 observation，增量游标与 Run 审计持久化在 `dsh_ohmymemo_manager` storage domain，不进入 Markdown 浏览器。
- **提取**：专用 root Agent 无可见 Tools，执行 guard 拒绝全部工具调用；维护会话 cwd 恒为中性 home 目录（不指向证据 workspace——那会把该仓 AGENTS.md 拉进每次 prompt 并把维护会话归组到该 workspace，本插件会话在 UI 中呈「未分组」）。输出必须整体通过 strict JSON、精确证据 quote 子串（≤200 字符）和 secret 检查，任一非法 item 使整轮失败且不推进游标；`agentMaxTokens`（默认 16384）需同时容纳最坏 JSON 输出与推理模型的思考消耗。**截断抢救**：turn 以 `max-tokens` 结束时，memories 数组的完整前缀仍逐项通过同样的 grounding 校验，任一通过即按 `truncated` 审计入账并推进游标——截断豁免缺失的条目，绝不豁免非法的条目。**死信**：同一证据窗口（promptHash 相同）连续 `deadLetterThreshold`（默认 3）次确定性输出失败后，游标强制推进、审计标注 dead-lettered，打破「每晚重试同一毒批」循环；超时/取消/供应商错误不计入。设置页的模型/档位选择器在每次写入提交后重取 models 快照（此前已设档位会一直显示「跟随默认」，且 `min(1)` 校验使空串「清除覆盖」被拒）。产品决策（2026-09-05）：自动结果**直接写为正式记忆**——`status: active`、`privacy: normal`、`pinned: true`，立即可被 search/capsule 召回，不经候选区、无需手动确认；证据落地、append-origin 过滤、secret fail-closed、同 key 去重与 tombstone 屏障仍是护栏。游标按「seq 连续已拟合前缀」推进：时间乱序导致低 seq 证据未进 prompt 时该 Session 游标原地不动，下次 Run 重新审视（同 key 去重保证幂等）；取消若赶在提交前到达，Run 以 `cancelled` 结算且不推进游标与调度边界。
- **记忆空间**：设置顶级菜单“记忆”内部提供“概览/记忆空间”。浏览器只索引 allowlist 中的 canonical/candidate/archive/generated-view Markdown，Host 端解析 frontmatter、清理 generated header，并在敏感记录上只返回 redacted 正文；路径规范化、generation、symlink、文件类型和大小均 fail closed。概念指南（范围/状态/视图/目录地图，含配图）见 `docs/ohmymemo-memory-space.md`。设置页在挂载期间轮询概览，初载与轮询均为 single-flight，慢 RPC 不会造成请求堆积或状态卡死。

## 运行时读取纪律（2026-09-05 生产事故修复）

插件**永不 duck-type 读取 `agent.session` 的内部字段**（`.events` / `.surface` 等）——它不是公开契约：野外部场（resume 后的会话视图）曾缺失 `events`，导致每个回合在 `agent/pre-step` 崩溃（`Cannot read properties of undefined (reading '<seq>')`），并连带维护 Agent 路径的 `events.at(-1)` 崩溃。事件一律经 **`sessionQuery` 受支持快照**读取：

- capsule 对账：`readSurface(sessionId)`（每 turn 首步扫描一次——0.3.0 起注入决策只发生在 turn 首步，turn 内不再扫描也不再对账；大日志会话的整日志折叠每 turn 至多一次）。监听器整体 fail-open：读面/存储异常时跳过本次胶囊并告警，**记忆注入永远不允许弄死回合**。
- 维护 Agent 事件窗口：`observeSession(id, { projectionMode: 'none' })` 租约（`header`/`events`/`[Symbol.dispose]`），followup 前后各一次。

## Model Experience

- **Model-visible input**：普通 Agent 继续只收到 Phase 2 的有界 context capsule。梦境维护 Agent 的 system/user prompt 持久化在独立 `ohmymemo-maintenance-*` Session，并只包含本轮通过过滤与 bytes 上限的 direct-human 证据；发送给模型的事件元数据只含 `workspaceAvailable`，不含绝对 cwd。
- **Model calls**：关闭梦境记忆时零新增调用；开启后每个有来源消息的 scheduled/manual Run 最多一次维护 Agent 调用（`auto_consolidation` 开启时同一 Agent 追加第二次 curator turn），无来源时不调用模型。
- **Token bounds**：每次 Run 受 `maxTranscriptBytes`、`maxMemoriesPerRun`、`agentMaxTokens` 与 `runTimeoutMs` 硬限制；实际 provider usage 随 maintenance Session 保留，本阶段未实现日/月费用预算。
- **KV cache**：维护 Run 使用独立 root Agent Session，不承诺与普通会话共享 prompt prefix 或 KV cache。

## Known Limitations and Deferred Work

- 当前 UI 是只读文件浏览器，不提供 candidate 确认/拒绝、冲突裁决、来源跳转或记忆编辑/忘记；这些仍属于后续治理 UI。
- 生命周期水位线默认值（365/180/90 天）待实战校准，观察期建议只看 audit 不动手；`auto_consolidation` 维持默认 `false`，Curator 先以手动 Run + audit 观察若干轮再考虑默认开启。
- 当前 DSH Session Query 没有同时支持 direct-user provenance 与分页/有界读取的接口；`listSessions` 和每个 selected Session 的 observation 会物化完整结果，本插件的 Session/消息/transcript 上限只约束后续处理与模型输入，不是物理 I/O 上限。
- 维护 prompt 按 DSH 的 model-visible 日志要求持久化在普通 root Session；平台尚无 maintenance Session 隐藏/删除契约，因此 `ohmymemo-maintenance-*` 可能出现在普通历史并按 Session Persistence 策略保留。
- 检索与记忆文件浏览目录是有界进程内扫描；达到实测规模阈值后再评估 FTS 或可删除的 embedding cache。
