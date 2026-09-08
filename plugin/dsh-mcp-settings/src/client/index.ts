/** MCP server configuration and live status registered into Web Settings. */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import type { McpServerEntry } from './drafts.ts'
import { McpSettingsSection, type McpSettingsSectionInjected } from './McpSettingsSection.tsx'
import { en, zh, type McpSettingsLocaleKey } from './locales.ts'

export type { McpSettingsSectionInjected, McpSettingsSectionProps } from './McpSettingsSection.tsx'
export type { McpSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** MCP settings section copy. */
    'settings.mcp': McpSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.mcp'

/** The `mcp` settings namespace this section edits (matches the manager's registration). */
export const MCP_SETTINGS_NS = 'mcp'

/** Services required by the Settings registration, the settings transport, and the status Remote. */
export const inject = ['slots', 'locale', 'remote', 'settingsScope']

/** Contribute the MCP server manager to the Settings panel. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  // Current Web bundles already select this namespace through api-remotes. An
  // older compatible shell can omit that selection, so this package mounts its
  // own generated-equivalent contribution without duplicating a live endpoint.
  const disposeRemote = ctx.get('remote.mcpInventory') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const inventoryRemote = ctx.get('remote.mcpInventory')
  if (inventoryRemote === undefined) {
    await disposeRemote()
    throw new Error('ui-settings-mcp: mcpInventory Remote did not mount')
  }

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-mcp: dictionaries')

    const t = ctx.locale.bind(NS)
    // Bound eagerly on this plugin's fiber: the scope's listeners and invalidation
    // subscriptions unload with the contribution, not with a component unmount.
    const scope = ctx.settingsScope.bind<{ servers: McpServerEntry[] }>({ namespace: MCP_SETTINGS_NS })
    const injected = (): McpSettingsSectionInjected => ({
      scope,
      listStatus: async () => {
        const result = await inventoryRemote.list()
        if (!result.ok) {
          throw new Error(`mcpInventory.list failed: ${result.error.code}: ${result.error.message}`)
        }
        return result.value
      },
      t: t,
    })

    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'mcp',
      order: 12,
      label: () => t('nav'),
      locale: NS,
      inject: injected,
    }, McpSettingsSection))
    return disposeRemote
  } catch (error) {
    await disposeRemote()
    throw error
  }
}
