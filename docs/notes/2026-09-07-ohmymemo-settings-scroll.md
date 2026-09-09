# 2026-09-07 · dsh-ohmymemo：设置页滚动姿态重做——交还 stock 面板统一滚动

## 背景

用户反馈设置页「滚动下侧非常丑、底部遮挡」。根因是插件在 stock 滚动容器里又自开了一个内部滚动区：

```
.panel  height: min(800px, 100vh - 48px)                     ← SettingsRoot.module.css
  .options  flex:1; overflow-y:auto; padding:0 24px 24px     ← stock 唯一滚动容器
    .omm-root  height:calc(100vh - 208px); max-height:min(680px, 100vh-168px); min-height:480px
      .omm-body  flex:1; overflow:auto; padding-right:4px    ← 插件第二个滚动容器
```

三个丑点：

1. **底部硬切**：`.omm-body`/`.omm-cards` 无底部留白，最后一张记忆卡滚到底被滚动容器底边直接裁掉；stock `.options` 的 `padding-bottom:24px` 因内容在内滚区里而完全失效。
2. **嵌套滚动**：矮视口下 `min-height:480px` 使 `.omm-root` 超过 `.options` 可用高度（panel 高 − 54px header − 24px padding），外层被迫出现第二条滚动条；平时也是插件这条滚动条贯穿面板、贴内容右缘仅 4px。
3. 自定高度唯一真正的需求方是「记忆空间」tab 的双栏（`.omm-space{height:100%}` 需要确定高度祖先）——概览 tab 根本不需要内部滚动。stock 的 General/Models 各 section 均不开内部滚动，本页是仓内唯一自创滚动容器的 section。

## 决策

- **方案 A（交还外层滚动）而非方案 B（保留内滚精修）**：与 stock 各 section 行为一致、代码更删更简、双滚动条彻底消失；B 的高度公式要跟着 stock panel 尺寸走，stock 改版即漂移。
- `.omm-root` 删 `height/max-height/min-height`，自然高度随内容；`.omm-body` 删 `flex:1; overflow:auto; padding-right:4px`，滚动交还 `.options`——滚到底由 stock 的 24px padding 自然留白。
- `.omm-space` 由 `height:100%` 改为自定高度 `height:min(520px, calc(100vh - 320px)); min-height:320px`——双栏（树/查看器）各自内部滚动的前提保住，又不劫持整页；矮视口下 min-height 兜底，超出时由 `.options` 单层滚动。
- 未采纳可选的 `.omm-tabs` sticky 增强：保持最小改动。

## 影响面

- `src/client/styles.ts` 三条规则（`.omm-root`/`.omm-body`/`.omm-space`）；`.tsx` 结构零改动，host 半零改动，持久 schema 零改动。
- 验证：typecheck / 152 项单测 / tsdown build 全绿；待实机回归——概览 tab 任意窗口高度仅面板一条滚动条、滚到底卡片与面板底边有 24px 留白、记忆空间双栏各自滚动、<520px container 移动布局与模型选择器弹层不回归。
