/**
 * Small presentational primitives shared by the Quno sidebar, settings page
 * and message cards. Token-only styling; no business state.
 *
 * @module dsh-quno/client/ui
 */

import React from 'react'
import { QUNO_MARK_DATA_URI, QUNO_MARK_DATA_URI_DARK } from './quno-mark.tsx'

/** One bordered surface. */
export function Card(props: { readonly children: React.ReactNode; readonly title?: string; readonly aside?: React.ReactNode }): React.ReactElement {
  return (
    <section style={styles.card}>
      {(props.title !== undefined || props.aside !== undefined) && (
        <header style={styles.cardHeader}>
          <span style={styles.cardTitle}>{props.title}</span>
          <span style={styles.cardAside}>{props.aside}</span>
        </header>
      )}
      {props.children}
    </section>
  )
}

/** A label/value row. */
export function Field(props: {
  readonly label: string
  readonly hint?: string
  readonly children: React.ReactNode
}): React.ReactElement {
  return (
    <label style={styles.field}>
      <span style={styles.fieldLabel}>{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span style={styles.fieldHint}>{props.hint}</span>}
    </label>
  )
}

/** A compact status dot + text. */
export function Status(props: { readonly tone: 'ok' | 'warn' | 'error' | 'idle'; readonly text: string }): React.ReactElement {
  return (
    <span style={styles.status}>
      <span style={{ ...styles.dot, background: toneColor(props.tone) }} />
      {props.text}
    </span>
  )
}

function toneColor(tone: 'ok' | 'warn' | 'error' | 'idle'): string {
  switch (tone) {
    case 'ok': return 'var(--dsw-alias-state-success-primary)'
    case 'warn': return 'var(--dsw-alias-state-warn-primary)'
    case 'error': return 'var(--dsw-alias-state-error-primary)'
    case 'idle': return 'var(--dsw-alias-label-tertiary)'
  }
}

/** Section heading inside a tab. */
export function SectionTitle(props: { readonly children: React.ReactNode; readonly aside?: React.ReactNode }): React.ReactElement {
  return (
    <div style={styles.sectionTitle}>
      <h3 style={styles.h3}>{props.children}</h3>
      {props.aside}
    </div>
  )
}

/** Token-styled text input. */
export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  return <input {...props} style={{ ...styles.input, ...props.style }} />
}

/** Token-styled textarea. */
export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): React.ReactElement {
  return <textarea {...props} style={{ ...styles.textarea, ...props.style }} />
}

/** Token-styled select. */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): React.ReactElement {
  return <select {...props} style={{ ...styles.input, ...props.style }} />
}

/** Empty-state paragraph. */
export function Empty(props: { readonly children: React.ReactNode }): React.ReactElement {
  return <p style={styles.empty}>{props.children}</p>
}

/** Inline error banner. */
export function ErrorBanner(props: { readonly children: React.ReactNode }): React.ReactElement {
  return <div style={styles.error}>{props.children}</div>
}

/** One chat/panel card with the accent bar from §13.8. */
export function QunoCard(props: {
  readonly children: React.ReactNode
  /** Left accent bar color; defaults to the brand accent. */
  readonly accent?: string
  readonly variant?: 'chat' | 'panel'
  readonly style?: React.CSSProperties
}): React.ReactElement {
  return (
    <div
      className={props.variant === 'panel' ? 'dsh-quno-card dsh-quno-card--panel' : 'dsh-quno-card'}
      style={{ ...(props.accent === undefined ? {} : { '--quno-bar': props.accent }), ...props.style } as React.CSSProperties}
    >
      {props.children}
    </div>
  )
}

/** One status chip (open / waiting / snoozed / done / failed). */
export function QunoStat(props: {
  readonly tone: 'open' | 'wait' | 'snooze' | 'done' | 'fail'
  readonly children: React.ReactNode
}): React.ReactElement {
  return <span className={`dsh-quno-stat dsh-quno-stat--${props.tone}`}>{props.children}</span>
}

/** One label/value row used by the Collector and task details. */
export function QunoKV(props: { readonly k: string; readonly v: React.ReactNode }): React.ReactElement {
  return (
    <div className="dsh-quno-kv">
      <span className="dsh-quno-kv__k">{props.k}</span>
      <span className="dsh-quno-kv__v">{props.v}</span>
    </div>
  )
}

