/**
 * Browser half: mounts the webSearchToggle Remote contribution and registers
 * the General-section row that toggles the native web_search tool.
 *
 * @module dsh-web-search-toggle/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { WebSearchRow } from './WebSearchRow.tsx'
import type { WebSearchRowInjected, WebSearchRowState } from './WebSearchRow.tsx'
import { en, zh } from './locales.ts'
import type { WebSearchLocaleKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'web-search-toggle'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** web_search toggle row copy. */
    'web-search-toggle': WebSearchLocaleKey
  }
}

/** Wrap one gateway answer as row state, mapping refusals to the error shape. */
async function call(
  invoke: () => Promise<{ ok: true, value: import('../toggle-types.ts').WebSearchToggleSnapshot } | { ok: false, error: { code: string, message: string } }>,
): Promise<WebSearchRowState> {
  try {
    const result = await invoke()
    if (!result.ok) {
      return { status: 'error', error: `${result.error.code}: ${result.error.message}` }
    }
    return { status: 'ready', snapshot: result.value }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

/** Required Client services (mcp-settings' client face): the apply below
 * awaits ctx.remote.$mount, so the fiber must not run before `remote`
 * arrives — reading it without this declaration throws at entry. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'settingsScope']

/** Contribute the web_search toggle row to the General settings section. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Mount our own generated-equivalent contribution when the shell's
  // selection has not already provided the namespace (mcp-settings pattern).
  const disposeRemote = ctx.get('remote.webSearchToggle') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const gateway = ctx.get('remote.webSearchToggle')
  if (gateway === undefined) {
    await disposeRemote()
    throw new Error('dsh-web-search-toggle: webSearchToggle Remote did not mount')
  }

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-web-search-toggle: dictionaries')

    const face: WebSearchRowInjected = {
      refresh: () => call(() => gateway.get()),
      setEnabled: enabled => call(() => gateway.set({ enabled })),
    }

    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item',
      id: 'web-search',
      order: 15,
      locale: NS,
      inject: (): WebSearchRowInjected => face,
    }, WebSearchRow))
    return disposeRemote
  } catch (error) {
    await disposeRemote()
    throw error
  }
}
