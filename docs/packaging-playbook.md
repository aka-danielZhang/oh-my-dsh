# Oh My DSH 打包手册（macOS / Windows）

面向「打出一个能在别的 mac 上跑的安装包」的完整操作指引。改流程先改本文件。

0.3.0-rc.1 起宿主是 **Electron**（`src/` + electron-builder）。0.2.x Tauri 壳已从仓内删除；已装 0.2.x 不能热更新到 0.3.x。

## 0. 前置条件（构建机）

- macOS + Apple Silicon（当前只打 aarch64）**或** Windows 10/11 x64（NSIS）
- Node 22+ / pnpm（`packageManager` 钉版本）；Electron 版本钉在仓根 `package.json`
- **runtime 在哪台机器组装就只能给哪台 OS 用**（native 模块按 Electron ABI rebuild）。不要把 mac 的 `runtime/build` 拷到 Windows，反之亦然。
- runtime 组装只依赖**公有** fork 仓库（`runtime/revision.json` 的 repo）

## 1. 一键打包

```sh
pnpm desktop:build
```

先跑 `pnpm run desktop:prepare`（`scripts/prepare-desktop-bundle.mjs`）：

1. 构建桌面自有插件：bridge、hierarchical compaction、Web Search toggle、model-image-input、send-while-running（默认 typecheck+test+build；`DSH_DESKTOP_PREPARE_MODE=build` 时只 build，发版用）；
2. 组装 runtime（`scripts/prepare-runtime.mjs`，SHA 键控缓存）；
3. 按当前 Electron 版本 `electron-rebuild` native 模块；
4. 打 `src/resources/runtime.tar.gz`（**不含** `tools/node`）及各插件 tarball；
5. `scripts/build-electron.mjs`：esbuild 打 main.cjs → electron-builder 出平台包。

产物：

- macOS：完整 `release/Oh-My-DSH-<ver>-arm64.dmg`（含 `runtime.tar.gz`）；**瘦** updater zip（electron-builder 只打 DMG；`scripts/slim-mac-updater-zip.mjs` 从已签 `.app` 剥 runtime 后写 zip + `.blockmap` + 完整 `latest-mac.yml`）
- 两个平台都另放 `release/runtime-<sha>-<platform>-<arch>.tar.gz` 与 `runtime-revision-<platform>-<arch>.json`，给瘦 zip / 缓存未命中时按 sha 补拉；发版同时把同一份 tar 切成 npm 分片（`scripts/publish-runtime-npm.mjs`），OTA 优先从 npm/pnpm registry 拉
- Windows：完整 `release/Oh My DSH-<ver>-setup.exe`（NSIS 仍自带 runtime，离线能装）

`src/resources/` 与 `dist-electron/`、`release/` 均 gitignored。

### 安装窗口外观（DMG 背景与布局）

- `src/dmg/background.png`（660×400）+ `background@2x.png`（1320×800）—— 由 `scripts/generate-dmg-background.py` 生成。electron-builder 26 用 1x 像素定窗口，再和 `@2x` 合成 hidpi TIFF；只放一张 1320×800 的 `background.png` 会把 Finder 窗撑成 2 倍。
- `electron-builder.yml` 的 `dmg.window` / `dmg.contents` 钉 660×400 与图标坐标（180,196）/（480,196）。

流水线在公证前运行 `scripts/verify-dmg-layout.sh <dmg>`。

## 2. 包结构与首启解压（原理）

runtime 与三个桌面自有插件以 **tar.gz 资源**进包（不是散目录拷贝）：runtime 树是 pnpm 安装产物（3k+ 符号链接），electron-builder 对目录 extraResources 不承诺保链接（解引用拷贝会让 .pnpm store 膨胀到 GB 级）；tar 往返链接感知。此外 tarball 方案让 App Translocation 不再影响可写性（解压到 home 后树恒可写），并允许 prepare 在归档前对 runtime 树里的每个 Mach-O 统一签名。注意 notarytool 会展开扫描 tarball，归档本身不能隐藏未签名二进制。

