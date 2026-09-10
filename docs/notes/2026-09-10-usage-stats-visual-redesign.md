# 使用统计页视觉重构方案

2026-09-10 · 状态：方案定稿，待实施 · 目标版本：`dsh-usage-stats 0.1.1` / Desktop `0.3.0-rc.47`

## 结论

当前页面不是单纯的视觉偏差，而是构建缺陷、响应式缺失和实现偏离参考设计叠加后的结果。截图中的黑色坐标文字、热力图越界、图表尺寸异常首先来自 CSS Modules 失联；趋势又把参考设计的按日堆叠柱改成了平滑多折线，并额外增加了双轴“模型质量”图。即使只修复样式，页面仍不会回到原定效果。

本次不做局部换色。推荐一次完成两层工作：

1. 修复所有会导致错误显示、错误数据刷新和错误格式化的 P0/P1 缺陷。
2. 回到 ZCode 官方参考图的核心表达，将页面重构为“摘要带 → 活动 → 时间范围 → 按日堆叠趋势 → 模型用量圆环与排行”的单列统计面板，删除偏离需求的双轴质量图。

Host 采集、records 事实源、Remote 五个查询及持久化格式保持不变。改动集中在 Client 表现层、交互状态和测试，不触碰历史统计数据。

## 当前问题与证据

### P0：图表样式没有接上 CSS Modules

`UsageStatsSection.module.css` 经 `tsdown.config.ts` 的 Lightning CSS 编译为 `[hash]_[local]`。父组件使用 `styles.*`，但 `charts.tsx` 有 57 处直接输出 `className="usage…"`，这些原始类名在构建产物中匹配不到被哈希的选择器。

直接后果：

- 月份、星期、趋势坐标轴回退为 SVG 默认黑色和默认字号，在暗色主题中几乎不可读。
- `fill: none`、网格线、图例、Tooltip、Donut、Quality 等样式大量失效。
- CSS 定义 `.heatWrap/.trendWrap/.qualityWrap`，JSX 输出 `usageHeatWrap/usageTrendWrap/usageQualityWrap`，名称本身也不一致。
- 热力图预期的局部横向滚动没有生效，固定宽度 SVG 把整个设置内容区撑出横向滚动条。
- 图表组件没有浏览器测试，源码 typecheck 无法发现原始字符串绕过模块映射。

### P0：筛选控件只变外观，不会立即刷新数据

`load()` 捕获了 `activityMode` 和 `rangeKey`，但触发请求的 effect 只依赖 `face`。切换每日/每周/累计、近 7 天/近 30 天/自定义后，选中态变化，图表数据仍停留在旧范围，直到窗口重新聚焦或手动刷新。

当前 `Promise.all` 还会让任一查询失败阻止全部区域更新，并允许快速切换时较旧响应覆盖较新选择。

### P1：数字格式存在实际计算错误

`formatTokens()` 同时把中文万进制规则套给英文，并在大数区间使用错误的除数与后缀：

- 英文可能显示 `1.2w`，不符合既有 `K/M/B` 口径。
- `500,000,000` 会得到 `5万`。
- `1,000,000,000` 会得到 `1M`。
- 坐标轴左侧固定 46px，加上失效的字号样式，会把 `1000万` 裁成截图中的 `000万`。

### P1：页面按 720px 设计，实际常态只有约 564px

stock 设置弹窗宽 800px，左侧导航 188px，内容区左右各 24px，因此桌面常态可用宽度约为：

```text
800 - 188 - 24 - 24 = 564px
```

当前四列指标卡没有任何容器查询，每张只剩约 135px，标签和说明只能省略。热力图逻辑宽约 644px；趋势和质量图按 640px 坐标系设计。样式一旦失效，越界立即暴露；即使样式正常，页面也没有针对真实内容宽度做构图。

### P1：信息架构过度卡片化

当前顺序是四张指标卡、热力图卡、趋势卡、模型质量卡、模型用量卡。所有区域都使用相同描边、圆角和背景，导致：

- 视觉层级只有“很多卡片”，没有摘要、主图和明细的主次。
- 纵向长度过长，用户无法在一屏建立整体判断。
- 说明文字被迫压缩或截断。
- 统计页像组件陈列，不像安静、可重复查看的操作面板。

### P1：“模型质量”图表达不成立

缓存命中率和端到端表观输出速度不是“模型质量”，也没有共同量纲。当前双 Y 轴分组柱把 `%` 与 `tok/s` 并排，容易让用户把柱高直接比较，得出错误结论。

