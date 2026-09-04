/**
 * dsh-send-while-running, browser half. Occupies the additive
 * `conversation.input.right` list seat (declared by ui-conversation's
 * conversation entry). 0.2.0 pivot: on the 0.1.2-alpha composer the stock
 * primary stays SEND while a running ordinary session has draft content, so
 * the seat now renders the button that state is actually missing — a STOP
 * beside the Send, wired through the SAME typed path the stock stop prop
 * takes (`scopedConversation(sessions, sessionId).cancel()`, ui-conversation
 * apply.ts): the runtime `ISessions.scope()` resolves the session's
 * AgentContext, whose `conversation` service face (`IConversation`) exposes
 * `cancel()`. When the draft empties the stock primary flips back to Stop
 * and this button stands down (never duplicated). Continuable child sessions
 * keep their stock independent Stop, so they are excluded. The 0.1.1 global
 * "every stop is danger-red" recolor is retained. No desktop gate: terminal
 * `dsh web`, plain browsers, and the desktop shell all get the same
 * composer. Effects are reversible and collected by this fiber.
 */
import type { ClientContext, ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-conversation's SlotMap declarations (the
// 'conversation.input.right' list seat and the session standard kit) and its
// session-scope Context merge (`conversation: IConversation`) so the
// cancel path below typechecks against the real service contract — no
// runtime edge to ui-conversation.
import type { IConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { StopWhileRunningButton } from './send-button.tsx'
import { installStopWhileRunningCss } from './stylesheet.ts'
import { en, zh, type SendWhileRunningKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The stop-while-running button labels. */
    'send-while-running': SendWhileRunningKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'send-while-running'

/**
 * Resolve the session-scoped conversation face — the stock stop prop's own
 * helper (ui-conversation `scopedConversation`), soft where it throws: an
 * absent sessions service or a session whose scope is already gone (click
 * racing a removal) is a no-op click, not a crash — this seat's posture is
 * fail-invisible.
 * @param sessions - the client sessions runtime (`ctx.get('sessions')`).
 * @param id - the session whose conversation face to resolve.
 * @returns the conversation service face, or undefined when unresolvable.
 */
function scopedConversation(
  sessions: ISessions | undefined,
  id: SessionId,
): IConversation | undefined {
  return sessions?.scope(id)?.get('conversation')
}

/** Required services: the slot registry (declaration-aware) and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: install the composer stylesheet, register the
 * dictionaries, and occupy the input.right seat with the Stop button.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installStopWhileRunningCss(document), 'send-while-running: composer css')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'send-while-running: dictionaries')
  // slots.inject waits on the conversation entry's declaration (activation
  // order is unconstrained), reruns after redeclaration, and leaves with
  // this fiber; register's disposer is the injection effect. The def's
  // per-session `inject` hands the component its interrupt verb — resolved
  // lazily at click time (the sessions runtime is core, but a click must
  // never depend on mount order), over the same scoped-conversation path
  // the stock stop prop takes; failures are swallowed like the stock
  // handler does.
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'send-while-running',
        order: 100,
        locale: NS,
        inject: (sessionId: SessionId) => ({
          interrupt: () => {
            scopedConversation(ctx.get('sessions'), sessionId)
              ?.cancel()
              .catch(() => { /* the stock stop swallows failures too */ })
          },
        }),
      },
      StopWhileRunningButton,
    ),
  )
}
