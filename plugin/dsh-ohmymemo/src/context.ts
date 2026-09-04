/**
 * The `ohmymemo-context` row: inject a bounded memory capsule as a durable
 * `user/message` before agent steps, reconciled by digest — the design doc's
 * "persistent baseline / change reconciliation" principle:
 *
 * - no prior capsule in the session surface → inject;
 * - most recent capsule carries the same digest → skip (no duplicate);
 * - digest changed → inject a replacement message that explicitly supersedes
 *   the previous capsule (session history is append-only; the message itself
 *   states the override).
 *
 * The message is sourced `{kind: 'plugin', plugin: 'dsh-ohmymemo-context'}` with
 * `form: 'snapshot'` — built as a plain literal so this row keeps type-only
 * harness imports (the UserMessage shape is a frozen data record; see
 * dsh-llm `createUserMessage`).
 * @module dsh-ohmymemo/context
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { composeCapsule, lastCapsuleDigest, replacementPreface } from './capsule.ts'
import { DREAM_MAINTENANCE_SESSION_PREFIX } from './dream.ts'
import type { OhMyMemoService } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-ohmymemo-context'

/** Hard dep: the memory service (provided by the store row). */
export const inject = ['ohMyMemo']

/** Narrow view of the live session surface for reconciliation scans. */
interface SessionSurfaceView {
  surface: { nodes: number[] }
  events: Record<number, { type: string; data?: { role?: string; content?: Array<{ type: string; text?: string }>; source?: { kind?: string; plugin?: string } } }>
}

function surfaceOf(agent: Agent): SessionSurfaceView | undefined {
  return (agent as unknown as { session?: SessionSurfaceView }).session
}

/** Build the durable capsule message (plain literal, plugin-sourced snapshot). */
export function createCapsuleMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-ohmymemo-context', form: 'snapshot', sections: [{ name: 'memory-capsule', text }] },
  } as unknown as UserMessage
}

/** Digest of the latest own capsule in the surface, if any. */
function previousDigest(agent: Agent): string | undefined {
  const session = surfaceOf(agent)
  if (session === undefined) return undefined
  return lastCapsuleDigest((seq) => {
    const event = session.events[seq]
    if (event === undefined || event.type !== 'user/message' || event.data?.role !== 'user') return undefined
    const text = (event.data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
    return { text, sourcePlugin: event.data.source?.plugin }
  }, session.surface.nodes, name)
}

export function apply(ctx: Context): void {
  const service = ctx.ohMyMemo as OhMyMemoService | undefined
  if (service === undefined) throw new Error('dsh-ohmymemo-context: ohMyMemo service is not mounted')

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    if (String(agent.id).startsWith(DREAM_MAINTENANCE_SESSION_PREFIX)) return decision

    const session = surfaceOf(agent)
    const cwd = session === undefined ? undefined : (agent as unknown as { session?: { header?: { cwd?: string } } }).session?.header?.cwd
    const input = service.capsuleInput(cwd)
    const capsule = composeCapsule({
      entries: input.entries,
      userScope: 'user',
      ...(input.workspaceScope !== undefined ? { workspaceScope: input.workspaceScope } : {}),
      budgetBytes: input.budgetBytes,
      now: new Date(),
    })
    signal.throwIfAborted()

    const prior = previousDigest(agent)
    if (prior === capsule.digest) return decision
    const text = prior !== undefined ? `${replacementPreface(prior)}\n\n${capsule.text}` : capsule.text
    return {
      ...decision,
      messages: [...decision.messages, createCapsuleMessage(text)],
    }
  })
}
