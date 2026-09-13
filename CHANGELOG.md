# Changelog

Oh My DSH 桌面端的面向用户变更。插件各自有包内 CHANGELOG 的，不在这里重复。发版时 `scripts/release-notes.mjs` 抽取对应 `## [version]`（没有则回退 `## [Unreleased]`）写入 GitHub Release 与 `latest-mac.yml` / `latest.yml` 的 `releaseNotes`。

## [Unreleased]

## [0.3.1-rc.2] - 2026-09-13

### Changed

- 「记忆」设置的「每日时间」换成与定时任务一致的双列滚轮选择器：点开是小时/分钟两列滚轮（无滚动条、当前值居中高亮），框内显示的时间与两列中心精确对齐（原先的原生时间输入框观感差且文字不对齐）。随包 dsh-ohmymemo 升级到 0.3.1。

## [0.3.1-rc.1] - 2026-09-12

### Fixed

- 修复每次打开设置面板时「使用统计 / MCP / 记忆」三枚语义图标先闪一帧齿轮再变色的问题：面板每次打开都会重新挂载，壳先画出兜底齿轮，而图标插件的补画原先挂在 60ms 去抖定时器之后，总是晚一两帧才生效。现改为在 DOM 观察回调（微任务）内同步补画——它跑在浏览器绘制之前，图标在面板首帧即已就位。随包 dsh-settings-icons 升级到 0.1.1。

## [0.3.0-rc.60] - 2026-09-12

### Fixed

- 「定时任务」的模型选择与对话框对齐：触发器现在显示「模型 · 强度」（如 `GLM-5.3-Flash · Max`），点开是「模型 / 推理等级」两级菜单——模型列表按供应商分组并显示真实模型名，切换模型后强度自动跟随重置；推理等级行始终存在（模型未声明档位时显示 `Default`）。同时修掉了档位恒为空的问题（读取了错误的档位字段）。随包 dsh-scheduled-tasks 升级到 0.1.2。

## [0.3.0-rc.59] - 2026-09-12

### Changed

- 记忆系统改为「索引优先」的读法：对话开头注入的记忆从整份正文换成「索引指针 + 每个范围最相关的几条一行摘要」，并给出本地索引文件路径，agent 需要正文时用 read/grep 按需自取——注入体积约减半，未置顶的记忆（如工作区事件、近期动态）也能被检索到。
- 移除「搜索记忆 / 回读记忆」两个工具：grep 和读文件本就是更自然的检索方式，同时少了一类工具参数报错面；「记住 / 修改 / 忘记」三个写入工具保留，凭据拦截与权限门控不变。
- 记住内容后不再立刻向对话重发整份记忆（原来每写一次就多耗一步消化系统注入），改为只在下一轮对话开始时对账更新；本会话自己写入引起的变更不再重复注入。
- 「修改记忆」不再要求先查内容哈希：从记忆文件头部读 revision 即可提交；显式携带哈希时仍做防覆盖校验。中文标签不再导致写入失败（尽力规范化，无法规范化的丢弃）。
- 旧记忆库零迁移，升级后直接可用。随包 dsh-ohmymemo 升级到 0.3.0。

## [0.3.0-rc.58] - 2026-09-12

### Fixed

- 修复「定时任务」入口按钮在正式版不显示的问题：入口按钮的定位锚点（会话搜索框的无障碍标签）在真实界面里失配，导致按钮永远画不出来——开发预览阶段用的是另一条已验证的定位路径所以只在预览里正常。现恢复为预览验证过的「会话标题文本定位 + 向上找工具栏行」策略，无障碍标签作为主路径、文本定位作为回退。随包 dsh-scheduled-tasks 升级到 0.1.1。

## [0.3.0-rc.57] - 2026-09-12

### Fixed

- 按用户评审撤销 rc.54 的更新入口交互改动：更新控件恢复原形态——平时隐藏，仅在有可安装更新 / 下载中 / 下载失败时出现在侧栏开关旁；流程恢复为定时后台检查 → 亮起下载图标 → 点击弹窗下载 → 完成后「稍后 / 重启以更新」。随包 dsh-desktop-bridge 升级到 0.2.0-rc.18（代码与 rc.16 相同，仅版本号走动）。

## [0.3.0-rc.56] - 2026-09-12

### Fixed

- 修复记忆检索必失败的问题：agent 调用「记忆搜索」工具（memory_search）时，只要搜到结果就报「invalid output: value.hits[N].score is not a declared property」。原因是工具声明的输出格式漏写了实现恒带的 score 排名字段，运行时按声明严格校验、多出字段即拒绝——该缺陷自记忆工具上线起就存在，只是空结果能过校验、记忆注入/梦境提取等主链路不走这道校验，所以直到今天才有会话真正踩中。随包 dsh-ohmymemo 升级到 0.2.4 补齐声明，并把全部记忆工具的真实输出接进与运行时同款的契约测试，防再犯。

## [0.3.0-rc.55] - 2026-09-12

### Fixed

