# fork 瘦身：todo-completion-guard 出树、compaction-basic 回归上游纯净

日期：2026-10-19。分支：`feature/upstream-0.2.1-rc.2`（fork 尖端 `5f23a53e51`）。

## 背景

0.2.1-rc.2 合并完成后对 fork 剩余增量做了逐项评估（+1905/-43 行，16 个包）。两项被判定不属于 fork：

1. **`dsh-compaction-hierarchical` 桌面插件已完整独立实现层次压缩**（自带 planner/prompt/引擎，显式按 stock compaction-basic 姿态设计——`source-deps.mjs` 的 `OFFICIAL_BASELINE_DEPS` 早有记录），fork 侧 compaction-basic 内的 984 行层次栈是同构重复。插件自带 `stockOwnsHierarchy` 探测：stock 引擎有能力时让位、没有时接管——删掉 fork 侧后插件自然全时接管。
2. **`todo-completion-guard` 是纯 `agent/turn-stopping` 监听者**，与上游 in-tree 的 `repeat-tool-reminder` 同款插件形态，无任何 fork 专属扩展点依赖。按 FORK.md「优先用动态 Cordis 插件解决」的章程，它应该在插件树里。

## 变更

- fork：`compaction-basic` 整体 `git checkout dsh-v0.2.1-rc.2`（含删 fork 新增的 hierarchical*.ts 与三个测试）；`todo-completion-guard` 包删除（bundle/base 行、guard 组文档、tsconfig 引用同步）；fork 增量降为 23 文件 +820/-37。
- 本仓：新增 `plugin/dsh-todo-completion-guard`（`plugin:new` 脚手架 + 源码/测试移植）：
  - 测试从 vitest 移植到 node:test（spec 未用 `vi.*`，纯机械转换）；mock-adapter 随包 vendor（139 行），唯一外部引用改相对路径。
  - 值导入收敛：`createUserMessage` 改从 `@deepseek-ai/dsh-llm/message` 子路径深导入，tsdown 将其与三个纯工具包（util-crypto/brand/util-values）内联进产物——**零运行时 `@deepseek-ai/*` 导入**，与 fs-observation-lock 同款零 peer 姿态，宿主无需为它链接任何 runtime peer。
  - 0.2.1-rc.2 官方包 peer 面宽（dsh-session→dsh-scope、agent-loop→session-persistence/system-prompt/tools/sandbox/fs-local/fs/working-directory……），按 0.1.6 轮 §3.4b 教训用脚本循环补齐 devDeps 供出（7 轮 12 个包）。
- `prepare-runtime.mjs` 的 `FORK_MODIFIED` 缩至 12 包（去 compaction-basic、todo-completion-guard），provenance 注释同步。

## 验证

- fork：typecheck 5/5 门、受影响套件 349/349（compaction/llm-pi-ai/agent-default-model/session-models/mcp-client）。
- 插件：typecheck 0 错、test 5/5、build 产物独立加载成功。
- 组装：`DSH_RUNTIME_LOCAL_FORK=1` 重组装过全部 fail-loud 扫描；桌面实启 boot graph 全绿（含新 guard 插件）。

## 决策记录

- guard 从 fork 包转为桌面插件后，**终端 fork 用户不再默认获得它**（原随 dsh-base 组合包分发）。这是有意的取舍：fork 只保留无扩展点不可为的增量；需要该行为的终端用户可独立安装本插件。
- fork 剩余面（toolbar、web:log、mcp-client status、pi-ai 亲和头、effort 记忆、content-length、@crazx 行识别）维持评估结论：content-length 走上游 Discussion 上推，其余待上游出现对应扩展点后继续收敛。
