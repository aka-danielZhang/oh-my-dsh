# OhMyMemo 记忆空间指南：范围、状态与视图

> **一分钟版本**
>
> - **一条记忆 = 一个带 YAML frontmatter 的 `.md` 文件**，躺在 `~/.dsh/ohmymemo/` 下。
> - **范围（scope）** 决定它跟着谁：`user` 跟你走（跨项目），`workspace` 只在某个工作区生效。
> - **状态（status）** 决定它现在算不算数：`active` 才会被召回；被修订取代的旧版进 `archive/`；「忘记」是 `tombstones/` 里的墓碑，防同一条记忆复活。
> - **视图（views/）** 是系统按范围帮你生成好的**只读摘要**，随时可以重建——它不是事实源，手改会被覆盖。
> - 一条记忆能被自动召回（进 capsule / 搜索默认命中）的条件：**`active` + `privacy: normal`**；想进每回合的常驻胶囊还要 **`pinned: true`**。

配图：[`docs/diagrams/memory-space-nested.html`](diagrams/memory-space-nested.html)（目录包含关系一图流）；提取/召回的调用时序见 [`docs/diagrams/memory-extraction-sequence.html`](diagrams/memory-extraction-sequence.html)。

## 1. 一条记忆长什么样

每条记忆就是仓库里的一个 Markdown 文件，元数据全在 frontmatter 里。这是一条真实文件（`scopes/user/semantic/mem_01M1Y8MJWH1ZYDVXW8MFNFR49B.md`）：

```yaml
---
schema: ohmymemo/v1
id: mem_01M1Y8MJWH1ZYDVXW8MFNFR49B   # 全局唯一 ID（ULID）
revision: 1                          # 修订号，每次内容变更 +1（配合 hash 做 CAS 并发保护）
scope: user                          # 范围：user | workspace:<wsId>
kind: semantic                       # 类型：semantic | episodic | procedural
key: dream.user.language.chinese.192812485574  # 冲突键（点分），同 scope+kind 下唯一
cardinality: single                  # 同 key 允许几条：single（新忆取代旧忆）| multiple（可并存）
status: active                       # 状态：见 §4
confidence: 0.82                     # 可信度（梦境抽取的模型置信度）
importance: 0.5                      # 召回优先级 0..1，视图和 capsule 都按它排序
privacy: normal                      # 隐私：normal | sensitive | secret-ref
pinned: true                         # 是否进「核心视图」与常驻 capsule
confirmed: false                     # 是否经你确认（你在对话里明确说过的事实会置 true）
created_at: 2026-09-07T15:43:53.234Z
updated_at: 2026-09-07T15:43:53.234Z
tags: [language, chinese, communication]
---
用户使用中文交流，回复与产出应使用中文。
```

frontmatter 下面就是正文——记忆本身，一两句话。

## 2. 范围（scope）：这条记忆跟着谁

| 范围 | 值 | 存放目录 | 什么时候会写进这个范围 |
|---|---|---|---|
| **user** | `user` | `scopes/user/<kind>/` | 与具体项目无关的稳定事实：语言偏好、设备、通用工作习惯 |
| **workspace** | `workspace:<wsId>` | `scopes/workspaces/<wsId>/<kind>/` | 只在某个仓库/项目里成立的事：构建命令、架构约定、该项目特有偏好 |

**判定规则**：写记忆时若带了会话 `cwd`，插件对它做 realpath 归一，关联到一个 workspace（`ws_<ulid>`，优先用 DSH 自己的 workspace id）。你（或梦境提取）在 A 项目会话里说「这个项目用 pnpm」，它就落进 A 的 workspace 范围；说「我用中文交流」，就落进 user 范围。

**召回时的含义**：会话在哪个工作区，就带哪个工作区的记忆 **加上** 全部 user 记忆——别的项目的 workspace 记忆不会串场。

## 3. 类型（kind）与同键策略（cardinality）

| kind | 含义 | 典型例子 | 目录 |
|---|---|---|---|
| `semantic` | 稳定事实 | 「用户用小米手机」 | `scopes/…/semantic/` |
| `procedural` | 可复用的做事方式 | 「日程规划要导出 .ics 让用户自己导入」 | `scopes/…/procedural/` |
| `episodic` | 事件性片段 | 「2026-09 和助手逐题复习过 DP 算法」 | `scopes/…/episodic/<年>/<月>/`（按时间归档） |

`cardinality`：`single` 表示同一个 key 只允许一条活的（新记忆修订取代旧的，旧文件进 archive）；`multiple` 允许同 key 多条并存（episodic 默认）。

## 4. 状态（status）：一条记忆算不算数

状态同时决定**文件住在哪个目录**和**会不会被召回**：