- 修复应用内更新在下载完成后必然失败的问题：更新预置阶段读取新版本 zip 内 `runtime-revision.json` 的路径少了一层 `resources/`（应用实际打包位置是 `Contents/Resources/resources/`），于是进度走满后报「update zip has no runtime-revision.json」。该缺陷随热更新原子切换（#38）引入，此前在用版本都没真正走过应用内热更所以一直没暴露。受影响的用户请手动下载安装本版一次，之后的自动更新恢复正常。

## [0.3.0-rc.54] - 2026-09-12

### Fixed

- 修复更新入口「看起来坏了」：桌面工具栏的更新控件改为常驻。此前没有待安装更新时该控件完全隐藏，发布新版后最长要等 2 小时的自动检查才会亮起，期间应用里没有任何手动检查更新的途径；现在随时可以点它立即检查更新，查无新版时短暂显示「当前已是最新版本」。发现新版本后也改为先弹窗展示版本号与更新说明、点「下载更新」确认后才开始下载，避免误触大流量下载；窗口长期在后台导致定时检查被系统节流跳过时，回到窗口会自动补一次检查。随包桥插件升级到 0.2.0-rc.17。

## [0.3.0-rc.53] - 2026-09-12

### Added

- 新增随包插件 `dsh-scheduled-tasks`（0.1.0）：侧栏会话区标题行的时钟按钮进入「定时任务」面板——五类调度（每小时第 N 分 / 每天 / 工作日 / 每周 / 每月）的定时任务创建、编辑、暂停与立即运行，任务绑定工作区、权限与模型；到期自动创建会话执行指令，可暂停、可查看运行历史并跳转会话，同一会话跨期复用。随包插件清单由 15 个增至 17 个。
- 新增随包插件 `dsh-settings-icons`（0.1.0）：设置导航中「使用统计 / MCP / 记忆」三项由兜底齿轮换成各自的语义图标（三柱统计 / 插头 / 记忆），仅替换图标绘制，不改动其他设置项。

## [0.3.0-rc.52] - 2026-09-12

### Changed

- runtime 基线升级到 fork `v0.1.5-rc.2+zw.1`（上游 `0.1.5-rc.2`：消息反馈提交对称化与界面打磨、代码文件图标 artwork 提取重构、交付卡片网格规格细化；全部插件依赖基线同步，插件行为零变更）。

## [0.3.0-rc.51] - 2026-09-11

### Added

- 新增随包插件 `dsh-copy-session-id`（0.1.0）：会话头部右上角「⋯」菜单里在「下载 Session 日志」之上增加「复制会话 ID」一项，点击即把当前会话 ID 写入剪贴板（异步剪贴板优先、textarea `execCommand` 回退，成功短暂显示「已复制会话 ID」，悬停可见完整 ID）；原「下载 Session 日志」项与下载状态弹层保留（下载中置灰、成功后 5 秒自动关闭），通过官方 `sessionLogDownload` 服务消费，官方 `/export` 命令触发的下载状态同样显示。随包插件清单由 14 个增至 15 个。

## [0.3.0-rc.50] - 2026-09-11

### Changed

- runtime 基线升级到 fork `v0.1.5-rc.1+zw.2`。

### Fixed

- 修复 OpenCode Go（Console Go）报 `MissingSessionID` 400 的问题：`opencode-go` 目录路由及 opencode.ai 端点现在默认携带 `x-opencode-session` + `x-client-request-id` 会话亲和头，零配置生效；显式配置 `sessionAffinityHeaders` 仍可覆盖，空数组表示退出。
- 工具链统一 pnpm 11.7.0，插件 overrides 迁移到 pnpm-workspace.yaml 并关闭 peer 自动安装，避免 @crazx peer 打穿到官方 registry。

## [0.3.0-rc.49] - 2026-09-10

### Changed

- runtime 基线升级到 fork `v0.1.5-rc.1+zw.1`（官方 `0.1.5-rc.1` + fork 增补，npm 层 `@crazx/*@0.1.5-rc.1.zw.1`）。

### Added

- 统一 macOS 工具栏随 rc.1 新布局恢复：会话标题簇与右栏角落 portal 进工具栏宿主，旧运行时自动回退原位标题头。
- 模型路由新增 `sessionAffinityHeaders` 配置：向亲和网关（如 OpenCode Go）按会话发送路由/缓存头，三条 API 路径统一生效。
- 文件观察记录插件现随安装自动激活，并修复跨 fork 证据越权与会话 ID 文件名碰撞两类安全问题。

### Fixed

- dsh-thread 会话状态读取改用公共快照 API，修复类型报错。
- 发送中 Stop 按钮改用框架标准 hooks，真实界面上恢复渲染。
- 供应商余额监听正确的凭据更新事件，密钥轮换后立即刷新缓存。
- 用量统计移除不存在的测试运行时注入；随包插件清单更新为 14 个。


### Changed