模型用量环图也存在结构问题：圆弧只画前 7 个模型，列表却显示全部模型；超过 7 个时圆环不再代表 100%，颜色还会循环复用。

### P1：趋势图容易制造错误视觉

Y 轴上限取每日总 Token，但曲线画的是单模型 Token，各模型会被整体压低。Catmull-Rom 平滑没有单调约束，会在离散日数据之间产生不存在的峰谷。7 天稀疏数据不适合这种平滑曲线。

### P1：国际化、无障碍和状态反馈不完整

`charts.tsx` 仍硬编码中文日期、星期、`轮`、`无用量`、缓存命中和输出速度；英文界面会混入中文。图表详情仅支持鼠标悬浮，日期输入没有可访问名称，筛选按钮用了 tab 语义但没有完整 tab 键盘协议。刷新按钮是手写 SVG，没有使用现成 `Button`、`IconRefreshOutline16` 和 `Tooltip`。

## 目标体验

### 设计原则

1. **先读结论，再看趋势，再做比较。** 页面第一屏先回答“总共用了多少、效率如何、最近是否活跃”。
2. **设置页不是大屏驾驶舱。** 使用紧凑指标带、无框图表区和细分隔线，不堆叠浮动卡片。
3. **以 564px 为主设计宽度。** 720px 是上限，不是默认；所有布局用容器宽度决策。
4. **图表只表达一种比较关系。** 不使用双轴混合柱，不用会越界的平滑曲线，不让圆环与列表口径不一致。
5. **颜色服务于数据。** 大面积表面保持中性，业务色只用于数据系列、选中和焦点。
6. **功能与状态可访问。** 筛选、刷新、Tooltip、日期范围和数据明细均支持键盘、触摸与屏幕阅读器。

### 推荐页面结构

```text
使用统计                                      [刷新]
本机所有会话的 Token 用量与调用表现
更新于刚刚 · 自 2026-09-08 起 · 活跃 3 天

┌──────────────────────────────────────────┐
│ 累计 Token      缓存命中                  │  564px 下 2×2
│ 1.5 万          94.2%                     │
│ ──────────────────────────────────────── │
│ 输出速度        调用时长                  │
│ 31.7 tok/s      <1 分钟                   │
└──────────────────────────────────────────┘

活动                                  [每日] [每周]
  9  10  11 ...                              
一 ▪ ▪ ▪ ▪ ▪ ▪ ▪ ...                         52 周热力图
三 ▪ ▪ ▪ ▪ ▪ ▪ ▪ ...                         实际宽度内完整显示
五 ▪ ▪ ▪ ▪ ▪ ▪ ▪ ...              少 ▪▪▪▪▪ 多

时间范围                     [近 7 天] [近 30 天] [自定义]

按日 Token 趋势
  每日一根堆叠柱；模型按颜色分层；Top 5 + 其他

模型用量
  [圆环：范围总量]   glm-5.3            42%   62.1万
                     gpt-5.6-luna       26%   38.4万
                     其他               8%    11.8万
```

## 具体设计决策

### 1. 页头与新鲜度

- 沿用 Models/MCP 的 16/24 标题、14/22 说明、12/18 元数据层级。
- 页头右侧使用 `Button variant="toolbar" size="sm"`、`IconRefreshOutline16` 和 `Tooltip`。
- 请求中按钮禁用并旋转图标；旋转遵守 `prefers-reduced-motion`。
- 元数据合成一行：更新时间、最早统计日期、活跃天数。刷新完成时用 `role="status"` 宣布；普通静态渲染不持续播报。
- 删除累计 Token 卡中的空占位 `statHint`。

### 2. 摘要带

- 四张独立卡合并成一张紧凑摘要带，使用一次 `0.5px` 描边或 `bg-module-platform`，圆角 8px。
- `container-width >= 680px`：四列一行。
- `420px <= container-width < 680px`：2×2；这是设置弹窗 564px 的默认形态。
- `< 420px`：单列，指标之间保留细分隔线。
- 标签允许两行，不使用 ellipsis；数值使用 18/24、tabular numerals。
- “平均缓存命中”副文案改为“计费输入”；“平均输出速度”副文案改为“端到端”；“平均调用时长”不再重复解释完整箭头文案。

### 3. 活动热力图

