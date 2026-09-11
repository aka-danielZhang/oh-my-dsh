# 上游同步兼容适配 Playbook 与 worktree 硬性纪律（2026-09-11）

## 决策

1. 新增 `docs/harness-bump/README.md` 作为可复用的「上游同步兼容适配 playbook」：官方 harness 发新 release 后，fork 合并上游 → 发新 zw 层 → 本仓 bump revision/插件适配 → 发版的完整流程契约。此前该流程只散落在 AGENTS.md 的纪律段落与各次 `<基线>/README.md` 一次性记录里，没有可复用的执行手册。
2. 把 **worktree 纪律**写成 playbook 第 0 节硬性条款，并同时约束 fork 仓与本仓（桌面端）：一切修改在仓库同级目录的 `feature/<topic>` worktree 内进行（目录 `<repo>-<topic>`、依赖独立安装）；修改与测试全绿后合并回各自 main；**发布动作（npm publish、打 tag、push tag）只在合并后的 main 上执行**；合并且发布全部成功才 `git worktree remove` + `prune` 清理，失败保留现场并报告路径与分支名。
3. AGENTS.md「基线锁定（上游线纪律）」段落追加该执行方式与 playbook 指针（契约同 PR 修订）。

## 理由

- 上游基线升级是本仓风险最高的批量变更（runtime 全树重组装 + 15 个随包插件适配），过去直接在主 checkout 上进行：中断后 main 处于半适配态，既不能发版也难回滚；worktree 让 main 恒保持「可发布」语义，失败现场隔离在旁路分支。
- 发布与修改分离：tag/npm publish 只落在 main，杜绝「worktree 半成品被推上更新链」的事故面（此类事故无法经更新入口自愈，用户只能手动下载）。
- 与既有 AGENTS.md「Git worktree 约定」（同级目录、独立依赖、git-only 跨 worktree、remove+prune 清理）完全同构，不引入第二套规范。
- 每日定时巡检任务（ZCode automation，每天凌晨 1 点检查母仓 release）按同一 playbook 执行，prompts 内联同样的硬性条款并指向该文件，保证人机两条执行路径契约一致。

## 后续

- playbook 的检查矩阵（聚焦测试、`plugins:check`、`prepare-runtime` 扫描、desktop smoke）按各次基线记录的经验增量修订；`<基线>/README.md` 落地记录若发现 playbook 缺项，同 PR 回填。
