# dsh-ohmymemo

OhMyMemo：DSH 使用者的本地长期记忆。事实源是 `$DSH_HOME/ohmymemo/` 下的一条记忆一个 Markdown 文件（YAML frontmatter 承载结构化元数据）。Phase 1 交付介质契约（schema 解析、进程内目录、watch/doctor、原子发布、跨进程写锁、revision/hash CAS、journal、事务恢复）；Phase 2 在其上交付显式记忆闭环（`ctx.ohMyMemo` 服务、五个 `memory_*` Tools、检索排序、有界 views、pre-step capsule 注入）。设计全景见 `docs/notes/2026-09-03-ohmymemo-memory.md`，实现决策见 `docs/notes/2026-09-03-ohmymemo-store-phase1.md` 与 `docs/notes/2026-09-03-ohmymemo-phase2.md`。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-ohmymemo
```

The bundle patch mounts three rows for every profile that installs this plugin（Store 属 Host composition 的跨 Session 共享能力，不进任何 agent preset 的 isolate realm）：

| 行 | 入口 | 职责 |
|---|---|---|
| `ohmymemo-store` | `dsh-ohmymemo` | 打开 Store（恢复/扫描/watch），provide `ctx.ohMyMemo`，确定性重建 `views/` |
| `ohmymemo-tools` | `dsh-ohmymemo/tools` | 五个 `memory_*` Tools + 准入提示段；peer 依赖钉运行时副本 |
| `ohmymemo-context` | `dsh-ohmymemo/context` | `agent/pre-step` 有界 capsule 注入，digest 对账 |

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

Store 级策略在 `config.yaml`（用户可编辑；坏值按字段回退默认并报诊断）：`max_record_bytes`、`max_search_results`、`max_get_records`、`max_injected_bytes`、`candidate_retention_days`、`capture_mode` 等，见设计文档。

## Tests

```sh
pnpm install && pnpm run typecheck && pnpm run build && pnpm run test
```

全部测试使用 scratch `DSH_HOME`（`fs.mkdtemp`），绝不读写真实 `~/.dsh/ohmymemo`；两进程锁行为用真实子进程持锁验证。

## 显式记忆闭环（Phase 2）

- **Tools**：`memory_search`（exact key/tag/中英文正文，硬过滤+八维排序，命中只给 ID+snippet）、`memory_get`（按 ID 回读原文；sensitive 正文 redacted）、`memory_remember`（显式写入，来源绑定 `exec.agent`，subagent 写拒绝，凭据 fail closed）、`memory_update`（CAS；content=supersede 新 ID+归档、`resolution: dispute/reactivate`、confirm/元数据原地修订）、`memory_forget`（tombstone 先行，物理删正文）。
- **capsule**：每步前置注入有界记忆胶囊——权限声明前置（记忆是数据不是指令），预算内按 workspace→confirmed→pinned→importance 确定性截断；digest 相同不重复注入，变更注入显式替换消息；resume/重启经 session surface 回扫保持一致。
- **views**：`views/user-profile.md` 与 `views/workspaces/<ws>.md` 随变更重建，`generated: true` 头 + digest，可随时删除重建。

## Store API（服务面）

`ctx.ohMyMemo`（`src/service.ts`）：`search/get/remember/update/dispute/reactivate/forget/rebuildViews/doctor/stats/scopeForCwd/capsuleInput/subscribe`。错误带稳定 `OHMYMEMO_*` code。