- 移除外层卡片背景，改为带顶部细分隔线的页面 section。
- 默认保留“每日 / 每周”两个筛选；“累计”从热力图删除。累计色阶只会随时间单调加深，表达的是日期顺序而非活动强度，不适合热力图。
- 保留 Host 的 `cumulative` Remote 能力以兼容现有协议，本次不删除 wire 字段。
- 每日模式使用 7×52 网格；逻辑尺寸按 564px 主宽调整为约 8px cell + 2px gap，使全年热力图在默认内容区完整显示。
- 小于约 520px 时只允许热力图自己的 wrapper 横向滚动；整个设置页不得出现横向滚动。
- 月份只在新月份首列显示；星期只显示一、三、五，降低噪声。
- 图例置于网格下方右侧，禁止 `float`，用 flex 正常参与布局。
- 单元格支持 hover、focus 和 touch/click；数据卡使用视口夹紧定位，不能被设置滚动容器裁切。

### 4. 时间范围

- 时间范围只控制趋势和模型对比，四项摘要与全年活动维持全时段口径。
- 筛选使用 `Pill` 或 `aria-pressed` 按钮组，不再伪装成 tabpanel。
- 默认 564px 下标题和按钮可同排；小于 520px 时分两行。
- 自定义日期使用两个带可访问标签的 32px 输入；小于 460px 时上下排列。
- `from > to`、缺日期或超过 120 天时显示就地校验，不继续展示旧范围数据冒充当前选择。
- 日期初值使用本地日历字段生成，修复当前 `toISOString()` 造成的 UTC 跨日偏差。

### 5. 按日 Token 趋势

- 去掉外层重复卡片边框，保留 section 标题、绘图区和图例。
- 回到参考设计的堆叠柱图：每天一根柱，柱内按模型分色，柱总高直接等于当日总 Token。
- 模型系列按范围总量排序，Top 5 单独着色，其余聚合为“其他”，避免颜色循环和长图例。
- 7 天使用较宽柱；30 天和自定义长范围自动收窄，但柱间距与绘图区尺寸保持稳定。
- Y 轴按每日总量决定上限，并由最长格式化 tick 决定左侧 gutter；不再固定 46px。
- `days=[]`、单日、全零和大数值必须有稳定布局，不得解引用空数组。
- 悬浮、焦点或触摸任一日期时展示当日总量和各模型明细；堆叠层与 Tooltip 使用同一颜色映射。

### 6. 模型用量圆环与排行

保留参考设计中的模型用量圆环，但重写当前错误实现；删除 `QualityBars` 及整块双轴“模型质量”区域。Host 的 `quality` Remote 暂时保留兼容，不再在 v1 页面展示。

模型用量 section 包含：

- 左侧紧凑圆环，中心显示所选范围 Token 总量。
- 右侧模型排行，每行显示色块、模型名、Token 绝对值和占比。
- 超过 6 个模型时，前 5 个独立显示，其余在圆环和排行中一致聚合为“其他”；圆环与列表始终合计 100%。
- 模型名过长时省略，但 Tooltip 显示完整 provider/model。
- 小于 520px 时圆环居中，排行移到下方；默认 564px 下使用约 128px 圆环加弹性排行。

“模型质量”不是本次需求的一部分。缓存命中和端到端速度保留在顶部摘要中，不再用双轴柱暗示它们可以直接比较。

### 7. 颜色与表面

- 页面表面只使用 `--dsw-alias-*` 语义 token。
- 数据系列色集中映射为组件级 CSS 变量，再指向已有 `--dsw-static-*` 色板；不在 JSX 到处散落 token 名。
- 空热力格使用 `bg-module-platform` + 极弱描边；非空格使用四级顺序色。
- 主总量线使用 business/deepseek 色，模型线使用蓝、绿、琥珀、红等分类色，避免整页单一蓝色。
- 所有图表文字显式使用 label-secondary/tertiary；暗色和亮色都不得回退为浏览器默认黑色。
- 普通 section 不画外框；只有摘要带和真正的输入控件保留边界。

### 8. 国际化与无障碍

- 移除 `charts.tsx` 中所有产品可见硬编码中文和英文单位。
- 日期通过明确的 locale profile 格式化；中文用 `M月D日`，英文用本地短日期。
- 数字格式改为明确的中文 `万/亿` 与英文 `K/M/B` 规则，另设 axis compact formatter，避免坐标轴长标签。
- 每个 SVG 提供本地化的 `<title>` 和 `<desc>`。
- 趋势、热力图和圆环提供屏幕阅读器可访问的数据摘要；圆环排行采用语义化 list。
- 筛选按钮支持 Tab 聚焦与 Enter/Space 切换；若保留 tab 语义，则必须补 Arrow/Home/End 和 `aria-controls`，但本方案推荐 pressed-group 语义。
- 所有 focus-visible 状态使用统一 2px 焦点环；Tooltip 同时响应 hover 和 keyboard focus。