Mac 热更新 zip **不含** `runtime.tar.gz`（sha 未变时不必再传约 115MB）。DMG / NSIS 仍自带，离线首装不变。打包态 `releaseRuntimeDir`：`.ok` 哈希命中 → 用 `~/.dsh-desktop/runtime/<sha>`；否则抽包内 tar；再否则先拼 npm 分片、失败再按 `runtime-<sha>-<platform>-<arch>.tar.gz` 从该次 GitHub Release 下载并校 sha256。`ready` / 重启要求本版 zip 与对应 runtime 都已就绪。瘦 zip、revision JSON、npm 分片与这条补拉必须同发，否则 OTA 用户会撞上 `bundled tarball missing`。

首次启动时壳把资源原子解压到 home：

```
~/.dsh-desktop/
  runtime/<sha>/{dsh,tools}     ← runtime.tar.gz 解压，.ok 标记完整
  bridge/{package.json,lib,cordis.patch.yml}  ← bridge.tar.gz 解压
  plugins/dsh-compaction-hierarchical/{package.json,lib,cordis.patch.yml,preset-snippet.yml,README.md}
                                      ← compaction-hierarchical.tar.gz 解压
  plugins/dsh-web-search-toggle/{package.json,lib,cordis.patch.yml,README.md}
                                      ← web-search-toggle.tar.gz 解压
```

解压是「临时目录 + sentinel 校验 + rename 原子晋升」——半截解压不会被当作完整 runtime。缓存是**内容寻址**的：`.ok` 标记存 tarball 的 sha256（哈希写进 `runtime-revision.json`），同 revision 但内容变了（组装变更、任一插件重建）只会自动重解压对应目录；哈希命中秒过。

三个插件 archive 都刻意不带 `node_modules`。壳在 `plugin add` 之后补 runtime-owned peer 链接：bridge 链 `@deepseek-ai/cordis`；hierarchical compaction 链 package.json 声明的六个 Harness peers；Web Search toggle 链 Host/Client 使用的 Cordis、settings、credentials、Typert、tools、system-prompt、locale/runtime/settings/slots peers。目标优先取 runtime 的 hoisted 包，回退到排序后的 `.pnpm` 实例，并 canonicalize 到 loader 同一 real path；这样既解决 Node ESM peer 解析，又避免 Cordis/Service/Typert 注册表因模块副本分裂。链接指向旧 revision 或悬空时会自愈重指；真实 dev 依赖目录不动，且 compaction/Web Search toggle 只在 shell-owned `.ok` 目录上受管。

sidecar runtime 解析顺序（`find_runtime`）：`$DSH_DESKTOP_RUNTIME` → 仓库 `runtime/build/<sha>`（dev 主路径）→ 包内资源解压树（仅 release）→ DSH 源码 checkout（dev 兜底）。桌面插件分别由 `find_bridge`、`find_compaction_plugin` 与 `find_web_search_toggle_plugin` 解析 env override → release resource → dev tree。

## 3. 体积参考（Electron + Chromium）

旧 Tauri / WKWebView 公证包约 160MB。Electron 会更大；去掉第二份 `tools/node` 后目标 **公证包 < 250MB**，超标要单独解释。

## 4. 本机验证

```sh
# e2e 冒烟（scratch home，不污染真实 ~/.dsh；探针走 gate→badge DOM→save_file IPC 往返）
DSH_HOME=$(mktemp -d) DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 \
  pnpm desktop:dev
echo "exit=$?"   # 0 = 通过
```

打包后再验安装包：

```sh
DSH_HOME=$(mktemp -d) DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 \
  "release/mac-arm64/Oh My DSH.app/Contents/MacOS/Oh My DSH"
echo "exit=$?"   # 0 = 通过
```

