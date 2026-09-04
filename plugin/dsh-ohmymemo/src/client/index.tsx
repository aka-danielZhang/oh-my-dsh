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
      const style = document.createElement('style')
      style.dataset.dshOhMyMemo = 'client-css'
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