/** QUNO_SKIN_CSS（design §13.9）：单一幂等样式表，七块结构——皮肤 token、
 * 消息头像、会话头身份/欢迎块、对话内胶囊、卡片规格、铬件隐藏、
 * 调色板与安静对话页（2026-10-23「连成一体，安静对话」提案）。
 * 选择器只用 `[data-slot]`/`data-chat-*` 接缝与自有属性
 * （`[data-quno-main]`），不引用 stock CSS-module 类名；颜色经 token 与
 * `--quno-*` 调色板双写暗色。侧栏回归 stock（Quno 入口为原生面板行，
 * 无页签、无面板分裂）。 */
export const QUNO_CSS = `
/* ── 1. 皮肤 token 作用域 ──
   头像占据列首独立行槽：indent 是正文左缘（与输入框列对齐，勿动），头像
   占 0..26px、不悬出列缘、与正文留 10px——头像在正文气泡之外，永不与
   引用块/代码块内边距叠加。回复底部动作行随正文缩进（见 7.7），因此头像
   右缘 26px 恒在复制按钮盒左缘 30px 左侧，两者分列两轴（2026-10-23 二次
   裁定：头像必须在复制按钮垂直线的左侧，不能正上方）。 */
[data-quno-main] {
  --quno-avatar-size: 26px;
  --quno-avatar-indent: 36px;
}

/* Flat brand disc: one mist-blue fill, no outer shadow. The dark theme lifts
   the fill a step and tints the hairline so the circle edge stays visible. */
:root {
  --quno-mark-bg: #48669D;
  --quno-mark-ring: rgba(255, 255, 255, 0.22);
  --quno-mark-message-image: url("${QUNO_MARK_DATA_URI}");
  /* Theme-aware elevation for floating surfaces; never a fixed black shadow. */
  --quno-elevation: var(--dsw-shadow-lv3, 0 8px 28px rgba(23, 26, 31, 0.16));
}
body[data-ds-dark-theme] {
  --quno-mark-bg: #4E6DA4;
  --quno-mark-ring: rgba(142, 169, 210, 0.45);
  --quno-mark-message-image: url("${QUNO_MARK_DATA_URI_DARK}");
}

/* ── 2. 消息头像：assistant 段落左侧圆形头像，流式时呼吸 ── */
[data-quno-main] [data-chat-flow-kind="assistant-step"] {
  position: relative;
  padding-left: var(--quno-avatar-indent);
}
[data-quno-main] [data-chat-flow-kind="assistant-step"]::before {
  content: "";
  position: absolute;
  left: 0;
  top: 2px;
  width: var(--quno-avatar-size);
  height: var(--quno-avatar-size);
  border-radius: 999px;
  background-image: var(--quno-mark-message-image);
  background-size: contain;
  background-repeat: no-repeat;
}
[data-quno-main] [data-chat-flow-kind="assistant-step"]:has([data-streaming])::before {
  animation: quno-avatar-breath 1.6s ease-in-out infinite;
}
@keyframes quno-avatar-breath {
  50% { opacity: 0.55; }
}

/* ── 3. 会话头身份 / hero 欢迎块（组件内联样式；Hero 本体保持 stock） ── */

/* ── 4. 对话内胶囊（组件内联样式） ── */

/* ── 5. 卡片规格（任务卡组件内联样式按此实现） ── */

/* ── 6. 铬件隐藏：工作区（hero/空态选择器、面包屑）与模式（preset 控件） ── */
.dsh-quno-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-quno-action:hover { background: var(--dsw-alias-bg-layer-2); }
/* The active tab cannot rely on a layer tint: the pane surface and bg-layer-2
   sit a few points apart in dark mode, which reads as "no selection". Tint with
   the interaction colour and add a brand underline instead. */
.dsh-quno-tab { position: relative; background: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-quno-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-quno-tab[data-active="true"] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.dsh-quno-tab[data-active="true"]::after {
  content: ""; position: absolute; left: 26%; right: 26%; bottom: 1px;
  height: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary);
}
[data-quno-main] [data-slot="conversation.hero.workspace"],
[data-quno-main] [data-slot="conversation.hero.agentPreset"],
[data-quno-main] [data-slot="conversation.session.header.lineage"] { display: none !important; }

/* ── 6c. 卡片、状态芯片与键值行（§13.8 统一规格；聊天与面板共用） ──
   汇报卡/任务卡 = 16px 圆角 + 左缘 3px 状态条；面板卡收窄为 10px。 */
.dsh-quno-card {
  position: relative; box-sizing: border-box; overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1); padding: 12px 14px;
}
.dsh-quno-card::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: var(--quno-bar, var(--dsw-alias-brand-primary));
}
.dsh-quno-card--panel { border-radius: 10px; padding: 10px; }
.dsh-quno-card__hd { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-quno-card__label { flex: none; font-size: 11px; font-weight: 600; color: var(--dsw-alias-brand-primary); }
.dsh-quno-card__title { flex: 1; min-width: 0; font-size: 13px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-quno-card__meta { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); display: inline-flex; align-items: center; gap: 5px; }
.dsh-quno-card__body { margin: 6px 0 0; font-size: 14px; line-height: 1.7; color: var(--dsw-alias-label-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-quno-card--panel .dsh-quno-card__body { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.dsh-quno-card__src { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.dsh-quno-chip { background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 1px 7px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-quno-stat { flex: none; font-size: 10.5px; font-weight: 600; border-radius: 6px; padding: 1px 7px; }
/* Chip tints come from the theme's state tokens, so light and dark are not a
   fixed-RGBA inversion of each other. */
.dsh-quno-stat--open { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.dsh-quno-stat--wait { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); }
.dsh-quno-stat--snooze { color: var(--dsw-alias-state-warn-primary); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent); }
.dsh-quno-stat--done { color: var(--dsw-alias-state-success-primary); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); }
.dsh-quno-stat--fail { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.dsh-quno-kv { display: flex; gap: 8px; min-height: 22px; font-size: 12px; }
.dsh-quno-kv__k { flex: none; width: 78px; color: var(--dsw-alias-label-tertiary); }
.dsh-quno-kv__v { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); overflow-wrap: anywhere; }
.dsh-quno-relchip { font-size: 10.5px; font-weight: 500; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 2px 7px; }
.dsh-quno-authcard {
  border: 1px solid var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
  border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px;
}
.dsh-quno-codepill {
  display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 10px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}

/* ── 6d. 面板列表行与骨架：hover 走主题交互色，骨架只在首次加载出现 ── */
.dsh-quno-listrow[data-interactive="true"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-quno-listrow[data-interactive="true"]:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-quno-danger { transition: background 120ms ease; }
.dsh-quno-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
.dsh-quno-danger[data-confirm="true"]:hover:not(:disabled) { filter: brightness(0.94); }
.dsh-quno-danger:disabled { opacity: 0.4; cursor: not-allowed; }
.dsh-quno-skeleton { animation: quno-skeleton 1.4s ease-in-out infinite; }
@keyframes quno-skeleton { 50% { opacity: 0.55; } }

/* ── 6e. 对话内悬浮胶囊（Portal 到 [data-conversation-content]） ──
   胶囊不在会话头按钮区：正文容器本身 position: relative，胶囊贴其右上角，
   因此不随消息滚动、不依赖头部高度、左右栏变化时自然跟随。 */
[data-quno-capsule-root] {
  position: absolute; top: 8px; right: 12px; z-index: 6;
  display: flex; flex-direction: column; align-items: flex-end;
  max-width: calc(100% - 24px);
}
[data-quno-capsule-flyout] {
  position: absolute; top: calc(100% + 6px); right: 0;
  width: var(--quno-capsule-width, 300px);
  max-height: var(--quno-capsule-max-height, 60vh);
  overflow-y: auto;
  animation: quno-capsule-in 120ms ease-out;
}
@keyframes quno-capsule-in {
  from { opacity: 0; transform: translateY(-2px); }
  to { opacity: 1; transform: none; }
}
.dsh-quno-capsule-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-quno-capsule-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
@media (prefers-reduced-motion: reduce) {
  [data-quno-capsule-flyout] { animation: none; }
}

/* ── Quno 调色板（「连成一体，安静对话」提案值；暗色随主题双写） ──
   提案浅色参考：强调 #48669D、气泡冷灰、标题 #23272E。暗色取主题
   label/层色的半透明等价物，跟随 body[data-ds-dark-theme] 翻转。 */
[data-quno-main] {
  --quno-accent: #48669D;
  --quno-title: #23272E;
  --quno-bubble: #F1F3F6;
}
body[data-ds-dark-theme] [data-quno-main] {
  --quno-accent: #7A96C8;
  --quno-title: var(--dsw-alias-label-primary);
  --quno-bubble: rgba(255, 255, 255, 0.06);
}

/* ── 6b. 接入向导（shell.overlay + platform Modal）──
   三栏布局需要比设置弹窗更宽；Modal 自带 portal/焦点/Escape/遮罩，
   插件只覆盖卡片尺寸与内边距（自有命名空间，不依赖对话标记）。 */
.dsh-quno-onboarding-dialog {
  width: min(1120px, calc(100vw - 64px));
  height: min(720px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))));
  padding: 0;
  gap: 0;
  overflow: hidden;
}
@media (max-width: 719px) {
  .dsh-quno-onboarding-dialog { width: calc(100vw - 24px); }
}

/* ── 7. 安静对话页（仅 [data-quno-main] 作用域） ── */

/* 7.1 头部两行：第一行身份居左、胶囊与面板开关居右上；第二行「对话/轨迹」
   居左。会话标题簇（面包屑+动作）退场——注意只藏 titleCluster，utilities
   （胶囊/标记）与 corner（面板开关）必须存活。 */
[data-quno-main] header { display: flex; flex-wrap: wrap; align-items: center; row-gap: 2px; min-height: 60px; }
[data-quno-main] [data-slot="conversation.session.header"] { display: contents; }
[data-quno-main] [data-slot="conversation.session.header"] > div:nth-child(1) { display: contents; }
[data-quno-main] [data-slot="conversation.session.header"] > div:nth-child(1) > div:nth-child(1) { display: none; }
[data-quno-main] [data-slot="conversation.session.header"] > div:nth-child(1) > div:nth-child(2) { margin-left: auto; }
[data-quno-main] [data-slot="conversation.session.header"] > div:nth-child(2) { flex-basis: 100%; }

/* macOS 收起态安全区：Quno 把 stock 带避让的 titleRow 拆成 display: contents，
   其 clearance 补偿不再生效，而身份区仍在独立的 headerLeading（grid-column 1）
   里——需自行消费框架发布的 --dsh-frame-leading-clearance（AppFrame，仅在
   darwin 收起态非零），公式与 stock titleRow 一致：头部已垫 20px 故减 20。
   展开态变量回退 0，max 取 0，布局不变；全屏收起自动用框架的 84px。 */
[data-quno-main] [data-conversation-header-leading] {
  padding-inline-start: max(0px, calc(var(--dsh-frame-leading-clearance, 0px) - 20px));
}

/* 7.2 消息列与输入框同宽居中（提案 800–840px） */
[data-quno-main] div:has(> [data-slot="conversation.chat.flow"]) { max-width: min(800px, 100%); margin: 0 auto; }
[data-quno-main] [data-composer-card] {
  max-width: min(800px, 100%); margin-left: auto; margin-right: auto;
  border-radius: 16px; box-shadow: 0 1px 2px rgba(35, 39, 46, 0.05);
}

/* 7.3 头像尺寸/间距统一由块 1 声明；连续输出与工具过程后不重复插头像
   （相邻同 Kind 撤销） */
[data-quno-main] [data-chat-flow-kind="tool-call"] + [data-chat-flow-kind="assistant-step"]::before,
[data-quno-main] [data-chat-flow-kind="assistant-step"] + [data-chat-flow-kind="assistant-step"]::before { content: none; }

/* 7.4 回合节奏：已完成过程行退场（执行信息走轨迹视图）；运行中行内含
   [data-chat-running] 不受影响；回复组以固定上间距分区，无分隔线。 */
[data-quno-main] [data-chat-flow-kind="turn-process"]:not(:has([data-chat-running])) { display: none; }
[data-quno-main] [data-chat-flow-kind="turn-process"] + * { padding-top: 24px; }

/* 7.5 回复底部保持 stock 样式，只少三颗按钮：评价（赞/踩）与分支退场，
   复制/用量/时间原样（图标形态不动，不加文字）。
   锚为 stock 的 aria-label（中英双字典值）；stock 改文案时规则失效
   （fail-open，按钮回归），不会误伤。复制成功反馈为 stock 原位行为。 */
[data-quno-main] button[aria-label="好的回答"],
[data-quno-main] button[aria-label="有问题的回答"],
[data-quno-main] button[aria-label="取消标记"],
[data-quno-main] button[aria-label="在新对话中分支"],
[data-quno-main] button[aria-label="Good response"],
[data-quno-main] button[aria-label="Bad response"],
[data-quno-main] button[aria-label="Remove rating"],
[data-quno-main] button[aria-label="Branch into a new conversation"] { display: none; }

/* 复制与用量/时间簇贴合行内相邻按钮的 8px 节奏：stock 的 meta 簇自带
   margin-left 8px，评价/分支在场时是分组呼吸，只剩复制一颗按钮时读作
   空洞（2026-10-23 用户裁定：参考原页面按钮节奏收拢）。锚为
   [data-turn-tail] 行的末个 meta span，stock 改结构时规则失效、间距
   回落 stock 值（fail-open，不误伤）。 */
[data-quno-main] [data-turn-tail] > :last-child > span:last-child { margin-left: 0; }

/* 7.6 用户气泡冷灰、发送钮雾蓝 */
[data-quno-main] { --dsw-specific-bubble: var(--quno-bubble); }
[data-quno-main] [data-composer-card] button[aria-label="发送消息"],
[data-quno-main] [data-composer-card] button[aria-label="Send message"] { background: var(--quno-accent); }

/* 7.7 动作行随正文缩进：turn-tail 行右移一个正文 indent，头像列（0..26px）
   因此与复制按钮（stock 自带 -6px，盒左缘 30px、图标左缘 36px 与正文齐）
   分列两轴；tail 槽里的 Quno 主动汇报卡随之与正文左对齐。锚为
   [data-turn-tail]（stock 属性），改结构时规则失效、动作行回落列左缘
   （fail-open：头像与按钮重新同列，不遮挡）。 */
[data-quno-main] [data-turn-tail] { padding-left: var(--quno-avatar-indent); }
`

