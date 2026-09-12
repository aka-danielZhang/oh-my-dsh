# Conventions（仓库约定）

> 本文从 AGENTS.md 迁出（2026-09-13 文档瘦身），是代码/文档约定与 Git worktree 约定的权威文档。

## Conventions

- ESM（`"type": "module"`）；插件包名无 scope，目录名 === `package.json` `name`，随仓分发（见 docs/plugin-monorepo.md）。
- client bundle 构建契约（banner/footer/externals）从 DSH `packages/client/tsdown.client.ts` 蒸馏：产物是 `window.__ModuleLoader__.load({id, factory})` 闭包；externals = 平台模块表**rc.8 起的隐式基线**（react/cordis/ui-slots/ui-primitives + runtime 豁免——rc.8 把 `web-react`/`ui-attachment`/`schema-form` 移出 PLATFORM_MODULES 改为普通内联库，并新增按包 `dsh.client.external` 声明机制；桥的镜像表见 `plugin/dsh-desktop-bridge/tsdown.config.ts` 注释）；非基线 `@deepseek-ai/*` 值 import 一律构建报错（纯度门）。基线 bump 时该镜像表必须跟着 `PLATFORM_MODULES` 核对。
- 纯函数与副作用安装分离：判定/diff 逻辑无 DOM 依赖可单测；安装函数薄壳包 effect。
- 客户端手写 `<style>` 注入必须预打 `data-plugin` + `data-plugin-css`（stock 构建模板同款，免疫写法参照 dsh-model-image-input）并做插入幂等：client-modules 的 `claimStyles` 会把一切未打标 `<style>` 认领给「下一个物化的插件」，认领方任意一次 HMR rebuilt 即经 `removeOwnedStyles` 连坐删除别人的表（2026-09-08 桥插件 rail/titlebar 样式被 ohmymemo 热构建误删事故，见 `docs/notes/2026-09-08-style-tag-claiming-hmr.md`）。
- 空不发声、缺即报错：可选服务 `ctx.get()` 处理 undefined；配置缺引用在能定位的最早点 throw。
- 组件不做订阅机械（useSyncExternalStore 等）；快照流消费在 apply 世界订阅、经闭包注入。
- 文件恰好一个行尾换行；`git diff --check` 干净。
- 非平凡变更加 Agent Note（`docs/notes/`，日期命名）记录决策与理由。

### Git worktree 约定

> 本节是**通用规范**，可原样搬运到其他仓库——只含机制与命名占位符，不含任何本机路径。生命周期一图流见 `docs/diagrams/git-worktree-lifecycle.html`。

- **位置与命名**：worktree 建在仓库的**同级目录**（仓库根目录的上一级，两者是兄弟目录），目录名 `<repo>-<topic>`，分支名 `feature/<topic>`，`<topic>` 与目录后缀一致（本仓现行实例：`dsh-desktop-ohmymemo`/`feature/ohmymemo`、`dsh-desktop-session-thread`/`feature/session-thread`）。**不在仓内嵌套 worktree**：会污染 glob/grep 检索与 workspace 类工具的包识别，还得往 `.gitignore` 加豁免；同级目录方案两者皆免。
- **创建**：主仓内执行 `git worktree add -b feature/<topic> ../<repo>-<topic>`（同名分支已存在则去掉 `-b`）。簿记由 git 自动记在主仓 `.git/worktrees/<name>/`——内部状态，禁止手改；同一分支同一时刻只能被一个 worktree checkout（git 强制）。
- **依赖不共享**：每个 worktree 是独立 checkout，依赖目录（node_modules、构建产物、语言环境）各自安装与构建；包管理器链接、锚点与外部指向均按各自路径解析，互不干扰。
- **清理**：分支合并后 `git worktree remove ../<repo>-<topic>`，再 `git worktree prune` 清陈旧簿记；不要 `rm -rf` 了事（会留悬空元数据）。git 会拒绝删除含未提交改动或未跟踪文件的 worktree，确认丢弃才允许 `--force`。`git worktree list` 随时盘点。
- **Agent 会话注意**：仓库规范文件（如 AGENTS.md）随会话工作区根注入——在 worktree 里干活时，读写（含文档与源码）必须落在对应 worktree 目录，别把主仓 checkout 当唯一事实源；跨 worktree 只经 git（分支/合并），不直接互拷文件。