| 状态 | 含义 | 文件位置 | 会被召回？ | 怎么产生 / 怎么离开 |
|---|---|---|---|---|
| `active` | 正式生效 | `scopes/…`（正典区） | ✅ | `memory_remember`、梦境抽取直接写入；被 `update` 修订后旧版转 `superseded` |
| `candidate` | 候选，尚未定稿 | `inbox/candidates/` | ❌ | 推断式候选（当前默认流程基本不产生）；确认后转 `active` 或被清理 |
| `disputed` | 有争议，挂起 | `scopes/…`（留在原地） | ❌（暂不召回） | `memory_dispute` 质疑；确认恢复用 `memory_update(reactivate)` 回 `active` |
| `superseded` | 已被新版本取代 | `archive/` | ❌ | `memory_update` 内容性修订的副产品；文件整体迁入归档目录 |
| （已忘记） | tombstone | `tombstones/<id>.yaml` | ❌（屏障） | `memory_forget` 先写墓碑再删正文——同 ID/同 key 不得复活 |

另外还有一层与状态正交的 **quarantine（隔离）** 标记：隐私或一致性检查没过的文件会被隔离——不进视图、不进搜索，等 doctor/人工处置。

## 5. 隐私（privacy）

| 值 | 含义 | 召回面 |
|---|---|---|
| `normal` | 普通记忆 | capsule / 视图 / 搜索默认可见 |
| `sensitive` | 敏感但非凭据 | 不进 capsule 与视图；搜索默认排除，`memory_get` 回读时正文与引文隐去 |
| `secret-ref` | 凭据引用 | 与 sensitive 同样隐去；写入端本就 fail-closed 拒收疑似凭据正文 |

## 6. 视图（views/）：生成的只读摘要，不是事实源

`views/` 是系统从正典记忆**筛选重建**出来的 Markdown 摘要页：

- `views/user-profile.md` —— user 范围的核心记忆；
- `views/workspaces/<wsId>.md` —— 各工作区的核心记忆。

生成规则（与 capsule 同一准入）：`quarantine` 未隔离 + `status: active` + `privacy: normal` + `pinned: true`，按 `importance` 降序排列。文件头带 `generated: true` 与内容 digest。

三条使用纪律：

1. **随时可重建**（`rebuildViews`；每次写入后自动刷新）——删掉也无妨。
2. **不要手编**：手改会在下一次重建时被覆盖，canonical 只有 `scopes/` 里的文件。
3. 它是「给人快速浏览」的；给模型的每回合注入（capsule）由 `ohmymemo-context` 行按同一准入条件、以 workspace 优先 + importance 排序、8KB 预算确定性截断后生成。

## 7. 目录地图

```
~/.dsh/ohmymemo/
├── manifest.yaml               # 库级清单（store_id、格式版本）
├── config.yaml                 # 你的偏好（注入预算、梦境模型、调度时间…）
├── scopes/                     # ★ 正典区：唯一事实源，按范围分目录
│   ├── user/
│   │   ├── semantic/           #   semantic 直接按类型放
│   │   ├── procedural/
│   │   └── episodic/2026/09/   #   episodic 再按 年/月 归档
│   └── workspaces/<wsId>/
│       ├── semantic/  ├── procedural/  └── episodic/…
├── inbox/candidates/           # candidate 候选区
├── archive/                    # superseded 旧版归档（目录结构与 scopes 镜像）
├── tombstones/                 # 忘记的墓碑（<id>.yaml 屏障）
├── journal/<年>/<月>.jsonl     # 纯元数据操作日志（崩溃恢复/审计，不含正文）
└── views/                      # ★ 派生只读视图（可随时重建）
    ├── user-profile.md
    └── workspaces/<wsId>.md
```

## 8. 常见问题

**Q：我让它「记住」，为什么设置页记忆空间里没有？**
先看会话里工具是否返回成功；再确认它写进了哪个 scope——workspace 记忆在「记忆空间」树里挂在对应工作区分组下，不在 user 组里。

**Q：为什么这条记忆没有出现在每回合的 capsule 里？**
按顺序查四个条件：`status` 是不是 `active` → `privacy` 是不是 `normal` → `pinned` 是否为 `true` → 预算（`max_injected_bytes`，默认 8KB）内是否排得进（workspace 优先、importance 降序，排不进的会被确定性截断）。

**Q：记忆空间里手改文件可以吗？**
可以，但以磁盘为准：插件 watch 到外部修改会按文件内容重载并记 `external-edit-detected`；手编 `views/` 没有意义（下次重建即覆盖），要改就改 `scopes/` 里的正典文件。

**Q：想删掉一条记忆？**
用 `memory_forget`（按 ID 或 scope+key），它会先落墓碑屏障再删正文；直接删文件会绕过屏障，同 key 的记忆之后可能被再次写入。

## 9. 相关文档

- 包行为契约：[`plugin/dsh-ohmymemo/README.md`](../plugin/dsh-ohmymemo/README.md)
- 总设计：[`docs/notes/2026-09-03-ohmymemo-memory.md`](notes/2026-09-03-ohmymemo-memory.md)
- 梦境提取与今日预算/抢救/死信决策：[`docs/notes/2026-09-07-ohmymemo-dream-output-budget-and-salvage.md`](notes/2026-09-07-ohmymemo-dream-output-budget-and-salvage.md)
- 提取→入库→召回时序图：[`docs/diagrams/memory-extraction-sequence.html`](diagrams/memory-extraction-sequence.html)
- 本指南配图（目录包含关系）：[`docs/diagrams/memory-space-nested.html`](diagrams/memory-space-nested.html)
