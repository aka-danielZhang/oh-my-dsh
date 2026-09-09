# rc.41 发布流水线失败：npm 分片脚本的 node:os 误导入与 Release-only 步骤的 CI 盲区

2026-09-09 · 修复随 Desktop 0.3.0-rc.42 发布

## 事故

`v0.3.0-rc.41` 的 Release workflow 在 macOS 与 Windows 两个 job 的「Publish runtime tarball to npm」步骤失败：

```
scripts/publish-runtime-npm.mjs:14
import { mkdtempSync, tmpdir } from 'node:os'
        ^^^^^^^^^^^
SyntaxError: The requested module 'node:os' does not provide an export named 'mkdtempSync'
```

构建产物与签名已完成，发布步骤炸在模块链接期，GitHub Release 未创建（`releases/latest` 仍指向 rc.40，已装客户端不受影响）。

## 根因

1. **直接原因**：`mkdtempSync` 是 `node:fs` 的 API，被误从 `node:os` 导入。ESM 对内置模块的具名导入在链接期校验，脚本根本没跑起来。
2. **流程原因**：`publish-runtime-npm.mjs` 是 `218109e`（runtime npm 分片热更）新增的，只在 Release workflow 的 npm-token 步骤里执行——main 分支 CI 从不触碰。rc.41 是第一个包含它的 Release，发布流水线成了它的首次执行点，链接错误在主干上游零拦截。

## 修复

- `mkdtempSync` 移入 `node:fs` 导入列表，`node:os` 只留 `tmpdir`。
- 新增 `scripts/publish-runtime-npm.test.mjs`（node:test，随 `shell` job 的既有脚本测试跑）：动态 import 触发链接校验 + 断言导出 + `splitFileIntoChunks` 字节切分行为——**Release-only 脚本的链接错误自此在 main CI 失败，而不是发布时**。
- `.github/workflows/ci.yml` 的 `shell` job 增加该测试步骤。

## 遗留

- `v0.3.0-rc.41` 成为死 tag（无 Release 对象）：不移动已推送的 tag，rc.42 直接接续发布。`releases.atom` 只列已发布 Release，空 tag 对更新器不可见、无毒化。
- 经验：给 Release workflow 增加任何脚本步骤时，必须在 main CI 有对应执行面（import 冒烟或行为测试），否则发布流水线就是第一现场。
