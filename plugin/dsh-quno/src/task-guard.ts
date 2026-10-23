/**
 * The `quno-task` preset guard: enforces the read-only capability boundary in
 * the tool registry (a prompt request is not a permission system).
 *
 * @module dsh-quno/task-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import { READ_ONLY_TOOLS } from './presets.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-quno-task-guard'

/** The preset row is hosted by an isolated agent scope; it needs the tool registry. */
export const inject = ['tools', 'systemPrompt']

/** Allow-list derived from the tools actually registered at mount time. */
export function apply(ctx: Context): void {
  const allowed = new Set(READ_ONLY_TOOLS)
  let available: string[] = []
  try {
    available = ctx.tools.schemas().map(schema => schema.name).filter(tool => allowed.has(tool))
    ctx.tools.restrict({ allow: available })
  } catch (error) {
    ctx.logger.warn(`dsh-quno task-guard: read-only restriction could not be installed: ${(error as Error).message}`)
  }

  // A monotonic guard covers tools registered after mount (and any scope-local
  // name that would otherwise bypass the allow-list).
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : `只读子任务不允许调用 ${exec.name}`)

  const disposeSection = ctx.systemPrompt.section({
    name: 'quno-task-boundary',
    order: 4,
    text: `# Read-only execution

You are a background task runner for Quno. You may read files, search, and fetch web pages. You must not modify files, send external messages, place orders, or perform any action with an outward effect. If the task requires a write, report what you would do and stop.`,
  })
  ctx.effect(() => () => disposeSection(), 'quno-task-guard: section')
}
