/**
 * The `ohmymemo-context` row: inject a bounded memory-index capsule as a
 * durable `user/message` before agent steps, reconciled by digest — the
 * design doc's "persistent baseline / change reconciliation" principle:
 *
 * - no prior capsule in the session surface → inject;
 * - most recent capsule carries the same digest → skip (no duplicate);
 * - digest changed → inject a replacement message that explicitly supersedes
 *   the previous capsule (session history is append-only; the message itself
 *   states the override);
 * - the change was produced by THIS session's own write → update the cached
 *   digest silently (self-write exemption: the model made the write, so
 *   re-announcing it to the same turn's context is pure churn).
 *
 * Anti-oscillation (index-first interaction): the injection decision is made
 * ONLY on the first step of a turn. Mid-turn digest changes — including the
 * session's own `memory_remember` success two steps ago — defer to the next
 * turn's first step. The old per-step reconciliation injected a full
 * replacement capsule mid-turn after every write, costing a step and
 * churning the whole context each time.
 *
 * Reconciliation reads ONLY the supported `sessionQuery` snapshots — never
 * the live `agent.session` internals, whose shape is not a public contract
 * (a resumed session in the wild surfaced a view without `events`, crashing
 * every turn at pre-step). One `readSurface` scan runs at the first step of
 * each turn; later steps of the same turn skip entirely. The whole listener
 * is fail-open: a broken store or query degrades to "no capsule this step"
 * and a warning — memory is additive and must never brick a turn.
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

/** Per-session reconciliation state: the turn already decided, plus cwd. */
interface Reconciliation {
  turn: number
  cwd?: string
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
      const known = cache.get(sessionId)
      if (known !== undefined && known.turn === turn) {
        // Mid-turn step: decisions happen once per turn. Digest changes —
        // self-writes included — defer to the next turn's first step.
        return decision
      }
      // First sight or a new turn: one supported surface scan repopulates
      // the reconciliation state (surface digest + frozen cwd).
      const snapshot = await sessions.readSurface(agent.id)
      const events = snapshot.events as unknown as readonly SurfaceEventView[]
      const surfaceDigest = lastDigestFromSurface(events)
      const cwd = snapshot.session.cwd
      cache.set(sessionId, { turn, ...(cwd === undefined ? {} : { cwd }) })
      signal.throwIfAborted()

      const input = service.capsuleInput(cwd)
      const capsule = composeCapsule({
        entries: input.entries,
        userScope: 'user',
        ...(input.workspaceScope !== undefined ? { workspaceScope: input.workspaceScope } : {}),
        root: input.root,
        topEntries: input.topEntries,
        summaryChars: input.summaryChars,
        budgetBytes: input.budgetBytes,
        now: new Date(),
        decayHorizons: input.decayHorizons,
      })
      signal.throwIfAborted()

      if (capsule.digest === surfaceDigest) return decision
      if (service.hasSelfWriteDigest(sessionId, capsule.digest)) {
        // This session's own write produced exactly this state; re-announcing
        // it would burn a step on "the system injected something". Cache only.
        return decision
      }
      const text = surfaceDigest !== undefined ? `${replacementPreface(surfaceDigest)}\n\n${capsule.text}` : capsule.text
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
