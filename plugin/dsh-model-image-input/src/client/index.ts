/** Image-input declarations injected into the stock Models settings card rows. */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { modelOpFor } from './drafts.ts'
import type { InputChoice, PiAiUserSection } from './drafts.ts'
import { startInjection } from './inject.ts'
import { en, zh, type ModelImageLocaleKey } from './locales.ts'
import { injectStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Image-input injection copy. */
    'settings.modelImage': ModelImageLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.modelImage'

/** The `llm-pi-ai` settings namespace this plugin edits. */
export const PI_AI_NS = 'llm-pi-ai'

/** Required services: locale dictionaries, the settings scope binder, and the typed settings Remote. */
export const inject = ['locale', 'settingsScope', 'remote.settings']

/**
 * Client plugin body: bind the llm-pi-ai settings scope, then start the
 * settings-card row injection over it. Writes are whole-array ops against the
 * STORED user layer (the same shape the stock Models editor produces); a
 * successful write publishes the Host's `settings/document-updated`, which
 * refreshes the shared mirror, this scope's snapshot, and — through the
 * injection's repaint — every injected icon.
 *
 * Writes go through the typed `remote.settings` Remote namespace (0.1.2+
 * posture — the old `connection.api` facade was removed upstream; positional
 * args, `RemoteResult` envelope), mirroring dsh-thread's 0.2.0-rc.5/6
 * migration.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-image: dictionaries')

  const t = ctx.locale.bind(NS)
  const scope = ctx.settingsScope.bind<PiAiUserSection>({ namespace: PI_AI_NS })
  const settingsRemote = ctx.remote.settings

  const applyChoice = async (provider: string, modelId: string, choice: InputChoice): Promise<void> => {
    const op = modelOpFor(scope.getSnapshot().user, provider, modelId, choice)
    if (op === undefined) throw new Error(t('notEditable'))
    const revision = scope.getSnapshot().revision
    const response = await settingsRemote.mutate(PI_AI_NS, [op] satisfies SettingsPathOpView[], revision)
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
  }

  ctx.effect(() => injectStyles(), 'ui-model-image: styles')
  ctx.effect(() => startInjection({
    t,
    readUser: () => scope.getSnapshot().user,
    applyChoice,
    onStoredChange: listener => scope.subscribe(listener),
  }), 'ui-model-image: settings row injection')
}