- 「模型质量」图例现在可以切换指标：点击“缓存命中”或“输出速度”后只显示对应柱形、坐标轴与悬浮详情，再次点击当前指标恢复双柱对比；支持鼠标和键盘操作。
- 一分钟内的平均调用时长改用秒显示（例如 `41 s`），不再笼统显示“小于 1 分钟”；页头刷新按钮同步为记忆页同款 28px 工具栏按钮。

### Fixed

- 修复「模型用量」把模型聚合桶当作数字累加，导致 Token 显示为 `—`、占比显示 `NaN%` 且圆环为空的问题；聚合层现读取真实 Token 字段，客户端同时对非有限占比做降级保护。

## [0.3.0-rc.47] - 2026-09-10

### Changed

- 「设置 → 使用统计」回归设置面板既有的卡片式仪表盘（dsh-usage-stats 0.1.2）：四项摘要恢复为独立卡片，趋势改为多模型平滑折线，补回模型质量双指标柱图，并保留热力图卡和模型用量圆环排行。52 周热力图现在随卡片等比缩放，窄窗口不再出现横向滚动条，悬浮与键盘定位仍准确。
- macOS 统一工具栏收敛为更轻的双簇布局（dsh-desktop-bridge 0.2.0-rc.16）：删除无需求的会话后退/前进、Workspace pill 与运行面切换图标；左侧只保留可点击的侧栏开关、通知、条件更新与收起态新会话，标题和会话动作紧跟会话列左缘，Thread 与右栏开关固定在最右侧并使用与左侧图标一致的 2px 间距。侧栏展开/收起及条件更新出现时，标题按实际控件宽度避让，不再遮挡、漂移或留下多余空档。

## [0.3.0-rc.46] - 2026-09-10

### Fixed

- **修复 rc.45 桥插件整体加载失败**（急需升级：rc.45 上外链路由、下载、通知、更新入口全部失效，且看不到更新按钮，请手动下载本版）：统一工具栏版 bridge 在 runtime 基线仍为 0.1.5-alpha.1+zw.1/zw.2 时注册 `shell.toolbar` 槽被拒，连锁导致整个桥加载失败。现注册改为防御式——旧 runtime 上工具栏静默缺席、其余能力全部保留、恢复 rc.13 带内布局；本版同时把 runtime 基线升到 `v0.1.5-alpha.1+zw.3`（工具栏布局基座 + 会话后退/前进历史），工具栏正常启用。
- 附带修复 dev 实例与正式版争单实例锁而静默退出的问题（unpackaged dev 使用独立 userData）。

## [0.3.0-rc.45] - 2026-09-10

### Added

- 全新「设置 → 使用统计」一级页（dsh-usage-stats，首次随桌面发货）：累计 Token、平均缓存命中、平均输出速度、平均调用时长四卡；Token 活动热力图（每日/每周/累计）；每日 Token 趋势、模型质量对比（缓存命中+输出速度分组柱）与模型用量环图，均支持悬浮数据卡；时间范围独立过滤（近 7 天 / 近 30 天 / 自定义起止日期）联动趋势、质量与用量三看板。数据采集自本机会话日志并自动回填最近 30 天，零 harness 改动，不含费用估算。

### Changed

- macOS 标题带重构为统一工具栏（bridge 0.2.0-rc.14 重写语义）：工具栏成为窗口布局的真实第一行——左侧栏开关、会话后退/前进、新会话，中间为当前会话标题（从正文顶部原位投射），右侧运行面切换、更新与通知入口；红绿灯嵌在工具栏左端预留区内，工具栏空白处可拖动窗口。收起侧栏时标题不再被任何图标遮挡；正文顶部与工具栏的重复标题随之消失，多视图页签仍留在正文顶部。右栏全屏模式保持原行为。

## [0.3.0-rc.44] - 2026-09-09

> rc.41–rc.43 三个 tag 因发布流水线问题未出片（npm 分片脚本导入错误、预发布缺 dist-tag、CHANGELOG 小节缺失）；本版为 rc.40 之后首个正式发布版，包含其间全部变更。

### Changed

- 热更新改为原子切过：先把本版 shell（瘦 zip）和对应 runtime 都下载并校验完毕，才进入「重启以更新」。缺一边不会换壳。发现新版本后即后台预拉 runtime，点下载时多半只需补瘦 zip。
- runtime 补拉优先走 npm/pnpm 源（用户 `.npmrc` / 国内镜像 / npmjs 的分片包），失败再回落 GitHub Releases。国内网络下不必再整包硬拉 GitHub。
- macOS 标题带重排（bridge 0.2.0-rc.13）：中间栏与右侧栏内容顶到窗口上沿，消灭标题带下的空条；右侧栏页签条进入顶部带，拖拽条改为按按钮位置挖洞的分段式，不再吞掉带内按钮的悬停与点击；右栏全屏模式接管整个窗口，页签避开红绿灯、页签条本身可拖动窗口；收起侧栏时对话标题让出红绿灯区域。
- 「设置 → 记忆」标题旁新增 Beta 预览角标，标记记忆功能当前为预览版（OhMyMemo 0.2.3）。

