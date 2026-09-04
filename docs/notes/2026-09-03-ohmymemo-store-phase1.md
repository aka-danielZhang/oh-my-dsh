# OhMyMemo Phase 1：Markdown Store 介质契约实现

日期：2026-09-03

状态：已实现（`plugin/dsh-ohmymemo` 0.1.0）；Phase 2 显式记忆闭环未开始

设计输入：`docs/notes/2026-09-03-ohmymemo-memory.md`（Phase 1 范围＝该文档「实施阶段 · Phase 1」）

## 决策摘要

按已确认设计实现 OhMyMemo 的 Phase 1：经仓库脚手架（`pnpm run plugin:new dsh-ohmymemo --face host --id ohmymemo-store`）创建插件，交付 Markdown Store 的完整介质契约——manifest/config、记录 schema 解析/序列化、扫描与进程内目录、watch/doctor、原子写、Store 级跨进程写锁、revision/hash CAS、journal、事务恢复、user/workspace scope 解析。不注册 Tool、不接模型、不发布 `ctx.ohMyMemo` 服务（设计把它们划入 Phase 2），apply 只负责打开 Store（恢复→扫描→watch）并在卸载时关闭。

## 结构

```text
plugin/dsh-ohmymemo/src/
  ids.ts        ULID（Crockford base32，同毫秒单调递增）与 mem_/ws_/tomb_/txn_/oms_ 前缀
  types.ts      领域类型（记录/tombstone/manifest/scope/config/诊断/目录项）
  paths.ts      布局推导 + parseLocation 位置分类（扫描与 watcher 的路由唯一事实源）
  schema.ts     frontmatter 拆分/合成、记录校验（逐字段 issue）、key/tag 规范化、
                secret 检测、tombstone/manifest/scope/config 解析与确定性序列化
  atomic.ts     原子发布（临时文件+fsync+rename+目录 fsync）、0600/0700、hash 助手
  lock.ts       WriterLock：mkdir 原子抢占 + pid/启动标识陈旧判定 + 有界等待
  journal.ts    元数据 JSONL 追加（journal/YYYY/MM.jsonl）
  txn.ts        事务标记 + 按 hash 的 done/not-done/conflict 恢复
  catalog.ts    进程内目录（路径键控 + 每 id 代表项 + fail closed 隔离标记）
  scan.ts       全量扫描 / 单文件解析 / 子树增量刷新（watcher 复用）
  doctor.ts     权限、悬空引用、tombstone 残留、未完成事务、锁态、watch 降级
  watch.ts      recursive fs.watch + 去抖 + 相关路径过滤；平台拒绝时降级报诊断
  scope.ts      user 常量 + workspace realpath→ws_<ulid> 关联（dsh id 优先）
  store.ts      编排：open/恢复/扫描/watch + create/update/supersede/promote/forget
  config.ts     插件行配置校验（手写，非法值 fail loud——沿用蓝本纪律）
  index.ts      host apply：打开 Store、doctor 错误进 logger；effect 全可逆
```

## 关键实现决策与理由

1. **YAML 解析用 `yaml` npm 包（唯一 runtime 依赖）**。frontmatter 是用户可手编的一等契约，手写子集解析器在引号/注释/多行边界上必错；`yaml` 是纯 JS、带类型。依赖走普通 `dependencies`（`dsh plugin add` 走 pnpm 安装会物化 node_modules），本包非 desktop-owned，不需要 zod 式内联。构建产物零 `@deepseek-ai/*` 运行时导入（host 蓝本纪律不变）。

2. **事务模型：内容写入永远 op1 + 磁盘可推导前滚**。事务标记不携带正文（journal/标记都不能成为第二份 canonical）。每类多文件事务恰有一个「内容来自内存」的 write，且排第一：崩溃后若它未落盘且无任何 op 完成 → 整体回滚（删标记）；若已完成 → 其余 op（write-derived 从源文件确定性变换、delete/move/journal 均可从磁盘推导）逐个前滚。恢复只比磁盘 hash，绝不按时间猜测；hash 冲突保留标记交 doctor。journal op 以「精确行去重」保证 exactly-once 追加。

3. **目录以路径键控，重复 ID 才可能被看见**。第一版 catalog 用 `Map<id, entry>`，upsert 会静默吞掉同 ID 的第二份拷贝——重复 ID 检测形同虚设（测试逼出）。改为 `Map<relPath, entry>` 为事实源 + 派生 `id → 代表项`（最低路径），重复 ID 时所有拷贝隔离，single-key 多 active 同样 fail closed 隔离并出诊断；隔离项保留在目录里供 doctor 展示，但不进 activeEntries。

