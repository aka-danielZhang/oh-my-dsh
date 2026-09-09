# 2026-09-09 runtime 走 npm/pnpm 源，更新原子切过

## 问题

瘦 zip 的 ~350MB runtime 一直从 GitHub Releases `curl`。国内网络下每次点更新都要卡很久；即使用户已经有旧 runtime，`ready` 仍被这一下挡住。另一头，若为了快而「先换壳、runtime 下次再生效」，会把新壳和旧/缺失 runtime 拼在一次重启里——那不是同一版 payload。

## 决策

1. **下载源：npm/pnpm 优先，GitHub 回落。** 组装树仍不是客户端可 `pnpm install` 的 workspace（prepare-runtime 的 file: tarball / unique-symbol 纪律不变）。发布时把同一份 `runtime.tar.gz` 切成 <100MB 的 `@crazx/dsh-desktop-runtime-<triple>-<i>@<桌面版本>` 分片（`payload.bin`），壳按用户 `.npmrc` / `DSH_RUNTIME_REGISTRY` / npmmirror / npmjs 拉分片、拼接、校 sha256，失败再走原来的 GitHub URL + `DSH_UPDATE_MIRROR`。字节与 GitHub 附件相同。
2. **发现即预拉，点击仍等待。** `check_update` 一经 `available` 就按该版 `runtime-revision-<platform>-<arch>.json`（平台分文件，避免 mac/win 互相覆盖哈希）后台预拉。点下载时多半缓存命中，但 **`ready` 必须等本版 shell zip 和对应 runtime 都落盘**。
3. **切过原子。** `planAtomicUpdateReady`：缺 zip、或缺「本版 sha 已解压可启动的 runtime 树」都不得 `ready`。仅有 tar 缓存不够（重启后新壳仍可能回落旧 sha）。旧 sha 树不能顶替新 revision。预置把 tar 解到 `runtime/<sha>/` 并写 `.ok`；`install_update` 再复核一次，未就绪即拒绝 `quitAndInstall`。失败留在旧版，可重试。
4. **Windows NSIS 仍自带 tar**，不预置。冷启动瘦 zip（无任何本地树）仍同步拉 runtime，保证能起来。

## 不做什么

不在用户机器上重跑 `prepare-runtime`。不把 350MB 整包直接 `npm publish`（registry 100MB 上限）。不把 `latest-mac.yml` 改到镜像（sha512 仍以 GitHub 为准）。

## 验证

- `src/runtime-registry.test.ts`：分片往返、registry 顺序、原子 ready 判定、mac 下载/安装门。
- `src/runtime-artifact.test.ts`：revision JSON URL、既有 boot 回落/预置跳过、loopback 不走代理。
- `src/runtime-update.integration.test.ts`：本地 HTTP registry 按 npm tarball URL 提供分片 → curl 下载（故意带死代理）→ concat → sha256 → 解压后才 ready；哈希不匹配 / 缺分片失败；async + abort；zip 内 revision 不能被旧 sha 树顶替。
- 发版：平台 job 发布 npm 分片并上传 `runtime-revision-<triple>.json`；`desktop-publish` 校验两侧 revision 附件。
- 未覆盖：已打包 Electron 对 GitHub/`npmjs` 的真机 OTA（需正式 Release 附件）。
