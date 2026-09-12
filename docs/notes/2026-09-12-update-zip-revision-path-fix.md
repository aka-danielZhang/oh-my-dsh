# 2026-09-12 更新 zip 清单路径修复（desktop 0.3.0-rc.55）

## 事故

rc.54 发布后用户首次真正走应用内热更（此前 rc.50–rc.52 均手动 DMG 安装），下载完成后报：

```
update zip has no runtime-revision.json: …/pending/Oh-My-DSH-0.3.0-rc.54-arm64.zip
```

状态机按设计落在 `failed`（zip 本身校验通过，是预置阶段拒判）。

## 根因

- electron-builder `extraResources: { from: src/resources, to: resources }` 的 `to` 相对
  `Contents/Resources`，所以清单实际打包在 `Contents/Resources/resources/runtime-revision.json`；
  壳自己运行时的读取面（`paths.ts resourceDir()` → `process.resourcesPath/resources`，
  即 `extract.ts` / `runtime.ts` / `plugins.ts`）全部按这个嵌套布局消费，安装态一切正常。
- #38（热更新原子切换）新增的 `readBundledRevisionFromZip()` 却写死了
  `*/Contents/Resources/runtime-revision.json`——少了 `resources/` 段，**自合入起从未匹配过
  任何一版 zip**。单测用的是同一错误假设的 flat 布局，所以测试也没拦住。
- 今天是 #38 之后第一次应用内热更，缺陷首次暴露。

## 修复

- `readBundledRevisionFromZip` 先按真实布局
  `*/Contents/Resources/resources/runtime-revision.json` 读，回落接受 flat 旧路径。
- 单测改为嵌套布局用例 + 保留 flat 回落用例；另用真实 rc.54 zip 实测通过
  （sha `7f3abc07…`，runtimeTarball 与 Release 附件 `runtime-revision-darwin-arm64.json` 一致）。

## 影响与恢复路径

- 坏的读取器在**已安装壳**里，重试/重下都无解：rc.52–rc.54 用户需手动 DMG 装 rc.55 一次，
  之后的自动更新恢复正常。rc.55 runtime 基线未变（7f3abc07），老用户本机已预置，
  更新只需拉壳 zip。
- runbook §4 已补排查行。
