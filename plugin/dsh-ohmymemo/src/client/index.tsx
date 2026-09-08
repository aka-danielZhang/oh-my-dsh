/** Browser entry for the top-level Memory settings section. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { MemorySettingsController } from './controller.ts'
import { en, zh, type MemoryLocaleKey } from './locales.ts'
import { MemorySettingsSection, type MemorySettingsInjected } from './MemorySettingsSection.tsx'
import { MEMORY_SETTINGS_CSS } from './styles.ts'

export const inject = ['slots', 'locale', 'remote', 'timer']

const LOCALE_NS = 'settings.ohMyMemo'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.ohMyMemo': MemoryLocaleKey
  }
}

/** Mount the package Remote descriptors and register one settings section. */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const disposeRemote = ctx.get('remote.ohMyMemoUi') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const remote = ctx.get('remote.ohMyMemoUi') as TypertRemoteNamespaceMap['ohMyMemoUi'] | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('dsh-ohmymemo: Memory Remote did not mount')
  }

  const controller = new MemorySettingsController(remote)
  const t = ctx.locale.bind(LOCALE_NS) as (key: MemoryLocaleKey) => string
  const injected = (): MemorySettingsInjected => ({
    controller,
    hooks: { memory: controller.store },
  })

  try {
    ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-ohmymemo: Memory dictionaries')
    ctx.effect(() => {
      // Pre-claimed with data-plugin/data-plugin-css (the stock build-time
      // CSS emission convention) and dedup-guarded: the client module
      // system's claimStyles attributes every UNTAGGED <style> to whichever
      // plugin materializes next, and that plugin's next HMR reload deletes
      // the claimed sheet — this plugin's own dev rebuilds did exactly that
      // to the desktop bridge's rail/titlebar stylesheets (2026-09-08
      // incident, dsh-desktop docs/notes/2026-09-08-style-tag-claiming-hmr.md).
      const tagId = 'dsh-ohmymemo/client-css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.dshOhMyMemo = 'client-css'
      style.dataset.plugin = 'dsh-ohmymemo'
      style.dataset.pluginCss = tagId
      style.textContent = MEMORY_SETTINGS_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }, 'dsh-ohmymemo: Memory styles')
    ctx.effect(() => {
      const stop = ctx.timer.interval(() => { void controller.tick() }, 3000)
      return () => {
        stop()
        controller.dispose()
      }
    }, 'dsh-ohmymemo: Memory refresh')
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'memory',
      order: 14,
      label: () => t('nav'),
      locale: LOCALE_NS,
      inject: injected,
    }, MemorySettingsSection))
    return disposeRemote
  } catch (error) {
    controller.dispose()
    await disposeRemote()
    throw error
  }
}