**强制走资源分支并隔离壳状态**：使用已打包应用、全新的 OS Home / DSH Home / Electron user-data，避免真实缓存掩盖缺依赖。不要移动开发 runtime，也不要删除正式 `~/.dsh-desktop/runtime`。

```sh
DSH_SMOKE_ROOT=$(mktemp -d)
mkdir -p "$DSH_SMOKE_ROOT/os-home" "$DSH_SMOKE_ROOT/data"
env -u DSH_DESKTOP_RUNTIME -u DSH_CHECKOUT \
  HOME="$DSH_SMOKE_ROOT/os-home" DSH_HOME="$DSH_SMOKE_ROOT/data" \
  DSH_DESKTOP_E2E_PROBE=1 DSH_DESKTOP_E2E_EXIT=1 \
  "release/mac-arm64/Oh My DSH.app/Contents/MacOS/Oh My DSH" \
  --user-data-dir="$DSH_SMOKE_ROOT/electron"
echo "exit=$?"   # 0 = 探针通过；新增插件仍须做专项加载和功能验证
```

同时检查并清除测试进程继承的 `DSH_DESKTOP_*_PLUGIN`、`DSH_DESKTOP_BRIDGE`、`DSH_WEB_LOG_DIR` 等路径覆盖，不能让它们重新指向正式目录。Windows 用独立测试账号或虚拟机隔离 `%USERPROFILE%` 和应用数据。

**已有 Profile 场景**：空 Home 验证之外，另用隔离目录中的既有 Profile 快照验证 `file:` / `link:` 插件及 home patch。复制前退出有关进程，排除凭据和无关私密数据；检查绝对路径、软链接及 Store root 覆盖，确保所有写入都留在测试目录。不要拿真实 Home 做未经验证插件的首次安装测试。

首次启动会解压 runtime tar，日志有 `extracted bundled runtime <sha>` 一行。隔离环境中验证开窗、建会话、下载桥、外链、通知及新增插件，再做完整退出重启。正式 Profile 接入须在备份和用户确认后进行，详见 [Desktop 插件接入与故障恢复](desktop-plugin-integration.md)。

## 5. 分发与 Gatekeeper

**签名+公证**：产物为 Developer ID 签名 + Apple 公证版，`spctl -a -vv -t install` 应答 `source=Notarized Developer ID`。electron-builder 保持 `mac.notarize: false`（只签 `.app` 再打 dmg）。瘦 zip 由 slim 从 `.app` 生成后再公证。CI 随后跑 `scripts/notarize-mac-artifacts.sh`：zip（OTA）和 DMG（安装盘）**并行** `notarytool submit --wait`，再 staple + `spctl` DMG。两份文件 hash 不同，必须两张 ticket；并行只把墙钟从相加变成 `max`。只 staple 会因「Record not found」失败。DMG Finder 校验必须在公证前提交结束（不要对同一 DMG 同时 `hdiutil attach` 与 `notarytool`）。校验用临时 venv 装 `ds-store`，不要 `pip --user`（macos-latest 的 Homebrew Python 是 PEP 668，会拒装）。

一次完整公证构建的环境变量：

```sh
export DSH_CODESIGN_IDENTITY="Developer ID Application: <团队名> (TEAMID)"   # runtime 内 Mach-O 签名
export CSC_NAME="$DSH_CODESIGN_IDENTITY"                                    # electron-builder 签 .app/.dmg
export APPLE_ID="<Apple ID 邮箱>"
export APPLE_APP_SPECIFIC_PASSWORD="<App 专用密码>"
export APPLE_TEAM_ID="<TEAMID>"
pnpm desktop:build -- --mac   # 内含 slim-mac-updater-zip：公证的是瘦 zip
bash scripts/notarize-mac-artifacts.sh release/*.dmg release/*.zip
```

发版流水线设 `DSH_DESKTOP_PREPARE_MODE=build`，只 build 桌面自有插件（typecheck/test 已在 CI 跑过）。本地默认仍全量验证。