### Fixed

- 本机 / `127.0.0.1` registry 下载不再走 `HTTP_PROXY`，避免企业代理把 loopback 劫持成超时。
- 记忆设置页连续修改配置后点开记忆文件报「memory file index changed」内部错误的问题（OhMyMemo 0.2.2）：内容未变化的派生视图不再被重写，页面目录过期时自动刷新并重试一次，不再需要手动点刷新。
- 发布流水线三处修复：npm 分片脚本的 `node:os` 误导入、预发布版本缺显式 dist-tag、Release-only 脚本与 CHANGELOG 覆盖检查补入主干 CI。

## [0.3.0-rc.40] - 2026-09-09

### Added

- 记忆系统 OhMyMemo 随桌面首发（第 13 个随包插件）：设置页新增「记忆」面板（概览 / 记忆空间 / 梦境记忆定时整理与提取模型选择），会话内提供 `memory_*` 工具族（搜索 / 回读 / 记住 / 修订 / 遗忘，root Agent 写权限门控）；存储为 `$DSH_HOME/ohmymemo` 下一记忆一 Markdown（YAML frontmatter），跨进程写锁、revision+hash CAS 与原子发布保证手编与工具写并发安全。
- Thread 交接的承接会话现在继承来源会话的模型选择（provider/模型/推理档位），不再落到「新建会话默认模型」：授权时读取来源会话的当前选择并验证路由（模型已不可用时明确报 `source-model-unavailable`，绝不静默降级），激活时以 `model/selection` 事件写入目标会话——刻意不走 `selectModel` 通道，避免每次交接悄悄改写全局默认模型。来源会话从未选过模型时维持部署默认（与来源实际行为一致）。

### Changed

- 运行时基线随 fork 升级：`0.1.2-rc.1+zw.2` → `0.1.5-alpha.1+zw.2`（fork tag `v0.1.5-alpha.1+zw.2`，npm `@crazx/*@0.1.5-alpha.1.zw.2`；zw.2 修复了 zw.1 发布包 peer 依赖不可解析的问题，桌面全部依赖直接落在 zw.2）。会话日志自动迁移 V2 → V3：系统提示成为持久事件、序号引用重映射，旧世代文件原样保留。**V3 不承诺降级读取**：回滚方式是恢复升级前的完整备份，而不是用旧版打开已迁移数据。
- 随包插件全部适配 0.1.5 运行时：`dsh-client-runtime` 聚合入口删除后改为按服务的显式 owner 导入；层次压缩兼容 Provider 在检测到新版 stock 已内建层级时完全委托；Web Search 开关对 `system-prompt/assemble` 异步全局瀑布的适配；MCP 设置 / 模型图片输入 / 档位编辑器 / 运行中补位 Stop / Thread / OhMyMemo 同批跟进。

## [0.3.0-rc.39] - 2026-09-08

### Fixed

- 修复桌面端标题带控件（侧栏开关 / 通知中心 / 新会话气泡）"飘"在窗口左上角、被原生红绿灯叠压：客户端手写 `<style>` 注入现预打 `data-plugin`/`data-plugin-css` 标记（桥 0.2.0-rc.10、运行中补位 Stop 0.2.1、推理档位编辑器 0.1.4、Thread 源码同步修复），不再被 client 模块系统的 HMR 簿记误认领、进而在其他插件热重建时被连坐删除。受影响版本重载窗口即可恢复显示。
- 新增仓库约定：客户端插件手写样式表必须预打 `data-plugin` 标记并做插入幂等（决策见 `docs/notes/2026-09-08-style-tag-claiming-hmr.md`）。

## [0.3.0-rc.38] - 2026-09-08

### Fixed

- 修复 rc.37 安装或更新后卡在「Failed to load plugins / loader fibers failed」：推理档位和图片输入插件补齐 `remote` 与 `remote.settings` 两项服务声明，两插件升至 0.1.3。保留模型设置写入修复，无需清空配置或聊天数据。
- 发布前新增实际客户端插件产物的 Cordis 加载、重复挂载和卸载测试，并验证漏掉任一 Remote 服务声明时测试必定失败。

## [0.3.0-rc.37] - 2026-09-08

### Fixed

- 修复模型设置卡内「推理档位」与「图片输入」两个内联编辑器的写入按钮报「写入失败：Cannot read proper…」：上游 0.1.2 运行时移除了 `connection.api` 门面，两个插件的写入调用在发出请求前就抛 `Cannot read properties of undefined (reading 'settings')`。现改走 typed `remote.settings.mutate`（dsh-thread 同款姿势），档位/图片声明对所有模型（含手动添加的 GPT-6-Astra 这类新模型）恢复可写；两插件升 0.1.2。

## [0.3.0-rc.36] - 2026-09-07

### Fixed