## 请求与状态重构

不要继续用一个 `Promise.all` 驱动整个页面。Client 状态分成三组：

1. `summaryState`：summary，全时段。
2. `activityState`：activity，仅由 activity mode 驱动。
3. `rangeState`：daily + breakdown + quality，由范围驱动。

行为：

- 首次挂载并行加载三组。
- 切换每日/每周只加载 activity。
- 切换范围只加载 range 组。
- 手动刷新和窗口重新聚焦加载全部三组。
- 每组持有递增 request generation；只有最新 generation 可以提交结果，防止快速切换产生乱序覆盖。
- 某组失败只在该 section 显示错误与重试，不清空其他成功区域。
- 刷新期间保留旧数据并显示忙碌状态，避免整个页面闪回 loading。
- 自定义日期无效时不发请求，range 区域进入明确 invalid 状态。

这一层可以留在组件私有 state，不引入新的外部 store，也不改变 slot inject 面。

## 文件级变更清单

### `plugin/dsh-usage-stats/src/client/UsageStatsSection.tsx`

- 重排为 Header、SummaryBand、ActivitySection、RangeToolbar、DailyTrendSection、ModelUsageSection。
- 把单个 `load()` 拆成三组请求状态与 generation guard。
- 使用 ui-primitives 的 Button、Pill、Tooltip、IconRefreshOutline16。
- 删除双轴 QualityBars 区域，保留并重构 DonutChart 与排行。
- 删除四张独立 statCard 的渲染和 `unusedPlaceholder()` 残留。

### `plugin/dsh-usage-stats/src/client/charts.tsx`

- 直接 import CSS Module，所有 className 改为模块映射；禁止原始 `usage*` 类字符串。
- 统一 wrapper 命名，删除无效 global 兼容选择器。
- 重写 ActivityHeatmap 的尺寸、指针坐标映射和 focus/touch 交互。
- 将 TrendChart 重写为按日堆叠柱，处理空数据、Top 5 + 其他、轴 gutter 和各范围柱宽。
- 重写 DonutChart 的 Top 5 + 其他与圆环/排行同源数据，删除 QualityBars 和 `smoothPath()`。
- 将纯数据转换提取到可单测 helper；组件只负责绘制和交互。

### `plugin/dsh-usage-stats/src/client/UsageStatsSection.module.css`

- 按新结构整体重写，保留 12px 基础节奏。
- `.section` 增加 `width:100%`、`min-width:0`、`box-sizing:border-box` 和 `container-type:inline-size`。
- 添加 680/520/420px 容器查询、focus-visible、reduced-motion。
- 删除八套重复 card chrome、失效的 `.usage*`/`:global()` 规则和 float 图例。
- 所有固定格式 UI 给出明确尺寸，图表和模型行不因动态内容改变布局。

### `plugin/dsh-usage-stats/src/client/format.ts`

- 拆出 summary、axis、percentage、duration、date formatter。
- 修复 10^8、10^9 边界与英文 K/M/B。
- 使用本地日期 helper，不再用 UTC `toISOString()` 生成范围日期。

### `plugin/dsh-usage-stats/src/client/locales.ts`

- 补齐总量、其他、日期标签、范围校验、局部错误/重试、图表 desc 等文案。
- 删除 charts 中硬编码的中文、`tokens` 和单位。
- 删除“模型质量”页面文案，补齐“模型用量 / Model usage”圆环与排行文案。

### `plugin/dsh-usage-stats/src/client/index.ts`

- inject face 保持五个查询不变。
- 若 formatter 需要当前语言标识，通过 inject 传入稳定 locale profile；不让组件读取 ctx 或自行订阅 locale。

### `plugin/dsh-usage-stats/tests/`

新增：

- `format.test.ts`：999、1K、9,999、10K、1亿、5亿、10亿，中英文边界；本地日期跨日。
- `charts.test.ts`：空/单日/多模型、堆叠柱总高、Top 5 + 其他、圆环合计 100%、轴范围、大 tick、全零数据。
- `components.client.spec.tsx`：加载、空态、错误、刷新、focus、每日/每周、7/30/自定义、无效日期、乱序响应、局部失败、英文无中文残留。
- `browser-plugin.client.spec.tsx`：真实 slot 注册、HMR dispose、built client module 装载。
- `vitest.config.ts`：沿用 bridge/MCP 的 jsdom 和 CSS Modules 测试配置。

更新 `package.json` test script，使 Node host tests 与 Vitest client tests 都执行，并补齐 Testing Library/Vitest 开发依赖。