凭据清单：Developer ID Application 证书（p12 导入钥匙串 + Apple G2 中间证书 `DeveloperIDG2CA.cer` + `security set-key-partition-list` 授权 codesign）、Team ID、App 专用密码。**ASC「个人 API 密钥」不能用于 notarytool**。

公证实测踩过的坑（已固化进构建）：

1. **hardened runtime 强制**：`electron-builder.yml` `mac.hardenedRuntime: true`；
2. **公证扫描钻进 tar.gz**：runtime 里 esbuild 等 Mach-O 全要 Developer ID 签名——prepare-desktop-bundle 打 tar 前自动签（`DSH_CODESIGN_IDENTITY` 门控；JIT 二进制带 allow-jit entitlements，见 `scripts/entitlements-runtime.plist`）；
3. **zip 与 DMG 各交一次、并行等**：`scripts/notarize-mac-artifacts.sh`。electron-builder 不再阻塞公证 `.app`。DMG-only 本地仍可用 `scripts/notarize-dmg.sh`。

无证书降级通道仍有效（ad-hoc + `xattr -dr com.apple.quarantine`）。`productName`/`appId` 已随签名生效，改名等于换应用。

分发通道推荐：curl 直链（最优）> 自建 brew tap > 浏览器直下（已公证，弹窗点「打开」即可）。

## 6. 升级 runtime / Desktop-owned 插件版本

1. runtime 升级时，fork 侧打标签：`git tag v<基线>+zw.<n> <sha> && git push origin <tag>`，再更新本仓 `runtime/revision.json`（repo/ref/sha）。
2. Desktop-owned 插件升级时，更新插件源码版本及 prepare 的精确版本断言，并同步 `src/resources`、壳解压/安装链、runtime peer 链接与文档。
3. 提升 Desktop 版本并执行 `pnpm desktop:build`。prepare 会重新生成相应 tarball 与内容哈希；壳按哈希换解压目录，旧缓存不再被引用。

插件的独立 GitHub Release 不会替换已安装 Desktop 包内的资源，也不会更新用户 Web Profile。只要 Desktop-owned 插件版本变化，就必须发布新的 Desktop；Web Search toggle 0.1.3 首次由 Desktop `0.2.0-rc.14` 携带。

## 7. 已知边界

- **架构**：macOS 只打 aarch64；Windows 只打 x86_64 NSIS currentUser。分发时确认对方机器架构。
- **验证机的「干净」标准**：没有 DSH checkout、没有本仓库 clone 的机器才是目标用户画像——装了 dev 环境的机器会走 source 兜底掩盖打包缺陷。
- **首启解压窗口**：~500MB 解压约 10–20s，窗口出现前有一段无反馈等待（后续可在窗口加启动进度）。
- **Mac 热更第一次整包**：`electron-updater` 差分前提是 `~/Library/Caches/oh-my-dsh-updater/update.zip`。DMG 安装没有这份缓存。从「带 runtime 的旧 zip」升到瘦 zip 的那一次也会整包或差量很差，再下一版（两份都是瘦 zip）才明显变小。不要删 updater 缓存。`disableDifferentialDownload` 禁止打开。
- **Chromium 不单独拆包**：Mac 公证不允许只热换 `app.asar`。第二次起靠 zip blockmap 跳过未改的 Electron Framework。
- **tar**：解压用系统 `tar`（macOS/Windows 10+ 自带 bsdtar；Linux 上一般也有）。GNU tar 对 `C:\...` 需要 `--force-local`；Win11 bsdtar 3.8.4 不认此选项。prepare 与壳按 `tar --help` 探测。
- **runtime 不可跨 OS**：在 mac 组装的树不能打进 Windows 安装包。
- App Translocation：从 DMG 直接拖进 /Applications 不触发；但**直接在 DMG 挂载卷里双击运行**会触发只读随机路径——解压方案对此免疫（写入目标是 home），行为仍推荐拖装。

## 8. Windows 本机验证

