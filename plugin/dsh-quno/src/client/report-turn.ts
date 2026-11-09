/**
 * Binds a delivered notice to the Turn it was injected into.
 *
 * The Host already stamps every proactive message's `source.notificationId`
 * into the durable `user/message` event, so the client does not need a new
 * event type: this Definition matches that message, folds one Context per
 * notification, and materializes a HIDDEN Chat node. Hidden means it adds no
 * row and no grouping effect; `ChatNodeStore.turnDataSource(turn, kind)`
 * exposes it per Turn, which is exactly what the turn-tail card reads.
 *
 * The card therefore survives reloads, stays bound to its own Turn, and no
 * longer depends on "the newest notice within the last hour".
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

/** Payload published onto the Chat target for one delivered notice. */
export interface QunoNoticeChatData {
  readonly notificationId: string
  readonly kind: 'notify' | 'task'
  readonly taskId?: string
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A proactive report or task result bound to its own Turn. */
    'quno-notice': QunoNoticeChatData
  }
}

/** Folded state: the business identity plus the owning Turn, when resolved. */
interface QunoNoticeState extends QunoNoticeChatData {
  readonly turn: number | null
}

/** Structural shape of the injected message source both kinds share. */
interface QunoMessageSource {
  readonly kind?: string
  readonly notificationId?: string
  readonly taskId?: string
}

function sourceOf(event: { readonly data: unknown }): QunoMessageSource | undefined {
  const data = event.data as { readonly source?: QunoMessageSource } | undefined
  return data?.source
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
    if (source?.kind !== 'quno-notify' && source?.kind !== 'quno-task') return null
    if (typeof source.notificationId !== 'string' || source.notificationId === '') return null
    // Claim the injected program message on the Chat target: the report card
    // below is its visible form, so a phantom user bubble must not render.
    return { id: source.notificationId, role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const source = sourceOf(match.event)
    // `match` only accepts a non-empty notificationId, so this never falls back.
    const notificationId = typeof source?.notificationId === 'string' ? source.notificationId : ''
    return {
      notificationId,
      kind: source?.kind === 'quno-task' ? 'task' : 'notify',
      ...(typeof source?.taskId === 'string' && source.taskId !== '' ? { taskId: source.taskId } : {}),
      turn: turnOf(match),
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    // A hidden node keeps the report out of the visible flow (no row, no
    // grouping effect) while `turnDataSource` still publishes it per Turn.
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