4. **外部手编：磁盘赢，Tool 写让路**。锁内所有 mutation 先重读目标文件；磁盘 hash ≠ 目录 hash → journal `external-edit-detected`、刷新目录，然后照常做 CAS——并发 Tool 写因 revision/hash 不匹配失败，绝不覆盖手编（设计验收场景「手工编辑」的直接实现）。watcher 侧自带 pendingInternal 抑制表：自己的原子发布（rename）不会被误记为外部编辑，抑制项按 hash 匹配消费、10s TTL。

5. **锁的陈旧判定只认身份，不认时间**。持锁者写 pid + 启动标识（Linux `/proc/<pid>/stat` 第 22 字段；mac `ps -p <pid> -o lstart=`；其他平台仅 liveness）+ nonce。回收必须证明「pid 不存在或启动标识不匹配」；steal 用原子 rename 把陈旧目录移走再 mkdir，两个进程同时 steal 由 rename 的原子性裁决。等待有界（默认 5s）超时 `OHMYMEMO_BUSY`。实测踩坑两则都进了测试：持锁子进程在打印信号后若不挂定时器会因事件_loop 清空而退出（锁「神秘」可窃取——holder 必须显式保活）；liveness 探测带 300ms 缓存，kill 后立刻断言 stale 会拿到缓存 alive（生产无碍，acquire 自带重试窗口）。

6. **诊断按路径键控、doctor 实时聚合**。增量刷新只重扫受影响子树，若诊断表不按路径替换就会把其他文件的旧诊断冲掉（实现中途发现）。现在 store 维护 `Map<relPath, Diagnostic[]>`，refresh 原地替换该路径条目（空即清除），doctor 聚合 开启期诊断 + 文件诊断 + catalog 不变量诊断 + 实时结构检查。

7. **config 双层**：插件行配置（`root/watch/lockTimeoutMs/watchDebounceMs`，非法 fail loud）与 Store 级 `config.yaml`（用户可编辑策略；损坏按字段回退默认并出 warning 诊断——手编坏文件不能让 Store 打不开）。manifest 缺失在锁内创建（store_id 用独立 `oms_<ulid>`，不复用遥测身份）；`format_version` 高于支持版本 fail loud 拒绝降级读取。

8. **episodic 归档拍平**：canonical 区 `episodic/YYYY/MM/` 嵌套由 `created_at` 推导并在扫描时校验；archive 区拍平到 `archive/<scope>/episodic/`（归档是历史状态，不再按月分桶，恢复/审计路径更短）。

9. **测试即验收**：80 个用例覆盖设计的验收面——基础持久化（重启后新 Store 实例重扫一致）、修订/替代（supersede 链 + archive + 新 ID）、忘记（tombstone 先行、正文物理删除、屏障与显式 override、按 scope/key 批量）、手工编辑竞态（external-edit-detected + 旧 hash CAS 失败）、并发（真实子进程持锁 → BUSY；杀掉持锁进程 → 陈旧判定 → 窃取恢复）、事务恢复（forget/supersede 半途崩溃前滚、未动回滚、hash 冲突保留）。全部 scratch home（`mkdtemp`），不触碰真实 `~/.dsh/ohmymemo`。

## 验证

- `pnpm run typecheck` / `pnpm run test`（80/80，重复运行稳定）/ `pnpm run build` 全绿；`git diff --check` 干净。
- 实机冒烟（scratch `DSH_HOME`）：runtime 组装树内 `dsh plugin --profile web add <repo>/plugin/dsh-ohmymemo` 安装成功，`--dump-config` 含 `ohmymemo-store` 行，`dsh web` 启动后 Store 在 scratch home 完整初始化（manifest/目录布局齐全）。

## Phase 2 边界（待确认后实施）

在此介质契约上：`ctx.ohMyMemo` 服务（Store 的薄包装 + search 排序）、五个 `memory_*` Tools（来源绑定 `exec.agent`）、exact key/tag/中英文全文检索（catalog 已备 NFKC+lower 正文索引）、user/workspace 有界 views、`agent/pre-step` 持久 capsule 对账。本包不新增介质语义，Phase 1 的 Store API 与测试即其地基。