前置：Node 22+、pnpm。源码 sidecar 需要 DSH checkout（`DSH_CHECKOUT` 或与本仓平级的 `../deepseek-harness`）。

```powershell
# dev
$env:DSH_CHECKOUT = "D:\dev\deepseek-harness"   # 若默认路径不存在
pnpm desktop:dev

# 打包（本机组装 Windows runtime，约数分钟到十几分钟）
pnpm desktop:build
# 产物：release/Oh My DSH-<ver>-setup.exe
```

e2e（PowerShell）：

```powershell
$env:DSH_HOME = Join-Path $env:TEMP ("dsh-e2e-" + [guid]::NewGuid())
$env:DSH_DESKTOP_E2E_PROBE = "1"
$env:DSH_DESKTOP_E2E_EXIT = "1"
pnpm desktop:dev
echo "exit=$LASTEXITCODE"   # 0 = 通过
```

强制走资源分支：把 `runtime\build` 改名、删 `%USERPROFILE%\.dsh-desktop\runtime` 后再跑安装包里的 `Oh My DSH.exe`。

无 Authenticode 时 SmartScreen 可能弹「无法验证发布者」——点「仍要运行」即可。NSIS 是 currentUser，不弹 UAC。证书怎么买、怎么接到 CI，见 §9。

## 9. Windows Authenticode（SmartScreen）

这和 **electron-updater** 的更新包校验不是同一把钥匙。updater 管「这个包是不是我们发的」；Authenticode 管「Windows 认不认这个发布者」。缺 Authenticode **不挡安装**，只是浏览器下载会警告。

**不能自签。** openssl 造的证书 Windows 不当成发布者，SmartScreen 照样红。SSL 网站证书也不能用来签 exe。必须买 **Code Signing**（代码签名）证书。

### 怎么买（2023-06 之后的现实）

CA 不再给可随意导出的 PFX：新证私钥必须在硬件（USB token）或云 HSM 里。个人/小团队三条路：

| 路线 | 适合 | 备注 |
|---|---|---|
| **Azure Trusted Signing**（推荐新买） | 没有旧 PFX、要在 GitHub Actions 签 | [Azure 文档](https://learn.microsoft.com/en-us/azure/trusted-signing/)：订阅 + 身份核验（护照等）。私钥不出云。CI 走 `signCommand` + `artifact-signing-cli`，不是下面的 PFX 流程；接好 Azure 后再改 release.yml。 |
| **还能导出 PFX 的 OV/EV** | 公司 2023-06 前买的旧证，或 CA 提供云导出 | DigiCert / Sectigo / SSL.com 的 **Code Signing**，不是 SSL。EV 更贵、SmartScreen 立刻绿；OV 要靠安装量养信誉。 |
| USB token EV | 本机签、不走 CI | GitHub Actions 拿不到插在你电脑上的 token，不适合本仓库的 tag 发布流。 |

本仓库已接好的是 **PFX 路径**（和 macOS 的 p12 secret 同一形态）。本机证书库目前是空的，需要你买到证之后把 PFX 填进 GitHub Secrets。

### 拿到 PFX 之后

1. 把 `.pfx` 编成一行 base64（PowerShell）：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('D:\certs\dsh-desktop.pfx')) | Set-Clipboard
```

2. GitHub → 本仓 Settings → Secrets and variables → Actions，加两条：

| Secret | 内容 |
|---|---|
| `WINDOWS_CERTIFICATE` | 上一步剪贴板里的 base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | 导出 PFX 时设的密码 |

3. 再发 `v*` tag（如 `v0.3.0-rc.1`）：`desktop-windows` job 把 PFX 写成 `CSC_LINK` / `CSC_KEY_PASSWORD`，electron-builder 签 NSIS。secret 为空则跳过、打未签名包。

本机验证：

```powershell
$env:CSC_LINK = 'D:\certs\dsh-desktop.pfx'
$env:CSC_KEY_PASSWORD = '…'
pnpm desktop:build -- --win
```

没证书的机器必须仍能打未签名包。
