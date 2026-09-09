# 使用统计插件实施记录（M1+M2）

2026-09-10 · 状态：M1、M2 已落地并实机验证 · 设计文档：`docs/notes/2026-09-09-usage-stats.md`

按设计文档实施 `plugin/dsh-usage-stats`（dual 三行：collector / gateway / 主行）。本文记录实施中的偏差决策与新发现，不复述设计。

## 实施偏差（对照设计文档）

1. **回填 API 是 `readSession` 不是 `listEvents`。** `ctx.sessionQuery.listEvents(sid)` 返回轻量元数据（sessionId/seq/type/time/surface），**不含 event data**——拿不到 usage。完整事件用 `readSession(sid) → SessionLogSnapshot.events`（live-preferred + persistence 直读，与 sqlite FTS 的 `openAt` 无关，web bundle 的 `openAt: never` 不影响）。
2. **records 是唯一事实源，`aggregates.json` 降级为 advisory 快照。** 设计文档写「gateway 读聚合快照 + 必要时按日文件重算」；实施改为每次启动从 records 全量重扫重建去重表与聚合（`aggregates.json` 只写不读）。理由：双源真相有一致性风险（快照滞后于崩溃前的 append），而全量重扫在 400 天 retention 内是百毫秒级后台任务；快照的「启动加速」价值留作 v2 增量水位优化。
3. **跨进程汇合：gateway 每次查询前 `rescan()`。** 设计文档只说「共享 Home 不加锁、last-wins」；实施补上主动汇合——rescan 按文件字节水位增量收编其他进程 append 的行（半行跳过、补全换行后下一轮收编）。桌面+终端双开时，任一侧查询都能看到对方刚写入的统计。水位/last-wins 丢账的最坏影响收敛为「多读（幂等）或靠 rescan 补」，records 永不重复也不漏。
4. **回填跳过规则**：`backfilled 集合含该 session 且水位表无记录 → skip`（老死会话不可能增长）；其余（水位表有记录的活跃会话、新会话）走 `readSession` 按 seq 增量 fold。首次启动 state 为空 = 全量回填，同一代码路径。
5. **streak 口径细化**：「当前连续天数」取延伸到今天或昨天的连续段（今天尚无数据不清零，GitHub 日历语义）；更早断档则归 0。README 已写明。
6. **listener 挂载时机**：`session/event` 监听在 store.open()（records 全量重建）完成**之后**才挂——去重集就绪前 fold 会双计其他进程/前世已持久化的消息。挂载前到达的事件留在会话日志里，由回填 walk 补上。

## 新发现（验证期踩坑）

- **session 日志有代际**：新版 harness 写 `session.v3.jsonl.zstd`（部分目录与旧 `session.jsonl.zstd` 并存迁移态）。旧基线 runtime（0.1.2-rc.1 源码 checkout）的 persistence 只认旧文件名——v3-only 会话直接从 `listSessions` 消失（不报错）。**结论：验证/部署必须用与写日志同代的 runtime**；本次 M1 实机验证改用 `~/.dsh-desktop/runtime/7e111d…`（当前桌面基线）跑 `dsh web` 才看到全部 4 个会话。插件的采集接口（session/event + sessionQuery）本身跨代稳定。
- **devDeps 避免 `@deepseek-ai/dsh-session-query`**：该包 0.1.2-rc.1 的 peer 链拉入 dsh-session-projection 等一串包，其中存在 prerelease range 解析失败（`>=0.1.2` 匹配不到 0.1.2-rc.1）。type-only 用途改用本地结构视图（`SessionQueryView`）+ `as` 桥接，零运行时影响。
- **RPC 信封（curl 调试形态）**：`POST /api/<ns>/<method>`，cookie 会话（先 `GET /?token=…` 换取），body `{"type":"client-request","rpcId":"1","method":"<ns>/<method>","payload":{"args":{"params":{…}}}}`。浏览器端 remote 客户端自动构造，无需关心。
- **静态色板**：主题 `design-platform.css` 的 `--dsw-static-{blue,green,amber,red,deepseek}-<shade>` 系列适合图表（跨深浅主题稳定）；热力图 5 档用 blue-100/300/450/600 渐进，系列色 deepseek/blue/green/amber/red 循环。

## 验证结论（M1 验收）

scratch home 复制 4 个真实会话（含 v3 与迁移态目录），起 `dsh web`（桌面基线 runtime）挂插件：

- 独立手工 fold（zstd CLI 解压 + 独立 JS 累加，与插件零共享代码）：37 条消息、总量 2,500,026、峰值 93,771、最长会话 875,310ms、byModel kimi-coding/k3=2,486,104 + zai-coding-cn/glm-5.3-flash=13,922。
- gateway 四方法（summary/daily/activity/breakdown）经 HTTP RPC 实测**逐字段一致**；records JSONL 行数 37、state 水位与 backfilled 集合齐全。

## M2 落地

- `settings.section` 注册（id `usage-stats`、order 30），设置导航出现「使用统计」；中文文案渲染正常。
- 手写 SVG 三图实机走查：热力图 daily 364 格（52×7 周对齐）/ weekly 52 格、趋势 2 条模型折线、环图 model/provider 双维切换（keys 分别为 `provider/model` 与 provider id）。
- CSS Modules 经 tsdown 内联，`<style>` 预打 `data-plugin="dsh-usage-stats"` + `data-plugin-css` 标记（2026-09-08 HMR 误删事故防御，DOM 实测确认）。
- 新鲜度：挂载拉取 + 刷新按钮 + 窗口 focus/visibility 重拉（设计文档 v1 口径；typert event 推送留 v2）。

## 待办（M3）

- retention 默认 400 天是否调整、回填进度展示、`dsh.desktop.ship` 是否随包（先走 git tag 分发）。
- 长驻进程的跨天 retention 追加清理（当前仅启动时清）。
