# 2026-08-31 runtime 同 sha 复用与后台就绪

## 问题

瘦 zip 不含 `runtime.tar.gz`。缓存原先只认 `runtime/<sha>/.ok` 与 `runtime-revision.json` 的 `runtimeTarball` 内容哈希一致。同一 harness git sha（例如 `222343c…`）重建 tar 后哈希变了，壳更新后的首启会再拉约 353MB。即便哈希确实变了、需要新树，同步 `curl` 也会把 sidecar 启动堵在看不见的下载上。

## 决策

1. **同 sha 热换**：`~/.dsh-desktop/runtime/<git-sha>/` 里已有 `dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` 即复用，不必等 `.ok` 对上新的 tarball 哈希。壳更新、harness 未动 → 0 流量。
2. **新 runtime 后台拉取、下次重启生效**：`decideRuntimeSource` 为 `download` 且本地已有任一可运行的旧 sha 树时，本会话继续跑旧树；异步 curl（`HTTPS_PROXY` / scutil Clash 7890 的 `-x`，`.part` 的 `-C -` 续传，失败不删 partial）+ 解压到目标 `runtime/<sha>/`，校验后写 `.ok`。下次启动切新树。进程内 dest lock + 串行尝试 versioned / latest URL，避免两条 curl 抢同一个 `.part`。
3. **冷启动仍同步**：没有任何本地 runtime（首装瘦 zip / 清过缓存）时同步下载或解压 bundled tar，保证能起来。DMG/NSIS 自带 tar，走解压而非网络。

## 路径对照

| 场景 | 行为 |
| --- | --- |
| 首装 DMG（resources 带 tar） | 同步解压到 `runtime/<sha>/` |
| 首装 / 无缓存瘦 zip | 同步下载（必须能起来；可有进度） |
| 壳更新、harness sha 未变 | 命中已解压树，不下载 |
| 壳更新、sha 变了、旧树仍在 | 立即用旧 runtime 起 sidecar；后台拉新，下次重启切换 |
| 更新器预置阶段 | 同 sha 已可运行则跳过预拉；否则仍在下载窗里预拉（保持 download-then-restart） |

## 不变

代理与续传：curl `-x` 来自 env / macOS scutil；`-C -` 写入 `.part`；失败不删 partial。sidecar 本会话不热切新树。
