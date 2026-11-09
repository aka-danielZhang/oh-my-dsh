/**
 * Quno's own agent presets, registered programmatically (preset-owned).
 *
 * The profile row only mounts the always-on Host service and the browser
 * half; the agent-facing composition lives here so it can carry Quno-specific
 * tools and the aggressive compaction policy without editing a user preset.
 *
 * `quno` — the permanent routing conversation (no direct execution tools).
 * `quno-task` — the read-only child used by delegated tasks (v1 boundary).
 *
 * @module dsh-quno/presets
 */

import type { Context } from '@deepseek-ai/cordis'
import { WORKER_TOOL_NAMES } from './app/worker-tools.ts'

/** One plugin row of a preset declaration. */
interface PresetRow {
  readonly id?: string
  readonly name: string
  readonly group?: boolean
  readonly isolate?: Record<string, boolean>
  readonly disabled?: boolean
  readonly config?: unknown
}

/** Structural face of the harness preset registry. */
interface PresetRegistryFace {
  register(definition: {
    readonly id: string
    readonly name?: string
    readonly description?: string
    readonly order?: number
    readonly plugins: readonly PresetRow[]
  }): Promise<() => Promise<void>>
}

/** Read-only tool names the delegated child may keep. */
export const READ_ONLY_TOOLS: readonly string[] = [
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'todo_write',
  'ask_user_question',
  'present',
  // Quno worker control surface (reports and thread ownership), not execution.
  ...WORKER_TOOL_NAMES,
]

/** Aggressive compaction knobs for a permanent conversation (design §4.3). */
const QUNO_COMPACTION = {
  thresholdRatio: 0.5,
  retainRatio: 0.08,
} as const

function compactionGroup(config: Record<string, unknown>): PresetRow {
  return {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ] satisfies PresetRow[],
  }
}

/** The main conversation composition: route, remember, clarify and report, never execute. */
export function qunoPresetRows(): PresetRow[] {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: 'You are Quno, the user\'s persistent personal assistant and routing secretary. You have one lifelong conversation with the user. Answer briefly, delegate every execution task, and report results when they return.',
      },
    },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65_536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    // Quno-owned capability surface: recall, attention management, delegation,
    // short-term mute. Direct execution tools deliberately stay out of the main preset.
    { id: 'quno-tools', name: 'dsh-quno/preset' },
    compactionGroup(QUNO_COMPACTION),
  ]
}

/** The read-only delegated-task composition. */
export function qunoTaskPresetRows(): PresetRow[] {
  return [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: {
        prefix: 'You are a read-only background task runner for Quno. Complete the assigned task by reading, searching and summarizing. Never modify files, send external messages, or perform outward actions.',
      },
    },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65_536 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: false } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    // Enforces the v1 boundary at the tool registry, not just in the prompt.
    { id: 'quno-task-guard', name: 'dsh-quno/task-guard' },
    compactionGroup({}),
  ]
}

/**
 * Register both presets on the Host registry.
 * @param ctx - host context carrying `agentPresets`.
 * @returns a disposer that retires both presets (plugin unload).
 */
export async function registerQunoPresets(ctx: Context): Promise<() => Promise<void>> {
  const registry = ctx.get('agentPresets') as unknown as PresetRegistryFace | undefined
  if (registry === undefined) {
    throw new Error('dsh-quno: agentPresets registry is not mounted; the Quno presets cannot be declared')
  }
  const disposers: (() => Promise<void>)[] = []
  try {
    disposers.push(await registry.register({
      id: 'quno',
      name: 'Quno 主对话',
      description: 'Quno 的永久主对话：只负责路由与转述，所有实际工作委派子 agent；支持历史召回、关注事项、提醒与激进压缩。',
      order: 2,
      plugins: qunoPresetRows(),
    }))
    disposers.push(await registry.register({
      id: 'quno-task',
      name: 'Quno 只读子任务',
      description: 'Quno 委派的后台只读执行会话：文件读取、搜索、网页只读抓取，不允许写操作。',
      order: 3,
      plugins: qunoTaskPresetRows(),
    }))
  } catch (error) {
    await Promise.allSettled(disposers.map(dispose => dispose()))
    throw error
  }
  return async () => {
    await Promise.allSettled(disposers.map(dispose => dispose()))
  }
}
