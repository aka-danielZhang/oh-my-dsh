/**
 * Browser entry for Quno: mounts the `quno` Remote namespace, starts the
 * polling snapshot store, and contributes the sidebar view, settings section,
 * task card and report actions.
 *
 * @module dsh-quno/client
 */

import React from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from './session-list-view-slot.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { QunoLocaleKey } from './locales.ts'
import type { QunoRemoteFace } from './store.ts'
import TYPERT_REMOTE from '../typert.remote-client.ts'
import { QunoClientStore } from './store.ts'
import { en, zh } from './locales.ts'
import { QunoSettingsSection } from './settings.tsx'
import { QunoSidebarView } from './sidebar.tsx'
import { QunoTaskCard } from './task-card.tsx'
import { QunoReportActions } from './report-actions.tsx'
import { QUNO_CSS } from './ui.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'quno'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Quno browser copy. */
    quno: QunoLocaleKey
  }
}

/** Required client services. */
export const inject = ['slots', 'locale', 'remote']

/** Structural face of the workspace navigation service (fork-provided). */
interface WorkspaceFace {
  openSession(sessionId: SessionId): void
}

/** Mount Quno's browser surface. */
export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const disposeRemote = ctx.get('remote.quno') === undefined
    ? await ctx.remote.$mount(TYPERT_REMOTE)
    : async (): Promise<void> => {}
  const remote = ctx.get('remote.quno') as QunoRemoteFace | undefined
  if (remote === undefined) {
    await disposeRemote()
    throw new Error('dsh-quno: the quno Remote namespace did not mount')
  }
  const store = new QunoClientStore(remote)
  const openSession = (sessionId: string): void => {
    const workspace = ctx.get('uiWorkspace') as WorkspaceFace | undefined
    workspace?.openSession(sessionId as SessionId)
  }
  const locale = (): 'zh' | 'en' => ctx.locale.getLocale().active.toLowerCase().startsWith('zh') ? 'zh' : 'en'

  try {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quno: dictionaries')
    const t = ctx.locale.bind(NS) as (key: QunoLocaleKey, params?: Record<string, string | number>) => string

    ctx.effect(() => store.start(), 'dsh-quno: polling')

    // The settings section is Quno's home for configuration AND operational state.
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'quno',
      order: 12,
      label: () => t('nav'),
      inject: () => ({ store, t, openSession, locale }),
    }, QunoSettingsSection))

    // The Quno list view: one durable conversation plus actionable state.
    ctx.slots.inject('sidebar.workspaces.sessionListView', () => ctx.slots.register({
      name: 'sidebar.workspaces.sessionListView',
      id: 'quno',
      order: 11,
      label: 'Quno',
      inject: () => ({ store, t, openSession }),
    }, QunoSidebarView))

    // Inline task card for quno_task calls.
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview',
      key: 'quno_task',
      inject: () => ({ store, t, openSession }),
    }, QunoTaskCard))

    // Deterministic report actions at the turn tail of the Quno conversation.
    ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      id: 'quno-report-actions',
      order: 30,
      inject: () => ({ store, t }),
    }, QunoReportActions))

    // Claimed stylesheet (see the 2026-09-08 cross-plugin style incident): a
    // plugin-tagged, dedupe-guarded sheet is never deleted by another plugin's
    // HMR reload.
    ctx.effect(() => {
      const tagId = 'dsh-quno/client-css'
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-quno'
      style.dataset.pluginCss = tagId
      style.textContent = QUNO_CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    })

    return async () => {
      await disposeRemote()
    }
  } catch (error) {
    await disposeRemote()
    throw error
  }
}

/** Keep React referenced for the JSX runtime in older bundler interop. */
void React