- 修复全新安装后「创造模式」加载失败：运行时升级到 `v0.1.2-rc.1+zw.2`，fork 的 npm 包保留配置和代码使用的原始依赖名称，通过 npm alias 引用 fork 实现。无需清空用户数据或额外重启来补装依赖。
- 发版冒烟新增四种内置模式的实际 Agent 挂载和工具注册检查，在隔离数据目录连续启动两次，防止「插件安装成功，但模式不可用」再次漏检。
- 冒烟探针使用标准 file URL，兼容 Windows 的 ESM 加载规则。rc.35 因该测试路径问题未正式发布，本版包含其全部修复。

## [0.3.0-rc.34] - 2026-09-07

### Fixed

- 修复 Windows 首装时目录插件添加后锁文件未同步导致事务回滚：在隔离事务内刷新锁文件，再执行冻结校验。rc.33 因 Windows 冒烟失败未正式发布，本版包含其全部修复。
- 首次接管已有 DSH 数据时，从安装包的 revision manifest 读取插件名单，不再访问打包后不存在的源码目录。
- 随包加入适配当前运行时的 MCP Settings 0.2.6；全新安装即可使用「设置 → MCP」，随包清单共 12 个插件。
- 开发启动按随包清单构建插件并保留构建失败；无构建脚本插件的本地 prepare 与裸源码插件的 tsx 冒烟解析路径保持一致。安装冒烟改用桌面真实事务，并验证重复启动幂等。

## [0.3.0-rc.32] - 2026-09-07

### Added

- 桌面安装包随包插件从 7 个扩展到 11 个：新增 branding、fs-observation-log、provider-balance、reasoning-efforts 四个此前需要手动 `dsh plugin add` 的插件。全新环境首次启动即获得完整插件集；已有 Profile 下次启动自动补装缺失插件，无需手动操作。provider-balance 保持裸源码分发形态（runtime tsx 直载 TS），打包清单经新增的 `dsh.desktop.pack` 覆盖显式声明，不再假设 `lib/` 布局；无构建脚本的插件在 prepare 与 CI 名单校验中按 `--if-present` 跳过。
- `mcp-settings` 本次暂不入包：其 tsc/vitest 解析表还锚在旧 harness 基线（rc.1 重组移除了 `packages/client/runtime`），移植完成前继续手动 `dsh plugin add dsh-mcp-settings`。

## [0.3.0-rc.31] - 2026-09-04

### Changed