### 文档与版本

- `plugin/dsh-usage-stats/README.md`：同步五个 Remote、四项摘要、堆叠趋势、模型用量圆环/排行、响应式和已知口径。
- `docs/notes/2026-09-10-usage-stats-impl.md`：追加本次偏差修复结果，不改历史事实。
- 根 `AGENTS.md`：更新 dsh-usage-stats 当前展示契约。
- `plugin/dsh-usage-stats/package.json`：建议 `0.1.0 → 0.1.1`。
- 因该插件 `dsh.desktop.ship: true`，落地后必须按 release runbook 推进 Desktop 下一版，建议 `0.3.0-rc.47`，并同步 CHANGELOG 与 runtime revision manifest 中的 usage-stats 版本/hash。

## 实施顺序

### 阶段 A：先建立失败保护

1. 安装插件依赖并锁定当前 registry posture。
2. 增加 formatter、请求切换和 built-client CSS smoke 的失败测试。
3. 在测试中复现：原始类名没有模块样式、切换范围不请求、500M/1B 格式错误。

### 阶段 B：修复 P0，不改变布局

1. 接通 CSS Modules 全部类名。
2. 修复 range/activity 请求触发与乱序响应。
3. 修复数字、本地日期和硬编码文案。
4. 生成一次“仅修故障”的基线截图，确认根因与重构效果可分开评估。

### 阶段 C：完成结构重构

1. 四卡合并摘要带。
2. 卡片式图表改为无框 section。
3. 热力图适配 564px，并删除累计模式入口。
4. 趋势增加总量、Top 5 + 其他与正确轴域。
5. 环图和双轴图合并为模型对比。
6. 完成容器查询、键盘/触摸、局部状态和 reduced-motion。

### 阶段 D：真实 GUI 验收

在真实组装 runtime 和设置弹窗中验证，不以孤立组件预览代替：

- 宽度：720、640、564、520、390px。
- 主题：light、dark。
- 语言：zh、en。
- 数据：empty、1 model、5 models、8+ models、超长模型名、全零、大数值、自定义 120 天。
- 状态：loading、partial error、refreshing、invalid range。
- 交互：全部筛选、键盘、触摸/点击 Tooltip、focus refresh、快速连续切换。

Playwright 截图至少覆盖：

1. 1208×835 暗色真实设置弹窗，与用户反馈截图同视口。
2. 1208×835 亮色。
3. 1024×768 暗色，自定义日期展开。
4. 窄内容 520px，8+ 模型与长名称。

同时做 DOM/像素断言：

- 设置 `.options` 与页面 section 的 `scrollWidth <= clientWidth + 1`；只有 `<520px` 时 heatmap wrapper 可局部横滚。
- 热力图、趋势路径和模型条均有非零像素，不为空白。
- SVG 轴文字 computed fill 不是默认黑色。
- 所有图表边界落在内容区内，文字与按钮无重叠。
- Tooltip 边界落在 viewport 内。
- 200% zoom 下无裁字、遮挡和不可达控件。

## 验收标准

### 必须通过

- 截图中的黑色坐标、右侧越界、底部全页横向滚动和截断指标说明全部消失。
- 默认 564px 内容宽度下，第一屏至少完整显示页头、摘要带和活动热力图。
- 页面最多只有摘要带一个“容器式卡片”，图表区不再逐块套相同边框。
- 切换活动模式或时间范围后立即请求正确参数，旧响应不能覆盖新选择。
- 500M/1B 等大数与英文 K/M/B 格式正确。
- 模型对比中 Token、占比、缓存命中、速度一行可比较，不再出现双轴误导或不满 100% 的圆环。
- 英文界面没有硬编码中文；所有控件和数据详情可通过键盘访问。
- dark/light、zh/en、empty/full/error 视觉回归通过。
- `typecheck`、Node tests、Vitest client tests、build、built-client smoke 全绿。

### 不在本次范围

- 不修改 Host records 格式、采集口径和历史数据。
- 不新增费用估算。
- 不引入第三方图表库。
- 不增加 per-session 下钻、导出或内部 LLM 调用统计。
- 不修改 Harness 设置弹窗布局或主题系统。

## 发布约束

这是 desktop-owned 插件的用户可见修复，不能只发插件 tag。实现完成后先阅读并执行 `docs/release-runbook.md`，构建细节按 `docs/packaging-playbook.md`，再推进 Desktop `v0.3.0-rc.47`。发布前必须验证 packaged profile 真实安装的 `usage-stats.tar.gz`，不能只在源码或动态预览里截图。