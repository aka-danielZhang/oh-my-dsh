# dsh-ohmymemo

OhMyMemo 的 Phase 1 Markdown Store：把 DSH 使用者的长期记忆落在 `$DSH_HOME/ohmymemo/` 下的一条记忆一个 Markdown 文件（YAML frontmatter 承载结构化元数据），并提供介质契约——schema 解析、进程内目录、watch/doctor、原子发布、跨进程写锁、revision/hash CAS、journal 与事务恢复。设计全景见 `docs/notes/2026-09-03-ohmymemo-memory.md`，Phase 1 实现决策见 `docs/notes/2026-09-03-ohmymemo-store-phase1.md`。

Phase 1 **刻意不接模型、不注册 Tool**：`ctx.ohMyMemo` 服务与五个 `memory_*` Tools 属 Phase 2 显式记忆闭环，直接构建在本包 `src/store.ts` 的 Store API 之上。挂载本插件后 Store 随 host 启动打开（扫描、恢复事务、watch），诊断经 logger 与 doctor 暴露。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-ohmymemo
```

The bundle patch mounts the `ohmymemo-store` row for every profile that installs this plugin（Store 属 Host composition 的跨 Session 共享能力，不进任何 agent preset 的 isolate realm）。

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
