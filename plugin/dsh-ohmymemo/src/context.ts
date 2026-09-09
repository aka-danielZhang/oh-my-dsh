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
 * Reconciliation reads ONLY the supported `sessionQuery` snapshots — never
 * the live `agent.session` internals, whose shape is not a public contract
 * (a resumed session in the wild surfaced a view without `events`, crashing
 * every turn at pre-step). One `readSurface` scan runs at first sight per
 * TURN; steps within a turn arbitrate against the in-memory digest cache, so
 * steady-state steps add no queries. The whole listener is fail-open: a
 * broken store or query degrades to "no capsule this step" and a warning —
 * memory is additive and must never brick a turn.
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
import { composeCapsule, digestFromText, replacementPreface } from './capsule.ts'
import { DREAM_MAINTENANCE_SESSION_PREFIX } from './dream.ts'
import type { OhMyMemoService } from './service.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-ohmymemo-context'

/** Hard deps: the memory service and the supported session read surface. */
export const inject = ['ohMyMemo', 'sessionQuery']

/** Build the durable capsule message (plain literal, plugin-sourced snapshot). */
export function createCapsuleMessage(text: string): UserMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-ohmymemo-context', form: 'snapshot', sections: [{ name: 'memory-capsule', text }] },
  } as unknown as UserMessage
}

/** Narrow view of one readSurface snapshot event (the supported shape). */
interface SurfaceEventView {
  seq: number
  type: string
  data?: { content?: Array<{ type: string; text?: string }>; source?: { kind?: string; plugin?: string } }
}

/** Per-session reconciliation state cached between steps of one turn. */
interface Reconciliation {
  turn: number
  cwd?: string
  digest?: string
}

/** Digest of the latest own capsule on the current surface, if any. */
function lastDigestFromSurface(events: readonly SurfaceEventView[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.plugin !== name) continue
    const text = (event.data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
    const digest = digestFromText(text)
    if (digest !== undefined) return digest
  }
  return undefined
}

export function apply(ctx: Context): void {
  const service = ctx.ohMyMemo as OhMyMemoService | undefined
  if (service === undefined) throw new Error('dsh-ohmymemo-context: ohMyMemo service is not mounted')
  const sessions = ctx.sessionQuery
  const cache = new Map<string, Reconciliation>()

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const { agent, signal } = payload as { agent: Agent; signal: AbortSignal }
    if (signal.aborted) return decision
    const sessionId = String(agent.id)
    if (sessionId.startsWith(DREAM_MAINTENANCE_SESSION_PREFIX)) return decision

    try {
      const turn = Number((payload as { turn?: number }).turn ?? 0)
      let known = cache.get(sessionId)
      if (known === undefined || known.turn !== turn) {
        // First sight this turn: one supported surface scan repopulates the
        // reconciliation state (digest + frozen cwd). Steps within the turn
        // then arbitrate purely in memory.
        const snapshot = await sessions.readSurface(agent.id)
        const events = snapshot.events as unknown as readonly SurfaceEventView[]
        known = { turn, ...(snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd }), digest: lastDigestFromSurface(events) }
        cache.set(sessionId, known)
      }
      signal.throwIfAborted()

      const input = service.capsuleInput(known.cwd)
      const capsule = composeCapsule({
        entries: input.entries,
        userScope: 'user',
        ...(input.workspaceScope !== undefined ? { workspaceScope: input.workspaceScope } : {}),
        budgetBytes: input.budgetBytes,
        now: new Date(),
        decayHorizons: input.decayHorizons,
      })
      signal.throwIfAborted()

      if (known.digest === capsule.digest) return decision
      const text = known.digest !== undefined ? `${replacementPreface(known.digest)}\n\n${capsule.text}` : capsule.text
      cache.set(sessionId, { ...known, digest: capsule.digest })
      return {
        ...decision,
        messages: [...decision.messages, createCapsuleMessage(text)],
      }
    } catch (error) {
      if (signal.aborted) return decision
      // Fail-open by design: an unreadable surface or broken store skips this
      // step's capsule instead of failing the turn.
      const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
      const message = `dsh-ohmymemo-context: capsule step skipped: ${error instanceof Error ? error.message : String(error)}`
      if (logger !== undefined) logger.warn(message)
      else console.warn(message)
      return decision
    }
  })
}