const styles = {
  card: {
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-1)',
    borderRadius: 12,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  cardHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  cardAside: { display: 'inline-flex', gap: 6, alignItems: 'center' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 },
  fieldLabel: { color: 'var(--dsw-alias-label-secondary)' },
  fieldHint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
  status: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
  dot: { width: 7, height: 7, borderRadius: 4, display: 'inline-block' },
  sectionTitle: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  h3: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '6px 8px',
    font: 'inherit',
    fontSize: 12,
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 70,
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '6px 8px',
    font: 'inherit',
    fontSize: 12,
    lineHeight: 1.5,
    resize: 'vertical',
  },
  empty: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
  error: {
    border: '1px solid var(--dsw-alias-state-error-primary)',
    color: 'var(--dsw-alias-state-error-primary)',
    borderRadius: 8,
    padding: '6px 8px',
    fontSize: 12,
  },
} as const

/**
 * Worker-surface styles (design v2 §5/§6/§8): the work entry, worker rows, the
 * worker session identity/commands and the read-only composer takeover.
 * Tokens only — no literal colors reach the components (v2 §2.3).
 */
export const QUNO_WORK_CSS = `
.quno-work-entry {
  display: inline-flex; align-items: center; gap: 6px;
  border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 13px; font-weight: 500;
  padding: 3px 8px; border-radius: 8px;
}
.quno-work-entry:hover { background: var(--dsw-alias-bg-layer-2); }
.quno-work-entry:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.quno-work-entry__count {
  min-width: 18px; padding: 0 5px; border-radius: 999px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  font-size: 11px; text-align: center;
}
.quno-work-entry[data-tone="warn"] .quno-work-entry__count {
  color: var(--dsw-alias-state-warn-primary);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-warn-primary);
}

.quno-worker-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 12px;
  width: 100%; min-height: 56px;
  padding: 9px 4px;
  border: 0; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  font: inherit; text-align: left;
  overflow-wrap: anywhere;
}
.quno-worker-row:hover { background: var(--dsw-alias-bg-layer-1); }
.quno-worker-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.quno-worker-row__title { font-size: 14px; font-weight: 600; line-height: 20px; }
.quno-worker-row__worker,
.quno-worker-row__activity { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.quno-worker-row__activity { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quno-worker-row__status { grid-column: 2; grid-row: 1 / span 2; align-self: center; font-size: 12px; }

.quno-worker-identity { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.quno-worker-identity__back {
  border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px;
  padding: 3px 6px; border-radius: 6px;
  flex: none;
}
.quno-worker-identity__back:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.quno-worker-identity__back:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.quno-worker-identity__divider { width: 1px; height: 16px; background: var(--dsw-alias-border-l1); flex: none; }
.quno-worker-identity__title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quno-worker-identity__meta { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); flex: none; }

.quno-worker-commands { display: inline-flex; align-items: center; gap: 6px; }
.quno-worker-commands button {
  border: 1px solid var(--dsw-alias-border-l2); background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px;
  padding: 3px 10px; border-radius: 8px;
}
.quno-worker-commands button:hover { background: var(--dsw-alias-bg-layer-2); }
.quno-worker-commands button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.quno-worker-commands button:disabled { opacity: 0.6; cursor: default; }
.quno-worker-commands__stop { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }

.quno-worker-readonly {
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  padding: 10px 16px 12px;
}
.quno-worker-readonly__note {
  margin: 0 0 4px; display: flex; gap: 8px; align-items: baseline;
  font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.quno-worker-readonly__note strong { color: var(--dsw-alias-label-primary); font-size: 12px; flex: none; }

.quno-worker-summary { min-width: 0; }
.quno-worker-summary__head {
  display: flex; align-items: center; gap: 8px;
  cursor: pointer; list-style: none; padding: 2px 0;
}
.quno-worker-summary__head::-webkit-details-marker { display: none; }
.quno-worker-summary__head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; border-radius: 6px; }
.quno-worker-summary__head::before { content: '▸'; color: var(--dsw-alias-label-tertiary); font-size: 10px; }
.quno-worker-summary[open] .quno-worker-summary__head::before { content: '▾'; }
.quno-worker-summary__title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quno-worker-summary__body {
  margin-top: 6px; padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  background: var(--dsw-alias-bg-base);
  display: flex; flex-direction: column; gap: 8px;
}
.quno-worker-summary__body h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.quno-worker-summary__body p { margin: 2px 0 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.quno-worker-summary__question { color: var(--dsw-alias-label-primary); }
.quno-worker-summary__error { color: var(--dsw-alias-state-error-primary); }
.quno-worker-summary__hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.quno-worker-summary__meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.quno-worker-summary__meta code { font-family: ui-monospace, monospace; font-size: 10.5px; overflow-wrap: anywhere; }
.quno-worker-summary__answer { display: flex; gap: 6px; margin-top: 4px; }
.quno-worker-summary__answer input {
  flex: 1; min-width: 0; font: inherit; font-size: 12px;
  padding: 5px 9px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
}
.quno-worker-summary__answer input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.quno-worker-summary__answer button {
  border: 0; border-radius: 8px; cursor: pointer;
  background: var(--dsw-alias-brand-primary); color: #fff;
  font: inherit; font-size: 12px; padding: 5px 12px;
}
.quno-worker-summary__answer button:disabled { opacity: 0.6; cursor: default; }
.quno-worker-summary__artifact { display: flex; align-items: center; gap: 6px; font-size: 12px; flex-wrap: wrap; margin-top: 2px; }
.quno-worker-summary__artifact-kind {
  flex: none; font-size: 10.5px; font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-2); border-radius: 6px; padding: 1px 7px;
}
.quno-worker-summary__artifact a { color: var(--dsw-alias-brand-primary); text-decoration: none; overflow-wrap: anywhere; }
.quno-worker-summary__artifact button {
  border: 0; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px; padding: 0;
}
.quno-worker-summary__artifact button:hover { color: var(--dsw-alias-label-primary); }

@media (max-width: 720px) {
  .quno-worker-row { min-height: 52px; }
  .quno-worker-identity__meta { display: none; }
  .quno-worker-readonly { padding: 8px 12px 10px; }
}
@media (max-width: 480px) {
  .quno-worker-row__worker { display: none; }
  .quno-worker-identity__title { max-width: 40vw; }
}
`