- Runtime 钉到 `v0.1.2-rc.1+zw.1`（`1b138a9e5b403a00f942cc90d3650d6584926cdc`，官方 `dsh-v0.1.2-rc.1`，fork [PR #13](https://github.com/aka-danielZhang/deepseek-harness/pull/13)）。0.1.2 用 `seq` / `eventAt()` / `snapshotEvents()` 取代 `Session.events`，并区分 `SessionSeq` 与 `SessionLogOffset`；`dsh-thread` 已改读 `snapshotEvents()`。`@crazx/*@0.1.2-rc.1.zw.1` 已上 npm。
- 运行中且草稿有内容时，composer 主按钮保持发送、整行没有停止入口。本版随包装入 `dsh-send-while-running` 0.2.0：该状态在发送旁补一颗红色 Stop（点击即中断当前回合），草稿清空后自动退场。0.1.x 的孪生 Send 作废（stock 已能在运行中发送）。
## [0.3.0-rc.30] - 2026-09-03

### Fixed

- 修复启动即弹「Failed to load plugins / dsh-thread: cannot get property "remote.session" without inject」：dsh-thread 0.2.0-rc.6 在 client 入口 inject 补声明 `remote.session` 点号子路径（stock session-controller / ui-plan 同款姿势）。cordis 4 把每个 Remote namespace 挂成独立服务 `remote.<namespace>`，不在 inject 里声明的服务任何 fiber 都解析不到；rc.5 改走 `ctx.remote.session` 时漏了这行声明，类型检查与单测均无法暴露。0.3.0-rc.29 受影响用户升级本版即恢复，无需手动操作。

## [0.3.0-rc.29] - 2026-09-03

### Fixed

- 修复从未创建过 Web Profile 的用户首次启动失败：Desktop 现在会先在事务 shadow home 中创建 `profiles/web`，再补 Profile scaffold 和安装随包插件，不再因写入不存在的 `cordis.patch.yml` 父目录而报 `ENOENT`。失败仍在 sidecar 启动前完整回滚，真实 DSH Home 不会留下半成品。
- 修复 Thread 交接点击「在 Thread 中继续」报 `Cannot read properties of undefined (reading 'sessions')`：harness 0.1.2 移除了浏览器端 `connection.api` 门面，dsh-thread 0.2.0-rc.5 改走 typed Remote `ctx.remote.session.create/rename`（保留承接会话继承来源 preset 的契约），并把 devDeps 全量钉到 0.1.2-alpha.3 基线让 typecheck 重新守门。已在 rc.28 上卡住的交接草稿，升级后刷新页面重新点击即可继续。

## [0.3.0-rc.28] - 2026-09-02

### Removed

- 移除「问题刻度尺」插件（dsh-question-rail）：上游 harness 0.1.2-alpha.3 起在 ui-chat 原生内置了 Turn 导航轨道（滚动视口右缘、阅读线跟随高亮、悬停问题预览、点击跳转），功能完全覆盖本插件。已装用户如需手动清理，可执行 `dsh plugin --profile web remove dsh-question-rail`。

## [0.3.0-rc.27] - 2026-09-02

### Fixed

- 修复 rc.23 – rc.26 全部无法启动的问题，rc.27 是 Thread 进包后第一个能正常启动的版本。两层根因：rc.23/24 是 `dsh-thread` host 产物外置 `zod` import、桌面解包姿态解析不到（rc.25 内联修复）；rc.25/26 是 thread 仍调用 0.1.2 runtime 已删除的 `settingsNamespace()`（`dsh-thread` 0.2.0-rc.4 改为 `register` 直接收命名空间字符串）。⚠️ rc.23 – rc.26 界面起不来、无法应用内更新，请从 Releases 手动下载本版覆盖安装。
- 发布链新增 packaged 冒烟门（#34）：发货同款 tarball 解压、按壳同款链接 runtime 依赖、逐个 import host 入口、空 home `plugin add` 后 `--dump-config`——「CI 源码树绿、解压产物对着钉死 runtime 起不来」这一类事故在发布前即拦截。

## [0.3.0-rc.26] - 2026-09-02

### Added

- 问题刻度尺（dsh-question-rail 0.6.0）滚动跟随绑定：你停在哪个用户问题上，对应刻度就常亮品牌色，随滚动自动移动；滑到最近 10 条之外的老问题时，刻度窗口自动滑过去把当前问题留在尺上；展开列表里当前问题的条目同步高亮，首次展开直接定位到当前问题。

## [0.3.0-rc.25] - 2026-09-02

### Fixed

- 修复 rc.23 / rc.24 无法启动：`dsh-thread` host 产物外置的 `zod` import 在桌面解包姿态（无 node_modules、仅链接八个 harness peer）解析不到，loader 两个 entry 全挂、web profile boot 中止、sidecar 起不来。`dsh-thread` 0.2.0-rc.3 起 zod 内联进 host bundle（web-search-toggle 同款姿势）。⚠️ 已装 rc.23/rc.24 的机器界面起不来、无法应用内更新，请从 Releases 手动下载本版安装。

## [0.3.0-rc.24] - 2026-09-02

### Added

- Thread 交接进入安装包（desktop-owned 七包 → 八包）：`dsh-thread` 0.2.0-rc.2 随壳首启幂等装入 web Profile。显式跨会话 Handoff——agent 在阶段边界起草携带结论/产物/待办的 Thread 草稿，经你在 Thread 面板确认后在同一工作区开新会话续接；「设置 → 通用 → Thread」总开关（默认开）统一门控工具与看板 UI。
- 交接卡片状态持久化：创建成功后按钮从「在 Thread 中继续」变为「打开 Thread 会话」（点击跳转并自动展开 Thread 看板），刷新后状态不丢、不再误建重复会话；失败态给「重试」。
- Thread 设置开关对齐 Web Search 词汇：32×18 原生语义开关、双语文案、300ms pending 延迟消除切换闪烁。

### Fixed

- 运行面切换确认框的插件计数文案（"六个包"已是第二次滞后）改为不提数字。

## [0.3.0-rc.21] - 2026-09-02

### Fixed

- 切运行面不再 `loadURL` 裸端口：窗口加载 sidecar 打印的 `?token=` URL，避免 0.1.2 的 `authentication required`。
- 旧 sidecar 只打印不带 token 的 `dsh web:` 行时仍能就绪；有 token 行时优先 token。
- runtime 里已经不存在的插件 peer（0.1.2 删掉的 `dsh-client-runtime`）跳过，不再整进程扔。
- Runtime 升到 `v0.1.2-alpha.3+zw.2`：`dsh-client-modules` 认出 `@crazx` 换 scope 再发布，HTML 能预加载 `client.js`。未改动的 fork 包按 zw 层向下找已发布版本。

## [0.3.0-rc.20] - 2026-09-02

### Fixed

- prepare-runtime 的 fork 名单对齐 0.1.2 发布面：卸已删除的 `dsh-host-apiproxy`，改钉已发布的 `dsh-api-session-controller`。rc.19 因此装不出 runtime。

## [0.3.0-rc.19] - 2026-09-02

### Changed

- Runtime 升到 `v0.1.2-alpha.3+zw.1`。0.1.2 起 `dsh web` 的 index 要一次性 `?token=` 兑换 cookie，壳改为解析 sidecar 打印的回环 URL，不再探 `GET /`。
- `dsh-web-search-toggle` 0.1.4，以及 mcp-settings / reasoning-efforts：对齐 0.1.2 删除的 `settingsNamespace()` / `installSettingsSection`。

## [0.3.0-rc.18] - 2026-09-01

### Fixed

- 模型设置行的按钮布局修复（dsh-model-image-input 0.1.1 / dsh-model-efforts-editor 0.1.1）：stock 模型行是固定 4 列 grid，两个插件各注入一个按钮后列模板竞争——展开钮溢出卡片右缘、删除钮被挤到隐式第二行换行。两插件统一改为给行加 flex 规则，按钮占固有宽度、输入框按 1.4:1 分剩余宽度并优先收缩，任意按钮数量共存都不再溢出/换行。

## [0.3.0-rc.17] - 2026-09-01

### Fixed

- 问题刻度尺（dsh-question-rail 0.5.1）：展开/收起动画丝滑化——刻度层与列表层常驻叠加、宽度只做「抽屉揭示」（内容不再瞬时切换、不在窄容器里挤压重排），两层交叉淡入淡出；展开后滚动位置跨悬停保持。

## [0.3.0-rc.16] - 2026-09-01

### Changed

- 问题刻度尺（dsh-question-rail 0.5.0）：刻度与展开条目一一对应——共用 32px 槽位网格，侧边第 i 个刻度和展开后第 i 个问题在同一个位置，鼠标悬停时面板原地加宽、条目就在刻度原位显字，零跳动；槽距变大更好点按；去掉了「我的问题」标题栏。面板里往上滑补载更早问题、点击跳转高亮均保持不变。

## [0.3.0-rc.15] - 2026-08-31

### Changed

- 问题刻度尺（dsh-question-rail 0.4.0）：侧边刻度保持最近 10 条；悬停展开的面板现在是完整问题列表——在面板里往上滑到顶部就自动补载更早的问题（逐页 50 条），直到历史全部就位，补载时阅读位置不动。打开会话本身不再触发任何历史加载，正文的「加载更多」节奏完全恢复原生；只有你在面板里主动往上滑，历史才会进来。点击刻度/条目跳转高亮不变。

## [0.3.0-rc.14] - 2026-08-31

### Changed

- 问题刻度尺（dsh-question-rail 0.3.0）：刻度与列表改为严格时间正序（此前补载历史后新旧问题会颠倒）；只展示**最近的 10 条提问**，正文恢复原生懒加载节奏——不再打开会话就把历史全部拉进来，仅当当前窗口不足 10 条时才在后台有界补页；点击刻度/条目时若目标还没加载，会自动补载到目标再平滑跳转高亮。

## [0.3.0-rc.13] - 2026-08-31

### Changed

- 问题刻度尺（dsh-question-rail 0.2.0）：打开长会话即刻度尺后台自动载入全部历史（每页 50 条，上限 2000 条），所有提问的刻度一两秒内全部就位，不再需要先往上滑点「加载更多」；每页落地时阅读位置不动。历史被完整载入后「加载更多」按钮自然消失，往上滑即纯滚动；超过上限的会话在面板标题提示「更早的未载入」。

## [0.3.0-rc.12] - 2026-08-31

### Added

- 新插件「问题刻度尺」（dsh-question-rail）随桌面分发：会话里你的提问（含回合中插话）达到 6 条时，对话左缘出现一把垂直居中、无背景的等距刻度尺；鼠标悬停展开可上下滑动的问题列表（原生菜单观感），点击刻度或条目平滑滚动跳转到对应消息并短暂高亮。刻度尺随正文/输入框一起参与布局运动，侧栏收起展开不割裂；终端 `dsh web` 与普通浏览器同一条路可用。

`v0.3.0-rc.11` 的打包流水线漏装新插件依赖而失败，没有 GitHub Release。

## [0.3.0-rc.10] - 2026-08-31

### Fixed

- macOS 热更新「重启以更新」不再静默失败：后台保留的关窗拦截此前挡住了更新退出序列，ShipIt 一直等不到进程退出、安装交换被搁置（实测 78 分钟），重启后看似更新失败。
- Mac 热更新在就绪前预置新版 runtime：此前 slim zip 的运行时留到重启后首启才下载，主进程阻塞且没有任何窗口与进度，慢网络下数分钟「装死」。现在下载阶段即把 runtime 拉取到本地并校验（进度在下载窗可见、可取消），重启后秒级回起；预置失败则留在旧版报「下载失败」可重试，绝不带着缺失运行时重启。
- 更新下载窗的图标块不再转圈，展示静态应用图标。

## [0.3.0-rc.9] - 2026-08-28

### Fixed

- 退出后台服务时等整棵进程树结束再继续，不再留下比主进程晚死几秒、占着固定端口的插件子进程（典型症状：切换运行面后新运行面一启动就报「端口被占用」退出）。
- 后台服务一启动就崩溃时立即回退并弹窗告知原因（含退出码/信号与端口占用排查提示），不再空等两分钟、窗口看起来像死了。

## [0.3.0-rc.8] - 2026-08-28

### Fixed

- macOS sidecar 的 `DSH Node.app` 复制后改为 ad-hoc 重签。此前 Developer ID + Hardened Runtime 的 stub 换了 Info.plist 会被系统 SIGKILL，日志空白，启动空等 120 秒。

## [0.3.0-rc.6] - 2026-08-28

### Changed

- Mac 热更新 zip 不再重复携带未变的 runtime tarball；DMG 仍可离线安装。已热更过一次后走 zip 差分，日志在 `~/.dsh-desktop/logs/updater.log`。
- 自动更新走系统代理 / `HTTPS_PROXY`；可选 `DSH_UPDATE_MIRROR` 加速 GitHub 大文件下载，失败回落官方 Release。

`v0.3.0-rc.5` 在瘦 zip 重打 blockmap 时失败，没有 GitHub Release。

## [0.3.0-rc.7] - 2026-08-28

### Added

- 运行面切换：右键点击侧栏 Oh My DSH 图标 / 字标 →「切换运行面…」，选择 `$DSH_HOME/profiles` 下的运行面目录（需含 Web 界面层；首次切换会自动装入桌面组件），确认后后台服务自动重启、窗口自动重载。会话、设置与凭据全部保留，下次启动沿用所选运行面；目标运行面异常时自动回退默认运行面。
- 更新下载窗：点击更新按钮弹出下载窗，实时进度条（未知大小时为不定态动画），支持「取消下载」；下载完成窗内切「稍后 / 重启以更新」并展示更新说明，收起窗后下载继续、完成时自动重开。

### Changed

- 发现新版本不再自动后台下载：更新按钮出现后需点击才开始下载，安装仍需就绪后的显式确认——下载与安装各自单飞、两级授权。

## [0.3.0-rc.5] - 2026-08-28

### Changed

- Mac 热更新 zip 不再重复携带未变的 runtime tarball；DMG 仍可离线安装。已热更过一次后走 zip 差分，日志在 `~/.dsh-desktop/logs/updater.log`。
- 自动更新走系统代理 / `HTTPS_PROXY`；可选 `DSH_UPDATE_MIRROR` 加速 GitHub 大文件下载，失败回落官方 Release。

## [0.3.0-rc.4] - 2026-08-28

### Fixed

- macOS sidecar 改为 LSUIElement helper 子进程，同事机没有 clang 时也不再出现两颗 Dock 图标。

## [0.3.0-rc.3] - 2026-08-28

### Fixed

- macOS 打开应用时 Dock 不再闪一颗马上消失的图标（sidecar 不再 `setsid` 成第二份 `.app`）。
- 更新说明按 GitHub HTML 收成标题/列表；标题带已下载勾可点，不再被拖窗条抢走点击。
- 自动更新只认 GitHub `releases/latest`，不再因空的 `-rc` tag 刮 atom 而静默失败。
- 测试与 `desktop:dev` 不再把共享 `node-shim` 写成死路径（云之家登录 ENOENT）。

### Changed

- 新增模型档位编辑器插件：设置 → 模型的每条自定义模型行内可直接编辑推理档位组合、各档线上值与 Z.ai 线缆格式，改档位不再需要手工编辑 settings.yaml 或重新发版。

## [0.3.0-rc.2] - 2026-08-27

### Fixed

- 新建会话时 agent 附着的短暂 running 脉冲不再发「回合已完成」。
- 启动或切工作区灌入会话列表时，不再把历史会话刷进通知中心。
- macOS 上 Bash 等工具不再在 Dock 冒出通用 exec 图标。

### Changed

- 新增模型档位编辑器插件：设置 → 模型的每条自定义模型行内可直接编辑推理档位组合、各档线上值与 Z.ai 线缆格式，改档位不再需要手工编辑 settings.yaml 或重新发版。

- Tauri 壳从仓库删除；Electron 升为正职 `src/`。图标与 DMG 背景随壳走。

## [0.3.0-rc.1] - 2026-08-25

### Changed

- 桌面壳换成 Electron（Chromium）。macOS 用 `hiddenInset` 标题栏；通知带应用身份，点击回到窗口。
- 自动更新改为 `electron-updater`。0.2.x Tauri 用户须手动下载。
- macOS 关窗后壳与 sidecar 留在后台（通知仍会响），Dock 点回来；Cmd+Q 才退出。
- 0.3.x Release 仍放一份 `latest.json`，让 0.2.x 看到换壳说明而不是端点 404；不能热更新，须手动下载。

### Added

- 标题带通知中心。切到其他应用或非当前会话时发系统通知，点击打开对应会话。

### Fixed

- macOS DMG 安装窗按 660×400 出，不再被 2x 背景像素撑成 1320×800。


## [0.2.0-rc.23] - 2026-08-24

### Fixed

- Overlay 标题栏下，带内控件相对红绿灯上漂（WKWebView 根滚动器的自动 content inset）。

## [0.2.0-rc.22] - 2026-08-22

### Changed

- 运行中发送按钮的 Stop 态改为主题柔和红，与蓝色 Send 区分。

### Fixed

- 规范化更新包资源名，避免 updater URL 对不上附件。
