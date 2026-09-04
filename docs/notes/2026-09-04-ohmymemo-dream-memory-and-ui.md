# 2026-09-04 — OhMyMemo 梦境记忆调度与只读记忆空间

## 触发

用户要求在设置中新增顶级“记忆”菜单，可开启定时梦境记忆提取、查看运行状态，并浏览记忆目录中的文件。原 Phase 1/2 已有 Markdown Store、显式 Tools 与 context capsule，但没有后台触发器、持久 Run 状态或 Client UI。

## 产品边界

本次只交付 evidence-grounded candidate 生成与只读管理面：自动提取永不写 active，永不确认、置顶、覆盖或忘记记忆；UI 不提供编辑、删除、candidate 确认或冲突裁决。`$DSH_HOME/ohmymemo` 下的一条记忆一个 Markdown 文件仍是唯一 canonical 事实源，文件目录、概览统计和 generated views 都是派生视图。

## 组合

安装包从三个 Host 行扩为五个 Host 行和一个 Client 行。`ohmymemo-manager` 消费 Store、Session query、Agent、默认模型、Jobs、storage domain 与 timer，provide `ohMyMemoUi`；`ohmymemo-api` 在 `typert` 和 `ohMyMemoUi` 均 ACTIVE 后注册六个 Remote descriptor。Client 只注册一个 `settings.section`（id `memory`，order 14），在区内以“概览/记忆空间”本地页签切换，不把子页伪装成多个顶级设置项。

## 调度与 Run

`config.yaml` 新增 `dream_schedule_local_time`，默认 `02:00`；既有 `allow_inference_candidates` 同时作为梦境记忆总开关，默认关闭。设置变更带 config hash CAS，Store watcher 发布 `config-updated` 后 Manager 重排 one-shot timer。每天的下一边界按 Host wall clock 重新计算，覆盖 DST 与休眠漂移；启动或唤醒只补 `catchUpWindowHours` 内最近一个漏过的边界。

Manager 进程内只保留一个活动 Run，跨进程另通过 `.state/locks/dream-memory.lock` 取得有界 maintenance lease。持锁后关闭并重新打开 `dsh_ohmymemo_manager` storage domain，消除其 open-time snapshot；interrupted-run 恢复、scheduled boundary 复核、认领、提取、审计和 cursor/state 提交都在同一次 lease 内，状态只在 storage put 成功后发布到进程内。Jobs 只镜像当前 Run 的 status/cancel，不承担持久事实源，且其 `done` 对所有存储/执行异常都结算为 terminal outcome。Service 启动后以 detached loader barrier 等待组合完成，再进入 Manager 自己的串行队列；loader 等待不进入 teardown 必须等待的 operation tail，避免组合失败时形成自等待。

## 提取权限

来源只接受普通 root Session 中 `event.surfaceOp === 'append'`、`event.type === 'user/message'` 且 `event.data.source.kind === 'user'` 的 durable human transcript；fork seed、replacement 节点、subagent、`ohmymemo-maintenance-` Session、非用户来源和疑似凭据全部排除。每个 Session 经带 run signal 的 observation 读取，后续选择与模型输入受 Session 数、每 Session 消息数、总 transcript bytes、候选数、Agent 输出 tokens 和运行时限约束。当前 Session Query 的 corpus list 与 observation 本身仍会物化完整结果，因此这些上限不宣称为底层 I/O 分页。

维护 Agent 使用专用 `ohmymemo-maintenance-<uuid>` root Session，先强制 native presentation 再清空 visible Tools，并在执行 guard 层拒绝任何工具调用。模型只返回 strict `{ memories: [...] }` JSON；未知字段、非法 kind/scope、缺失证据或 evidence quote 不是原消息精确子串均使整轮失败且不推进 cursor。candidate key 从规范化正文与证据确定性派生，来源同时保留 event seq、quote hash 与受限 quote preview；所有自动候选统一写成 `privacy: sensitive`，最终仍经过 Store 的 secret、tombstone、锁与 schema 检查。

## 浏览安全

Host 文件索引只暴露 `scopes/`、`inbox/candidates/`、`archive/` 的 canonical Markdown，以及从当前 catalog 可重新组成并逐字验证的 `views/user-profile.md` 与 `views/workspaces/<ws>.md`；任意或陈旧 `views/*.md` 不进入索引。manifest、config、journal、锁、事务、storage-domain 状态、cache、metadata 和 tombstone 均不进入浏览器。读取要求相对规范路径、当前 tree generation、path+content hash、allowlist 命中、非 symlink escape、普通文件和 bytes 上限；Host 解析 frontmatter 后只把 owned metadata 与正文送到 Client，sensitive 正文 redacted，generated view 的内部 `<!-- generated ... -->` 头在渲染前清理。

## Client 数据与布局

