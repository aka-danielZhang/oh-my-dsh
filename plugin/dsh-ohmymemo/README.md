# dsh-ohmymemo

OhMyMemo：DSH 使用者的本地长期记忆。事实源是 `$DSH_HOME/ohmymemo/` 下的一条记忆一个 Markdown 文件（YAML frontmatter 承载结构化元数据）。Phase 1 交付介质契约（schema 解析、进程内目录、watch/doctor、原子发布、跨进程写锁、revision/hash CAS、journal、事务恢复）；Phase 2 在其上交付显式记忆闭环（`ctx.ohMyMemo` 服务、五个 `memory_*` Tools、检索排序、有界 views、pre-step capsule 注入）；当前版本另交付默认关闭的每日梦境记忆提取、Run 审计与取消，以及设置中的只读记忆空间。设计全景见 `docs/notes/2026-09-03-ohmymemo-memory.md`，实现决策见 `docs/notes/2026-09-03-ohmymemo-store-phase1.md`、`docs/notes/2026-09-03-ohmymemo-phase2.md` 与 `docs/notes/2026-09-04-ohmymemo-dream-memory-and-ui.md`。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-ohmymemo
```

Installing the package mounts five Host rows through the bundle patch and one Client row through `dsh.client`（Store 与 Manager 属 Host composition 的跨 Session 共享能力，不进任何 agent preset 的 isolate realm）：

| 行 | 入口 | 职责 |
|---|---|---|
| `ohmymemo-store` | `dsh-ohmymemo` | 打开 Store（恢复/扫描/watch），provide `ctx.ohMyMemo`，确定性重建 `views/` |
| `ohmymemo-tools` | `dsh-ohmymemo/tools` | 五个 `memory_*` Tools + 准入提示段；peer 依赖钉运行时副本 |
| `ohmymemo-context` | `dsh-ohmymemo/context` | `agent/pre-step` 有界 capsule 注入，digest 对账 |
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

Store 级策略在 `config.yaml`（用户可编辑；坏值按字段回退默认并报诊断）：`max_record_bytes`、`max_search_results`、`max_get_records`、`max_injected_bytes`、`candidate_retention_days`、`capture_mode`、`allow_inference_candidates`（默认 `false`）与 `dream_schedule_local_time`（默认 `02:00`），见设计文档。设置页以 config hash 做 CAS 更新这两个梦境记忆字段；若源文件包含未知或非法字段则拒绝整文件重写，避免 UI 丢失未来版本配置。

`ohmymemo-manager` 行配置拥有每次提取的硬上限：Session 数、消息数、transcript bytes、候选数、模型输出 tokens、运行时限、补跑窗口、浏览文件数与读取 bytes；非法值在组合加载时 fail loud。默认配置见 `src/manager.ts` 的 `Config`。

## Tests

```sh
pnpm install && pnpm run typecheck && pnpm run build && pnpm run test
```

全部测试使用 scratch `DSH_HOME`（`fs.mkdtemp`），绝不读写真实 `~/.dsh/ohmymemo`；两进程锁行为用真实子进程持锁验证。

## 显式记忆闭环（Phase 2）

- **Tools**：`memory_search`（exact key/tag/中英文正文，硬过滤+八维排序，命中只给 ID+snippet）、`memory_get`（按 ID 回读原文与 `hash`；sensitive 正文与 `quote_preview` 均 redacted，定位符 `quote_hash/session_id` 保留）、`memory_remember`（显式写入，来源绑定 `exec.agent`，subagent 写拒绝，凭据 fail closed）、`memory_update`（revision+hash 双重 CAS；content=supersede 新 ID+归档、`resolution: dispute/reactivate`、confirm/元数据原地修订）、`memory_forget`（tombstone 先行，物理删正文）。
- **capsule**：每步前置注入有界记忆胶囊——权限声明前置（记忆是数据不是指令），预算内按 workspace→confirmed→pinned→importance 确定性截断；digest 相同不重复注入，变更注入显式替换消息；resume/重启经 session surface 回扫保持一致。
- **views**：`views/user-profile.md` 与 `views/workspaces/<ws>.md` 随变更重建，`generated: true` 头 + digest，可随时删除重建。
- **读取屏障与 CAS**：tombstone 一旦落盘即按 `memory_ids` 屏蔽 search/get/capsule/浏览器读取（延迟删除的残留正文不可召回，doctor 仍可见以便清理）；记录修订强制 revision+hash 双 CAS，同 revision 的手工编辑不会被陈旧调用覆盖；写锁内 reconciliation 同步重读 `config.yaml`，跨进程陈旧策略不会被执行。
- **事务与退出加固**：事务 marker 是不可信本地输入——严格 schema/ID-文件名绑定/store 内路径 allowlist/symlink 拒绝，逃逸 marker 只会被隔离报告；全部物理 op 在 marker 落盘前预检为零写入状态，`before_hash` 竞态以零持久写入中止，不再留下永久冲突标记。Store `close()` 不再强制释放写锁/维护租约（在飞回调自行释放，进程中途退出由 pid+启动标识陈旧判定兜底）；Manager 收敛为单一 drain-first teardown（先中止活动 Run、等队列排空再关 domain），`startRun` 在执行期复查接受状态，排队中的启动不会逃逸 drain。

## Store API（服务面）

`ctx.ohMyMemo`（`src/service.ts`）：`search/get/remember/update/dispute/reactivate/forget/rebuildViews/doctor/stats/scopeForCwd/capsuleInput/subscribe`。错误带稳定 `OHMYMEMO_*` code。

## 梦境记忆与设置

- **调度**：默认关闭；开启后按 Host 本地时区每天在 `dream_schedule_local_time` 运行（设置页可直接修改），使用 one-shot timer 在每次边界重算下一次时间，覆盖 DST 与休眠漂移；36 小时默认补跑窗口只补最近一个漏过的边界。提取模型与推理强度可在设置页选择（`dream_model_provider`/`dream_model`/`dream_effort`，留空跟随默认模型；强度以路由声明的档位为准）。
- **单飞与取消**：进程内只允许一个 Run，跨进程另持有 `.state/locks/dream-memory.lock`；持锁后重新打开 manager storage domain，并把 interrupted-run 恢复、边界复核、认领、提取、审计与 cursor/state 提交包在同一次 lease 中。活动 Run 镜像到 Jobs 供状态和取消，不把 Jobs 当持久事实源。设置页提供“立即整理”与活动 Run 取消。
- **来源**：只读取非 subagent、非维护 Session 中 `surfaceOp === 'append'` 且 `source.kind === 'user'` 的 direct-human `user/message`；排除 fork seed、replacement 节点、疑似凭据和维护 Session。每个 Session 使用可取消 observation，增量游标与 Run 审计持久化在 `dsh_ohmymemo_manager` storage domain，不进入 Markdown 浏览器。
- **提取**：专用 root Agent 无可见 Tools，执行 guard 拒绝全部工具调用；输出必须整体通过 strict JSON、精确证据 quote 子串和 secret 检查，任一非法 item 使整轮失败且不推进游标。产品决策（2026-09-05）：自动结果**直接写为正式记忆**——`status: active`、`privacy: normal`、`pinned: true`，立即可被 search/capsule 召回，不经候选区、无需手动确认；证据落地、append-origin 过滤、secret fail-closed、同 key 去重与 tombstone 屏障仍是护栏。游标按「seq 连续已拟合前缀」推进：时间乱序导致低 seq 证据未进 prompt 时该 Session 游标原地不动，下次 Run 重新审视（同 key 去重保证幂等）；取消若赶在提交前到达，Run 以 `cancelled` 结算且不推进游标与调度边界。
- **记忆空间**：设置顶级菜单“记忆”内部提供“概览/记忆空间”。浏览器只索引 allowlist 中的 canonical/candidate/archive/generated-view Markdown，Host 端解析 frontmatter、清理 generated header，并在敏感记录上只返回 redacted 正文；路径规范化、generation、symlink、文件类型和大小均 fail closed。设置页在挂载期间轮询概览，初载与轮询均为 single-flight，慢 RPC 不会造成请求堆积或状态卡死。

## Model Experience

- **Model-visible input**：普通 Agent 继续只收到 Phase 2 的有界 context capsule。梦境维护 Agent 的 system/user prompt 持久化在独立 `ohmymemo-maintenance-*` Session，并只包含本轮通过过滤与 bytes 上限的 direct-human 证据；发送给模型的事件元数据只含 `workspaceAvailable`，不含绝对 cwd。
- **Model calls**：关闭梦境记忆时零新增调用；开启后每个有来源消息的 scheduled/manual Run 最多一次维护 Agent 调用，无来源时不调用模型。
- **Token bounds**：每次 Run 受 `maxTranscriptBytes`、`maxMemoriesPerRun`、`agentMaxTokens` 与 `runTimeoutMs` 硬限制；实际 provider usage 随 maintenance Session 保留，本阶段未实现日/月费用预算。
- **KV cache**：维护 Run 使用独立 root Agent Session，不承诺与普通会话共享 prompt prefix 或 KV cache。

## Known Limitations and Deferred Work

- 当前 UI 是只读文件浏览器，不提供 candidate 确认/拒绝、冲突裁决、来源跳转或记忆编辑/忘记；这些仍属于后续治理 UI。
- 自动提取只产生 evidence-grounded sensitive candidate；语义合并、自动 consolidation、candidate TTL 清理和 usage/cost 日月预算尚未实现。进入普通召回前仍需显式确认并把 privacy 改为 normal。
- 当前 DSH Session Query 没有同时支持 direct-user provenance 与分页/有界读取的接口；`listSessions` 和每个 selected Session 的 observation 会物化完整结果，本插件的 Session/消息/transcript 上限只约束后续处理与模型输入，不是物理 I/O 上限。
- 维护 prompt 按 DSH 的 model-visible 日志要求持久化在普通 root Session；平台尚无 maintenance Session 隐藏/删除契约，因此 `ohmymemo-maintenance-*` 可能出现在普通历史并按 Session Persistence 策略保留。
- 检索与记忆文件浏览目录是有界进程内扫描；达到实测规模阈值后再评估 FTS 或可删除的 embedding cache。
