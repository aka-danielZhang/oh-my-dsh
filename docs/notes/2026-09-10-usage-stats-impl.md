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

## 动态预览反馈同步（2026-09-10 深夜，10 轮）

用动态 Cordis 插件（ustat-1，纯内存 host+client）在真实 GUI 上做了 10 轮可用性预览，定稿形态全部回移编译版（6714038d）：

- **四卡定稿**：累计 Token / 平均缓存命中（cr÷计费输入）/ 平均输出速度 / 平均调用时长。峰值、最长聊天、连续天数从卡片撤下（字段保留在 wire 兼容）。
- **关键发现（速度/首 token 无值的根因）**：0.1.5 会话日志**不落盘流式增量**——`assistant/chunk` 在新 SessionEventMap 中已移除，旧 packed 行（text-chunks 等）仅存在于 v0 旧日志且读取时走 v0→v3 转换；`assistant/attempt` 稀疏（1340 消息仅 1 条）不可依赖。结论：**纯生成速度与首 token 时间在新架构下无数据源**。替代口径：`step/start → assistant/message` 端到端窗口，表观速率 = output÷该窗口（含网络，21~34 tok/s 量级），样本 100% 覆盖（两份真实日志验证）。record 增加 `sd`（step 起点时间）使 records 仍是唯一事实源。
- **交互定稿**：时间范围=独立裸过滤行（无卡片背景，紧贴趋势图上方），仅驱动趋势+模型用量两看板（四卡全时段口径）；支持近 7 天/近 30 天/自定义起止（≤120 天）；「使用统计」order 11 紧随「模型」；环图固定按模型；刷新为图标钮；三图悬浮数据卡（热力图 position:fixed 防滚动裁剪，格子弹出「日期+tokens+轮数」）。
- React 教训：子组件必须 `el(Component, props)` 挂 hooks——直接函数调用会把子组件 useState 记到父组件 hook 表，条件渲染切换即 React #310。
- Inspect 工具带参调用报 "input must be an object"（空对象/带参皆如此，无参正常）——疑似传输层问题，待上游查。

## 0.1.1 视觉重构落地（2026-09-10，方案见 2026-09-10-usage-stats-visual-redesign.md）

### 0.1.2 视觉回调（2026-09-10）

实机对照现有设置页参考图后，撤回“唯一摘要带 + 无框图表分区 + 堆叠柱”的视觉表达，恢复为四张独立摘要卡、热力图卡、多模型平滑折线卡、模型质量双指标柱卡和模型用量圆环卡。时间范围仍保持无框过滤行；三组请求、generation guard、局部重试、CSS Modules、国际化和键盘交互保留。

按定稿方案一次完成 P0/P1 修复与结构重构，Client 表现层全部重写，Host 采集/records/Remote 五查询/wire 格式零改动：

- **P0 修复**：`charts.tsx` 57 处原始 `usage*` 类名全部改走 CSS Module 映射（构建产物断言 bundle 不含 `usage(Heat|Trend|Donut|...)` 原始串）；筛选只变外观不刷新的根因（`load()` 捕获 mode/range 但 effect 只依赖 face）改为三组请求状态 + 每 group 独立 effect + generation guard（快速切换旧响应丢弃）；`formatTokens` 10^8/10^9 边界修复（500M→5亿/500M、1B→10亿/1B，含 rounded `10000万`→`1亿` 进位）。
- **页面结构**：四卡合并为一张摘要带（唯一带边框容器；容器查询 680/520/420px → 4 列/2×2/单列），图表区改无框 section + 顶部细分隔线；热力图 8px cell + 2px gap（~544px 在默认 564px 内容宽完整显示），月份仅新月份首列、星期仅一/三/五，图例 flex 置于网格下方右侧；「累计」模式从 UI 移除（Remote `cumulative` 保留兼容）。
- **趋势改按日堆叠柱**：柱总高=当日总 Token，模型分层着色，Top 5 + 其他（`chart-data.ts` 纯 helper 单测覆盖）；Catmull-Rom 平滑折线与双轴「模型质量」图删除（`QualityBars` 整块移除，`quality` Remote 仍在 range 组拉取、不上 UI）。
- **模型用量**：圆环 + 排行同源数据（共享 `NamedCut` + `normalizedShares` 把舍入残差并给最大片，恒合计 100%）；>6 模型前 5 独立 + 其他聚合，超长名省略、title 显全名。
- **i18n/a11y**：charts 硬编码中文/单位全部清除；formatter 拆 zh/en 双 profile（`万/亿` vs `K/M/B`、`M月D日` vs `Sep 6`），axis 独立 compact formatter；日期初值走本地日历（修 `toISOString()` UTC 跨日）；locale profile 经 inject 传 `lang()` 解析器（组件不触 ctx）；筛选改 `Pill` aria-pressed 组；热力图 roving-tabindex 键盘游标（方向键/Home/End）+ 触摸/点击钉住；Tooltip 卡视口夹紧；SVG 均带 `<title>/<desc>`；`prefers-reduced-motion` 关刷新图标旋转。
- **测试基建**：新增 Vitest（jsdom + Testing Library，沿用 bridge/MCP 配置）与 `tests/format.test.ts`（边界数字/本地日期）、`tests/chart-data.test.ts`（堆叠总高/Top5+其他/圆环 100%/轴域）、`tests/components.client.spec.tsx`（14 例：加载/空态/局部失败重试/模式与范围即时请求/无效日期不发请求/乱序响应丢弃/手动刷新 announce/focus 重拉/英文无中文残留/CSS Module 类名非原始串）、`tests/browser-plugin.client.spec.tsx`（真实 SlotRegistry 注册与 fiber 卸载、Remote 自挂载、RemoteOutcome 解包、built client.js 装载 + 插件样式表注入 + 每个 local class 有哈希规则）。`test` script 改为 node 套件 + vitest 双跑。
- **已知偏差**：方案阶段 B 的「仅修故障基线截图」未单独出图——P0 根因已由失败测试固定（类名/请求/数字三例），修复与重构合入同一版 0.1.1，根因与重构效果由测试与 GUI 验收分别评估。
