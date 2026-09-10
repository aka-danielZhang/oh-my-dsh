# dsh-usage-stats

设置·使用统计：四张摘要卡（累计 Token/缓存命中/输出速度/调用时长）、Token 活动热力图、多模型按日折线趋势、模型质量分组柱和模型用量圆环排行。数据零改动采集自既有会话日志，不含费用估算。

## 形态

标准 DSH 双面包，bundle patch 挂三行：

| 行 | 职责 |
|---|---|
| `dsh-usage-stats/collector` | 采集：`ctx.on('session/event')` live fold + 启动回填（`ctx.sessionQuery.listSessions()` → `readSession`），`message.id` 跨会话去重，写入 `$DSH_HOME/usage-stats/` |
| `dsh-usage-stats/gateway` | Typert Remote `usageStats` 命名空间：`summary` / `daily` / `activity` / `breakdown` / `quality` 五查询，返回聚合好的纯 JSON |
| `dsh-usage-stats`（主行） | typert strict contribution 注册（装配 runtime 下 `/api/usageStats/*` 可路由）+ 浏览器半载体 |

浏览器半注册 `settings.section`（id `usage-stats`，models 之后）。页面按设置面板既有的卡片化仪表盘表达：页头（标题/说明/新鲜度 + 刷新）→ 四张独立摘要卡（宽屏四列，窄屏 2×2/单列）→ Token 活动热力图卡（每日/每周，52 周×7 天）→ 无外框时间范围行（近 7/30 天或自定义 ≤120 天）→ 多模型按日平滑折线卡→ 模型质量分组双轴柱卡（缓存命中率 / 输出速度；点击图例可单独查看任一指标，再次点击恢复双柱）→ 模型用量圆环与排行卡（Top 5 + 其他，合计 100%）。手写 SVG，无第三方图表库；样式使用 `--dsw-*` token 与 CSS Modules。请求分 summary/activity/range 三组独立加载，保留 generation guard、局部重试、中英文格式化和键盘可访问性。

## 存储（`$DSH_HOME/usage-stats/`）

```
records/<yyyy-mm-dd>.jsonl   # 日滚追加，一行一条 record（事实源）
aggregates.json              # 聚合快照（advisory；启动时从 records 全量重建）
state.json                   # 每 session 已消费 seq 水位 + 回填完成集合
```

- **records 是唯一事实源**：每次启动全量重扫重建去重表与聚合；`aggregates.json` 仅作发布快照。
- **去重键 = assistant message id**：fork 种子消息、live/回填竞态、跨进程水位竞态全部坍缩。
- **跨进程**：桌面与终端共享 `$DSH_HOME`，各自追加不加锁（O_APPEND 行级交错安全，半行被跳过直到补全换行）；gateway 每次查询前 `rescan()` 收编其他进程写入的行。
- **retention**：`records` 默认保留 400 天（启动时清理），聚合永久。

## Config（cordis.yml `config`，非法值 fail loud）

| 字段 | 默认 | 说明 |
|---|---|---|
| `retentionDays` | 400 | 日滚 records 保留天数（7–3650） |
| `flushIntervalMs` | 2000 | state/aggregates 落盘 debounce（250–60000） |
| `maxWriteFailures` | 5 | 连续写失败次数上限，超过后磁盘半自动禁用（内存镜像继续服务） |

## 指标口径

| 指标 | 口径 |
|---|---|
| 累计 Token | Σ 每条 record 的 in+cr+cw+out（互斥口径，billed input 含 cache），全时段 |
| 平均缓存命中 | cr ÷ 计费输入（in+cr+cw），全时段；副文案「计费输入」 |
| 平均输出速度 | output ÷ 调用端到端时长（step 起点→回复），全时段；副文案「端到端」 |
| 平均调用时长 | 调用开始 → 回复完成的均值，全时段；一分钟内按整数秒（`s`）显示 |
| 峰值 Token / 最长聊天 / 连续天数 | 保留在 wire（`summary` 字段），v1 页面不上卡 |
| 热力图档位 | 区间内最大值 4 等分（非零即至少 1 档） |
| 趋势/模型用量 | 受时间范围过滤驱动（近 7/30 天或自定义 ≤120 天） |

## 已知边界（有意为之）

- adapter 不上报 usage 的调用不进统计（`estimated` 标记是 v2 项）；失败/取消调用无 usage 不计。
- 压缩/标题生成等内部调用（`llm/stream` 旁路）v1 不计入，留作 v2 独立 `internal` 桶。
- reasoning tokens 记录在 record（`rt` 字段）但 v1 不计入总量。
- 不做费用估算（无价格表事实源）。
- retention 清理只发生在启动时；长驻进程跨多天不追加清理。

## Install

```sh
dsh plugin --profile web add <repo>/plugin/dsh-usage-stats
```

The bundle patch mounts the three rows above for every profile that installs
this plugin.

## Client half

`lib/client.js` is the ModuleLoader closure artifact (window.__ModuleLoader__
.load) with platform modules externalized — the build contract lives in this
package's `tsdown.config.ts`; keep `CLIENT_EXTERNALS` in sync with the
harness `PLATFORM_MODULES` baseline when it moves.

## Design notes

- 设计文档：仓根 `docs/notes/2026-09-09-usage-stats.md`。
- 实施决策：`docs/notes/2026-09-10-usage-stats-impl.md`。
- Contracts live in the repo root `AGENTS.md` (plugin monorepo rules, npm
  dependency discipline, client bundle build contract).
