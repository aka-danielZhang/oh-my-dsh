/**
 * Small presentational primitives shared by the Quno sidebar, settings page
 * and message cards. Token-only styling; no business state.
 *
 * @module dsh-quno/client/ui
 */

import React from 'react'

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

/** QUNO_SKIN_CSS（design §13.9）：单一幂等样式表，七块结构——皮肤 token、
 * 消息头像、会话头身份/欢迎块、对话内胶囊、卡片规格、铬件隐藏、
 * 调色板与安静对话页（2026-10-23「连成一体，安静对话」提案）。
 * 选择器只用 `[data-slot]`/`data-chat-*` 接缝与自有属性
 * （`[data-quno-main]`），不引用 stock CSS-module 类名；颜色经 token 与
 * `--quno-*` 调色板双写暗色。侧栏回归 stock（Quno 入口为原生面板行，
 * 无页签、无面板分裂）。 */
export const QUNO_CSS = `
/* ── 1. 皮肤 token 作用域 ── */
[data-quno-main] {
  --quno-avatar-size: 26px;
  --quno-avatar-gap: 10px;
}

/* ── 2. 消息头像：assistant 段落左侧圆形头像，流式时呼吸 ── */
[data-quno-main] [data-chat-flow-kind="assistant-step"] {
  position: relative;
  padding-left: calc(var(--quno-avatar-size) + var(--quno-avatar-gap));
}
[data-quno-main] [data-chat-flow-kind="assistant-step"]::before {
  content: "Q";
  position: absolute;
  left: 0;
  top: 2px;
  width: var(--quno-avatar-size);
  height: var(--quno-avatar-size);
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
}
[data-quno-main] [data-chat-flow-kind="assistant-step"]:has([data-streaming])::before {
  animation: quno-avatar-breath 1.6s ease-in-out infinite;
}
@keyframes quno-avatar-breath {
  50% { opacity: 0.55; }
}

/* ── 3. 会话头身份 / hero 欢迎块（组件内联样式，此处仅 stock 鲸鱼座退场） ── */
[data-quno-main] [data-slot="conversation.hero.brand.mark"] { display: none !important; }

/* ── 4. 对话内胶囊（组件内联样式） ── */

/* ── 5. 卡片规格（任务卡组件内联样式按此实现） ── */

/* ── 6. 铬件隐藏：工作区（hero/空态选择器、面包屑）与模式（preset 控件） ── */
.dsh-quno-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-quno-action:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-quno-tab[data-active="true"] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-quno-tab:hover { color: var(--dsw-alias-label-primary); }
[data-quno-main] [data-slot="conversation.hero.workspace"],
[data-quno-main] [data-slot="conversation.hero.agentPreset"],
[data-quno-main] [data-slot="conversation.session.header.lineage"] { display: none !important; }

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

/* ── 7. 安静对话页（仅 [data-quno-main] 作用域） ── */

/* 7.1 头部一行化：标题行退场，「对话/轨迹」推到右侧与身份同行 */
[data-quno-main] [data-slot="conversation.session.header"] { display: contents; }
[data-quno-main] [data-slot="conversation.session.header"] > div:nth-child(1) { display: none; }
[data-quno-main] [data-slot="conversation.session.header"] > div:nth-child(2) { margin-left: auto; }
[data-quno-main] header { min-height: 52px; }

/* 7.2 消息列与输入框同宽居中（提案 800–840px） */
[data-quno-main] div:has(> [data-slot="conversation.chat.flow"]) { max-width: min(800px, 100%); margin: 0 auto; }
[data-quno-main] [data-composer-card] {
  max-width: min(800px, 100%); margin-left: auto; margin-right: auto;
  border-radius: 16px; box-shadow: 0 1px 2px rgba(35, 39, 46, 0.05);
}

/* 7.3 头像缩小；连续输出与工具过程后不重复插头像（相邻同 Kind 撤销） */
[data-quno-main] { --quno-avatar-size: 26px; --quno-avatar-gap: 10px; }
[data-quno-main] [data-chat-flow-kind="tool-call"] + [data-chat-flow-kind="assistant-step"]::before,
[data-quno-main] [data-chat-flow-kind="assistant-step"] + [data-chat-flow-kind="assistant-step"]::before { content: none; }

/* 7.4 回合节奏：已完成过程行退场（执行信息走轨迹视图）；运行中行内含
   [data-chat-running] 不受影响；回复组以固定上间距分区，无分隔线。 */
[data-quno-main] [data-chat-flow-kind="turn-process"]:not(:has([data-chat-running])) { display: none; }
[data-quno-main] [data-chat-flow-kind="turn-process"] + * { padding-top: 24px; }

/* 7.5 回复底部只留复制与用量：评价（赞/踩）与分支按钮退场。
   锚为 stock 的 aria-label（中英双字典值）；stock 改文案时规则失效
   （fail-open，按钮回归），不会误伤。复制成功反馈为 stock 原位行为。
   复制钮保持 stock 图标盒、放宽为「图标 + 文字」，不断开图标。 */
[data-quno-main] button[aria-label="好的回答"],
[data-quno-main] button[aria-label="有问题的回答"],
[data-quno-main] button[aria-label="取消标记"],
[data-quno-main] button[aria-label="在新对话中分支"],
[data-quno-main] button[aria-label="Good response"],
[data-quno-main] button[aria-label="Bad response"],
[data-quno-main] button[aria-label="Remove rating"],
[data-quno-main] button[aria-label="Branch into a new conversation"] { display: none; }
[data-quno-main] [data-turn-tail] button[aria-label="复制"]::after { content: "复制"; }
[data-quno-main] [data-turn-tail] button[aria-label="Copy"]::after { content: "Copy"; }
[data-quno-main] [data-turn-tail] button[aria-label="复制"]::after,
[data-quno-main] [data-turn-tail] button[aria-label="Copy"]::after {
  font-size: 12px; font-weight: 400; color: var(--dsw-alias-label-secondary);
}
[data-quno-main] [data-turn-tail] button[aria-label="复制"],
[data-quno-main] [data-turn-tail] button[aria-label="Copy"] {
  width: auto; min-width: 32px; padding: 0 8px; gap: 6px;
}

/* 7.6 用户气泡冷灰、发送钮雾蓝 */
[data-quno-main] { --dsw-specific-bubble: var(--quno-bubble); }
[data-quno-main] [data-composer-card] button[aria-label="发送消息"],
[data-quno-main] [data-composer-card] button[aria-label="Send message"] { background: var(--quno-accent); }
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
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    padding: '6px 8px',
    font: 'inherit',
    fontSize: 12,
  },
  textarea: {
    boxSizing: 'border-box',
    width: '100%',
    minHeight: 70,
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-base)',
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
