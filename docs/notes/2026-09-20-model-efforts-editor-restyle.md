# 2026-09-20 — dsh-model-efforts-editor 弹层对齐 stock 视觉

日期：2026-09-20。涉及插件：`dsh-model-efforts-editor` 0.1.5（desktop-owned）。

## 症状

设置 → 模型 → 自定义设置里，点模型行的档位按钮弹出的编辑层看起来像一张临时 HTML 表单：macOS 原生勾选框压在深色卡片上、输入框是浏览器默认控件、三段模式钮挤成 11px、底下一颗系统蓝「应用」。和旁边 `dsh-model-image-input` 的菜单、以及 mcp-settings 的分段控件完全不在一个视觉系统里。

## 根因

`styles.ts` 用了一套不存在的 token 名（`--dsw-text-primary`、`--dsw-bg-elevated`、`--dsw-border-subtle`、`--dsw-primary` …），只能落到硬编码 `#1f1f1f` / `rgba(127,127,127,.35)` 和 `accent-color`。sibling 图片输入菜单从第一天就走 `--dsw-alias-*` + `--dsw-shadow-lv3`，还自己画勾选，所以两边并排时档位层特别扎眼。`CHECK_SVG` 早就写在 `inject.ts` 里，从未挂上。

## 决策

只改皮肤，不改三态语义、写入路径、fail-invisible 锚定：

1. **token 与 sibling 对齐**：弹层、行按钮、输入、错误色全部改走 `--dsw-alias-*` / `--dsw-shadow-*`，禁止硬编码色。行按钮改 26px，和图片输入钮同高。
2. **原生控件退场**：档位勾选用隐藏 checkbox + 主题方块 + 已有勾选 SVG；Z.ai 改成 web-search / Thread 同款 32×18 开关，标题/说明拆开；模式三段抄 mcp-settings 的 inset segmented（layer-1 底、选中 layer-3 + shadow-lv1）。
3. **弹层本身可滚**：七档不再在 196px 里单独出滚动条，弹层 `max-height: calc(100vh - 16px)`，切换「跟随默认 / 不推理」时 `place()` 重算。
4. **单测守门**：`SECTION_CSS` 导出，断言不含 hex/rgb、不含旧 token 名。

行为契约不变：`off` 可留空、自定义模式至少一档、写入仍是 revision-fenced 整组 `models` 数组。

## 验证与分发

- 包内 `pnpm run test` + `pnpm run typecheck` + `pnpm run build`。
- 实时预览：构建产物拷入 `~/.dsh-desktop/plugins/dsh-model-efforts-editor/lib/`（web profile 以 `link:` 指向该目录，`/plugins/.../client.js` 为 `no-cache`，刷新即生效）。
- 版本 0.1.4 → 0.1.5。正式发布随下一次桌面 `v*` 的随包事务带出；手工覆盖届时被新 tarball 顶替属预期。
- 样式注入保留 0.1.4 的 `data-plugin` / `data-plugin-css` 预打标与插入幂等（2026-09-08 HMR 连坐事故）。
