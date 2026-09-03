/**
 * dsh-send-while-running, browser half. Occupies the additive
 * `conversation.input.right` list seat (declared by ui-conversation's
 * conversation entry). 0.2.0 pivot: on the 0.1.2-alpha composer the stock
 * primary stays SEND while a running ordinary session has draft content, so
 * the seat now renders the button that state is actually missing — a STOP
 * beside the Send, wired to the same session-scoped conversation `cancel()`
 * the stock stop prop calls. When the draft empties the stock primary flips
 * back to Stop and this button stands down (never duplicated). Continuable
 * child sessions keep their stock independent Stop, so they are excluded.
 * The 0.1.1 global "every stop is danger-red" recolor is retained. No
 * desktop gate: terminal `dsh web`, plain browsers, and the desktop shell
 * all get the same composer. Effects are reversible and collected by this
 * fiber.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-conversation's SlotMap declarations (the
// 'conversation.input.right' list seat and the session standard kit) so the
// registration below typechecks against the real declaration — no runtime
// edge to ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
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
 * Structural slice of the client sessions runtime service the interrupt
 * path needs: resolve the session scope, then its conversation face. The
 * real service satisfies this; no value import crosses the boundary.
 */
interface SessionsScopeHost {
  scope(id: string): { get(name: 'conversation'): { cancel(): Promise<unknown> } | undefined } | undefined
}

/**
 * Cancel the session's running turn — the stock stop prop's exact path
 * (`scopedConversation(sessions, sessionId).cancel()`), resolved lazily at
 * click time so registration never depends on service mount order.
 * Failures are swallowed like the stock handler; a session whose scope is
 * already gone no-ops.
 * @param ctx - client root context (reads `sessions` lazily).
 * @param sessionId - the session whose turn to interrupt.
 */
function interruptRunningTurn(ctx: ClientContext, sessionId: string): void {
  const sessions = ctx.get('sessions') as SessionsScopeHost | undefined
  const conversation = sessions?.scope(sessionId)?.get('conversation')
  if (conversation === undefined) return
  conversation.cancel().catch(() => { /* the stock stop swallows failures too */ })
}

/** Required services: the slot registry (declaration-aware), the locale registry, and the sessions runtime the interrupt path resolves through. */
export const inject = ['slots', 'locale', 'sessions']

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
  // per-session `inject` hands the component its interrupt verb (the same
  // cancel path the stock stop prop wires).
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'send-while-running',
        order: 100,
        locale: NS,
        inject: (sessionId: string) => ({ interrupt: () => interruptRunningTurn(ctx, sessionId) }),
      },
      StopWhileRunningButton,
    ),
  )
}
