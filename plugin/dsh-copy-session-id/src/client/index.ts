/**
 * dsh-copy-session-id, browser half.
 *
 * Takes over the session-header ellipsis menu so it carries a Copy Session ID
 * item beside the stock Download Session Log entry.
 *
 * Seat: the additive `conversation.session.header.utilities` list seat
 * (declared by ui-conversation's conversation entry), registering with the
 * SHIPPED cell id `session-log-download`. Per the slot contract, reusing a
 * shipped id puts this plugin in THAT cell and replaces its occupant — which
 * is exactly the point: the stock session-log-export header action IS that
 * ellipsis menu, so extending it means re-rendering it (see menu.tsx) rather
 * than growing a second button beside it.
 *
 * Download stays the stock controller's job: this plugin never imports
 * session-log-export, it consumes the `sessionLogDownload` cordis service
 * face, duck-checked (download-state.ts). When that service is absent — a
 * runtime without the stock plugin, or a shape drift — the menu degrades to
 * copy-only instead of failing the header.
 *
 * Copy uses the browser carriers (copy-text.ts): async clipboard first, the
 * execCommand fallback second, a logged failure last. No desktop gate:
 * terminal `dsh web`, plain browsers, and the desktop shell all get the same
 * header menu. Effects are reversible and collected by this fiber.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-conversation's SlotMap declarations (the
// 'conversation.session.header.utilities' list seat and the session standard
// kit) — no runtime edge to ui-conversation.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { buildSessionLogActions } from './download-state.ts'
import { SessionActionsMenu } from './menu.tsx'
import { installSessionActionsCss } from './stylesheet.ts'
import { en, NS, zh, type CopySessionIdKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The session-actions menu labels and download status copy. */
    'copy-session-id': CopySessionIdKey
  }
}

/** Required services: the slot registry, the locale registry, and the timer. */
export const inject = ['slots', 'locale', 'timer']

/**
 * Client plugin body: install the header stylesheet, register the
 * dictionaries, and take over the shipped ellipsis menu cell.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installSessionActionsCss(document), 'copy-session-id: header css')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'copy-session-id: dictionaries')
  // slots.inject waits on the conversation entry's declaration (activation
  // order is unconstrained), reruns after redeclaration, and leaves with this
  // fiber. The def's per-session `inject` hands the component its verbs; the
  // stock controller is resolved lazily inside them (ctx.get at call time),
  // so a mount-order race can never bake an absent service into the face.
  ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'session-log-download',
        // Cell shadowing: the stock session-log-export action occupies this id
        // at the default priority 0, and a same-id/same-priority registration
        // is a hard error. Priority sorts ascending with the LOWEST live entry
        // rendering, so -1 wins the cell; the stock entry stays on the ledger
        // and resumes the moment this fiber is disposed.
        priority: -1,
        locale: NS,
        inject: (sessionId: string) =>
          buildSessionLogActions(ctx, sessionId, (fn, ms) => ctx.timer.timeout(fn, ms)),
      },
      SessionActionsMenu,
    ),
  )
}