Client apply 挂载 Typert Remote，以 `createSnapshotStore` 构造稳定 controller source，并通过注册项的 `hooks: { memory: controller.store }` 让渲染器生成 `useMemory`。组件不读取 `ctx`、不实现订阅机械，只消费 framework hook 快照与 controller callbacks；Remote 的 `RemoteResult<T>` 在 controller 中显式解包。全部产品文案由 typed 中英文 locale dictionary 提供，样式只用 `--dsw-*` 语义 token。

桌面记忆空间固定为 `214px minmax(0,1fr)` 双栏。容器小于 520px 时只显示文件列表或正文，正文头提供本地返回；浏览器视口小于 600px 且 Memory section 已挂载时，稳定结构选择器隐藏 stock 设置 `nav` 并把内容扩到面板宽度，离开该 section 自动恢复。该规则不依赖上游 CSS-module 类名。

## 验证

纯函数与服务测试覆盖本地调度边界/补跑、source 筛选、prompt bytes、strict output、证据校验、candidate/config CAS、maintenance lease、文件 allowlist/generation/symlink/size/redaction、tree projection、controller Remote 解包与 active Job 取消。发布 bundle 通过 typecheck、完整单测、构建与 Client require/颜色纯度扫描。

真实组合使用 scratch `DSH_HOME` 安装当前插件并以 OS 分配回环端口冷启动；浏览器验证顶级“记忆”菜单、默认关闭状态、启用后的无来源成功 Run、手动文件读取、desktop 双栏以及 390px narrow 列表/正文返回。整个验证不读取或修改真实 `~/.dsh/ohmymemo`。

## 已知限制

当前 DSH 没有同时提供 direct-user provenance 与分页/有界物理读取的 Session API；本轮只能把完整 corpus/selected-log 物化与后续有界处理区分并如实记录。Model-visible prompt 必须可从 Session 日志重建，而平台没有 maintenance Session 隐藏或删除契约，因此 `ohmymemo-maintenance-*` root Session 可能出现在普通历史并长期保留；本插件不绕过 Session Persistence 直接删文件。

## 发布前加固（host 审查驱动）

终审在可运行组合上复现了一组跨进程与竞态缺陷，全部在本轮修复并配回归测试：

- **事务 marker 视为不可信本地输入**：读取与写入均过严格 schema（含 ops/targets 一致性、ID 与 `txn_<ulid>.yaml` 文件名绑定）、store 内 allowlist 路径（record/tombstone/config）、路径规范化与逐级 symlink 拒绝；`toAbs` 以 realpath 的 store 根解析。逃逸 marker 只会进入 `damaged` → 冲突报告，不动任何文件。
- **零写入 CAS 中止**：`runTransaction` 在 marker 落盘前预检全部物理 op 必须 `not-done`；`before_hash` 竞态以零持久写入失败并移除 marker，不再产生永久冲突标记阻塞后续写入。
- **tombstone 读屏障**：catalog `get/activeEntries/byConflictKey/stats` 按 tombstone `memory_ids` 屏蔽，`readRecord` 读取前后刷新 tombstone 目录，`search/get/capsuleInput/浏览器索引` 全部走屏障后的 `readCatalog()`；延迟删除的残留正文不可经任何读取路径召回，doctor 仍见 `allEntries()` 以便清理，写入侧 `hasMemoryKey` 保持占用语义。
- **强制 revision+hash CAS**：`UpdateInput/SupersedeInput/PromoteInput/markDispute/markActive` 的 `ifHash` 变为必填，`memory_get` 返回 `hash`，`memory_update` 增加必填 `ifHash` 参数；同 revision 手工编辑不会再被陈旧调用覆盖。
- **写锁内 config 重读**：`reconcileCatalogUnderLock` 先重读 `config.yaml` 并应用运行时策略，陈旧进程不会执行过期的 size/retention/watch 策略。
- **退出顺序**：Store `close()` 不再强制释放写锁与维护租约（在飞回调自行释放；进程中途退出走 pid+启动标识陈旧判定）；Manager 收敛为单一 drain-first teardown effect，`startRun` 在执行期复查 `accepting`，排队启动不能逃逸 drain。
- **晚取消与游标安全**：`finishRun` 尊重 abort 信号——提交前取消以 `cancelled` 结算、不推进游标与 `lastScheduledFor`；游标推进改为「seq 连续已拟合前缀」水位（`cursorWatermarks` 纯函数），时间乱序漏掉低 seq 证据时游标原地不动，下次 Run 幂等重扫。
- **敏感 provenance**：`memory_get`/service 视图对 `sensitive` 记录剥离 `sources[].quote_preview`（本地 Markdown 保留 bounded quote 供审计），`quote_hash` 与定位符保留。
- **Client single-flight**：初载与 3 秒轮询各自 single-flight，慢 RPC 不再让 generation 互相作废或把 UI 卡在 running。

## 后续

candidate 确认/拒绝、TTL 清理、语义 consolidation、冲突裁决、来源 Session 跳转、maintenance Session 生命周期、编辑/忘记预览和 usage/cost 日月预算仍未实现。只有这些治理操作有明确交互与事务语义后，才扩展当前只读设置面。
