/**
 * Binds program-injected inputs to the Turn they were injected into, and
 * keeps them out of the visible flow (design §7.2).
 *
 * The Host stamps every program message's `source.kind` into the durable
 * `user/message` event. This Definition matches ALL Quno program sources
 * (eval candidates, report relays, notifications, task notices), claims each
 * one exclusively on the Chat target, and materializes a HIDDEN node. Hidden
 * means: no row, no grouping effect — but `ChatNodeStore.turnDataSource(turn,
 * kind)` still publishes it per Turn, which is what the turn-tail report card
 * reads.
 *
 * The Router's own natural-language reply on the same Turn renders natively:
 * only the program INPUT is hidden, never Quno's answer.
 *
 * @module dsh-quno/client/report-turn
 */

import type {
  ConversationLocation,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'

/** Payload published onto the Chat target for one program input. */
export interface QunoNoticeChatData {
  readonly notificationId: string
  readonly kind: 'notify' | 'task' | 'eval' | 'report'
  readonly taskId?: string
}

/** The program source kinds the main conversation hides on sight. */
const INTERNAL_SOURCE_KINDS: ReadonlySet<string> = new Set([
  'quno-eval',
  'quno-report',
  'quno-notify',
  'quno-task',
])

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A program input bound to its own Turn (hidden node, queryable per Turn). */
    'quno-notice': QunoNoticeChatData
  }
}

/** Folded state: the business identity plus the owning Turn, when resolved. */
interface QunoNoticeState extends QunoNoticeChatData {
  readonly turn: number | null
}

/** Structural shape of the injected message source all kinds share. */
interface QunoMessageSource {
  readonly kind?: string
  readonly notificationId?: string
  readonly taskId?: string
  readonly evalId?: string
  readonly ticketId?: string
  readonly assignmentId?: string
}

function sourceOf(event: { readonly data: unknown }): QunoMessageSource | undefined {
  const data = event.data as { readonly source?: QunoMessageSource } | undefined
  return data?.source
}

/**
 * One stable business identity per program input, so the fold survives
 * reloads: notifications use their id, evals the eval id, report relays the
 * assignment they report about.
 */
function claimIdOf(source: QunoMessageSource): string | null {
  if (typeof source.notificationId === 'string' && source.notificationId !== '') return source.notificationId
  if (typeof source.evalId === 'string' && source.evalId !== '') return source.evalId
  if (typeof source.ticketId === 'string' && source.ticketId !== '' && typeof source.assignmentId === 'string' && source.assignmentId !== '') {
    return `${source.ticketId}:${source.assignmentId}`
  }
  if (typeof source.ticketId === 'string' && source.ticketId !== '') return source.ticketId
  return null
}

function kindOf(source: QunoMessageSource): QunoNoticeChatData['kind'] {
  if (source.kind === 'quno-task') return 'task'
  if (source.kind === 'quno-eval') return 'eval'
  if (source.kind === 'quno-report') return 'report'
  return 'notify'
}

function turnOf(match: ConversationMatch): number | null {
  const location = match.location
  return location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : null
}

function locationOf(context: ConversationNodeContext<QunoNoticeState>): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/** The Definition contributed to `ctx.uiConversation.events`. */
export const qunoNoticeDefinition: ConversationNodeDefinition<QunoNoticeState> = {
  kind: 'quno-notice',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message') return null
    const source = sourceOf(event)
    if (source?.kind === undefined || !INTERNAL_SOURCE_KINDS.has(source.kind)) return null
    const id = claimIdOf(source)
    if (id === null) return null
    // Claim the program message on the Chat target: the hidden node (and, for
    // notices, the turn-tail card) is its visible form, so no phantom user
    // bubble renders.
    return { id, role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const source = sourceOf(match.event) ?? {}
    return {
      // `match` only accepts a non-empty id, so the fallback never triggers.
      notificationId: typeof source.notificationId === 'string' ? source.notificationId : (claimIdOf(source) ?? ''),
      kind: kindOf(source),
      ...(typeof source.taskId === 'string' && source.taskId !== '' ? { taskId: source.taskId } : {}),
      turn: turnOf(match),
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    // A hidden node keeps the program input out of the visible flow (no row,
    // no grouping effect) while `turnDataSource` still publishes it per Turn.
    return {
      key: context.key,
      kind: 'quno-notice',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? 0,
      location: locationOf(context),
      visibility: 'hidden',
      groupTree: 'turn',
      data: {
        notificationId: context.state.notificationId,
        kind: context.state.kind,
        ...(context.state.taskId === undefined ? {} : { taskId: context.state.taskId }),
      },
    }
  },
}
